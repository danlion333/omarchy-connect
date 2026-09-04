/**
 * The end of a call, as the handset actually reports it.
 *
 * Android broadcasts that a call is over without saying whose it was: no
 * number, no name, no direction, and — on the builds that hand out a token per
 * conversation at all — sometimes a token this desktop has never seen, because
 * the ending was assembled somewhere other than the ringing was. Every one of
 * the three ways `twin` had of recognising a conversation missed a report like
 * that: the token matched nothing, the branch that lets a live call move on was
 * closed to anything carrying a token, and the six-second window wants a
 * matching state, which `ended` never has against `ringing`.
 *
 * So a call the desktop had watched from the first ring left two lines behind
 * it — the real one, and an `unknown` with nothing under it but a timestamp —
 * and the call counter went up twice for one conversation. In the panel that
 * second line is indistinguishable from a missed call from a withheld number.
 *
 * Three scenarios, and the panel's own reading of what they leave behind:
 *
 *   1. Against a real daemon and a real phone socket: ring, answer, hang up,
 *      with the hang-up anonymous and stamped with a different token.
 *   2. In process, with the clock pushed past `RING_TIMEOUT_MS`, because the
 *      other half of the complaint is a call card that vanishes mid-conversation
 *      — once the watchdog has dropped it there is no live call to attach to,
 *      and the line in the history is all that is left to find.
 *   3. An anonymous ending that belongs to nothing at all, which is not a
 *      record of anything and is not written down.
 *
 * The last section loads `shell/Model.js` into a VM the way `sms-reply.mjs`
 * does and asks the panel what it would draw from the history the daemon
 * actually produced — because "no empty `unknown` row" is a statement about the
 * screen, and the panel is where the row is made.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

import { check, done } from '../../tools/test-harness.mjs'
import { quietBluetooth, localHeaders } from './sandbox.mjs'
import { connectPhone } from './phone.mjs'

const PORT = Number(process.env.PORT || 8823)
const base = `http://127.0.0.1:${PORT}`
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const repo = path.dirname(root)
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'omarchy-connect-call-close-'))
const local = () => localHeaders(path.join(sandbox, 'state'))

const fakeBin = path.join(sandbox, 'bin')
fs.mkdirSync(fakeBin, { recursive: true })

/**
 * A stand-in for libnotify. It is ahead of the real one on the PATH of this
 * process as well as of the daemon's, because the second half of this suite
 * imports the phone plugin in process — a ringing call reported there would
 * otherwise throw a real urgent card onto the screen of whoever is running the
 * tests and hold it there for forty-five seconds.
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

quietBluetooth(sandbox)

// For the in-process half: the same sandbox, the same stand-ins, and above all
// the same Bluetooth policy — a suite must not page the tester's handset.
process.env.PATH = `${fakeBin}:${process.env.PATH}`
process.env.XDG_CONFIG_HOME = sandbox
process.env.OMARCHY_CONNECT_STATE = path.join(sandbox, 'state')

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
    device: { id: 'call-close-test', name: 'Handset', platform: 'android' },
  })
  setTimeout(() => reject(new Error('no hello')), 8000)
})

/* ── one conversation, three reports, two tokens ───────────────────────── */

const calls = (items) => items.filter((i) => i.kind === 'call')

await req('phone.report', {
  events: [{ kind: 'call', at: Date.now(), call: 'ring-a', state: 'ringing', from: '+380501110001', name: 'Соломія' }],
})
await wait(400)
await req('phone.report', {
  events: [{ kind: 'call', at: Date.now(), call: 'ring-a', state: 'active', from: '+380501110001', name: 'Соломія' }],
})
await wait(400)

const answered = await req('phone.history', { limit: 20 })
check('the ring and the answer are one line', calls(answered.items).length === 1, `${calls(answered.items).length} line(s)`)
check('and the desktop is holding that call', answered.call?.state === 'active', JSON.stringify(answered.call))

// The report the bug was made of: the same conversation ending, with a token
// nothing has ever been stamped with and not a word about who it was with.
await req('phone.report', {
  events: [{ kind: 'call', at: Date.now(), call: 'ended-b', state: 'ended' }],
})
await wait(400)

const closed = await req('phone.history', { limit: 20 })
const line = calls(closed.items)[0]
check('a hang-up with a foreign token and no caller closes the call it ended',
  calls(closed.items).length === 1, `${calls(closed.items).length} line(s): ${JSON.stringify(calls(closed.items))}`)
check('on the line that was already there', line?.state === 'ended' && line?.call === 'ring-a', JSON.stringify(line))
check('and that line is still named', line?.name === 'Соломія' && line?.from === '+380501110001', JSON.stringify(line))
check('one conversation, counted once', closed.counters.calls === 1, JSON.stringify(closed.counters))
check('and nothing is left up on the desktop', closed.call === null, JSON.stringify(closed.call))

/* ── an ending that belongs to nothing ─────────────────────────────────── */

/**
 * No number, no name, no direction the road knew, no duration, and no
 * conversation open for it to be the end of. There is nothing in it that a
 * history row exists to carry, so there is no row.
 */
await req('phone.report', {
  events: [{ kind: 'call', at: Date.now(), state: 'ended' }],
})
await wait(400)

const orphan = await req('phone.history', { limit: 20 })
check('an anonymous ending with nothing to close adds no row',
  calls(orphan.items).length === 1, JSON.stringify(calls(orphan.items)))
check('and does not count a call that was never seen', orphan.counters.calls === 1, JSON.stringify(orphan.counters))

// A real call afterwards still lands: the rule above throws away one shape of
// report, not the road it came down.
await req('phone.report', {
  events: [{ kind: 'call', at: Date.now(), call: 'ring-c', state: 'ended', direction: 'missed', missed: true, from: '+380501110002' }],
})
await wait(400)
const after = await req('phone.history', { limit: 20 })
check('a missed call after it is still recorded', calls(after.items).some((i) => i.from === '+380501110002'),
  JSON.stringify(calls(after.items)[0]))
check('and counted', after.counters.calls === 2 && after.counters.missed === 1, JSON.stringify(after.counters))

phone.close()

/* ── the same ending, after the ringing card has timed out ─────────────── */

/**
 * In process, because the only way to reach the watchdog in `liveCall` is to be
 * on the other side of forty-five seconds and a test suite is not going to sit
 * there. The plugin is imported fresh, its own history and counters start
 * empty, and the clock is pushed forward for exactly the one call that reads
 * it — after which `live` is gone and the line in the history is all that is
 * left of the conversation.
 */
const plugin = await import('../src/plugins/phone.js')
const report = (event) => plugin.default.methods['phone.report']({ events: [event] })

report({ kind: 'call', at: Date.now(), call: 'ring-d', state: 'ringing', from: '+380501110003', name: 'Устим' })
check('the ring is on the desktop', plugin.liveCall()?.state === 'ringing', JSON.stringify(plugin.liveCall()))

const realNow = Date.now
Date.now = () => realNow() + 46_000
const stillLive = plugin.liveCall()
Date.now = realNow
check('and forty-five seconds later the card is gone', stillLive === null, JSON.stringify(stillLive))

report({ kind: 'call', at: Date.now(), call: 'ended-e', state: 'ended' })
const late = plugin.recent(20).filter((i) => i.kind === 'call')
check('the hang-up that arrives after it still closes that call, not a new one',
  late.length === 1, `${late.length} line(s): ${JSON.stringify(late)}`)
check('and the line keeps the caller the ring brought', late[0]?.name === 'Устим' && late[0]?.state === 'ended',
  JSON.stringify(late[0]))
check('with one call counted for one conversation', plugin.summary().calls === 1, `${plugin.summary().calls}`)

/* ── what the panel would draw from it ─────────────────────────────────── */

const source = fs.readFileSync(path.join(repo, 'shell', 'Model.js'), 'utf8').replace(/^\.pragma .*$/m, '')
const Model = vm.createContext({})
vm.runInContext(source, Model, { filename: 'shell/Model.js' })

const now = Date.now()
/**
 * A row nobody can use: the panel names it `unknown`, and the only thing under
 * that name is the time it arrived. This is what the second line looked like on
 * screen, and asserting the shape here is what makes the rows below a statement
 * about the panel rather than about the daemon's JSON.
 */
const bare = (entry) =>
  entry.kind === 'call' &&
  Model.phoneWho(entry) === 'unknown' &&
  Model.phoneDetail(entry, now) === Model.since(entry.at, now)

const invented = { kind: 'call', at: now, state: 'ended', direction: 'incoming' }
check('the panel would indeed draw an anonymous ending as an empty unknown row', bare(invented) === true,
  `${Model.phoneWho(invented)} · ${Model.phoneDetail(invented, now)}`)

const rows = [...after.items, ...plugin.recent(20)]
check('but no row the daemon produced is one', rows.every((entry) => !bare(entry)),
  JSON.stringify(rows.filter(bare)))
check('and the calls in the section all say who they were with',
  rows.filter((e) => e.kind === 'call').every((e) => Model.phoneWho(e) !== 'unknown'),
  JSON.stringify(rows.filter((e) => e.kind === 'call').map((e) => Model.phoneWho(e))),
)

done('call-close checks')
