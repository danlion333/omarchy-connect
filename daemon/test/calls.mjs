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
import { DEFAULT_EVENTS } from '../src/server.js'

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
 *
 * It imitates two more of the real one's habits, because the daemon depends on
 * both. `-p` prints the notification's id, which is what lets a second report
 * of the same ringing call rewrite the first rather than stack beside it. And
 * a notification with actions waits for the click instead of exiting — an id
 * belongs to a notification that is still on screen, so a stand-in that
 * returned immediately would make every replacement look like a fresh one.
 */
const notifyLog = path.join(sandbox, 'notify.log')
const fakeBin = path.join(sandbox, 'bin')
fs.mkdirSync(fakeBin, { recursive: true })
fs.writeFileSync(
  path.join(fakeBin, 'notify-send'),
  [
    '#!/bin/sh',
    `printf '%s\\n' "$*" >> ${JSON.stringify(notifyLog)}`,
    'case " $* " in *" -p "*) printf \'4242\\n\' ;; esac',
    'case " $* " in *" -A "*) exec sleep 20 ;; esac',
    '',
  ].join('\n'),
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
//
// Only asked when this machine has no phone on hands-free. With one connected
// the request would not fail — it would place a real call to a made-up number
// from the developer's own handset, which is not a thing a test suite may do.
if ((await handsfree.read()).gateway) {
  check('dialling is skipped — a phone is connected over Bluetooth and would really dial', true)
} else {
  const dial = await post('/api/call', { op: 'dial', number: '+15551234' })
  check('dialling without Bluetooth explains itself', dial.status === 400 && /Bluetooth/.test(dial.data.error), dial.data.error)
}

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

/**
 * An Android phone cannot always say who is calling at the moment it says the
 * phone is ringing: the state change comes from the telephony stack and the
 * name from the dialler's notification, and either can arrive first. When the
 * name arrives second the desktop has already put "unknown number" on screen,
 * so the entry being filled in is not enough — the notification has to be
 * raised again, or the one thing the user is looking at stays wrong.
 */
await req('phone.report', { events: [{ kind: 'call', state: 'ringing' }] })
await req('phone.report', { events: [{ kind: 'call', state: 'ringing', from: '+15551111', name: 'Тарас' }] })
const late = await req('phone.history', { limit: 10 })
const named = late.items.filter((i) => i.kind === 'call' && i.name === 'Тарас')
check('a late caller name fills in the ringing call', named.length === 1, `${named.length} entr(y/ies)`)
check('it does not become a second call', named[0]?.from === '+15551111', named[0]?.from)

/**
 * The same again, one step further along. A call that arrived as a bare number
 * is not anonymous, so nothing about the entry changes when the name lands —
 * but what the user is reading does, and that is what decides whether the
 * notification is worth raising a second time.
 */
await req('phone.report', { events: [{ kind: 'call', state: 'ringing', from: '+15552222' }] })
await req('phone.report', { events: [{ kind: 'call', state: 'ringing', from: '+15552222', name: 'Оксана' }] })
const upgraded = (await req('phone.history', { limit: 10 })).items.filter((i) => i.from === '+15552222')
check('a number that turns into a name stays one call', upgraded.length === 1, `${upgraded.length} entr(y/ies)`)
check('and takes the name', upgraded[0]?.name === 'Оксана', upgraded[0]?.name)

/**
 * The panel's remote control has to appear for a call down any road.
 *
 * It used to read the hands-free profile alone, which is right about the audio
 * and wrong about everything else: plenty of handsets connect over the profile
 * and never publish a call object, so PipeWire reports a gateway, no calls, and
 * the panel offered nothing to press while the phone rang.
 */
const midRing = await req('phone.history', { limit: 5 })
check('a ringing call is published for the panel to act on', Boolean(midRing.call), JSON.stringify(midRing.call))
check('and says which road it came down', midRing.call?.via === 'app', midRing.call?.via)
check('and carries the name the buttons are about', midRing.call?.name === 'Оксана', midRing.call?.name)
check('and is marked ringing rather than in progress', midRing.call?.state === 'ringing', midRing.call?.state)

await req('phone.report', { events: [{ kind: 'call', state: 'ended', from: '+15552222' }] })
const afterRing = await req('phone.history', { limit: 5 })
check('a call that ends takes the remote control off the screen', afterRing.call === null, JSON.stringify(afterRing.call))

/**
 * The dialler puts the number where the name goes for the first moment of
 * every call — the notification is posted before the address book has been
 * consulted — and Android wraps that number in invisible direction marks
 * first, so it does not look like a number to anything checking. Left alone,
 * the desktop reads a name it never had, decides the caller is known, and
 * discards the post that carried the real one: the reported symptom was a
 * ringing phone that showed a number and never turned into a contact.
 */
const WRAPPED = '\u202a+380 97 993 6034\u202c'
await req('phone.report', { events: [{ kind: 'call', state: 'ringing', name: WRAPPED }] })
await req('phone.report', { events: [{ kind: 'call', state: 'ringing', from: '+380979936034', name: 'Настьона' }] })
const wrapped = (await req('phone.history', { limit: 10 })).items.filter((i) => /9936034/.test(i.from ?? ''))
check('a number dressed as a name is one call, not two', wrapped.length === 1, `${wrapped.length} entr(y/ies)`)
check('the layout marks are stripped off it', wrapped[0]?.from === '+380979936034', JSON.stringify(wrapped[0]?.from))
check('and the contact replaces it once the dialler knows', wrapped[0]?.name === 'Настьона', wrapped[0]?.name)

/**
 * Both halves of that in one request, which is what a phone that reconnects
 * with a backlog actually sends. The second report is handled before the
 * notification server has said what id it gave the first, so a rewrite has
 * nothing to name — and the anonymous card used to sit on screen beside the
 * named one rather than being replaced by it.
 */
await req('phone.report', {
  events: [
    { kind: 'call', state: 'ringing', from: '+15553333' },
    { kind: 'call', state: 'ringing', from: '+15553333', name: 'Богдан' },
  ],
})
const batched = (await req('phone.history', { limit: 10 })).items.filter((i) => i.from === '+15553333')
check('a batch of both reports is one call', batched.length === 1, `${batched.length} entr(y/ies)`)
check('and ends up named', batched[0]?.name === 'Богдан', batched[0]?.name)

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
/**
 * Buttons are not the only way an action reaches a notification, and on this
 * desktop they are not even the usual one: Omarchy's shell draws no buttons at
 * all and invokes the action named `default` when the card is clicked. Without
 * that name registered the notification was inert — the call could be seen and
 * not answered, which is the whole complaint.
 */
check(
  'and a click on it answers, for the servers that draw no buttons',
  Boolean(rang) && /-A default=Answer/.test(rang),
)
check(
  'the named caller replaces the anonymous notification',
  notifications.some((line) => /Incoming call/.test(line) && /Тарас/.test(line)),
)
check(
  'a number becoming a name is worth raising again',
  notifications.some((line) => /Incoming call/.test(line) && /Оксана/.test(line)),
)

/**
 * The point of raising it again is that the user ends up looking at one
 * notification, not two. `-r` is the whole of that: without the id of the one
 * already on screen the server has no way to know this is the same call, and
 * "unknown number" sits there beside the name until it times out.
 */
const rerung = notifications.filter((line) => /Incoming call/.test(line) && /-r 4242/.test(line))
check('the second notification replaces the first rather than joining it', rerung.length >= 1,
  `${rerung.length} replacement(s)`)
check(
  'a name arriving in the same batch as the number replaces it too',
  notifications.some((line) => /Богдан/.test(line) && /-r 4242/.test(line)),
  notifications.filter((line) => /Богдан/.test(line)).join(' | ') || 'nothing was raised',
)

/**
 * The app has to be listening on the channel the daemon talks on.
 *
 * Everything above proves the desktop asks; none of it proves the handset is
 * subscribed to `phone`, because the test phone subscribes to whatever it is
 * told to. The real app keeps its own list, and once left `phone` off it — so
 * every answer, reject and outgoing message timed out with nothing in the log
 * to say why. The two lists live in different languages and different
 * repositories' halves; this is the only place they can be compared.
 */
const clientSource = fs.readFileSync(path.join(root, '..', 'app', 'src', 'api', 'client.ts'), 'utf8')
const declared = clientSource.match(/private subscriptions: string\[\] = \[([^\]]*)\]/)?.[1] ?? ''
const appEvents = [...declared.matchAll(/'([^']+)'/g)].map((m) => m[1])
const missing = DEFAULT_EVENTS.filter((event) => !appEvents.includes(event))
check('the app subscribes to every event the daemon publishes', missing.length === 0,
  missing.length ? `missing: ${missing.join(', ')}` : appEvents.join(' '))

const status = JSON.parse(fs.readFileSync(path.join(sandbox, 'state', 'status.json'), 'utf8'))
check('the status file carries the Bluetooth summary', 'bluetooth' in (status.phone || {}),
  `available=${status.phone?.bluetooth?.available}`)
check('and the live call the panel puts its buttons on', 'call' in (status.phone || {}))

phone.close()
const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} call-control checks passed`)
process.exit(failed.length ? 1 : 0)
