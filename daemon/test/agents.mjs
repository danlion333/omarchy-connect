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
    JSON.stringify({ version: 1, port: PORT, deviceName: 'agents-test', agents: { enabled, spawn: false }, devices: [] }, null, 2),
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
  return { hello, req, events, close: () => phone.ws.close() }
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

/* ── the gate ──────────────────────────────────────────────────────────── */

await startDaemon(false)
{
  const { hello, req, events, close } = await connect()
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
const { hello, req, events, close } = await connect()
check('capabilities say agents are on', hello.capabilities.agents?.enabled === true, (hello.capabilities.agents?.adapters || []).join(' '))
check(
  'capabilities name the road into a terminal',
  hello.capabilities.agents?.write === (hasTmux ? 'tmux' : hello.capabilities.agents?.write),
  String(hello.capabilities.agents?.write),
)
check('capabilities list the keys a phone may press', (hello.capabilities.agents?.keys || []).includes('Escape'))

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

// Answering at the keyboard fires no hook we subscribe to, so the transcript
// moving again is what has to clear `waiting`.
fs.appendFileSync(
  transcript,
  line({ type: 'assistant', timestamp: at, message: { role: 'assistant', content: [{ type: 'text', text: 'Running it now.' }] } }),
)
check('transcript activity clears a stale waiting', Boolean(await waitFor(events, (e) => e.kind === 'state' && e.state === 'working')))

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

  tmux(['kill-session', '-t', 'oc-test'])
  await settle(300)
  await req('agents.list')
  const orphaned = (await req('agents.list')).sessions.find((s) => s.id === session.id)
  // The pane is gone and so is the `cat` inside it; whatever is left of the
  // session must not still be advertising a composer.
  check('a closed pane takes the composer with it', !orphaned || orphaned.writable !== 'tmux', String(orphaned?.writable))
}

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
