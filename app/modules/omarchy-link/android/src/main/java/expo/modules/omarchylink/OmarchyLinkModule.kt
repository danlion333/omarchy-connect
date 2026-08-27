package expo.modules.omarchylink

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.ConnectivityManager
import android.net.Network
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

    Events("onNetworkChange")

    OnStartObserving { watchNetwork() }
    OnStopObserving { unwatchNetwork() }
    OnDestroy { unwatchNetwork() }

    Function("isAvailable") { true }

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

    /** What the ongoing notification says, kept in step with the socket. */
    Function("setStatus") { status: String, desktop: String? ->
      LinkPrefs.setStatus(context, status)
      LinkPrefs.setDesktop(context, desktop)
      LinkService.refresh(context)
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
      private fun send() {
        try {
          this@OmarchyLinkModule.sendEvent("onNetworkChange", mapOf<String, Any?>())
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
