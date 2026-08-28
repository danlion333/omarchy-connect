// Reading a coding agent from a phone: the gate, the hooks, the tail.
//
// The whole feature is off by default and the transcripts it reads are the
// most sensitive thing on the desktop, so the first thing this asserts is that
// a paired phone gets nothing until someone says otherwise.
import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { connectPhone } from './phone.mjs'

const PORT = Number(process.env.PORT || 8802)
const base = `http://127.0.0.1:${PORT}`
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

// `HOME` moves the fake agent's transcripts aside as well as the config: this
// test writes into `~/.claude/projects`, and that is a directory the person
// running the suite very much cares about.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'omarchy-connect-agents-'))
const CWD = '/home/dan/Projects/example'
const SLUG = CWD.replace(/[^a-zA-Z0-9]/g, '-')
const SESSION = '11111111-2222-3333-4444-555555555555'
const projects = path.join(sandbox, '.claude', 'projects', SLUG)
fs.mkdirSync(projects, { recursive: true })
const transcript = path.join(projects, `${SESSION}.jsonl`)

const line = (obj) => JSON.stringify(obj) + '\n'
const at = '2026-08-25T19:24:33.475Z'

fs.writeFileSync(
  transcript,
  [
    line({ type: 'mode', mode: 'normal' }),
    line({ type: 'user', timestamp: at, message: { role: 'user', content: 'add a health endpoint' } }),
    line({
      type: 'assistant',
      timestamp: at,
      message: { role: 'assistant', content: [{ type: 'thinking', thinking: '', signature: 'SECRETSIGNATURE' }] },
    }),
    line({
      type: 'assistant',
      timestamp: at,
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Looking at the router first.' },
          { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'grep -rn "router" src' } },
        ],
      },
    }),
    line({
      type: 'user',
      timestamp: at,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'src/app.js:12\nsrc/app.js:40' }] },
    }),
    // Subagent traffic belongs under its parent tool call, never in the chat.
    line({
      type: 'assistant',
      isSidechain: true,
      timestamp: at,
      message: { role: 'assistant', content: [{ type: 'text', text: 'SIDECHAIN LEAK' }] },
    }),
  ].join(''),
)

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`)
}

function writeConfig(enabled) {
  const dir = path.join(sandbox, 'omarchy-connect')
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  fs.writeFileSync(
    path.join(dir, 'config.json'),
    JSON.stringify(
      {
        version: 1,
        port: PORT,
        deviceName: 'agents-test',
        agents: { enabled, spawn: false },
        // Same reason as every other suite — see `sandbox.mjs`.
        handsfree: { autoConnect: 'off', address: null },
        devices: [],
      },
      null,
      2,
    ),
  )
}

let daemon = null

async function startDaemon(enabled) {
  writeConfig(enabled)
  daemon = spawn(process.execPath, [path.join(root, 'bin', 'omarchy-connect.js'), 'start', '--port', String(PORT)], {
    env: {
      ...process.env,
      HOME: sandbox,
      XDG_CONFIG_HOME: sandbox,
      // A picture on its way to an agent lands in the cache; this suite is not
      // entitled to write into the real one.
      XDG_CACHE_HOME: path.join(sandbox, '.cache'),
      OMARCHY_CONNECT_STATE: path.join(sandbox, 'state'),
      OMARCHY_CONNECT_LOG: 'warn',
      // The writing half shells out to tmux, and the person running this suite
      // very likely has tmux sessions of their own open. `TMUX_TMPDIR` gives
      // the daemon a server nobody else is attached to.
      TMUX_TMPDIR: sandbox,
    },
    stdio: ['ignore', 'ignore', 'inherit'],
  })
  for (let i = 0; i < 40; i += 1) {
    try {
      if ((await fetch(`${base}/api/info`)).ok) return
    } catch {
      await new Promise((r) => setTimeout(r, 250))
    }
  }
  throw new Error('daemon did not start')
}

async function stopDaemon() {
  if (!daemon) return
  const done = new Promise((resolve) => daemon.on('exit', resolve))
  daemon.kill('SIGTERM')
  await done
  daemon = null
}

process.on('exit', () => {
  daemon?.kill('SIGTERM')
  fs.rmSync(sandbox, { recursive: true, force: true })
})

/** A paired phone with request/response correlation and an event log. */
async function connect() {
  const info = await (await fetch(`${base}/api/info`)).json()
  const pair = await (await fetch(`${base}/api/pair-code`, { method: 'POST' })).json()
  const phone = connectPhone(PORT, info.publicKey)
  const pending = new Map()
  const events = []
  let seq = 0
  // The upload endpoint is HTTP and authenticates on its own, so the token
  // pairing issues has to be caught as it goes past.
  let token = null

  const req = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++seq
      pending.set(id, { resolve, reject })
      phone.send({ t: 'req', id, method, params })
      setTimeout(() => pending.has(id) && (pending.delete(id), reject(new Error(`${method} timed out`))), 8000)
    })

  const hello = await new Promise((resolve, reject) => {
    phone.ready
      .then(() =>
        phone.send({ t: 'hello', pairCode: pair.code, device: { id: 'agents-test', name: 'Agents Phone', platform: 'android' } }),
      )
      .catch(reject)
    phone.on((msg) => {
      if (msg.t === 'paired') token = msg.token
      if (msg.t === 'hello.ok') resolve(msg)
      if (msg.t === 'hello.err') reject(new Error(msg.error))
      if (msg.t === 'ev' && msg.event === 'agent') events.push(msg.data)
      if (msg.t === 'res') {
        const p = pending.get(msg.id)
        if (!p) return
        pending.delete(msg.id)
        msg.ok ? p.resolve(msg.data) : p.reject(new Error(msg.error))
      }
    })
    phone.ws.on('error', reject)
  })

  phone.send({ t: 'sub', events: ['agent'] })
  return { hello, token, req, events, close: () => phone.ws.close() }
}

const hook = (event, extra = {}) =>
  fetch(`${base}/api/agent/hook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      hook_event_name: event,
      session_id: SESSION,
      transcript_path: transcript,
      cwd: CWD,
      agent: 'claude',
      ...extra,
    }),
  }).then((r) => r.json())

/** The desktop's own switch: loopback only, and no phone can reach it. */
const control = (op) =>
  fetch(`${base}/api/agent/control`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ op }),
  }).then((r) => r.json())

const readStatus = () => JSON.parse(fs.readFileSync(path.join(sandbox, 'state', 'status.json'), 'utf8'))
const readStoredConfig = () => JSON.parse(fs.readFileSync(path.join(sandbox, 'omarchy-connect', 'config.json'), 'utf8'))

/**
 * tmux is the primary writer and it is not universally installed, so the
 * writing section either runs for real or says out loud that it did not. A
 * silently skipped test is worse than no test.
 */
const hasTmux = (() => {
  try {
    execFileSync('which', ['tmux'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

const tmux = (args) =>
  execFileSync('tmux', args, { env: { ...process.env, TMUX_TMPDIR: sandbox }, encoding: 'utf8' }).trim()

const settle = (ms = 350) => new Promise((r) => setTimeout(r, ms))
const waitFor = async (events, predicate, ms = 4000) => {
  const until = Date.now() + ms
  while (Date.now() < until) {
    const found = events.find(predicate)
    if (found) return found
    await settle(80)
  }
  return null
}

/* ── who is an agent, and whose conversation is whose ──────────────────── */

// The half of discovery no daemon is needed to test, and the half that was
// wrong: which `claude` processes are sessions at all, and which transcript
// each one is allowed to be holding.
{
  const claude = (await import('../src/agents/claude.js')).default
  const { pair } = await import('../src/agents/pairing.js')
  const proc = await import('../src/agents/proc.js')

  check('a bare session is a session', claude.isSession(['/usr/bin/claude']))
  check('so is one with flags', claude.isSession(['claude', '--resume', '--effort', 'high']))
  check('so is one carrying a prompt', claude.isSession(['claude', '-p', 'add a health endpoint']))
  // The one that was being listed on a phone as an agent, with a stranger's
  // conversation inside it, because it wears the same name in `/proc`.
  check('the agent’s own supervisor is not', !claude.isSession(['/usr/bin/claude', 'daemon', 'run']))
  check('nor are its background helpers', !claude.isSession(['claude', 'bg-spare', '--bg-spare', '/tmp/x.sock']))
  check('nor is a housekeeping command', !claude.isSession(['claude', 'doctor']))
  // These wear their subcommand in their process title rather than in an
  // argument, which is the only place it appears.
  check('a helper hiding in its process title is caught too', !claude.isSession(['claude bg-pty-host', '--bg-pty-host', '/tmp/x.sock']))

  const started = 10_000
  const running = { pid: 1, startedAt: started, ticks: 20, tty: true }
  const mine = { id: 'mine', mtime: started + 60_000 }
  const stranger = { id: 'stranger', mtime: started - 60_000 }

  check('a live agent takes the transcript it could have written', pair([running], [stranger, mine])[0]?.transcript === mine)
  // The whole class of bug: the newest file in a busy directory is very often
  // one that ended, and pinning a live pid to it puts somebody else's
  // conversation on the phone under a live agent's name.
  check('and never one that stopped before it started', pair([running], [stranger]).length === 0)
  check(
    'an agent that has not written yet is absent, not misattributed',
    pair([{ ...running, startedAt: Date.now() }], [stranger]).length === 0,
  )
  const helper = { pid: 2, startedAt: started + 30_000, ticks: 99, tty: false }
  check(
    'a session at a keyboard is served before a helper that shares its directory',
    pair([helper, running], [mine])[0]?.proc === running,
  )
  check('two agents in one directory get one transcript each', pair([running, { ...helper, tty: true }], [mine, { id: 'other', mtime: started + 90_000 }]).length === 2)

  check('this process knows when it started', Math.abs(proc.startedAt(process.pid) - Date.now()) < 10 * 60 * 1000)
  check('and that a test runner has no controlling terminal to speak of', typeof proc.hasTty(process.pid) === 'boolean')

  // A working directory is not a unique key. A background job and the session
  // that launched it share one, and the transcript follows the agent between
  // project directories a beat late — long enough, on this very desktop, for a
  // background agent's conversation to be listed under the interactive
  // session's pid, with that session's terminal offered as the way to answer.
  const atKeyboard = { pid: 1, tty: true, ticks: 100, startedAt: 1000 }
  const inBackground = { pid: 2, tty: false, ticks: 900, startedAt: 2000 }
  const bgFile = { id: 'bg', path: '/bg.jsonl', mtime: 9000 }
  const ttyFile = { id: 'tty', path: '/tty.jsonl', mtime: 5000 }
  const kind = (t) => t.path === '/bg.jsonl'

  const crossed = pair([atKeyboard, inBackground], [bgFile, ttyFile])
  check('without it the newest file wins and both are wrong', crossed[0]?.transcript === bgFile)
  const sorted = pair([atKeyboard, inBackground], [bgFile, ttyFile], { background: kind })
  check(
    'a session at a keyboard does not take a background conversation',
    sorted.find((p) => p.proc === atKeyboard)?.transcript === ttyFile,
  )
  check(
    'and the background agent keeps its own',
    sorted.find((p) => p.proc === inBackground)?.transcript === bgFile,
  )
  // A transcript with no turn in it yet cannot say which it is, and refusing
  // it would lose the session rather than place it better.
  check('a transcript that has not said yet is still a candidate', pair([atKeyboard], [ttyFile], { background: () => null }).length === 1)

  // The adapter reads that off the file, so it has to survive a real one.
  const bgSample = path.join(sandbox, 'bg-sample.jsonl')
  fs.writeFileSync(bgSample, [line({ type: 'mode', mode: 'normal' }), line({ type: 'assistant', entrypoint: 'cli', sessionKind: 'bg', cwd: CWD })].join(''))
  check('a background transcript says so', claude.background(bgSample) === true)
  const ttySample = path.join(sandbox, 'tty-sample.jsonl')
  fs.writeFileSync(ttySample, [line({ type: 'ai-title', aiTitle: 'x' }), line({ type: 'assistant', entrypoint: 'cli', cwd: CWD })].join(''))
  check('an interactive one says nothing, which is its answer', claude.background(ttySample) === false)
  const quiet = path.join(sandbox, 'quiet-sample.jsonl')
  fs.writeFileSync(quiet, line({ type: 'mode', mode: 'normal' }))
  check('and a transcript with no turn yet stays unknown', claude.background(quiet) === null)
}

/* ── the gate ──────────────────────────────────────────────────────────── */

await startDaemon(false)
{
  const { hello, token, req, events, close } = await connect()
  check('capabilities say agents are off', hello.capabilities.agents?.enabled === false)
  check('capabilities admit writing is not implemented', hello.capabilities.agents?.write === null)
  const refused = await req('agents.list').then(() => null, (e) => e.message)
  check('agents.list is refused while disabled', String(refused).includes('agent enable'), refused)
  // Writing is arbitrary code execution on the desktop. It arrives with
  // reading, behind the same switch, and it has to be shut by the same one.
  const refusedWrite = await req('agents.send', { id: `claude:${SESSION}`, text: 'rm -rf /' }).then(
    () => null,
    (e) => e.message,
  )
  check('agents.send is refused while disabled', String(refusedWrite).includes('agent enable'), refusedWrite)
  const ignored = await hook('SessionStart')
  check('a hook is ignored while disabled', ignored.ok === false, ignored.error)

  // The picture door is the same gate: with agents off there is nothing on
  // this desktop that would ever read what a phone dropped there.
  const dropped = await fetch(`${base}/api/upload`, {
    method: 'POST',
    headers: { 'x-oc-token': token, 'x-oc-filename': 'shot.png', 'x-oc-dest': 'agent' },
    body: 'x',
  })
  check('a picture for an agent is refused while disabled', dropped.status === 403, String(dropped.status))

  /* ── the switch on the desktop panel ─────────────────────────────────── */

  // The panel shells out to `omarchy-connect agent enable`, which comes down
  // this road. The whole point is that it lands without a restart: the phone
  // above stays connected across the next four checks.
  const denied = await req('agents.enable').then(() => 'answered', (e) => e.message)
  check('a phone cannot turn on its own reading', denied !== 'answered', String(denied))

  const on = await control('enable')
  check('the desktop switch turns reading on', on.ok === true && on.agents.enabled === true)
  check('the switch says whether the hooks are in place', typeof on.agents.hooks === 'boolean')
  check(
    'the phone is told the answer changed',
    Boolean(await waitFor(events, (e) => e.kind === 'control' && e.enabled === true)),
  )
  const allowed = await req('agents.list')
  check('the same link can read agents now — no reconnect', Array.isArray(allowed.sessions))
  const accepted = await hook('SessionStart', { ppid: process.pid })
  check('a hook lands once the switch is on', accepted.ok === true, accepted.id)
  check('the status file tells the panel it is on', readStatus().agents.enabled === true)
  check('the decision survives a restart', readStoredConfig().agents?.enabled === true)

  const off = await control('disable')
  check('the switch turns it off again', off.ok === true && off.agents.enabled === false)
  const refusedAgain = await req('agents.list').then(() => null, (e) => e.message)
  check('reading stops the moment it is turned off', String(refusedAgain).includes('agent enable'), refusedAgain)
  check(
    'the phone is told it stopped',
    Boolean(await waitFor(events, (e) => e.kind === 'control' && e.enabled === false)),
  )
  check('the status file follows', readStatus().agents.enabled === false)
  close()
}
await stopDaemon()

/* ── reading ───────────────────────────────────────────────────────────── */

await startDaemon(true)
const { hello, token, req, events, close } = await connect()
check('capabilities say agents are on', hello.capabilities.agents?.enabled === true, (hello.capabilities.agents?.adapters || []).join(' '))
check(
  'capabilities name the road into a terminal',
  hello.capabilities.agents?.write === (hasTmux ? 'tmux' : hello.capabilities.agents?.write),
  String(hello.capabilities.agents?.write),
)
check('capabilities list the keys a phone may press', (hello.capabilities.agents?.keys || []).includes('Escape'))
check(
  'capabilities admit the two things the app has to ask for',
  hello.capabilities.agents?.attach === true && hello.capabilities.agents?.answer === true,
)

const empty = await req('agents.list')
check('no sessions before anything is discovered', empty.sessions.length === 0)

// Deliberately without `ppid`: the hook resolves a pid by walking up from the
// process that ran it, and this suite is very often run *by* a coding agent —
// which would hand the fake session the real agent's terminal and make the
// next check depend on whose machine it ran on. The writing section below
// names a pid outright instead.
const registered = await hook('SessionStart')
check('SessionStart registers a session', registered.ok === true && registered.id === `claude:${SESSION}`, registered.id)
check('a hook-registered session is announced', Boolean(await waitFor(events, (e) => e.kind === 'session' && e.id === `claude:${SESSION}`)))

const listed = await req('agents.list')
const session = listed.sessions[0]
check('agents.list finds it', listed.sessions.length === 1 && session.state === 'idle', `${session?.title} · ${session?.state}`)
check('the session names its directory and its road', session.cwd === CWD && session.via === 'hook')
// Nothing has told this session which terminal it lives in yet, so there is
// no composer to offer — and saying `null` is what lets the app grey the input
// out instead of discovering at send time that it cannot work.
check('a session in no terminal we can reach is read-only', session.writable === null, String(session.writable))
// The list is mostly previews, and a session nobody has opened is not tailed —
// so the preview comes from the tail of the file directly. A long run of tool
// calls is the normal shape of an agent at work, so it describes the last block
// whatever kind it is rather than quoting only prose.
check('the list says what the agent is doing', session.preview === 'src/app.js:12', session.preview)

const opened = await req('agents.open', { id: session.id, limit: 100 })
const kinds = opened.blocks.map((b) => `${b.role}:${b.kind}`)
check('agents.open returns the conversation', opened.blocks.length === 5, kinds.join(' '))
check('the user turn survives', opened.blocks[0].kind === 'text' && opened.blocks[0].text === 'add a health endpoint')
check('the tool call is one line', opened.blocks.some((b) => b.kind === 'tool' && b.tool === 'Bash' && b.summary.includes('grep')))
check('the tool result carries a status', opened.blocks.some((b) => b.kind === 'result' && b.status === 'ok' && b.lines === 2))
check('bookkeeping lines are dropped', !kinds.includes('system:state'))
check('subagent traffic stays out of the chat', !JSON.stringify(opened.blocks).includes('SIDECHAIN LEAK'))
check('a thinking signature is never rendered', !JSON.stringify(opened.blocks).includes('SECRETSIGNATURE'))
check('open answers with a cursor', opened.cursor === 5, String(opened.cursor))

const detail = await req('agents.detail', { id: session.id, seq: opened.blocks.find((b) => b.kind === 'result').seq })
check('the full tool body is one tap away', detail.text.includes('src/app.js:40'))

// The tail: a line appended to the transcript has to reach an open phone.
fs.appendFileSync(
  transcript,
  line({
    type: 'assistant',
    timestamp: at,
    message: { role: 'assistant', content: [{ type: 'text', text: 'Added GET /health.' }] },
  }),
)
const streamed = await waitFor(events, (e) => e.kind === 'blocks' && e.blocks.some((b) => b.text === 'Added GET /health.'))
check('new blocks stream to an open session', Boolean(streamed), streamed ? `cursor ${streamed.cursor}` : 'nothing arrived')

/* ── the state machine ─────────────────────────────────────────────────── */

await hook('UserPromptSubmit')
check('a submitted prompt means working', Boolean(await waitFor(events, (e) => e.kind === 'state' && e.state === 'working')))

await hook('Notification', { message: 'Claude needs your permission to use Bash' })
const waiting = await waitFor(events, (e) => e.kind === 'state' && e.state === 'waiting')
check('a permission prompt means waiting', Boolean(waiting), waiting?.prompt)
check('the waiting session sorts to the top', (await req('agents.list')).sessions[0].state === 'waiting')

const status = readStatus()
check('the status file tells the panel', status.agents.waiting === 1 && status.agents.running === 1)
check('the status file agrees with the phone about who is first', status.agents.sessions[0].state === 'waiting')

// The other sentence `Notification` carries. It fires a minute after the agent
// stopped, to say it is sitting at an empty prompt — which is what an idle
// agent does all evening. Calling that "needs you" put a badge on every
// session the person had simply walked away from.
await hook('Stop')
await waitFor(events, (e) => e.kind === 'state' && e.state === 'idle')
await hook('Notification', { message: 'Claude is waiting for your input' })
await settle()
check(
  'an agent left alone at its prompt is idle, not waiting',
  (await req('agents.list')).sessions[0].state === 'idle',
  (await req('agents.list')).sessions[0].state,
)
await hook('UserPromptSubmit')
await waitFor(events, (e) => e.kind === 'state' && e.state === 'working')
await hook('Notification', { message: 'Claude needs your permission to use Bash' })
await waitFor(events, (e) => e.kind === 'state' && e.state === 'waiting')

// Answering at the keyboard fires no hook we subscribe to, so the transcript
// moving again is what has to clear `waiting`.
fs.appendFileSync(
  transcript,
  line({ type: 'assistant', timestamp: at, message: { role: 'assistant', content: [{ type: 'text', text: 'Running it now.' }] } }),
)
check('transcript activity clears a stale waiting', Boolean(await waitFor(events, (e) => e.kind === 'state' && e.state === 'working')))

/* ── multiple choice ───────────────────────────────────────────────────── */

// The one thing an agent blocks on that it also writes down. Every other tool
// call is collapsed to a line on its way to the phone; this one has to arrive
// whole, because the options are the entire reason it is worth carrying.
const QUESTION_ID = 'toolu_ask_1'
const askLine = (id) =>
  line({
    type: 'assistant',
    timestamp: at,
    message: {
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id,
          name: 'AskUserQuestion',
          input: {
            questions: [
              {
                question: 'Which database?',
                header: 'Storage',
                multiSelect: false,
                options: [
                  { label: 'Postgres', description: 'the one already in the compose file' },
                  { label: 'SQLite', description: 'no server to run' },
                ],
              },
            ],
          },
        },
      ],
    },
  })

fs.appendFileSync(transcript, askLine(QUESTION_ID))
const asked = await waitFor(events, (e) => e.kind === 'blocks' && e.blocks.some((b) => b.kind === 'question'))
const questionBlock = asked?.blocks.find((b) => b.kind === 'question')
check('a multiple-choice question arrives whole', Boolean(questionBlock), questionBlock?.summary)
check(
  'the options survive the trip, in order',
  questionBlock?.questions?.[0]?.options.map((o) => o.label).join(' · ') === 'Postgres · SQLite',
  questionBlock?.questions?.[0]?.options.map((o) => o.label).join(' · '),
)
check('an option keeps what it means', questionBlock?.questions?.[0]?.options[0].description.includes('compose file'))

// This is the road to `waiting` that needs no hook at all: the question is on
// disk, so even a session found by scanning /proc can say what it is stuck on.
const stuck = await waitFor(events, (e) => e.kind === 'state' && e.state === 'waiting' && String(e.prompt).includes('database'))
check('a question on disk is a session waiting', Boolean(stuck), stuck?.prompt)

/* ── the words the question was held back with ─────────────────────────── */

// Claude Code writes an assistant turn down only once the tool inside it has
// returned, so the sentence the agent said on its way to asking is withheld
// along with the question: the hook carries the card minutes before the file
// carries the words. When the file finally catches up, those words must not
// land *under* a card that was drawn before them — an explanation printed
// after the question it explains is a conversation read backwards.
const HELD_ID = 'toolu_ask_held'
const heldInput = {
  questions: [
    {
      question: 'Remove the pairing on both sides?',
      header: 'Re-pair',
      multiSelect: false,
      options: [{ label: 'Yes, do it' }, { label: 'Just tell me how' }],
    },
  ],
}
await hook('PreToolUse', { tool_name: 'AskUserQuestion', tool_use_id: HELD_ID, tool_input: heldInput })
const carried = await waitFor(events, (e) => e.kind === 'blocks' && e.blocks.some((b) => b.ref === HELD_ID))
check('a hook carries a question the file does not have yet', Boolean(carried))
const heldCard = (await req('agents.open', { id: session.id, limit: 200 })).blocks.find((b) => b.ref === HELD_ID)

// The whole turn arrives at once, the way Claude Code writes it: what the
// agent said, the question it asked, and the answer that released both.
fs.appendFileSync(
  transcript,
  [
    line({
      type: 'assistant',
      timestamp: at,
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'The pairing is only half there.' },
          { type: 'tool_use', id: HELD_ID, name: 'AskUserQuestion', input: heldInput },
        ],
      },
    }),
    line({
      type: 'user',
      timestamp: at,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: HELD_ID, content: 'Yes, do it' }] },
    }),
  ].join(''),
)

// A block that moved is not something an appending phone can be told about one
// block at a time, so the list arrives again whole.
const caught = await waitFor(events, (e) => e.kind === 'blocks' && e.reset === true)
check('a reordered conversation is sent again whole', Boolean(caught))
const said = caught?.blocks.findIndex((b) => b.text === 'The pairing is only half there.')
const card = caught?.blocks.findIndex((b) => b.ref === HELD_ID)
check('the words the question was held back with come before it', said >= 0 && card > said, `${said} then ${card}`)
check(
  'the question is still one card',
  caught?.blocks.filter((b) => b.ref === HELD_ID && b.kind === 'question').length === 1,
)
// The phone answers a question by seq, and a card that renumbers under a thumb
// is a phone answering the wrong one.
check('the card keeps the number the phone knows it by', caught?.blocks[card]?.seq === heldCard.seq, `${caught?.blocks[card]?.seq} vs ${heldCard.seq}`)
check('the answer that released the turn comes after the card', caught?.blocks.findIndex((b) => b.kind === 'result' && b.ref === HELD_ID) > card)

/* ── answering ─────────────────────────────────────────────────────────── */

// The hard half, exercised against a real pane rather than a mock: the point
// of the tmux road is that the bytes arrive at the far end of somebody else's
// pty, and only a real pty can say whether they did.
if (!hasTmux) {
  console.log('  skip  tmux is not installed — the writing half was not exercised')
} else {
  const received = path.join(sandbox, 'pane.txt')
  tmux(['new-session', '-d', '-s', 'oc-test', '-x', '100', '-y', '30', `cat > ${received}`])
  await settle(400)

  const paneId = tmux(['list-panes', '-t', 'oc-test', '-F', '#{pane_id}'])
  const panePid = Number(tmux(['list-panes', '-t', 'oc-test', '-F', '#{pane_pid}']))
  // The agent is a child of the pane's shell — here, the `cat` the pane runs.
  const agentPid = Number(execFileSync('pgrep', ['-P', String(panePid)], { encoding: 'utf8' }).trim().split('\n')[0])

  // A hook is how a real session announces its pid; this one just happens to
  // be a `cat`, which is exactly as much as the writer needs to know.
  await hook('UserPromptSubmit', { pid: agentPid })
  const found = (await req('agents.list')).sessions.find((s) => s.id === session.id)
  check('a session inside a pane is answerable', found?.writable === 'tmux', `${found?.writable} ${found?.pane}`)
  check('and it names the pane it found', found?.pane === paneId, `${found?.pane} vs ${paneId}`)

  const sent = await req('agents.send', { id: session.id, text: 'так, продовжуй' })
  check('agents.send reports the road it took', sent.ok === true && sent.via === 'tmux', JSON.stringify(sent))

  // Multi-line has to arrive as a paste, not as a burst of Returns: a TUI with
  // bracketed paste on would otherwise submit the first line on its own.
  await req('agents.send', { id: session.id, text: 'line one\nline two', submit: true })
  // A numbered permission prompt is answered with a digit, not with prose.
  await req('agents.key', { id: session.id, key: '2' })
  await req('agents.key', { id: session.id, key: 'Enter' })
  await settle(500)

  const arrived = fs.readFileSync(received, 'utf8')
  check('the text reaches the far end of the pty', arrived.includes('так, продовжуй'), JSON.stringify(arrived))
  check('utf-8 survives send-keys -l', arrived.split('\n')[0] === 'так, продовжуй')
  check('a multi-line message stays one message', arrived.includes('line one\nline two'), JSON.stringify(arrived))
  check('a digit answers a numbered prompt', arrived.split('\n').includes('2'), JSON.stringify(arrived))

  const screen = await req('agents.screen', { id: session.id, lines: 20 })
  check('the raw screen is what the terminal shows', screen.screen.includes('line two'), screen.screen.split('\n')[0])

  // The key list is a whitelist, not a pass-through: `send-keys` would happily
  // take anything, and "anything" is not a surface worth exposing to a phone.
  const badKey = await req('agents.key', { id: session.id, key: 'C-z; rm -rf /' }).then(() => null, (e) => e.message)
  check('an unknown key is refused rather than forwarded', String(badKey).includes('cannot be sent'), badKey)

  const tooMuch = await req('agents.send', { id: session.id, text: 'x'.repeat(5000) }).then(() => null, (e) => e.message)
  check('an oversized message is refused', String(tooMuch).includes('too much text'), tooMuch)

  /* ── picking an answer off the list ──────────────────────────────────── */

  // The option's position is the keystroke that chooses it, so what has to be
  // asserted is that tapping option two presses `2` at the far end of the pty.
  const answerable = (await req('agents.open', { id: session.id, limit: 200 })).blocks.find((b) => b.kind === 'question')
  const answered = await req('agents.answer', { id: session.id, seq: answerable.seq, choices: [2] })
  check('agents.answer names what it picked', answered.labels?.join() === 'SQLite', JSON.stringify(answered.labels))
  await settle(400)
  check('the choice reaches the pty as its digit', fs.readFileSync(received, 'utf8').split('\n').includes('2'))

  // A number that does not name an option on the block the phone is looking at
  // is a stale screen answering the wrong question — a refusal, not a keypress.
  const outOfRange = await req('agents.answer', { id: session.id, seq: answerable.seq, choices: [7] })
    .then(() => null, (e) => e.message)
  check('an option that does not exist is refused', String(outOfRange).includes('no option 7'), outOfRange)

  const notAQuestion = await req('agents.answer', { id: session.id, seq: 1, choices: [1] }).then(() => null, (e) => e.message)
  check('a block that is not a question cannot be answered', String(notAQuestion).includes('not a question'), notAQuestion)

  const tooMany = await req('agents.answer', { id: session.id, seq: answerable.seq, choices: [1, 2] })
    .then(() => null, (e) => e.message)
  check('a single-choice list takes one answer', String(tooMany).includes('one answer'), tooMany)

  /* ── a multi-select is toggles, and then a submit ────────────────────── */

  // Digits only tick boxes on a multi-select — nothing has been said yet, and
  // a Return pressed there toggles the highlighted row instead of sending,
  // which is a phone quietly adding an option nobody picked. What sends is
  // walking off the checkbox screen with Right and pressing Return on the
  // submit tab, so the chord has to be digits, Right, Return. The pane is in
  // canonical mode, so the line only arrives at all once the Return does.
  const MULTI_ID = 'toolu_multi'
  const multiInput = {
    questions: [
      {
        question: 'Which colours?',
        header: 'Colours',
        multiSelect: true,
        options: [{ label: 'Red' }, { label: 'Green' }, { label: 'Blue' }],
      },
    ],
  }
  await hook('PreToolUse', { tool_name: 'AskUserQuestion', tool_use_id: MULTI_ID, tool_input: multiInput })
  await settle(400)
  const multiBlock = (await req('agents.open', { id: session.id, limit: 200 })).blocks
    .find((b) => b.kind === 'question' && b.summary.includes('colours'))
  // The digit the single-choice test pressed is still sitting in the pane's
  // line buffer; flush it so what arrives next is only this answer.
  await req('agents.key', { id: session.id, key: 'Enter' })
  await settle(300)
  const beforeMulti = fs.readFileSync(received, 'utf8').length
  const multiAnswered = await req('agents.answer', { id: session.id, seq: multiBlock.seq, choices: [2, 3] })
  check(
    'a multi-select names every label it picked',
    multiAnswered.labels?.join(' · ') === 'Green · Blue',
    JSON.stringify(multiAnswered.labels),
  )
  await settle(1600)
  const chorded = fs.readFileSync(received, 'utf8').slice(beforeMulti)
  check('the boxes are ticked and the tabs walked to submit', chorded === '23\x1b[C\n', JSON.stringify(chorded))
  await hook('PostToolUse', { tool_name: 'AskUserQuestion', tool_use_id: MULTI_ID, tool_input: multiInput })
  await settle(300)

  /* ── handing over a picture ──────────────────────────────────────────── */

  // A one-pixel PNG is a real picture as far as every layer here is concerned.
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  )
  const uploaded = await fetch(`${base}/api/upload`, {
    method: 'POST',
    headers: {
      'x-oc-token': token,
      'x-oc-filename': encodeURIComponent('a shot.png'),
      'x-oc-dest': 'agent',
      'content-type': 'application/octet-stream',
    },
    body: png,
  }).then((r) => r.json())
  check('a picture for an agent answers with where it landed', typeof uploaded.path === 'string', uploaded.path)
  check('it goes to the cache, not the share inbox', !String(uploaded.path).includes('Downloads'), uploaded.path)
  check('and its name is safe to type at a prompt', !path.basename(uploaded.path).includes(' '), path.basename(uploaded.path))
  check('the bytes are all there', fs.statSync(uploaded.path).size === png.length)

  await req('agents.attach', { id: session.id, paths: [uploaded.path], text: 'why is this off by one?' })
  await settle(400)
  const withShot = fs.readFileSync(received, 'utf8')
  check('the agent is told where the picture is', withShot.includes(uploaded.path), path.basename(uploaded.path))
  check('and the question comes with it', withShot.includes('why is this off by one?'))

  // `agents.attach` types what it is handed into a terminal, so the one thing
  // it must never do is type a path the phone made up.
  const escaped = await req('agents.attach', { id: session.id, paths: ['/etc/passwd'] }).then(() => null, (e) => e.message)
  check('a path outside the drop directory is refused', String(escaped).includes('not one this phone handed over'), escaped)

  tmux(['kill-session', '-t', 'oc-test'])
  await settle(300)
  await req('agents.list')
  const orphaned = (await req('agents.list')).sessions.find((s) => s.id === session.id)
  // The pane is gone and so is the `cat` inside it; whatever is left of the
  // session must not still be advertising a composer.
  check('a closed pane takes the composer with it', !orphaned || orphaned.writable !== 'tmux', String(orphaned?.writable))
  // And killing the process is the end of the session, not a row that stays on
  // the phone for the rest of the daemon's life. This is the reap that used to
  // be unreachable: it lived behind a scan that threw on its first line, so a
  // desktop accumulated every agent it had ever seen and dropped none of them.
  check('an agent whose process died stops being listed', !orphaned, String(orphaned?.state))
}

// The rest of this file is about a live session again, so announce one: the
// hook road is how a real agent says which process it is, and this test runner
// is a process that is certainly running.
await hook('UserPromptSubmit', { pid: process.pid })

/* ── a question the transcript does not have yet ───────────────────────── */

// The road that matters most, and the one that was missing. Claude Code holds
// an assistant turn back until the tool inside it has returned, so a question
// the agent is *blocked on* is in no file — by the time `AskUserQuestion`
// reaches the transcript it has already been answered at the keyboard. Only
// `PreToolUse` has it while a phone can still do something about it.
const HOOK_ID = 'toolu_ask_2'
const hookInput = {
  questions: [
    {
      question: 'Which fruit should I pick?',
      header: 'Fruit',
      multiSelect: false,
      options: [
        { label: 'Apple', description: 'crisp and common' },
        { label: 'Banana', description: 'soft and sweet' },
      ],
    },
  ],
}

await req('agents.open', { id: session.id, limit: 200 })
const beforeAsk = events.length
await hook('PreToolUse', { tool_name: 'AskUserQuestion', tool_use_id: HOOK_ID, tool_input: hookInput })
const fromHook = await waitFor(
  events.slice(beforeAsk),
  (e) => e.kind === 'blocks' && e.blocks.some((b) => b.kind === 'question' && b.summary.includes('fruit')),
)
check('a question reaches the phone before the transcript has it', Boolean(fromHook))
const hookBlock = fromHook?.blocks.find((b) => b.kind === 'question')
check(
  'and it arrives whole, options and all',
  hookBlock?.questions?.[0]?.options.map((o) => o.label).join(' · ') === 'Apple · Banana',
  hookBlock?.questions?.[0]?.options.map((o) => o.label).join(' · '),
)
check(
  'the session says what it is stuck on, not that it is stuck',
  (await req('agents.list')).sessions[0].prompt === 'Which fruit should I pick?',
  (await req('agents.list')).sessions[0].prompt,
)
// A tool call carried by a hook is still a tool call: the phone answers it the
// same way, by the option's position.
if (hasTmux) {
  const refusedSeven = await req('agents.answer', { id: session.id, seq: hookBlock.seq, choices: [7] })
    .then(() => null, (e) => e.message)
  check('a hook-carried question validates like any other', String(refusedSeven).includes('no option 7'), refusedSeven)
}

// Closing the screen throws the blocks away; the question is still on the
// terminal after it, so opening again has to find it — and finding it must not
// flip a waiting session to `working` for having been looked at.
await req('agents.close', { id: session.id })
const reopened = await req('agents.open', { id: session.id, limit: 200 })
const survived = reopened.blocks.filter((b) => b.kind === 'question' && b.summary.includes('fruit'))
check('reopening finds the question again', survived.length === 1, `${survived.length} copies`)
check('and opening a waiting session leaves it waiting', reopened.session.state === 'waiting', reopened.session.state)

// The transcript finally catches up, carrying the same tool call and then its
// answer. One card, not two — and the answer settles it.
fs.appendFileSync(
  transcript,
  line({
    type: 'assistant',
    timestamp: at,
    message: { role: 'assistant', content: [{ type: 'tool_use', id: HOOK_ID, name: 'AskUserQuestion', input: hookInput }] },
  }),
)
fs.appendFileSync(
  transcript,
  line({
    type: 'user',
    timestamp: at,
    toolUseResult: { answers: { 'Which fruit should I pick?': 'Apple' } },
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: HOOK_ID, content: 'Apple' }],
    },
  }),
)
await settle(600)
const settledBlocks = (await req('agents.open', { id: session.id, limit: 200 })).blocks
check(
  'the transcript copy is dropped as the duplicate it is',
  settledBlocks.filter((b) => b.kind === 'question' && b.summary.includes('fruit')).length === 1,
  String(settledBlocks.filter((b) => b.kind === 'question' && b.summary.includes('fruit')).length),
)
check(
  'and what was picked lands on the same card',
  settledBlocks.some((b) => b.kind === 'result' && b.answers?.['Which fruit should I pick?'] === 'Apple'),
)
await hook('PostToolUse', { tool_name: 'AskUserQuestion', tool_use_id: HOOK_ID, tool_input: hookInput })
await settle(300)
// The database question from the section above is still on disk unanswered,
// so this session is legitimately still waiting — on that one, not on fruit.
check(
  'an answered question stops being what the session waits on',
  !String((await req('agents.list')).sessions[0].prompt).includes('fruit'),
  (await req('agents.list')).sessions[0].prompt,
)
await req('agents.close', { id: session.id })
const afterAnswer = await req('agents.open', { id: session.id, limit: 200 })
check(
  'and it is not put back on screen next time',
  afterAnswer.blocks.filter((b) => b.kind === 'question' && b.summary.includes('fruit')).length === 1,
)

await req('agents.close', { id: session.id })
const before = events.length
await hook('SessionEnd')
await settle(400)
check('SessionEnd ends it', (await req('agents.list')).sessions.length === 0)
// A list driven by events has to end up where a fresh `agents.list` would: a
// session frame after the state change would put the finished session back.
check(
  'nothing re-announces a finished session',
  !events.slice(before).some((e) => e.kind === 'session' && !e.removed),
  events.slice(before).map((e) => e.kind).join(' '),
)

close()
await stopDaemon()

/* ── a CLI newer than the daemon it is talking to ──────────────────────── */

// The first version of the desktop switch shipped this bug: `agent enable`
// posts to the daemon, and a daemon from before that endpoint existed answers
// 404 — which the CLI read as a refusal and turned into a red line on the
// panel with nothing written anywhere. A daemon that cannot take the live half
// is not a daemon saying no: the config is the durable half of the switch and
// has to be written regardless.
{
  const stale = http.createServer((req, res) => {
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'not found' }))
  })
  await new Promise((resolve) => stale.listen(PORT, '127.0.0.1', resolve))

  writeConfig(false)
  // Asynchronously, because the stub above is served by this very process:
  // `spawnSync` would block the loop it needs to answer on, and the CLI would
  // time out instead of being told 404 — which is a different bug entirely.
  const cli = await new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(root, 'bin', 'omarchy-connect.js'), 'agent', 'enable'], {
      env: { ...process.env, HOME: sandbox, XDG_CONFIG_HOME: sandbox, OMARCHY_CONNECT_STATE: path.join(sandbox, 'state') },
    })
    let err = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => {
      err += chunk
    })
    child.stdout.resume()
    child.on('exit', (code) => resolve({ code, err }))
  })
  check('a daemon that does not know the switch is not a refusal', cli.code === 0, cli.err.trim())
  check('the config is written anyway', readStoredConfig().agents?.enabled === true)
  check('and the CLI says the running daemon is stale', cli.err.includes('restart'), cli.err.trim())

  await new Promise((resolve) => stale.close(resolve))
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
