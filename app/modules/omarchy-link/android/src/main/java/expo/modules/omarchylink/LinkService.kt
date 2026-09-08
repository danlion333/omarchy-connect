package expo.modules.omarchylink

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat

import com.facebook.react.ReactApplication
import com.facebook.react.ReactHost
import com.facebook.react.ReactInstanceEventListener
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.ReactContext
import com.facebook.react.bridge.UiThreadUtil
import com.facebook.react.jstasks.HeadlessJsTaskConfig
import com.facebook.react.jstasks.HeadlessJsTaskContext

/**
 * Keeps the desktop link up while the app is not on screen.
 *
 * Two separate things are going on here and both are needed:
 *
 *   - **The process stays alive.** A foreground service is what stops Android
 *     from reclaiming this process when the task is swiped away, and what
 *     exempts its network access from Doze.
 *   - **JavaScript keeps running.** This is the part that is easy to miss:
 *     React Native suspends every `setTimeout` and `setInterval` the moment
 *     the activity pauses, and the connection's keepalive ping, its reconnect
 *     backoff and the telephony flush are all timers. RN makes exactly one
 *     exception — a headless task marks the runtime as busy and the timers
 *     keep firing. So the service starts a task that never finishes, and the
 *     JS side treats it as "hold the connection open until told otherwise".
 *
 * `HeadlessJsTaskService` would do most of this, but it takes an untimed
 * `PARTIAL_WAKE_LOCK` for the life of the task — fine for a burst of work,
 * ruinous for a link meant to stay up all day. This holds no wake lock: the
 * socket survives suspend, and whatever wakes the phone (a call, a message,
 * the screen) is what gets the timers running again.
 */
class LinkService : Service() {
  companion object {
    private const val CHANNEL = "omarchy-link"
    internal const val NOTIFICATION_ID = 4801
    private const val TASK = "OmarchyConnectLink"
    const val ACTION_STOP = "expo.modules.omarchylink.STOP"

    @Volatile
    var running = false
      private set

    /**
     * Whether the ongoing notification is also claiming the microphone.
     *
     * From Android 14 a foreground service that records has to declare the
     * `microphone` type, and it has to be declared *before* the input is
     * opened. Claiming it for the life of the service instead would be simpler
     * and worse: the type is refused outright when the service starts from a
     * background context that is not allowed one — `BOOT_COMPLETED`, above
     * all — and losing the whole link because nobody was recording is a bad
     * trade for a claim nothing was using.
     *
     * So it is added when `Mic` is about to open the input and dropped when it
     * gives it back, by re-entering the foreground with the two types instead
     * of one. `startForeground` on a service already in the foreground is how
     * Android documents changing types; it does not restart anything and the
     * notification does not flash.
     */
    @Volatile
    private var microphone = false

    /**
     * Whether the ongoing notification is also claiming the camera.
     *
     * Everything said above about the microphone holds here one rung up: from
     * Android 14 a foreground service that films has to declare the `camera`
     * type, before the device is opened, and claiming it for the life of the
     * service would lose the whole link on every start that is not eligible
     * for it. So it goes on when `Camera` is about to open a lens and off
     * when it gives it back.
     */
    @Volatile
    private var camera = false

    /**
     * Whether the ongoing notification is also claiming media playback.
     *
     * The third of the same claim, and the one this service needs while the
     * desktop's sound is coming out of this handset: from Android 14 a
     * foreground service that plays has to declare `mediaPlayback`, before the
     * track is written to, or the system stops the playback the moment the app
     * is out of sight — which is the entire case the speaker exists for, since
     * a phone being used as a speaker is a phone lying face down on a table.
     */
    @Volatile
    private var playback = false

    fun start(context: Context) {
      val app = context.applicationContext
      ContextCompat.startForegroundService(app, Intent(app, LinkService::class.java))
    }

    fun stop(context: Context) {
      val app = context.applicationContext
      app.stopService(Intent(app, LinkService::class.java))
    }

    /**
     * Claim, or give back, the microphone half of the foreground service type.
     *
     * Never fatal. A phone that refuses the claim is a phone where the
     * recording will be stopped when the screen goes off — which is worth a
     * line in the log and is not worth losing the link over.
     */
    fun holdMicrophone(wanted: Boolean) {
      if (microphone == wanted) return
      microphone = wanted
      if (!running) return
      instance?.goForeground() ?: Trace.warn("mic.foreground.missing", "wanted" to wanted)
    }

    /**
     * Claim, or give back, the camera half of the foreground service type.
     *
     * Never fatal, for the same reason `holdMicrophone` is not: a phone that
     * refuses the claim is a phone where the capture stops when the screen
     * goes off, which is worth a line in the log and is not worth losing the
     * link over.
     */
    fun holdCamera(wanted: Boolean) {
      if (camera == wanted) return
      camera = wanted
      if (!running) return
      instance?.goForeground() ?: Trace.warn("camera.foreground.missing", "wanted" to wanted)
    }

    /**
     * Claim, or give back, the playback half of the foreground service type.
     *
     * Never fatal, for the reason neither of the others is: a phone that
     * refuses the claim is a phone where the sound stops when the screen goes
     * off, which is worth a line in the log and is not worth losing the link
     * over.
     */
    fun holdPlayback(wanted: Boolean) {
      if (playback == wanted) return
      playback = wanted
      if (!running) return
      instance?.goForeground() ?: Trace.warn("speaker.foreground.missing", "wanted" to wanted)
    }

    /** The live service, so `holdMicrophone` has something to re-enter with. */
    @Volatile
    private var instance: LinkService? = null

    /** Redraws the ongoing notification, if the service is up to be redrawn. */
    fun refresh(context: Context) {
      if (!running) return
      val app = context.applicationContext
      val manager = app.getSystemService(NotificationManager::class.java) ?: return
      try {
        manager.notify(NOTIFICATION_ID, buildNotification(app))
      } catch (error: SecurityException) {
        // Notifications not granted on API 33+. The service still runs; the
        // user simply does not see it, which is their choice to make.
        //
        // Worth a line all the same, because from the outside this is
        // indistinguishable from the link being down: no notification, no
        // sign of the app, and a service quietly doing its job behind both.
        Trace.warn("notification.refused", "reason" to "post-notifications-denied")
      }
    }

    /**
     * The line in the shade that says whether this phone can see its desktop.
     *
     * It is the app's whole presence while nobody has it open, so it says the
     * true thing rather than the flattering one: the title used to read
     * "Connected to <desktop>" for as long as a pairing existed, which meant a
     * phone that had been off the network since breakfast still claimed to be
     * connected. The name of the desktop is not news; whether it is reachable
     * is.
     */
    private fun buildNotification(context: Context): Notification {
      ensureChannel(context)
      val desktop = LinkPrefs.desktop(context)
      val connected = LinkPrefs.isConnected(context)
      val status = LinkPrefs.status(context).ifBlank { "starting up" }
      val launch = context.packageManager.getLaunchIntentForPackage(context.packageName)
      val tap = launch?.let {
        PendingIntent.getActivity(
          context,
          0,
          it,
          PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
      }

      val title = when {
        connected && desktop != null -> "Connected to $desktop"
        connected -> "Connected"
        desktop != null -> "$desktop — $status"
        else -> "Omarchy Connect"
      }

      val builder = NotificationCompat.Builder(context, CHANNEL)
        .setSmallIcon(
          if (connected) R.drawable.omarchy_link_notification else R.drawable.omarchy_link_offline,
        )
        .setContentTitle(title)
        .setContentText(
          when {
            connected -> status
            // Parked: the title already says what it is waiting for, so this
            // line must not also claim an effort that is not being made.
            LinkPrefs.isWaiting(context) -> "tap to open \u00b7 Reconnect tries anyway"
            else -> "tap to open \u00b7 the phone keeps trying"
          },
        )
        .setContentIntent(tap)
        .setOngoing(true)
        .setSilent(true)
        .setShowWhen(false)
        .setPriority(NotificationCompat.PRIORITY_MIN)
        .setCategory(NotificationCompat.CATEGORY_SERVICE)
        .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)

      // Only when it would do something. The backoff already retries on its
      // own schedule; this is for the case everyone knows — you have just
      // walked back into the flat and would rather not wait out the timer.
      if (!connected) builder.addAction(reconnectAction(context))

      return builder.build()
    }

    private fun reconnectAction(context: Context): NotificationCompat.Action {
      val intent = Intent(context, LinkActionReceiver::class.java).setAction(LinkActionReceiver.ACTION_RECONNECT)
      val pending = PendingIntent.getBroadcast(
        context,
        NOTIFICATION_ID,
        intent,
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
      )
      return NotificationCompat.Action.Builder(R.drawable.omarchy_link_notification, "Reconnect", pending).build()
    }

    private fun ensureChannel(context: Context) {
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
      val manager = context.getSystemService(NotificationManager::class.java) ?: return
      if (manager.getNotificationChannel(CHANNEL) != null) return
      // Lowest importance that still permits an ongoing notification: no
      // sound, no badge, collapsed into the bottom of the shade.
      val channel = NotificationChannel(CHANNEL, "Desktop link", NotificationManager.IMPORTANCE_LOW)
      channel.description = "Shown while Omarchy Connect is talking to your desktop."
      channel.setShowBadge(false)
      channel.enableVibration(false)
      channel.setSound(null, null)
      manager.createNotificationChannel(channel)
    }
  }

  private var taskId: Int? = null
  private var pendingListener: ReactInstanceEventListener? = null

  private val host: ReactHost?
    get() = (application as? ReactApplication)?.reactHost

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onCreate() {
    super.onCreate()
    running = true
    instance = this
    Trace.evt("service.create", "enabled" to LinkPrefs.isEnabled(this))
    // A fresh service instance means a fresh process and no socket: whatever
    // the last incarnation wrote about being connected — the flags and the
    // line of prose alike — is stale by definition, and the notification is
    // drawn on the next line.
    LinkPrefs.forgetConnection(this)
    // The desktop's own "I am up" burst, which is the only thing that brings
    // a sleeping phone back before its backoff rung comes round. It listens
    // for exactly as long as this service exists, which is the process that
    // outlives the desktop being switched off — see `Announce`.
    Announce.start(this)
    // Android gives a service started with `startForegroundService` five
    // seconds to put up its notification, so this happens before anything
    // that could conceivably block.
    goForeground()
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (intent?.action == ACTION_STOP) {
      Trace.evt("service.stop.asked")
      stopSelf()
      return START_NOT_STICKY
    }
    // A null intent is Android restarting this after a kill rather than anyone
    // asking for it, and that difference is most of what a morning-after
    // reading of the log is trying to establish.
    Trace.evt("service.start", "startId" to startId, "restart" to (intent == null))
    goForeground()
    ensureTask()
    // Restarted by Android with a null intent after a kill: the flag in
    // preferences, not the intent, is what says whether that was wanted.
    return START_STICKY
  }

  private fun goForeground() {
    // Built up rather than chosen from a list of pairs: there are two optional
    // claims now and a phone can be recording and filming at once, so an `if`
    // ladder over every combination would be four branches that mean one rule.
    var types = if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) 0 else ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      if (microphone && Mic.hasPermission(this)) types = types or ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
      if (camera && Camera.hasPermission(this)) types = types or ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA
      // No permission to gate this one on: playing needs none. What gates it
      // is Android's own rule that the type may only be claimed from a
      // service that is eligible for it, which the `catch` below answers.
      if (playback && Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        types = types or ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK
      }
    }
    try {
      ServiceCompat.startForeground(this, NOTIFICATION_ID, buildNotification(this), types)
      Trace.detail("service.foreground", "ok" to true, "mic" to microphone, "cam" to camera, "play" to playback)
    } catch (error: Exception) {
      // The microphone and camera types are the ones the system refuses on
      // its own terms — a service that came up from the background is not
      // eligible for either — and the link is worth far more than the claim.
      // Drop both and go back to the type that has always worked; whatever
      // asked for them hears about it when the capture is cut short.
      if (types != ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE && Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        Trace.fail("service.foreground.capture.refused", error)
        microphone = false
        camera = false
        return goForeground()
      }
      // Android 12 forbids starting a foreground service from the background
      // outside a handful of exemptions. Losing the service is survivable —
      // the app reconnects the next time it is opened — crashing is not.
      //
      // This is the one failure in the module that looks exactly like nothing
      // happening, so it is the one that most needs saying out loud: the link
      // is not down because the network is bad, it is down because the service
      // was never allowed to start.
      Trace.fail("service.foreground.refused", error)
      stopSelf()
    }
  }

  /**
   * Brings the React runtime up if it is not already, then starts the task
   * that keeps its timers running. Called on every start command because
   * Android may restart the service into a process whose React instance was
   * torn down underneath it.
   */
  private fun ensureTask() {
    val host = host
    if (host == null) {
      // Not a React application, which should be impossible in this app and is
      // therefore worth hearing about rather than returning from in silence.
      Trace.warn("task.host.missing")
      return
    }
    val context = host.currentReactContext
    if (context != null) {
      startTask(context)
      return
    }
    if (pendingListener != null) {
      Trace.detail("task.waiting", "reason" to "already-listening")
      return
    }
    val listener = object : ReactInstanceEventListener {
      override fun onReactContextInitialized(context: ReactContext) {
        host.removeReactInstanceEventListener(this)
        pendingListener = null
        Trace.evt("task.context.ready")
        startTask(context)
      }
    }
    pendingListener = listener
    host.addReactInstanceEventListener(listener)
    // The gap between here and `task.context.ready` is the runtime coming back
    // from nothing, and it is long enough that a log without both ends of it
    // reads as the service having done nothing at all.
    Trace.evt("task.context.starting")
    UiThreadUtil.runOnUiThread { host.start() }
  }

  private fun startTask(context: ReactContext) {
    UiThreadUtil.runOnUiThread {
      val tasks = HeadlessJsTaskContext.getInstance(context)
      val current = taskId
      if (current != null && tasks.isTaskRunning(current)) {
        Trace.detail("task.already", "id" to current)
        return@runOnUiThread
      }
      taskId = try {
        // No timeout, and allowed in the foreground: the task's whole job is
        // to outlive every transition between foreground and background.
        tasks.startTask(HeadlessJsTaskConfig(TASK, Arguments.createMap(), 0, true))
          .also { Trace.evt("task.start", "id" to it) }
      } catch (error: Exception) {
        // Without the task the process survives and the timers do not, so the
        // link stays up exactly as long as the screen does. That is the
        // subtlest way this module can fail and it deserves a line.
        Trace.fail("task.start.failed", error)
        null
      }
    }
  }

  private fun finishTask() {
    val context = host?.currentReactContext ?: return
    val current = taskId ?: return
    taskId = null
    UiThreadUtil.runOnUiThread {
      val tasks = HeadlessJsTaskContext.getInstance(context)
      if (tasks.isTaskRunning(current)) tasks.finishTask(current)
      Trace.detail("task.finish", "id" to current)
    }
  }

  override fun onDestroy() {
    Trace.evt("service.destroy", "task" to taskId)
    running = false
    instance = null
    // A recording outliving the service that legitimises it is exactly what
    // the foreground service type exists to prevent, so it ends here too.
    microphone = false
    camera = false
    Mic.stop()
    Camera.stop()
    Announce.stop()
    LinkPrefs.forgetConnection(this)
    // Nothing is left that could carry an answer to the desktop, or fetch a
    // file it offers to save, so the shade should not keep offering either.
    Shade.cancelEverything(this)
    pendingListener?.let { host?.removeReactInstanceEventListener(it) }
    pendingListener = null
    finishTask()
    super.onDestroy()
  }
}
