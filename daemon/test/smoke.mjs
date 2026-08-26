// End-to-end smoke test: pairs a fake phone, exercises the protocol.
import WebSocket from 'ws'
import { spawn } from 'node:child_process'
import { connectPhone } from './phone.mjs'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { quietBluetooth } from './sandbox.mjs'

const PORT = Number(process.env.PORT || 8799)
const base = `http://127.0.0.1:${PORT}`
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

// An isolated config root: the test pairs devices, and those must not end up
// in the user's own ~/.config/omarchy-connect.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'omarchy-connect-test-'))
// A stand-in for libnotify ahead of the real one on PATH: the mirroring checks
// below would otherwise throw real notifications onto the screen of whoever is
// running the suite. It also makes what the desktop was asked to show something
// this test can read back rather than a side effect nobody can assert on.
const notifyLog = path.join(sandbox, 'notify.log')
const fakeBin = path.join(sandbox, 'bin')
fs.mkdirSync(fakeBin, { recursive: true })
fs.writeFileSync(
  path.join(fakeBin, 'notify-send'),
  `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(notifyLog)}\n`,
  { mode: 0o755 },
)

quietBluetooth(sandbox)

const daemon = spawn(process.execPath, [path.join(root, 'bin', 'omarchy-connect.js'), 'start', '--port', String(PORT)], {
  env: {
    ...process.env,
    PATH: `${fakeBin}:${process.env.PATH}`,
    XDG_CONFIG_HOME: sandbox,
    // The status file the desktop client reads is real state; a test run must
    // not stomp on the daemon the user is actually running.
    OMARCHY_CONNECT_STATE: path.join(sandbox, 'state'),
    OMARCHY_CONNECT_LOG: 'warn',
  },
  stdio: ['ignore', 'ignore', 'inherit'],
})
process.on('exit', () => {
  daemon.kill('SIGTERM')
  fs.rmSync(sandbox, { recursive: true, force: true })
})

for (let i = 0; i < 40; i += 1) {
  try {
    const probe = await fetch(`${base}/api/info`)
    if (probe.ok) break
  } catch {
    await new Promise((r) => setTimeout(r, 250))
  }
}
const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`)
}

const info = await (await fetch(`${base}/api/info`)).json()
check('GET /api/info', info.app === 'omarchy-connect', `${info.name} v${info.version} theme=${info.theme?.name}`)
check('/api/info publishes an identity key', /^[0-9a-f]{64}$/.test(info.publicKey || ''), info.fingerprint)
check('encryption is required by default', info.encryption === 'required')

const pair = await (await fetch(`${base}/api/pair-code`, { method: 'POST' })).json()
check('POST /api/pair-code', /^\d{6}$/.test(pair.code), pair.code)

// A plaintext socket must be turned away before it can say anything.
const plaintextRejected = await new Promise((resolve) => {
  const raw = new WebSocket(`ws://127.0.0.1:${PORT}/ws`)
  raw.on('open', () => raw.send(JSON.stringify({ t: 'hello', pairCode: '000000', device: { id: 'x', name: 'x' } })))
  raw.on('close', (code) => resolve(code))
  raw.on('error', () => resolve(-1))
  setTimeout(() => resolve(0), 4000)
})
check('unencrypted client is refused', plaintextRejected === 4005, `close code ${plaintextRejected}`)

// So must one that cannot prove it holds the identity key it claims.
const impostorRejected = await new Promise((resolve) => {
  const rogue = connectPhone(PORT, 'ab'.repeat(32))
  rogue.ready.then(() => {
    rogue.send({ t: 'hello', pairCode: pair.code, device: { id: 'rogue', name: 'Rogue' } })
    setTimeout(() => resolve(0), 2500)
  }).catch(() => resolve(-1))
  rogue.ws.on('close', (code) => resolve(code))
})
check('client pinning the wrong key is refused', impostorRejected === 4005, `close code ${impostorRejected}`)

let token = null
const phone = connectPhone(PORT, info.publicKey)
const ws = phone.ws
const pending = new Map()
let seq = 0
const events = []

const req = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++seq
    pending.set(id, { resolve, reject })
    phone.send({ t: 'req', id, method, params })
    setTimeout(() => pending.has(id) && (pending.delete(id), reject(new Error(`${method} timed out`))), 8000)
  })

const ready = new Promise((resolve, reject) => {
  phone.ready
    .then(() =>
      phone.send({
        t: 'hello',
        pairCode: pair.code,
        device: { id: 'smoke-test-device', name: 'Smoke Phone', platform: 'ios', model: 'Simulator' },
      }),
    )
    .catch(reject)
  phone.on((msg) => {
    if (msg.t === 'paired') {
      token = msg.token
      check('pairing issues a token', msg.token?.length === 64)
    }
    if (msg.t === 'hello.ok') resolve(msg)
    if (msg.t === 'hello.err') reject(new Error(msg.error))
    if (msg.t === 'ev') events.push(msg)
    if (msg.t === 'res') {
      const p = pending.get(msg.id)
      if (!p) return
      pending.delete(msg.id)
      msg.ok ? p.resolve(msg.data) : p.reject(new Error(msg.error))
    }
  })
  ws.on('error', reject)
})

const hello = await ready
check('handshake', hello.protocol === 2, `caps: ${Object.keys(hello.capabilities).join(', ')}`)
check('handshake reports an encrypted channel', hello.secure === true && hello.fingerprint === info.fingerprint, hello.fingerprint)

phone.send({ t: 'sub', events: ['stats', 'clipboard', 'notification', 'theme', 'file', 'phone'] })

const stats = await req('system.stats')
check('system.stats', typeof stats.memory.total === 'number', `net ${stats.network.interface} ${stats.network.ip}`)

const sysinfo = await req('system.info')
check('system.info', sysinfo.host.os.length > 0, `${sysinfo.host.os} · ${sysinfo.theme.name}`)

const media = await req('media.state')
check('media.state', media.output !== null, `volume ${media.output?.percent}%`)

await req('clipboard.set', { text: 'omarchy-connect smoke test' })
const clip = await req('clipboard.get')
check('clipboard round trip', clip.text === 'omarchy-connect smoke test')

const notes = await req('notifications.list', { limit: 5 })
check('notifications.list', Array.isArray(notes.items), `${notes.items.length} items`)

const themes = await req('theme.list')
check('theme.list', themes.themes.length > 0, `${themes.themes.length} themes, current ${themes.current}`)

const workspaces = await req('hypr.workspaces').catch((e) => ({ error: e.message }))
check('hypr.workspaces', !workspaces.error, workspaces.error || `active ${workspaces.activeId}`)

const inbox = await req('share.inbox')
check('share.inbox', typeof inbox.path === 'string', inbox.path)

const bad = await req('does.not.exist').catch((e) => e.message)
// Pointer control runs against the live compositor, so put the cursor back
// exactly where the person at the desk left it.
try {
  const before = await req('input.state')
  check('input.state', before.width > 0 && before.height > 0, `${before.width}x${before.height} at ${before.cursor.x},${before.cursor.y}`)
  const moved = await req('input.move', { dx: 40, dy: 25 })
  check('input.move is relative', moved.x === before.cursor.x + 40 && moved.y === before.cursor.y + 25, `${moved.x},${moved.y}`)
  const clamped = await req('input.moveTo', { x: 10 ** 6, y: 10 ** 6 })
  check('pointer stays on screen', clamped.x < before.width && clamped.y < before.height, `${clamped.x},${clamped.y}`)
  const restored = await req('input.moveTo', before.cursor)
  check('cursor restored', restored.x === before.cursor.x && restored.y === before.cursor.y)
  const badKey = await req('input.key', { key: 'rm -rf ~' }).then(() => null, (e) => e.message)
  check('input.key refuses anything that is not a key name', typeof badKey === 'string', badKey)
} catch (err) {
  check('input plugin', false, err.message)
}

check('unknown method rejected', String(bad).includes('unknown method'))

const guarded = await req('system.power', { action: 'shutdown' }).catch((e) => e.message)
check('destructive action needs confirm', String(guarded).includes('confirm'))

const badUrl = await req('system.openUrl', { url: 'file:///etc/passwd' }).catch((e) => e.message)
check('openUrl rejects non-http', String(badUrl).includes('http(s)'))

// A clipboard change made outside the app must reach the phone.
await new Promise((resolve, reject) => {
  const copy = spawn('wl-copy', ['--type', 'text/plain'], { stdio: ['pipe', 'ignore', 'ignore'] })
  copy.on('exit', () => resolve())
  copy.on('error', reject)
  copy.stdin.end(`desktop-side copy ${Date.now()}`)
})

const rejectedUpload = await fetch(`${base}/api/upload`, {
  method: 'POST',
  headers: { 'x-oc-token': 'f'.repeat(64), 'x-oc-filename': 'smoke.txt' },
  body: 'hello from the smoke test',
})
check('upload rejects a bad token', rejectedUpload.status === 401)

const payload = `smoke test payload ${Date.now()}`
const upload = await fetch(`${base}/api/upload`, {
  method: 'POST',
  headers: { 'x-oc-token': token, 'x-oc-filename': 'smoke test.txt' },
  body: payload,
})
const uploaded = await upload.json()
check('phone -> desktop upload', upload.ok && uploaded.size === payload.length, uploaded.name)

const inboxAfter = await req('share.inbox')
check('uploaded file lands in the inbox', inboxAfter.items.some((i) => i.name === uploaded.name))

// Desktop -> phone: offer a real file and fetch it back with the token.
const offerSource = new URL('./smoke.mjs', import.meta.url).pathname
const offer = await (
  await fetch(`${base}/api/offer`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: offerSource }),
  })
).json()
check('desktop offers a file', typeof offer.token === 'string', `${offer.name} · ${offer.recipients} recipient(s)`)

const downloadNoAuth = await fetch(`${base}/api/download/${offer.token}`)
check('download needs a token', downloadNoAuth.status === 401)

const downloaded = await fetch(`${base}/api/download/${offer.token}?token=${token}`)
const body = await downloaded.text()
check('desktop -> phone download', downloaded.ok && body.includes('smoke test payload'), `${body.length} bytes`)

await new Promise((r) => setTimeout(r, 2500))
check('stats stream', events.some((e) => e.event === 'stats'), `${events.filter((e) => e.event === 'stats').length} ticks`)
check(
  'file events reach the phone',
  events.some((e) => e.event === 'file' && e.data.direction === 'out') &&
    events.some((e) => e.event === 'file' && e.data.direction === 'in'),
  'both directions announced',
)
check(
  'clipboard event',
  events.some((e) => e.event === 'clipboard' && e.data.text?.startsWith('desktop-side copy')),
  'desktop clipboard change mirrored',
)

/* ── the desktop client's data file ─────────────────────────────────── */

const statusFile = path.join(sandbox, 'state', 'status.json')
const readStatus = () => JSON.parse(fs.readFileSync(statusFile, 'utf8'))

const live = readStatus()
check('status file is published', live.v === 1 && live.running === true, `pid ${live.pid} port ${live.port}`)
check('status file carries the identity', live.fingerprint === info.fingerprint, live.fingerprint)
check(
  'status file knows how to invoke the daemon',
  Array.isArray(live.exec) && live.exec.length > 0 && live.exec[live.exec.length - 1].endsWith('omarchy-connect.js'),
)
check(
  'the paired phone shows as online',
  live.devices.some((d) => d.name === 'Smoke Phone' && d.online === true),
)
check('transfers are recorded both ways', live.counters.filesIn === 1 && live.counters.filesOut === 1)

const reported = await req('device.report', { battery: { percent: 64, charging: true }, network: 'WIFI' })
check('device.report accepted', reported.ok === true)

const withBattery = readStatus().devices.find((d) => d.name === 'Smoke Phone')
check(
  'phone telemetry reaches the status file',
  withBattery.battery?.percent === 64 && withBattery.battery.charging === true,
  `${withBattery.battery?.percent}% on ${withBattery.network}`,
)

const clamped = await req('device.report', { battery: { percent: 900 } })
check('a nonsense battery level is clamped, not stored raw', clamped.ok === true)
check('battery clamps to 100', readStatus().devices.find((d) => d.name === 'Smoke Phone').battery.percent === 100)

/* ── mirrored SMS and calls ─────────────────────────────────────────── */

const mirrored = await req('phone.report', {
  events: [
    { kind: 'sms', at: Date.now(), from: '+15551234567', name: 'Mum', body: 'dinner at eight' },
    { kind: 'call', at: Date.now(), from: '+15559876543', state: 'ended', missed: true, direction: 'missed' },
  ],
})
check('phone.report accepts a batch', mirrored.ok === true && mirrored.stored === 2)

const historyRes = await req('phone.history', { limit: 10 })
check(
  'phone.history returns what was mirrored',
  historyRes.items.length === 2 && historyRes.items[0].kind === 'call',
  `${historyRes.items.length} items`,
)
check(
  'a missed call is counted as missed',
  historyRes.counters.missed === 1 && historyRes.counters.messages === 1,
)
check(
  'telephony reaches the status file',
  readStatus().phone?.messages === 1 && readStatus().phone?.recent?.length === 2,
)

// The desktop has no radio: `omarchy-connect sms` asks the phone to send, and
// only answers once the phone has said what happened.
const outbox = new Promise((resolve) => {
  const answer = (msg) => {
    if (msg.t !== 'ev' || msg.event !== 'phone' || msg.data?.action !== 'send') return
    resolve(msg.data)
    req('phone.sent', { id: msg.data.id, ok: true })
  }
  phone.on(answer)
})
const smsResponse = await fetch(`${base}/api/sms`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ to: '+15551234567', body: 'on my way' }),
})
const instruction = await outbox
check('POST /api/sms reaches the phone', instruction.to === '+15551234567' && instruction.body === 'on my way')
check('POST /api/sms waits for the phone to confirm', smsResponse.ok, `HTTP ${smsResponse.status}`)

const mirroredNotifications = fs.existsSync(notifyLog) ? fs.readFileSync(notifyLog, 'utf8') : ''
check('a mirrored message raises a desktop notification', /SMS/.test(mirroredNotifications))
check('a missed call is raised as urgent', /-u critical.*Missed call/.test(mirroredNotifications))

/* ── one phone at a time ────────────────────────────────────────────── */

// With a phone paired there is no second way in: the daemon refuses to mint a
// code at all, and a socket arriving with a stale one is turned away rather
// than quietly displacing the phone already in someone's pocket.
const secondCode = await fetch(`${base}/api/pair-code`, { method: 'POST' })
check('a second pairing code is refused while a phone is paired', secondCode.status === 409)
check('and it names the phone in the way', (await secondCode.json()).device?.name === 'Smoke Phone')

const infoWhilePaired = await (await fetch(`${base}/api/info`)).json()
check('/api/info says the desktop is taken', infoWhilePaired.paired === true)
check('and no pairing window is open', infoWhilePaired.pairing === false)

const secondPhoneRejected = await new Promise((resolve) => {
  const second = connectPhone(PORT, info.publicKey)
  second.ready
    .then(() => second.send({ t: 'hello', pairCode: pair.code, device: { id: 'second-phone', name: 'Second Phone' } }))
    .catch(() => resolve(-1))
  second.ws.on('close', (code) => resolve(code))
  setTimeout(() => resolve(0), 4000)
})
check('a second phone is refused at hello', secondPhoneRejected === 4003, `close code ${secondPhoneRejected}`)
check('and the desktop still holds the first', readStatus().devices.length === 1)

const unpairRemote = await fetch(`${base}/api/unpair`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ id: 'smoke-test-device' }),
})
check('POST /api/unpair drops the device', unpairRemote.ok)
check('the unpaired phone leaves the status file', readStatus().devices.length === 0)

const freedCode = await fetch(`${base}/api/pair-code`, { method: 'POST' })
check('and the desktop can pair again once it is free', freedCode.status === 200)

ws.close()
const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length ? 1 : 0)
