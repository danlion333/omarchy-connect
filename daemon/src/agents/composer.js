/**
 * What is still sitting in the agent's input box.
 *
 * Everything else in this directory reads a terminal to find out what the
 * agent *said*. This reads one to find out what it was never told: the box at
 * the bottom of a TUI where a message waits until a Return sends it. That is
 * the difference between a phone that reports a working agent and a phone that
 * is right, because `send` cannot otherwise know whether the Return it pressed
 * landed — it presses a key into somebody else's pty and hears nothing back.
 *
 * The reading is deliberately shallow. It does not try to understand the box,
 * only to find it and say what text is inside it, so that the same string can
 * be taken before a message is typed and after it is submitted. Two readings
 * and a comparison say more than one clever one ever could: whatever a TUI
 * draws in an empty composer — a placeholder, a hint, a model name — it draws
 * the same way both times and cancels itself out. What does not cancel out is
 * a message that never left.
 *
 * A pane with no box in it — a bare shell, `cat`, a full-screen pager — reads
 * as `null`, which means "cannot tell" and never means "not submitted". A
 * guess in that direction would tell a phone its message failed when it did
 * not, and a person would send it twice.
 */

/** The characters a TUI draws its frame out of. */
const FRAME_CHARS = '─━┄┈╌═╭╮╰╯┌┐└┘│┃|'
/** A line that is nothing but frame: the top or the bottom of the box. */
const FRAME = new RegExp(`^[${FRAME_CHARS}]{6,}$`, 'u')
/** The marker a composer puts in front of the line being typed. */
const PROMPT = /^(?:[❯>›⏵»]|\$)[  ]?/u
/**
 * How far above the last line of the pane the closing frame may be. A
 * composer usually has a status line under it — the model, the context left —
 * and sometimes two. Further than this and the box at the bottom of the screen
 * is not a composer, it is a table somebody printed.
 */
const TAIL_ROWS = 8
/** …and how tall the box itself may be before it stops being an input box. */
const BOX_ROWS = 24

/** A line stripped of the frame around it and the prompt in front of it. */
function content(line) {
  let text = String(line)
  // The box's own sides, which are drawn on every row of it.
  text = text.replace(new RegExp(`^\\s*[│┃|]`, 'u'), '').replace(new RegExp(`[│┃|]\\s*$`, 'u'), '')
  return text.trim().replace(PROMPT, '').trim()
}

const isFrame = (line) => FRAME.test(String(line).replace(/\s+/gu, ''))

/**
 * The text held in the composer at the bottom of a pane, or `null`.
 *
 * `null` is not "empty" — it is "this screen has no composer I can find", and
 * the caller must treat the two differently.
 */
export function composerOf(screen) {
  const lines = String(screen ?? '').split('\n').map((line) => line.replace(/\s+$/u, ''))
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop()
  if (!lines.length) return null

  let bottom = -1
  for (let i = lines.length - 1; i >= 0 && lines.length - i <= TAIL_ROWS; i -= 1) {
    if (isFrame(lines[i])) {
      bottom = i
      break
    }
  }
  if (bottom < 1) return null

  let top = -1
  for (let i = bottom - 1; i >= 0 && bottom - i <= BOX_ROWS; i -= 1) {
    if (isFrame(lines[i])) {
      top = i
      break
    }
  }
  if (top < 0) return null

  return lines
    .slice(top + 1, bottom)
    .map(content)
    .join('\n')
    .trim()
}

/**
 * Did the message leave the composer?
 *
 * Three ways to say yes, and only one of them is an observation of success:
 * the box is empty, which is what a TUI does to it the moment it accepts a
 * message. The other two are refusals to accuse — an unreadable screen, and a
 * box that holds exactly what it held before anything was typed into it, which
 * is a composer that was already carrying somebody's half-written line and
 * still is.
 *
 * Anything else is a message sitting where it was put, and the phone is told
 * so rather than told the agent is working.
 */
export function submitted(before, after) {
  if (after === null || after === undefined) return true
  if (after === '') return true
  return after === before
}

export default { composerOf, submitted }
