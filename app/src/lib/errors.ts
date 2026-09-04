/**
 * One sentence for the user, and the whole truth underneath it.
 *
 * Everything that can fail in this app fails through a `catch`, and until now
 * every one of those `catch`es did the same thing by hand: cast the thrown
 * value to an `Error` and render its message. That cast is a lie twice over.
 * A promise
 * can reject with a string, with `undefined`, with an object that is not an
 * `Error` at all — and then `.message` is `undefined` and the screen politely
 * renders the word "undefined" in red. And when the throw comes from the
 * native side, `.message` is not a sentence but a Java stack trace: a
 * fully-qualified exception class, a colon, a line of prose and then twenty
 * lines of `at com.facebook.react…`, painted onto the screen as-is until it
 * has pushed everything else off it.
 *
 * So nothing renders a thrown value directly any more. It goes through here
 * first and comes out as a `Problem`: one short line that says what happened,
 * and the untouched original kept beside it for whoever wants to read it.
 * The screen shows the line; `Notice` in `ui/kit` puts the rest behind a tap.
 *
 * The rules are the ones a person applies when reading a stack trace out loud:
 * the message is the first line that is not a frame, an exception's package
 * path is noise, and nothing longer than a sentence belongs on a phone screen.
 */

export type Problem = {
  /** One line, no frames, never empty — this is what a screen renders. */
  message: string
  /** The original text when it says more than the line does, else null. */
  detail: string | null
}

/** What a value that says nothing at all turns into. */
export const FALLBACK = 'something went wrong'

/** Longer than this and a phone screen is being used as a log viewer. */
const MAX = 140

/**
 * A line of a stack trace rather than a line of prose.
 *
 * Java, Kotlin and JavaScript all write frames as `at …`, and the JVM writes
 * two more shapes around them — `Caused by:` and the `... 23 more` that ends
 * an abbreviated cause. None of the three is a sentence for a user.
 */
const FRAME = /^\s*(at\s|Caused by:|\.{3}\s*\d+\s+more\b)/

/**
 * A fully-qualified exception class at the head of a message:
 * `java.lang.SecurityException: Permission Denial…`. The package path is for
 * a bug report, not for a person holding a phone, so it is dropped and the
 * prose after the colon is kept. When there is no prose the simple name is
 * all there is, and it is better than nothing.
 */
const FQCN = /^((?:[a-z][\w$]*\.)+)([A-Z][\w$]*)(?::\s*|\s*$)/

/** A frame that was concatenated onto the message instead of newline'd. */
const INLINE_FRAME = /\s+at\s+[\w$.<>]+\(/

/** The text a thrown value carries, without deciding anything about it yet. */
function raw(err: unknown): string {
  if (err == null) return ''
  if (typeof err === 'string') return err
  if (typeof err === 'number' || typeof err === 'boolean') return String(err)
  // An `Error` speaks for itself, empty message included: `String(error)` on
  // one of those is "Error", which is a class name pretending to be news.
  if (err instanceof Error) return typeof err.message === 'string' ? err.message : ''
  if (typeof err === 'object') {
    const message = (err as { message?: unknown }).message
    if (typeof message === 'string' && message.trim()) return message
    // A rejected fetch-ish object, or anything else with a spoken field.
    const reason = (err as { error?: unknown }).error
    if (typeof reason === 'string' && reason.trim()) return reason
    const text = String(err)
    return text === '[object Object]' ? '' : text
  }
  return String(err)
}

/**
 * The one line, cut out of whatever the thrower thought was a message.
 *
 * Read top to bottom: the first line that is not a frame is the message, an
 * inline frame ends it, the package path in front of it is dropped, and what
 * is left is squeezed onto one line and cut to a length a person will read.
 */
function firstSentence(text: string): string {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  let line = lines.find((l) => l.trim() && !FRAME.test(l))?.trim() ?? ''

  const inline = line.search(INLINE_FRAME)
  if (inline > 0) line = line.slice(0, inline).trim()

  const qualified = FQCN.exec(line)
  if (qualified) {
    const rest = line.slice(qualified[0].length).trim()
    line = rest || qualified[2]
  }

  line = line.replace(/\s+/g, ' ').replace(/[\s:;,]+$/, '').trim()
  if (line.length > MAX) {
    const cut = line.slice(0, MAX)
    const space = cut.lastIndexOf(' ')
    line = `${(space > MAX * 0.6 ? cut.slice(0, space) : cut).trim()}…`
  }
  return line
}

/**
 * Anything that was thrown, as something a screen can show.
 *
 * `fallback` is for the callers who know what was being attempted — "the
 * desktop did not answer" reads better than "something went wrong" — and is
 * used only when the thrown value carried no words of its own.
 */
export function problem(err: unknown, fallback: string = FALLBACK): Problem {
  const text = raw(err).trim()
  const message = firstSentence(text) || fallback
  // The detail earns its place only by saying more than the line already
  // does: a plain `new Error('nope')` has nothing behind it to expand.
  const detail = text && text.replace(/\s+/g, ' ').trim() !== message ? text : null
  return { message, detail }
}

/** The line on its own, for the places that hold a string and not a state. */
export function errorLine(err: unknown, fallback: string = FALLBACK): string {
  return problem(err, fallback).message
}
