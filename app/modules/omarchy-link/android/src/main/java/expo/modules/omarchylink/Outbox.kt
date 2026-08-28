package expo.modules.omarchylink

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

/**
 * Work asked for from the notification shade before the app was there to do it.
 *
 * A notification button starts a broadcast receiver, and a broadcast receiver
 * can run in a process whose React runtime is not up — after a reboot, or once
 * Android has torn the runtime down under a service it kept. Anything that
 * needs the socket, or needs a file fetched, therefore lands here first: the
 * receiver asks for the service, the service brings JavaScript back, and the
 * link drains this the moment it has a connection.
 *
 * Two kinds so far, and both are one line of intent:
 *
 *   - `reply` — `id` is an agent session, `text` the answer typed into it.
 *   - `save` — `id` is an offer token, `text` the file's name.
 *
 * Bounded, and small: the only thing that ever lands here was asked for a
 * second ago by somebody still holding the phone.
 */
object Outbox {
  private const val PREFS = "omarchy-connect.link"
  private const val KEY = "outbox"
  private const val LIMIT = 30

  private fun prefs(context: Context) =
    context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

  @Synchronized
  fun add(context: Context, kind: String, id: String, text: String) {
    val list = read(context)
    list.put(JSONObject(mapOf("kind" to kind, "id" to id, "text" to text)))
    // Drop from the front: the oldest unsent thing is the one worth losing.
    while (list.length() > LIMIT) list.remove(0)
    prefs(context).edit().putString(KEY, list.toString()).apply()
  }

  @Synchronized
  fun drain(context: Context): List<Map<String, Any?>> {
    val list = read(context)
    prefs(context).edit().remove(KEY).apply()
    return (0 until list.length()).mapNotNull { index ->
      val item = list.optJSONObject(index) ?: return@mapNotNull null
      val kind = item.optString("kind").ifBlank { return@mapNotNull null }
      val id = item.optString("id").ifBlank { return@mapNotNull null }
      mapOf("kind" to kind, "id" to id, "text" to item.optString("text"))
    }
  }

  private fun read(context: Context): JSONArray =
    try {
      JSONArray(prefs(context).getString(KEY, "[]") ?: "[]")
    } catch (error: Exception) {
      JSONArray()
    }
}
