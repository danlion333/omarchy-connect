/**
 * The same message, reported twice, and written down once.
 *
 * The phone takes a batch of mirrored events out of its queue and sends it in
 * one `phone.report`. If the answer never comes back it puts the batch back —
 * it has to, because the answer not coming says nothing at all about whether
 * the desktop got the batch: a socket that dies mid-request and a request that
 * outlives the app's twelve-second timeout look exactly the same from the
 * phone. So on the next connection the same batch is sent again.
 *
 * Until this was fixed, that was a guaranteed duplicate rather than a rare
 * race — every Doze window, every Wi-Fi handover, every daemon restart put a
 * second row in the panel, a second tick on the counter and a second card on
 * the screen for one text message. `twin` had solved this for calls years
 * before, off the token the handset stamps on a conversation; SMS and app
 * notifications had no key of any kind.
 *
 * So: a batch is replayed here exactly as the phone replays it, twice over —
 * once for events that carry the app's own `key`, and once for events that
 * carry none, which is what an older build and anything already sitting in a
 * backlog will send. And the memory that makes this possible is bounded, so
 * the last part of the suite floods it and watches it forget.
 *
 * Against a real daemon over the real encrypted socket, with a stand-in
 * `notify-send` on PATH, because the loudest half of the complaint was the
 * second card and no in-process assertion can see one.
 */
import { spawn } from 'node:child_process'
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
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'omarchy-connect-dedupe-'))
const local = () => localHeaders(path.join(sandbox, 'state'))

const fakeBin = path.join(sandbox, 'bin')
fs.mkdirSync(fakeBin, { recursive: true })

/** One line per card the desktop was asked to raise. */
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
    "  *GetServerInformation*) printf \"('quickshell', 'quickshell', '', '1.2')\\n\" ;;",
    'esac',
    '',
  ].join('\n'),
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
  fs.rmSync(sandbox, { recursive: true, force: true })
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
    device: { id: 'dedupe-test', name: 'Phone with a bad socket', platform: 'android' },
  })
  setTimeout(() => reject(new Error('no hello')), 8000)
})

const history = () => req('phone.history', { limit: 50 })
const rows = (items, body) => items.filter((i) => i.body === body).length

/* ── the batch the phone sent, and sent again ──────────────────────────── */

/**
 * Two messages carrying the app's own key and one app notification carrying
 * none — the daemon's own ANCS road never mints one, so the digest has to
 * cover that kind too.
 */
const now = Date.now()
const batch = [
  { kind: 'sms', key: 'sms-key-1', at: now, from: '+15550001', name: 'Мама', body: 'вечеря о восьмій' },
  { kind: 'sms', key: 'sms-key-2', at: now + 1, from: '+15550001', name: 'Мама', body: 'вечеря о восьмій' },
  { kind: 'notification', at: now, app: 'com.example.chat', appName: 'Chat', title: 'Устим', body: 'ти де' },
]

const first = await req('phone.report', { events: batch })
await wait(400)
check('the first report stores everything in it', first?.stored === 3, JSON.stringify(first))
const afterFirst = await history()
check('the counters counted it once', afterFirst.counters.messages === 2 && afterFirst.counters.notifications === 1, JSON.stringify(afterFirst.counters))
const announced = cards().length
check('and the desktop raised a card for each', announced === 3, `${announced} card(s): ${cards().join(' | ').slice(0, 160)}`)

/**
 * The socket died before the answer got home, so the phone put the batch back
 * and has just sent it again — byte for byte the same events.
 */
const second = await req('phone.report', { events: batch })
await wait(400)
check('the replayed batch stores nothing new', second?.stored === 0, JSON.stringify(second))

const afterSecond = await history()
check(
  'one row per message, not two',
  rows(afterSecond.items, 'вечеря о восьмій') === 2 && rows(afterSecond.items, 'ти де') === 1,
  afterSecond.items.map((i) => `${i.kind}:${i.body}`).join(' | ').slice(0, 200),
)
check(
  'two texts that read alike are still two messages',
  new Set(afterSecond.items.filter((i) => i.body === 'вечеря о восьмій').map((i) => i.id)).size === 2,
)
check(
  'the counters did not move',
  afterSecond.counters.messages === 2 && afterSecond.counters.notifications === 1,
  JSON.stringify(afterSecond.counters),
)
check('and nothing was announced a second time', cards().length === announced, cards().join(' | ').slice(0, 200))

/* ── the same, for a phone that stamps no key at all ───────────────────── */

/**
 * An older build of the app, and every event already sitting in a backlog
 * written before keys existed. Nothing is asked of the sender: the daemon
 * recognises the message by what it is.
 */
const keyless = [
  { kind: 'sms', at: now + 2, from: '+15550002', name: 'Ярина', body: 'вже виходжу' },
  { kind: 'notification', at: now + 2, app: 'com.example.bank', appName: 'Bank', title: 'Картка', body: 'списання 200' },
]
const third = await req('phone.report', { events: keyless })
await wait(300)
const fourth = await req('phone.report', { events: keyless })
await wait(300)
check('an unkeyed batch stores once', third?.stored === 2, JSON.stringify(third))
check('and its replay stores nothing', fourth?.stored === 0, JSON.stringify(fourth))
const afterKeyless = await history()
check(
  'one row apiece for the unkeyed pair too',
  rows(afterKeyless.items, 'вже виходжу') === 1 && rows(afterKeyless.items, 'списання 200') === 1,
  afterKeyless.items.map((i) => i.body).join(' | ').slice(0, 200),
)
check(
  'and they were counted once',
  afterKeyless.counters.messages === 3 && afterKeyless.counters.notifications === 2,
  JSON.stringify(afterKeyless.counters),
)

/* ── a phone that never stops talking ──────────────────────────────────── */

/**
 * The memory is a ring, not an archive: a handset mirroring all day cannot be
 * allowed to grow the daemon for as long as it runs. Three hundred messages
 * later the first one is genuinely forgotten and, if the phone somehow sends
 * it again, it is recorded again — which is the right way round. Forgetting
 * costs a duplicate row in a case that cannot happen; remembering forever
 * costs memory in a case that happens every day.
 *
 * The flood is stamped hours ago so that it is filed in silence: `REPLAY_MS`
 * is what keeps three hundred stand-in cards off this test's PATH.
 */
const HOURS = 60 * 60 * 1000
const flood = []
for (let i = 0; i < 300; i += 1) {
  flood.push({ kind: 'sms', key: `flood-${i}`, at: now - 3 * HOURS + i, from: '+15559999', body: `flood ${i}` })
}
for (let i = 0; i < flood.length; i += 100) await req('phone.report', { events: flood.slice(i, i + 100) })
await wait(500)

const beforeEviction = (await history()).counters.messages
const evicted = await req('phone.report', { events: [batch[0]] })
await wait(300)
check('a message pushed out of the ring is no longer recognised', evicted?.stored === 1, JSON.stringify(evicted))
check(
  'and the ring is what bounds the daemon, so it counted again',
  (await history()).counters.messages === beforeEviction + 1,
)

/**
 * The other side of the same bound: the newest messages are still remembered
 * after all that traffic, which is what makes the ring an LRU rather than a
 * bucket that empties.
 */
const recent = await req('phone.report', { events: [flood[flood.length - 1]] })
check('while the newest of the flood is still recognised', recent?.stored === 0, JSON.stringify(recent))

done('mirror-dedupe')
