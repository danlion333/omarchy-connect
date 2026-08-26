/**
 * The iPhone bridge: Bluetooth Low Energy, and everything that hangs off it.
 *
 * Like the hands-free side, the last few centimetres cannot be exercised
 * without a handset in the room — nothing here can make an iPhone ring. What
 * *can* be tested is everything up to the antenna, and on this protocol that
 * turns out to be most of it: ANCS is a byte format, so the packets it would
 * send can be constructed exactly, split at every awkward boundary, and fed to
 * the same parser the radio would feed. The rest is the daemon's behaviour
 * around it — that it refuses honestly with no phone bonded, that the pairing
 * window asks BlueZ for the right advertisement, and that a call arriving as a
 * number over hands-free and as a name over ANCS ends up as one call.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { quietBluetooth } from './sandbox.mjs'

import { connectPhone } from './phone.mjs'
import { Ancs, ancs, parseBytes, parseNotification, parseAttributes, parseDate, ANCS_UUID } from '../src/lib/ancs.js'

const PORT = Number(process.env.PORT || 8798)
const base = `http://127.0.0.1:${PORT}`
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'omarchy-connect-ios-'))

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`)
}

/* ── the wire format, byte for byte ─────────────────────────────────────── */

// What GLib prints for a byte array. Worth pinning: the whole receive path is
// a text round trip, and GVariant has a second, shorter spelling for byte
// arrays that look like strings. It does not use it here, and if that ever
// changed this is the test that would say so.
check(
  'a gdbus byte array parses back to bytes',
  parseBytes('[byte 0x00, 0x18, 0x01, 0x01, 0x2a, 0x00, 0x00, 0x00]').equals(
    Buffer.from([0, 0x18, 1, 1, 42, 0, 0, 0]),
  ),
)
check('printable bytes are still printed as hex', parseBytes('[byte 0x48, 0x65, 0x6c]').toString() === 'Hel')
check('an empty array is empty, not an error', parseBytes('@ay []').length === 0)

const incoming = parseNotification(Buffer.from([0, 8 | 16, 1, 1, 42, 0, 0, 0]))
check('an incoming call decodes', incoming.event === 'added' && incoming.category === 'incomingCall', incoming.category)
check('its notification id is little-endian', incoming.uid === 42, String(incoming.uid))
check('both action flags are seen', incoming.positive === true && incoming.negative === true)
check(
  'the lock screen backlog is marked as such',
  parseNotification(Buffer.from([0, 4, 4, 1, 7, 0, 0, 0])).preExisting === true,
)
check('a short packet is refused rather than guessed at', parseNotification(Buffer.from([0, 0, 0])) === null)

// A Control Point answer, and the same answer arriving in fragments — which is
// what actually happens, because a message longer than the MTU is split and
// the pieces carry no headers of their own.
const tuple = (id, value) => {
  const body = Buffer.from(value, 'utf8')
  const head = Buffer.alloc(3)
  head[0] = id
  head.writeUInt16LE(body.length, 1)
  return Buffer.concat([head, body])
}
const header = Buffer.alloc(5)
header.writeUInt32LE(42, 1)
const reply = Buffer.concat([header, tuple(0, 'com.apple.MobileSMS'), tuple(1, 'Тарас'), tuple(3, 'Привіт!')])

check('a whole reply parses', parseAttributes(reply, 3)?.attributes[1] === 'Тарас')
check('the notification it answers about is identified', parseAttributes(reply, 3)?.key === 42)
check('non-ASCII survives the round trip', parseAttributes(reply, 3)?.attributes[3] === 'Привіт!')

let heldBack = 0
for (let cut = 1; cut < reply.length; cut += 1) {
  if (parseAttributes(reply.subarray(0, cut), 3) !== null) break
  heldBack += 1
}
check(
  'every partial reply is held back until the last byte',
  heldBack === reply.length - 1,
  `${heldBack}/${reply.length - 1} prefixes`,
)

const appReply = Buffer.concat([Buffer.from([1]), Buffer.from('com.apple.MobileSMS', 'utf8'), Buffer.from([0]), tuple(0, 'Messages')])
check('an app name reply parses', parseAttributes(appReply, 1)?.attributes[0] === 'Messages')
check('it is keyed by the bundle id', parseAttributes(appReply, 1)?.key === 'com.apple.MobileSMS')

const stamped = parseDate('20260825T173000')
check('an ANCS timestamp is read as local time', new Date(stamped).getHours() === 17, new Date(stamped).toISOString())
check('a malformed timestamp is null, not NaN', parseDate('yesterday') === null)

/* ── the client, against this machine's real BlueZ ──────────────────────── */

const bluez = await ancs.probe()
check('the ANCS client probes the system bus', typeof bluez === 'boolean', bluez ? 'BlueZ is running here' : 'no BlueZ')

if (bluez) {
  const state = await ancs.read()
  check('it reads the whole BlueZ object tree', state.available === true)
  check(
    'an iPhone is reported only when one is bonded',
    state.device === null || typeof state.device.address === 'string',
    state.device ? state.device.address : 'nothing paired',
  )
  check(
    'the characteristics are all three or none',
    Object.values(state.chars).every((v) => v === null) || Object.values(state.chars).every((v) => typeof v === 'string'),
  )
}

const summary = ancs.summary()
check(
  'summary has the shape the panel reads',
  ['available', 'connected', 'subscribed', 'device', 'paired', 'pairing'].every((k) => k in summary),
)

// Acting on a notification we were never told about must be an error rather
// than a write into the void.
const bare = new Ancs()
let refused = ''
try {
  await bare.act(1)
} catch (err) {
  refused = err.message
}
check('pressing a button with no iPhone connected is refused', /no iPhone is connected/.test(refused), refused)

refused = ''
try {
  await bare.request(Buffer.from([0]), 1)
} catch (err) {
  refused = err.message
}
check('asking a question with nothing subscribed is refused', /not subscribed/.test(refused), refused)

/* ── the pairing window, without touching the real adapter ──────────────── */

// `bluetoothctl` would make this machine discoverable and start advertising
// for real. Standing in for it keeps the test off the airwaves and turns the
// script we feed it into something that can actually be asserted on — the
// solicited UUID is the entire reason iOS offers us its notifications, and a
// typo in it would fail silently on real hardware.
const fakeBin = path.join(sandbox, 'bin')
const btLog = path.join(sandbox, 'bluetoothctl.log')
fs.mkdirSync(fakeBin, { recursive: true })
fs.writeFileSync(
  path.join(fakeBin, 'bluetoothctl'),
  `#!/bin/sh\nprintf 'argv: %s\\n' "$*" >> ${JSON.stringify(btLog)}\ncat >> ${JSON.stringify(btLog)}\n`,
  { mode: 0o755 },
)
fs.writeFileSync(path.join(fakeBin, 'notify-send'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })

quietBluetooth(sandbox)

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

const post = async (pathname, body) => {
  const res = await fetch(`${base}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: res.status, data: await res.json() }
}

const statusRes = await post('/api/ios', { op: 'status' })
check('POST /api/ios reports the bridge', statusRes.status === 200 && 'subscribed' in (statusRes.data.ios || {}))

const unknown = await post('/api/ios', { op: 'teleport' })
check('an unknown iOS action is refused', unknown.status === 400 && /teleport/.test(unknown.data.error), unknown.data.error)

const opened = await post('/api/ios', { op: 'pair', seconds: 45 })
check('a pairing window opens', opened.status === 200 && opened.data.seconds === 45, String(opened.data.seconds))
check('the window is reported as open', opened.data.ios?.pairing?.until > Date.now())

await new Promise((r) => setTimeout(r, 400))
const script = fs.existsSync(btLog) ? fs.readFileSync(btLog, 'utf8') : ''
check(
  'it solicits the ANCS service',
  script.includes(`solicit ${ANCS_UUID.toUpperCase()}`),
  script.split('\n').find((l) => l.startsWith('solicit')) || 'nothing solicited',
)
check('it advertises as a peripheral', /^advertise peripheral$/m.test(script))
check('it makes the desktop pairable', /^pairable on$/m.test(script) && /^discoverable on$/m.test(script))
check('it uses an agent that will not ask for a passkey', /argv: .*--agent NoInputNoOutput/.test(script))
// Both windows are closed by BlueZ rather than by us, so killing the daemon
// outright cannot leave this machine advertising itself indefinitely.
check(
  'BlueZ is given the deadline, not just this process',
  /^discoverable-timeout 45$/m.test(script) && /^timeout 45$/m.test(script),
)

const closed = await post('/api/ios', { op: 'stop' })
check('the window closes again', closed.status === 200 && closed.data.stopped === true)
check('and stops being reported as open', closed.data.ios?.pairing === null)

await new Promise((r) => setTimeout(r, 400))
const after = fs.readFileSync(btLog, 'utf8')
check('closing it takes the advertisement down', /^advertise off$/m.test(after) && /^discoverable off$/m.test(after))

/* ── one call, two roads ────────────────────────────────────────────────── */

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
        device: { id: 'ios-test-device', name: 'Test iPhone', platform: 'ios', model: 'Test' },
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
check('the test iPhone paired', hello.protocol === 2, hello.device?.name)
check('the daemon advertises the iOS bridge as a capability', 'ios' in (hello.capabilities?.phone || {}))

/**
 * The case this whole design turns on. Hands-free knows the number and nothing
 * else; ANCS knows the contact and nothing else. Two reports, one ringing
 * phone — and the desktop must end up with a single entry that has both.
 */
await req('phone.report', {
  events: [
    { kind: 'call', state: 'ringing', from: '+380671112233', via: 'bluetooth' },
    { kind: 'call', state: 'ringing', name: 'Тарас', via: 'ancs' },
  ],
})
let history = await req('phone.history', { limit: 10 })
const calls = history.items.filter((i) => i.kind === 'call')
check('the same call down two roads is stored once', calls.length === 1, `${calls.length} entr(y/ies)`)
check('the number from the hands-free link is kept', calls[0]?.from === '+380671112233', calls[0]?.from)
check('the name from ANCS is folded in', calls[0]?.name === 'Тарас', calls[0]?.name)
check('the road that got there first is the one recorded', calls[0]?.via === 'bluetooth', calls[0]?.via)

// An iPhone's messages arrive as notifications from the Messages app rather
// than as SMS, but they are the same thing to everything downstream.
await req('phone.report', {
  events: [{ kind: 'sms', via: 'ancs', name: 'Оля', body: 'вже виходжу' }],
})
history = await req('phone.history', { limit: 10 })
const message = history.items.find((i) => i.kind === 'sms')
check('a message from ANCS is stored as a message', message?.body === 'вже виходжу', message?.body)
check('it remembers it came in over low energy', message?.via === 'ancs', message?.via)

// Everything else the phone raises is a notification, and the app it came from
// is the subject rather than a correspondent.
await req('phone.report', {
  events: [
    { kind: 'notification', via: 'ancs', app: 'com.apple.mobilecal', appName: 'Calendar', title: 'Standup', body: 'in 10 minutes' },
  ],
})
history = await req('phone.history', { limit: 10 })
const raised = history.items.find((i) => i.kind === 'notification')
check('an app notification is mirrored', raised?.body === 'in 10 minutes', raised?.body)
check('the app that raised it is named', raised?.appName === 'Calendar', raised?.appName)
check('mirrored notifications are counted separately', history.counters.notifications === 1,
  String(history.counters.notifications))
check('messages and notifications are not confused', history.counters.messages === 1, String(history.counters.messages))
check('history reports the iOS bridge', typeof history.ios?.subscribed === 'boolean')

const state = JSON.parse(fs.readFileSync(path.join(sandbox, 'state', 'status.json'), 'utf8'))
check('the status file carries the iOS summary', 'ios' in (state.phone || {}), `available=${state.phone?.ios?.available}`)

phone.close()
const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} iPhone-bridge checks passed`)
process.exit(failed.length ? 1 : 0)
