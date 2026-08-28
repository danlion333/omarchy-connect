import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * Background agents, read from the bookkeeping the CLI keeps for them.
 *
 * A background agent is a session with nobody sitting in front of it: started
 * with `--bg`, it detaches, works, and writes to the same kind of transcript
 * as any other session. What it does *not* have is a terminal, which is why
 * the rest of this plugin can find it but never offer to type into it — and
 * why the phone is where it is worth reading at all. Nothing on the desktop is
 * showing it.
 *
 * The CLI keeps a directory per job under `~/.claude/jobs/<short>/`, with a
 * `state.json` that is exactly the status line such a thing needs: what it is
 * doing right now in a sentence, how many tokens it has burned, the prompt it
 * was sent off with, and the session id that ties it back to a transcript.
 * Beside it is `timeline.jsonl`, one line per state change, which is the
 * closest thing to progress a job that has not finished can offer.
 *
 * Read-only, and deliberately so: starting a background agent goes through
 * `spawn`, which is gated. This module only says what is already running.
 */

const JOBS_DIR = path.join(os.homedir(), '.claude', 'jobs')

/** A phone lists what is happening now, not everything that ever did. */
const MAX_JOBS = 40
/** A job that has not been touched in this long is history. */
const IDLE_TTL_MS = 24 * 60 * 60 * 1000
/** Enough of the timeline to say what the last few steps were. */
const TIMELINE_TAIL = 8 * 1024
/** Steps kept from that tail. More than this is a log, not a status. */
const MAX_STEPS = 12
/** States a job does not come back from on its own. */
const TERMINAL_STATES = new Set(['done', 'failed', 'killed', 'cancelled', 'error'])
/** A live job touches its state file far more often than this. */
const LIVE_WINDOW_MS = 3 * 60 * 1000

const oneLine = (value, max = 200) => {
  const text = String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

const stamp = (value) => {
  const at = Date.parse(String(value || ''))
  return Number.isFinite(at) ? at : 0
}

/**
 * The last few lines of the job's timeline, newest last.
 *
 * Reading the end rather than the file: a job that has been running all
 * afternoon has thousands of these, and the interesting ones are the ones it
 * wrote a minute ago. The first line of the window is very likely half a line
 * and is dropped rather than parsed.
 */
function steps(dir) {
  const file = path.join(dir, 'timeline.jsonl')
  let fd
  let text
  try {
    const stat = fs.statSync(file)
    const start = stat.size > TIMELINE_TAIL ? stat.size - TIMELINE_TAIL : 0
    fd = fs.openSync(file, 'r')
    const buf = Buffer.allocUnsafe(stat.size - start)
    const read = fs.readSync(fd, buf, 0, buf.length, start)
    text = buf.subarray(0, read).toString('utf8')
    if (start > 0) text = text.slice(text.indexOf('\n') + 1)
  } catch {
    return []
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
  }

  const out = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let entry
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    const detail = oneLine(entry?.detail || entry?.text)
    if (!detail) continue
    // A job says the same sentence every time it checks in; one row per
    // distinct thing it was doing is the whole point of the list.
    const last = out[out.length - 1]
    if (last && last.detail === detail) {
      last.at = stamp(entry.at) || last.at
      continue
    }
    out.push({ at: stamp(entry.at), state: String(entry?.state || ''), detail })
  }
  return out.slice(-MAX_STEPS)
}

/** One `state.json` → the row the phone draws, or null if it is not readable. */
function readJob(short, { withSteps = false } = {}) {
  const dir = path.join(JOBS_DIR, short)
  let state
  let mtime = 0
  try {
    const file = path.join(dir, 'state.json')
    mtime = fs.statSync(file).mtimeMs
    state = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
  if (!state || typeof state !== 'object' || !state.sessionId) return null

  const updatedAt = stamp(state.updatedAt) || mtime
  return {
    id: short,
    sessionId: String(state.sessionId),
    // Whether anything is actually running this job right now. The state file
    // outlives the process — it goes on saying "blocked" or "working" for as
    // long as it sits on disk — and a phone shown a dead job as a running one
    // asked the person to wait on an agent that was never coming back. The
    // file offers no pid to check (it is null even mid-run), but a job that is
    // alive touches its state every few seconds, so a non-terminal state with
    // a fresh write behind it is the honest definition of live — and a
    // `blocked` job is live exactly as long as it has just asked, which is the
    // window in which answering it is worth a notification.
    live: !TERMINAL_STATES.has(String(state.state)) && Date.now() - updatedAt < LIVE_WINDOW_MS,
    // Which conversation this one grew out of, when it was launched from one.
    //
    // Not decoration: a job that respawns resumes its old conversation rather
    // than starting a new file, so the transcript being written right now is
    // very often this id and not `sessionId`. Both are published, and whoever
    // matches a job to a session tries both.
    resumedFrom: state.resumeSessionId ? String(state.resumeSessionId) : null,
    name: oneLine(state.name, 80) || short,
    // The sentence it wrote about itself, which is the whole reason to look.
    detail: oneLine(state.detail),
    // What it was sent off to do — worth more than the name once there are
    // several, because the names are generated and the intents are not.
    intent: oneLine(state.intent, 400),
    state: String(state.state || 'unknown'),
    tempo: state.tempo ? String(state.tempo) : null,
    tokens: Number(state.tokens) || 0,
    cwd: state.cwd ? String(state.cwd) : null,
    createdAt: stamp(state.createdAt),
    updatedAt,
    // A job that reached a terminal state has stopped; the timestamp is when.
    finishedAt: stamp(state.firstTerminalAt) || null,
    steps: withSteps ? steps(dir) : undefined,
  }
}

/** Does this desktop run background agents at all? */
export function available() {
  try {
    return fs.statSync(JOBS_DIR).isDirectory()
  } catch {
    return false
  }
}

/**
 * Every background agent worth showing, newest activity first.
 *
 * Bounded twice over — by age and by count — because the directory is a
 * history that nothing prunes, and a phone asking "what is running" should not
 * be handed last month.
 */
export function list({ all = false } = {}) {
  let names = []
  try {
    names = fs.readdirSync(JOBS_DIR, { withFileTypes: true })
      .filter((item) => item.isDirectory())
      .map((item) => item.name)
  } catch {
    return []
  }
  const now = Date.now()
  return names
    .map((short) => readJob(short))
    .filter(Boolean)
    .filter((job) => all || now - job.updatedAt < IDLE_TTL_MS)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, MAX_JOBS)
}

/** One job, with the last few things it said about itself. */
export function detail(id) {
  const short = String(id || '').replace(/[^\w-]/g, '')
  if (!short) return null
  return readJob(short, { withSteps: true })
}

/**
 * The job behind a session id, if that session is one.
 *
 * This is how a background agent's own status line reaches the row the phone
 * already draws for it: the scan finds the transcript like any other, and this
 * says the sentence the job wrote about what it is doing.
 */
export function bySession() {
  const map = new Map()
  for (const job of list()) {
    // The resumed id last so that it wins: when a job carries both, the
    // resumed conversation is the file it is actually writing to.
    map.set(job.sessionId, job)
    if (job.resumedFrom) map.set(job.resumedFrom, job)
  }
  return map
}
