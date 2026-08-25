package expo.modules.omarchytelephony

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.telephony.TelephonyManager

/**
 * Ringing, answered, over.
 *
 * Android stopped handing out the caller's number to apps without
 * `READ_CALL_LOG` on API 29, and it never sends one for OFFHOOK or IDLE at
 * all. A ringing number is therefore remembered so the "ended" event can still
 * say who the call was with.
 */
class PhoneStateReceiver : BroadcastReceiver() {
  companion object {
    @Volatile private var ringingNumber: String? = null
    @Volatile private var ringingName: String? = null
    @Volatile private var lastState: String? = null
    @Volatile private var answered = false
  }

  override fun onReceive(context: Context, intent: Intent) {
    if (intent.action != TelephonyManager.ACTION_PHONE_STATE_CHANGED) return
    val raw = intent.getStringExtra(TelephonyManager.EXTRA_STATE) ?: return

    val state = when (raw) {
      TelephonyManager.EXTRA_STATE_RINGING -> "ringing"
      TelephonyManager.EXTRA_STATE_OFFHOOK -> "active"
      TelephonyManager.EXTRA_STATE_IDLE -> "ended"
      else -> return
    }
    // The broadcast fires more than once for the same state on some devices.
    if (state == lastState) return
    lastState = state

    if (state == "ringing") {
      @Suppress("DEPRECATION")
      ringingNumber = intent.getStringExtra(TelephonyManager.EXTRA_INCOMING_NUMBER)
      ringingName = Contacts.nameFor(context, ringingNumber)
      answered = false
    }
    if (state == "active") answered = true

    val event = mapOf(
      "kind" to "call",
      "at" to System.currentTimeMillis(),
      "state" to state,
      "from" to ringingNumber,
      "name" to ringingName,
      // A call that goes straight from ringing to idle was never picked up —
      // which is the one the desktop most wants to tell you about.
      "missed" to (state == "ended" && !answered),
    )
    OmarchyTelephonyModule.deliver(context, "onCall", event)

    if (state == "ended") {
      ringingNumber = null
      ringingName = null
      answered = false
    }
  }
}
