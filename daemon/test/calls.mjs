/**
 * Call control: the two roads, and the choice between them.
 *
 * The Bluetooth half cannot be exercised end to end without a handset in the
 * room, so what is tested here is everything around it — that the daemon falls
 * back to the app when no gateway is connected, that it refuses honestly when
 * neither road is open, that an instruction the phone never answers times out
 * rather than hanging, and that the hands-free client itself reads the live
 * D-Bus surface correctly on a machine that has one.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { connectPhone } from './phone.mjs'
import { handsfree } from '../src/lib/handsfree.js'

const PORT = Number(process.env.PORT || 8797)
const base = `http://127.0.0.1:${PORT}`
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'omarchy-connect-calls-'))

/**
 * A stand-in for libnotify, ahead of the real one on PATH.
 *
 * Two reasons. A test that mirrors a ringing call would otherwise throw a real
 * urgent notification onto the screen of whoever is running it — and hold it
 * there for the full forty-five seconds, because an actionable notification
 * waits for a click. And faking it turns a side effect nobody could assert on
 * into a log this test can read: what the desktop was actually asked to show,
 * and whether it offered the buttons.
 *
 * Printing the action name is what `notify-send --help` says a click does, so
 * this also drives the answer path end to end.
 */
const notifyLog = path.join(sandbox, 'notify.log')
const fakeBin = path.join(sandbox, 'bin')
fs.mkdirSync(fakeBin, { recursive: true })
fs.writeFileSync(
  path.join(fakeBin, 'notify-send'),
  `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(notifyLog)}\n`,
  { mode: 0o755 },
)

const daemon = spawn(
  process.execPath,
  [path.join(root, 'bin', 'omarchy-connect.js'), 'start', '--port', String(PORT)],
  {
    env: {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH}`,
      XDG_CONFIG_HOME: sandbox,
      OMARCHY_CONNECT_STATE: path.join(sandbox, 'state'),
      OMARCHY_CONNECT_LOG: 'error',
    },
    stdio: ['ignore', 'ignore', 'inherit'],
  },
)
process.on('exit', () => {
  daemon.kill('SIGTERM')
  fs.rmSync(sandbox, { recursive: true, force: true })
})

for (let i = 0; i < 40; i += 1) {
  try {
    if ((await fetch(`${base}/api/info`)).ok) break
  } catch {
    await new Promise((r) => setTimeout(r, 250))
  }
}

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`)
}
const post = async (pathname, body) => {
  const res = await fetch(`${base}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: res.status, data: await res.json() }
}

/* ── the hands-free client, against this machine's real PipeWire ────────── */

const supported = await handsfree.probe()
check(
  'handsfree probes the session bus',
  typeof supported === 'boolean',
  supported ? 'org.pipewire.Telephony is published here' : 'no telephony API on this machine',
)

if (supported) {
  const state = await handsfree.read()
  check('handsfree reads GetManagedObjects', state.available === true && Array.isArray(state.calls))
  check(
    'a gateway is reported only when one is connected',
    state.gateway === null || typeof state.gateway.path === 'string',
    state.gateway ? state.gateway.address : 'nothing paired',
  )
  const summary = handsfree.summary()
  check('summary has the shape the panel reads', 'connected' in summary && 'call' in summary && 'audio' in summary)
}

// Whatever the machine, asking to act on a call that is not there must be an
// error rather than a silent no-op.
handsfree.state = { available: true, gateway: null, calls: [] }
let refused = ''
try {
  await handsfree.answer()
} catch (err) {
  refused = err.message
}
check('answering nothing is refused', /no call is ringing/.test(refused), refused)

refused = ''
try {
  await handsfree.dial('123')
} catch (err) {
  refused = err.message
}
check('dialling with no gateway is refused', /no phone is connected/.test(refused), refused)

// The picker is what decides which call an unqualified `answer` acts on: a
// ringing one always outranks one already in progress.
handsfree.state = {
  available: true,
  gateway: { path: '/ag1', address: 'AA', audio: 'active' },
  calls: [
    { path: '/ag1/call1', id: 'call1', state: 'active', from: '+111', name: null },
    { path: '/ag1/call2', id: 'call2', state: 'incoming', from: '+222', name: null },
  ],
}
check('a ringing call outranks one in progress', handsfree.pick()?.id === 'call2', handsfree.pick()?.id)
check('an explicit id still wins', handsfree.pick('call1')?.id === 'call1')
handsfree.state = { available: false, gateway: null, calls: [] }

/* ── the app road ───────────────────────────────────────────────────────── */

// Nothing connected at all: neither Bluetooth nor a socket.
const orphan = await post('/api/call', { op: 'answer' })
check('answering with nothing connected fails cleanly', orphan.status === 400, orphan.data.error)

const nonsense = await post('/api/call', { op: 'teleport' })
check('an unknown action is refused', nonsense.status === 400, nonsense.data.error)

const info = await (await fetch(`${base}/api/info`)).json()
const code = (await (await fetch(`${base}/api/pair-code`, { method: 'POST' })).json()).code
const phone = connectPhone(PORT, info.publicKey)

const pending = new Map()
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
      phone.send({
        t: 'hello',
        pairCode: code,
        device: { id: 'calls-test-device', name: 'Test phone', platform: 'android', model: 'Test' },
      }),
    )
    .catch(reject)
  phone.on((msg) => {
    if (msg.t === 'hello.ok') resolve(msg)
    if (msg.t === 'hello.err') reject(new Error(msg.error))
    if (msg.t === 'res') {
      const p = pending.get(msg.id)
      if (!p) return
      pending.delete(msg.id)
      msg.ok ? p.resolve(msg.data) : p.reject(new Error(msg.error))
    }
  })
})
check('the test phone paired', hello.protocol === 2, hello.device?.name)
check('the daemon advertises call control', hello.capabilities?.phone?.answer === true)
phone.send({ t: 'sub', events: ['phone'] })

/**
 * Stand in for the app: one listener for the whole run, answering each
 * instruction the way the next test says to. One rather than one-per-call,
 * because a stack of listeners would have the first test's answer racing the
 * third's — the real app has exactly one handler and so does this.
 */
let answerNext = { ok: true, error: null, resolve: () => {} }
phone.on((msg) => {
  if (msg.t !== 'ev' || msg.event !== 'phone' || msg.data?.action !== 'call') return
  const { ok, error, resolve } = answerNext
  req('phone.acted', { id: msg.data.id, ok, error }).catch(() => {})
  resolve(msg.data)
})

function respond({ ok = true, error = null } = {}) {
  return new Promise((resolve) => {
    answerNext = { ok, error, resolve }
  })
}

const answered = respond()
const answerRes = await post('/api/call', { op: 'answer' })
const instruction = await answered
check('the answer instruction reached the phone', instruction.op === 'answer', `id=${instruction.id.slice(0, 8)}`)
check('POST /api/call answers through the app', answerRes.status === 200 && answerRes.data.via === 'app')

const declined = respond()
const rejectRes = await post('/api/call', { op: 'reject' })
check('the reject instruction reached the phone', (await declined).op === 'reject')
check('POST /api/call rejects through the app', rejectRes.status === 200)

// A phone that says it could not do it must surface as a failure, not a 200.
const failing = respond({ ok: false, error: 'permission to answer calls was not granted' })
const denied = await post('/api/call', { op: 'answer' })
await failing
check("the phone's refusal is reported", denied.status === 400 && /permission/.test(denied.data.error), denied.data.error)

// Dialling has no app fallback, and the error should say why rather than
// leaving the user to guess that the feature is missing.
const dial = await post('/api/call', { op: 'dial', number: '+15551234' })
check('dialling without Bluetooth explains itself', dial.status === 400 && /Bluetooth/.test(dial.data.error), dial.data.error)

const stray = await req('phone.acted', { id: 'nobody-asked', ok: true })
check('an unsolicited ack is refused', stray.ok === false)

/* ── the shared history ─────────────────────────────────────────────────── */

// The same ringing phone reaching the desktop over both roads at once must be
// one entry, not two.
await req('phone.report', {
  events: [
    { kind: 'call', state: 'ringing', from: '+15550000', via: 'bluetooth' },
    { kind: 'call', state: 'ringing', from: '+15550000' },
  ],
})
const history = await req('phone.history', { limit: 10 })
const ringing = history.items.filter((i) => i.kind === 'call' && i.from === '+15550000')
check('the same call arriving twice is stored once', ringing.length === 1, `${ringing.length} entr(y/ies)`)
check('the road it came in on is recorded', ringing[0]?.via === 'bluetooth', ringing[0]?.via)
check('history reports the Bluetooth link', typeof history.bluetooth?.connected === 'boolean')
check('answering and rejecting are counted', history.counters.answered === 1 && history.counters.rejected === 1,
  `answered=${history.counters.answered} rejected=${history.counters.rejected}`)

// A ringing phone is the one notification worth putting buttons on, and the
// buttons are the whole point — a notification without them is just a readout.
const notifications = fs.existsSync(notifyLog) ? fs.readFileSync(notifyLog, 'utf8').split('\n') : []
const rang = notifications.find((line) => /Incoming call/.test(line))
check('a ringing call raises a notification', Boolean(rang), rang ? rang.slice(0, 60) : 'nothing was raised')
check(
  'the ringing notification carries Answer and Decline',
  Boolean(rang) && /-A answer=Answer/.test(rang) && /-A reject=Decline/.test(rang),
)
check('it is raised as urgent', Boolean(rang) && /-u critical/.test(rang))

const status = JSON.parse(fs.readFileSync(path.join(sandbox, 'state', 'status.json'), 'utf8'))
check('the status file carries the Bluetooth summary', 'bluetooth' in (status.phone || {}),
  `available=${status.phone?.bluetooth?.available}`)

phone.close()
const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} call-control checks passed`)
process.exit(failed.length ? 1 : 0)
