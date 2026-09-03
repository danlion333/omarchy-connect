import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { loadConfig, updateConfig } from '../lib/config.js'
import { has, run, spawnDetached } from '../lib/exec.js'
import { log } from '../lib/log.js'
import { ADAPTERS, detected } from '../agents/index.js'
import * as hooks from '../agents/hooks.js'
import * as writer from '../agents/writer.js'
import * as drops from '../agents/drops.js'
import * as skills from '../agents/skills.js'
import * as limits from '../agents/limits.js'
import * as jobs from '../agents/jobs.js'
import * as tasks from '../agents/tasks.js'
import * as tmux from '../agents/tmux.js'
import * as herdr from '../agents/herdr.js'
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
/**
 * How often the pane is read while an agent is writing and a phone is reading.
 *
 * Fast enough to look like typing and slow enough to be free: it costs one
 * socket round trip to herdr, or one `capture-pane`, and only for a session
 * that is open on somebody's phone *and* mid-answer. A desktop with nothing
 * being read does none of them.
 */
const DRAFT_MS = 400
/**
 * How often the account service is asked what the plan has left.
 *
 * The percentages move with every turn of every session, and the two unscoped
 * windows already ride in free on the status line between probes — so this
 * only has to be often enough that a per-model row is never visibly behind.
 * Five minutes is well inside that, and is one request from a desktop with a
 * phone actually watching; a desktop with nobody subscribed asks nothing.
 */
const LIMITS_MS = 5 * 60 * 1000
/** Rows of pane to read for a draft. A paragraph in flight is never taller. */
const DRAFT_LINES = 40
/** A scan-discovered session whose transcript moved this recently is working. */
const ACTIVE_MS = 20_000
/**
 * How old a process with no transcript has to be before it is worth a row.
 *
 * A normal launch writes its first line within a couple of seconds, and the
 * hook announces it sooner than that. What stays past this grace is an agent
 * standing at a screen it cannot get past on its own — the folder-trust
 * prompt, most often — which is exactly the kind of stuck the phone exists
 * for, and it used to be the one kind that was invisible: no transcript, no
 * hook (an untrusted folder runs none), nothing to pair. It was also *stuck*,
 * and the person on the sofa was told "nothing running".
 */
const STARTING_GRACE_MS = 12_000
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
let draftTimer = null
let limitsTimer = null

const enabled = () => loadConfig().agents?.enabled === true
const spawnAllowed = () => loadConfig().agents?.spawn === true

// The HTTP side asks the same question: a phone may only drop a picture where
// an agent can read it while agents are something this desktop does at all.
export { enabled as agentsEnabled }

const requireEnabled = () => {
  if (!enabled()) throw new Error('agent control is off — run `omarchy-connect agent enable` on the desktop')
}

/* ── the session as the phone sees it ──────────────────────────────────── */

/**
 * Which background agents this desktop is running, remembered between scans.
 *
 * Refreshed by the sweep rather than by whoever is drawing a row: reading it
 * is a directory walk and a handful of small files, and every session frame
 * that leaves the daemon wants the answer. A map that is eight seconds stale
 * is the right trade for one that is rebuilt forty times a second.
 */
let jobMap = new Map()

/** The jobs as of the last sweep, so the map and the event share one walk. */
let jobList = []

const refreshJobs = () => {
  try {
    jobList = jobs.available() ? jobs.list() : []
    const map = new Map()
    for (const job of jobList) {
      // The resumed id last so that it wins: when a job carries both, the
      // resumed conversation is the file it is actually writing to.
      map.set(job.sessionId, job)
      if (job.resumedFrom) map.set(job.resumedFrom, job)
    }
    jobMap = map
  } catch {
    // A jobs directory being written under us is not worth a log line; the
    // sessions simply lose their job badge until the next sweep.
  }
}

/** The native session id inside `claude:1234-…`, which is what a job knows it by. */
const nativeIdOf = (entry) => entry.id.slice(entry.agent.length + 1)

/**
 * The status line for a session, if its adapter keeps one.
 *
 * Guarded rather than trusted: this reads and parses somebody else's file
 * format on a path that every session frame goes through, and a malformed
 * transcript must cost a meter rather than the list it was on.
 */
function vitalsOf(entry) {
  try {
    return entry.adapter.vitals?.(entry.transcript, entry.cwd) ?? null
  } catch {
    return null
  }
}

const publicSession = (entry) => {
  const vitals = vitalsOf(entry)
  const job = jobMap.get(nativeIdOf(entry)) || null
  return {
    id: entry.id,
    agent: entry.agent,
    // The CLI writes a title for its own conversations once it has read enough
    // of one to name it, and "Телефон не під'єднується до Bluetooth" beats the
    // directory's basename on a list where every row is the same project.
    title: vitals?.title || entry.title,
    // Kept beside it because the title is now a sentence: which project a
    // session is in stops being obvious the moment it stops being the title.
    project: entry.title,
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
    // How many subagents it has out. The transcript hides their traffic, so
    // this number is the only sign of a fan-out the phone ever gets.
    subagents: entry.subagents || 0,
    // Model, context, permission mode, branch — the desktop's own status line,
    // read off the transcript rather than asked of the session.
    vitals,
    // What it is working through. An agent at work produces a lot of traffic
    // and very little news; this is the sentence it wrote about the work
    // rather than about the tool it happened to reach for.
    tasks: tasks.summary(nativeIdOf(entry)),
    // The background agent behind this conversation, when there is one. This
    // is the only place a `--bg` session says what it thinks it is doing:
    // nothing is on screen for it anywhere on the desktop.
    job: job
      ? {
          id: job.id,
          name: job.name,
          detail: job.detail,
          state: job.state,
          live: job.live,
          tokens: job.tokens,
          updatedAt: job.updatedAt,
        }
      : null,
  }
}

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
  // Nothing is being written any more, so nothing half-written is true.
  if (state !== 'working') clearDraft(entry)
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
    // Which herdr server that pane belongs to, when the pane is herdr's. A
    // desktop may be running several — a default session and a named one —
    // and a pane id means nothing without the socket it was minted on.
    socket: null,
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
    // Subagents out right now, counted off their own lifecycle hooks.
    subagents: 0,
    goneAt: null,
    // The status line as the phone last saw it, so a scan can tell whether it
    // has anything to say. `undefined` until the first scan looks.
    stamp: undefined,
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
    // The unfinished sentence as the phone last saw it, the one it has already
    // been shown and must not be shown again, and a read in flight.
    draft: '',
    draftHeld: '',
    drafting: false,
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
  // The file caught up. Whatever the screen was showing, this is the record.
  if (fresh.length) clearDraft(entry, { hold: true })
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

/* ── the sentence being written right now ──────────────────────────────── */

/**
 * Reading the pane while the file is still holding its breath.
 *
 * A transcript is the honest record and it is also a late one: Claude Code
 * writes an assistant entry only once the message is complete, so a phone
 * tailing the file sits through the whole answer and then receives it whole.
 * On the desktop the same answer arrives a word at a time, because the words
 * are being drawn as they come off the wire — and the pane is the only place
 * they exist until the file catches up.
 *
 * So while an agent is answering and somebody is reading it, the pane is read
 * beside the file and what the adapter finds there is sent as a draft. It is
 * marked as one all the way to the screen and it lives about a second: the
 * moment the transcript delivers the real block the draft is dropped, and what
 * the reader is left with is the parsed, canonical thing rather than a
 * screenshot of a terminal.
 *
 * The conditions are the whole design. A draft is only taken for a session
 * that a phone has open, that is `working`, and that lives in a multiplexer
 * pane — the compositor road has no screen to read. So a desktop nobody is
 * watching pays nothing, and a session the daemon cannot see the terminal of
 * behaves exactly as it did before: the conversation arrives a message at a
 * time, which is late but never wrong.
 */
const draftable = (entry) =>
  entry.opens > 0 &&
  entry.state === 'working' &&
  typeof entry.adapter?.draft === 'function' &&
  writer.isPane(entry.writable) &&
  Boolean(entry.pane)

/**
 * Take the draft off the screen and send what is new about it.
 *
 * A growing paragraph is almost always the last one plus a few more words, so
 * the common case goes down the wire as those words rather than as the
 * paragraph — the phone is on somebody's data plan and this fires twice a
 * second. A rewrap breaks the prefix and costs one full send, which is what
 * the fallback is for.
 */
async function pumpDraft(entry) {
  if (entry.drafting) return
  entry.drafting = true
  try {
    const screen = await writer.screen(entry, DRAFT_LINES)
    // A pane read is not instant and a turn can end inside one.
    if (!draftable(entry)) return
    const text = entry.adapter.draft(screen) || ''
    if (!text || text === entry.draft) return
    // The words the file has already delivered, still sitting on the screen
    // where they were drawn. Sending them again would double the message.
    if (entry.draftHeld && text.startsWith(entry.draftHeld)) return
    const grew = entry.draft && text.startsWith(entry.draft)
    emit(grew ? { kind: 'draft', id: entry.id, append: text.slice(entry.draft.length) } : { kind: 'draft', id: entry.id, text })
    entry.draft = text
  } catch {
    // The pane closed, the server went away, tmux was slow. None of it is
    // news: the transcript is still carrying the conversation.
  } finally {
    entry.drafting = false
  }
}

/**
 * Drop the draft, because the real thing has arrived — or because there is no
 * longer a turn for it to belong to.
 *
 * `hold` is what stops the same words coming straight back: the pane goes on
 * showing a finished message for as long as it is on screen, and the next read
 * would find it there and send it a second time, under the block the file just
 * delivered.
 */
function clearDraft(entry, { hold = false } = {}) {
  entry.draftHeld = hold ? entry.draft || entry.draftHeld : ''
  if (!entry.draft) return
  entry.draft = ''
  if (entry.opens > 0) emit({ kind: 'draft', id: entry.id, text: '' })
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
  entry.draft = ''
  entry.draftHeld = ''
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
 * What a transcript says about itself — which kind of session wrote it, and
 * when it last had a turn in it — remembered per file.
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
const recencies = new Map()

/** A desktop has nothing like this many live agents; past it, start again. */
const RECENCY_CACHE_MAX = 512

const recencyOf = (adapter) => (transcript) => {
  if (!adapter.recency) return null
  const cached = recencies.get(transcript.path)
  if (cached && cached.at === transcript.mtime) return cached.value
  if (recencies.size >= RECENCY_CACHE_MAX) recencies.clear()
  const value = adapter.recency(transcript.path)
  recencies.set(transcript.path, { at: transcript.mtime, value })
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
    const pairs = pair(group, adapter.transcripts(cwd), {
      recency: recencyOf(adapter),
    })
    for (const { proc, transcript, activeAt } of pairs) {
      const id = `${adapter.id}:${transcript.id}`
      seen.add(id)
      // The placeholder this process may have worn while it had no transcript
      // — it has one now, and two rows for one agent is one too many.
      const ghost = sessions.get(`${adapter.id}:pid-${proc.pid}`)
      if (ghost) forget(ghost)
      const { entry, created } = upsert({
        id,
        agent: adapter.id,
        adapter,
        cwd,
        pid: proc.pid,
        transcript: transcript.path,
        // When the conversation last moved, not when the file did. The CLI
        // appends untimestamped bookkeeping to transcripts nobody is talking
        // in any more, so a session idle since lunchtime was reaching the
        // phone as forty minutes old — which is exactly the number somebody
        // reads to decide whether the thing on screen is still theirs.
        lastActivity: activeAt,
        via: 'scan',
      })
      if (entry.via === 'scan') {
        setState(entry, Date.now() - activeAt < ACTIVE_MS ? 'working' : 'idle')
        entry.lastActivity = Math.max(entry.lastActivity, activeAt)
      }
      refreshPreview(entry)
      if (created) {
        log.debug(`agent session discovered: ${id} in ${cwd}`)
        emitSession(entry)
      } else if (restamp(entry)) {
        // The status line moved. `state` frames carry only the state, so
        // without this the model, the context meter and the task list would
        // sit unchanged on the phone from the moment a session was announced
        // until the next hook fired — which for an agent working through
        // something long is the whole of the interesting part.
        emitSession(entry)
      }
    }

    // The processes the pairing could not place. Young ones are agents still
    // starting up and stay invisible, as ever; old ones are agents stuck at a
    // screen they wrote nothing about — the trust prompt — and get a row with
    // no transcript behind it, so the phone can at least see them and, when
    // the terminal is reachable, press the key they are stuck on.
    const matched = new Set(pairs.map((p) => p.proc.pid))
    for (const proc of group) {
      if (matched.has(proc.pid)) continue
      if (!proc.startedAt || Date.now() - proc.startedAt < STARTING_GRACE_MS) continue
      const id = `${adapter.id}:pid-${proc.pid}`
      // A real session already owns this process — a hook got there first, or
      // its transcript lives in a directory the process has since left.
      const real = [...sessions.values()].some((e) => e.id !== id && e.pid === proc.pid && e.state !== 'gone')
      if (real) {
        const ghost = sessions.get(id)
        if (ghost) forget(ghost)
        continue
      }
      seen.add(id)
      const { entry, created } = upsert({
        id,
        agent: adapter.id,
        adapter,
        cwd,
        pid: proc.pid,
        transcript: null,
        state: 'starting',
        startedAt: proc.startedAt,
        lastActivity: proc.startedAt,
        via: 'scan',
      })
      if (!entry.preview) entry.preview = 'started, but nothing on disk yet — likely stuck at a first-run prompt'
      if (created) {
        log.debug(`agent process without a transcript: ${id} in ${cwd}`)
        emitSession(entry)
      }
    }
  }
  return seen
}

/**
 * Has anything on this session's status line changed since the last scan?
 *
 * A fingerprint rather than a deep compare because the answer has to be cheap:
 * this is asked of every session on every sweep. It covers exactly the fields
 * a `state` frame does not carry — everything the phone would otherwise be
 * drawing from a snapshot taken minutes ago.
 *
 * Nothing here reads a file that has not changed: both `vitals` and the task
 * summary are remembered against an mtime, so a session sitting still costs
 * two `stat` calls and no more.
 */
function restamp(entry) {
  const vitals = vitalsOf(entry)
  const todo = tasks.summary(nativeIdOf(entry))
  const job = jobMap.get(nativeIdOf(entry)) || null
  const print = [
    vitals?.model,
    vitals?.mode,
    vitals?.branch,
    vitals?.title,
    vitals?.context?.tokens,
    todo?.total,
    todo?.done,
    todo?.active,
    job?.detail,
    job?.state,
    entry.subagents || 0,
  ].join('\u0000')
  if (entry.stamp === print) return false
  // The first scan of a session that was announced by a hook is not a change:
  // the frame it was announced with already carried all of this.
  const first = entry.stamp === undefined
  entry.stamp = print
  return !first
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
  refreshJobs()
  announceLimits()
  announceJobs()
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
        : 'this desktop has no way to type into a terminal — install tmux or herdr, or wtype for the fallback',
    )
  }
  return entry
}

/* ── discovery: hooks ──────────────────────────────────────────────────── */

/**
 * The one line of a tool's input worth putting beside "needs your permission".
 * The command for a shell, the path for an edit — the argument the person at
 * the prompt would read before pressing 1.
 */
function permissionSubject(input) {
  const raw = input && typeof input === 'object' ? input : {}
  for (const key of ['command', 'file_path', 'path', 'url', 'pattern', 'description']) {
    if (typeof raw[key] === 'string' && raw[key].trim()) {
      const text = raw[key].replace(/\s+/g, ' ').trim()
      return text.length > 120 ? `${text.slice(0, 119)}…` : text
    }
  }
  return ''
}

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
  // One firing per batch of tool calls. This is what tells a session apart
  // from its own past: a `waiting` answered at the keyboard used to sit on the
  // phone as `waiting` until the whole turn ended, because nothing between the
  // answer and the `Stop` said a word.
  PostToolBatch: 'working',
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

/** The notification types that mean a person could do something right now. */
const WAITING_NOTIFICATIONS = new Set([
  'permission_prompt',
  'agent_needs_input',
  'elicitation_dialog',
  'elicitation_url_dialog',
])

/**
 * What a `Notification` actually means for this session.
 *
 * The payload names its own kind these days — `notification_type` — and the
 * name is believed before the sentence: matching the English message was how
 * an auth success or a quota reset could put a "needs you" badge on an agent
 * that needed nothing. A question already on the books outranks `idle_prompt`
 * either way: the idle timer keeps running while a prompt is on screen, so the
 * "waiting for your input" line can arrive on top of a real question, and
 * dropping to `idle` there would take a card the phone can answer off the
 * screen. An unknown type is news, not state — it changes nothing.
 */
function notificationState(entry, payload, message) {
  const type = String(payload.notification_type || '')
  if (type) {
    if (WAITING_NOTIFICATIONS.has(type)) return 'waiting'
    if (type === 'idle_prompt') return entry.question ? 'waiting' : 'idle'
    return null
  }
  return IDLE_NOTIFICATION.test(message || '') && !entry.question ? 'idle' : 'waiting'
}

/**
 * A lifecycle event straight from the agent. This is the authoritative road:
 * the payload names the transcript, and the environment the hook inherited
 * names the process and the pane it is running in.
 */
export function hook(payload = {}) {
  if (!enabled()) return { ok: false, error: 'agents disabled' }
  const event = String(payload.hook_event_name || payload.event || '')

  // The status-line bridge. Not a lifecycle event: it says what the account
  // and the session are spending, fresh off the latest API response, and it
  // fires far too often to be allowed anywhere near the state machine.
  if (event === 'StatusLine') {
    if (limits.absorb(payload.rate_limits)) announceLimits()
    return { ok: true }
  }

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
  } else if (event === 'PermissionRequest') {
    // A permission prompt, the moment it exists. `Notification` says the same
    // thing six seconds later — an idle threshold the CLI waits out before it
    // speaks — and those seconds were the difference between a phone that
    // buzzes while you still remember what you asked for and one that is
    // always a beat behind the desktop. In a mode that answers its own
    // prompts nothing is on screen and there is nothing to say.
    if (payload.permission_mode !== 'bypassPermissions') {
      const tool = String(payload.tool_name || '').trim()
      const what = permissionSubject(payload.tool_input)
      const prompt = [tool || 'a tool', 'needs your permission'].join(' ') + (what ? `: ${what}` : '')
      entry.preview = prompt
      setState(entry, 'waiting', { prompt })
    }
  } else if (event === 'SubagentStart' || event === 'SubagentStop') {
    // How many pairs of hands the session has out right now. The transcript
    // hides sidechain traffic on purpose, so without this a session that
    // fanned five agents out reads as one agent sitting quietly.
    entry.subagents = Math.max(0, (entry.subagents || 0) + (event === 'SubagentStart' ? 1 : -1))
    entry.lastActivity = Date.now()
    if (event === 'SubagentStart' && entry.state !== 'waiting') setState(entry, 'working')
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
  const next = event === 'Notification' ? notificationState(entry, payload, message) : HOOK_STATE[event]
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

  // The pane, beside the file, for the seconds when the file has nothing to
  // say and the terminal has everything. Its own timer rather than a division
  // of the poll above: they are watching two different things at two very
  // different speeds, and a read of somebody's screen must never be the reason
  // a transcript is tailed five times a second.
  draftTimer = setInterval(() => {
    if (!bus?.hasSubscribers('agent')) return
    for (const entry of sessions.values()) {
      if (draftable(entry)) void pumpDraft(entry)
    }
  }, DRAFT_MS)
  draftTimer.unref?.()

  // Its own timer for the same reason the draft has one: it is watching
  // something else entirely, at a pace measured in minutes rather than
  // frames, and it leaves the wire alone when nobody is listening.
  limitsTimer = setInterval(() => {
    if (!bus?.hasSubscribers('agent')) return
    void limits.probe().then(announceLimits)
  }, LIMITS_MS)
  limitsTimer.unref?.()

  sweep()
  void resurvey()
  // Asked once on the way up, so the first phone to look sees today's numbers
  // rather than whatever the config cache was left holding.
  void limits.probe({ force: true }).then(announceLimits)
  log.info("agent control is on — phones can read and answer this desktop's coding agents")
}

/** Stop watching and forget what was seen: a transcript held open is a read. */
function unwatch() {
  clearInterval(scanTimer)
  clearInterval(pollTimer)
  clearInterval(draftTimer)
  clearInterval(limitsTimer)
  scanTimer = null
  pollTimer = null
  draftTimer = null
  limitsTimer = null
  for (const entry of sessions.values()) closeTail(entry)
  sessions.clear()
  recencies.clear()
  jobList = []
  // The fingerprints are what stop an event per sweep; they must not also stop
  // the *first* one after the feature comes back on.
  jobsPrint = ''
  limitsPrint = ''
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
    // The panel and the CLI draw the same status line the phone does.
    limits: enabled() ? limits.read() : null,
    // Only the jobs something is actually running: the directory behind this
    // is a history, and a count that included finished jobs read as agents
    // still out working.
    jobs: enabled() && jobs.available() ? jobs.list().filter((job) => job.live).length : 0,
  }
}

/* ── starting one ──────────────────────────────────────────────────────── */

/** A prompt sent along with a new agent — the same ceiling as any other send. */
const MAX_PROMPT = MAX_SEND
/** `claude --bg` returns as soon as the job is registered, but not instantly. */
const SPAWN_TIMEOUT_MS = 30_000

const requireSpawn = () => {
  if (!spawnAllowed()) {
    throw new Error('starting agents from a phone is off — run `omarchy-connect agent spawn on` on the desktop')
  }
}

/**
 * A working directory that exists.
 *
 * The phone names one and the daemon starts a shell in it, so it is resolved
 * and checked rather than passed through. There is deliberately no allow-list
 * of directories: a phone that may type into an agent may already `cd`
 * anywhere, and pretending otherwise would be a fence with no field behind it.
 */
function checkedDir(cwd) {
  const dir = path.resolve(String(cwd || os.homedir()))
  let stat
  try {
    stat = fs.statSync(dir)
  } catch {
    throw new Error('no such directory on that desktop')
  }
  if (!stat.isDirectory()) throw new Error('that is a file, not a directory')
  return dir
}

/**
 * A conversation this desktop actually has, in the directory it was had in.
 *
 * Checked against the transcripts on disk rather than against a pattern: the
 * id becomes an argument to a command, and "it looks like a uuid" is a weaker
 * promise than "it is one of the files we listed".
 */
function checkedResume(adapter, cwd, id) {
  const wanted = String(id || '').trim()
  if (!wanted) return null
  const found = adapter.transcripts(cwd).find((t) => t.id === wanted)
  if (!found) throw new Error('that desktop has no such conversation in this directory')
  return wanted
}

/**
 * The command line an agent is started with, on either road.
 *
 * One function because there is one rule, and it was previously kept in only
 * one of the two places that needed it: the prompt goes after `--`. A prompt
 * is arbitrary text typed on a phone, and text typed on a phone begins with a
 * dash often enough to matter — "-p is a flag, right?", a pasted diff, a line
 * lifted out of a man page. Handed straight after `--bg`, such a prompt is
 * read by the CLI's own parser as options: at best an unknown-flag error, at
 * worst a flag the user never asked for, chosen by whoever typed the message.
 * After `--` it is what it always was, a sentence.
 *
 * The flags themselves — `--resume`, `--name`, `--bg` — are this daemon's own
 * words and stay in front of the fence, where they are still parsed.
 */
export function agentCommand({ args = [], prompt = '', background = false } = {}) {
  const flags = background ? [...args, '--bg'] : [...args]
  return prompt ? [...flags, '--', prompt] : flags
}

/**
 * Start an agent, and say which road it went down.
 *
 * Two roads, and they are not variations on each other:
 *
 *   - **In a pane.** `tmux new-session -d` puts the agent in a terminal that
 *     exists but that nobody is looking at, which is exactly the shape the
 *     writer wants: the phone can type into it from the first second, and
 *     whoever is at the desktop can attach to it later. This is the default,
 *     and it needs a multiplexer — without one there is no terminal for a new
 *     agent to be born into that a phone could ever reach. herdr does the
 *     same job with a workspace nobody is looking at, and is asked second
 *     only because it also has to be *running*: tmux starts a server on
 *     demand, and herdr's is a thing the person at the desktop keeps.
 *   - **In the background.** `claude --bg` detaches outright: no terminal, no
 *     pane, no way to type into it ever. What it gets instead is a job the CLI
 *     tracks, which is what makes an agent worth starting from a phone you are
 *     about to put in your pocket — you describe the work once and read the
 *     answer later.
 */
async function startAgent({ adapter, cwd, resume = null, prompt = '', background = false, name = null }) {
  const bin = adapter.binaries[0]
  if (!has(bin)) throw new Error(`${bin} is not on this desktop's PATH`)

  const args = []
  if (resume) args.push('--resume', resume)
  // The CLI's own name for the session, which is what its `/resume` picker and
  // the terminal title show. Worth setting: a session started from a phone is
  // one nobody will recognise on the desktop otherwise.
  if (name) args.push('--name', String(name).slice(0, 60))

  if (background) {
    if (!prompt) throw new Error('a background agent needs something to work on')
    const res = await run(bin, agentCommand({ args, prompt, background: true }), { cwd, timeout: SPAWN_TIMEOUT_MS })
    if (!res.ok) throw new Error(res.stderr || `${bin} --bg failed`)
    return { via: 'background', output: res.stdout.slice(0, 400) }
  }

  const command = agentCommand({ args, prompt })

  if (tmux.available()) {
    const session = await tmux.freeSessionName()
    // `--` a second time, this time so tmux hands the rest over verbatim.
    const res = await run('tmux', ['new-session', '-d', '-s', session, '-c', cwd, '--', bin, ...command], {
      timeout: SPAWN_TIMEOUT_MS,
    })
    if (!res.ok) throw new Error(res.stderr || 'tmux could not start that session')
    return { via: 'tmux', session }
  }

  // A workspace of its own on a herdr server that is already up. The arguments
  // are handed over as an array rather than as a command line, which matters
  // more here than anywhere else in this file: a prompt from a phone is
  // arbitrary text, and arbitrary text spliced into a shell command is how a
  // chat box becomes a shell. `agent.start` also waits until herdr has seen
  // the agent come up, so a launch that fails says so instead of leaving a
  // session that never appears.
  const socket = herdr.available() ? await herdr.liveSocket() : null
  if (socket) {
    const started = await herdr.startAgent(socket, {
      kind: adapter.id,
      cwd,
      args: command,
      timeout: SPAWN_TIMEOUT_MS,
    })
    return { via: 'herdr', ...started }
  }

  throw new Error(
    herdr.available()
      ? 'this desktop has no tmux and no herdr server running, so a new agent would open in a terminal nothing can reach'
      : 'this desktop has no tmux, so a new agent would open in a terminal nothing can reach',
  )
}

/* ── what the desktop is spending ──────────────────────────────────────── */

/**
 * The plan's remaining headroom, and a nudge when it moves.
 *
 * `hello` carries the first answer and the phone would otherwise hold it until
 * it reconnected — which is hours, and the number this is about changes every
 * few minutes. The fingerprint is what stops that from being a message a
 * second: the file behind it is rewritten far more often than the percentages
 * in it actually change.
 */
let limitsPrint = ''

function announceLimits() {
  const value = limits.read()
  // Ageing counts as news: a row that has crossed into stale draws itself
  // differently on the phone, and nothing else would tell it.
  const print = value ? value.limits.map((l) => `${l.kind}:${l.percent}:${l.stale ? 'old' : ''}`).join(',') : ''
  if (print === limitsPrint) return
  limitsPrint = print
  emit({ kind: 'limits', limits: value })
}

/**
 * The background agents, and a nudge when one of them says something new.
 *
 * A detached agent has no terminal and nothing on the desktop draws it, so the
 * phone is the only screen it has — and a screen that only updates when you
 * pull it down is not a screen you would watch. The sentence a job writes
 * about itself changes every few seconds, which is exactly why the
 * fingerprint covers it: an event per change, and nothing at all while the
 * jobs sit still.
 */
let jobsPrint = ''

function announceJobs() {
  const print = jobList.map((job) => `${job.id}:${job.state}:${job.detail}:${job.tokens}`).join('|')
  if (print === jobsPrint) return
  jobsPrint = print
  emit({ kind: 'jobs', jobs: jobList })
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
      // The rest of the desktop's own status line, each published rather than
      // assumed for the same reason: an app that is a version ahead of the
      // daemon must draw what the daemon has, not what the app knows about.
      skills: true,
      history: true,
      commands: true,
      tasks: true,
      jobs: jobs.available(),
      limits: enabled() ? limits.read() : null,
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
      // The limits ride along for the same reason, and in parallel — they are
      // a network round trip and the survey is a local one, so serialising
      // them would spend the slower of the two twice.
      await Promise.all([resurvey(), limits.probe()])
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
        skills: true,
        history: true,
        commands: true,
        tasks: true,
        jobs: jobs.available(),
        limits: limits.read(),
      }
    },

    /**
     * Start reading one session: a snapshot now, then `agent` events as the
     * transcript grows. Only opened sessions are tailed — the same
     * reference-counted discipline the stats sampler uses.
     *
     * `since` is a cursor from an earlier open or `blocks` event, and it turns
     * this into a resume. A phone re-opens after every reconnect — the desktop
     * drops its subscriptions when the bus loses its last subscriber, so an
     * open session stops being tailed the moment the socket dies — and without
     * a cursor that would mean refetching the whole window, over a link that
     * has only just come back, to redraw a chat that has not changed. With one,
     * the answer is the handful of blocks the phone missed, and `resumed` says
     * so: the screen appends rather than replacing. A cursor the desktop can no
     * longer honour — the session was reloaded and its numbering restarted, or
     * the ring dropped the blocks in between — is not an error, it is a reload:
     * the full window comes back with `resumed: false`.
     */
    'agents.open'({ id, limit = 60, since = null } = {}) {
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

      // Asked after the drain, not before: the blocks that arrived while the
      // phone was away are exactly the ones a resume is for.
      const from = Number(since)
      const resumable =
        since !== null &&
        since !== undefined &&
        Number.isInteger(from) &&
        from >= 0 &&
        from <= entry.seq &&
        // Everything after the cursor still has to be in the ring, or the
        // resume would quietly skip whatever fell off the front of it.
        (!entry.blocks.length || entry.blocks[0].seq <= from + 1)

      if (resumable) {
        const missed = entry.blocks.filter((block) => block.seq > from)
        return {
          session: publicSession(entry),
          resumed: true,
          blocks: missed.slice(-count).map(publicBlock),
          cursor: entry.seq,
          truncated: missed.length > count,
        }
      }

      return {
        session: publicSession(entry),
        resumed: false,
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
     * phone is about to answer exist only here. A multiplexer only — tmux or
     * herdr: nothing else on this desktop owns somebody else's screen well
     * enough to hand it over.
     */
    async 'agents.screen'({ id, lines = 60 } = {}) {
      requireEnabled()
      const entry = liveSession(id)
      await resurvey([entry])
      return { id: entry.id, pane: entry.pane, screen: await writer.screen(entry, lines) }
    },

    /* ── the status line ───────────────────────────────────────────────── */

    /**
     * How much of the plan is left, and when the window turns over.
     *
     * Asked of the account service, because somebody asking this question is
     * asking about now — this is the phone's pull-to-refresh, and answering it
     * out of a cache is what the screen used to do wrong. `force` skips the
     * floor between probes for exactly that reason: an interval is there to
     * absorb a flurry, not to overrule a person who reached for the answer.
     * `null` is still a real answer: an account on no plan at all, or a
     * desktop that has never been told and cannot reach anyone to ask.
     */
    async 'agents.limits'() {
      requireEnabled()
      await limits.probe({ force: true })
      return { limits: limits.read() }
    },

    /**
     * The list this session is working through.
     *
     * Kept out of the session frame in full and summarised onto it, because
     * the summary is what tells six rows apart and the list is what you read
     * once you have picked one.
     */
    'agents.tasks'({ id } = {}) {
      requireEnabled()
      const entry = sessions.get(String(id))
      if (!entry) throw new Error('no such agent session')
      return { id: entry.id, ...(tasks.read(nativeIdOf(entry)) || { tasks: [], total: 0, done: 0, active: null }) }
    },

    /* ── skills and commands ───────────────────────────────────────────── */

    /**
     * Everything this desktop's agent answers to by name.
     *
     * The point of putting this on a phone is that a slash command's name is
     * short and what it does is long: nobody types `/security-review` with a
     * thumb, and nobody remembers which of thirty skills is the one that
     * drives the phone over adb. Read off the same directories the CLI reads,
     * for the session's own working directory, so a project's own skills are
     * in the list when that project's session is the one open.
     */
    'agents.skills'({ id = null, cwd = null } = {}) {
      requireEnabled()
      const entry = id ? sessions.get(String(id)) : null
      const where = entry?.cwd || (cwd ? String(cwd) : null)
      return { cwd: where, ...skills.list(where) }
    },

    /**
     * Run one of them.
     *
     * `send` could carry the same string, and the reason this exists beside it
     * is the check: the name is matched against the list this desktop just
     * published before it becomes a line of text in front of an agent. What
     * the phone offers and what the desktop will type are then the same set,
     * and a stale app cannot invent a command by asking for one.
     *
     * The arguments are not checked, and cannot be — an argument to a skill is
     * prose. They are the same prose `agents.send` already carries.
     */
    async 'agents.command'({ id, name, args = '', submit = true } = {}) {
      requireEnabled()
      const entry = liveSession(id)
      const wanted = String(name || '').trim()
      if (!skills.known(entry.cwd, wanted)) throw new Error('that desktop does not have a command by that name')
      const rest = String(args ?? '').trim()
      const body = `/${wanted}${rest ? ` ${rest}` : ''}`
      if (body.length > MAX_SEND) throw new Error('that is too much text to type at once')
      await ensureWritable(entry)

      const result = await writer.serialise(entry, () => writer.send(entry, body, { submit: submit !== false }))
      if (entry.state !== 'working') setState(entry, 'working')
      return { ok: true, command: body, ...result }
    },

    /* ── conversations that are not running ────────────────────────────── */

    /**
     * The conversations this desktop has had, whether or not one is open.
     *
     * The live list answers "what is running"; this answers "what did I have
     * open yesterday", which is the question behind every `--resume`. Both
     * halves are on disk already: the transcript is the conversation, and its
     * tail carries the working directory, the model and the title the CLI gave
     * it — so a picker that would otherwise need the CLI's interactive
     * `/resume` screen can be drawn from files instead.
     */
    'agents.history'({ cwd = null, limit = 25 } = {}) {
      requireEnabled()
      const count = Math.min(Math.max(Number(limit) || 25, 1), 60)
      const where = cwd ? String(cwd) : null
      const out = []
      for (const adapter of ADAPTERS) {
        if (!adapter.detect()) continue
        // Twice what is wanted, because some of them will turn out to be
        // sessions that started and said nothing. Listing them is a `readdir`
        // and a `stat`; *reading* them is not, so the loop below stops as soon
        // as it has enough rather than reading the lot.
        const found = where ? adapter.transcripts(where) : adapter.recent?.(count * 2) || []
        let taken = 0
        for (const transcript of found) {
          if (taken >= count) break
          const id = `${adapter.id}:${transcript.id}`
          const live = sessions.get(id)
          let vitals = null
          try {
            vitals = adapter.vitals?.(transcript.path, where) ?? null
          } catch {
            vitals = null
          }
          // A conversation that never had a turn in it is a session that
          // started and said nothing — the CLI leaves the file behind, and
          // resuming one restores nothing. It is not offered.
          if (!vitals?.context && !live) continue
          const job = jobMap.get(transcript.id) || null
          taken += 1
          out.push({
            id,
            agent: adapter.id,
            sessionId: transcript.id,
            cwd: vitals?.cwd || where,
            title: vitals?.title || (vitals?.cwd ? path.basename(vitals.cwd) : transcript.id.slice(0, 8)),
            model: vitals?.model || null,
            branch: vitals?.branch || null,
            context: vitals?.context || null,
            // The conversation's own clock. A transcript's mtime moves every
            // time the CLI writes a line of bookkeeping into it, which it goes
            // on doing for hours after the last thing anybody said — so a list
            // ordered by mtime puts finished conversations above the one that
            // was actually being had.
            at: vitals?.turnAt || transcript.mtime,
            size: transcript.size,
            // A conversation that is open right now is not one to resume; the
            // phone offers to walk into it instead.
            live: Boolean(live && live.state !== 'gone'),
            liveId: live && live.state !== 'gone' ? live.id : null,
            background: Boolean(job),
          })
        }
      }
      return { sessions: out.sort((a, b) => b.at - a.at).slice(0, count), spawn: spawnAllowed() }
    },

    /* ── background agents ─────────────────────────────────────────────── */

    /**
     * The agents running with nobody in front of them.
     *
     * A `--bg` session has no terminal, so nothing on the desktop is showing
     * it — no pane, no window, no bar. The CLI writes what it is doing into a
     * job directory, and that sentence is the whole value here: "exploring
     * project state for commit + merge flow" is worth more on a phone than any
     * amount of transcript.
     */
    'agents.jobs'({ all = false } = {}) {
      requireEnabled()
      // `all` reaches past what the sweep keeps, which is only what is current.
      if (all !== true) refreshJobs()
      const running = all === true ? jobs.list({ all: true }) : jobList
      return {
        jobs: running,
        // Which of them the phone can walk into: a job whose transcript this
        // daemon has a live session for is readable like any other.
        open: Object.fromEntries(
          running
            .map((job) => {
              const id = [...sessions.keys()].find(
                (key) => key.endsWith(`:${job.sessionId}`) || (job.resumedFrom && key.endsWith(`:${job.resumedFrom}`)),
              )
              return id && sessions.get(id)?.state !== 'gone' ? [job.id, id] : null
            })
            .filter(Boolean),
        ),
      }
    },

    /** One job, with the last few sentences it wrote about itself. */
    'agents.job'({ id } = {}) {
      requireEnabled()
      const job = jobs.detail(id)
      if (!job) throw new Error('no such background agent')
      return { job }
    },

    /* ── starting one ──────────────────────────────────────────────────── */

    /**
     * Start an agent from the phone — a fresh one, or one picked up again.
     *
     * Behind its own switch rather than the reading one. Reading an agent and
     * answering the one already open are things the person at the desktop
     * started; this starts a process that was not there before, and that is a
     * different sentence to say yes to.
     */
    async 'agents.spawn'({ cwd = null, resume = null, prompt = '', background = false, name = null } = {}) {
      requireEnabled()
      requireSpawn()
      const adapter = ADAPTERS.find((a) => a.detect())
      if (!adapter) throw new Error('this desktop has no coding agent installed')

      const body = String(prompt ?? '').trim()
      if (body.length > MAX_PROMPT) throw new Error('that is too much to send an agent off with')
      // Resuming names a conversation, and a conversation names its directory
      // — so the phone does not have to know one to ask for the other.
      let where = cwd ? checkedDir(cwd) : null
      if (resume && !where) {
        const found = adapter.recent?.(200)?.find((t) => t.id === String(resume)) || null
        const from = found ? adapter.vitals?.(found.path)?.cwd : null
        if (!from) throw new Error('that desktop has no such conversation')
        where = checkedDir(from)
      }
      where = where || checkedDir(null)
      const session = resume ? checkedResume(adapter, where, resume) : null

      const result = await startAgent({
        adapter,
        cwd: where,
        resume: session,
        prompt: body,
        background: background === true,
        name,
      })
      log.info(`agent started from a phone: ${result.via} in ${where}${session ? ` (resuming ${session})` : ''}`)
      // The scan is on an eight-second timer and the phone is waiting for a
      // row to appear; a sweep now is what makes the new session turn up in
      // the list this call's caller is about to refresh.
      refreshJobs()
      try {
        scan()
      } catch (err) {
        log.debug('post-spawn scan failed:', err.message)
      }
      void resurvey()
      return { ok: true, cwd: where, resumed: session, ...result }
    },
  },
}
