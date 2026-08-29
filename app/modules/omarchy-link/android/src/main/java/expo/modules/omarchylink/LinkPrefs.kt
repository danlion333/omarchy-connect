package expo.modules.omarchylink

import android.content.Context

/**
 * The little the service needs to know before any JavaScript exists.
 *
 * On a cold start — a reboot, or Android restarting a killed service — the
 * decision to stay connected has to be readable without a React instance, and
 * the notification has to say something truthful before the socket is up.
 */
object LinkPrefs {
  private const val PREFS = "omarchy-connect.link"
  private const val KEY_ENABLED = "enabled"
  private const val KEY_STATUS = "status"
  private const val KEY_DESKTOP = "desktop"
  private const val KEY_CONNECTED = "connected"
  private const val KEY_WAITING = "waiting"

  private fun prefs(context: Context) =
    context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

  /** Whether the user wants the link kept up while the app is closed. */
  fun isEnabled(context: Context): Boolean = prefs(context).getBoolean(KEY_ENABLED, false)

  /**
   * Whether anyone has decided yet. Distinct from `isEnabled` being false: a
   * phone paired before this existed has made no choice, and the app treats
   * that as "on" — an offline phone is the bug this module was written for —
   * whereas a phone that was switched off has said what it wants.
   */
  fun hasChoice(context: Context): Boolean = prefs(context).contains(KEY_ENABLED)

  fun setEnabled(context: Context, value: Boolean) {
    prefs(context).edit().putBoolean(KEY_ENABLED, value).apply()
  }

  /** Last line shown in the notification, so a restart does not start blank. */
  fun status(context: Context): String = prefs(context).getString(KEY_STATUS, "") ?: ""

  fun setStatus(context: Context, value: String) {
    prefs(context).edit().putString(KEY_STATUS, value).apply()
  }

  /** The paired desktop's name, for the notification title. */
  fun desktop(context: Context): String? = prefs(context).getString(KEY_DESKTOP, null)

  fun setDesktop(context: Context, value: String?) {
    prefs(context).edit().putString(KEY_DESKTOP, value).apply()
  }

  /**
   * Whether the socket is actually up, as opposed to merely wanted.
   *
   * The notification used to read the desktop's name and say "Connected to"
   * regardless, which made it a decoration rather than a status line — the one
   * thing a KDE Connect style notification exists to be. Kept separately from
   * the status text because the text is prose and this is what the title, the
   * icon and the action button all branch on.
   */
  fun isConnected(context: Context): Boolean = prefs(context).getBoolean(KEY_CONNECTED, false)

  fun setConnected(context: Context, value: Boolean) {
    prefs(context).edit().putBoolean(KEY_CONNECTED, value).apply()
  }

  /**
   * Whether the phone has stopped dialling on purpose.
   *
   * Disconnected used to mean one thing, so the notification could say "the
   * phone keeps trying" and be right. It no longer does: on a network that
   * cannot reach this desktop the retry loop parks itself rather than fail
   * every fifteen seconds all night, and a line promising it keeps trying
   * would then be exactly the kind of decoration the title was fixed to stop
   * being. See `lib/retry`.
   */
  fun isWaiting(context: Context): Boolean = prefs(context).getBoolean(KEY_WAITING, false)

  fun setWaiting(context: Context, value: Boolean) {
    prefs(context).edit().putBoolean(KEY_WAITING, value).apply()
  }

  /**
   * Forgets everything the last socket said about itself, in one write.
   *
   * All three belong to a socket, and a service starting or stopping is a
   * socket that does not exist — so they have to go together. Clearing the two
   * flags and leaving the text produced a notification that argued with
   * itself: `waiting` false drew "the phone keeps trying" under a title still
   * reading "waiting for a network", written by a client that had been parked
   * before the restart. The text falls back to "starting up", which is both
   * true at that moment and true about the flags underneath it.
   */
  fun forgetConnection(context: Context) {
    prefs(context)
      .edit()
      .putString(KEY_STATUS, "")
      .putBoolean(KEY_CONNECTED, false)
      .putBoolean(KEY_WAITING, false)
      .apply()
  }
}
