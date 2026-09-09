package expo.modules.omarchylink

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import expo.modules.interfaces.permissions.Permissions
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * The JavaScript handle on the background link.
 *
 * The service is the thing that actually keeps the process and the timers
 * alive; this is how the app turns it on, tells it what to say in its
 * notification, and finds out what stands in its way — notification
 * permission on Android 13, battery optimisation on every OEM that has an
 * opinion about it.
 *
 * It also reports network changes, because the single most common reason a
 * backgrounded phone looks offline is that it moved from mobile data to Wi-Fi
 * and the old socket is a corpse nobody has noticed yet.
 */
class OmarchyLinkModule : Module() {
  private val context: Context
    get() = appContext.reactContext ?: throw CodedException("no android context")

  private var networkCallback: ConnectivityManager.NetworkCallback? = null

  /**
   * A share that arrived while the app was already up.
   *
   * Kept here rather than read back off the activity because nothing in the
   * React or Expo activity chain calls `setIntent` for a new intent — the
   * activity would still be holding whatever launched it, which for a warm
   * share is the launcher icon.
   */
  private var pendingShare: Intent? = null

  override fun definition() = ModuleDefinition {
    Name("OmarchyLink")

    Events(
      "onNetworkChange",
      "onOutbox",
      "onLinkReconnect",
      "onLocateFound",
      "onShareIntent",
      "onDesktopAnnounce",
      "onMicChunk",
      "onMicStopped",
      "onCameraFrame",
      "onCameraStopped",
      "onSpeakerStopped",
    )

    /**
     * Somebody shared to this app while it was already running.
     *
     * A cold-started share is on the activity's own intent and JavaScript
     * finds it by asking; this is the other half, where the activity is
     * already up and Android hands the share over as a new intent. Only the
     * news is sent — the payload is fetched with `takeShareIntent`, whose
     * copying is too slow to do on the way past.
     */
    OnNewIntent { intent ->
      if (ShareIntake.isShare(intent)) {
        Trace.evt("share.newIntent")
        pendingShare = intent
        try {
          this@OmarchyLinkModule.sendEvent("onShareIntent", emptyMap<String, Any?>())
        } catch (error: Exception) {
          // Nothing listening yet; the intent is still on the activity and the
          // next `takeShareIntent` will find it there.
          Trace.warn("share.send.failed", "error" to error.javaClass.simpleName)
        }
      }
    }

    /**
     * The notification buttons run in a broadcast receiver, which has no way
     * to reach a module instance on its own. This is that way: set while a
     * runtime exists, and the receiver falls back to its own persistence when
     * it is null.
     */
    OnCreate {
      // The window in which a broadcast receiver has somewhere to send its
      // work. Everything the outbox holds was queued outside one of these.
      Trace.evt("runtime.up", "service" to LinkService.running)
      LinkActionReceiver.listener = { event, payload ->
        try {
          this@OmarchyLinkModule.sendEvent(event, payload)
        } catch (error: Exception) {
          /* the runtime went away mid-broadcast; the backlog still has it */
          Trace.warn("runtime.send.failed", "event" to event, "error" to error.javaClass.simpleName)
        }
      }
      // The phone going quiet is news for the desktop that asked it to shout,
      // and the button that does it is a broadcast receiver away from here.
      // Ten of these a second while the desktop is listening. Set here rather
      // than in `Mic` so the recorder knows nothing about React: when the
      // runtime goes away this goes back to null and the read loop drops what
      // it reads, which is the right answer for live sound with nowhere to go.
      Mic.onChunk = { pcm, seq ->
        try {
          this@OmarchyLinkModule.sendEvent("onMicChunk", mapOf("pcm" to pcm, "seq" to seq))
        } catch (error: Exception) {
          /* the runtime went away mid-chunk; the next one finds onChunk null */
        }
      }
      Mic.onStopped = { reason ->
        try {
          this@OmarchyLinkModule.sendEvent("onMicStopped", mapOf("error" to reason))
        } catch (error: Exception) {
          /* nothing listening; the desktop's own socket tells it soon enough */
        }
      }
      // Fifteen of these a second while the desktop is watching, and each one
      // is tens of kilobytes rather than the microphone's hundreds of bytes.
      // Same bargain otherwise: set here so `Camera` knows nothing about
      // React, and null when the runtime goes away, which the read side reads
      // as a frame with nowhere to go.
      //
      // The one difference from the microphone is the shape: a `ByteArray` in
      // an event payload arrives in JavaScript as a `Uint8Array`, straight out
      // of the JNI converter, while a base64 string would be a third more
      // bytes on the way over and then a character-at-a-time loop in Hermes to
      // undo. At tens of kilobytes fifteen times a second that loop was the
      // largest thing on the app's JavaScript thread; sound stays base64
      // because a chunk is hundreds of bytes and the change would buy nothing.
      Camera.onFrame = { jpeg, seq ->
        try {
          this@OmarchyLinkModule.sendEvent("onCameraFrame", mapOf("jpeg" to jpeg, "seq" to seq))
        } catch (error: Exception) {
          /* the runtime went away mid-frame; the next one finds onFrame null */
        }
      }
      Camera.onStopped = { reason ->
        try {
          this@OmarchyLinkModule.sendEvent("onCameraStopped", mapOf("error" to reason))
        } catch (error: Exception) {
          /* nothing listening; the desktop's own socket tells it soon enough */
        }
      }
      // The track going away without being asked is the one thing the desktop
      // cannot see from its end: it would keep sending into a phone that is
      // playing nothing. Set here for the reason `Mic`'s is — so `Speaker`
      // knows nothing about React.
      Speaker.onStopped = { reason ->
        try {
          this@OmarchyLinkModule.sendEvent("onSpeakerStopped", mapOf("error" to reason))
        } catch (error: Exception) {
          /* nothing listening; the desktop's own socket tells it soon enough */
        }
      }
      Locator.onFound = {
        try {
          this@OmarchyLinkModule.sendEvent("onLocateFound", emptyMap<String, Any?>())
        } catch (error: Exception) {
          /* nothing listening; the desktop's own window expires on its own */
        }
      }
    }

    OnStartObserving { watchNetwork() }
    OnStopObserving { unwatchNetwork() }
    OnDestroy {
      Trace.evt("runtime.down", "service" to LinkService.running, "locating" to Locator.ringing)
      LinkActionReceiver.listener = null
      // The recorder outlives the runtime — it is on the service, not on
      // React — so a runtime going away has to give the microphone back
      // rather than leave a phone recording into nobody.
      Mic.onChunk = null
      Mic.onStopped = null
      Mic.stop()
      Camera.onFrame = null
      Camera.onStopped = null
      Camera.stop()
      Speaker.onStopped = null
      Speaker.stop()
      Locator.onFound = null
      pendingShare = null
      unwatchNetwork()
    }

    Function("isAvailable") { true }

    /**
     * What the phone is attached to, right now.
     *
     * The event fires on change, which is no help to a client opening its
     * first socket — after a reboot the last change was before this process
     * existed. See `lib/retry` for what is done with the answer.
     */
    Function("networkFacts") { describeNetwork() }

    /** Whether the service is up right now, as opposed to merely wanted. */
    Function("isRunning") { LinkService.running }

    /** Whether the user has asked for the link to be kept up. */
    Function("isEnabled") { LinkPrefs.isEnabled(context) }

    /** Whether they have been asked at all — see `LinkPrefs.hasChoice`. */
    Function("hasChoice") { LinkPrefs.hasChoice(context) }

    /**
     * Starting is idempotent: Android folds a second `startForegroundService`
     * into another `onStartCommand` on the service already running, which is
     * exactly the "make sure it is up" the app wants on every launch.
     */
    Function("start") {
      LinkPrefs.setEnabled(context, true)
      LinkService.start(context)
    }

    Function("stop") {
      LinkPrefs.setEnabled(context, false)
      LinkService.stop(context)
    }

    /**
     * What the ongoing notification says, kept in step with the socket.
     *
     * `connected` is separate from the text on purpose: the text is prose for
     * a human to read, and this is what the title, the icon and the reconnect
     * button branch on. See `LinkPrefs.isConnected`.
     */
    Function("setStatus") { status: String, desktop: String?, connected: Boolean, waiting: Boolean ->
      LinkPrefs.setStatus(context, status)
      LinkPrefs.setDesktop(context, desktop)
      LinkPrefs.setConnected(context, connected)
      LinkPrefs.setWaiting(context, waiting)
      LinkService.refresh(context)
    }

    /* ── what the phone is allowed to say ─────────────────────────────── */

    /**
     * Raises, or quietly corrects, the alert for one blocked session.
     *
     * `alert` false is the correction: the agent was already waiting and only
     * the wording of its question changed, which is not worth a second buzz.
     */
    Function("notifyAgentWaiting") { id: String, agent: String, title: String, prompt: String, canReply: Boolean, alert: Boolean ->
      AgentAlerts.waiting(
        context,
        session = id,
        agent = agent,
        title = title,
        prompt = prompt,
        desktop = LinkPrefs.desktop(context),
        canReply = canReply,
        alert = alert,
      )
    }

    /**
     * An agent finished something long enough to have been worth waiting on.
     * Whether it was long enough is decided in JavaScript — every turn an
     * agent takes ends idle, and this must not fire on all of them.
     */
    Function("notifyAgentDone") { id: String, agent: String, title: String, preview: String ->
      AgentAlerts.finished(context, id, agent, title, preview, LinkPrefs.desktop(context))
    }

    /** A file the desktop is offering. `saveable` draws the gallery button. */
    Function("notifyFile") { token: String, name: String, size: String, saveable: Boolean ->
      DesktopAlerts.file(context, token, name, size, LinkPrefs.desktop(context), saveable)
    }

    /** Whatever the desktop last copied, as one silent self-replacing line. */
    Function("notifyClipboard") { text: String ->
      DesktopAlerts.clipboard(context, text, LinkPrefs.desktop(context))
    }

    /** The same line for a copied picture: preview, and a Save into the gallery. */
    Function("notifyClipboardImage") { token: String, name: String, path: String? ->
      DesktopAlerts.clipboardImage(context, token, name, path, LinkPrefs.desktop(context))
    }

    /**
     * A picture, on this phone's clipboard — the bytes, not the file name.
     *
     * The same call the **Copy** button makes from its receiver, so the row on
     * the share screen and the button in the shade cannot drift apart. It
     * throws rather than answering false: what went wrong is a sentence the
     * screen shows, and "it did not work" on its own is not one.
     */
    Function("copyImage") { path: String ->
      try {
        ImageClip.put(context, path)
      } catch (error: Exception) {
        throw CodedException(error.message ?: "the phone would not take the picture")
      }
    }

    /** The agent moved on, the offer expired, or the phone did. */
    Function("clearAlert") { kind: String, key: String -> Shade.cancel(context, kind, key) }

    Function("clearAlerts") { kind: String -> Shade.cancelAll(context, kind) }

    Function("clearEveryAlert") { Shade.cancelEverything(context) }

    /** Says what became of something asked for from the shade. */
    Function("noteAgentAlert") { id: String, note: String ->
      AgentAlerts.note(context, id, note, LinkPrefs.desktop(context))
    }

    Function("noteFileAlert") { token: String, name: String, note: String ->
      DesktopAlerts.fileNote(context, token, name, note)
    }

    /* ── the microphone ───────────────────────────────────────────────── */

    /**
     * Open the microphone and start emitting `onMicChunk`.
     *
     * Answers false rather than throwing for the one reason a caller can act
     * on — it could not — because every particular reason is already a line in
     * logcat and none of them changes what the phone tells the desktop: it
     * could not listen. `chunkMs` is how much sound rides in one event, and
     * the desktop names it so that the two ends cannot drift.
     */
    Function("startMic") { chunkMs: Int -> Mic.start(context, chunkMs) }

    /** Give the microphone back. Safe when nothing is recording. */
    Function("stopMic") { Mic.stop() }

    /** Whether this phone is recording right now. */
    Function("isMicRunning") { Mic.isRunning }

    /** Whether RECORD_AUDIO is granted, without asking for it. */
    Function("hasMicPermission") { Mic.hasPermission(context) }

    /**
     * Ask for it. The manifest has declared `RECORD_AUDIO` since dictation
     * existed; what is new is that this module, rather than `expo-audio`, is
     * the one that needs it — and a desktop asking for a microphone while the
     * app is in a pocket is exactly the case where the answer has to come back
     * as a refusal rather than as a dialog nobody sees.
     */
    AsyncFunction("requestMicPermissionAsync") { promise: Promise ->
      Permissions.askForPermissionsWithPermissionsManager(
        appContext.permissions,
        promise,
        Manifest.permission.RECORD_AUDIO,
      )
    }

    /* ── the speaker ──────────────────────────────────────────────────── */

    /**
     * Open a track for the desktop's sound and start accepting chunks.
     *
     * Answers false rather than throwing, for the reason `startMic` does: the
     * layer above turns it into the one sentence the desktop is holding a
     * request open for. No permission is checked because Android asks for none
     * to play.
     */
    Function("startSpeaker") { rate: Int, chunkMs: Int -> Speaker.start(context, rate, chunkMs) }

    /** Give the track back. Safe when nothing is playing. */
    Function("stopSpeaker") { Speaker.stop() }

    /** Whether a track is open right now. */
    Function("isSpeakerRunning") { Speaker.isRunning }

    /**
     * One chunk into the track, base64 as it crossed the bridge.
     *
     * Fifty of these a second, which is why it is a `Function` rather than an
     * `AsyncFunction`: a promise per chunk would be fifty promises a second
     * resolving on the JS thread to say something the next chunk already
     * implies. False means the track has gone, and the layer above stops.
     */
    Function("writeSpeaker") { pcm: String -> Speaker.writeEncoded(pcm) }

    /* ── the headset ──────────────────────────────────────────────────── */

    /**
     * Enter the mode where this phone is a microphone and a speaker at once.
     *
     * Asked *before* either direction is opened, and that ordering is the
     * whole of it: the record source, the audio session and the platform's
     * echo canceller are all fixed at the moment `AudioRecord` and
     * `AudioTrack` are constructed, so a mode entered afterwards would change
     * nothing until something restarted. `Headset` argues it at length.
     *
     * Answers false only on a device with no audio manager at all.
     */
    Function("startHeadset") { Headset.start(context) }

    /**
     * Leave it, and put the phone back the way it was found — the mode, the
     * routing and the canceller. Safe when the mode was never entered, because
     * the desktop asking, the socket dying and the app going away are three
     * roads here and they race.
     */
    Function("stopHeadset") { Headset.stop(context) }

    /**
     * What the duplex actually is on this handset, rather than what was asked
     * for. `aecAvailable` is a per-handset fact and some phones say no; the
     * desktop prints that instead of promising an echo canceller that is not
     * there.
     */
    Function("headsetStatus") { Headset.status() }

    /* ── the camera ───────────────────────────────────────────────────── */

    /**
     * Open the camera and start emitting `onCameraFrame`.
     *
     * Answers false rather than throwing, for the same reason `startMic` does:
     * every particular reason is already a line in logcat and none of them
     * changes what the phone tells the desktop — it could not look. Blocks
     * while Camera2 opens the device and configures the session, which is why
     * the desktop's fifteen seconds are comfortably wider than the eight this
     * waits.
     */
    Function("startCamera") { facing: String, width: Int, height: Int, fps: Int, quality: Int ->
      Camera.start(context, facing, width, height, fps, quality)
    }

    /** Give the camera back. Safe when nothing is filming. */
    Function("stopCamera") { Camera.stop() }

    /** Whether this phone is filming right now. */
    Function("isCameraRunning") { Camera.isRunning }

    /** Whether CAMERA is granted, without asking for it. */
    Function("hasCameraPermission") { Camera.hasPermission(context) }

    /**
     * Ask for it. The manifest has declared `CAMERA` since the pairing scanner
     * existed; what is new is that this module, rather than `expo-camera`, is
     * the one that needs it — and a desktop asking for a lens while the app is
     * in a pocket is exactly the case where the answer has to come back as a
     * refusal rather than as a dialog nobody sees.
     */
    AsyncFunction("requestCameraPermissionAsync") { promise: Promise ->
      Permissions.askForPermissionsWithPermissionsManager(
        appContext.permissions,
        promise,
        Manifest.permission.CAMERA,
      )
    }

    /* ── finding this phone ───────────────────────────────────────────── */

    /**
     * The desktop asking where this phone is. It answers with noise: see
     * `Locator` for why that noise is an alarm rather than a notification.
     */
    Function("locate") { seconds: Int ->
      Locator.ring(context, seconds, LinkPrefs.desktop(context))
    }

    /** The desktop calling the search off, or the app's own Stop button. */
    Function("hush") { Locator.hush(context, found = false) }

    /** Whether this phone is shouting right now. */
    Function("isLocating") { Locator.ringing }

    /**
     * Work asked for from a notification while there was no socket to do it
     * with — after a reboot, or once Android tore the runtime down under the
     * service. Drained on every connect; see `Outbox`.
     */
    AsyncFunction("drainOutbox") { Outbox.drain(context) }

    /**
     * The share waiting on the activity, or `null` when there is none.
     *
     * Taking it spends it, so a second call — the app being resumed, a screen
     * remounting — comes back empty rather than sending the same photo twice.
     * The bytes are copied out of the sharing app's provider inside this call,
     * which is why it is asynchronous: a video shared from the gallery is a
     * real copy and has no business on the JS thread.
     */
    AsyncFunction("takeShareIntent") {
      val intent = pendingShare
        ?: appContext.currentActivity?.intent?.takeIf { ShareIntake.isShare(it) }
      if (intent == null) {
        null
      } else {
        val payload = ShareIntake.read(context, intent)
        ShareIntake.spend(intent)
        pendingShare = null
        payload
      }
    }

    /**
     * The service runs without this — Android 13 only withholds the
     * notification, not the process — but a foreground service the user cannot
     * see is a worse deal for them than one they can dismiss.
     */
    Function("canPostNotifications") {
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) true
      else
        context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) ==
          PackageManager.PERMISSION_GRANTED
    }

    AsyncFunction("requestNotificationPermissionAsync") { promise: Promise ->
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
        promise.resolve(mapOf("granted" to true, "status" to "granted", "canAskAgain" to false))
        return@AsyncFunction
      }
      Permissions.askForPermissionsWithPermissionsManager(
        appContext.permissions,
        promise,
        Manifest.permission.POST_NOTIFICATIONS,
      )
    }

    /**
     * Doze is the difference between a link that survives a night on the
     * bedside table and one that goes quiet twenty minutes in. A foreground
     * service is exempt from Doze's network cutoff, but several manufacturers
     * kill background processes on their own schedule regardless, and this
     * exemption is the only lever an app is given against that.
     */
    Function("isBatteryOptimized") {
      val power = context.getSystemService(PowerManager::class.java)
      !(power?.isIgnoringBatteryOptimizations(context.packageName) ?: true)
    }

    /**
     * Deliberately the settings list rather than the direct
     * `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` dialog: the dialog needs a
     * permission Google Play treats as a policy violation for anything but a
     * short list of app types, and the list gets the user to the same switch.
     */
    AsyncFunction("openBatterySettings") {
      val activity = appContext.currentActivity ?: context
      val intent = Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)
      if (activity !is android.app.Activity) intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      try {
        activity.startActivity(intent)
      } catch (error: Exception) {
        val fallback = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS)
          .setData(Uri.fromParts("package", context.packageName, null))
          .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        activity.startActivity(fallback)
      }
    }
  }

  private fun watchNetwork() {
    if (networkCallback != null) return
    val manager = context.getSystemService(ConnectivityManager::class.java) ?: return
    val callback = object : ConnectivityManager.NetworkCallback() {
      override fun onAvailable(network: Network) = send()
      override fun onLost(network: Network) = send()
      override fun onCapabilitiesChanged(network: Network, caps: NetworkCapabilities) = send()
      private fun send() {
        try {
          // Deliberately not reading the callback's own `network` argument:
          // moving from Wi-Fi to mobile data fires `onAvailable` for the new
          // one and `onLost` for the old one in an order nobody promises, and
          // believing `onLost` would report a phone with no network at all.
          // Asking the manager what is current is ordering-proof.
          this@OmarchyLinkModule.sendEvent("onNetworkChange", describeNetwork())
        } catch (error: Exception) {
          /* the runtime went away between the callback and the send */
        }
      }
    }
    try {
      manager.registerDefaultNetworkCallback(callback)
      networkCallback = callback
    } catch (error: Exception) {
      /* some devices refuse this without a foreground app; not fatal */
    }
  }

  /**
   * As much of what the phone is attached to as Android will say for free.
   *
   * Note what is *not* here: the SSID. From Android 10 reading it needs a
   * location permission, and asking for the user's whereabouts to work out
   * whether to retry a socket is a trade nobody would accept. The transport is
   * enough — Wi-Fi or Ethernet means this handset could plausibly be on the
   * same wire as a desktop, and that is the whole question.
   *
   * `vpn` is reported separately rather than folded into `lan`, because a
   * tunnel carries private addresses over any transport underneath it. A phone
   * on mobile data inside a VPN can reach a 192.168 address, and parking it
   * would break exactly the setup that never needed parking.
   *
   * When the system cannot be asked at all the answer is the permissive one:
   * an unknown network reads as usable, and the client retries the way it did
   * before any of this existed. That is not the same as the system answering
   * "nothing" — see `gone` below.
   */
  private fun describeNetwork(): Map<String, Any?> {
    val unknown = mapOf<String, Any?>("online" to true, "lan" to true, "vpn" to false)
    val gone = mapOf<String, Any?>("online" to false, "lan" to false, "vpn" to false)
    val manager = context.getSystemService(ConnectivityManager::class.java) ?: return unknown
    val active = try {
      manager.activeNetwork
    } catch (error: Exception) {
      return unknown
    } ?: return gone
    // A null here is not "cannot say": `getNetworkCapabilities` answers null
    // for a network connectivity no longer knows about, and during a teardown
    // `activeNetwork` still hands back the handle of the one that is going.
    // Reading that as unknown — and so as usable — is what left a phone in
    // aeroplane mode retrying all night: the callback that reported the loss
    // was the last one there would be, so nothing ever corrected the answer.
    val caps = try {
      manager.getNetworkCapabilities(active)
    } catch (error: Exception) {
      return unknown
    } ?: return gone
    return mapOf(
      // A network the system will not certify as carrying the internet is one
      // the socket has no business waking up for.
      "online" to caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET),
      "lan" to (
        caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) ||
          caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET)
        ),
      "vpn" to caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN),
    )
  }

  private fun unwatchNetwork() {
    val callback = networkCallback ?: return
    networkCallback = null
    try {
      context.getSystemService(ConnectivityManager::class.java)?.unregisterNetworkCallback(callback)
    } catch (error: Exception) {
      /* already gone */
    }
  }
}
