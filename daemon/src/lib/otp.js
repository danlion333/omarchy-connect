/**
 * The one-time code inside a mirrored message.
 *
 * A phone that mirrors its SMS to the desktop already carries the thing you
 * were actually reaching for the handset to get: six digits, valid for a
 * minute, that have to be retyped into a browser two centimetres away. Apple
 * solved this years ago and called it Security Code AutoFill; on Linux the
 * message arrives, is read, and then the phone is picked up anyway.
 *
 * So the card that shows the message gets a button that copies the code, and
 * everything here exists to decide whether there is one and what it is.
 *
 * Two rules shape the whole file:
 *
 *   - **Language-blind.** An SMS arrives with no locale attached — the phone
 *     forwards bytes, not a language tag — and the desktop's own locale says
 *     nothing about who is texting it. So a code is found by its shape and by
 *     the words around it in whatever script they were written, and digits are
 *     `\p{Nd}` rather than `\d`: a Persian bank writes ۱۲۳۴۵۶ and means the
 *     same six digits every other bank means.
 *   - **A trigger phrase, not a lone number.** Any four digits in a message
 *     could be a code, and most are not — an amount, a date, the last four of
 *     a card, a flight number. The phrase list is what tells a code from a
 *     number, and the ignore list is what keeps "20% off with discount code
 *     SPRING" from putting a coupon on the clipboard.
 *
 * The lists themselves are otphelper's (https://github.com/jd1378/otphelper),
 * an Android app that has been doing exactly this against real messages in
 * dozens of languages for years. Inventing our own would mean re-learning that
 * "Endziffer-4" is not a code and that 验证码 is, one angry user at a time.
 */

/** A word that is not part of a longer one, in any script. */
const WORD_START = '(?<![\\p{L}\\p{N}_])'
const WORD_END = '(?![\\p{L}\\p{N}_])'

/**
 * The words that mean "what follows is a code", in the scripts they are
 * written in. This is the list that decides whether a message has a code at
 * all, so it errs towards saying yes: a wrong guess costs one unwanted button.
 */
const TRIGGERS = [
  'code', 'One[-\\s]Time[-\\s]Password', 'کد', 'رمز',
  'شناسه\\s+تا[یي][یي]د', '\\bOTP\\W', '\\b2FA\\W',
  'Einmalkennwort', 'contraseña', 'c[oó]digo', 'clave',
  '\\bel siguiente PIN\\W', '验证码', '校验码', '識別碼',
  '認證', '驗證', 'код', 'סיסמ',
  `${WORD_START}הקוד${WORD_END}`, `${WORD_START}קוד${WORD_END}`,
  '\\bKodu\\W', '\\bKodunuz\\W', '\\b[sş]ifre:\\W',
  '\\b[sş]ifreniz(?=\\W)', '\\bKodi\\W', '\\bKods\\W',
  '\\b(?:m|sms)?TAN\\W', '\\bcodice\\W', 'コード',
  'パスワード', '認証番号', 'ワンタイム',
  '\\bvahvistuskoodi', '\\bkertakäyttökoodisi\\W',
  '\\bkod\\W', '\\bautoryzacji\\W',
  'Parol\\s+dlya\\s+podtverzhdeniya',
  `${WORD_START}пароль${WORD_END}`, '인증번호',
]

/**
 * What may not sit between the trigger word and the code. A run of four
 * single characters is a code being spelled out somewhere else in the
 * sentence, and "amount"/"مبلغ" is money about to be mistaken for one.
 */
const SKIP = ['مقدار', 'مبلغ', 'amount', 'برای', '-ارز', '[a-zA-Z0-9] [a-zA-Z0-9] [a-zA-Z0-9] [a-zA-Z0-9] ?']

/** Digits followed by one of these are a sum of money, not a code. */
const CURRENCY = ['USD', 'EUR', 'GBP', '[$€£]']

/**
 * Messages that use the word and mean something else. A discount code is the
 * expensive one: it looks exactly like an OTP, arrives by SMS from a shop, and
 * would quietly replace whatever was on the clipboard.
 */
const IGNORED = [
  'تخفیف', 'تخفیفات', 'تخفیفها', 'takhfif', 'off',
  'اشتباه وارد شده', 'RatingCode', 'vscode',
  'versionCode', 'unicode', 'discount code', 'fancode',
  'encode', 'decode', 'barcode', 'codex',
]

/**
 * Struck out of the message before anything is read from it. A domain name is
 * the reason this exists: `verify.example.com` is letters, a dot and more
 * letters, and the matcher would happily read part of it as a code.
 */
const CLEANUP = [
  '[a-zA-Z0-9][a-zA-Z0-9-]{0,61}\\.[a-zA-Z]{2,}(?:[.a-zA-Z]{0,3}(?=\\s+)|)',
  "['\"]", 'Endziffer-\\d+', 'Ending \\d+', '<#>', 'share OTP',
]

/** Every character a locale might write a colon with. */
const COLONS = ':：܃︓﹕'

const any = (list) => list.join('|')

/**
 * The code, read forwards: a trigger word, then whatever punctuation and
 * prose the sender put between it and the number, then the number.
 *
 * The middle of this is the part that earns its keep. It steps over ordinary
 * words and stray digits — "Your verification code for order 12 is 445566" —
 * while refusing to step over a colon, a quote or a run of digits that turns
 * out to be a price. Group 1 is the trigger, group 3 is the code.
 */
const GENERAL = new RegExp(
  `(${any(TRIGGERS)})` +
    `(?:\\s*(?!${any(SKIP)})(?:[^\\s${COLONS}.'"\\p{Nd}]|[\\p{Nd},\\s]+(?:${any(CURRENCY)})|\\p{Nd}\\P{Nd}))*` +
    `\\s*[${COLONS}]?\\s*(["'「]?)` +
    '([\\p{Nd}a-zA-Z-]{4,}|(?: [\\p{Nd}a-zA-Z]){4,}|)\\2?' +
    '(?:[^\\p{Nd}a-zA-Z]|$)',
  'gimu',
)

/**
 * The code, read backwards: the number first and the trigger word after it,
 * which is how German, Turkish and Japanese all tend to put it — "445566 ist
 * Ihr Einmalkennwort". Only consulted when reading forwards found the phrase
 * but no digits behind it.
 */
const SPECIAL = new RegExp(
  `((?:\\p{Nd}-?){4,}(?=\\s)|[\\p{Nd} ]{4,}(?=\\s)|\\p{Nd}{4,})[^${COLONS}]*(?:${any(TRIGGERS)})`,
  'imu',
)

const IGNORE = new RegExp(`${WORD_START}(?:${any(IGNORED)})${WORD_END}`, 'imu')
const CLEAN = new RegExp(`(?:${any(CLEANUP)})`, 'gimu')

const IS_DIGIT = /\p{Nd}/u

/**
 * A code is short, and a code has a digit in it.
 *
 * Neither is true of everything the matcher can return: "code" followed by an
 * English word matches, and so does a long identifier the cleanup missed. The
 * button this feeds goes straight to the clipboard, so the cost of a wrong
 * answer is somebody pasting a stray word into a bank, and these two lines are
 * cheap next to that. Ten is generous — six is the world's answer, eight is
 * the long end of it.
 */
const MIN_LENGTH = 4
const MAX_LENGTH = 10

/**
 * `۴۵۶` → `456`, in any script that has digits.
 *
 * Unicode encodes every set of decimal digits as ten consecutive code points
 * in ascending order, so a digit's value is its distance from the start of its
 * own run — and the start of the run is found by walking back while the
 * character before is still a digit. Nine steps at most, and it needs no table
 * of scripts to be kept up to date.
 */
function toAsciiDigits(code) {
  let out = ''
  for (const ch of code) {
    if (!IS_DIGIT.test(ch)) {
      out += ch
      continue
    }
    const cp = ch.codePointAt(0)
    let start = cp
    while (start > 0 && cp - start < 9 && IS_DIGIT.test(String.fromCodePoint(start - 1))) start -= 1
    out += String(cp - start)
  }
  return out
}

/**
 * One space wherever the sender left several, and the whole message on one
 * line.
 *
 * This is not tidiness, it is the difference between a microsecond and five
 * seconds. The matcher steps over the prose between the trigger word and the
 * code with `\s*` in front of a run that can itself match whitespace, and two
 * ways of consuming the same blank means the engine tries all of them: a
 * fifteen-hundred-space message took this from instant to a five-second stall
 * of the whole daemon — call control, the socket, everything — and the body of
 * an SMS is written by whoever knows the number.
 *
 * Nothing is lost. A code is never told apart from a non-code by how many
 * blanks precede it, and the one place the matcher cares about a space — a
 * code spelled out as `12 34 56` — is exactly the single space that survives.
 */
const flatten = (message) => message.replace(/\s+/g, ' ')

/** Spaces and dashes are how a code is made readable, not part of it. */
const compact = (value) => value.replace(/[\s-]/g, '')

const plausible = (code) =>
  code.length >= MIN_LENGTH && code.length <= MAX_LENGTH && IS_DIGIT.test(code)

/**
 * The one-time code in a message, or null.
 *
 * Null is the common answer and the right one: most messages are not from a
 * bank, and a button offering to copy something out of a note from a friend is
 * worse than no button at all.
 */
export function extractCode(message) {
  if (typeof message !== 'string' || !message) return null
  if (IGNORE.test(message)) return null

  const text = flatten(message).replace(CLEAN, '')

  // A match with no third group at all is the matcher having found a trigger
  // word and run off the end of the message; only a match that got as far as
  // deciding about a code is worth looking at.
  let found = null
  let sawTrigger = false
  for (const match of text.matchAll(GENERAL)) {
    if (match[3] == null) continue
    sawTrigger = true
    if (match[3]) {
      found = compact(match[3])
      break
    }
  }
  // The trigger was there and the digits were not in front of it. They are
  // usually behind it instead — this is the whole of German word order and
  // most of Japanese.
  if (!found && sawTrigger) found = compact(SPECIAL.exec(text)?.[1] ?? '')
  if (!found) return null

  const code = toAsciiDigits(found)
  return plausible(code) ? code : null
}

/** For the CLI, which wants to explain a `no` as well as report a `yes`. */
export function explain(message) {
  if (typeof message !== 'string' || !message) return { code: null, why: 'nothing to read' }
  const ignored = IGNORE.exec(message)
  if (ignored) return { code: null, why: `"${ignored[0]}" — this is an advert, not a code` }
  const code = extractCode(message)
  return code ? { code, why: null } : { code: null, why: 'no code word with a number behind it' }
}
