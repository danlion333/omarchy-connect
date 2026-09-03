package expo.modules.omarchytelephony

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

/**
 * What arrived while nobody was listening.
 *
 * A message can reach the phone at three in the morning with the app closed
 * and the desktop asleep. Android will start this app's process to deliver the
 * broadcast, but no JavaScript is running to forward it anywhere — so the
 * receiver writes it down here instead, and the app drains the list the next
 * time it connects.
 *
 * Bounded on purpose: this is a hand-off buffer, not a message store. The
 * phone already keeps the real archive.
 */
object Backlog {
  private const val PREFS = "omarchy-connect.telephony"
  private const val KEY = "backlog"
  private const val LIMIT = 200

  private fun prefs(context: Context) = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

  @Synchronized
  fun add(context: Context, entry: Map<String, Any?>) {
    val list = readRaw(context)
    list.put(JSONObject(entry))
    // Drop from the front: the oldest unseen event is the one worth losing.
    while (list.length() > LIMIT) {
      list.remove(0)
      // A message the desktop will now never see. The buffer is bounded on
      // purpose, but reaching the bound means the phone has been unable to
      // speak for a long time, and that is news.
      Trace.warn("backlog.overflow", "limit" to LIMIT)
    }
    prefs(context).edit().putString(KEY, list.toString()).apply()
    Trace.detail("backlog.add", "kind" to entry["kind"], "held" to list.length())
  }

  @Synchronized
  fun drain(context: Context): List<Map<String, Any?>> {
    val list = readRaw(context)
    prefs(context).edit().remove(KEY).apply()
    val held = (0 until list.length()).mapNotNull { index ->
      val item = list.optJSONObject(index) ?: return@mapNotNull null
      item.keys().asSequence().associateWith { key -> if (item.isNull(key)) null else item.get(key) }
    }
    if (held.isNotEmpty()) Trace.evt("backlog.drain", "count" to held.size)
    return held
  }

  @Synchronized
  fun size(context: Context): Int = readRaw(context).length()

  private fun readRaw(context: Context): JSONArray =
    try {
      JSONArray(prefs(context).getString(KEY, "[]") ?: "[]")
    } catch (error: Exception) {
      // Everything held is lost at this point, and this is the only notice of
      // it that will ever be given.
      Trace.warn("backlog.unreadable", "error" to error.javaClass.simpleName)
      JSONArray()
    }
}
