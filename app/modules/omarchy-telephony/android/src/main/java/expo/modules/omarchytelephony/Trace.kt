package expo.modules.omarchytelephony

import android.util.Log
import java.security.MessageDigest
import java.security.SecureRandom

/**
 * What this module did, in a form something other than a person can read.
 *
 * This half of the app runs almost entirely where nobody is watching. A
 * message arrives at three in the morning and Android starts the process for
 * the broadcast alone; a call is identified by a notification listener firing
 * against a dialler's card; a state machine spread across two receivers
 * decides which way a call went from three broadcasts that carry no number.
 * When any of that goes wrong the only evidence is what was written to logcat
 * as it happened — and until this file existed the module wrote nothing, so a
 * filtered `adb logcat` came back empty and the emptiness meant nothing at
 * all. It did not say the code had not run; it said nobody had asked it to
 * speak.
 *
 * Two rules shape the format, and both follow from who reads it.
 *
 *   - **One line, `evt=` first, then `key=value`.** A person skims it and a
 *     test greps it, so it has to work for both. `evt=deliver road=backlog` is
 *     a fact either one can act on; a sentence about the bridge being absent
 *     is a fact only for the person.
 *   - **Nothing that belongs to the user goes in it.** This module reads SMS
 *     bodies, the address book and the numbers people ring — it is the most
 *     sensitive code in the project. logcat is readable over adb by whoever is
 *     holding the phone, and by whoever they hand it to at a repair counter,
 *     so a body or a caller's number written here would be a leak the feature
 *     never asked for. [mark] and [len] go instead: enough to follow one call
 *     across several lines, never enough to know whose it was.
 *
 * Levels carry meaning rather than emphasis. [evt] is a fact worth asserting
 * on and is always emitted. [detail] is for following a mechanism and stays
 * off until somebody asks for it:
 *
 * ```
 * adb shell setprop log.tag.OmarchyTelephony DEBUG
 * adb logcat -s OmarchyLink:V OmarchyTelephony:V
 * ```
 *
 * [warn] is something that went wrong and was survived, [fail] the same with
 * the throwable attached. Both exist for the failures this module deliberately
 * swallows — and it swallows a great many, because a crash in a receiver is
 * worse than a missed event. Swallowing them silently is what made them
 * invisible; swallowing them out loud is the point of this file.
 *
 * The link module keeps its own copy of this under its own tag. Gradle modules
 * cannot share a source file, and two short ones cost less than a third module
 * built to hold them.
 */
internal object Trace {
  const val TAG = "OmarchyTelephony"

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
