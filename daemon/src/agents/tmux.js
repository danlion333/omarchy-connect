import { spawn } from 'node:child_process'

import { has, run } from '../lib/exec.js'

/**
 * tmux: the one thing on this desktop that may legitimately type into a
 * terminal it does not own.
 *
 * `TIOCSTI` is gone — this kernel does not even expose the sysctl that used to
 * restrict it, the ioctl is compiled out — so nothing can push bytes into a
 * foreign tty. A multiplexer can, because the pty is *its* pty: the agent is
 * merely the process on the far end of it. That makes tmux the primary writer
 * and everything else a fallback.
 *
 * Three commands do the whole job, and each was verified on this machine
 * before it was written down. Nothing here parses a screen or guesses at
 * state; it moves bytes and reports what tmux said.
 */

/** Our own paste buffer, so a send never eats what the user copied. */
const BUFFER = 'omarchy-connect'

/**
 * Tab-separated because a working directory may contain spaces and a session
 * name almost certainly does. Tabs cannot appear in any of these fields.
 */
const FORMAT = ['#{pane_id}', '#{pane_pid}', '#{pane_current_path}', '#{session_name}', '#{window_index}'].join('\t')

export const available = () => has('tmux')

/**
 * Every pane on every session this user's server is running.
 *
 * `pane_current_command` is deliberately not asked for: it reports the
 * foreground process of the pane's shell and is unreliable for wrappers — a
 * pane verified to be running `cat` reported `bash`. What a pane is running is
 * answered by walking its process subtree instead, and that is the caller's
 * job because only the caller knows which pids it is looking for.
 */
export async function panes() {
  if (!available()) return []
  const res = await run('tmux', ['list-panes', '-a', '-F', FORMAT], { timeout: 3000 })
  // "no server running on ..." is the ordinary answer on a desktop without
  // tmux open, not a failure worth logging.
  if (!res.ok) return []
  return res.stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [id, pid, cwd, session, window] = line.split('\t')
      return { id, pid: Number(pid) || 0, cwd: cwd || null, session: session || null, window: Number(window) || 0 }
    })
    .filter((pane) => pane.id && pane.pid)
}

/** Does this pane still exist? A hook's `$TMUX_PANE` outlives the pane itself. */
export async function hasPane(id) {
  if (!id || !available()) return false
  const res = await run('tmux', ['display-message', '-p', '-t', id, '#{pane_id}'], { timeout: 3000 })
  return res.ok && res.stdout.trim() === id
}

const tmux = async (args, what) => {
  const res = await run('tmux', args, { timeout: 5000 })
  if (!res.ok) throw new Error(res.stderr || `tmux ${what} failed`)
  return res.stdout
}

/**
 * `load-buffer` reads the text from stdin, which `run` cannot give it —
 * `execFile` builds its own stdio. Passing the text as an argument instead
 * would put it through a second round of tmux's own quoting.
 */
function loadBuffer(text) {
  return new Promise((resolve, reject) => {
    const child = spawn('tmux', ['load-buffer', '-b', BUFFER, '-'], { stdio: ['pipe', 'ignore', 'pipe'] })
    let err = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => (err += chunk))
    child.on('error', reject)
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(err.trim() || `tmux load-buffer exited with ${code}`))))
    child.stdin.on('error', reject)
    child.stdin.end(text)
  })
}

/**
 * Put text in front of the agent, without submitting it.
 *
 * One line goes through `send-keys -l`, which is literal — UTF-8 and emoji
 * survive it unchanged. Anything with a newline goes through the paste buffer
 * instead, because a TUI that has enabled bracketed paste needs multi-line
 * input to arrive as one paste: sent as keys, every Return in the middle would
 * submit half a message. tmux emits the brackets only when the application
 * asked for them, so the same call is right for a TUI and for a bare shell.
 */
export async function type(pane, text) {
  if (!text) return
  if (text.includes('\n')) {
    await loadBuffer(text)
    // -p bracketed, -d delete the buffer afterwards: the text was a message,
    // not something the user asked to keep.
    await tmux(['paste-buffer', '-b', BUFFER, '-t', pane, '-p', '-d'], 'paste-buffer')
    return
  }
  // `--` because a message may perfectly well begin with a dash.
  await tmux(['send-keys', '-t', pane, '-l', '--', text], 'send-keys')
}

/** A named key, in tmux's own spelling: `Enter`, `Escape`, `C-c`. */
export async function key(pane, name) {
  await tmux(['send-keys', '-t', pane, name], 'send-keys')
}

/**
 * What the terminal actually shows.
 *
 * The transcript is the better read for a conversation, but it is not the
 * whole truth: a permission prompt is drawn on the screen and never written to
 * disk, so the numbered options a phone is about to answer exist only here.
 * Colour is dropped — `-e` would keep the SGR sequences, and a phone rendering
 * them as text is worse than a phone without them.
 */
export async function capture(pane, lines = 60) {
  const count = Math.min(Math.max(Number(lines) || 60, 5), 400)
  const out = await tmux(['capture-pane', '-p', '-t', pane, '-S', `-${count}`], 'capture-pane')
  // A pane that is mostly empty ends in a wall of blank lines; they cost a
  // phone a scroll each and say nothing.
  return out.replace(/\s+$/, '')
}

/** A session name nothing else is using, for `omarchy-connect agent run`. */
export async function freeSessionName(prefix = 'oc-agent') {
  const res = await run('tmux', ['list-sessions', '-F', '#{session_name}'], { timeout: 3000 })
  const taken = new Set(res.ok ? res.stdout.split('\n').filter(Boolean) : [])
  for (let n = 1; n < 100; n += 1) {
    const name = `${prefix}-${n}`
    if (!taken.has(name)) return name
  }
  return `${prefix}-${process.pid}`
}
