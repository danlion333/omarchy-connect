package expo.modules.omarchytelephony

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.provider.Telephony

/**
 * One incoming SMS. Long messages arrive as several parts in the same
 * broadcast, so the bodies are stitched back together before anyone sees them.
 */
class SmsReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    if (intent.action != Telephony.Sms.Intents.SMS_RECEIVED_ACTION) return
    val parts = Telephony.Sms.Intents.getMessagesFromIntent(intent)
    if (parts == null || parts.isEmpty()) {
      // A broadcast that carried no message is either an OEM quirk or a
      // stitching bug, and both are invisible without this.
      Trace.warn("sms.empty", "parts" to (parts?.size ?: "null"))
      return
    }

    val from = parts[0].displayOriginatingAddress
    val body = parts.joinToString("") { it.displayMessageBody ?: "" }
    // The shape of the message, never the message. `parts` is here because a
    // long SMS arriving as several and being stitched back together wrongly is
    // a real failure mode, and the count is what shows it.
    Trace.evt("sms.received", "parts" to parts.size, "from" to Trace.mark(from), "chars" to Trace.len(body))
    val event = mapOf(
      "kind" to "sms",
      "at" to System.currentTimeMillis(),
      "from" to from,
      "name" to Contacts.nameFor(context, from),
      "body" to body,
    )
    OmarchyTelephonyModule.deliver(context, "onMessage", event)
  }
}
