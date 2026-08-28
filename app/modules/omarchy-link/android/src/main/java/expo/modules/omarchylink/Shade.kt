package expo.modules.omarchylink

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build

/**
 * The bookkeeping every notification in this app shares.
 *
 * Three things kept turning up in each of them, and all three are the sort
 * that is quietly wrong until it is centralised:
 *
 *   - **Identity.** A notification id is an int and everything this app has to
 *     talk about — a session, an offer token, the clipboard — is a string. The
 *     hash of `kind:key` gives one id per thing per kind, stable across the
 *     process dying, which a counter would not be. Colliding with the
 *     foreground service's own id would take the link's status line down with
 *     it, so that one value is stepped over.
 *   - **What is on screen.** Notifications outlive the process that posted
 *     them. Clearing the shade after a restart — or when the link is switched
 *     off entirely — means knowing what a previous incarnation put there, so
 *     the live keys live in preferences rather than in a field.
 *   - **Distinct PendingIntents.** Two PendingIntents are the same object to
 *     Android when they differ only by extras, which is exactly how one
 *     agent's reply button ends up answering another's. Every intent built
 *     here carries its identity in the data URI, where Android does look.
 */
object Shade {
  private const val PREFS = "omarchy-connect.link"

  /** Namespaces. One notification per key per kind. */
  const val AGENT = "agent"
  const val DONE = "done"
  const val FILE = "file"
  const val CLIP = "clip"

  private val KINDS = listOf(AGENT, DONE, FILE, CLIP)

  fun manager(context: Context): NotificationManager? =
    context.applicationContext.getSystemService(NotificationManager::class.java)

  fun id(kind: String, key: String): Int {
    val hash = "$kind:$key".hashCode()
    return if (hash == LinkService.NOTIFICATION_ID) hash + 1 else hash
  }

  /** Posts, and remembers that it did. Silent about a refused permission. */
  fun show(context: Context, kind: String, key: String, notification: Notification) {
    val app = context.applicationContext
    try {
      manager(app)?.notify(id(kind, key), notification)
      remember(app, kind, key)
    } catch (error: SecurityException) {
      // Notifications were never granted on Android 13+. Everything else about
      // the link works; the user simply is not told, which is their choice.
    }
  }

  fun cancel(context: Context, kind: String, key: String) {
    val app = context.applicationContext
    try {
      manager(app)?.cancel(id(kind, key))
    } catch (error: Exception) {
      /* nothing here is worth crashing over */
    }
    forget(app, kind, key)
  }

  fun cancelAll(context: Context, kind: String) {
    val app = context.applicationContext
    live(app, kind).forEach { key ->
      try {
        manager(app)?.cancel(id(kind, key))
      } catch (error: Exception) {
        /* keep clearing the rest */
      }
    }
    prefs(app).edit().remove(setKey(kind)).apply()
  }

  /** Everything this app has put up, of every kind. */
  fun cancelEverything(context: Context) = KINDS.forEach { cancelAll(context, it) }

  fun live(context: Context, kind: String): Set<String> =
    prefs(context).getStringSet(setKey(kind), emptySet())?.toSet() ?: emptySet()

  fun holds(context: Context, kind: String, key: String) = live(context, kind).contains(key)

  /**
   * A channel is created once and then belongs to the user — importance they
   * have changed by hand is never overwritten, which is why this returns early
   * rather than reconfiguring.
   */
  fun channel(context: Context, id: String, name: String, description: String, importance: Int) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val manager = manager(context) ?: return
    if (manager.getNotificationChannel(id) != null) return
    val channel = NotificationChannel(id, name, importance)
    channel.description = description
    if (importance <= NotificationManager.IMPORTANCE_LOW) {
      channel.setShowBadge(false)
      channel.enableVibration(false)
      channel.setSound(null, null)
    }
    manager.createNotificationChannel(channel)
  }

  /** Opens the app at a deep link the JavaScript side knows how to route. */
  fun open(context: Context, kind: String, key: String, url: String): PendingIntent? {
    val intent = Intent(Intent.ACTION_VIEW, Uri.parse(url))
      .setPackage(context.packageName)
      .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    return try {
      PendingIntent.getActivity(context, id(kind, key), intent, flags(false))
    } catch (error: Exception) {
      null
    }
  }

  /** A button on a notification, answered by `LinkActionReceiver`. */
  fun act(
    context: Context,
    action: String,
    kind: String,
    key: String,
    extras: Map<String, String> = emptyMap(),
    mutable: Boolean = false,
  ): PendingIntent? {
    val intent = Intent(context, LinkActionReceiver::class.java)
      .setAction(action)
      // Identity where Android reads it, rather than only in the extras it
      // ignores when deciding whether two PendingIntents are the same.
      .setData(Uri.parse("omarchy-connect://$action/$kind/${Uri.encode(key)}"))
      .putExtra(LinkActionReceiver.EXTRA_KIND, kind)
      .putExtra(LinkActionReceiver.EXTRA_KEY, key)
    extras.forEach { (name, value) -> intent.putExtra(name, value) }
    return try {
      PendingIntent.getBroadcast(context, id(kind, key), intent, flags(mutable))
    } catch (error: Exception) {
      null
    }
  }

  /**
   * `FLAG_MUTABLE` only exists from Android 12, and before it a PendingIntent
   * was mutable anyway — so the flag is added where it is understood and left
   * off where it is neither needed nor recognised. Only a `RemoteInput` needs
   * one: it has to write the typed answer back into the intent.
   */
  fun flags(mutable: Boolean): Int {
    val base = PendingIntent.FLAG_UPDATE_CURRENT
    return when {
      mutable && Build.VERSION.SDK_INT >= Build.VERSION_CODES.S -> base or PendingIntent.FLAG_MUTABLE
      mutable -> base
      Build.VERSION.SDK_INT >= Build.VERSION_CODES.M -> base or PendingIntent.FLAG_IMMUTABLE
      else -> base
    }
  }

  private fun prefs(context: Context) =
    context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

  private fun setKey(kind: String) = "alerts.$kind"

  @Synchronized
  private fun remember(context: Context, kind: String, key: String) {
    val next = live(context, kind).toMutableSet()
    if (!next.add(key)) return
    prefs(context).edit().putStringSet(setKey(kind), next).apply()
  }

  @Synchronized
  private fun forget(context: Context, kind: String, key: String) {
    val next = live(context, kind).toMutableSet()
    if (!next.remove(key)) return
    prefs(context).edit().putStringSet(setKey(kind), next).apply()
  }
}
