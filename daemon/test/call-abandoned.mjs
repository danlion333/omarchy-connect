/**
 * A conversation the handset never closed.
 *
 * The desktop's belief in a mirrored call is built entirely out of reports
 * from the phone, and the report the phone is least likely to send is the last
 * one: Android force-stops an app, kills it under memory pressure or freezes
 * it in Doze in the middle of a call, and the `ended` broadcast is never
 * forwarded. Nothing in the daemon used to ever stop believing — `remember`
 * takes `live` down on `ended` and on nothing else, and the watchdog in
 * `liveCall` only ever aged out a call that was still ringing.
 *
 * What that leaves on screen is not subtle: the call card repaints itself
 * once a second through `notify-send` until the daemon is restarted, the panel
 * keeps offering Answer and Hang-up for a call that is over, and
 * `handsfree.busy()` answers `true` forever, so the Bluetooth link raised for
 * that call can never be put down and the headset never gives the audio back.
 *
 * Three scenarios, and one thing that must *not* happen:
 *
 *   1. Against a real daemon and a real socket: ring, answer, then the socket
 *      dies without an `ended`. The status file the panel reads is the witness.
 *   2. The same disappearing socket against a call the desktop can hear over
 *      Bluetooth, which is real whether or not the app is running and must
 *      survive it.
 *   3. In process, with the clock pushed past the staleness threshold, for the
 *      phone that keeps its socket and simply stops talking about the call —
 *      the same shape of watchdog the `ringing` branch has always had.
 */
import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { check, done } from '../../tools/test-harness.mjs'
import { quietBluetooth, localHeaders } from './sandbox.mjs'
import { connectPhone } from './phone.mjs'

const PORT = Number(process.env.PORT || 8829)
const base = `http://127.0.0.1:${PORT}`
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'omarchy-connect-call-abandoned-'))
const local = () => localHeaders(path.join(sandbox, 'state'))

const fakeBin = path.join(sandbox, 'bin')
fs.mkdirSync(fakeBin, { recursive: true })

/**
 * A stand-in for libnotify, and the whole evidence for the card. Every call is
 * written down with the second it happened, because the complaint this suite
 * is about is a card that goes on being painted — so what matters is not that
 * a card exists but that no new one is drawn after the call is gone.
 */
const notifyLog = path.join(sandbox, 'notify.log')
fs.writeFileSync(
  path.join(fakeBin, 'notify-send'),
  [
    '#!/bin/sh',
    `printf '%s\\n' "$*" >> ${JSON.stringify(notifyLog)}`,
    "case \" $* \" in *\" -p \"*) printf '4242\\n' ;; esac",
    'case " $* " in *" -A "*|*" -w "*) exec sleep 20 ;; esac',
    '',
  ].join('\n'),
  { mode: 0o755 },
)

/** Buttonless, like the shell this project actually ships against. */
fs.writeFileSync(
  path.join(fakeBin, 'gdbus'),
  [
    '#!/bin/sh',
    'case " $* " in',
    '  *" monitor "*) exec sleep 3600 ;;',
    '  *GetServerInformation*) printf "(\'quickshell\', \'quickshell\', \'\', \'1.2\')\\n" ;;',
    'esac',
    '',
  ].join('\n'),
  { mode: 0o755 },
)

/**
 * No session bus, for the daemon and for the in-process half alike. Both
 * hands-free and ANCS probe with `busctl` and go quiet when it says no, which
 * is what puts the mirrored call — the one this suite is about — in charge of
 * `liveCall`, and keeps a suite from touching the tester's own handset.
 */
fs.writeFileSync(path.join(fakeBin, 'busctl'), '#!/bin/sh\nexit 1\n', { mode: 0o755 })

quietBluetooth(sandbox)

process.env.PATH = `${fakeBin}:${process.env.PATH}`
process.env.XDG_CONFIG_HOME = sandbox
process.env.OMARCHY_CONNECT_STATE = path.join(sandbox, 'state')
// The in-process half starts the plugin for real; its journal is not the
// suite's output.
process.env.OMARCHY_CONNECT_LOG = 'error'

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

const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const info = await (await fetch(`${base}/api/info`)).json()
const status = () => JSON.parse(fs.readFileSync(path.join(sandbox, 'state', 'status.json'), 'utf8'))
const cards = () => (fs.existsSync(notifyLog) ? fs.readFileSync(notifyLog, 'utf8').split('\n').filter(Boolean) : [])
const onCall = () => cards().filter((line) => line.includes('On call')).length

/**
 * One phone on the socket, with `req` over it, the way the app talks.
 *
 * The same handset every time, reconnecting: one desktop pairs with one phone,
 * and a second pairing code is refused while that pairing stands. Which is
 * also the truthful shape of the episode this suite is about — an app that was
 * killed comes back as the same device on a new socket.
 */
let token = null
async function handset(name = 'abandoned-app') {
  const pair = token
    ? {}
    : await (await fetch(`${base}/api/pair-code`, { method: 'POST', headers: local() })).json()
  const phone = connectPhone(PORT, info.publicKey)
  let nextId = 1
  const pendingReq = new Map()
  phone.on((msg) => {
    if (msg.t === 'res' && pendingReq.has(msg.id)) {
      const { resolve, reject } = pendingReq.get(msg.id)
      pendingReq.delete(msg.id)
      msg.error ? reject(new Error(msg.error)) : resolve(msg.data)
    }
  })
  const req = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = String(nextId++)
      pendingReq.set(id, { resolve, reject })
      phone.send({ t: 'req', id, method, params })
      setTimeout(() => reject(new Error(`${method} timed out`)), 8000)
    })
  await phone.ready
  await new Promise((resolve, reject) => {
    phone.on((msg) => {
      // The token arrives in its own frame, before the greeting.
      if (msg.t === 'paired' && msg.token) token = msg.token
      if (msg.t === 'hello.ok') resolve(msg)
      if (msg.t === 'hello.err') reject(new Error(msg.error))
    })
    phone.send({
      t: 'hello',
      ...(token ? { token } : { pairCode: pair.code }),
      device: { id: name, name: 'Handset', platform: 'android' },
    })
    setTimeout(() => reject(new Error('no hello')), 8000)
  })
  return { phone, req }
}

/* ── a socket that dies mid-conversation ───────────────────────────────── */

const first = await handset('abandoned-app')

await first.req('phone.report', {
  events: [{ kind: 'call', at: Date.now(), call: 'ring-a', state: 'ringing', from: '+380501110001', name: 'Соломія' }],
})
await wait(300)
await first.req('phone.report', {
  events: [{ kind: 'call', at: Date.now(), call: 'ring-a', state: 'active', from: '+380501110001', name: 'Соломія' }],
})
await wait(600)

check('the desktop is holding the call the phone answered', status().phone?.call?.state === 'active',
  JSON.stringify(status().phone?.call))
check('and counting it on screen', status().phone?.timer?.running === true, JSON.stringify(status().phone?.timer))
check('with a card that says so', onCall() > 0, cards().at(-1) || 'nothing drawn')

// The app dies. No `ended`, no goodbye — the socket simply goes.
first.phone.close()
await wait(800)

check('the socket dying takes the call down with it', status().phone?.call === null,
  JSON.stringify(status().phone?.call))
check('and stops the clock', status().phone?.timer?.running === false, JSON.stringify(status().phone?.timer))

/**
 * The heart of the complaint: not that a card was drawn, but that it kept
 * being drawn. `TICK_MS` is a second, so two and a half seconds of silence is
 * two rewrites that are not happening.
 */
const drawn = onCall()
await wait(2500)
check('and no card is repainted after it', onCall() === drawn, `${onCall() - drawn} more "On call" card(s)`)

/**
 * Nothing is written down, because the desktop does not know what happened.
 * The call it saw stays in the history as the call it saw — it is not turned
 * into a hang-up it never witnessed, and no second line is invented for it.
 */
const after = await (await fetch(`${base}/api/info`)).json()
check('the daemon is still up and answering', after.publicKey === info.publicKey)

/* ── a call the desktop can hear is not the app's to lose ──────────────── */

const second = await handset()
await second.req('phone.report', {
  events: [{ kind: 'call', at: Date.now(), call: 'ring-b', state: 'active', via: 'bluetooth', from: '+380501110002', name: 'Устим' }],
})
await wait(600)
check('a call on the Bluetooth road is up', status().phone?.call?.state === 'active',
  JSON.stringify(status().phone?.call))

second.phone.close()
await wait(800)
check('and survives the app socket going away', status().phone?.call?.state === 'active',
  JSON.stringify(status().phone?.call))

// Put it down again, so the daemon is left the way it was found.
const third = await handset()
await third.req('phone.report', { events: [{ kind: 'call', at: Date.now(), call: 'ring-b', state: 'ended' }] })
await wait(400)
check('and ends when somebody says it ended', status().phone?.call === null, JSON.stringify(status().phone?.call))
third.phone.close()

/* ── the phone that keeps its socket and stops talking ─────────────────── */

/**
 * In process, because the only way to reach the watchdog is to be on the far
 * side of the threshold and a suite is not going to sit there. The plugin is
 * started for real — with `busctl` refusing above, its Bluetooth and ANCS
 * halves come up unavailable — so `handsfree.busy` is the closure the daemon
 * actually installs, which is the thing the stuck call used to jam.
 */
const plugin = await import('../src/plugins/phone.js')
const { handsfree } = await import('../src/lib/handsfree.js')
const { talkTime } = await import('../src/lib/talktime.js')
const bus = new EventEmitter()
plugin.default.start(bus)
const report = (event, device = { id: 'silent-app', name: 'Handset' }) =>
  plugin.default.methods['phone.report']({ events: [event] }, { device })

report({ kind: 'call', at: Date.now(), call: 'ring-c', state: 'ringing', from: '+380501110003', name: 'Мирослава' })
report({ kind: 'call', at: Date.now(), call: 'ring-c', state: 'active', from: '+380501110003', name: 'Мирослава' })
check('the conversation is on the desktop', plugin.liveCall()?.state === 'active', JSON.stringify(plugin.liveCall()))
check('and the link is told it is busy', handsfree.busy() === true)
check('and the clock is running', talkTime.running === true)

const realNow = Date.now
Date.now = () => realNow() + 4 * 60 * 60 * 1000 + 60_000
const stale = plugin.liveCall()
const busyLater = handsfree.busy()
Date.now = realNow

check('hours later, a call nobody ever hung up is gone', stale === null, JSON.stringify(stale))
check('the link is no longer held busy by it', busyLater === false)
check('and the clock has stopped', talkTime.running === false)
check('with nothing left offering to answer or hang up', plugin.liveCall() === null, JSON.stringify(plugin.liveCall()))

const beforeIdle = onCall()
await wait(2000)
check('and no card is repainted for it either', onCall() === beforeIdle, `${onCall() - beforeIdle} more "On call" card(s)`)

/**
 * The socket-close road, tested where it lands rather than where it starts:
 * the server announces a device that is gone, and this is the plugin's answer
 * to that announcement. The end-to-end version of the same thing is the first
 * section above.
 */
report({ kind: 'call', at: Date.now(), call: 'ring-d', state: 'active', from: '+380501110004', name: 'Богдан' })
check('another call, on the same socket', plugin.liveCall()?.state === 'active', JSON.stringify(plugin.liveCall()))
bus.emit('device-gone', { id: 'someone-else', name: 'Another phone' })
check('a different phone leaving is not this call', plugin.liveCall()?.state === 'active',
  JSON.stringify(plugin.liveCall()))
bus.emit('device-gone', { id: 'silent-app', name: 'Handset' })
check('the phone that reported it leaving is', plugin.liveCall() === null, JSON.stringify(plugin.liveCall()))
check('and the clock goes with it', talkTime.running === false)

plugin.default.stop()

done('call-abandoned checks')
