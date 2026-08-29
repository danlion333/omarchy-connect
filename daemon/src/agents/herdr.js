import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

import { has } from '../lib/exec.js'
import { envOf } from './proc.js'

/**
 * herdr: the other multiplexer that may legitimately type into a terminal it
 * does not own — and the one a desktop full of coding agents is likely to be
 * running instead of tmux.
 *
 * The argument for tmux is made in `tmux.js` and it is the same argument here:
 * the pane's pty belongs to the multiplexer, so bytes written to it arrive as
 * if they had been typed. What differs is everything about how you ask.
 *
 *   - **There is no command to shell out to.** herdr's server listens on a
 *     unix socket and speaks newline-delimited JSON, one object per line, and
 *     the `herdr` binary is a client of that socket like anything else. So
 *     this module is the client rather than a wrapper around a CLI: it costs a
 *     connect instead of a process, and it gets its errors as codes rather
 *     than as a string on stderr to be guessed at.
 *   - **A pane is named, not hunted for.** herdr puts `HERDR_PANE_ID` into
 *     every process it starts, so the agent is carrying the answer around in
 *     its own environment. Walking the process tree — which is how a tmux pane
 *     is found — would not work here anyway: the server is detached, so an
 *     agent's forebears lead to a daemon rather than to anything on screen.
 *   - **One call does what tmux needs three for.** `pane.send_input` takes the
 *     text and the Return together and brackets the paste itself if the
 *     application asked for bracketed paste, which was verified against a pty
 *     with `\e[?2004h` set: the bytes arrived wrapped in `\e[200~`…`\e[201~`
 *     followed by `\r`. That atomicity is worth having. It is the difference
 *     between a message and half a message when a phone's connection drops
 *     between two writes.
 *
 * Nothing here decides whether a phone may write, and nothing here reads a
 * transcript. herdr is a road to a terminal, exactly as tmux is; the session
 * on the far end of it is Claude Code's and is read from Claude Code's files.
 */

const HOME = os.homedir()
const CONFIG_DIR = path.join(HOME, '.config', 'herdr')

/**
 * Where a session's socket lives.
 *
 * The default session gets the top-level socket; a named one — `herdr
 * --session review` — gets its own directory under `sessions/`. A pane almost
 * always tells us the path outright in `HERDR_SOCKET_PATH`; this is the
 * fallback for an environment that carries only the name.
 */
export const socketFor = (session) =>
  session ? path.join(CONFIG_DIR, 'sessions', String(session), 'herdr.sock') : path.join(CONFIG_DIR, 'herdr.sock')

/**
 * Is this desktop one where a session could be reached this way at all?
 *
 * The same question `tmux.available()` answers and with the same honesty:
 * having the binary is not having a pane, it is only the difference between a
 * desktop that could and one that never will. Which sessions are actually in
 * a pane is `locate()`'s business, and it asks a running server.
 */
export const available = () => has('herdr')

/** Longer than a socket round trip needs and shorter than a phone will wait. */
const CALL_TIMEOUT_MS = 4000
/** A reply this large is a server that has lost the plot, not an answer. */
const MAX_REPLY = 4 * 1024 * 1024

/**
 * One request, one reply, one connection.
 *
 * A long-lived connection would save a few microseconds and cost the thing
 * that matters more: a socket that has to be reconnected, drained and
 * resynchronised after a server restart, in a daemon whose whole job is to
 * still be there afterwards. herdr's protocol is request/response over a
 * stream, so a connection per call is both correct and cheap, and a server
 * that went away between two calls fails the second one instead of poisoning
 * every call after it.
 */
function call(socket, method, params = {}, { timeout = CALL_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    let buf = ''
    let settled = false
    const sock = net.connect(socket)
    const finish = (err, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      sock.destroy()
      if (err) reject(err)
      else resolve(value)
    }
    // Overridable because one call is not like the others: `agent.start`
    // deliberately blocks until herdr has seen the agent come up, and a
    // launch is allowed to take half a minute where a keystroke is not.
    const timer = setTimeout(() => finish(new Error(`herdr did not answer ${method}`)), timeout)

    sock.setEncoding('utf8')
    sock.on('connect', () => sock.write(`${JSON.stringify({ id: 'omarchy-connect', method, params })}\n`))
    sock.on('data', (chunk) => {
      buf += chunk
      const end = buf.indexOf('\n')
      if (end < 0) {
        if (buf.length > MAX_REPLY) finish(new Error(`herdr sent more than an answer to ${method}`))
        return
      }
      let frame
      try {
        frame = JSON.parse(buf.slice(0, end))
      } catch {
        return finish(new Error(`herdr answered ${method} with something that is not JSON`))
      }
      // The error half of the envelope is a code and a sentence; the sentence
      // is what a person reads on a phone, so it is what is kept.
      if (frame?.error) return finish(new Error(frame.error.message || frame.error.code || `herdr refused ${method}`))
      finish(null, frame?.result || {})
    })
    sock.on('error', (err) => finish(err))
    // A server that hangs up mid-answer is a failure, and one that hangs up
    // after answering has already resolved and will not be heard from here.
    sock.on('close', () => finish(new Error(`herdr closed the connection on ${method}`)))
  })
}

/* ── which pane, if any, an agent is sitting in ────────────────────────── */

/**
 * The variables herdr injects, and the only ones this daemon ever looks at.
 *
 * `HERDR_SOCKET_PATH` is the exact answer and `HERDR_SESSION` is the fallback
 * that can be turned into one. Everything else in that environment is the
 * agent's own business.
 */
const ENV_KEYS = ['HERDR_PANE_ID', 'HERDR_SOCKET_PATH', 'HERDR_SESSION']

/** What the process itself says about where it is running. Cheap; unverified. */
export function claimed(pid) {
  const env = pid ? envOf(pid, ENV_KEYS) : null
  const pane = env?.HERDR_PANE_ID
  if (!pane) return null
  const socket = env.HERDR_SOCKET_PATH || socketFor(env.HERDR_SESSION)
  return { pane, socket }
}

/**
 * Where this agent can be typed into, if anywhere — proven rather than
 * believed.
 *
 * The environment names a pane, and on its own that is not enough. An
 * environment is inherited by everything a process starts and it outlives the
 * pane it describes: a tmux *server* first started from inside a herdr pane
 * hands `HERDR_PANE_ID` to every pane it ever opens afterwards, including the
 * ones on other screens entirely, and a phone acting on that claim would type
 * a message into a stranger's terminal. So the claim is checked against the
 * pane it names: the agent has to be the pane's own foreground process, or a
 * descendant of the shell herdr started there. `chain` is the walk up from the
 * agent that `writer.js` has already done for its own purposes.
 *
 * A server that is not running, a pane that has been closed and a socket left
 * behind by a crash all fail the same way — no pane — which is the truthful
 * answer in each case.
 */
export async function locate(pid, chain = []) {
  const claim = claimed(pid)
  if (!claim) return null
  let info = null
  try {
    info = (await call(claim.socket, 'pane.process_info', { pane_id: claim.pane }))?.process_info || null
  } catch {
    return null
  }
  if (!info) return null
  const owned =
    (info.shell_pid && chain.includes(info.shell_pid)) ||
    (info.foreground_processes || []).some((proc) => proc.pid === pid)
  return owned ? claim : null
}

/* ── writing ───────────────────────────────────────────────────────────── */

/**
 * Text and keys, together, as one write.
 *
 * `pane.send_input` is the call the whole herdr road is built on. It takes the
 * message and the Return that submits it in the same request, and it consults
 * the pane's live bracketed-paste mode rather than being told about it — so a
 * multi-line message arrives at a TUI as one paste instead of as a burst of
 * Returns that submit it a line at a time, and the same call is right for a
 * bare shell that never asked for brackets.
 */
export async function input(target, { text = '', keys = [] } = {}) {
  const params = { pane_id: target.pane }
  if (text) params.text = text
  if (keys.length) params.keys = keys
  if (!params.text && !params.keys) return
  await call(target.socket, 'pane.send_input', params)
}

/** Put text in front of the agent without submitting it. */
export const type = (target, text) => input(target, { text })

/** A named key, in herdr's own spelling: `enter`, `esc`, `ctrl+c`. */
export const key = (target, name) => input(target, { keys: [name] })

/**
 * What the terminal actually shows.
 *
 * The same reason tmux's `capture-pane` is here: a permission prompt is drawn
 * on the screen and never written to disk, so the numbered options a phone is
 * about to answer exist nowhere else. `recent` is the bottom of the pane as it
 * was drawn, soft wraps and all, which is what a phone rendering a screen in a
 * monospace block wants — `recent-unwrapped` is for reading logs back, not for
 * showing somebody their terminal. Colour is dropped, because a phone
 * rendering escape sequences as text is worse than one without them.
 */
export async function capture(target, lines = 60) {
  const count = Math.min(Math.max(Number(lines) || 60, 5), 400)
  const res = await call(target.socket, 'pane.read', {
    pane_id: target.pane,
    source: 'recent',
    lines: count,
    strip_ansi: true,
  })
  return String(res?.read?.text || '').replace(/\s+$/, '')
}

/* ── starting one ──────────────────────────────────────────────────────── */

/**
 * A name nothing else is using, for an agent this daemon starts.
 *
 * herdr names agents rather than numbering them, and the names have to be
 * unique among the live ones and match `[a-z][a-z0-9_-]{0,31}`.
 */
export async function freeAgentName(socket, prefix = 'oc-agent') {
  let taken = new Set()
  try {
    const list = (await call(socket, 'agent.list'))?.agents || []
    taken = new Set(list.map((agent) => agent.name).filter(Boolean))
  } catch {
    /* a server that cannot list has nothing to collide with */
  }
  for (let n = 1; n < 100; n += 1) {
    const name = `${prefix}-${n}`
    if (!taken.has(name)) return name
  }
  return `${prefix}-${process.pid}`
}

/**
 * The socket of a server that is actually up, or nothing.
 *
 * Only wanted for starting an agent from the phone, which is the one thing
 * that has no pane to inherit an answer from. `ping` is the cheapest question
 * there is and it distinguishes a live server from a socket file left behind
 * by one that crashed — a distinction a bare `existsSync` cannot make.
 */
export async function liveSocket(session = process.env.HERDR_SESSION || null) {
  const socket = socketFor(session)
  try {
    await call(socket, 'ping')
    return socket
  } catch {
    return null
  }
}

/**
 * Start an agent in a workspace of its own, with no terminal open on it.
 *
 * The shape tmux's `new-session -d` gives for free: a pty that exists, that
 * nobody is looking at, and that the phone can type into from the first
 * second — and that whoever is at the desktop can open later by attaching to
 * the session and switching to the workspace.
 *
 * `agent.start` rather than a command line typed into the pane, because the
 * arguments are passed as an array: a prompt from a phone is arbitrary text,
 * and text that becomes part of a shell command line is an injection waiting
 * for somebody to write `; rm -rf ~` in a chat box. It also waits until herdr
 * has *seen* the agent it was asked to start, so a failure to launch is an
 * error here rather than a session that never appears.
 */
export async function startAgent(socket, { kind, cwd, args = [], timeout = 30_000 }) {
  const created = await call(socket, 'workspace.create', { cwd, label: kind, focus: false })
  const pane = created?.root_pane?.pane_id
  if (!pane) throw new Error('herdr made a workspace with no pane in it')
  const name = await freeAgentName(socket)
  // Our own patience has to outlast herdr's, or the launch is abandoned here
  // while it is still going well over there.
  await call(socket, 'agent.start', { name, kind, pane_id: pane, args, timeout_ms: timeout }, { timeout: timeout + 5000 })
  return { name, pane, workspace: created?.workspace?.workspace_id || null }
}
