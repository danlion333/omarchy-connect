/**
 * The arithmetic behind the Terminal workspace.
 *
 * The screen itself is a subscription and a `TextInput`, neither of which a
 * test in this repository can run; what can be run is everything the screen
 * decides before it draws. That is what lives here: the local command history,
 * the pane text turned into the lines that go on screen, the working directory
 * turned into a title, and the handset's pixels turned into the `cols`/`rows`
 * the desktop sizes its shell to.
 *
 * All of it is pure on purpose. A phone that shows the wrong directory or eats
 * a command out of its own history is a bug you want caught by `npm test` and
 * not by a person squinting at a handset.
 */

/** What the desktop pushes with every `terminal` event of kind `screen`. */
export type Shot = {
  /** The pane as tmux draws it, screen plus a little scrollback. */
  screen: string
  /** The shell's working directory, absolute, as the desktop spells it. */
  cwd: string | null
  /** Something other than the shell owns the tty: a command is running. */
  running: boolean
  cols: number
  rows: number
}

/** What `capabilities.terminal` says about the desktop's shell. */
export type TerminalCaps = {
  enabled: boolean
  /** No tmux, no shell — the one state this screen cannot draw its way out of. */
  available: boolean
  session: string
  keys: string[]
  attach: boolean
}

/**
 * How many commands the phone keeps to hand back.
 *
 * Small deliberately: this is a row of chips over the keyboard, not a `.bash_history`.
 * Twenty is about a screenful of chips and a morning's worth of typing.
 */
export const MAX_COMMANDS = 20

/**
 * A command, put at the front of what this phone has sent.
 *
 * Newest first, because the one you want again is nearly always the last one,
 * and a repeat moves its entry rather than spending a second slot on it — the
 * same rule the clipboard history follows, for the same reason: a person who
 * ran `git status` four times wants one chip, not four.
 */
export function rememberCommand(history: string[], text: string): string[] {
  const line = text.trim()
  if (!line) return history
  return [line, ...history.filter((entry) => entry !== line)].slice(0, MAX_COMMANDS)
}

/**
 * The pane, cut into the lines the screen draws.
 *
 * `capture-pane` hands back the window's full height whatever is on it, so a
 * shell that has printed two lines arrives as two lines and thirty blanks —
 * and a screen that drew those blanks would show a prompt pinned to the top of
 * a phone with an empty half underneath. Both ends are trimmed, the right-hand
 * padding goes with them, and what is left is exactly what the shell has said.
 */
export function screenLines(screen: string | null | undefined): string[] {
  if (!screen) return []
  const lines = screen.replace(/\r/g, '').split('\n').map((line) => line.replace(/\s+$/, ''))
  let end = lines.length
  while (end > 0 && lines[end - 1] === '') end -= 1
  let start = 0
  while (start < end && lines[start] === '') start += 1
  return lines.slice(start, end)
}

/**
 * The working directory, spelled the way a person writes it.
 *
 * The desktop sends an absolute path and nothing else — `hello` has never
 * carried a home directory and this screen is not worth a protocol field — so
 * the tilde is put back by the shape of the path rather than by knowing whose
 * it is. Anything outside a home stays absolute, which is right: `/etc` is
 * where you notice you are not where you thought.
 */
export function shortPath(cwd: string | null | undefined): string | null {
  if (!cwd) return null
  const home = /^(?:\/home\/[^/]+|\/Users\/[^/]+|\/root)(\/.*)?$/.exec(cwd)
  if (home) return `~${home[1] ?? ''}`
  return cwd
}

/**
 * The width of one monospace character, as a fraction of its point size.
 *
 * JetBrains Mono's advance is 600/1000 em and the app has no other face for
 * this. Measuring the glyph on the device would be more honest and needs a
 * text-layout round trip per rotation; the constant is exact for the one font
 * the app ships, and the columns it yields are checked against the pane the
 * desktop reports anyway.
 */
export const MONO_ADVANCE = 0.6

/**
 * The shell's size, from the space the phone has to draw it in.
 *
 * This is the whole reason the daemon takes a size at all: `ls` and `git
 * status` should wrap to the handset. The bounds match the daemon's own — it
 * refuses anything outside 10…500 — so a panel that has not been measured yet
 * (zero width, one frame before layout) asks for nothing rather than for a
 * one-column shell.
 */
export function fitCols(width: number, fontSize: number): number {
  const cols = Math.floor(width / (fontSize * MONO_ADVANCE))
  return clampSize(cols)
}

export function fitRows(height: number, lineHeight: number): number {
  return clampSize(Math.floor(height / lineHeight))
}

function clampSize(n: number): number {
  if (!Number.isFinite(n) || n < 10) return 0
  return Math.min(n, 500)
}
