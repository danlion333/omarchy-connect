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

import { quietBluetooth } from './sandbox.mjs'

import { connectPhone } from './phone.mjs'
import { handsfree, Handsfree } from '../src/lib/handsfree.js'
import { TalkTime, clock, spoken } from '../src/lib/talktime.js'

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
 * It imitates three more of the real one's habits, because the daemon depends
 * on all of them. `-p` prints the notification's id, which is what lets a
 * second report of the same ringing call rewrite the first rather than stack
 * beside it. A notification with actions waits for the click instead of
 * exiting — an id belongs to a notification that is still on screen, so a
 * stand-in that returned immediately would make every replacement look like a
 * fresh one. And `-w` waits for the card to be taken off the screen, which is
 * how the call timer tells a card it is still counting on from one somebody
 * has swiped away.
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
    'case " $* " in *" -A "*|*" -w "*) exec sleep 20 ;; esac',
    '',
  ].join('\n'),
  { mode: 0o755 },
)

/**
 * A stand-in for the bus.
 *
 * Two jobs. It answers `GetServerInformation` as the buttonless server this
 * desktop actually has, so the suite tests the same notification either way
 * instead of drawing buttons on a machine with a chattier server and no
 * buttons in CI. And its `monitor` is how a card gets closed by hand here: it
 * waits for the test to drop `SWEPT` on disk and then prints the signal a
 * notification server broadcasts when somebody sweeps a card off the screen.
 *
 * Everything else on the session bus — the hands-free watch is the one that
 * matters — gets a monitor that reports nothing, which is what a quiet bus
 * looks like.
 */
const sweptFlag = path.join(sandbox, 'swept')
fs.writeFileSync(
  path.join(fakeBin, 'gdbus'),
  [
    '#!/bin/sh',
    'case " $* " in',
    '  *" monitor "*)',
    '    case " $* " in',
    '      *org.freedesktop.Notifications*)',
    '        i=0',
    '        while [ $i -lt 600 ]; do',
    `          if [ -f ${JSON.stringify(sweptFlag)} ]; then`,
    `            rm -f ${JSON.stringify(sweptFlag)}`,
    "            printf '/org/freedesktop/Notifications: org.freedesktop.Notifications.NotificationClosed (uint32 4242, uint32 2)\\n'",
    '          fi',
    '          i=$((i+1))',
    '          sleep 0.05',
    '        done',
    '        exec sleep 3600 ;;',
    '      *) exec sleep 3600 ;;',
    '    esac ;;',
    '  *GetServerInformation*)',
    "    printf \"('quickshell', 'quickshell', '', '1.2')\\n\" ;;",
    'esac',
    '',
  ].join('\n'),
  { mode: 0o755 },
)

/**
 * A stand-in for the sound card.
 *
 * The ringtone is off in every other suite because a test that mirrors a
 * ringing call would otherwise ring out loud on whoever's machine is running
 * it. Here it is switched on against a fake `paplay`, which turns the one side
 * effect worth asserting on — that a ringing phone rings, and stops when the
 * call does — into a log file.
 */
const ringLog = path.join(sandbox, 'ring.log')
fs.writeFileSync(
  path.join(fakeBin, 'paplay'),
  [
    '#!/bin/sh',
    `printf '%s\\n' "$*" >> ${JSON.stringify(ringLog)}`,
    // A player that returns instantly is the one shape this cannot be tested
    // against: the loop hangs its next pass off the child's exit, so an
    // instant exit would pass even if the gap and the re-spawn were both
    // broken. The stand-in holds the sound open the way a real one does.
    'sleep 1',
    '',
  ].join('\n'),
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

/* ── the link the whole road depends on ─────────────────────────────────── */

/**
 * When the desktop pages the handset, and when it leaves it alone.
 *
 * Against a stub, deliberately. The page itself is one D-Bus call and there is
 * nothing to learn from watching it succeed — what is worth asserting is the
 * policy around it, and asserting that for real would mean this suite reaching
 * out and connecting to whatever phone the person running it has paired.
 *
 * `attempt` is the seam because it is exactly the boundary: everything above
 * it is the decision, everything below it is BlueZ.
 */
function stubbed(policy = 'presence') {
  const link = new Handsfree()
  link.configure({ autoConnect: policy })
  link.state = { available: true, gateway: null, calls: [] }
  link.pages = []
  link.attempt = async (why) => {
    link.pages.push(why)
    link.state = { available: true, gateway: { path: '/ag1', address: 'AA', audio: 'idle' }, calls: [] }
    link.link.raisedBy = why
    return true
  }
  return link
}

{
  const link = stubbed('off')
  check('a policy of off pages nothing', (await link.raise('ring')) === false && link.pages.length === 0)
  check('and ensure does not wait around for it', (await link.ensure({ wait: 5000 })) === false)
  // Off is about what the desktop does unasked. Being asked is different.
  check(
    'but the hand crank still works',
    (await link.ensure({ why: 'manual', force: true })) === true && link.pages.join() === 'manual',
    link.pages.join(),
  )
}

{
  const link = stubbed('presence')
  link.presence(true)
  await link.link.raising
  check('the phone arriving raises the link', link.pages.join() === 'presence', link.pages.join())
  check('and the desktop remembers that it was the one who did', link.link.raisedBy === 'presence')

  // A ringing call while presence already holds the link needs no second page.
  await link.raise('ring')
  check('a link that is already up is not raised twice', link.pages.length === 1, `${link.pages.length} page(s)`)
}

{
  // Two askers, one page: presence and a ringing call want the same link, and
  // the second must join the attempt rather than start a competing one.
  const link = stubbed('presence')
  let release = null
  link.attempt = async (why) => {
    link.pages.push(why)
    await new Promise((resolve) => {
      release = resolve
    })
    link.state = { available: true, gateway: { path: '/ag1', address: 'AA', audio: 'idle' }, calls: [] }
    link.link.raisedBy = why
    return true
  }
  const first = link.raise('presence')
  const second = link.raise('ring')
  check('a second asker joins the page already under way', link.pages.length === 1, `${link.pages.length} page(s)`)

  // And somebody about to answer does not wait on a handset that is not coming.
  const gave = await link.ensure({ wait: 40 })
  check('ensure gives up on time rather than on the page', gave === false)
  release()
  await Promise.all([first, second])
  check('while the page itself carries on to the end', link.connected === true)
}

{
  // A link somebody asked for by hand is not undone by the app that happened
  // to be open at the time going away.
  const link = stubbed('presence')
  await link.raise('manual', { force: true })
  let dropped = 0
  link.drop = async () => {
    dropped += 1
    return true
  }
  link.presence(false)
  check('the phone leaving does not undo a link somebody asked for', dropped === 0)

  link.link.raisedBy = 'presence'
  link.presence(false)
  check('but it does undo the one presence put up', dropped === 1)
}

{
  // A link the user made themselves in Bluetooth settings is not the daemon's
  // to hang up, however the policy feels about it.
  const link = stubbed('presence')
  let lookups = 0
  link.handset = async () => {
    lookups += 1
    return null
  }
  link.state = { available: true, gateway: { path: '/ag1', address: 'AA', audio: 'idle' }, calls: [] }
  check('a link nobody here raised is left alone', (await link.drop()) === false && lookups === 0)
  check('and forcing it is a different verb', (await link.drop({ force: true })) === false && lookups === 1)
}

{
  // The gateway going away on its own — WirePlumber restarting, the phone
  // walking out of range — ends the daemon's claim on it too.
  const link = stubbed('presence')
  link.link.raisedBy = 'presence'
  link.apply({ available: true, gateway: null, calls: [] })
  check('a link that vanished is no longer ours to drop', link.link.raisedBy === null)
}

{
  // What `ring` buys and what it costs: no link until something rings, and the
  // link goes away again a little after the call does.
  const link = stubbed('ring')
  link.presence(true)
  check('presence means nothing under a ring policy', link.pages.length === 0)
  await link.raise('ring')
  check('but a ringing call still raises the link', link.pages.join() === 'ring')

  let dropped = 0
  link.drop = async () => {
    dropped += 1
    return true
  }
  link.state = { ...link.state, calls: [{ path: '/ag1/c1', id: 'c1', state: 'active' }] }
  link.standDown()
  check('a link with a call still under it keeps standing', link.linger === null && dropped === 0)

  link.state = { ...link.state, calls: [] }
  link.standDown()
  check('and is only put down once the line is clear', link.linger !== null)
  clearTimeout(link.linger)
  link.stop()
}

{
  /**
   * The link that was already up before the daemon was.
   *
   * BlueZ pages a bonded handset the moment it is in range, so a desktop that
   * only wants the profile for the length of a call finds it up at login, at
   * every reconnect, and for the rest of the day — with the phone's audio held
   * in a headset codec the whole time. Under `ring` that link is not adopted,
   * it is put back down, and `raisedBy` staying null is the whole reason this
   * needs `force`: nobody here raised it.
   */
  const link = stubbed('ring')
  const dropped = []
  link.drop = async (opts = {}) => {
    dropped.push(opts.force === true)
    link.state = { available: true, gateway: null, calls: [] }
    return true
  }
  link.apply({ available: true, gateway: { path: '/ag1', address: 'AA', audio: 'idle' }, calls: [] })
  check('a stray hands-free link is noticed', link.linger !== null)
  await new Promise((resolve) => setTimeout(resolve, 3200))
  check('and put back down, without pretending the daemon raised it', dropped.join() === 'true', dropped.join() || 'nothing')
  link.stop()
}

{
  /**
   * A handset that carries the audio and never says a call exists.
   *
   * PipeWire publishes a gateway with nothing under it for those, so "no call
   * objects" is not "no call" — the app or the iPhone is the only witness, and
   * a bedtime that ignored them would hang up on a conversation in progress.
   */
  const link = stubbed('ring')
  link.busy = () => true
  link.apply({ available: true, gateway: { path: '/ag1', address: 'AA', audio: 'idle' }, calls: [] })
  check('a call the desktop heard about elsewhere keeps the link up', link.linger === null)

  link.busy = () => false
  link.apply({ available: true, gateway: { path: '/ag1', address: 'AA', audio: 'active' }, calls: [] })
  check('and so does audio actually flowing', link.linger === null)

  link.apply({ available: true, gateway: { path: '/ag1', address: 'AA', audio: 'idle' }, calls: [] })
  check('once neither is true it goes down like any other stray', link.linger !== null)
  clearTimeout(link.linger)
  link.stop()
}

{
  // The same, one step later: the call starts inside the wait rather than
  // before it, and the timer that was already set must not fire through it.
  const link = stubbed('ring')
  let dropped = 0
  link.drop = async () => {
    dropped += 1
    return true
  }
  link.state = { available: true, gateway: { path: '/ag1', address: 'AA', audio: 'idle' }, calls: [] }
  link.standDown()
  link.busy = () => true
  await new Promise((resolve) => setTimeout(resolve, 3200))
  check('a call arriving inside the wait cancels the drop', dropped === 0)
  link.stop()
}

{
  // The same link under the other policies is somebody else's business: one
  // the user made in Bluetooth settings outlives whatever this daemon thinks.
  for (const policy of ['presence', 'off']) {
    const link = stubbed(policy)
    link.apply({ available: true, gateway: { path: '/ag1', address: 'AA', audio: 'idle' }, calls: [] })
    check(`a link nobody here raised is left alone under ${policy}`, link.linger === null)
    link.stop()
  }
}

{
  // A call under the link is the one thing that certainly keeps it up, however
  // it got there — and the bedtime is cancelled rather than merely ignored.
  const link = stubbed('ring')
  link.apply({ available: true, gateway: { path: '/ag1', address: 'AA', audio: 'idle' }, calls: [] })
  check('an idle stray link is on its way down', link.linger !== null)
  link.apply({
    available: true,
    gateway: { path: '/ag1', address: 'AA', audio: 'active' },
    calls: [{ path: '/ag1/c1', id: 'c1', state: 'incoming' }],
  })
  check('and a call arriving under it cancels that', link.linger === null)
  link.stop()
}

{
  // A handset that raises the profile again every time it is dropped would be
  // argued with forever; the desktop gives in instead, and says so once.
  const link = stubbed('ring')
  link.state = { available: true, gateway: { path: '/ag1', address: 'AA', audio: 'idle' }, calls: [] }
  link.standDown()
  check('a stray link is put down while the argument is winnable', link.linger !== null)
  clearTimeout(link.linger)
  link.linger = null
  link.strays = { count: 3, at: Date.now() }
  link.standDown()
  check('and left alone once it has come back too many times', link.linger === null)

  // An hour later the same reconnect is a phone walking back into the room,
  // not the same argument, and the desktop tries again.
  link.strays = { count: 3, at: Date.now() - 120_000 }
  link.standDown()
  check('but an argument that stopped is not held against it', link.linger !== null)
  clearTimeout(link.linger)
  link.stop()
}

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

let token = null
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
    if (msg.t === 'paired') token = msg.token
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
/**
 * The other gesture a card has.
 *
 * On a server that draws no buttons the click answers, and the only thing left
 * to do with the card is make it go away — the right mouse button, on every
 * server worth the name. Nothing in libnotify reports that: the card invoked
 * no action, so `notify-send` exits having said nothing, and before this the
 * phone went on ringing at somebody who had just said no to it. The bus is
 * where it shows up, as a close with the reason "a person did this".
 */
const raisedFor = (who) =>
  (fs.existsSync(notifyLog) ? fs.readFileSync(notifyLog, 'utf8').split('\n') : []).filter((line) =>
    new RegExp(who).test(line),
  )

const swept = respond()
await req('phone.report', {
  events: [{ kind: 'call', state: 'ringing', from: '+15558888', name: 'Соломія' }],
})
fs.writeFileSync(sweptFlag, '')
const sweptInstruction = await Promise.race([
  swept,
  new Promise((resolve) => setTimeout(() => resolve(null), 8000)),
])
check(
  'sweeping the ringing card off the screen declines the call',
  sweptInstruction?.op === 'reject',
  sweptInstruction ? sweptInstruction.op : 'the phone was told nothing',
)
check(
  'and the card says the right button is there to do it',
  raisedFor('Соломія').some((line) => /right-click to decline/.test(line)),
  raisedFor('Соломія').join(' | ') || 'nothing was raised',
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
 * A ringing phone rings.
 *
 * The notification card is the wrong instrument for a call: answering from the
 * desktop is worth having precisely when the handset is in another room, and
 * something you have to be looking at the screen to notice does not survive
 * that. So the desktop plays a ring — on a loop, because one three-second file
 * is not a ringing phone — and stops the moment the call is over.
 */
const ringLines = () => (fs.existsSync(ringLog) ? fs.readFileSync(ringLog, 'utf8').trim().split('\n').filter(Boolean) : [])

await req('phone.report', { events: [{ kind: 'call', state: 'ended', from: '+15553333' }] })
await new Promise((resolve) => setTimeout(resolve, 200))
const before = ringLines().length
await req('phone.report', { events: [{ kind: 'call', state: 'ringing', from: '+15554444' }] })
// A pass is a second of sound and 1.2s of silence, so this window holds two
// gaps and asks for what happens after both of them.
await new Promise((resolve) => setTimeout(resolve, 5000))
const during = ringLines()
check('a ringing call plays the ringtone', during.length > before, `${during.length - before} pass(es)`)
check('and plays the file it was given', during.at(-1)?.includes(ringFile), during.at(-1) || 'nothing was played')
check('and keeps ringing rather than playing once', during.length - before > 1, `${during.length - before} pass(es)`)

await req('phone.report', { events: [{ kind: 'call', state: 'ended', from: '+15554444' }] })
const settled = ringLines().length
await new Promise((resolve) => setTimeout(resolve, 2600))
check('a call that ends stops it', ringLines().length === settled, `${ringLines().length - settled} pass(es) after the call`)

/* ── one conversation, one line ─────────────────────────────────────────── */

/**
 * Ringing, answered and over are three separate broadcasts on Android, and the
 * desktop used to write all three down. One call therefore filled the panel's
 * four rows on its own and read as three calls with the same person — which is
 * what the duplicates in the phone list actually were.
 *
 * The phone now stamps every report of one call with the same token, and the
 * entry follows that call through its states instead of a second line being
 * written underneath it.
 */
await req('phone.report', { events: [{ kind: 'call', call: 'one', state: 'ringing', from: '+15556001', name: 'Ярина' }] })
await req('phone.report', { events: [{ kind: 'call', call: 'one', state: 'active', from: '+15556001', name: 'Ярина' }] })
const answeredCall = (await req('phone.history', { limit: 10 })).items.filter((i) => i.name === 'Ярина')
check('a call that is answered stays one line', answeredCall.length === 1, `${answeredCall.length} entr(y/ies)`)
check('and the line follows it', answeredCall[0]?.state === 'active', answeredCall[0]?.state)

await req('phone.report', { events: [{ kind: 'call', call: 'one', state: 'ended', from: '+15556001', name: 'Ярина' }] })
const endedCall = (await req('phone.history', { limit: 10 })).items.filter((i) => i.name === 'Ярина')
check('and a call that is over is still that line', endedCall.length === 1, `${endedCall.length} entr(y/ies)`)
check('marked as over', endedCall[0]?.state === 'ended', endedCall[0]?.state)
check('and not as a call nobody took', endedCall[0]?.missed === false, String(endedCall[0]?.missed))

/**
 * A call this phone placed, which reaches the desktop as `active` out of
 * nowhere: there is no ring, and Android tells an ordinary app nothing else
 * about it. It used to be filed as an incoming call — the panel drew the
 * incoming glyph beside every number the user had dialled themselves — and it
 * was never counted, because counting skipped everything that was not a ring.
 */
const dialledBefore = (await req('phone.history', { limit: 1 })).counters.calls
await req('phone.report', {
  events: [{ kind: 'call', call: 'out', state: 'active', direction: 'outgoing', from: '+15556002', name: 'Богдана' }],
})
await req('phone.report', {
  events: [{ kind: 'call', call: 'out', state: 'ended', direction: 'outgoing', from: '+15556002', name: 'Богдана' }],
})
const placed = await req('phone.history', { limit: 10 })
const dialled = placed.items.filter((i) => i.name === 'Богдана')
check('a call this phone placed is one line too', dialled.length === 1, `${dialled.length} entr(y/ies)`)
check('and is marked as going out', dialled[0]?.direction === 'outgoing', dialled[0]?.direction)
check('and is counted like any other call', placed.counters.calls === dialledBefore + 1,
  `${dialledBefore} → ${placed.counters.calls}`)

/**
 * A ring that went to voicemail: one line, and the one flag the panel colours
 * red. Two lines here was the worst of the duplicates, because the second one
 * was not marked missed and made the call look answered.
 */
await req('phone.report', { events: [{ kind: 'call', call: 'gone', state: 'ringing', from: '+15556003', name: 'Устим' }] })
await req('phone.report', { events: [{ kind: 'call', call: 'gone', state: 'ended', missed: true, from: '+15556003', name: 'Устим' }] })
const unanswered = (await req('phone.history', { limit: 10 })).items.filter((i) => i.name === 'Устим')
check('a call nobody took is one line', unanswered.length === 1, `${unanswered.length} entr(y/ies)`)
check('and it is marked missed', unanswered[0]?.missed === true, String(unanswered[0]?.missed))

/**
 * The token is what makes the fold work, rather than timing. A phone rings for
 * half a minute before anybody reaches the desk, which is a long way outside
 * the six-second window that tells two simultaneous reports of one ring apart.
 */
await req('phone.report', { events: [{ kind: 'call', call: 'slow', state: 'ringing', from: '+15556004', name: 'Северин' }] })
await new Promise((resolve) => setTimeout(resolve, 6500))
await req('phone.report', { events: [{ kind: 'call', call: 'slow', state: 'ended', from: '+15556004', name: 'Северин' }] })
const patient = (await req('phone.history', { limit: 10 })).items.filter((i) => i.name === 'Северин')
check('a call answered long after it rang is still one line', patient.length === 1, `${patient.length} entr(y/ies)`)
check('and the desktop knows it is over', patient[0]?.state === 'ended', patient[0]?.state)

/* ── the clock a picked-up call keeps ───────────────────────────────────── */

/**
 * Answering from the desktop takes the phone out of your hand, and the call
 * timer with it. Nothing on this screen said how long the conversation had
 * been going: the panel says "in progress", and only while it is open.
 *
 * So the card that was ringing stays up and counts. It is the *same* card —
 * the id is handed over rather than closed and re-raised, which is what makes
 * picking up look like one notification changing its mind.
 */
const notifyLines = () =>
  (fs.existsSync(notifyLog) ? fs.readFileSync(notifyLog, 'utf8').split('\n') : []).filter(Boolean)
const onCall = () => notifyLines().filter((line) => /On call · Ірина/.test(line))

await req('phone.report', { events: [{ kind: 'call', call: 'talk', state: 'ringing', from: '+15557001', name: 'Ірина' }] })
await new Promise((resolve) => setTimeout(resolve, 250))
await req('phone.report', { events: [{ kind: 'call', call: 'talk', state: 'active', from: '+15557001', name: 'Ірина' }] })
await new Promise((resolve) => setTimeout(resolve, 2300))

const ticking = onCall()
check('a call that is picked up keeps a card on screen', ticking.length >= 1, `${ticking.length} card(s)`)
check('and the card counts rather than sitting still', ticking.length >= 2, `${ticking.length} rewrite(s)`)
check(
  'it rewrites the card the call was ringing on rather than raising a second',
  ticking.every((line) => / -r 4242 /.test(` ${line} `)),
  ticking.at(-1) || 'nothing was raised',
)
check('it never expires on its own — the call is what ends it', /-t 0/.test(ticking.at(-1) || ''))
check('and it interrupts nobody, unlike the ring it replaced', /-u low/.test(ticking.at(-1) || ''))
check(
  'the count on it is a clock, not a number of seconds',
  /\b\d\d:\d\d\b/.test(ticking.at(-1) || ''),
  ticking.at(-1) || '',
)

/**
 * The panel and the bar count from the same instant, so the daemon publishes
 * it. A ringing call has nothing to count yet and says so.
 */
const live = (await req('phone.history', { limit: 1 })).call
check('the live call carries the moment it was picked up', typeof live?.startedAt === 'number', JSON.stringify(live))
check('which is when it was answered, not when it rang', Math.abs(Date.now() - live.startedAt) < 10_000,
  `${Math.round((Date.now() - live.startedAt) / 1000)}s ago`)

const timerStatus = JSON.parse(fs.readFileSync(path.join(sandbox, 'state', 'status.json'), 'utf8'))
check('and the status file says a conversation is being counted', timerStatus.phone?.timer?.running === true,
  JSON.stringify(timerStatus.phone?.timer))

// And the last thing the card says is how long it was — the number somebody
// reaches for a minute later and would otherwise have to go into the phone for.
await req('phone.report', { events: [{ kind: 'call', call: 'talk', state: 'ended', from: '+15557001', name: 'Ірина' }] })
await new Promise((resolve) => setTimeout(resolve, 200))
const farewell = notifyLines().filter((line) => /Call ended · Ірина/.test(line))
check('a call that is over leaves the total behind it', farewell.length === 1, `${farewell.length} card(s)`)
check('spelled the way somebody would say it', /lasted \d+[smh]/.test(farewell.at(-1) || ''), farewell.at(-1) || '')

const settledCards = onCall().length
await new Promise((resolve) => setTimeout(resolve, 1500))
check('and the counting stops with it', onCall().length === settledCards,
  `${onCall().length - settledCards} rewrite(s) after the call`)
check('the live call takes its clock with it', (await req('phone.history', { limit: 1 })).call === null)

/**
 * Somebody who does not want a card on screen for the whole conversation says
 * so once. It is the same switch the ringtone has, and it is honoured for the
 * next call rather than only after a restart.
 */
const timerOff = await post('/api/call', { op: 'timer', value: 'off' })
check('the timer can be switched off', timerOff.status === 200 && timerOff.data.timer?.enabled === false,
  JSON.stringify(timerOff.data))
const quietBefore = notifyLines().filter((line) => /On call · Дарина/.test(line)).length
await req('phone.report', { events: [{ kind: 'call', call: 'quiet', state: 'active', from: '+15557002', name: 'Дарина' }] })
await new Promise((resolve) => setTimeout(resolve, 1400))
check(
  'and then a call in progress leaves the screen alone',
  notifyLines().filter((line) => /On call · Дарина/.test(line)).length === quietBefore,
  `${notifyLines().filter((line) => /On call · Дарина/.test(line)).length} card(s)`,
)
check(
  'while the panel still knows when the conversation started',
  typeof (await req('phone.history', { limit: 1 })).call?.startedAt === 'number',
)
await req('phone.report', { events: [{ kind: 'call', call: 'quiet', state: 'ended', from: '+15557002', name: 'Дарина' }] })
const timerOn = await post('/api/call', { op: 'timer', value: 'on' })
check('and back on again', timerOn.status === 200 && timerOn.data.timer?.enabled === true, JSON.stringify(timerOn.data))
const timerJunk = await post('/api/call', { op: 'timer', value: 'sometimes' })
check('anything else is refused honestly', timerJunk.status === 400 && /on or off/.test(timerJunk.data.error || ''),
  timerJunk.data.error)

/**
 * A card that lives for the length of a conversation is a card somebody will
 * eventually swipe away, and the rewrite a second later would put it straight
 * back: a server asked to replace an id it no longer knows raises a fresh one.
 * Left alone, the only way out of the notification would be to end the call.
 *
 * In process, against a `notify-send` that returns from `-w` immediately —
 * which is exactly what the real one does the moment the card is gone.
 */
{
  const swipeBin = path.join(sandbox, 'swipe')
  const swipeLog = path.join(swipeBin, 'notify.log')
  fs.mkdirSync(swipeBin, { recursive: true })
  fs.writeFileSync(
    path.join(swipeBin, 'notify-send'),
    ['#!/bin/sh', `printf '%s\\n' "$*" >> ${JSON.stringify(swipeLog)}`, 'case " $* " in *" -p "*) printf \'7\\n\' ;; esac', ''].join('\n'),
    { mode: 0o755 },
  )
  process.env.PATH = `${swipeBin}:${process.env.PATH}`
  const cards = () => (fs.existsSync(swipeLog) ? fs.readFileSync(swipeLog, 'utf8').split('\n').filter(Boolean) : [])

  const timer = new TalkTime()
  timer.start({ key: 'swiped', who: 'Мирослава' })
  await new Promise((resolve) => setTimeout(resolve, 300))
  check('a card taken off the screen is noticed', timer.dismissed === true)
  const raised = cards().length
  await new Promise((resolve) => setTimeout(resolve, 1400))
  check('and is not put back a second later', cards().length === raised, `${cards().length - raised} more card(s)`)
  check('while the clock keeps its own time for the panel', timer.running === true && timer.seconds > 1,
    `${Math.round(timer.seconds)}s`)
  timer.stop()
  check('and the total is not pushed at somebody who said no to the card',
    cards().every((line) => !/Call ended/.test(line)), cards().at(-1) || '')
}

// The two ways a span of seconds is written: one for a card that is counting,
// one for a card that is telling you what it added up to.
check('a conversation is clocked the way a handset clocks it', clock(72) === '01:12' && clock(3782) === '1:03:02',
  `${clock(72)} / ${clock(3782)}`)
check('and totalled the way somebody would say it', spoken(45) === '45s' && spoken(252) === '4m 12s' && spoken(3720) === '1h 2m',
  [spoken(45), spoken(252), spoken(3720)].join(' / '))

const status = JSON.parse(fs.readFileSync(path.join(sandbox, 'state', 'status.json'), 'utf8'))
check('the status file carries the Bluetooth summary', 'bluetooth' in (status.phone || {}),
  `available=${status.phone?.bluetooth?.available}`)
check('and the live call the panel puts its buttons on', 'call' in (status.phone || {}))
check('and what a ringing phone will sound like', status.phone?.ringtone?.enabled === true,
  JSON.stringify(status.phone?.ringtone))
check('and whether a call in progress is counted on screen', status.phone?.timer?.enabled === true,
  JSON.stringify(status.phone?.timer))

/**
 * The name on the panel is the one the phone answers to today. A phone
 * renamed in its own settings — or one whose app only learned to ask after it
 * was paired — comes back on the same token, and the desktop takes the new
 * name rather than the one it wrote down on pairing day.
 */
phone.close()
const again = connectPhone(PORT, info.publicKey)
const rehello = await new Promise((resolve, reject) => {
  again.ready
    .then(() =>
      again.send({
        t: 'hello',
        token,
        device: { id: 'calls-test-device', name: "Оксанин Pixel", platform: 'android', model: 'Pixel 8' },
      }),
    )
    .catch(reject)
  again.on((msg) => {
    if (msg.t === 'hello.ok') resolve(msg)
    if (msg.t === 'hello.err') reject(new Error(msg.error))
  })
  setTimeout(() => reject(new Error('no hello')), 8000)
}).catch((err) => err)
check('a renamed phone keeps its pairing', rehello?.protocol === 2, rehello?.message || '')
check('and the desktop takes the new name', rehello?.device?.name === 'Оксанин Pixel', rehello?.device?.name)
const paired = JSON.parse(fs.readFileSync(path.join(sandbox, 'omarchy-connect', 'config.json'), 'utf8')).devices[0]
check('the name is remembered, not just answered with', paired?.name === 'Оксанин Pixel', paired?.name)
check('and the model it came with', paired?.model === 'Pixel 8', paired?.model)
again.close()

/**
 * The other direction: an app that cannot ask the platform who it is sends the
 * same generic label on every hello, and taking it would undo the real name on
 * every reconnect — the one its owner typed, or the one the network answered
 * with on a phone whose app never learned to ask.
 */
const generic = connectPhone(PORT, info.publicKey)
const regreet = await new Promise((resolve, reject) => {
  generic.ready
    .then(() =>
      generic.send({
        t: 'hello',
        token,
        device: { id: 'calls-test-device', name: 'Android phone', platform: 'android', model: '34' },
      }),
    )
    .catch(reject)
  generic.on((msg) => {
    if (msg.t === 'hello.ok') resolve(msg)
    if (msg.t === 'hello.err') reject(new Error(msg.error))
  })
  setTimeout(() => reject(new Error('no hello')), 8000)
}).catch((err) => err)
check('a generic name does not displace a real one', regreet?.device?.name === 'Оксанин Pixel', regreet?.device?.name)
const kept = JSON.parse(fs.readFileSync(path.join(sandbox, 'omarchy-connect', 'config.json'), 'utf8')).devices[0]
check('and the desktop does not write it down either', kept?.name === 'Оксанин Pixel', kept?.name)
generic.close()

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} call-control checks passed`)
process.exit(failed.length ? 1 : 0)
