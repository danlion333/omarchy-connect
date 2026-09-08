/**
 * Coming home to a phone that has been away.
 *
 * A handset off the network holds everything it could not deliver and hands
 * the whole pile to the desktop in one `phone.report` on the next `hello`.
 * That much is right. What was not right is that every entry in the pile was
 * announced as if it had just happened — a wall of cards about calls answered
 * and messages read on the handset hours earlier, and the desktop ringing for
 * a call that ended at breakfast.
 *
 * What is asserted here is the line the daemon now draws: the age of each
 * report decides whether it interrupts anybody, so the same batch can carry a
 * three-hour-old message that is filed in silence and a message from a second
 * ago that rings the desk. And the record itself is untouched — the history
 * and the counters are the desktop's copy of what happened, not a by-product
 * of the notification.
 *
 * Against a real daemon, because the whole bug lived in a side effect: a
 * stand-in `notify-send` on PATH turns "what was the desktop asked to show"
 * into a file, and a stand-in `paplay` does the same for the ringtone, which
 * is the loudest half of the complaint.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { check, done } from '../../tools/test-harness.mjs'
import { quietBluetooth, localHeaders } from './sandbox.mjs'
import { connectPhone } from './phone.mjs'

const PORT = Number(process.env.PORT || 8821)
const base = `http://127.0.0.1:${PORT}`
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'omarchy-connect-replay-'))
const local = () => localHeaders(path.join(sandbox, 'state'))

const fakeBin = path.join(sandbox, 'bin')
fs.mkdirSync(fakeBin, { recursive: true })

/**
 * A stand-in for libnotify: one line per card the desktop was asked to raise.
 *
 * A card with actions is a card that waits for a click, so the ringing one
 * holds its process open the way the real one does — otherwise the daemon
 * would treat every replacement as a fresh notification.
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
 * A stand-in for the sound card. The ringtone is off in every other suite so
 * that a test does not ring out loud on whoever is running it; here it is on,
 * against a player that writes to a file, because "the desktop rang for a call
 * that ended this morning" is the part of this bug people actually noticed.
 */
const ringLog = path.join(sandbox, 'ring.log')
fs.writeFileSync(
  path.join(fakeBin, 'paplay'),
  ['#!/bin/sh', `printf '%s\\n' "$*" >> ${JSON.stringify(ringLog)}`, 'sleep 1', ''].join('\n'),
  { mode: 0o755 },
)
const ringFile = path.join(sandbox, 'ring.oga')
fs.writeFileSync(ringFile, 'not really a sound, and never opened by the stand-in')

quietBluetooth(sandbox, { ringtone: { enabled: true, sound: ringFile } })

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
const cards = () => (fs.existsSync(notifyLog) ? fs.readFileSync(notifyLog, 'utf8').split('\n').filter(Boolean) : [])
const rings = () => (fs.existsSync(ringLog) ? fs.readFileSync(ringLog, 'utf8').split('\n').filter(Boolean) : [])

/* ── a phone on the socket ─────────────────────────────────────────────── */

const info = await (await fetch(`${base}/api/info`)).json()
const pair = await (await fetch(`${base}/api/pair-code`, { method: 'POST', headers: local() })).json()
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
    if (msg.t === 'hello.ok') resolve(msg)
    if (msg.t === 'hello.err') reject(new Error(msg.error))
  })
  phone.send({
    t: 'hello',
    pairCode: pair.code,
    device: { id: 'replay-test', name: 'Phone that was away', platform: 'android' },
  })
  setTimeout(() => reject(new Error('no hello')), 8000)
})

/* ── the pile that comes home with it ──────────────────────────────────── */

const now = Date.now()
const HOURS = 60 * 60 * 1000

const report = await req('phone.report', {
  events: [
    { kind: 'sms', at: now - 3 * HOURS, from: '+15550001', name: 'Мама', body: 'вечеря о восьмій' },
    { kind: 'notification', at: now - 2 * HOURS, app: 'com.example.chat', appName: 'Chat', title: 'Устим', body: 'ти де' },
    { kind: 'call', at: now - 3 * HOURS, call: 'breakfast', state: 'ringing', from: '+15550002', name: 'Ярина' },
    { kind: 'call', at: now - 3 * HOURS + 20_000, call: 'breakfast', state: 'ended', missed: true, from: '+15550002', name: 'Ярина' },
  ],
})
await wait(500)

check('the whole backlog is accepted', report?.ok === true, JSON.stringify(report))
check(
  'nothing hours old raises a card',
  cards().length === 0,
  cards().join(' | ').slice(0, 120) || 'nothing was raised',
)
check('and the desktop does not ring for a call that ended this morning', rings().length === 0, rings().join(' | '))

const filed = await req('phone.history', { limit: 20 })
const message = filed.items.find((i) => i.kind === 'sms' && i.from === '+15550001')
const app = filed.items.find((i) => i.kind === 'notification' && i.app === 'com.example.chat')
const missed = filed.items.find((i) => i.kind === 'call' && i.from === '+15550002')
check('the message is still in the history', Boolean(message), message?.body)
check('so is the app notification', Boolean(app), app?.title)
check('so is the call, folded into one line that ended missed', Boolean(missed) && missed.state === 'ended' && missed.missed === true, missed?.state)
check(
  'and the counters counted it all',
  filed.counters.messages === 1 && filed.counters.notifications === 1 && filed.counters.calls === 1 && filed.counters.missed === 1,
  JSON.stringify(filed.counters),
)

/* ── and the one that really did just arrive ───────────────────────────── */

/**
 * The other half, and the reason the line is drawn on age rather than on "this
 * came in a batch": the batch a reconnecting phone sends usually carries the
 * message that landed a second before it dialled, and that one is news.
 */
await req('phone.report', {
  events: [
    { kind: 'sms', at: Date.now(), from: '+15550003', name: 'Оксана', body: 'вже виходжу' },
    { kind: 'sms', at: Date.now() - 4 * HOURS, from: '+15550004', name: 'Банк', body: 'залишок на рахунку' },
  ],
})
await wait(500)
const mixed = cards()
check('a message that arrived a second ago still raises its card', mixed.some((line) => /вже виходжу/.test(line)), mixed.join(' | ').slice(0, 120))
check('while the old one beside it in the same batch stays quiet', !mixed.some((line) => /залишок/.test(line)))

/* ── a call that outlives the window ───────────────────────────────────── */

/**
 * The trap in judging by the entry rather than by the report. A conversation
 * keeps the `at` of the report that opened it, so a phone that has been
 * ringing — or talking — for longer than the window would have its hang-up
 * read as stale, and the card would go on counting for ever. Each report is
 * asked how old it is, not the line it lands on.
 */
await req('phone.report', {
  events: [{ kind: 'call', at: now - 3 * HOURS, call: 'long', state: 'ringing', from: '+15550005', name: 'Северин' }],
})
await wait(300)
check('a ring from hours ago is still silent', !cards().some((line) => /Северин/.test(line)))
await req('phone.report', {
  events: [{ kind: 'call', at: Date.now(), call: 'long', state: 'ended', missed: true, from: '+15550005', name: 'Северин' }],
})
await wait(500)
check(
  'but the hang-up that arrives now is announced on the same line',
  cards().some((line) => /Missed call/.test(line) && /Северин/.test(line)),
  cards().join(' | ').slice(-120),
)

/* ── a phone ringing right now ─────────────────────────────────────────── */

await req('phone.report', {
  events: [{ kind: 'call', at: Date.now(), call: 'live', state: 'ringing', from: '+15550006', name: 'Дарина' }],
})
await wait(600)
check(
  'a call ringing now still gets its urgent card',
  cards().some((line) => /Incoming call/.test(line) && /-u critical/.test(line)),
  cards().join(' | ').slice(-120),
)
check('and the desktop rings for it', rings().length > 0, `${rings().length} play(s)`)

const alive = await req('phone.history', { limit: 5 })
check('and the daemon is still answering afterwards', Array.isArray(alive.items))

phone.close()
done('replay checks')
