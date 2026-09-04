package expo.modules.omarchytelephony

import android.content.Context
import org.json.JSONObject

/**
 * The conversation in hand, written down where a killed process can find it.
 *
 * Everything `PhoneStateReceiver` knows about a call — the token the desktop
 * gathers its reports under, who is on the line, which way it went, when the
 * line opened — lived only in that class's companion object, which is to say
 * in the memory of a process Android is free to end at any moment. It commonly
 * does end it: a phone under memory pressure kills the background app of
 * somebody who is talking, and then starts the process again a minute later
 * purely to deliver the `IDLE` broadcast. The receiver that woke up in that
 * new process had never seen the call begin, so it minted a *second* token and
 * reported the ending of a call the desktop had never been told about, with no
 * number, no name and no direction. One conversation, two lines, and the
 * second one blank.
 *
 * So the identity of a live call goes to disk, in the same `SharedPreferences`
 * file [Backlog] already uses to survive exactly this — the process dying with
 * something still to say. It is a hand-off, not a history: one record, rewritten
 * as the call moves along, removed the moment the call is over.
 *
 * Written with `commit()` rather than `apply()`. `apply()` returns immediately
 * and finishes the write on another thread, which is the right trade almost
 * everywhere and the wrong one here: the whole point of this record is to be on
 * disk when the process is killed without warning, and the kill can land inside
 * that window. The write is a few dozen bytes, three times per call.
 */
object LiveCall {
  private const val PREFS = "omarchy-connect.telephony"
  private const val KEY = "call"

  /**
   * How old a held record may be and still be believed.
   *
   * A record outlives its call only when the ending was never seen at all —
   * the process was killed and Android chose not to start it again, or the
   * broadcast was lost. What is left is a conversation that will never be
   * closed, and resurrecting it onto some unrelated later `IDLE` would report
   * yesterday's caller as today's. Longer than any call anyone has, short
   * enough that a stale record dies within the day.
   */
  const val STALE_MS = 6 * 60 * 60 * 1000L

  /** One call, as much of it as the last process managed to learn. */
  class Held(
    val callId: String,
    val direction: String?,
    val from: String?,
    val name: String?,
    val state: String?,
    val answered: Boolean,
    val namedOut: Boolean,
    val offHookAt: Long,
    val chronometer: Long,
    val savedAt: Long,
  )

  private fun prefs(context: Context) = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

  @Synchronized
  fun save(context: Context, held: Held) {
    val json = JSONObject()
      .put("call", held.callId)
      .put("direction", held.direction)
      .put("from", held.from)
      .put("name", held.name)
      .put("state", held.state)
      .put("answered", held.answered)
      .put("namedOut", held.namedOut)
      .put("offHookAt", held.offHookAt)
      .put("chronometer", held.chronometer)
      .put("savedAt", System.currentTimeMillis())
    try {
      prefs(context).edit().putString(KEY, json.toString()).commit()
    } catch (error: Exception) {
      // Nothing to do about it, and silence here is what made the original
      // bug unreadable: the next process would simply find no record and
      // have no way to know one had been meant.
      Trace.warn("call.hold.failed", "error" to error.javaClass.simpleName)
    }
  }

  @Synchronized
  fun clear(context: Context) {
    try {
      prefs(context).edit().remove(KEY).commit()
    } catch (error: Exception) {
      Trace.warn("call.hold.clear.failed", "error" to error.javaClass.simpleName)
    }
  }

  /** What was held, or null when there is nothing worth believing. */
  @Synchronized
  fun read(context: Context): Held? {
    val raw = prefs(context).getString(KEY, null) ?: return null
    return try {
      val json = JSONObject(raw)
      val callId = json.optString("call").takeIf { it.isNotEmpty() }
      val savedAt = json.optLong("savedAt")
      if (callId == null || savedAt <= 0L) {
        clear(context)
        return null
      }
      val age = System.currentTimeMillis() - savedAt
      if (age > STALE_MS || age < -STALE_MS) {
        Trace.evt("call.hold.stale", "ageMs" to age, "limit" to STALE_MS)
        clear(context)
        return null
      }
      Held(
        callId = callId,
        direction = json.optString("direction").takeIf { it.isNotEmpty() && !json.isNull("direction") },
        from = json.optString("from").takeIf { it.isNotEmpty() && !json.isNull("from") },
        name = json.optString("name").takeIf { it.isNotEmpty() && !json.isNull("name") },
        state = json.optString("state").takeIf { it.isNotEmpty() && !json.isNull("state") },
        answered = json.optBoolean("answered"),
        namedOut = json.optBoolean("namedOut"),
        offHookAt = json.optLong("offHookAt"),
        chronometer = json.optLong("chronometer"),
        savedAt = savedAt,
      )
    } catch (error: Exception) {
      Trace.warn("call.hold.unreadable", "error" to error.javaClass.simpleName)
      clear(context)
      null
    }
  }
}
