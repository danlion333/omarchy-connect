/**
 * The shell on the desktop the phone types into, against a real tmux.
 *
 * There is no point mocking any of this. The whole feature is a claim about
 * somebody else's pty — that bytes put in arrive, that what comes back is what
 * the terminal actually shows, that the window is the width the phone asked
 * for and not eighty columns — and none of those claims can be checked against
 * a stand-in that agrees with us by construction. So the suite runs a real
 * tmux server inside its own `TMUX_TMPDIR`, drives it through a real daemon
 * over a real encrypted socket, and says out loud when tmux is missing rather
 * than passing quietly.
 *
 * The first thing it asserts is the gate: a paired phone gets nothing at all
 * until somebody at the desktop has said `omarchy-connect terminal on`.
 */
import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { check, done } from '../../tools/test-harness.mjs'
import { connectPhone } from './phone.mjs'
import { localHeaders } from './sandbox.mjs'

const PORT = Number(process.env.PORT || 8813)
const base = `http://127.0.0.1:${PORT}`
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'omarchy-connect-terminal-'))
const local = () => localHeaders(path.join(sandbox, 'state'))

const hasTmux = (() => {
  try {
    execFileSync('which', ['tmux'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

if (!hasTmux) {
  console.log('  skip  tmux is not installed — the desktop shell was not exercised')
  done('desktop shell checks')
}

/**
 * The suite is very likely being run from inside a tmux session of the
 * person's own, and `TMUX`/`TMUX_PANE` in the environment would point every
 * command below at their server — where this suite would then make, resize and
 * kill a session called `oc-term`. Both variables go, and `TMUX_TMPDIR` puts
 * the daemon's server in the sandbox where nobody else is attached.
 */
const cleanEnv = { ...process.env }
for (const key of ['TMUX', 'TMUX_PANE', 'HERDR_SOCKET_PATH']) delete cleanEnv[key]

const daemonEnv = {
  ...cleanEnv,
  HOME: sandbox,
  XDG_CONFIG_HOME: sandbox,
  XDG_CACHE_HOME: path.join(sandbox, '.cache'),
  OMARCHY_CONNECT_STATE: path.join(sandbox, 'state'),
  OMARCHY_CONNECT_LOG: 'warn',
  TMUX_TMPDIR: sandbox,
}

const tmux = (args) => execFileSync('tmux', args, { env: daemonEnv, encoding: 'utf8' }).trim()

/** The session names on the sandbox server — empty when there is no server. */
const sessions = () => {
  try {
    return tmux(['list-sessions', '-F', '#{session_name}']).split('\n').filter(Boolean)
  } catch {
    return []
  }
}

const settle = (ms = 300) => new Promise((r) => setTimeout(r, ms))

function writeConfig(enabled) {
  const dir = path.join(sandbox, 'omarchy-connect')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'config.json'),
    JSON.stringify(
      {
        version: 1,
        port: PORT,
        deviceName: 'terminal-test',
        terminal: { enabled },
        agents: { enabled: false, spawn: false },
        // Same reason as every other suite — see `sandbox.mjs`.
        handsfree: { autoConnect: 'off', address: null },
        ringtone: { enabled: false, sound: null },
        devices: [],
      },
      null,
      2,
    ),
  )
}

const storedConfig = () => JSON.parse(fs.readFileSync(path.join(sandbox, 'omarchy-connect', 'config.json'), 'utf8'))

let daemon = null

async function startDaemon(enabled) {
  writeConfig(enabled)
  daemon = spawn(process.execPath, [path.join(root, 'bin', 'omarchy-connect.js'), 'start', '--port', String(PORT)], {
    env: daemonEnv,
    stdio: ['ignore', 'ignore', 'inherit'],
  })
  for (let i = 0; i < 40; i += 1) {
    try {
      if ((await fetch(`${base}/api/info`)).ok) return
    } catch {
      await settle(250)
    }
  }
  throw new Error('daemon did not start')
}

process.on('exit', () => {
  daemon?.kill('SIGTERM')
  try {
    execFileSync('tmux', ['kill-server'], { env: daemonEnv, stdio: 'ignore' })
  } catch {
    /* there may be no server left to kill, which is the tidy case */
  }
  fs.rmSync(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

/** A paired phone, its request table and its log of `terminal` events. */
async function connect(known = null) {
  const info = await (await fetch(`${base}/api/info`)).json()
  const pair = known ? { code: null } : await (await fetch(`${base}/api/pair-code`, { method: 'POST', headers: local() })).json()
  const phone = connectPhone(PORT, info.publicKey)
  const pending = new Map()
  const events = []
  let seq = 0
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
          device: { id: 'terminal-test', name: 'Terminal Phone', platform: 'android' },
        }),
      )
      .catch(reject)
    phone.on((msg) => {
      if (msg.t === 'paired') token = msg.token
      if (msg.t === 'hello.ok') resolve(msg)
      if (msg.t === 'hello.err') reject(new Error(msg.error))
      if (msg.t === 'ev' && msg.event === 'terminal') events.push({ ...msg.data, at: Date.now() })
      if (msg.t === 'res') {
        const p = pending.get(msg.id)
        if (!p) return
        pending.delete(msg.id)
        msg.ok ? p.resolve(msg.data) : p.reject(new Error(msg.error))
      }
    })
    phone.ws.on('error', reject)
  })

  phone.send({ t: 'sub', events: ['terminal'] })
  await settle(150)
  return { hello, token, req, events, close: () => phone.ws.close() }
}

const refused = (promise) => promise.then(() => null, (err) => err.message)

const waitFor = async (fn, ms = 5000) => {
  const until = Date.now() + ms
  for (;;) {
    const found = await fn()
    if (found) return found
    if (Date.now() > until) return null
    await settle(80)
  }
}

/* ── the gate ──────────────────────────────────────────────────────────── */

await startDaemon(false)
let phone = await connect()

check('the shell is off out of the box', phone.hello.capabilities?.terminal?.enabled === false, JSON.stringify(phone.hello.capabilities?.terminal))
check('and the desktop still says whether it could run one', phone.hello.capabilities?.terminal?.available === true)

for (const [method, params] of [
  ['terminal.open', { cols: 48, rows: 30 }],
  ['terminal.type', { text: 'ls' }],
  ['terminal.key', { key: 'Enter' }],
  ['terminal.attach', {}],
  ['terminal.close', {}],
]) {
  const why = await refused(phone.req(method, params))
  check(`${method} is refused while the switch is off`, /omarchy-connect terminal on/.test(why || ''), String(why))
}

check('and no shell was opened behind the refusal', !sessions().includes('oc-term'), sessions().join())

/* ── the CLI flips it on a running daemon ──────────────────────────────── */

const cli = (args) =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(root, 'bin', 'omarchy-connect.js'), ...args], { env: daemonEnv })
    let out = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (c) => (out += c))
    child.stderr.on('data', (c) => (out += c))
    child.on('exit', (code) => resolve({ code, out }))
  })

const off = await cli(['terminal', 'status'])
check('terminal status says off before anybody asked for it', /STATE[\s\S]*?off/i.test(off.out), off.out.trim().split('\n').slice(0, 3).join(' / '))

const on = await cli(['terminal', 'on'])
check('terminal on exits clean', on.code === 0, on.out.trim())
check('and writes the switch to the config', storedConfig().terminal?.enabled === true)
check('and did not have to tell anyone to restart', !/restart/.test(on.out), on.out.trim())

const control = await waitFor(async () => phone.events.find((e) => e.kind === 'control'))
check('the already-connected phone is told the switch moved', control?.enabled === true, JSON.stringify(control))

const shown = await cli(['terminal', 'status'])
check('terminal status says on afterwards', /STATE[\s\S]*?on/i.test(shown.out), shown.out.trim().split('\n').slice(0, 3).join(' / '))

/* ── opening ───────────────────────────────────────────────────────────── */

const opened = await phone.req('terminal.open', { cols: 48, rows: 30 })
check('open answers with a screen, a directory and what it is doing', typeof opened.screen === 'string' && typeof opened.cwd === 'string' && typeof opened.running === 'boolean', JSON.stringify({ ...opened, screen: undefined }))
check('the session starts in the home directory', opened.cwd === sandbox, `${opened.cwd} vs ${sandbox}`)
check('a fresh shell is not running anything', opened.running === false)

// The whole reason the phone sends its size: `ls` and `git status` have to
// wrap to the handset rather than to somebody's eighty columns.
const width = () => tmux(['display-message', '-p', '-t', 'oc-term:', '#{pane_width}x#{pane_height}'])
check('the window is the size the phone asked for', width() === '48x30', width())

const again = await phone.req('terminal.open', { cols: 48, rows: 30 })
check('opening again comes back to the same session', typeof again.screen === 'string' && sessions().filter((n) => n === 'oc-term').length === 1, sessions().join())

const wider = await phone.req('terminal.open', { cols: 80, rows: 24 })
check('a phone that turned sideways resizes the session it already had', wider.cols === 80 && width() === '80x24', width())
await phone.req('terminal.open', { cols: 48, rows: 30 })

/* ── typing, reading, and what it is doing ─────────────────────────────── */

await phone.req('terminal.type', { text: 'cd /tmp && echo hi' })
await phone.req('terminal.key', { key: 'Enter' })

const said = await waitFor(async () => {
  const state = await phone.req('terminal.open', { cols: 48, rows: 30 })
  return state.screen.includes('hi') && state.cwd === '/tmp' ? state : null
})
check('what the phone typed ran, and its output is on the screen', Boolean(said), said ? said.screen.split('\n').slice(-3).join(' | ') : 'never appeared')
check('and the shell says where it now is', said?.cwd === '/tmp', String(said?.cwd))

await phone.req('terminal.type', { text: 'sleep 3' })
await phone.req('terminal.key', { key: 'Enter' })
const busy = await waitFor(async () => {
  const state = await phone.req('terminal.open', { cols: 48, rows: 30 })
  return state.running ? state : null
}, 3000)
check('a command that is still going reads as running', Boolean(busy), JSON.stringify({ ...busy, screen: undefined }))
const idle = await waitFor(async () => {
  const state = await phone.req('terminal.open', { cols: 48, rows: 30 })
  return state.running === false ? state : null
}, 8000)
check('and the prompt comes back when it is over', Boolean(idle))

const bigger = await refused(phone.req('terminal.type', { text: 'x'.repeat(5000) }))
check('an oversized paste is refused rather than pushed at a shell', /too much text/.test(bigger || ''), String(bigger))
const badKey = await refused(phone.req('terminal.key', { key: 'C-z; rm -rf /' }))
check('a key outside the list is refused rather than forwarded', /cannot be sent/.test(badKey || ''), String(badKey))

/* ── the screen is pushed, not polled ──────────────────────────────────── */

phone.events.length = 0
await phone.req('terminal.open', { cols: 48, rows: 30 })
phone.events.length = 0

await phone.req('terminal.type', { text: 'echo pushed-to-the-phone' })
await phone.req('terminal.key', { key: 'Enter' })
const typedAt = Date.now()
const pushed = await waitFor(async () => phone.events.find((e) => e.kind === 'screen' && e.screen.includes('pushed-to-the-phone')), 3000)
check('a phone watching the shell is pushed the new screen', Boolean(pushed), JSON.stringify(phone.events.map((e) => e.kind)))
check('inside half a second of the pane printing it', pushed && pushed.at - typedAt < 500, pushed ? `${pushed.at - typedAt}ms` : 'never')
check('and the push carries the directory and the state with it', pushed?.cwd === '/tmp' && pushed?.running === false, JSON.stringify({ cwd: pushed?.cwd, running: pushed?.running }))

// A terminal is quiet for minutes at a time, and a quiet terminal must cost
// the phone nothing at all.
phone.events.length = 0
await settle(1000)
check('a quiet second is a second with nothing on the wire', phone.events.length === 0, JSON.stringify(phone.events.map((e) => e.kind)))

/**
 * Nobody looking, nothing read.
 *
 * `terminal.close` is the phone leaving the screen, and from there the pane
 * can print whatever it likes: the watcher is not running, so nothing is
 * captured and nothing goes on the wire. What comes back when the phone
 * returns is the second half of the same claim — the desktop was not keeping
 * up with the pane, and it does not need to have been.
 */
await phone.req('terminal.close')
await settle(600)
phone.events.length = 0
tmux(['send-keys', '-t', 'oc-term:', '-l', 'echo nobody-is-watching'])
tmux(['send-keys', '-t', 'oc-term:', 'Enter'])
await settle(900)
check('a screen nobody has open is not pushed', phone.events.length === 0, JSON.stringify(phone.events.map((e) => e.kind)))
const reopened = await phone.req('terminal.open', { cols: 48, rows: 30 })
check('and coming back shows everything that happened meanwhile', reopened.screen.includes('nobody-is-watching'), reopened.screen.split('\n').slice(-3).join(' | '))

/* ── the session outlives the phone, and dies when the shell does ──────── */

await phone.req('terminal.type', { text: 'exit' })
await phone.req('terminal.key', { key: 'Enter' })
const gone = await waitFor(async () => (sessions().includes('oc-term') ? null : true), 5000)
check('exiting the shell ends the session', Boolean(gone), sessions().join())
const remade = await phone.req('terminal.open', { cols: 48, rows: 30 })
check('and the next open starts a new one rather than failing', typeof remade.screen === 'string' && remade.cwd === sandbox, JSON.stringify({ ...remade, screen: undefined }))

/* ── attach ────────────────────────────────────────────────────────────── */

// `omarchy-launch-terminal` is Omarchy's own opener and is not necessarily on
// the machine running this suite, so what is asserted here is the command the
// daemon hands it — with a stub standing in for the terminal emulator, which
// is the one part of this a test cannot see the far end of.
{
  const bin = path.join(sandbox, 'bin')
  fs.mkdirSync(bin, { recursive: true })
  const launched = path.join(sandbox, 'launched.log')
  fs.writeFileSync(
    path.join(bin, 'omarchy-launch-terminal'),
    `#!/bin/bash\nprintf '%s\\n' "$*" >> ${JSON.stringify(launched)}\nexec "$@" < /dev/null > /dev/null 2>&1\n`,
    { mode: 0o755 },
  )
  // The daemon caches PATH lookups on first use, so the stub has to be there
  // before this daemon ever asked — which means a daemon started with it.
  daemon.kill('SIGTERM')
  await new Promise((resolve) => daemon.on('exit', resolve))
  daemon = null
  const withStub = { ...daemonEnv, PATH: `${bin}:${daemonEnv.PATH}` }
  daemon = spawn(process.execPath, [path.join(root, 'bin', 'omarchy-connect.js'), 'start', '--port', String(PORT)], {
    env: withStub,
    stdio: ['ignore', 'ignore', 'inherit'],
  })
  for (let i = 0; i < 40; i += 1) {
    try {
      if ((await fetch(`${base}/api/info`)).ok) break
    } catch {
      await settle(250)
    }
  }
  phone.close()
  phone = await connect(phone.token)
  check('the switch survived the restart', phone.hello.capabilities?.terminal?.enabled === true)

  await phone.req('terminal.open', { cols: 48, rows: 30 })
  await phone.req('terminal.type', { text: 'echo from-phone' })
  await phone.req('terminal.key', { key: 'Enter' })
  await settle(400)

  const attached = await phone.req('terminal.attach')
  check('attach names the session it opened', attached.session === 'oc-term', JSON.stringify(attached))
  const line = await waitFor(async () => {
    try {
      return fs.readFileSync(launched, 'utf8').trim() || null
    } catch {
      return null
    }
  }, 4000)
  check('the desktop terminal is asked to attach to that same session', line === 'tmux attach -t oc-term', String(line))

  // The real client is what sizes the window from here: a session pinned to a
  // phone's 48 columns inside a 200-column window is not one anybody wants to
  // sit in at the desk.
  check(
    'and the window is handed back to whoever attaches',
    tmux(['show-options', '-w', '-t', 'oc-term:', 'window-size']).includes('latest'),
    tmux(['show-options', '-w', '-t', 'oc-term:', 'window-size']),
  )

  // What the phone typed is in that session's scrollback, which is the whole
  // promise of attaching: it is picked up where it was left, not restarted.
  const scrollback = tmux(['capture-pane', '-p', '-t', 'oc-term:', '-S', '-100'])
  check('what was typed from the phone is there for the person at the desk', scrollback.includes('from-phone'), scrollback.split('\n').filter(Boolean).slice(-2).join(' | '))
}

/* ── turning it off again ──────────────────────────────────────────────── */

phone.events.length = 0
const backOff = await cli(['terminal', 'off'])
check('terminal off exits clean', backOff.code === 0, backOff.out.trim())
const told = await waitFor(async () => phone.events.find((e) => e.kind === 'control'))
check('and the phone is told it lost the shell', told?.enabled === false, JSON.stringify(told))
const shut = await refused(phone.req('terminal.type', { text: 'echo no' }))
check('after which typing is refused again', /omarchy-connect terminal on/.test(shut || ''), String(shut))
check('but the session at the desk is left standing', sessions().includes('oc-term'), sessions().join())

phone.close()
done('desktop shell checks')
