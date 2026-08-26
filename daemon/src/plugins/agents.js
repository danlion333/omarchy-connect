import fs from 'node:fs'
import path from 'node:path'

import { loadConfig, updateConfig } from '../lib/config.js'
import { log } from '../lib/log.js'
import { ADAPTERS, detected } from '../agents/index.js'
import * as hooks from '../agents/hooks.js'

/**
 * The coding agent already open on the desktop, readable from the phone.
 *
 * Reading and writing are two different problems. This is the reading half:
 * every CLI agent keeps a structured transcript on disk, so a conversation can
 * be followed without touching the terminal that owns it. Writing — which is
 * genuinely hard, because nothing may push bytes into a foreign tty — is not
 * here yet, and `capabilities().write` says so rather than failing at call
 * time.
 *
 * Sessions arrive down two roads that differ in how much they can be trusted:
 *
 *   - **Hooks.** Claude Code runs a shell hook on every lifecycle event and
 *     hands it `session_id`, `transcript_path` and `cwd` on stdin. The hook
 *     process inherits the agent's environment, so it also knows the pid and
 *     the tmux pane. That is authoritative: no guessing which transcript
 *     belongs to which terminal, and it is the only road that can say
 *     `waiting` — the moment a permission prompt is on screen and a person on
 *     the sofa can actually help.
 *   - **A process scan.** `/proc` for a known agent binary, then its cwd, then
 *     the newest transcript for that directory. This is how an agent started
 *     before the hooks were installed becomes visible at all. It is a
 *     heuristic and is marked as one (`via: "scan"`).
 *
 * Reading an agent is reading everything it saw — source, tool output, any
 * secret that crossed a Bash result — so the whole plugin is off until
 * someone turns it on — `omarchy-connect agent enable`, or the switch on the
 * desktop panel, which is the same decision through a different door.
 */

/** Blocks kept in memory per open session — a phone scrolls back, not forever. */
const RING = 500
/** Transcripts tailed at once. Opening a fifth drops the oldest. */
const OPEN_LIMIT = 4
/** How often the process scan re-runs while a phone is watching. */
const SCAN_MS = 8000
/** Backstop for the tail: `fs.watch` misses writes on some filesystems. */
const POLL_MS = 2000
/** A scan-discovered session whose transcript moved this recently is working. */
const ACTIVE_MS = 20_000
/** How long a finished session stays in the list before it is forgotten. */
const GONE_TTL_MS = 5 * 60 * 1000
/** Never read more than this from a transcript on the first open. */
const MAX_FIRST_READ = 2 * 1024 * 1024
/** Enough of the tail to find the last thing the agent said, for the list. */
const PREVIEW_READ = 16 * 1024

const sessions = new Map()
let bus = null
let scanTimer = null
let pollTimer = null

const enabled = () => loadConfig().agents?.enabled === true
const spawnAllowed = () => loadConfig().agents?.spawn === true

const requireEnabled = () => {
  if (!enabled()) throw new Error('agent control is off — run `omarchy-connect agent enable` on the desktop')
}

/* ── the session as the phone sees it ──────────────────────────────────── */

const publicSession = (entry) => ({
  id: entry.id,
  agent: entry.agent,
  title: entry.title,
  cwd: entry.cwd,
  state: entry.state,
  writable: entry.writable,
  pane: entry.pane,
  pid: entry.pid,
  startedAt: entry.startedAt,
  lastActivity: entry.lastActivity,
  preview: entry.preview,
  prompt: entry.prompt,
  via: entry.via,
})

const publicBlock = ({ full, ...block }) => ({ ...block, expandable: Boolean(full) })

/**
 * One line for the session list. A long run of tool calls is the normal shape
 * of an agent at work, so a preview that only ever quotes prose spends most of
 * its life empty — what it is doing right now is the useful answer.
 */
function describe(block) {
  const text =
    block.kind === 'text' ? block.text
    : block.kind === 'tool' ? `${block.tool} ${block.summary}`
    : block.kind === 'result' ? block.summary
    : block.kind === 'thinking' ? 'thinking'
    : ''
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, 160)
}

const emit = (data) => bus?.emit('event', 'agent', data)

const emitSession = (entry, removed = false) =>
  emit({ kind: 'session', id: entry.id, removed, session: removed ? null : publicSession(entry) })

const emitState = (entry) =>
  emit({
    kind: 'state',
    id: entry.id,
    state: entry.state,
    prompt: entry.prompt,
    preview: entry.preview,
    lastActivity: entry.lastActivity,
  })

/**
 * `waiting` is the field the whole feature hangs on, so it is the one that has
 * to be right: it means the agent asked a question and stopped, which is the
 * only state a phone can do something about.
 */
function setState(entry, state, { prompt = null } = {}) {
  if (entry.state === state && entry.prompt === prompt) return false
  entry.state = state
  entry.prompt = state === 'waiting' ? prompt : null
  emitState(entry)
  return true
}

function upsert(fields) {
  const existing = sessions.get(fields.id)
  if (existing) {
    // A hook knows things a scan can only guess at, so it is allowed to
    // overwrite them; a scan must never downgrade what a hook established.
    const trusted = fields.via === 'hook' || existing.via !== 'hook'
    if (trusted) {
      if (fields.pid) existing.pid = fields.pid
      if (fields.pane) existing.pane = fields.pane
      if (fields.cwd) existing.cwd = fields.cwd
      if (fields.via) existing.via = fields.via
    }
    if (fields.transcript) existing.transcript = fields.transcript
    existing.goneAt = null
    return { entry: existing, created: false }
  }
  const entry = {
    id: fields.id,
    agent: fields.agent,
    adapter: fields.adapter,
    title: path.basename(fields.cwd || '') || fields.agent,
    cwd: fields.cwd || null,
    state: fields.state || 'idle',
    // Stage two's problem. Saying `null` now is what lets the app grey the
    // input out instead of offering a send that cannot work.
    writable: null,
    pane: fields.pane || null,
    pid: fields.pid || null,
    transcript: fields.transcript,
    startedAt: fields.startedAt || Date.now(),
    lastActivity: fields.lastActivity || Date.now(),
    preview: '',
    prompt: null,
    via: fields.via || 'scan',
    goneAt: null,
    /* internals — never leave the daemon */
    previewAt: 0,
    blocks: [],
    seq: 0,
    offset: 0,
    loaded: false,
    opens: 0,
    openedAt: 0,
    watcher: null,
  }
  sessions.set(entry.id, entry)
  return { entry, created: true }
}

function forget(entry) {
  closeTail(entry)
  sessions.delete(entry.id)
  emitSession(entry, true)
}

/* ── reading the transcript ────────────────────────────────────────────── */

/**
 * Bytes from `offset` to the last complete line. Byte offsets rather than a
 * carried-over string buffer: the tail then has no state to lose, and a
 * multi-byte character split across two writes cannot corrupt a line.
 */
function readFrom(file, offset) {
  const stat = fs.statSync(file)
  // Rewritten or rotated under us — start again rather than read garbage.
  if (stat.size < offset) return { text: '', offset: 0, reset: true }
  if (stat.size === offset) return { text: '', offset }
  const fd = fs.openSync(file, 'r')
  try {
    const length = stat.size - offset
    const buf = Buffer.allocUnsafe(length)
    const read = fs.readSync(fd, buf, 0, length, offset)
    const slice = buf.subarray(0, read)
    const nl = slice.lastIndexOf(0x0a)
    if (nl < 0) return { text: '', offset } // a line is still being written
    const complete = slice.subarray(0, nl + 1)
    return { text: complete.toString('utf8'), offset: offset + complete.length }
  } finally {
    fs.closeSync(fd)
  }
}

function ingest(entry, text) {
  const fresh = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    for (const block of entry.adapter.parse(line)) {
      entry.seq += 1
      const stored = { seq: entry.seq, ...block }
      entry.blocks.push(stored)
      fresh.push(stored)
    }
  }
  if (!fresh.length) return fresh
  if (entry.blocks.length > RING) entry.blocks.splice(0, entry.blocks.length - RING)

  entry.lastActivity = fresh[fresh.length - 1].at || Date.now()
  const preview = describe(fresh[fresh.length - 1])
  if (preview) entry.preview = preview
  // A permission prompt that was answered at the keyboard fires no hook we
  // subscribe to, so the transcript moving again is what clears `waiting`.
  if (entry.state === 'waiting') setState(entry, 'working')
  return fresh
}

/**
 * The last line the agent said, for a session nobody has opened.
 *
 * The list on the phone is mostly previews, and a session is only tailed once
 * it is opened — so this reads the tail of the file directly. It is bounded in
 * both directions: 16 KB at a time, and never twice for the same write.
 */
function refreshPreview(entry) {
  if (entry.opens > 0) return
  let stat
  try {
    stat = fs.statSync(entry.transcript)
  } catch {
    return
  }
  if (entry.previewAt === stat.mtimeMs) return
  entry.previewAt = stat.mtimeMs
  const start = stat.size > PREVIEW_READ ? stat.size - PREVIEW_READ : 0
  let text
  try {
    text = readFrom(entry.transcript, start).text
  } catch {
    return
  }
  if (start > 0) text = text.slice(text.indexOf('\n') + 1)
  let last = null
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    for (const block of entry.adapter.parse(line)) last = block
  }
  const preview = last && describe(last)
  if (preview) entry.preview = preview
}

/** First read of a session: everything on disk, or the tail of a huge file. */
function load(entry) {
  if (entry.loaded) return
  entry.loaded = true
  let stat
  try {
    stat = fs.statSync(entry.transcript)
  } catch {
    return
  }
  const start = stat.size > MAX_FIRST_READ ? stat.size - MAX_FIRST_READ : 0
  entry.offset = start
  const { text, offset } = readFrom(entry.transcript, start)
  entry.offset = offset
  // A tail that begins mid-file starts mid-line; that line is not ours to parse.
  ingest(entry, start > 0 ? text.slice(text.indexOf('\n') + 1) : text)
}

function drain(entry) {
  if (!entry.loaded) return
  let result
  try {
    result = readFrom(entry.transcript, entry.offset)
  } catch {
    return
  }
  if (result.reset) {
    entry.offset = 0
    entry.blocks = []
    entry.loaded = false
    load(entry)
    if (entry.opens > 0 && entry.blocks.length) {
      emit({ kind: 'blocks', id: entry.id, reset: true, blocks: entry.blocks.map(publicBlock), cursor: entry.seq })
    }
    return
  }
  entry.offset = result.offset
  if (!result.text) return
  const fresh = ingest(entry, result.text)
  if (fresh.length && entry.opens > 0) {
    emit({ kind: 'blocks', id: entry.id, blocks: fresh.map(publicBlock), cursor: entry.seq })
  }
}

function openTail(entry) {
  if (entry.watcher) return
  try {
    entry.watcher = fs.watch(entry.transcript, { persistent: false }, () => drain(entry))
    entry.watcher.on('error', () => closeTail(entry))
  } catch {
    // No watch is survivable — the poll below carries it, just less promptly.
    entry.watcher = null
  }
}

function closeTail(entry) {
  entry.watcher?.close()
  entry.watcher = null
}

/** Only the sessions a phone is actually reading are tailed. */
function openedSessions() {
  return [...sessions.values()].filter((e) => e.opens > 0)
}

function release(entry) {
  entry.opens = Math.max(0, entry.opens - 1)
  if (entry.opens > 0) return
  closeTail(entry)
  entry.blocks = []
  entry.loaded = false
  entry.offset = 0
  entry.seq = 0
}

/* ── discovery: the process scan ───────────────────────────────────────── */

const procFile = (pid, name) => {
  try {
    return fs.readFileSync(`/proc/${pid}/${name}`, 'utf8')
  } catch {
    return null
  }
}

const alive = (pid) => Boolean(pid) && fs.existsSync(`/proc/${pid}`)

/** Boot-relative start time, so two agents in one directory can be ordered. */
function startTicks(pid) {
  const stat = procFile(pid, 'stat')
  if (!stat) return 0
  // The comm field can contain spaces and parentheses; everything after the
  // last ')' is fixed-width, which is why this is not a plain split.
  const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
  return Number(fields[19]) || 0
}

/**
 * Every running agent process this user owns, with its working directory.
 *
 * `comm` alone is not proof — it is truncated to 15 characters and a grep for
 * "claude" reports it too — so argv[0] has to agree.
 */
function scanProcesses() {
  const found = []
  let pids
  try {
    pids = fs.readdirSync('/proc').filter((name) => /^\d+$/.test(name))
  } catch {
    return found
  }
  for (const pid of pids) {
    const comm = procFile(pid, 'comm')?.trim()
    if (!comm) continue
    const adapter = ADAPTERS.find((a) => a.binaries.includes(comm))
    if (!adapter) continue
    const cmdline = procFile(pid, 'cmdline')
    const argv0 = cmdline ? path.basename(cmdline.split('\0')[0] || '') : ''
    if (argv0 && !adapter.binaries.includes(argv0) && argv0 !== 'node') continue
    let cwd
    try {
      cwd = fs.readlinkSync(`/proc/${pid}/cwd`)
    } catch {
      continue // another user's process, or one that exited mid-scan
    }
    found.push({ pid: Number(pid), adapter, cwd, ticks: startTicks(pid) })
  }
  return found
}

/**
 * Attach live processes to transcripts. When two agents share a directory
 * neither `/proc` nor the transcript says which is which, so the newest
 * transcript goes to the newest process and the guess is labelled as one.
 */
function scan() {
  const processes = scanProcesses().sort((a, b) => b.ticks - a.ticks)
  const byDir = new Map()
  for (const proc of processes) {
    const key = `${proc.adapter.id} ${proc.cwd}`
    if (!byDir.has(key)) byDir.set(key, [])
    byDir.get(key).push(proc)
  }

  const seen = new Set()
  for (const [, group] of byDir) {
    const { adapter, cwd } = group[0]
    const transcripts = adapter.transcripts(cwd)
    group.forEach((proc, i) => {
      const transcript = transcripts[i]
      if (!transcript) return
      const id = `${adapter.id}:${transcript.id}`
      seen.add(id)
      const { entry, created } = upsert({
        id,
        agent: adapter.id,
        adapter,
        cwd,
        pid: proc.pid,
        transcript: transcript.path,
        lastActivity: transcript.mtime,
        via: 'scan',
      })
      if (entry.via === 'scan') {
        setState(entry, Date.now() - transcript.mtime < ACTIVE_MS ? 'working' : 'idle')
        entry.lastActivity = Math.max(entry.lastActivity, transcript.mtime)
      }
      refreshPreview(entry)
      if (created) {
        log.debug(`agent session discovered: ${id} in ${cwd}`)
        emitSession(entry)
      }
    })
  }

  // A session whose process is gone is gone, whichever road found it. Hook
  // sessions are the exception while their pid is unknown — a hook may arrive
  // before the scan has ever seen that process.
  const now = Date.now()
  for (const entry of sessions.values()) {
    if (seen.has(entry.id)) continue
    if (entry.pid && alive(entry.pid)) continue
    if (!entry.pid && entry.via === 'hook' && entry.state !== 'gone') continue
    if (entry.state !== 'gone') {
      setState(entry, 'gone')
      entry.goneAt = now
    }
    if (entry.goneAt && now - entry.goneAt > GONE_TTL_MS) forget(entry)
  }
}

/* ── discovery: hooks ──────────────────────────────────────────────────── */

/** From the hook process up to the agent that ran it — at most a few steps. */
function agentPidFrom(ppid, adapter) {
  let pid = Number(ppid) || 0
  for (let i = 0; i < 6 && pid > 1; i += 1) {
    const comm = procFile(pid, 'comm')?.trim()
    if (comm && adapter.binaries.includes(comm)) return pid
    const stat = procFile(pid, 'stat')
    if (!stat) return null
    pid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]) || 0
  }
  return null
}

const HOOK_STATE = {
  SessionStart: 'idle',
  UserPromptSubmit: 'working',
  Stop: 'idle',
  Notification: 'waiting',
  SessionEnd: 'gone',
}

/**
 * A lifecycle event straight from the agent. This is the authoritative road:
 * the payload names the transcript, and the environment the hook inherited
 * names the process and the pane it is running in.
 */
export function hook(payload = {}) {
  if (!enabled()) return { ok: false, error: 'agents disabled' }
  const event = String(payload.hook_event_name || payload.event || '')
  const transcript = String(payload.transcript_path || '')
  if (!transcript) return { ok: false, error: 'transcript_path required' }

  const adapter = ADAPTERS.find((a) => a.id === (payload.agent || 'claude'))
  if (!adapter) return { ok: false, error: 'unknown agent' }

  const id = `${adapter.id}:${adapter.sessionIdFor(transcript)}`
  const { entry, created } = upsert({
    id,
    agent: adapter.id,
    adapter,
    cwd: payload.cwd || null,
    pid: payload.pid || agentPidFrom(payload.ppid, adapter),
    pane: payload.pane || null,
    transcript,
    via: 'hook',
  })
  entry.lastActivity = Date.now()
  if (created) {
    log.debug(`agent session registered by hook: ${id}`)
    emitSession(entry)
  }

  const next = HOOK_STATE[event]
  if (next === 'gone') {
    setState(entry, 'gone')
    entry.goneAt = Date.now()
  } else if (next) {
    setState(entry, next, { prompt: next === 'waiting' ? String(payload.message || '').slice(0, 400) || null : null })
  }
  // The transcript is usually already on disk by the time the hook fires, so a
  // reader gets the last turn without waiting for the watcher to notice.
  if (entry.opens > 0) drain(entry)
  else refreshPreview(entry)
  // A finished session has already been announced by its state change; saying
  // it again as a session frame would put it back in a list that just dropped it.
  if (!created && entry.state !== 'gone') emitSession(entry)
  return { ok: true, id, state: entry.state }
}

/* ── the switch ────────────────────────────────────────────────────────── */

/**
 * Start watching: the periodic scan for agents nobody hooked, and the poll
 * that backs up `fs.watch` on filesystems where it misses writes. Neither
 * costs anything while no phone is subscribed, and both are torn down the
 * moment the feature goes off.
 */
function watch() {
  if (scanTimer) return

  scanTimer = setInterval(() => {
    // Nobody is watching: the scan is the only thing here that costs
    // anything, and hooks keep the registry current for free.
    if (!bus?.hasSubscribers('agent')) return
    try {
      scan()
    } catch (err) {
      log.debug('agent scan failed:', err.message)
    }
  }, SCAN_MS)
  scanTimer.unref?.()

  pollTimer = setInterval(() => {
    const open = openedSessions()
    if (!open.length) return
    // A phone that walked away takes its subscription with it.
    if (!bus?.hasSubscribers('agent')) {
      for (const entry of open) {
        entry.opens = 0
        release(entry)
      }
      return
    }
    for (const entry of open) drain(entry)
  }, POLL_MS)
  pollTimer.unref?.()

  try {
    scan()
  } catch (err) {
    log.debug('agent scan failed:', err.message)
  }
  log.info("agent control is on — phones can read this desktop's coding agents")
}

/** Stop watching and forget what was seen: a transcript held open is a read. */
function unwatch() {
  clearInterval(scanTimer)
  clearInterval(pollTimer)
  scanTimer = null
  pollTimer = null
  for (const entry of sessions.values()) closeTail(entry)
  sessions.clear()
}

/**
 * Turn reading on or off while the daemon runs.
 *
 * The desktop panel is the reason this exists. Writing the config file and
 * asking for a restart would drop the phone's link — and a switch on a bar
 * widget that costs you the connection is not a switch anyone will use — so
 * the daemon owns both halves of the change: it writes the config, so the
 * decision survives a restart, and it starts or stops the watching itself.
 *
 * Turning it off is the half that has to be immediate: every open transcript
 * is closed and every session forgotten before this returns, and the phone is
 * told so it stops offering a screen it can no longer fill.
 */
export function setEnabled(on) {
  const next = on === true
  const was = enabled()
  updateConfig((cfg) => {
    cfg.agents = { ...(cfg.agents || {}), enabled: next }
  })
  if (next === was) return summary()
  if (next) watch()
  else {
    unwatch()
    log.info('agent control is off — nothing is reading this desktop\'s coding agents')
  }
  // The phone learned whether it could read agents from `hello`, and it is not
  // about to say hello again. This is how it finds out the answer changed.
  emit({ kind: 'control', enabled: next, adapters: detected() })
  return summary()
}

/* ── what the panel and the CLI read ───────────────────────────────────── */

/** Which agents are installed on this desktop — re-exported for the CLI. */
export { detected }

export function summary() {
  const list = [...sessions.values()].filter((e) => e.state !== 'gone')
  return {
    enabled: enabled(),
    adapters: detected(),
    // Without hooks a session is found by scanning `/proc`, which can say an
    // agent is running but never that it is *waiting* — the panel offers to
    // install them for exactly that reason, so it has to know.
    hooks: hooks.installed(),
    running: list.length,
    waiting: list.filter((e) => e.state === 'waiting').length,
    sessions: list.map(publicSession),
  }
}

/* ── plugin ────────────────────────────────────────────────────────────── */

export default {
  name: 'agents',

  capabilities() {
    return {
      enabled: enabled(),
      adapters: detected(),
      read: true,
      // Stage two and stage four. The app greys these out rather than
      // discovering at call time that this desktop cannot do them.
      write: null,
      spawn: spawnAllowed(),
    }
  },

  start(eventBus) {
    bus = eventBus
    if (enabled()) watch()
  },

  stop() {
    unwatch()
    bus = null
  },

  methods: {
    /** Every agent session this desktop can see, newest activity first. */
    'agents.list'() {
      requireEnabled()
      try {
        scan()
      } catch (err) {
        log.debug('agent scan failed:', err.message)
      }
      const list = [...sessions.values()]
        .filter((e) => e.state !== 'gone')
        .sort((a, b) => {
          // A blocked agent is the reason anyone opened this screen.
          if ((a.state === 'waiting') !== (b.state === 'waiting')) return a.state === 'waiting' ? -1 : 1
          return b.lastActivity - a.lastActivity
        })
      return { sessions: list.map(publicSession), ...this['agents.capabilities']() }
    },

    'agents.capabilities'() {
      return {
        adapters: detected(),
        write: null,
        spawn: spawnAllowed(),
      }
    },

    /**
     * Start reading one session: a snapshot now, then `agent` events as the
     * transcript grows. Only opened sessions are tailed — the same
     * reference-counted discipline the stats sampler uses.
     */
    'agents.open'({ id, limit = 60 } = {}) {
      requireEnabled()
      const entry = sessions.get(String(id))
      if (!entry) throw new Error('no such agent session')
      const count = Math.min(Math.max(Number(limit) || 60, 1), 300)

      if (entry.opens === 0) {
        const open = openedSessions().sort((a, b) => a.openedAt - b.openedAt)
        while (open.length >= OPEN_LIMIT) {
          const victim = open.shift()
          victim.opens = 0
          release(victim)
        }
      }
      entry.opens += 1
      entry.openedAt = Date.now()
      load(entry)
      drain(entry)
      openTail(entry)

      return {
        session: publicSession(entry),
        blocks: entry.blocks.slice(-count).map(publicBlock),
        cursor: entry.seq,
        truncated: entry.blocks.length > count,
      }
    },

    'agents.close'({ id } = {}) {
      requireEnabled()
      const entry = sessions.get(String(id))
      if (!entry) return { ok: true }
      release(entry)
      return { ok: true }
    },

    /**
     * The full body behind a one-line chip. Tool traffic is collapsed for the
     * phone's sake, not hidden — this is the one tap away.
     */
    'agents.detail'({ id, seq } = {}) {
      requireEnabled()
      const entry = sessions.get(String(id))
      if (!entry) throw new Error('no such agent session')
      const block = entry.blocks.find((b) => b.seq === Number(seq))
      if (!block) throw new Error('that block is no longer in memory')
      return { seq: block.seq, kind: block.kind, tool: block.tool ?? null, text: block.full ?? block.text ?? '' }
    },
  },
}
