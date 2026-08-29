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
import android.util.Base64
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetAddress
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

  /** A magic packet is 102 bytes; nothing this sends has any business being large. */
  private val MAX_DATAGRAM = 1024

  override fun definition() = ModuleDefinition {
    Name("OmarchyLink")

    Events("onNetworkChange", "onOutbox", "onLinkReconnect")

    /**
     * The notification buttons run in a broadcast receiver, which has no way
     * to reach a module instance on its own. This is that way: set while a
     * runtime exists, and the receiver falls back to its own persistence when
     * it is null.
     */
    OnCreate {
      LinkActionReceiver.listener = { event, payload ->
        try {
          this@OmarchyLinkModule.sendEvent(event, payload)
        } catch (error: Exception) {
          /* the runtime went away mid-broadcast; the backlog still has it */
        }
      }
    }

    OnStartObserving { watchNetwork() }
    OnStopObserving { unwatchNetwork() }
    OnDestroy {
      LinkActionReceiver.listener = null
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

    /**
     * Work asked for from a notification while there was no socket to do it
     * with — after a reboot, or once Android tore the runtime down under the
     * service. Drained on every connect; see `Outbox`.
     */
    AsyncFunction("drainOutbox") { Outbox.drain(context) }

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

    /**
     * One UDP datagram, at an address that is usually a broadcast one.
     *
     * This exists for Wake-on-LAN, and it is deliberately dumber than that:
     * the magic packet is built in TypeScript, where it can be tested by the
     * suite rather than only by a sleeping desktop. All that is left for the
     * native half is the one thing React Native has no answer for — there is
     * no UDP socket in the runtime, at any price.
     *
     * `AsyncFunction` bodies run off the JS thread, so the socket is opened on
     * a background thread and `NetworkOnMainThreadException` never applies.
     * Broadcasting needs no Android permission beyond `INTERNET`; the multicast
     * lock everybody remembers is for *receiving*.
     */
    AsyncFunction("sendDatagram") { payload: String, host: String, port: Int ->
      if (port !in 1..65535) throw CodedException("port out of range: $port")
      val bytes = try {
        Base64.decode(payload, Base64.DEFAULT)
      } catch (error: IllegalArgumentException) {
        throw CodedException("payload is not base64")
      }
      if (bytes.isEmpty() || bytes.size > MAX_DATAGRAM) {
        throw CodedException("a datagram of ${bytes.size} bytes is not one this sends")
      }
      DatagramSocket().use { socket ->
        socket.broadcast = true
        socket.send(DatagramPacket(bytes, bytes.size, InetAddress.getByName(host), port))
      }
      bytes.size
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
   * When anything here cannot be determined the answer is the permissive one:
   * an unknown network reads as usable, and the client retries the way it did
   * before any of this existed.
   */
  private fun describeNetwork(): Map<String, Any?> {
    val unknown = mapOf<String, Any?>("online" to true, "lan" to true, "vpn" to false)
    val manager = context.getSystemService(ConnectivityManager::class.java) ?: return unknown
    val active = try {
      manager.activeNetwork
    } catch (error: Exception) {
      return unknown
    } ?: return mapOf<String, Any?>("online" to false, "lan" to false, "vpn" to false)
    val caps = try {
      manager.getNetworkCapabilities(active)
    } catch (error: Exception) {
      null
    } ?: return unknown
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
