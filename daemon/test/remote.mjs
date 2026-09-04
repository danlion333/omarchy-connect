// What changes when the phone is not on this network.
//
// The suite has no tunnel to dial down, so it makes one out of the loopback:
// the daemon is told, through the same detection cache the server reads, that
// 127.0.0.1 is an overlay address. Every socket the test opens then arrives
// "over the tunnel" as far as the server is concerned, which is exactly the
// state that is hard to reach by hand and easy to get wrong.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { connectPhone } from './phone.mjs'
import { quietBluetooth, localHeaders } from './sandbox.mjs'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const PORT = Number(process.env.PORT || 8803)

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`)
}

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'omarchy-connect-remote-'))

// The local HTTP routes are gated on the secret the daemon publishes in its
// own status file, so every post below reads it the way the CLI does.
const local = () => localHeaders(path.join(sandbox, 'state'))
quietBluetooth(sandbox)

// The daemon is started with remote access already on and the loopback
// declared an overlay, both through the environment, so nothing here depends
// on the machine running the suite having a tunnel at all.
fs.mkdirSync(path.join(sandbox, 'omarchy-connect'), { recursive: true })
fs.writeFileSync(
  path.join(sandbox, 'omarchy-connect', 'config.json'),
  JSON.stringify({ port: PORT, remote: { enabled: true }, devices: [] }, null, 2),
)

let daemon = null
const stop = () => {
  if (daemon && !daemon.killed) daemon.kill('SIGTERM')
  fs.rmSync(sandbox, { recursive: true, force: true })
}
process.on('exit', stop)

function start() {
  daemon = spawn(process.execPath, [path.join(root, 'bin', 'omarchy-connect.js'), 'start', '--port', String(PORT)], {
    env: {
      ...process.env,
      XDG_CONFIG_HOME: sandbox,
      OMARCHY_CONNECT_STATE: path.join(sandbox, 'state'),
      OMARCHY_CONNECT_LOG: 'warn',
      OMARCHY_CONNECT_FAKE_OVERLAY: '127.0.0.1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  daemon.stderr.on('data', (chunk) => {
    const line = String(chunk)
    if (/error/i.test(line)) process.stderr.write(line)
  })
}

async function info() {
  for (let i = 0; i < 40; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/api/info`)
      if (res.ok) return res.json()
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error('the daemon never came up')
}

const control = (op) =>
  fetch(`http://127.0.0.1:${PORT}/api/remote/control`, {
    method: 'POST',
    headers: local(),
    body: JSON.stringify({ op }),
  }).then((r) => r.json())

const pairCode = () =>
  fetch(`http://127.0.0.1:${PORT}/api/pair-code`, { method: 'POST', headers: local() }).then((r) => r.json())

start()
const desktop = await info()

/* ── the socket knows where it came from ────────────────────────────────── */

const pair = await pairCode()
const phone = connectPhone(PORT, desktop.publicKey)
const hello = await new Promise((resolve, reject) => {
  phone.on((msg) => {
    if (msg.t === 'hello.ok') resolve(msg)
    if (msg.t === 'hello.err') reject(new Error(msg.error))
  })
  phone.ready
    .then(() => phone.send({ t: 'hello', pairCode: pair.code, device: { id: 'far-phone', name: 'Far Phone' } }))
    .catch(reject)
})

check('a socket that arrived on an overlay address is remote', hello.link?.via === 'remote', JSON.stringify(hello.link))
check('and it is told which overlay', typeof hello.link?.kind === 'string')

/* ── and what it may not do ─────────────────────────────────────────────── */

const caps = hello.capabilities.phone
check('mirroring is off', caps.mirror === false)
check('sending is off', caps.send === false)
check('answering is off', caps.answer === false)
check('the hands-free profile is off', caps.bluetooth === false && caps.ios === false)
check('and no history is offered', caps.history === 0)
check('finding the phone is off — it is not in the room to be found', caps.locate === false)
check('the app is told why, not just no', caps.remote === true)

check('everything that is not telephony still works', hello.capabilities.system && hello.capabilities.clipboard)

let nextId = 1
const pending = new Map()
phone.on((msg) => {
  if (msg.t === 'res' && pending.has(msg.id)) {
    pending.get(msg.id)(msg)
    pending.delete(msg.id)
  }
})
const req = (method, params = {}) =>
  new Promise((resolve) => {
    const id = nextId
    nextId += 1
    pending.set(id, resolve)
    phone.send({ t: 'req', id, method, params })
  })

for (const method of ['phone.report', 'phone.history', 'phone.sent', 'phone.acted', 'phone.located']) {
  const res = await req(method, { events: [], limit: 1, id: 'x', ok: true })
  check(`${method} is refused`, res.ok === false && /remote link/.test(res.error || ''), res.error)
}

// The microphone is the one capability where a trusted pairing is not the
// whole question: the phone is in a room nobody at this desktop can see into.
// The `audio` *channel* is already kept off a tunnelled socket, so this is the
// other direction — the switches a phone can press.
for (const method of ['audio.offer', 'audio.input']) {
  const res = await req(method, { op: 'start' })
  check(`${method} is refused`, res.ok === false && /remote link/.test(res.error || ''), res.error)
}
check('but a remote phone may still ask what this desktop is doing', (await req('audio.status')).ok === true)

const stats = await req('system.stats')
check('a method that is not telephony is answered as usual', stats.ok === true)

/* ── the endpoints it was handed ────────────────────────────────────────── */

check('the overlay address is advertised while remote is on',
  hello.endpoints.some((e) => e.kind !== 'lan'), hello.endpoints.map((e) => `${e.host}/${e.kind}`).join(' '))

phone.send({ t: 'sub', events: ['endpoints'] })
const narrowed = new Promise((resolve) => {
  phone.on((msg) => {
    if (msg.t === 'ev' && msg.event === 'endpoints') resolve(msg.data)
  })
})
const closed = new Promise((resolve) => phone.ws.on('close', (code) => resolve(code)))

await control('disable')
const pushed = await Promise.race([narrowed, new Promise((r) => setTimeout(() => r(null), 3000))])
check('switching remote off pushes a list with no tunnel in it',
  pushed !== null && !pushed.endpoints.some((e) => e.kind !== 'lan'), JSON.stringify(pushed))

const code = await Promise.race([closed, new Promise((r) => setTimeout(() => r(null), 3000))])
check('and hangs up the socket that was using it', code === 4006, String(code))

/* ── and refuses the next one by name ───────────────────────────────────── */

const second = connectPhone(PORT, desktop.publicKey)
const refusal = await new Promise((resolve) => {
  second.on((msg) => {
    if (msg.t === 'hello.err') resolve(msg.error)
  })
  second.ready
    .then(() => second.send({ t: 'hello', token: 'whatever', device: { id: 'far-phone', name: 'Far Phone' } }))
    .catch(() => resolve(null))
  setTimeout(() => resolve(null), 4000)
})
check('a remote hello is refused with a sentence that names the fix',
  typeof refusal === 'string' && /remote access is off/.test(refusal) && /omarchy-connect remote on/.test(refusal),
  String(refusal))

const back = await control('enable')
check('and the switch goes back on', back.ok === true && back.remote.enabled === true)

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} remote-access checks passed`)
process.exit(failed.length ? 1 : 0)
