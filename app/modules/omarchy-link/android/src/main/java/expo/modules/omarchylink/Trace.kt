package expo.modules.omarchylink

import android.util.Log
import java.security.MessageDigest
import java.security.SecureRandom

/**
 * What this module did, in a form something other than a person can read.
 *
 * Everything in here runs where no debugger reaches: a broadcast receiver
 * Android woke for ten seconds, a service restarted into a process whose React
 * runtime was torn down underneath it, a notification listener firing while
 * the phone is in a pocket. When one of them misbehaves the only evidence that
 * outlives the moment is whatever was written to logcat while it happened —
 * and until this file existed the module wrote nothing at all. A filtered
 * `adb logcat` came back empty, and that emptiness said nothing. It did not
 * say the code had not run; it said nobody had asked it to speak.
 *
 * Two rules shape the format, and both follow from who reads it.
 *
 *   - **One line, `evt=` first, then `key=value`.** A person skims it and a
 *     test greps it, so it has to work for both. `evt=service.foreground
 *     ok=false` is a fact either one can act on; a sentence about failing to
 *     start a foreground service is a fact only for the person.
 *   - **Nothing that belongs to the user goes in it.** This app carries
 *     messages, contacts, the clipboard and the numbers people ring. logcat is
 *     readable over adb by whoever is holding the phone — and by whoever they
 *     hand it to at a repair counter — so a message body or a caller's number
 *     written here would be a leak no feature asked for. [mark] and [len] go
 *     instead: enough to follow one thing across several lines, never enough
 *     to read it.
 *
 * Levels carry meaning rather than emphasis. [evt] is a fact worth asserting
 * on and is always emitted. [detail] is for following a mechanism and stays
 * off until somebody asks for it:
 *
 * ```
 * adb shell setprop log.tag.OmarchyLink DEBUG
 * adb logcat -s OmarchyLink:V OmarchyTelephony:V
 * ```
 *
 * [warn] is something that went wrong and was survived, [fail] the same with
 * the throwable attached. Both exist for the failures this module deliberately
 * swallows — and it swallows a great many, because a crash in a receiver is
 * worse than a missed event. Swallowing them silently is what made them
 * invisible; swallowing them out loud is the point of this file.
 *
 * The telephony module keeps its own copy of this under its own tag. Gradle
 * modules cannot share a source file, and two short ones cost less than a
 * third module built to hold them.
 */
internal object Trace {
  const val TAG = "OmarchyLink"

  /**
   * Correlates without identifying.
   *
   * A test wants to know that the number which rang is the number the call
   * ended with. It does not want the number, and nothing reading logcat should
   * be able to recover it — so this is a digest under a salt drawn once per
   * process and never written down. The same value marks the same thing across
   * one run of the app and means nothing at all across two, which is exactly
   * as far as the question ever goes.
   */
  fun mark(value: String?): String {
    val text = value?.trim().orEmpty()
    if (text.isEmpty()) return "none"
    val digest = MessageDigest.getInstance("SHA-256")
    digest.update(salt)
    digest.update(text.toByteArray())
    return digest.digest().take(3).joinToString("") { byte -> "%02x".format(byte) }
  }

  /** How much of it there was, which is all a test ever needs to know. */
  fun len(value: CharSequence?): String = value?.length?.toString() ?: "none"

  /** A fact about what happened. Always emitted. */
  fun evt(name: String, vararg fields: Pair<String, Any?>) {
    Log.i(TAG, line(name, fields))
  }

  /** How it happened. Emitted only once somebody turns this tag up to DEBUG. */
  fun detail(name: String, vararg fields: Pair<String, Any?>) {
    if (Log.isLoggable(TAG, Log.DEBUG)) Log.d(TAG, line(name, fields))
  }

  /** Something went wrong and was survived. */
  fun warn(name: String, vararg fields: Pair<String, Any?>) {
    Log.w(TAG, line(name, fields))
  }

  /** The same, with the throwable that says why. */
  fun fail(name: String, error: Throwable, vararg fields: Pair<String, Any?>) {
    Log.e(TAG, line(name, fields), error)
  }

  private val salt: ByteArray = ByteArray(16).also { SecureRandom().nextBytes(it) }

  /**
   * `evt=name key=value key=value`. Null fields are dropped rather than
   * written out as "null": an absent field and a field that is absent on
   * purpose read the same to a grep, and the shorter line is the one that
   * stays legible on a phone screen.
   */
  private fun line(name: String, fields: Array<out Pair<String, Any?>>): String = buildString {
    append("evt=").append(name)
    for ((key, value) in fields) {
      if (value == null) continue
      append(' ').append(key).append('=').append(token(value))
    }
  }

  /** One field, with the whitespace taken out so the line stays one field wide. */
  private fun token(value: Any): String {
    val text = value.toString()
    return if (text.isEmpty()) "empty" else text.replace(WHITESPACE, "_")
  }

  private val WHITESPACE = Regex("""\s+""")
}
