package expo.modules.omarchylink

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * Puts the link back after a reboot or an app update.
 *
 * Without this a phone that restarted in the night is simply missing from the
 * desktop until someone opens the app — which is the failure this whole module
 * exists to prevent, just on a longer fuse.
 *
 * `BOOT_COMPLETED` is one of the few broadcasts still allowed to start a
 * foreground service from the background on Android 12 and later; the start is
 * guarded anyway, because a manufacturer that disagrees should cost us a log
 * line rather than a crash loop at boot.
 */
class BootReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    when (intent.action) {
      Intent.ACTION_BOOT_COMPLETED,
      Intent.ACTION_MY_PACKAGE_REPLACED -> Unit
      else -> return
    }
    if (!LinkPrefs.isEnabled(context)) {
      // A phone that comes back from a reboot without its link, because the
      // user turned it off weeks ago, is indistinguishable from this receiver
      // never running — until one of them says so.
      Trace.evt("boot.skipped", "action" to intent.action, "reason" to "link-disabled")
      return
    }
    Trace.evt("boot", "action" to intent.action)
    // The socket is not up yet and the notification is drawn before any
    // JavaScript runs, so say what is actually true.
    LinkPrefs.setStatus(context, "connecting")
    LinkPrefs.setConnected(context, false)
    try {
      LinkService.start(context)
    } catch (error: Exception) {
      /* the app reconnects the next time it is opened */
      Trace.fail("boot.start.failed", error)
    }
  }
}
