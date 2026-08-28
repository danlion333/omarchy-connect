import fs from 'node:fs'
import path from 'node:path'

import { loadConfig, updateConfig } from '../lib/config.js'
import { log } from '../lib/log.js'
import { ADAPTERS, detected } from '../agents/index.js'
import * as hooks from '../agents/hooks.js'
import * as writer from '../agents/writer.js'
import * as drops from '../agents/drops.js'
import { pair } from '../agents/pairing.js'
import { alive, ancestors, commOf, hasTty, procFile, startedAt, startTicks } from '../agents/proc.js'

/**
 * The coding agent already open on the desktop, readable from the phone.
 *
 * Reading and writing are two different problems with different answers.
 * Reading is easy and the agents solved it themselves: every CLI agent keeps a
 * structured transcript on disk, so a conversation can be followed without
 * touching the terminal that owns it. Writing is the hard half — nothing may
 * push bytes into a foreign tty — and it lives in `agents/writer.js`, which
 * picks between the multiplexer that owns the pty and the compositor typing on
 * the user's behalf. This plugin owns the gate, the registry and the state
 * machine that both halves share.
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
 *     the newest transcript for that directory that the process could actually
 *     have written. This is how an agent started before the hooks were
 *     installed becomes visible at all. It is a heuristic and is marked as one
 *     (`via: "scan"`) — `agents/pairing.js` is what keeps it from guessing
 *     something impossible.
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
/**
 * How long a hook-registered session with no pid is believed.
 *
 * A hook can arrive before the scan has ever seen the process behind it, so a
 * session whose pid is unknown cannot be judged on liveness and used to be
 * kept forever on that reasoning. Forever is too long: if the hook could not
 * name the process, nothing ever will, and the session outlives the agent by
 * the whole uptime of the daemon. A transcript that has not moved in this long
 * belongs to an agent that is not there to move it.
 */
const ORPHAN_TTL_MS = 10 * 60 * 1000
/** Never read more than this from a transcript on the first open. */
const MAX_FIRST_READ = 2 * 1024 * 1024
/** Enough of the tail to find the last thing the agent said, for the list. */
const PREVIEW_READ = 16 * 1024
/**
 * Between the keypresses of an answer.
 *
 * Wider than a keystroke needs because answering a multi-select changes the
 * screen mid-chord, and the prompt drops the key that arrives while it is
 * drawing the next one.
 */
const ANSWER_GAP_MS = 300

const sessions = new Map()
let bus = null
let scanTimer = null
let pollTimer = null

const enabled = () => loadConfig().agents?.enabled === true
const spawnAllowed = () => loadConfig().agents?.spawn === true

// The HTTP side asks the same question: a phone may only drop a picture where
// an agent can read it while agents are something this desktop does at all.
export { enabled as agentsEnabled }

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
    : block.kind === 'question' ? `asked: ${block.summary}`
    : block.kind === 'tool' ? `${block.tool} ${block.summary}`
    : block.kind === 'result' ? block.summary
    : block.kind === 'thinking' ? 'thinking'
    : ''
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, 160)
}

/** The longest message a phone may type in one go. */
const MAX_SEND = 4096
/** Pictures per message. More than a handful is a file transfer, not a question. */
const MAX_ATTACH = 6

const emit = (data) => bus?.emit('event', 'agent', data)

/** A session that exists and has not ended — what every write needs. */
function liveSession(id) {
  const entry = sessions.get(String(id))
  if (!entry) throw new Error('no such agent session')
  if (entry.state === 'gone') throw new Error('that session has ended')
  return entry
}

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
    // Filled in by the survey below, which is the only thing that knows
    // whether anything on this desktop can reach the session's terminal.
    writable: null,
    pane: fields.pane || null,
    // The Hyprland window that owns the terminal, when there is no pane.
    window: null,
    pid: fields.pid || null,
    transcript: fields.transcript,
    startedAt: fields.startedAt || Date.now(),
    lastActivity: fields.lastActivity || Date.now(),
    preview: '',
    prompt: null,
    // The question this session is standing at, when a hook has told us about
    // one. Kept beside the session rather than only among its blocks: the
    // blocks go when the phone closes the screen, and the question does not.
    question: null,
    via: fields.via || 'scan',
    goneAt: null,
    /* internals — never leave the daemon */
    previewAt: 0,
    blocks: [],
    // Set when the transcript catches up with a hook's question and the card
    // has to move down past the words that came with it — the phone appends,
    // so a reordered list is only true once it is sent again whole.
    reordered: false,
    seq: 0,
    offset: 0,
    loaded: false,
    opens: 0,
    openedAt: 0,
    watcher: null,
    writeChain: null,
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

function ingest(entry, text, { backfill = false } = {}) {
  const fresh = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    for (const block of entry.adapter.parse(line)) {
      // The transcript catching up with a question a hook already carried:
      // the same tool call arriving a second time, and one card is enough.
      //
      // The card does have to move, though. What the agent said on its way to
      // asking is in the same withheld turn as the question, so it lands here
      // a moment ago — after a card the hook put on screen minutes earlier,
      // which reads as an answer arriving before its question. Sliding the
      // card down to where the transcript keeps it puts the words back in
      // front of it. Its `seq` travels with it rather than being reissued: the
      // phone answers a question by seq, and a card that renumbers under a
      // thumb is a phone answering the wrong one.
      if (block.kind === 'question' && block.ref) {
        const held = entry.blocks.findIndex((b) => b.kind === 'question' && b.ref === block.ref)
        if (held >= 0) {
          if (held !== entry.blocks.length - 1) {
            entry.blocks.push(entry.blocks.splice(held, 1)[0])
            entry.reordered = true
          }
          continue
        }
      }
      // Whatever this answered, it is answered — including a question the
      // hook road is still holding on to.
      if (block.kind === 'result' && block.ref) clearQuestion(entry, block.ref)
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

  // A multiple-choice question is the one thing an agent blocks on that it
  // *does* write down, so this is the only road to `waiting` that needs no
  // hook at all — a session found by scanning /proc can now say it is stuck
  // and say what on, which the design document had down as an open question.
  const question = pendingQuestion(entry)
  if (question) setState(entry, 'waiting', { prompt: question.summary })
  // A permission prompt that was answered at the keyboard fires no hook we
  // subscribe to, so the transcript moving again is what clears `waiting`.
  // Reading a file for the first time is not the transcript moving, though:
  // a session opened while it waits has to still be waiting once it is on
  // screen, rather than flip to `working` for having been looked at.
  else if (entry.state === 'waiting' && !backfill) setState(entry, 'working')
  return fresh
}

/** How far back a question can be and still be the thing the agent is on. */
const QUESTION_TAIL = 8

/**
 * The multiple-choice question this session is sitting on, if it is sitting on
 * one.
 *
 * `AskUserQuestion` blocks the agent outright, so the question worth offering
 * is always near the end — and once its result lands the agent has moved on,
 * whoever answered it and from wherever. Both halves are read off the
 * transcript, which means a question answered at the keyboard clears itself on
 * the phone without anything having to tell it.
 */
function pendingQuestion(entry) {
  const tail = entry.blocks.slice(-QUESTION_TAIL)
  const answered = new Set(tail.filter((b) => b.kind === 'result' && b.ref).map((b) => b.ref))
  for (let i = tail.length - 1; i >= 0; i -= 1) {
    const block = tail[i]
    if (block.kind === 'question' && block.ref && !answered.has(block.ref)) return block
  }
  return null
}

const hasQuestion = (entry, ref) => entry.blocks.some((b) => b.kind === 'question' && b.ref === ref)

/**
 * The question a hook handed over, put where the transcript's questions go.
 *
 * Claude Code writes an assistant turn down only once the tool inside it has
 * returned, so a question the agent is *blocked on* is in no file yet — the
 * hook is the only thing that has it while it is still worth answering. The
 * block it becomes is indistinguishable from one the transcript would have
 * produced, which is the point: the phone draws one card, `agents.answer`
 * validates against one shape, and when the transcript does catch up its copy
 * is dropped as the duplicate it is — the card that is already on screen slides
 * down to stand where that copy would have, behind the words held back with it.
 *
 * Those words are the one thing this road cannot carry. The withheld turn is
 * usually the agent explaining what it is about to ask about, and until it is
 * answered that explanation is nowhere but the terminal — no hook payload has
 * it, and `tool_input` is only the question itself.
 */
function syncQuestion(entry) {
  const question = entry.question
  if (!question || !entry.loaded) return null
  if (question.ref && hasQuestion(entry, question.ref)) return null
  entry.seq += 1
  const stored = { seq: entry.seq, ...question }
  entry.blocks.push(stored)
  return stored
}

/** Forget the pending question — all of them, or the one that was answered. */
function clearQuestion(entry, ref = null) {
  if (!entry.question) return false
  if (ref && entry.question.ref !== ref) return false
  entry.question = null
  return true
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
  ingest(entry, start > 0 ? text.slice(text.indexOf('\n') + 1) : text, { backfill: true })
  syncQuestion(entry)
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
    entry.reordered = false
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
  // A move is not something an appending phone can be told about a block at a
  // time, so a batch that reordered anything is sent as the whole list.
  const moved = entry.reordered
  entry.reordered = false
  if (entry.opens === 0) return
  if (moved) {
    emit({ kind: 'blocks', id: entry.id, reset: true, blocks: entry.blocks.map(publicBlock), cursor: entry.seq })
  } else if (fresh.length) {
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
  entry.reordered = false
  entry.loaded = false
  entry.offset = 0
  entry.seq = 0
}

/* ── discovery: the process scan ───────────────────────────────────────── */

/**
 * Every running agent process this user owns, with its working directory.
 *
 * `comm` alone is not proof — it is truncated to 15 characters and a grep for
 * "claude" reports it too — so argv[0] has to agree. Nor is argv[0] the end of
 * it: an agent's own supervisor and its pty hosts run the same binary under
 * the same name, and one of them was being listed on the phone as a session
 * with somebody else's conversation inside it. What the argv actually *says*
 * is the thing that separates them, and only the adapter knows its own CLI
 * well enough to read it.
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
    const comm = commOf(pid)
    if (!comm) continue
    const adapter = ADAPTERS.find((a) => a.binaries.includes(comm))
    if (!adapter) continue
    const cmdline = procFile(pid, 'cmdline')
    const argv = cmdline ? cmdline.split('\0').filter(Boolean) : []
    const argv0 = argv.length ? path.basename(argv[0]) : ''
    if (argv0 && !adapter.binaries.includes(argv0) && argv0 !== 'node') continue
    if (adapter.isSession && !adapter.isSession(argv)) continue
    let cwd
    try {
      cwd = fs.readlinkSync(`/proc/${pid}/cwd`)
    } catch {
      continue // another user's process, or one that exited mid-scan
    }
    found.push({
      pid: Number(pid),
      adapter,
      cwd,
      ticks: startTicks(pid),
      startedAt: startedAt(pid),
      tty: hasTty(pid),
    })
  }
  return found
}

/**
 * Whether a transcript was written in the background, remembered per file.
 *
 * The answer is read off the end of the file, and the file only has to be read
 * again once it has changed — which is the same bargain `hooks.installed()`
 * strikes with the settings file, and for the same reason: this is asked on
 * every scan, and a scan happens whenever a phone is looking.
 *
 * The map is keyed by path and holds one small entry per transcript a live
 * agent has been considered against, so it stays the size of the desktop's
 * open sessions rather than of its history.
 */
const backgrounds = new Map()

/** A desktop has nothing like this many live agents; past it, start again. */
const BACKGROUND_CACHE_MAX = 256

const backgroundOf = (adapter) => (transcript) => {
  if (!adapter.background) return null
  const cached = backgrounds.get(transcript.path)
  if (cached && cached.at === transcript.mtime) return cached.value
  if (backgrounds.size >= BACKGROUND_CACHE_MAX) backgrounds.clear()
  const value = adapter.background(transcript.path)
  backgrounds.set(transcript.path, { at: transcript.mtime, value })
  return value
}

/**
 * Attach live processes to transcripts. When two agents share a directory
 * neither `/proc` nor the transcript says which is which, so the pairing is a
 * guess and is labelled as one — `agents/pairing.js` is what keeps it from
 * guessing something that cannot be true.
 */
function scan() {
  const processes = scanProcesses()
  const byDir = new Map()
  for (const proc of processes) {
    const key = `${proc.adapter.id}\u0000${proc.cwd}`
    if (!byDir.has(key)) byDir.set(key, [])
    byDir.get(key).push(proc)
  }

  const seen = new Set()
  for (const [, group] of byDir) {
    const { adapter, cwd } = group[0]
    for (const { proc, transcript } of pair(group, adapter.transcripts(cwd), { background: backgroundOf(adapter) })) {
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
    }
  }
  return seen
}

/**
 * Drop the sessions whose agent is no longer running.
 *
 * Its own pass, and called whether or not the discovery above got through,
 * because the two fail in different ways and only one of them is survivable.
 * A scan that throws leaves the list exactly as it was — which is a list of
 * agents that have since been killed, closed, or rebooted away, sitting on the
 * phone under states none of them are in any more. A daemon that has stopped
 * discovering new sessions is behind; a daemon that has stopped forgetting old
 * ones is lying, and it never corrects itself.
 *
 * `seen` is what discovery managed to confirm this time round. Without it —
 * discovery having failed — a session is judged on its pid alone, which is the
 * conservative half of the same question.
 */
function reap(seen = null) {
  const now = Date.now()
  for (const entry of sessions.values()) {
    if (seen?.has(entry.id)) continue
    // Liveness is the whole test, and deliberately nothing more. Asking that
    // the pid still *look* like an agent would catch the odd reused pid and
    // would also drop any session whose process this daemon cannot recognise
    // — and a live session that vanishes off the phone is a far worse answer
    // than a dead one that lingers for another eight seconds.
    if (entry.pid && alive(entry.pid)) continue
    // A hook that arrived before the scan ever saw the process leaves a session
    // with no pid to check. It is given the benefit of the doubt, but not
    // indefinitely: a transcript that has not moved in this long belongs to an
    // agent that is not there to move it.
    if (!entry.pid && entry.via === 'hook' && entry.state !== 'gone' && now - entry.lastActivity < ORPHAN_TTL_MS) continue
    if (entry.state !== 'gone') {
      setState(entry, 'gone')
      entry.goneAt = now
    }
    if (entry.goneAt && now - entry.goneAt > GONE_TTL_MS) forget(entry)
  }
}

/**
 * Discovery and reaping, in that order, with the second surviving the first.
 *
 * The failure this shape exists for was a real one and it was silent: a
 * mistyped import made every scan throw before it reached a single line of
 * work, and because the throw was swallowed at `debug` the daemon went on
 * publishing a list nobody was maintaining — no new sessions, and none of the
 * finished ones ever dropped. So the scan's failure is a warning now, loud
 * enough to be read in a log, and the reap runs either way.
 */
function sweep() {
  let seen = null
  try {
    seen = scan()
  } catch (err) {
    log.warn('agent scan failed:', err.message)
  }
  reap(seen)
}

/* ── discovery: what can be typed into ─────────────────────────────────── */

/**
 * Work out how each live session could be answered, and tell the phone when
 * that changes.
 *
 * Kept apart from the scan above because it asks different questions of a
 * different subsystem — tmux and the compositor rather than `/proc` — and
 * because it is the one part of discovery that can fail slowly: `tmux
 * list-panes` on a busy server, `hyprctl clients` on a compositor mid-resize.
 * The scan stays synchronous and this trails it.
 *
 * A session that gains or loses a way in is a session whose composer has to
 * change on the phone, so the change is announced rather than waiting for the
 * next list.
 */
async function resurvey(entries = [...sessions.values()].filter((e) => e.state !== 'gone')) {
  const before = new Map(entries.map((e) => [e.id, e.writable]))
  try {
    await writer.survey(entries)
  } catch (err) {
    log.debug('agent write survey failed:', err.message)
    return
  }
  for (const entry of entries) {
    if (before.get(entry.id) === entry.writable) continue
    log.debug(`agent session ${entry.id} is writable via ${entry.writable || 'nothing'}`)
    if (sessions.has(entry.id)) emitSession(entry)
  }
}

/** The one session a `send` is about, resolved as late as possible. */
async function ensureWritable(entry) {
  await resurvey([entry])
  if (!entry.writable) {
    throw new Error(
      writer.best()
        ? 'that session is not in a terminal this desktop can type into — start it with `omarchy-connect agent run`'
        : 'this desktop has no way to type into a terminal — install tmux, or wtype for the fallback',
    )
  }
  return entry
}

/* ── discovery: hooks ──────────────────────────────────────────────────── */

/** From the hook process up to the agent that ran it — at most a few steps. */
function agentPidFrom(ppid, adapter) {
  for (const pid of ancestors(ppid, 6)) {
    const comm = commOf(pid)
    if (comm && adapter.binaries.includes(comm)) return pid
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
 * The notification that means nothing is wrong.
 *
 * `Notification` carries two very different sentences. One is a permission
 * prompt on screen and an agent that cannot go on without an answer — the
 * moment this whole feature was built for. The other fires a minute after the
 * agent finished, to say that it is sitting at an empty prompt the way it will
 * sit there all evening, and treating that as `waiting` put a "needs you"
 * badge and a push notification on every agent the user simply walked away
 * from. An idle agent is idle; the phone should say so.
 */
const IDLE_NOTIFICATION = /waiting for your input/i

/**
 * What a `Notification` actually means for this session.
 *
 * A question already on the books outranks the message: the idle timer keeps
 * running while a prompt is on screen, so the "waiting for your input" line
 * can arrive on top of a real question, and dropping to `idle` there would
 * take a card the phone can answer off the screen.
 */
const notificationState = (entry, message) =>
  IDLE_NOTIFICATION.test(message || '') && !entry.question ? 'idle' : 'waiting'

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

  // A question the agent has not asked yet. `PreToolUse` fires while it is
  // still standing at the prompt, which is the only moment the answer is worth
  // anything — by the time the turn reaches the transcript it has been given.
  if (event === 'PreToolUse') {
    const question = entry.adapter.question?.(payload.tool_name, payload.tool_input)
    if (question) entry.question = { ...question, at: Date.now(), ref: payload.tool_use_id || null }
  } else if (event === 'PostToolUse') {
    // Answered — at the keyboard or from the phone, it makes no difference
    // here. This is what keeps the card from being put back on a screen the
    // agent has already moved past, and it is the only thing that clears
    // `waiting` for a session nobody has opened: with no reader there is no
    // tail, so the answer landing in the transcript goes unnoticed.
    if (clearQuestion(entry, payload.tool_use_id || null)) {
      const still = pendingQuestion(entry)
      setState(entry, still ? 'waiting' : 'working', { prompt: still?.summary ?? null })
    }
  }

  // Both hooks fire for the same stop, and "Which fruit should I pick?" is
  // worth more on a phone than "Claude needs your permission".
  const message = String(payload.message || '').slice(0, 400) || null
  const next = event === 'Notification' ? notificationState(entry, message) : HOOK_STATE[event]
  if (next === 'gone') {
    setState(entry, 'gone')
    entry.goneAt = Date.now()
  } else if (next) {
    // A turn that is moving again is not standing at a question, whatever the
    // last `PreToolUse` said.
    if (next !== 'waiting') clearQuestion(entry)
    setState(entry, next, { prompt: next === 'waiting' ? entry.question?.summary || message : null })
  }
  // The transcript is usually already on disk by the time the hook fires, so a
  // reader gets the last turn without waiting for the watcher to notice.
  if (entry.opens > 0) drain(entry)
  else refreshPreview(entry)

  // After the drain, so the question lands at the end of the conversation
  // rather than behind whatever the same hook brought with it — and after
  // `refreshPreview`, which reads its line off the transcript and does not
  // know about a question that is not in there yet.
  if (entry.question) {
    const stored = syncQuestion(entry)
    if (stored && entry.opens > 0) {
      emit({ kind: 'blocks', id: entry.id, blocks: [publicBlock(stored)], cursor: entry.seq })
    }
    entry.preview = describe(entry.question)
    setState(entry, 'waiting', { prompt: entry.question.summary })
  }
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
    sweep()
    // Trailing the scan rather than inside it: this one shells out, and a slow
    // tmux server must not hold up the state machine behind it.
    void resurvey()
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

  sweep()
  void resurvey()
  log.info("agent control is on — phones can read and answer this desktop's coding agents")
}

/** Stop watching and forget what was seen: a transcript held open is a read. */
function unwatch() {
  clearInterval(scanTimer)
  clearInterval(pollTimer)
  scanTimer = null
  pollTimer = null
  for (const entry of sessions.values()) closeTail(entry)
  sessions.clear()
  backgrounds.clear()
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
  emit({ kind: 'control', enabled: next, adapters: detected(), write: next ? writer.best() : null })
  return summary()
}

/* ── what the panel and the CLI read ───────────────────────────────────── */

/** Which agents are installed on this desktop — re-exported for the CLI. */
export { detected }

/**
 * The order both roads out of here agree on: whoever is stuck first, then
 * whoever moved last. The panel and the CLI read the status file and the phone
 * asks `agents.list`, and a desktop that put the blocked agent at the top of
 * one list and in the middle of the other was describing the same six sessions
 * two different ways.
 */
const byUrgency = (a, b) => {
  if ((a.state === 'waiting') !== (b.state === 'waiting')) return a.state === 'waiting' ? -1 : 1
  return b.lastActivity - a.lastActivity
}

export function summary() {
  const list = [...sessions.values()].filter((e) => e.state !== 'gone').sort(byUrgency)
  return {
    enabled: enabled(),
    adapters: detected(),
    // Which road this desktop has to a terminal at all — `null` means it can
    // only ever read, and the panel says so rather than offering a send.
    write: enabled() ? writer.best() : null,
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
      // The best road this desktop has; a session says which one it is on.
      // Stage four's `spawn` is still the flag it has always been.
      write: enabled() ? writer.best() : null,
      keys: writer.KEY_NAMES,
      // Two things a phone can only offer if the desktop understands the call
      // behind it, so they are published rather than assumed: handing an agent
      // a picture, and picking an answer off a numbered list.
      attach: true,
      answer: true,
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
    async 'agents.list'() {
      requireEnabled()
      sweep()
      // Awaited here, unlike on the timer: a pull-to-refresh that came back
      // with a stale composer would be the one moment the answer mattered.
      await resurvey()
      // A blocked agent is the reason anyone opened this screen.
      const list = [...sessions.values()].filter((e) => e.state !== 'gone').sort(byUrgency)
      return { sessions: list.map(publicSession), ...this['agents.capabilities']() }
    },

    'agents.capabilities'() {
      return {
        adapters: detected(),
        write: enabled() ? writer.best() : null,
        keys: writer.KEY_NAMES,
        attach: true,
        answer: true,
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

    /* ── answering ─────────────────────────────────────────────────────── */

    /**
     * Type a message into the agent, and by default press Return.
     *
     * This is arbitrary code execution and the daemon does not pretend
     * otherwise: the agent will run what it is told to run. The gate is the
     * same switch that granted reading, which is stated in what
     * `agent enable` prints and in `PROTOCOL.md`.
     */
    async 'agents.send'({ id, text = '', submit = true } = {}) {
      requireEnabled()
      const entry = liveSession(id)
      const body = String(text ?? '')
      if (body.length > MAX_SEND) throw new Error('that is too much text to type at once')
      if (!body.trim() && !submit) throw new Error('nothing to send')
      await ensureWritable(entry)

      const result = await writer.serialise(entry, () => writer.send(entry, body, { submit: submit !== false }))
      // A hook-backed session hears about this from the agent itself a moment
      // later. A scanned one never would, and a composer that leaves the row
      // sitting at `waiting` after a successful answer reads as a failed send.
      if (entry.state !== 'working') setState(entry, 'working')
      return { ok: true, ...result }
    },

    /**
     * Hand the agent a picture.
     *
     * An agent reads an image the way it reads a file, so this is `send` with
     * the paths in front of the message: the bytes arrived over `/api/upload`
     * and landed in the drop directory, and what gets typed is where they are.
     * Sending the path rather than the picture is not a shortcut — it is the
     * only road there is, because a terminal carries text and nothing else.
     *
     * The paths are checked against the drop directory rather than trusted.
     * This method types what it is handed into a shell's neighbourhood, so a
     * phone naming `~/.ssh/id_ed25519` must get a refusal and not a paste.
     */
    async 'agents.attach'({ id, paths = [], text = '', submit = true } = {}) {
      requireEnabled()
      const entry = liveSession(id)
      const files = (Array.isArray(paths) ? paths : [paths]).map(String).filter(Boolean)
      if (!files.length) throw new Error('nothing to attach')
      if (files.length > MAX_ATTACH) throw new Error(`that is more than ${MAX_ATTACH} pictures at once`)
      for (const file of files) {
        if (!drops.holds(file)) throw new Error('that file is not one this phone handed over')
      }
      // Paths first and the message under them: the agent has to know what it
      // is looking at before it reads the question about it, and a path on its
      // own line survives a caption that happens to start with a slash.
      const body = [files.join(' '), String(text ?? '').trim()].filter(Boolean).join('\n')
      if (body.length > MAX_SEND) throw new Error('that is too much text to type at once')
      await ensureWritable(entry)

      const result = await writer.serialise(entry, () => writer.send(entry, body, { submit: submit !== false }))
      if (entry.state !== 'working') setState(entry, 'working')
      return { ok: true, paths: files, ...result }
    },

    /**
     * Answer a multiple-choice question by picking off the list.
     *
     * The transcript carries the options and the terminal draws the same list
     * in the same order, so the option's position *is* the keystroke that
     * chooses it — which is the whole reason this can work from a phone with no
     * keyboard. Validating against the block rather than forwarding a digit is
     * what keeps a stale screen from answering the wrong question: a number
     * that does not name an option on the block the phone is looking at is a
     * refusal, not a keypress.
     *
     * One question at a time, in the order the terminal asks them. A
     * single-choice list is answered by the digit alone — it picks and moves on
     * in one press. A multi-select only toggles: the digits tick the boxes and
     * nothing has been said yet, so the answer walks the tabs along with Right
     * — onto the next question, or onto the submit tab when this was the last
     * one, where Return sends. Return on the checkbox screen would toggle
     * whatever row is highlighted instead, which is how a phone used to add an
     * option nobody picked.
     */
    async 'agents.answer'({ id, seq, question = 0, choices = [] } = {}) {
      requireEnabled()
      const entry = liveSession(id)
      const block = entry.blocks.find((b) => b.seq === Number(seq))
      if (!block || block.kind !== 'question') throw new Error('that block is not a question')
      const index = Number(question) || 0
      const asked = block.questions?.[index]
      if (!asked) throw new Error('that question is not on this block')

      const picked = [...new Set((Array.isArray(choices) ? choices : [choices]).map(Number))]
      if (!picked.length) throw new Error('nothing was chosen')
      if (!asked.multiSelect && picked.length > 1) throw new Error('that question takes one answer')
      for (const n of picked) {
        if (!Number.isInteger(n) || n < 1 || n > asked.options.length) throw new Error(`there is no option ${n}`)
      }
      await ensureWritable(entry)

      const keys = picked.map(String)
      if (asked.multiSelect) {
        keys.push('Right')
        if (index === block.questions.length - 1) keys.push('Enter')
      }
      const result = await writer.serialise(entry, () => writer.chord(entry, keys, { gap: ANSWER_GAP_MS }))
      if (entry.state === 'waiting') setState(entry, 'working')
      return { ok: true, labels: picked.map((n) => asked.options[n - 1].label), ...result }
    },

    /**
     * One named key. This is what makes answering a permission prompt from a
     * phone possible without a keyboard: `Escape` interrupts, a digit picks a
     * numbered option, `Enter` accepts the highlighted one.
     */
    async 'agents.key'({ id, key } = {}) {
      requireEnabled()
      const entry = liveSession(id)
      await ensureWritable(entry)
      const result = await writer.serialise(entry, () => writer.press(entry, String(key ?? '')))
      if (entry.state === 'waiting') setState(entry, 'working')
      return { ok: true, ...result }
    },

    /**
     * The terminal as it actually looks.
     *
     * The transcript is the better read for a conversation, but a permission
     * prompt is drawn on screen and never written to disk — so the options a
     * phone is about to answer exist only here. tmux only: nothing else on
     * this desktop can hand over somebody else's screen.
     */
    async 'agents.screen'({ id, lines = 60 } = {}) {
      requireEnabled()
      const entry = liveSession(id)
      await resurvey([entry])
      return { id: entry.id, pane: entry.pane, screen: await writer.screen(entry, lines) }
    },
  },
}
