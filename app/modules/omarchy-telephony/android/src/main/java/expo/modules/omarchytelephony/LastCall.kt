package expo.modules.omarchytelephony

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.provider.CallLog

/**
 * The phone's own record of the call that just finished.
 *
 * The last resort for the question "who was that?". The telephony broadcast
 * has never carried a number on any build this app targets, and the dialler's
 * notification — the road that normally answers it — is silent when the user
 * has not granted notification access, when the caller withholds their number,
 * or when the process was started fresh for the ending and never saw the card.
 * In all of those the `ended` report went out anonymous.
 *
 * Android has been writing the call down the whole time, and this app already
 * holds `READ_CALL_LOG` for the recent-calls list. So when a call ends with
 * nobody named, the log is asked. It is asked *narrowly*: the newest entry, and
 * only if it plausibly belongs to the call that just ended — the log is a list
 * of every call this phone has ever had, and the wrong row would put a
 * stranger's name on this conversation.
 *
 * It can legitimately come back empty. The provider is written by the dialler
 * at its own pace and the row is sometimes not there yet when `IDLE` lands, a
 * few hundred milliseconds too early. A broadcast receiver may not sit and
 * wait, so this reports the miss rather than papering over it.
 */
object LastCall {
  /**
   * How far from the ending the log entry may sit and still be this call.
   *
   * `CallLog.DATE` is the moment the call *started*, so a two-hour
   * conversation's row is two hours old the second it ends: the entry is
   * matched on when it ended — its start plus its duration — and only a call
   * that has not long stopped counts. Missed and rejected calls have no
   * duration, and for those the start is the end.
   */
  private const val GRACE_MS = 120_000L

  /** A number, a name, and which way it went. Any of them may be null. */
  class Entry(val from: String?, val name: String?, val direction: String?, val missed: Boolean)

  /**
   * The newest logged call, when it can only be the one that just ended.
   *
   * [notBefore] is the moment this handset went off-hook, when that is known;
   * a row older than that belongs to an earlier call and is refused. When
   * nothing is known — the true orphan, a process that saw only the ending —
   * recency is the whole of the evidence there is.
   */
  fun since(context: Context, notBefore: Long): Entry? {
    if (context.checkSelfPermission(Manifest.permission.READ_CALL_LOG) != PackageManager.PERMISSION_GRANTED) {
      Trace.detail("call.log.denied")
      return null
    }
    return try {
      val projection = arrayOf(
        CallLog.Calls.NUMBER,
        CallLog.Calls.CACHED_NAME,
        CallLog.Calls.DATE,
        CallLog.Calls.DURATION,
        CallLog.Calls.TYPE,
      )
      context.contentResolver
        .query(CallLog.Calls.CONTENT_URI, projection, null, null, "${CallLog.Calls.DATE} DESC")
        ?.use { cursor ->
          if (!cursor.moveToNext()) {
            Trace.evt("call.log.miss", "reason" to "empty")
            return null
          }
          val at = cursor.getLong(2)
          val endedAt = at + cursor.getLong(3) * 1000L
          val now = System.currentTimeMillis()
          if (now - endedAt > GRACE_MS) {
            // An older call's row, which means this call's own row has not
            // been written yet. Saying so is the difference between "the log
            // did not know" and "the log was never asked".
            Trace.evt("call.log.miss", "reason" to "not-written", "staleMs" to (now - endedAt))
            return null
          }
          if (notBefore > 0L && at < notBefore - GRACE_MS) {
            Trace.evt("call.log.miss", "reason" to "before-this-call")
            return null
          }
          val type = cursor.getInt(4)
          val number = cursor.getString(0)?.takeIf { it.isNotBlank() }
          val missed = type == CallLog.Calls.MISSED_TYPE || type == CallLog.Calls.REJECTED_TYPE
          Entry(
            from = number,
            name = cursor.getString(1)?.takeIf { it.isNotBlank() } ?: Contacts.nameFor(context, number),
            direction = if (type == CallLog.Calls.OUTGOING_TYPE) "outgoing" else "incoming",
            missed = missed,
          )
        }
    } catch (error: Exception) {
      // A receiver that throws takes the process with it, and this is the
      // least important thing it does.
      Trace.warn("call.log.failed", "error" to error.javaClass.simpleName)
      null
    }
  }
}
