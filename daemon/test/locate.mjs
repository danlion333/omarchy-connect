/**
 * Find my phone, from the desktop's side of the link.
 *
 * Nothing in a test can make a real handset shout — the noise is native and
 * lives in the app — so what is exercised here is everything the desktop is
 * responsible for: that the instruction reaches the phone with a window on it,
 * that the desktop waits to be told it is ringing rather than claiming so,
 * that it refuses honestly when there is no phone to ask or when the phone
 * says it cannot, and that its own belief about a ringing phone is dropped
 * when somebody in the next room presses the button.
 *
 * The stand-in phone is the same one the call-control suite uses: a socket
 * that answers instructions the way the app would, one handler for the whole
 * run, told by each test what to say next.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { connectPhone } from './phone.mjs'
import { quietBluetooth, localHeaders } from './sandbox.mjs'

const PORT = Number(process.env.PORT || 8804)
const base = `http://127.0.0.1:${PORT}`
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'omarchy-connect-locate-'))

// The local HTTP routes are gated on the secret the daemon publishes in its
// own status file, so every post below reads it the way the CLI does.
const local = () => localHeaders(path.join(sandbox, 'state'))

/**
 * A stand-in for libnotify. The desktop says "phone found" out loud, and a
 * test suite that threw that onto the tester's screen would be rude — this
 * turns it into a log the run can assert on instead.
 */
const notifyLog = path.join(sandbox, 'notify.log')
const fakeBin = path.join(sandbox, 'bin')
fs.mkdirSync(fakeBin, { recursive: true })
fs.writeFileSync(
  path.join(fakeBin, 'notify-send'),
  ['#!/bin/sh', `printf '%s\\n' "$*" >> ${JSON.stringify(notifyLog)}`, ''].join('\n'),
  { mode: 0o755 },
)

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
  fs.rmSync(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
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
    headers: local(),
    body: JSON.stringify(body),
  })
  return { status: res.status, data: await res.json() }
}

/* ── with nothing on the socket ─────────────────────────────────────────── */

const orphan = await post('/api/locate', { op: 'start' })
check('ringing with no phone connected fails cleanly', orphan.status === 400, orphan.data.error)
check('and says which end is missing', /no phone is connected/.test(orphan.data.error || ''), orphan.data.error)

/* ── with a phone ───────────────────────────────────────────────────────── */

const info = await (await fetch(`${base}/api/info`)).json()
const code = (await (await fetch(`${base}/api/pair-code`, { method: 'POST', headers: local() })).json()).code
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
        device: { id: 'locate-test-device', name: 'Test phone', platform: 'android', model: 'Test' },
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
  setTimeout(() => reject(new Error('no hello')), 8000)
})
check('the test phone paired', hello.protocol === 2, hello.device?.name)
check('the daemon advertises that it can find the phone', hello.capabilities?.phone?.locate === true)
phone.send({ t: 'sub', events: ['phone'] })

/**
 * One handler for the run, the way the app has one. Each test says what the
 * phone should answer next and gets the instruction it was given.
 */
let answerNext = { ok: true, error: null, resolve: () => {} }
phone.on((msg) => {
  if (msg.t !== 'ev' || msg.event !== 'phone' || msg.data?.action !== 'locate') return
  const { ok, error, resolve } = answerNext
  req('phone.located', { id: msg.data.id, ok, error }).catch(() => {})
  resolve(msg.data)
})

function respond({ ok = true, error = null } = {}) {
  return new Promise((resolve) => {
    answerNext = { ok, error, resolve }
  })
}

const ringing = respond()
const started = await post('/api/locate', { op: 'start' })
const instruction = await ringing
check('the instruction reached the phone', instruction.op === 'start', `id=${String(instruction.id).slice(0, 8)}`)
check('it carries a window the phone can run its own clock on', instruction.seconds === 60, String(instruction.seconds))
check('the desktop waits to be told it is ringing', started.status === 200 && started.data.locate?.ringing === true, JSON.stringify(started.data))

// The panel reads the published status file rather than asking, so a search
// nobody can see from the bar is a search whose button cannot be turned off.
const statusFile = path.join(sandbox, 'state', 'status.json')
const published = () => {
  try {
    return JSON.parse(fs.readFileSync(statusFile, 'utf8'))
  } catch {
    return null
  }
}
check('the search reaches the desktop status file', published()?.phone?.locate?.ringing === true, JSON.stringify(published()?.phone?.locate))

/* ── the endings ────────────────────────────────────────────────────────── */

// Somebody in the next room pressed the button on the handset. No request id,
// because there is no request behind it.
const found = await req('phone.located', { found: true })
check('the phone reporting itself found is accepted', found.ok === true, JSON.stringify(found))
await new Promise((r) => setTimeout(r, 150))
check(
  'the desktop says so out loud',
  fs.existsSync(notifyLog) && /Phone found/.test(fs.readFileSync(notifyLog, 'utf8')),
  fs.existsSync(notifyLog) ? fs.readFileSync(notifyLog, 'utf8').trim() : 'nothing logged',
)

// And having stopped believing it rings, it offers to start again.
const again = respond()
const restarted = await post('/api/locate', { op: 'start', seconds: 5 })
check('a second search is a fresh one', (await again).seconds === 5, JSON.stringify(restarted.data))
check('the window is the one that was asked for', restarted.data.locate?.ringing === true)

const stopping = respond()
const stopped = await post('/api/locate', { op: 'stop' })
check('stopping reaches the phone as its own instruction', (await stopping).op === 'stop')
check('and the desktop stops claiming it rings', stopped.status === 200 && stopped.data.locate?.ringing === false, JSON.stringify(stopped.data))
check('the status file agrees', published()?.phone?.locate?.ringing === false, JSON.stringify(published()?.phone?.locate))

/* ── refusals ───────────────────────────────────────────────────────────── */

const failing = respond({ ok: false, error: 'this phone cannot ring itself' })
const denied = await post('/api/locate', { op: 'start' })
await failing
check("the phone's refusal is reported", denied.status === 400 && /cannot ring itself/.test(denied.data.error), denied.data.error)

const nonsense = await post('/api/locate', { op: 'teleport' })
check('an unknown action is refused', nonsense.status === 400, nonsense.data.error)

const stray = await req('phone.located', { id: 'nobody-asked', ok: true })
check('an unsolicited answer to nothing is refused', stray.ok === false, JSON.stringify(stray))

// The window is clamped rather than believed: a desktop asking for an hour of
// noise is a bug somewhere, and the handset should not be the one to find out.
const clamped = respond()
await post('/api/locate', { op: 'start', seconds: 99999 })
check('an absurd window is clamped', (await clamped).seconds === 300, JSON.stringify(await clamped))

phone.close()

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} find-my-phone checks passed`)
process.exit(failed.length ? 1 : 0)
