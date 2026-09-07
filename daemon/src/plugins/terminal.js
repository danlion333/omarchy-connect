import os from 'node:os'

import { loadConfig, updateConfig } from '../lib/config.js'
import { has, run, spawnDetached } from '../lib/exec.js'
import { log } from '../lib/log.js'
import * as tmux from '../agents/tmux.js'
import { foregroundBusy } from '../agents/proc.js'

/**
 * A shell on the desktop that the phone can type into and read back.
 *
 * Until now the only thing this daemon could do with a keyboard was push keys
 * at whatever window Hyprland happened to be focusing (`input.text`,
 * `input.key`), and nothing came back. That is fine for a media player and
 * useless for a shell: half the reason to pick the phone up instead of walking
 * to the desk is "make that directory, grep that, look at the log", and none of
 * those questions can be answered by a keystroke that vanishes into a window.
 *
 * So the desktop keeps one tmux session — `oc-term` — running the user's login
 * shell in their home directory, and the phone gets four things: type into it,
 * press a named key, read what is on it, and know what it is doing. The
 * multiplexer is what makes this possible at all, for the same reason it is
 * the agents' primary writer: the pty belongs to tmux, so bytes can be put in
 * and the screen can be read out without anybody's terminal being hijacked.
 * The movement of those bytes is `agents/tmux.js` and is not written twice
 * here — this file owns the session, the gate, and the watching.
 *
 * The screen is **pushed**, never polled by the phone. A terminal is quiet for
 * minutes and then says forty lines in a tenth of a second, and a phone asking
 * "anything new?" four times a second is the wrong shape for both halves. The
 * daemon watches instead, and only while somebody is actually looking.
 *
 * This is a shell, which is to say arbitrary code execution from a phone —
 * exactly the class of thing `agents.send` is, and it is off for the same
 * reason and by the same road: `terminal.enabled`, false by default, flipped
 * from the desktop with `omarchy-connect terminal on`.
 */

/** The one session. Not a prefix: there is exactly one, on purpose. */
const SESSION = 'oc-term'

/**
 * How often the watcher looks, while a phone has the screen open.
 *
 * The issue that asked for this suggested tmux's control mode (`tmux -C
 * attach`) as the trigger, since it reports every byte the pane emits. It was
 * not taken, and the reason is the size: a control-mode client is a client,
 * and an attached client is what tmux sizes the window from. The phone's
 * `cols` are the whole point of this feature — `git status` should wrap to the
 * handset, not to somebody's 80 columns — and a watcher that quietly resized
 * the window it was watching would break the thing it exists to serve. So the
 * daemon reads from outside, on a tick fast enough that a line typed on the
 * desktop is on the phone well inside the half-second the criteria ask for.
 */
const TICK_MS = 250

/** Screen plus this much scrollback, so the phone can flick back a little. */
const SCROLLBACK = 60

/** The most text a phone may put into a shell in one go. */
const MAX_TEXT = 4096

/**
 * The keys a phone may press.
 *
 * A whitelist rather than a pass-through, for the reason `agents/writer.js`
 * gives: `send-keys` takes arbitrary key sequences and the set worth exposing
 * is small and knowable. Wider than the agents' list, though, because this is
 * a shell and not a composer — line editing, history, job control and paging
 * are what a person actually does at a prompt.
 */
const KEYS = new Set([
  'Enter',
  'Escape',
  'Tab',
  'BTab',
  'Space',
  'BSpace',
  'Up',
  'Down',
  'Left',
  'Right',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  'DC',
  'C-c',
  'C-d',
  'C-z',
  'C-l',
  'C-a',
  'C-e',
  'C-u',
  'C-k',
  'C-w',
  'C-r',
  'C-p',
  'C-n',
])

const INFO = ['#{pane_id}', '#{pane_pid}', '#{pane_current_path}', '#{pane_width}', '#{pane_height}'].join('\t')

let bus = null
let timer = null
/** Set by `terminal.open`, cleared by `terminal.close`: is anybody looking? */
let watching = false
/** The last screen pushed, so a quiet terminal costs the phone nothing. */
let lastPrint = null

const enabled = () => loadConfig().terminal?.enabled === true

const requireEnabled = () => {
  if (!enabled()) throw new Error('the desktop shell is off — run `omarchy-connect terminal on` on the desktop')
}

const requireTmux = () => {
  if (!tmux.available()) throw new Error('this desktop has no tmux, so there is no shell to open')
}

/**
 * The session as it stands, or null when there is none.
 *
 * `-t oc-term` resolves to the session's active pane, which is the only pane
 * there is: this feature never splits or opens a second window. A session the
 * user exited out of is simply gone, and tmux says so with a non-zero exit
 * rather than an error worth logging — the next `open` starts a new one.
 */
async function session() {
  if (!tmux.available()) return null
  const res = await run('tmux', ['display-message', '-p', '-t', `${SESSION}:`, INFO], { timeout: 3000 })
  if (!res.ok) return null
  const [pane, pid, cwd, cols, rows] = res.stdout.split('\t')
  if (!pane || !pid) return null
  return { pane, pid: Number(pid) || 0, cwd: cwd || null, cols: Number(cols) || 0, rows: Number(rows) || 0 }
}

/** Screen, working directory and whether the shell is busy — one snapshot. */
async function snapshot(info) {
  const screen = await tmux.capture(info.pane, Math.min(Math.max(info.rows, 5) + SCROLLBACK, 400))
  return {
    screen,
    cwd: info.cwd,
    running: foregroundBusy(info.pid),
    cols: info.cols,
    rows: info.rows,
  }
}

/** A size the phone sent, or nothing at all, made into something tmux takes. */
const size = (value, fallback) => {
  const n = Math.round(Number(value))
  return Number.isFinite(n) && n >= 10 && n <= 500 ? n : fallback
}

/**
 * The session, made if it was not there.
 *
 * The shell is tmux's own `default-shell`, which is the user's login shell,
 * and the directory is home — one session, one shell, one starting point, as
 * the issue fenced it. A size that arrived with the request is applied either
 * way: on a new session through `-x/-y`, and on one that is already up through
 * `resize-window`, because a phone that has been rotated is a phone whose
 * columns changed under a session it did not restart.
 */
async function ensure(cols, rows) {
  requireTmux()
  const existing = await session()
  if (existing) {
    if (cols && rows && (existing.cols !== cols || existing.rows !== rows)) {
      await run('tmux', ['resize-window', '-t', `${SESSION}:`, '-x', String(cols), '-y', String(rows)], { timeout: 3000 })
      return (await session()) || existing
    }
    return existing
  }
  const res = await run(
    'tmux',
    ['new-session', '-d', '-s', SESSION, '-x', String(cols || 80), '-y', String(rows || 24), '-c', os.homedir()],
    { timeout: 5000 },
  )
  if (!res.ok) throw new Error(res.stderr || 'tmux could not open a shell')
  const made = await session()
  if (!made) throw new Error('the shell session went away as soon as it was made')
  log.info(`desktop shell ${SESSION} opened for the phone`)
  return made
}

/* ── watching ──────────────────────────────────────────────────────────── */

/**
 * One look at the pane, and a push if it has anything new to say.
 *
 * Everything a phone draws is in the fingerprint — the screen, the directory
 * and whether the shell is busy — so a `sleep` that finishes without printing
 * anything still reaches the handset, and a terminal nobody has touched for a
 * minute costs one `capture-pane` a tick and not one frame on the wire.
 */
async function tick() {
  const info = await session()
  if (!info) {
    // Exited out of. Stop looking until somebody opens one again, and say so,
    // because a phone holding a dead screen should stop drawing it.
    watching = false
    lastPrint = null
    bus?.emit('event', 'terminal', { kind: 'gone' })
    return
  }
  const shot = await snapshot(info)
  const print = JSON.stringify(shot)
  if (print === lastPrint) return
  lastPrint = print
  bus.emit('event', 'terminal', { kind: 'screen', ...shot })
}

let ticking = false

function start() {
  if (timer) return
  timer = setInterval(() => {
    // Nobody has the screen open, or nobody is subscribed: the pane is not
    // read at all. `capture-pane` is somebody's terminal, and a daemon that
    // reads one when no phone is looking is reading it for nothing.
    if (!watching || !enabled() || !bus?.hasSubscribers('terminal')) return
    // A slow tmux must not stack ticks on top of each other.
    if (ticking) return
    ticking = true
    void tick()
      .catch(() => {
        /* a pane read that failed is next tick's problem */
      })
      .finally(() => {
        ticking = false
      })
  }, TICK_MS)
  timer.unref?.()
}

/* ── the switch ────────────────────────────────────────────────────────── */

/** What the CLI and the loopback endpoint read back. */
export function summary() {
  return { enabled: enabled(), available: tmux.available(), session: SESSION }
}

/**
 * Turn the desktop shell on or off while the daemon runs.
 *
 * The same shape as `agents.setEnabled`, and for the same two reasons: the
 * decision must survive a restart, so the config is written here; and it must
 * not cost the phone its link, so the live half happens in the same call. The
 * phone learned what it could do from `hello` and is not about to say hello
 * again, so it is told.
 *
 * Turning it off stops the watching immediately. The session itself is left
 * standing — it may be a shell somebody is sitting in at the desk, and this
 * switch is about what the phone may reach, not about killing anyone's work.
 */
export function setEnabled(on) {
  const next = on === true
  const was = enabled()
  updateConfig((cfg) => {
    cfg.terminal = { ...(cfg.terminal || {}), enabled: next }
  })
  if (next !== was) {
    if (!next) {
      watching = false
      lastPrint = null
      log.info('the desktop shell is off — the phone can no longer type into this machine')
    }
    bus?.emit('event', 'terminal', { kind: 'control', enabled: next, available: tmux.available() })
  }
  return summary()
}

/* ── plugin ────────────────────────────────────────────────────────────── */

export default {
  name: 'terminal',

  capabilities() {
    return {
      enabled: enabled(),
      // Without tmux there is no road at all, and the app should say that
      // rather than offer a screen whose every method answers with an error.
      available: tmux.available(),
      session: SESSION,
      keys: [...KEYS],
      attach: has('omarchy-launch-terminal'),
    }
  },

  start(eventBus) {
    bus = eventBus
    start()
  },

  stop() {
    clearInterval(timer)
    timer = null
    watching = false
    lastPrint = null
    bus = null
  },

  methods: {
    /**
     * Open the shell, or come back to the one that is already there.
     *
     * Also the read: it answers with the screen as it stands, so a phone that
     * has just put the screen up has something to draw before the first push
     * arrives, and so a caller that wants `running` right now — during a
     * `sleep`, when nothing is being printed — can simply ask.
     */
    async 'terminal.open'({ cols, rows } = {}) {
      requireEnabled()
      const info = await ensure(size(cols, 0), size(rows, 0))
      const shot = await snapshot(info)
      watching = true
      // The next tick pushes only what is new, and what the caller is holding
      // right now is not new to it.
      lastPrint = JSON.stringify(shot)
      return shot
    },

    /**
     * Stop watching. The session stays up.
     *
     * The same idea as `agents.close`: the phone left the screen, so the
     * desktop stops reading a pane nobody is looking at. What was typed is
     * still there when it comes back.
     */
    async 'terminal.close'() {
      requireEnabled()
      watching = false
      lastPrint = null
      return { ok: true }
    },

    /** Literal text into the shell. It is not submitted; `Enter` does that. */
    async 'terminal.type'({ text } = {}) {
      requireEnabled()
      if (typeof text !== 'string' || !text) throw new Error('text required')
      if (text.length > MAX_TEXT) throw new Error(`too much text — ${MAX_TEXT} characters at a time`)
      const info = await ensure(0, 0)
      await tmux.type(info.pane, text)
      return { ok: true }
    },

    /** One named key, from the list `capabilities.terminal.keys` publishes. */
    async 'terminal.key'({ key } = {}) {
      requireEnabled()
      if (!KEYS.has(key)) throw new Error(`${key} cannot be sent — it is not one of the keys this shell takes`)
      const info = await ensure(0, 0)
      await tmux.key(info.pane, key)
      return { ok: true }
    },

    /**
     * Put the same session in front of the person at the desk.
     *
     * The point of one named session rather than a session per request: what
     * was started from the sofa is picked up at the keyboard, mid-command,
     * with its scrollback. `omarchy-launch-terminal` is Omarchy's own opener
     * and takes the command to run, which is why the presentation wrapper is
     * not used here — it would print a logo over the shell and a "done" banner
     * under it.
     *
     * `window-size` goes back to `latest` on the way out because `open` may
     * have pinned the window to the phone's columns with `resize-window`, and
     * a session pinned to 48 columns inside a 200-column window on the desk is
     * a session nobody wants to sit in. The real client wins from here.
     */
    async 'terminal.attach'() {
      requireEnabled()
      if (!has('omarchy-launch-terminal')) throw new Error('omarchy-launch-terminal not installed')
      const info = await ensure(0, 0)
      await run('tmux', ['set-option', '-w', '-t', `${SESSION}:`, 'window-size', 'latest'], { timeout: 3000 })
      spawnDetached('omarchy-launch-terminal', ['tmux', 'attach', '-t', SESSION])
      return { ok: true, session: SESSION, pane: info.pane }
    },
  },
}
