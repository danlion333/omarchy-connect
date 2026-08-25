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
    val parts = Telephony.Sms.Intents.getMessagesFromIntent(intent) ?: return
    if (parts.isEmpty()) return

    val from = parts[0].displayOriginatingAddress
    val body = parts.joinToString("") { it.displayMessageBody ?: "" }
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
