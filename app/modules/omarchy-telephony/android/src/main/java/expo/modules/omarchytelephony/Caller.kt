package expo.modules.omarchytelephony

/**
 * Telling a caller's name from a caller's number.
 *
 * The dialler does not hand its notification over in the shape it was written
 * in. Android runs every phone number it puts on screen through a
 * bidirectional formatter first, which wraps it in invisible direction marks so
 * that a leading `+` still reads correctly beside Hebrew or Arabic. What
 * reaches a notification listener is U+202A, the digits, U+202C — and a
 * number that is not recognised as one gets forwarded to the desktop as if it
 * were the contact's name.
 *
 * That is worse than cosmetic. `PhoneStateReceiver` stops listening once it
 * believes it knows who is calling, so a number mistaken for a name also
 * throws away the dialler's *second* post — the one carrying the real contact,
 * which is the entire reason this road exists.
 */
object Caller {
  /**
   * Everything Android may add to a string for the sake of laying it out, and
   * nothing that is part of what was written.
   */
  private val INVISIBLE = Regex("""[\u00ad\u200b-\u200f\u202a-\u202e\u2066-\u2069]""")

  /** A caller ID made of nothing but dialling characters is a number. */
  private val NUMBERISH = Regex("""^[+()\-.\s\d*#]+$""")

  /** As written, with the layout marks taken back out. Blank becomes null. */
  fun clean(value: String?): String? =
    value?.replace(INVISIBLE, "")?.trim()?.takeIf { it.isNotEmpty() }

  /**
   * Whether this is a number rather than a name. A digit has to be in there
   * somewhere: a title of `()` is neither, and calling it a number would put
   * the brackets in the desktop's dial field.
   */
  fun isNumber(value: String?): Boolean {
    val text = clean(value) ?: return false
    return NUMBERISH.matches(text) && text.any(Char::isDigit)
  }
}
