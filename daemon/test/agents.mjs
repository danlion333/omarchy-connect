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

import { FAKE_TUI } from './fake-tui.mjs'
import { connectPhone } from './phone.mjs'
import { localHeaders } from './sandbox.mjs'

const PORT = Number(process.env.PORT || 8802)
const base = `http://127.0.0.1:${PORT}`
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

// `HOME` moves the fake agent's transcripts aside as well as the config: this
// test writes into `~/.claude/projects`, and that is a directory the person
// running the suite very much cares about.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'omarchy-connect-agents-'))

// The local HTTP routes are gated on the secret the daemon publishes in its
// own status file, so every post below reads it the way the CLI does.
const local = () => localHeaders(path.join(sandbox, 'state'))

const CWD = '/home/dan/Projects/example'
const SLUG = CWD.replace(/[^a-zA-Z0-9]/g, '-')
const SESSION = '11111111-2222-3333-4444-555555555555'
const projects = path.join(sandbox, '.claude', 'projects', SLUG)
fs.mkdirSync(projects, { recursive: true })
const transcript = path.join(projects, `${SESSION}.jsonl`)

/**
 * This process's environment, with every trace of herdr taken out of it.
 *
 * The suite is very likely being run from inside a herdr pane — for a change
 * about herdr that is the obvious place to run it from — and herdr puts
 * `HERDR_SOCKET_PATH` and friends into everything a pane starts. The variable
 * outranks `XDG_CONFIG_HOME` in herdr's own CLI, so a sandbox that only moved
 * the config directory was no sandbox at all: the suite created workspaces on
 * the live server, raised a second server against the real socket, and ended
 * by running `server stop` on it — killing the pane it was running in, and
 * taking the rest of the run with it.
 *
 * So the sandbox starts by forgetting, and everything spawned from here — the
 * daemon, the CLI, herdr itself — is given this rather than `process.env`.
 * What is left of the inheritance is `/proc`: this process was started with
 * those variables and its own `environ` still says so, which is why the pid
 * announced as an agent below is a child's rather than this one's.
 */
const cleanEnv = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.startsWith('HERDR_')),
)

const line = (obj) => JSON.stringify(obj) + '\n'
const at = '2026-08-25T19:24:33.475Z'
/** A transcript stamps every entry, and what it stamps them with is the clock. */
const now = (offset = 0) => new Date(Date.now() + offset).toISOString()

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
      gitBranch: 'master',
      version: '2.1.241',
      message: {
        role: 'assistant',
        model: 'claude-opus-5',
        // The status line is read off this: everything that occupies the
        // window, which is nearly all cache.
        usage: { input_tokens: 2, cache_creation_input_tokens: 600, cache_read_input_tokens: 99_398, output_tokens: 0 },
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

// The rest of the desktop's status line lives in files the CLI keeps for its
// own purposes, so the fake HOME gets those too: a skill, the account
// service's cached answer, and a background agent mid-thought.
fs.mkdirSync(path.join(sandbox, '.claude', 'skills', 'example-skill'), { recursive: true })
fs.writeFileSync(
  path.join(sandbox, '.claude', 'skills', 'example-skill', 'SKILL.md'),
  '---\nname: example-skill\ndescription: something this desktop knows how to do\n---\n',
)
fs.writeFileSync(
  path.join(sandbox, '.claude.json'),
  JSON.stringify({
    cachedUsageUtilization: {
      fetchedAtMs: Date.now(),
      utilization: {
        limits: [
          { kind: 'session', group: 'session', percent: 12, severity: 'normal', resets_at: new Date(Date.now() + 3_600_000).toISOString(), is_active: true },
        ],
      },
    },
  }),
)
const JOB = 'job12345'
fs.mkdirSync(path.join(sandbox, '.claude', 'jobs', JOB), { recursive: true })
fs.writeFileSync(
  path.join(sandbox, '.claude', 'jobs', JOB, 'state.json'),
  JSON.stringify({
    state: 'working',
    detail: 'reading the router',
    tokens: 4096,
    name: 'Health endpoint',
    sessionId: SESSION,
    cwd: CWD,
    updatedAt: new Date().toISOString(),
  }),
)

// The list this session is working through.
fs.mkdirSync(path.join(sandbox, '.claude', 'tasks', SESSION), { recursive: true })
fs.writeFileSync(
  path.join(sandbox, '.claude', 'tasks', SESSION, '1.json'),
  JSON.stringify({ id: '1', subject: 'Read the router', activeForm: 'Reading the router', status: 'in_progress', blockedBy: [] }),
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
      ...cleanEnv,
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

/**
 * A live process for a hook to point at, and deliberately not this one.
 *
 * `cleanEnv` cannot reach backwards: `/proc/<pid>/environ` holds the
 * environment a process was *started* with, so this runner goes on naming a
 * real pane on the real herdr server for as long as it lives, whatever it does
 * to `process.env`. A daemon told that this pid is an agent would check that
 * claim, find it true, and hand a phone a composer onto the terminal the suite
 * is running in. So the pid announced as an agent belongs to a child started
 * without any of it — a node process, like the runner, and one that outlasts
 * the suite by a wide margin.
 */
const standIn = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 900000)'], {
  env: cleanEnv,
  stdio: 'ignore',
})

process.on('exit', () => {
  daemon?.kill('SIGTERM')
  standIn.kill()
  fs.rmSync(sandbox, { recursive: true, force: true })
})

/**
 * A paired phone with request/response correlation and an event log.
 *
 * `known` is the token an earlier connection was given: a phone that has been
 * here before comes back with it rather than pairing again, which is what the
 * real app does and the only way to raise a *second* socket for the same
 * device — pairing codes are spent on the first one.
 */
async function connect(known = null) {
  const info = await (await fetch(`${base}/api/info`)).json()
  const pair = known
    ? { code: null }
    : await (await fetch(`${base}/api/pair-code`, { method: 'POST', headers: local() })).json()
  const phone = connectPhone(PORT, info.publicKey)
  const pending = new Map()
  const events = []
  let seq = 0
  // The upload endpoint is HTTP and authenticates on its own, so the token
  // pairing issues has to be caught as it goes past.
  let token = known

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
        phone.send({
          t: 'hello',
          ...(known ? { token: known } : { pairCode: pair.code }),
          device: { id: 'agents-test', name: 'Agents Phone', platform: 'android' },
        }),
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
    headers: local(),
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
    headers: local(),
    body: JSON.stringify({ op }),
  }).then((r) => r.json())

const readStatus = () => JSON.parse(fs.readFileSync(path.join(sandbox, 'state', 'status.json'), 'utf8'))

// The suite very often runs on a desktop where real agents are working — this
// one included — and the daemon under test scans the real `/proc`. Their
// transcripts live under the real HOME, not the sandbox, so they surface as
// `pid-` placeholders: honest rows in production, noise in a test that wants
// to count only the sessions it faked. Filtered here, asserted on directly in
// the placeholder section below.
const real = (sessions) => (sessions || []).filter((s) => !String(s.id).includes(':pid-'))
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

/**
 * The other multiplexer, tested the same way and for the same reason: a road
 * that carries bytes into somebody else's pty is only worth believing when a
 * real pty has been asked whether they arrived.
 */
const hasHerdr = (() => {
  try {
    execFileSync('which', ['herdr'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

// A server of our own, in the sandbox, so the suite never reaches into the
// session the person running it has open — and never writes over the layout
// that session would restore from. Both halves are needed. `XDG_CONFIG_HOME`
// moves the whole of it: the socket, the log and the saved state all follow
// it, which a socket path on its own does not. And `cleanEnv` is what makes
// that stick — an inherited `HERDR_SOCKET_PATH` outranks it and would point
// every command below back at the real server. The sandbox stays under `/tmp`
// for a reason too: a unix socket name is 108 bytes and no more.
const herdrEnv = { ...cleanEnv, XDG_CONFIG_HOME: sandbox }
const herdrSocket = path.join(sandbox, 'herdr', 'herdr.sock')
const herdr = (args) => {
  const out = execFileSync('herdr', args, { env: herdrEnv, encoding: 'utf8' }).trim()
  // Not every command answers: `pane run` does the thing and says nothing.
  return out ? JSON.parse(out).result : null
}

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
  const kind = (t) => ({ background: t.path === '/bg.jsonl', at: t.mtime })

  const crossed = pair([atKeyboard, inBackground], [bgFile, ttyFile])
  check('without it the newest file wins and both are wrong', crossed[0]?.transcript === bgFile)
  const sorted = pair([atKeyboard, inBackground], [bgFile, ttyFile], { recency: kind })
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
  check('a transcript that has not said yet is still a candidate', pair([atKeyboard], [ttyFile], { recency: () => null }).length === 1)

  // An mtime is not when a conversation last happened. The CLI keeps appending
  // untimestamped bookkeeping to transcripts nobody is talking in any more,
  // and each of those writes moves the file's clock — which was enough to rank
  // a conversation that ended at lunchtime above the one being had now, and to
  // put the wrong one on the phone under a live agent's name.
  const finished = { id: 'finished', path: '/finished.jsonl', mtime: 9_000 }
  const current = { id: 'current', path: '/current.jsonl', mtime: 6_000 }
  const turns = (t) => ({ background: false, at: t.path === '/finished.jsonl' ? 3_000 : 6_000 })
  check(
    'a finished conversation with a freshly-bumped mtime does not outrank a live one',
    pair([atKeyboard], [finished, current], { recency: turns })[0]?.transcript === current,
  )
  check(
    'and the session is dated by its last turn, not by the last write to its file',
    pair([atKeyboard], [current], { recency: turns })[0]?.activeAt === 6_000,
  )
  // Nothing said means nothing known: a file too new to have a turn in it is
  // still dated by the only clock there is.
  check(
    'a transcript with no turn yet falls back to its mtime',
    pair([atKeyboard], [current], { recency: () => ({ background: null, at: 0 }) })[0]?.activeAt === 6_000,
  )

  // The adapter reads that off the file, so it has to survive a real one.
  const bgSample = path.join(sandbox, 'bg-sample.jsonl')
  fs.writeFileSync(bgSample, [line({ type: 'mode', mode: 'normal' }), line({ type: 'assistant', entrypoint: 'cli', sessionKind: 'bg', cwd: CWD })].join(''))
  check('a background transcript says so', claude.recency(bgSample).background === true)
  const ttySample = path.join(sandbox, 'tty-sample.jsonl')
  fs.writeFileSync(ttySample, [line({ type: 'ai-title', aiTitle: 'x' }), line({ type: 'assistant', entrypoint: 'cli', cwd: CWD })].join(''))
  check('an interactive one says nothing, which is its answer', claude.recency(ttySample).background === false)
  const quiet = path.join(sandbox, 'quiet-sample.jsonl')
  fs.writeFileSync(quiet, line({ type: 'mode', mode: 'normal' }))
  check('and a transcript with no turn yet stays unknown', claude.recency(quiet).background === null)
  // The line the CLI writes when a background turn is over carries the
  // entrypoint but not the kind, and reading only the newest of them handed a
  // background conversation to whichever session was at a keyboard.
  const trailing = path.join(sandbox, 'trailing-sample.jsonl')
  fs.writeFileSync(
    trailing,
    [
      line({ type: 'assistant', entrypoint: 'cli', sessionKind: 'bg', cwd: CWD }),
      line({ type: 'system', entrypoint: 'cli', cwd: CWD }),
    ].join(''),
  )
  check('a background transcript still says so after a line that does not', claude.recency(trailing).background === true)
  // And the clock it reports is the conversation's own.
  const dated = path.join(sandbox, 'dated-sample.jsonl')
  fs.writeFileSync(
    dated,
    [
      line({ type: 'assistant', entrypoint: 'cli', cwd: CWD, timestamp: '2026-08-28T11:20:26.000Z' }),
      line({ type: 'bridge-session' }),
    ].join(''),
  )
  check('and it is dated by its last turn rather than by its last line', claude.recency(dated).at === Date.parse('2026-08-28T11:20:26.000Z'))

  // A background task reporting in arrives as a user turn, but nobody typed
  // it — a page of XML was landing in the chat as if the person had sent it.
  const notification = claude.parse(
    line({
      type: 'user',
      timestamp: at,
      message: { role: 'user', content: '<task-notification>\n<task-id>abc</task-id>\n<result>done</result>\n</task-notification>' },
    }),
  )
  check('a task notification is not a thing the person said', notification.length === 0, JSON.stringify(notification))
  const mixed = claude.parse(
    line({
      type: 'user',
      timestamp: at,
      message: { role: 'user', content: 'looks good\n<task-notification><result>x</result></task-notification>' },
    }),
  )
  check('but the words beside one survive', mixed.length === 1 && mixed[0].text === 'looks good', JSON.stringify(mixed))
  const harness = claude.parse(
    line({
      type: 'user',
      timestamp: at,
      message: { role: 'user', content: '[SYSTEM NOTIFICATION - NOT USER INPUT]\nThis is an automated background-task event.' },
    }),
  )
  check('a harness injection that announces itself is believed', harness.length === 0, JSON.stringify(harness))

  // What the agent *said* crosses whole. A long answer used to stop at four
  // thousand characters with `… truncated`, which is the end of the reasoning
  // and the recommendation gone — the two parts the phone was opened for.
  const essay = 'x'.repeat(12_000)
  const long = claude.parse(
    line({ type: 'assistant', timestamp: at, message: { role: 'assistant', content: [{ type: 'text', text: essay }] } }),
  )
  check('a long answer is not cut short', long.length === 1 && long[0].text === essay, String(long[0]?.text?.length))
  const pasted = claude.parse(
    line({ type: 'user', timestamp: at, message: { role: 'user', content: essay } }),
  )
  check('nor is a long thing the person said', pasted.length === 1 && pasted[0].text === essay, String(pasted[0]?.text?.length))
  // The body behind a chip is a different animal: a log nobody scrolls to the
  // end of on a phone, and it stays capped.
  const dump = claude.parse(
    line({
      type: 'user',
      timestamp: at,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'y'.repeat(64 * 1024) }] },
    }),
  )
  check('but a huge tool result is still clamped', dump.length === 1 && dump[0].full.endsWith('… truncated'), String(dump[0]?.full?.length))
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
  // And the road to a worker is the same road: it exists because reading was
  // granted, so it closes when reading does rather than having a switch of its
  // own to be left on.
  const refusedRelay = await req('agents.relay', { id: `claude:${SESSION}`, agentId: 'w1', text: 'hello?' }).then(
    () => null,
    (e) => e.message,
  )
  check('agents.relay is refused while disabled', String(refusedRelay).includes('agent enable'), refusedRelay)
  const ignored = await hook('SessionStart')
  check('a hook is ignored while disabled', ignored.ok === false, ignored.error)

  // The picture door is the same gate: with agents off there is nothing on
  // this desktop that would ever read what a phone dropped there.
  const dropped = await fetch(`${base}/api/upload`, {
    method: 'POST',
    headers: {
      'x-oc-ticket': (await req('share.ticket', { use: 'upload' })).ticket,
      'x-oc-filename': 'shot.png',
      'x-oc-dest': 'agent',
    },
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
  const accepted = await hook('SessionStart', { ppid: standIn.pid })
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
check('no sessions before anything is discovered', real(empty.sessions).length === 0)

// Deliberately without `ppid`: the hook resolves a pid by walking up from the
// process that ran it, and this suite is very often run *by* a coding agent —
// which would hand the fake session the real agent's terminal and make the
// next check depend on whose machine it ran on. The writing section below
// names a pid outright instead.
const registered = await hook('SessionStart')
check('SessionStart registers a session', registered.ok === true && registered.id === `claude:${SESSION}`, registered.id)
check('a hook-registered session is announced', Boolean(await waitFor(events, (e) => e.kind === 'session' && e.id === `claude:${SESSION}`)))

const listed = await req('agents.list')
const session = real(listed.sessions)[0]
check('agents.list finds it', real(listed.sessions).length === 1 && session.state === 'idle', `${session?.title} · ${session?.state}`)
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

/* ── the status line ───────────────────────────────────────────────────── */

// None of this is asked of the agent: every figure is read off a file the CLI
// keeps for itself, which is why a phone can show a desktop session's status
// line with no cooperation from that session.
check('the session carries the model it is running as', session.vitals?.model === 'claude-opus-5', String(session.vitals?.model))
check(
  'and how full its context is, counting the cache',
  session.vitals?.context?.tokens === 100_000,
  String(session.vitals?.context?.tokens),
)
check('and the permission mode it is in', session.vitals?.mode === 'normal', String(session.vitals?.mode))
check('and the branch it is on', session.vitals?.branch === 'master', String(session.vitals?.branch))
check('the project is still said, now that the title may not say it', session.project === 'example', String(session.project))
check('a background agent is matched to the conversation it writes', session.job?.detail === 'reading the router', String(session.job?.detail))

check('the list carries what the plan has left', listed.limits?.limits?.[0]?.percent === 12, String(listed.limits?.limits?.[0]?.percent))
const limitsAnswer = await req('agents.limits')
check('and it can be asked for on its own', limitsAnswer.limits?.limits?.[0]?.kind === 'session')

/* ── skills and commands ───────────────────────────────────────────────── */

const offered = await req('agents.skills', { id: session.id })
check('the desktop lists the skills it has', offered.skills.some((s) => s.name === 'example-skill'))
check('and the built-ins worth a thumb', offered.builtins.some((b) => b.name === 'compact'))
check('the list is for the session\'s own directory', offered.cwd === CWD, String(offered.cwd))

// The name becomes a line of text in front of an agent that runs what it is
// told, so it is checked against the list we just published rather than
// forwarded hopefully.
const badCommand = await req('agents.command', { id: session.id, name: 'rm -rf /' }).catch((err) => err)
check('a name nobody published is refused', String(badCommand?.message || '').includes('does not have a command'), String(badCommand?.message))

/* ── conversations, running or not ─────────────────────────────────────── */

const history = await req('agents.history')
check('the conversations on disk are listed', history.sessions.some((e) => e.sessionId === SESSION), String(history.sessions.length))
const mine = history.sessions.find((e) => e.sessionId === SESSION)
check('an open one says so, and says which session it is', mine?.live === true && mine?.liveId === session.id)
check('the working directory is read off the file, not off the slug', mine?.cwd === CWD, String(mine?.cwd))

// What it is working on beats what it last did: a row that quotes the agent's
// own sentence about the work is one you can act on, and "Bash grep" is not.
check('the session says what it is working through', session.tasks?.active === 'Reading the router', String(session.tasks?.active))
const todo = await req('agents.tasks', { id: session.id })
check('and the list itself is one call away', todo.tasks?.[0]?.subject === 'Read the router', String(todo.total))

// A job whose process died still has a state file that says "blocked", and it
// says it for as long as the file sits on disk. The row may stay — it is a
// result worth reading — but it must not call itself running.
fs.mkdirSync(path.join(sandbox, '.claude', 'jobs', 'deadjob1'), { recursive: true })
fs.writeFileSync(
  path.join(sandbox, '.claude', 'jobs', 'deadjob1', 'state.json'),
  JSON.stringify({
    state: 'blocked',
    detail: 'awaiting a go-ahead that never came',
    tokens: 1,
    name: 'Dead job',
    sessionId: '99999999-8888-7777-6666-555555555555',
    cwd: CWD,
    updatedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
  }),
)

const jobs = await req('agents.jobs')
check('background agents are listed with what they are doing', jobs.jobs?.find((j) => j.id === JOB)?.detail === 'reading the router')
check('and the ones that are also live sessions say which', jobs.open?.[JOB] === session.id, JSON.stringify(jobs.open))
check('a job something is running calls itself live', jobs.jobs?.find((j) => j.id === JOB)?.live === true)
check(
  'a job whose agent is gone does not',
  jobs.jobs?.find((j) => j.id === 'deadjob1')?.live === false,
  JSON.stringify(jobs.jobs?.map((j) => [j.id, j.live])),
)

// Starting a process that was not there before is not the same decision as
// reading one somebody already started, so it has its own switch — and reading
// being on must not be enough.
const refused = await req('agents.spawn', { cwd: CWD }).catch((err) => err)
check('starting an agent is refused while its own switch is off', String(refused?.message || '').includes('agent spawn on'), String(refused?.message))

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
check('the status file tells the panel', status.agents.waiting === 1 && real(status.agents.sessions).length === 1)
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
// moving again is what has to clear `waiting` — the answer being written down
// now, which is why this line is stamped now rather than with the fixture's
// hour. A line older than the question is the case below.
fs.appendFileSync(
  transcript,
  line({ type: 'assistant', timestamp: now(), message: { role: 'assistant', content: [{ type: 'text', text: 'Running it now.' }] } }),
)
check('transcript activity clears a stale waiting', Boolean(await waitFor(events, (e) => e.kind === 'state' && e.state === 'working')))

/* ── the permission prompt, without the six-second wait ────────────────── */

// `Notification` holds a permission prompt back for an idle threshold before
// it says a word; `PermissionRequest` fires the moment the prompt exists, and
// carries the tool. Those seconds are the whole latency budget of a phone
// whose point is answering exactly this.
await hook('PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'rm -rf node_modules' }, permission_mode: 'default' })
const permission = await waitFor(events, (e) => e.kind === 'state' && e.state === 'waiting' && String(e.prompt || '').includes('rm -rf'))
check('a permission request means waiting the moment it is asked', Boolean(permission))
check(
  'and the prompt says which tool wants what',
  String(permission?.prompt || '').includes('Bash') && String(permission?.prompt || '').includes('rm -rf node_modules'),
  permission?.prompt,
)

// Approved at the keyboard, the tools run and the batch ends — the only hook
// that says anything between the answer and the end of the turn.
await hook('PostToolBatch')
check(
  'a finished tool batch clears a prompt answered at the keyboard',
  Boolean(await waitFor(events, (e) => e.kind === 'state' && e.state === 'working')),
)

// A mode that answers its own prompts draws nothing on screen.
await hook('PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'ls' }, permission_mode: 'bypassPermissions' })
await settle()
check(
  'a self-answering mode never says waiting',
  (await req('agents.list')).sessions.find((s) => s.id === `claude:${SESSION}`)?.state === 'working',
)

/* ── a card that stays up long enough to read ──────────────────────────── */

// The complaint this section is here for: a permission card that arrives on
// the phone and is gone about two seconds later. Two things were taking it
// down, and neither of them was an answer.
const stateOf = async () => (await req('agents.list')).sessions.find((s) => s.id === `claude:${SESSION}`)?.state

await hook('PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'rm -rf build' }, permission_mode: 'default' })
await waitFor(events, (e) => e.kind === 'state' && e.state === 'waiting' && String(e.prompt || '').includes('rm -rf build'))

// One: the turn that asks. The tool call is written to the transcript before
// the prompt is drawn — it is what the prompt is about — so the first tail
// read after the hook delivers a line that is *older* than the question, and
// it used to be read as the session moving on.
fs.appendFileSync(
  transcript,
  line({
    type: 'assistant',
    timestamp: now(-4000),
    message: { role: 'assistant', content: [{ type: 'text', text: 'Clearing the build directory.' }] },
  }),
)
await settle(2600)
check('a transcript line older than the question does not answer it', (await stateOf()) === 'waiting', await stateOf())

// Two: the workers. A subagent's tool calls fire these hooks under the
// session's own id and transcript — a sidechain has neither of its own — and
// `agent_id` is the only thing in the payload that says so. Five workers
// hammering tools is not an answer to the question their session is stopped
// at, and under `/loop` it was taking the card down every couple of seconds.
await hook('PostToolUse', { tool_name: 'Bash', tool_use_id: 'toolu_worker', agent_id: 'sub-9', agent_type: 'general-purpose' })
await hook('PostToolBatch', { agent_id: 'sub-9', agent_type: 'general-purpose' })
await settle()
check('a subagent at work does not answer its session\'s question', (await stateOf()) === 'waiting', await stateOf())

// And the answer still answers, from either end.
await hook('PostToolBatch')
check(
  'the session\'s own finished batch still clears the prompt',
  Boolean(await waitFor(events, (e) => e.kind === 'state' && e.state === 'working')),
  await stateOf(),
)

// The payload names its own kind these days, and the name outranks the
// sentence: a quota reset is news, not a session that needs anybody.
await hook('Notification', { message: 'Your limit has reset', notification_type: 'quota_auto_resume_fired' })
await settle()
check(
  'an unfamiliar notification type changes nothing',
  (await req('agents.list')).sessions.find((s) => s.id === `claude:${SESSION}`)?.state === 'working',
)

/* ── the fan-out ───────────────────────────────────────────────────────── */

// A desktop whose CLI never wrote a `subagents/` directory — every version
// before this one, and every session that never fanned out. The number, an
// empty list, and nothing anywhere that had to be caught.
const beforeWorkers = (await req('agents.list')).sessions.find((s) => s.id === `claude:${SESSION}`)
check('a session with no workers on disk lists none', beforeWorkers?.workers?.length === 0, JSON.stringify(beforeWorkers?.workers))

// Sidechain traffic is hidden from the chat on purpose, so the count of
// subagents is the only sign a session is more than one agent.
await hook('SubagentStart', { agent_type: 'general-purpose', agent_id: 'sub-1' })
await hook('SubagentStart', { agent_type: 'Explore', agent_id: 'sub-2' })
await settle()
check(
  'subagents are counted out',
  (await req('agents.list')).sessions.find((s) => s.id === `claude:${SESSION}`)?.subagents === 2,
)
await hook('SubagentStop', { agent_type: 'general-purpose', agent_id: 'sub-1' })
await hook('SubagentStop', { agent_type: 'Explore', agent_id: 'sub-2' })
await settle()
check(
  'and counted back in',
  (await req('agents.list')).sessions.find((s) => s.id === `claude:${SESSION}`)?.subagents === 0,
)

/* ── who the workers are ───────────────────────────────────────────────── */

// The count was the whole of it: "2 subagents", with no way to say what
// either one was doing, no way to open one, and nothing tying a worker to the
// `Agent` chip already sitting in its parent's chat. All of that is on disk,
// beside the parent's transcript, in `<session>/subagents/`.
const subagents = path.join(projects, SESSION, 'subagents')
fs.mkdirSync(subagents, { recursive: true })
const worker = (id, meta, lines) => {
  fs.writeFileSync(path.join(subagents, `agent-${id}.meta.json`), JSON.stringify(meta))
  fs.writeFileSync(path.join(subagents, `agent-${id}.jsonl`), lines.join(''))
}
const sidechain = (id, extra) => ({ isSidechain: true, agentId: id, ...extra })
worker('w1', { agentType: 'Explore', description: 'Read the router', toolUseId: 'toolu_agent1', spawnDepth: 1 }, [
  line(sidechain('w1', { type: 'user', timestamp: now(-60_000), message: { role: 'user', content: 'find the router' } })),
  line(
    sidechain('w1', {
      type: 'assistant',
      timestamp: now(-50_000),
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_w1a', name: 'Grep', input: { pattern: 'router', path: 'src' } }] },
    }),
  ),
  line(
    sidechain('w1', {
      type: 'user',
      timestamp: now(-49_000),
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_w1a', content: 'src/app.js:12\nsrc/app.js:40' }] },
    }),
  ),
  line(
    sidechain('w1', {
      type: 'assistant',
      timestamp: now(-40_000),
      message: { role: 'assistant', content: [{ type: 'text', text: 'The router is src/app.js:12.' }] },
    }),
  ),
])
worker('w2', { agentType: 'general-purpose', description: 'Draft the endpoint', toolUseId: 'toolu_agent2', spawnDepth: 1 }, [
  line(
    sidechain('w2', {
      type: 'assistant',
      timestamp: now(-3_600_000),
      message: { role: 'assistant', content: [{ type: 'text', text: 'Wrote GET /health.' }] },
    }),
  ),
])
// Nothing has written to w2's file for an hour. There is no completion marker
// anywhere in a worker's transcript, so that silence is the only thing that
// says it is over — and a worker that is over has to stay on the list.
const hourAgo = new Date(Date.now() - 3_600_000)
fs.utimesSync(path.join(subagents, 'agent-w2.jsonl'), hourAgo, hourAgo)

const fanned = (await req('agents.list')).sessions.find((s) => s.id === `claude:${SESSION}`)
check('a session says who its workers are', fanned?.workers?.length === 2, JSON.stringify(fanned?.workers?.map((w) => w.id)))
const w1 = fanned?.workers?.find((w) => w.id === 'w1')
const w2 = fanned?.workers?.find((w) => w.id === 'w2')
check('a worker carries its type and what it was sent to do', w1?.type === 'Explore' && w1?.description === 'Read the router', JSON.stringify(w1))
check('and the tool_use id of the Agent call that started it', w1?.ref === 'toolu_agent1', String(w1?.ref))
check('and the last thing it said', String(w1?.preview).includes('The router is src/app.js:12'), w1?.preview)
check('a worker still writing is running', w1?.running === true)
check('a worker that stopped stays on the list', Boolean(w2), JSON.stringify(fanned?.workers?.map((w) => w.id)))
check('and says it is not running any more', w2?.running === false, JSON.stringify(w2))
check('with the last thing it said still on it', String(w2?.preview).includes('Wrote GET /health'), w2?.preview)

// The one row rule. A worker has no session of its own and must never take a
// line beside the conversation it belongs to — including when a hook names
// the worker's own transcript, which is the one payload shape that could mint
// one by accident.
const rowsBefore = (await req('agents.list')).sessions.length
await hook('SubagentStart', { agent_type: 'Explore', agent_id: 'w1', transcript_path: path.join(subagents, 'agent-w1.jsonl') })
await settle()
const rowsAfter = await req('agents.list')
check(
  'a worker is never a row of its own',
  rowsAfter.sessions.length === rowsBefore && !rowsAfter.sessions.some((s) => s.id.includes('agent-')),
  rowsAfter.sessions.map((s) => s.id).join(' '),
)

// A stop this daemon was awake for is exact, and outranks the clock: w1's file
// was written a moment ago and would otherwise read as still running.
await hook('SubagentStop', { agent_type: 'Explore', agent_id: 'w1', transcript_path: path.join(subagents, 'agent-w1.jsonl') })
await settle()
const stopped = (await req('agents.list')).sessions.find((s) => s.id === `claude:${SESSION}`)
check(
  'a worker the stop hook named is done whatever its file says',
  stopped?.workers?.find((w) => w.id === 'w1')?.running === false,
  JSON.stringify(stopped?.workers?.find((w) => w.id === 'w1')),
)

// And reading one: the same blocks a chat is drawn from, because it is the
// same kind of file.
const readWorker = await req('agents.worker', { id: `claude:${SESSION}`, agentId: 'w1' })
check('a worker opens as a conversation', readWorker.blocks?.length === 4, readWorker.blocks?.map((b) => `${b.role}:${b.kind}`).join(' '))
check('what it said comes through', readWorker.blocks.some((b) => b.kind === 'text' && String(b.text).includes('The router is')))
check('and its tool calls, collapsed the usual way', readWorker.blocks.some((b) => b.kind === 'tool' && b.tool === 'Grep'))
const workerResult = readWorker.blocks.find((b) => b.kind === 'result')
const workerBody = await req('agents.detail', { id: `claude:${SESSION}`, seq: workerResult.seq, agentId: 'w1' })
check('the body behind a worker chip is one tap away', workerBody.text.includes('src/app.js:40'), workerBody.text)
const noWorker = await req('agents.worker', { id: `claude:${SESSION}`, agentId: 'nobody' }).catch((err) => err)
check('asking for a worker that is not there is a refusal, not a crash', String(noWorker?.message).includes('no such worker'), String(noWorker?.message))

/* ── answering a worker, through the session that holds it ─────────────── */

// A worker has no pty, so `agents.relay` writes to its parent instead. Both
// refusals are asserted before the road exists, because both are the shapes a
// phone can produce with nothing wrong on the desktop at all.
const relayNobody = await req('agents.relay', { id: `claude:${SESSION}`, agentId: 'nobody', text: 'hello?' })
  .then(() => null, (e) => e.message)
check('relaying to a worker this session never had is refused', String(relayNobody).includes('no such worker'), String(relayNobody))

// And the one that matters more: this session is in no terminal anybody can
// type into, so there is nowhere for the message to go. Accepting it would
// look, on the phone, exactly like delivering it.
const relayUnreachable = await req('agents.relay', { id: `claude:${SESSION}`, agentId: 'w1', text: 'stop and think' })
  .then(() => null, (e) => e.message)
check(
  'a session with no terminal cannot pass a message on',
  String(relayUnreachable).includes('terminal'),
  String(relayUnreachable),
)
const relayEmpty = await req('agents.relay', { id: `claude:${SESSION}`, agentId: 'w1', text: '   ' })
  .then(() => null, (e) => e.message)
check('an empty message is refused before anything else', String(relayEmpty).includes('nothing to send'), String(relayEmpty))

/* ── realtime usage off the status line ────────────────────────────────── */

// The cache file said 12% at whatever hour the CLI last felt like writing it.
// The status line says what the latest API response said, and the fresher
// figure has to be the one both the phone and the panel read.
const statuslineAck = await hook('StatusLine', {
  rate_limits: {
    five_hour: { used_percentage: 41.4, resets_at: Math.floor(Date.now() / 1000) + 3600 },
    seven_day: { used_percentage: 81.2, resets_at: Math.floor(Date.now() / 1000) + 86_400 },
  },
  context_window: { used_percentage: 37 },
})
check('the status line bridge is accepted', statuslineAck.ok === true)
const freshLimits = (await req('agents.limits')).limits
check(
  'its numbers override the cache where they are fresher',
  freshLimits?.limits?.find((l) => l.label === 'session')?.percent === 41,
  JSON.stringify(freshLimits?.limits),
)
check(
  'and add the windows the cache never had',
  freshLimits?.limits?.find((l) => l.label === 'week')?.percent === 81,
)
check('numbers straight off an API response are not stale', freshLimits?.stale === false)

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

  /* ── answering a worker ──────────────────────────────────────────────── */

  // Now that the session has a pane, the road to its workers exists: the
  // message is typed into the *parent's* composer with the worker named, and
  // what the pty receives is the proof, because the worker itself has no pty
  // to receive anything.
  const relayed = await req('agents.relay', { id: session.id, agentId: 'w1', text: 'подивись ще раз на роутер' })
  check('agents.relay reports the road the parent is on', relayed.ok === true && relayed.via === 'tmux', JSON.stringify(relayed))
  check('and says it is queued rather than delivered', relayed.queued === true && relayed.agentId === 'w1', JSON.stringify(relayed))
  check('and names the worker it is for', relayed.worker === 'Read the router', String(relayed.worker))
  await settle(500)
  const relayArrived = fs.readFileSync(received, 'utf8')
  check('the parent is asked by the worker\'s agentId', relayArrived.includes('subagent w1'), JSON.stringify(relayArrived.slice(-400)))
  check('and told to continue it rather than start another', /continue that agent/i.test(relayArrived), JSON.stringify(relayArrived.slice(-400)))
  check('with the message from the phone under it', relayArrived.includes('подивись ще раз на роутер'), JSON.stringify(relayArrived.slice(-400)))

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

  /* ── a block of several questions ends on a Return ───────────────────── */

  // `AskUserQuestion` may ask two or three things at once, and then the TUI
  // puts a tab of its own at the end of them — `Review your answers`, with
  // `Submit answers` waiting to be pressed. A digit on the last question picks
  // its option and walks onto that tab; it does not press it. So a block whose
  // last question is single-choice used to leave the agent standing on the
  // confirmation screen with nothing sent, while the phone ticked both cards
  // and called the session `working`. The last answer of a block ends with
  // Return whichever kind of question it is, and only that last answer moves
  // the session off `waiting`.
  const PAIR_ID = 'toolu_pair'
  const pairInput = {
    questions: [
      {
        question: 'Which colours should the theme use?',
        header: 'Colours',
        multiSelect: true,
        options: [{ label: 'Red' }, { label: 'Green' }, { label: 'Blue' }],
      },
      {
        question: 'And which shape?',
        header: 'Shape',
        multiSelect: false,
        options: [{ label: 'Circle' }, { label: 'Square' }, { label: 'Hexagon' }],
      },
    ],
  }
  await hook('PreToolUse', { tool_name: 'AskUserQuestion', tool_use_id: PAIR_ID, tool_input: pairInput })
  await settle(500)
  const pairBlock = (await req('agents.open', { id: session.id, limit: 200 })).blocks
    .find((b) => b.kind === 'question' && b.questions?.length === 2)
  check('a block of two questions arrives whole', Boolean(pairBlock), JSON.stringify(pairBlock?.questions?.length))
  check('and the session is waiting on it', (await stateOf()) === 'waiting', await stateOf())

  const beforePair = fs.readFileSync(received, 'utf8').length
  const firstOfTwo = await req('agents.answer', { id: session.id, seq: pairBlock.seq, question: 0, choices: [1, 3] })
  check('the first answer says it has not submitted the block', firstOfTwo.submitted === false, JSON.stringify(firstOfTwo.submitted))
  await settle(1200)
  // Nothing may have been sent yet: the pane is in canonical mode and the
  // walk off the checkboxes carries no Return.
  check(
    'answering the first question sends no Return',
    fs.readFileSync(received, 'utf8').length === beforePair,
    JSON.stringify(fs.readFileSync(received, 'utf8').slice(beforePair)),
  )
  check('and leaves the session waiting on the rest of the block', (await stateOf()) === 'waiting', await stateOf())

  const lastOfTwo = await req('agents.answer', { id: session.id, seq: pairBlock.seq, question: 1, choices: [2] })
  check('the last answer names what it picked', lastOfTwo.labels?.join() === 'Square', JSON.stringify(lastOfTwo.labels))
  check('and says it submitted the block', lastOfTwo.submitted === true, JSON.stringify(lastOfTwo.submitted))
  await settle(1600)
  const pairChord = fs.readFileSync(received, 'utf8').slice(beforePair)
  check(
    'a single-choice last question is a digit and the Return that submits',
    pairChord === '13\x1b[C2\n',
    JSON.stringify(pairChord),
  )
  await hook('PostToolUse', { tool_name: 'AskUserQuestion', tool_use_id: PAIR_ID, tool_input: pairInput })
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
      'x-oc-ticket': (await req('share.ticket', { use: 'upload' })).ticket,
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

  /* ── a message the agent never took ─────────────────────────────────── */

  // The bug this whole road was rewritten for: a picture and a caption make a
  // multi-line body, a multi-line body reaches a TUI as a bracketed paste, and
  // a TUI that swallowed the Return along with the paste left the message in
  // its own composer. Both halves of the write had succeeded, so the daemon
  // said `submitted: true` and flipped the row to `working` — and the phone,
  // which had already cleared its composer, had thrown away the only copy.
  //
  // `fake-tui.mjs --deaf` is a terminal that never submits anything, so what
  // is asserted here is the daemon's honesty rather than its typing.
  const deafLog = path.join(sandbox, 'deaf.log')
  fs.writeFileSync(deafLog, '')
  tmux(['new-session', '-d', '-s', 'oc-deaf', '-x', '100', '-y', '30', `${process.execPath} ${FAKE_TUI} ${deafLog} deaf 100`])
  await settle(600)
  const deafPanePid = Number(tmux(['list-panes', '-t', 'oc-deaf', '-F', '#{pane_pid}']))
  // tmux runs a command with no shell metacharacters in it directly, so the
  // pane's own process is already the fake TUI and there is no child to find.
  let deafPid = deafPanePid
  try {
    deafPid = Number(execFileSync('pgrep', ['-P', String(deafPanePid)], { encoding: 'utf8' }).trim().split('\n')[0]) || deafPanePid
  } catch {
    deafPid = deafPanePid
  }
  // The session moves to the pane its own hook says it is running in.
  await hook('UserPromptSubmit', { pid: deafPid })
  await hook('Stop')
  await settle(400)
  const beforeDeaf = (await req('agents.list')).sessions.find((s) => s.id === session.id)
  check('the session is on the deaf pane and not working', beforeDeaf?.state !== 'working', String(beforeDeaf?.state))

  const unheard = await req('agents.attach', { id: session.id, paths: [uploaded.path], text: 'did this land?' })
  check('a send that never left says so', unheard.submitted === false, JSON.stringify(unheard))
  await settle(300)
  const afterDeaf = (await req('agents.list')).sessions.find((s) => s.id === session.id)
  check('and the row does not claim the agent is working', afterDeaf?.state !== 'working', String(afterDeaf?.state))
  check('nothing was submitted to it', fs.readFileSync(deafLog, 'utf8') === '', JSON.stringify(fs.readFileSync(deafLog, 'utf8')))
  const deafScreen = await req('agents.screen', { id: session.id, lines: 20 })
  check('the message is still sitting in the composer', deafScreen.screen.includes('did this land?'))
  tmux(['kill-session', '-t', 'oc-deaf'])
  await settle(300)

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

/* ── answering, through the other multiplexer ──────────────────────────── */

// herdr owns its panes' ptys exactly as tmux owns its own, so the road is the
// same road and this is the same test: a real server, a real pane, and the
// bytes counted at the far end. What differs is how you ask — a socket rather
// than a command — and one thing that had to be proven rather than assumed,
// which is that a pane named in an environment is not a pane a process is in.
if (!hasHerdr) {
  console.log('  skip  herdr is not installed — the second writing road was not exercised')
} else {
  const server = spawn('herdr', ['server'], { env: herdrEnv, stdio: 'ignore' })
  for (let i = 0; i < 80 && !fs.existsSync(herdrSocket); i += 1) await settle(100)

  const received = path.join(sandbox, 'herdr-pane.txt')
  const pane = herdr(['workspace', 'create', '--cwd', sandbox, '--label', 'oc-test']).root_pane.pane_id
  herdr(['pane', 'run', pane, `cat > ${received}`])
  await settle(500)

  const shellPid = herdr(['pane', 'process-info', '--pane', pane]).process_info.shell_pid
  // The agent is a child of the shell herdr started in the pane — here, a
  // `cat`, which is as much as the writer ever needs to know about it.
  const agentPid = Number(execFileSync('pgrep', ['-P', String(shellPid)], { encoding: 'utf8' }).trim().split('\n')[0])

  await hook('UserPromptSubmit', { pid: agentPid })
  const found = (await req('agents.list')).sessions.find((s) => s.id === session.id)
  check('a session inside a herdr pane is answerable', found?.writable === 'herdr', `${found?.writable} ${found?.pane}`)
  check('and it names the pane herdr gave it', found?.pane === pane, `${found?.pane} vs ${pane}`)

  const sent = await req('agents.send', { id: session.id, text: 'так, продовжуй' })
  check('agents.send reports the herdr road', sent.ok === true && sent.via === 'herdr', JSON.stringify(sent))

  // The same three shapes the tmux road had to survive: text that is not
  // ASCII, a message with a newline in it, and a digit answering a prompt.
  await req('agents.send', { id: session.id, text: 'line one\nline two', submit: true })
  await req('agents.key', { id: session.id, key: '2' })
  await req('agents.key', { id: session.id, key: 'Enter' })
  await settle(500)

  const arrived = fs.readFileSync(received, 'utf8')
  check('the text reaches the far end of a herdr pty', arrived.includes('так, продовжуй'), JSON.stringify(arrived))
  check('utf-8 survives the socket', arrived.split('\n')[0] === 'так, продовжуй')
  check('a multi-line message stays one message here too', arrived.includes('line one\nline two'), JSON.stringify(arrived))
  check('a digit answers a numbered prompt', arrived.split('\n').includes('2'), JSON.stringify(arrived))

  const screen = await req('agents.screen', { id: session.id, lines: 20 })
  // Twenty lines of terminal, not twenty rows counted up from the bottom of a
  // window that is mostly blank — which is what herdr's own count means, and
  // what used to answer a freshly started agent with an empty screen.
  check('herdr hands over the raw screen as well', screen.screen.includes('line two'), screen.screen.split('\n').slice(-1)[0])
  check('and no more of it than was asked for', screen.screen.split('\n').length <= 20, String(screen.screen.split('\n').length))

  /* ── the claim that has to be checked ────────────────────────────────── */

  // An environment is inherited by everything a process starts and it outlives
  // the pane it describes, so `HERDR_PANE_ID` is a claim rather than an
  // answer. If it were taken at face value a message meant for one agent would
  // be typed into a stranger's terminal — which is the whole reason the claim
  // is checked against the pane's own process list before anybody writes.
  {
    const herdrMod = await import('../src/agents/herdr.js')
    const impostor = spawn('sleep', ['30'], {
      env: { ...cleanEnv, HERDR_PANE_ID: pane, HERDR_SOCKET_PATH: herdrSocket },
      stdio: 'ignore',
    })
    await settle(250)
    check('a pane named in an inherited environment is read', herdrMod.claimed(impostor.pid)?.pane === pane)
    check(
      'but a process that is not in that pane is not offered it',
      (await herdrMod.locate(impostor.pid, [impostor.pid])) === null,
    )
    check(
      'while the agent that really is in it keeps it',
      (await herdrMod.locate(agentPid, [agentPid, shellPid]))?.pane === pane,
    )
    impostor.kill()
  }

  // A server that has gone takes its panes with it, and every composer that
  // was pointed at one. Nothing on this desktop can type into a pty that no
  // longer exists, and a phone must be told so rather than shown a text field.
  try {
    herdr(['server', 'stop'])
  } catch {
    server.kill()
  }
  await settle(500)
  await req('agents.list')
  const stranded = (await req('agents.list')).sessions.find((s) => s.id === session.id)
  check('a herdr server that has gone takes the composer with it', !stranded || stranded.writable !== 'herdr', String(stranded?.writable))
  server.kill()
}

// The rest of this file is about a live session again, so announce one: the
// hook road is how a real agent says which process it is, and the stand-in is
// a process that is certainly running — and, unlike this runner, one whose
// environment names no terminal anybody is sitting at.
await hook('UserPromptSubmit', { pid: standIn.pid })

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

/* ── coming back after a reconnect ─────────────────────────────────────── */

// The phone re-opens every session it has on screen as soon as the link is
// back, because the desktop stopped tailing them when the socket died. Doing
// that without a cursor means refetching the whole window over a link that has
// only just returned, so `agents.open` takes one.
const settled = await req('agents.open', { id: session.id, limit: 200, since: afterAnswer.cursor, epoch: afterAnswer.epoch })
check('a resume from the current cursor brings nothing back', settled.resumed === true && settled.blocks.length === 0,
  `resumed=${settled.resumed} blocks=${settled.blocks.length}`)
check('and the cursor has not moved', settled.cursor === afterAnswer.cursor, `${settled.cursor} vs ${afterAnswer.cursor}`)

fs.appendFileSync(
  transcript,
  line({ type: 'user', timestamp: at, message: { role: 'user', content: 'and now write the tests' } }),
)
await settle(600)
const resumed = await req('agents.open', { id: session.id, limit: 200, since: settled.cursor, epoch: settled.epoch })
check(
  'a resume brings back only what arrived while the phone was away',
  resumed.resumed === true && resumed.blocks.length === 1 && JSON.stringify(resumed.blocks).includes('write the tests'),
  `${resumed.blocks.length} blocks`,
)
check('every block it does bring is past the cursor', resumed.blocks.every((b) => b.seq > settled.cursor))
check(
  'a cursor without the numbering it came from is not a cursor',
  (await req('agents.open', { id: session.id, limit: 200, since: settled.cursor })).resumed === false,
)
check(
  'nor is one from somebody else\'s numbering',
  (await req('agents.open', { id: session.id, limit: 200, since: settled.cursor, epoch: 'deadbeef.0' })).resumed === false,
)
check('and the cursor moves on', resumed.cursor > settled.cursor, `${settled.cursor} → ${resumed.cursor}`)

// The whole window, for comparison — and for the phone that has no cursor.
const whole = await req('agents.open', { id: session.id, limit: 200 })
check('an open without a cursor is the reload it always was',
  whole.resumed === false && whole.blocks.length > resumed.blocks.length, `${whole.blocks.length} blocks`)
check(
  'a cursor from the future is answered with the window rather than nothing',
  (await req('agents.open', { id: session.id, limit: 200, since: whole.cursor + 1000, epoch: whole.epoch })).resumed === false,
)
check(
  'so is one from before the ring starts',
  (await req('agents.open', { id: session.id, limit: 200, since: 0, epoch: whole.epoch })).blocks.length === whole.blocks.length,
)
// Five opens above the one the screen holds; the tail must not be left with a
// reference count that keeps it open after the screen closes.
for (let i = 0; i < 7; i += 1) await req('agents.close', { id: session.id })

await req('agents.close', { id: session.id })
const before = events.length
await hook('SessionEnd')
await settle(400)
check('SessionEnd ends it', real((await req('agents.list')).sessions).length === 0)
// A list driven by events has to end up where a fresh `agents.list` would: a
// session frame after the state change would put the finished session back.
check(
  'nothing re-announces a finished session',
  !events.slice(before).some((e) => e.kind === 'session' && !e.removed),
  events.slice(before).map((e) => e.kind).join(' '),
)

close()

/* ── the phone drops off the network for a moment ──────────────────────── */

// The reason `agents.open` takes a cursor at all. A dropped socket takes the
// last subscriber off the `agent` bus, and the desktop stops tailing every
// session it was tailing for that phone — which is right, nobody is reading
// them. What was wrong was throwing away what the phone already had along with
// the tail: block numbering restarted from zero, so the re-open on the way
// back could only ever be a full reload of a conversation that had not changed.
{
  const B = '99999999-8888-7777-6666-555555555555'
  const transcriptB = path.join(projects, `${B}.jsonl`)
  fs.writeFileSync(
    transcriptB,
    [line({ type: 'user', timestamp: at, message: { role: 'user', content: 'first thing' } })].join(''),
  )
  await hook('SessionStart', { session_id: B, transcript_path: transcriptB })

  const before = await connect(token)
  const opened = await before.req('agents.open', { id: `claude:${B}`, limit: 200, since: null })
  check('a session opens on the first phone', opened.blocks.length === 1 && opened.resumed === false, `${opened.blocks.length} blocks`)

  before.close()
  // Longer than the poll that notices the bus has gone quiet.
  await settle(3000)
  fs.appendFileSync(
    transcriptB,
    line({ type: 'user', timestamp: at, message: { role: 'user', content: 'said while nobody was listening' } }),
  )
  await settle(500)

  const after = await connect(token)
  const resumed = await after.req('agents.open', { id: `claude:${B}`, limit: 200, since: opened.cursor, epoch: opened.epoch })
  check(
    'a phone that comes back resumes rather than reloading',
    resumed.resumed === true && resumed.blocks.length === 1,
    `resumed=${resumed.resumed} ${resumed.blocks.length} blocks`,
  )
  check(
    'and what it gets is what it missed',
    JSON.stringify(resumed.blocks).includes('said while nobody was listening'),
  )
  // The tail has to be running again, or the resume would be the last thing
  // the phone ever heard about this session.
  fs.appendFileSync(
    transcriptB,
    line({ type: 'user', timestamp: at, message: { role: 'user', content: 'and now it is listening' } }),
  )
  check(
    'the desktop is tailing it again without being asked twice',
    Boolean(await waitFor(after.events, (e) => e.kind === 'blocks' && JSON.stringify(e.blocks).includes('and now it is listening'))),
  )
  await after.req('agents.close', { id: `claude:${B}` })
  await hook('SessionEnd', { session_id: B, transcript_path: transcriptB })
  after.close()
}

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
      env: { ...cleanEnv, HOME: sandbox, XDG_CONFIG_HOME: sandbox, OMARCHY_CONNECT_STATE: path.join(sandbox, 'state') },
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
