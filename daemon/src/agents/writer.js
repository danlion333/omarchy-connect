import { has, run } from '../lib/exec.js'
import * as hypr from '../lib/hypr.js'
import * as tmux from './tmux.js'
import { ADAPTERS } from './index.js'
import { ancestors, commOf, hasTty } from './proc.js'

/** Every process name that is an agent rather than a terminal on the way to one. */
const AGENT_BINARIES = new Set(ADAPTERS.flatMap((adapter) => adapter.binaries))

/**
 * Answering the agent — the hard half.
 *
 * Reading a coding agent is easy because the agent already wrote everything
 * down. Writing to one is not: it owns a tty that belongs to somebody else's
 * process, and there is no supported way to push bytes into a foreign
 * terminal. Whatever writes has to be either a multiplexer that owns the pty
 * or the compositor typing on the user's behalf, and this module is the choice
 * between those two.
 *
 *   - **tmux** is the good road. The pane is tmux's own pty, so the text
 *     arrives exactly as typed, nothing steals focus, and a multi-line message
 *     can be delivered as a bracketed paste instead of a burst of Returns.
 *   - **wtype** is the honest fallback. For an agent in a bare terminal the
 *     daemon already owns both halves — Hyprland focus and a keyboard — so it
 *     remembers what was focused, focuses the terminal, types, and puts focus
 *     back. It is genuinely worse: it steals focus for a moment, it interleaves
 *     with anyone typing at the real keyboard, and it cannot be made atomic.
 *     It ships because "the agent I already have open" is the whole point of
 *     the feature, and requiring tmux would exclude the common case. The app is
 *     told which road a session is on and says so before the first send.
 *
 * Nothing here decides *whether* a phone may write. That gate is the plugin's,
 * and it is the same switch that lets it read.
 */

/** How long to let the compositor settle after a focus change, in ms. */
const FOCUS_SETTLE_MS = 90
/** …and after typing, before focus goes back where it was. */
const RETURN_SETTLE_MS = 40
/**
 * …and between two keys of one chord. A TUI redrawing its selection has to
 * see the second digit as a second keypress rather than as part of a burst it
 * is still repainting from.
 */
const KEY_GAP_MS = 40

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * The keys a phone may press, and how each road spells them.
 *
 * A whitelist rather than a pass-through: `send-keys` takes arbitrary key
 * sequences, and the set worth exposing is small and knowable — interrupt the
 * agent, submit, answer a numbered permission prompt, move within it. Anything
 * outside it is a bug in the app rather than something to forward hopefully.
 */
const KEYS = {
  Enter: { tmux: 'Enter', wtype: ['-k', 'Return'] },
  Escape: { tmux: 'Escape', wtype: ['-k', 'Escape'] },
  Tab: { tmux: 'Tab', wtype: ['-k', 'Tab'] },
  Space: { tmux: 'Space', wtype: ['-k', 'space'] },
  BSpace: { tmux: 'BSpace', wtype: ['-k', 'BackSpace'] },
  Up: { tmux: 'Up', wtype: ['-k', 'Up'] },
  Down: { tmux: 'Down', wtype: ['-k', 'Down'] },
  Left: { tmux: 'Left', wtype: ['-k', 'Left'] },
  Right: { tmux: 'Right', wtype: ['-k', 'Right'] },
  // The two interrupts. `C-c` stops a runaway tool and is the one the app puts
  // on screen; `C-d` ends the session outright, so it is reachable but never
  // offered as a button.
  'C-c': { tmux: 'C-c', wtype: ['-M', 'ctrl', '-k', 'c', '-m', 'ctrl'] },
  'C-d': { tmux: 'C-d', wtype: ['-M', 'ctrl', '-k', 'd', '-m', 'ctrl'] },
}

// A numbered permission prompt is answered by typing the digit, not by a named
// key, so the digits are literal text on both roads.
for (const digit of '123456789') KEYS[digit] = { tmux: null, literal: digit }

export const KEY_NAMES = Object.keys(KEYS)

/* ── which roads exist on this desktop ─────────────────────────────────── */

const wtypeAvailable = () => has('wtype') && hypr.available()

/** The best a session on this desktop could possibly be, for `capabilities`. */
export function best() {
  if (tmux.available()) return 'tmux'
  if (wtypeAvailable()) return 'wtype'
  return null
}

export function transports() {
  return { tmux: tmux.available(), wtype: wtypeAvailable() }
}

/* ── matching a session to something that can be typed into ────────────── */

async function clients() {
  try {
    const list = await hypr.json('clients')
    return Array.isArray(list) ? list : []
  } catch {
    return []
  }
}

/**
 * A session's forebears, up to but not past the agent that launched it.
 *
 * The walk exists to find the terminal a session is sitting in, and it stops
 * at another agent because past that point the terminal belongs to that one.
 * Three sessions on this desktop — a background job, an agent's own supervisor
 * and the person's actual session — all walked up to the same `foot` window
 * and all three were offered as writable, which meant two of the three rows on
 * the phone would have typed into the third one's conversation.
 */
function ownChain(pid) {
  const chain = []
  for (const [i, ancestor] of ancestors(pid).entries()) {
    const comm = commOf(ancestor)
    if (i && comm && AGENT_BINARIES.has(comm)) break
    chain.push(ancestor)
  }
  return chain
}

/**
 * Work out how each session could be written to, in one pass.
 *
 * One `tmux list-panes` and one Hyprland `clients` for the whole set rather
 * than a pair per session: this runs on every scan, and the answer changes
 * only when a terminal opens or closes.
 *
 * The match itself is a walk up the process tree. A pane's shell is the
 * agent's parent or grandparent; a terminal emulator is further up still, and
 * an agent inside tmux has the tmux *server* as its forebear rather than any
 * window — which is exactly why tmux is checked first and why finding no
 * window for such a session is right rather than a miss.
 */
export async function survey(sessions) {
  const list = [...sessions]
  if (!list.length) return

  const paneList = tmux.available() ? await tmux.panes() : []
  const paneByPid = new Map(paneList.map((pane) => [pane.pid, pane]))
  const paneById = new Map(paneList.map((pane) => [pane.id, pane]))

  // Only asked for once, and only if some session is not in tmux — on a
  // desktop where everything lives in panes this never runs at all.
  let windowByPid = null

  for (const entry of list) {
    const chain = entry.pid ? ownChain(entry.pid) : []

    // An agent with no controlling terminal is not at anybody's keyboard.
    //
    // This is what a background session looks like: a real conversation, worth
    // reading from the phone, running under a pty host with no window and no
    // pane of its own. Walking its parents finds a terminal all the same —
    // the one belonging to whichever agent launched it — and the daemon used
    // to offer that as the way in. It is not a way in; it is somebody else's
    // session, and a message meant for the background agent would have been
    // typed into the foreground one. Read-only is the truthful answer.
    if (!entry.pid || !hasTty(entry.pid)) {
      entry.pane = null
      entry.window = null
      entry.writable = null
      continue
    }

    // A hook reports `$TMUX_PANE` outright, which beats any amount of walking
    // — but a pane id outlives the pane, so it still has to exist.
    let pane = entry.pane ? paneById.get(entry.pane) || null : null
    if (!pane) pane = chain.map((pid) => paneByPid.get(pid)).find(Boolean) || null

    if (pane) {
      entry.pane = pane.id
      entry.window = null
      entry.writable = 'tmux'
      continue
    }
    entry.pane = null

    if (!wtypeAvailable() || !chain.length) {
      entry.window = null
      entry.writable = null
      continue
    }
    if (!windowByPid) {
      windowByPid = new Map()
      for (const client of await clients()) {
        if (client?.pid && client.address) windowByPid.set(client.pid, client.address)
      }
    }
    const address = chain.map((pid) => windowByPid.get(pid)).find(Boolean) || null
    entry.window = address
    entry.writable = address ? 'wtype' : null
  }
}

/* ── writing ───────────────────────────────────────────────────────────── */

/**
 * Focus the agent's window, do something, put focus back.
 *
 * Restoring is in a `finally` because the alternative — a failed `wtype`
 * leaving the user staring at a terminal they did not ask for — turns a
 * message that did not send into a desktop that moved under them.
 */
async function borrowFocus(address, fn) {
  let previous = null
  try {
    previous = (await hypr.json('activewindow'))?.address || null
  } catch {
    previous = null
  }
  const focus = (target) => hypr.dispatch(`hl.dsp.focus{window="address:${target}"}`, `focuswindow address:${target}`)

  await focus(address)
  await sleep(FOCUS_SETTLE_MS)
  try {
    return await fn()
  } finally {
    await sleep(RETURN_SETTLE_MS)
    if (previous && previous !== address) await focus(previous).catch(() => {})
  }
}

async function wtype(args) {
  const res = await run('wtype', args, { timeout: 15_000 })
  if (!res.ok) throw new Error(res.stderr || 'wtype failed')
}

/**
 * Send a message, and by default submit it.
 *
 * `submit` is separate from the text because the two quick answers a phone
 * gives most — a bare Enter to accept, a digit to pick an option — are keys,
 * and because a long message is worth putting in front of the agent to look at
 * before it runs.
 */
export async function send(entry, text, { submit = true } = {}) {
  const body = String(text ?? '').replace(/\r\n/g, '\n').replace(/\n+$/, '')
  if (!body && !submit) throw new Error('nothing to send')

  if (entry.writable === 'tmux') {
    if (body) await tmux.type(entry.pane, body)
    if (submit) await tmux.key(entry.pane, 'Enter')
    return { via: 'tmux', pane: entry.pane, submitted: submit }
  }

  if (entry.writable === 'wtype') {
    await borrowFocus(entry.window, async () => {
      if (body) await wtype(['--', body])
      if (submit) await wtype(['-k', 'Return'])
    })
    return { via: 'wtype', window: entry.window, submitted: submit }
  }

  throw new Error('nothing on this desktop can type into that session')
}

/**
 * A run of named keys, pressed in order as one write.
 *
 * One key is the common case and the reason this exists is the other one:
 * answering a multi-select prompt means toggling two or three options and then
 * submitting, and doing that as three separate calls would borrow the
 * compositor's focus three times over — three flickers for one answer, with
 * room between them for the person at the keyboard to arrive mid-thought. The
 * whole chord is one focus borrow and one lock.
 *
 * `gap` is how long to wait between two presses. The default is barely more
 * than a keystroke, which is all a list of toggles needs; a caller that walks
 * the prompt onto another screen asks for more, because a screen that has just
 * been drawn ignores the key that arrives on its heels.
 */
export async function chord(entry, names, { gap = KEY_GAP_MS } = {}) {
  const specs = names.map((name) => {
    const spec = Object.hasOwn(KEYS, name) ? KEYS[name] : null
    if (!spec) throw new Error(`that key cannot be sent from a phone: ${name}`)
    return spec
  })
  if (!specs.length) throw new Error('no keys to press')

  if (entry.writable === 'tmux') {
    for (const [i, spec] of specs.entries()) {
      if (i) await sleep(gap)
      if (spec.literal) await tmux.type(entry.pane, spec.literal)
      else await tmux.key(entry.pane, spec.tmux)
    }
    return { via: 'tmux', pane: entry.pane, keys: names }
  }

  if (entry.writable === 'wtype') {
    await borrowFocus(entry.window, async () => {
      for (const [i, spec] of specs.entries()) {
        if (i) await sleep(gap)
        await wtype(spec.literal ? ['--', spec.literal] : spec.wtype)
      }
    })
    return { via: 'wtype', window: entry.window, keys: names }
  }

  throw new Error('nothing on this desktop can type into that session')
}

export async function press(entry, name) {
  const { keys: _keys, ...result } = await chord(entry, [name])
  return { ...result, key: name }
}

/** The raw screen, which only a multiplexer can hand over. */
export async function screen(entry, lines) {
  if (entry.writable !== 'tmux' || !entry.pane) {
    throw new Error('the raw screen needs a tmux pane — this session is not in one')
  }
  return tmux.capture(entry.pane, lines)
}

/**
 * One write at a time per session.
 *
 * Two sends racing would interleave halfway through a paste, and the agent
 * would receive one message made of two. This does not lock out the person at
 * the keyboard — nothing can — but it makes the daemon's own half orderly, and
 * that is the half the daemon is responsible for.
 */
export function serialise(entry, fn) {
  const next = (entry.writeChain || Promise.resolve()).then(fn, fn)
  // The chain must not reject, or every later write on this session inherits
  // the failure; the caller still sees its own result.
  entry.writeChain = next.then(
    () => {},
    () => {},
  )
  return next
}
