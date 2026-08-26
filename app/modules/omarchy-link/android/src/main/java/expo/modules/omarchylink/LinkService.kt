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
    private const val NOTIFICATION_ID = 4801
    private const val TASK = "OmarchyConnectLink"
    const val ACTION_STOP = "expo.modules.omarchylink.STOP"

    @Volatile
    var running = false
      private set

    fun start(context: Context) {
      val app = context.applicationContext
      ContextCompat.startForegroundService(app, Intent(app, LinkService::class.java))
    }

    fun stop(context: Context) {
      val app = context.applicationContext
      app.stopService(Intent(app, LinkService::class.java))
    }

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
      }
    }

    private fun buildNotification(context: Context): Notification {
      ensureChannel(context)
      val desktop = LinkPrefs.desktop(context)
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

      return NotificationCompat.Builder(context, CHANNEL)
        .setSmallIcon(R.drawable.omarchy_link_notification)
        .setContentTitle(desktop?.let { "Connected to $it" } ?: "Omarchy Connect")
        .setContentText(status)
        .setContentIntent(tap)
        .setOngoing(true)
        .setSilent(true)
        .setShowWhen(false)
        .setPriority(NotificationCompat.PRIORITY_MIN)
        .setCategory(NotificationCompat.CATEGORY_SERVICE)
        .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
        .build()
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
    // Android gives a service started with `startForegroundService` five
    // seconds to put up its notification, so this happens before anything
    // that could conceivably block.
    goForeground()
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (intent?.action == ACTION_STOP) {
      stopSelf()
      return START_NOT_STICKY
    }
    goForeground()
    ensureTask()
    // Restarted by Android with a null intent after a kill: the flag in
    // preferences, not the intent, is what says whether that was wanted.
    return START_STICKY
  }

  private fun goForeground() {
    try {
      ServiceCompat.startForeground(
        this,
        NOTIFICATION_ID,
        buildNotification(this),
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q)
          ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE
        else 0,
      )
    } catch (error: Exception) {
      // Android 12 forbids starting a foreground service from the background
      // outside a handful of exemptions. Losing the service is survivable —
      // the app reconnects the next time it is opened — crashing is not.
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
    val host = host ?: return
    val context = host.currentReactContext
    if (context != null) {
      startTask(context)
      return
    }
    if (pendingListener != null) return
    val listener = object : ReactInstanceEventListener {
      override fun onReactContextInitialized(context: ReactContext) {
        host.removeReactInstanceEventListener(this)
        pendingListener = null
        startTask(context)
      }
    }
    pendingListener = listener
    host.addReactInstanceEventListener(listener)
    UiThreadUtil.runOnUiThread { host.start() }
  }

  private fun startTask(context: ReactContext) {
    UiThreadUtil.runOnUiThread {
      val tasks = HeadlessJsTaskContext.getInstance(context)
      val current = taskId
      if (current != null && tasks.isTaskRunning(current)) return@runOnUiThread
      taskId = try {
        // No timeout, and allowed in the foreground: the task's whole job is
        // to outlive every transition between foreground and background.
        tasks.startTask(HeadlessJsTaskConfig(TASK, Arguments.createMap(), 0, true))
      } catch (error: Exception) {
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
    }
  }

  override fun onDestroy() {
    running = false
    pendingListener?.let { host?.removeReactInstanceEventListener(it) }
    pendingListener = null
    finishTask()
    super.onDestroy()
  }
}
