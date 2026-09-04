package expo.modules.omarchytelephony

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.provider.Telephony
import java.util.UUID

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
      /**
       * This message, told apart from every other one for as long as it
       * matters.
       *
       * The desktop is sent a batch and, if the socket dies before the answer
       * comes back, sends the same batch again on the next connection —
       * because nothing on this side can know whether the first one landed.
       * The key is what lets the desktop recognise the second copy instead of
       * writing a second row, ticking the counter again and raising a second
       * card. It is minted here, once, at the moment the broadcast arrives,
       * so the live event and the copy `Backlog` keeps across a process death
       * are the same message and say so.
       */
      "key" to UUID.randomUUID().toString(),
      "at" to System.currentTimeMillis(),
      "from" to from,
      "name" to Contacts.nameFor(context, from),
      "body" to body,
    )
    OmarchyTelephonyModule.deliver(context, "onMessage", event)
  }
}
