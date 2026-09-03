/**
 * Answering a mirrored message from the panel instead of from a terminal.
 *
 * The panel's new reply field is a TextField and two translations around it:
 * which rows have somebody to answer, and what argv answers them. Everything
 * that can go wrong is in those two — a field offered on an app's own
 * notification is a field whose Enter can only fail, and an argv that loses
 * the spacing somebody typed sends a different message than the one on
 * screen. So this suite checks both, and then checks that the argv the panel
 * would have built actually reaches a phone as the message it was meant to be.
 *
 * It lives beside the daemon for the same reason `drop.mjs` does: QML cannot
 * be run here — there is no bar and no compositor in a test — but `Model.js`
 * is ordinary JavaScript with a `.pragma` line on top, so the deciding half of
 * the panel can be loaded into a VM and asked directly. The other half is the
 * one that matters: the command is spawned for real against a real daemon
 * with a phone on the other end, which either sees the reply under the right
 * number or does not.
 *
 * Nothing here touches the machine's own daemon, inbox or Bluetooth: it is all
 * a sandbox, a port of its own, and a phone written in Node.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

import { check, done } from '../../tools/test-harness.mjs'
import { connectPhone } from './phone.mjs'
import { quietBluetooth, localHeaders } from './sandbox.mjs'

const PORT = Number(process.env.PORT || 8817)
const base = `http://127.0.0.1:${PORT}`
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const repo = path.dirname(root)

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'omarchy-connect-sms-reply-'))
const state = path.join(sandbox, 'state')
const local = () => localHeaders(state)
quietBluetooth(sandbox)

/* ── the panel's half, loaded out of the QML ──────────────────────────── */

const source = fs.readFileSync(path.join(repo, 'shell', 'Model.js'), 'utf8').replace(/^\.pragma .*$/m, '')
const Model = vm.createContext({})
vm.runInContext(source, Model, { filename: 'shell/Model.js' })

const sms = { kind: 'sms', at: Date.now(), from: '+15551234567', name: 'Mum', body: 'dinner at eight' }
// What an iPhone's message looks like by the time it has come down the
// low-energy road: a name, a sentence, and no address anywhere in it.
const overAncs = { kind: 'sms', at: Date.now(), via: 'ancs', name: 'Mum', body: 'dinner at eight' }
const appNote = { kind: 'notification', at: Date.now(), app: 'com.example', appName: 'Example', body: 'a parcel' }
const missed = { kind: 'call', at: Date.now(), from: '+15559876543', state: 'ended', direction: 'missed', missed: true }

check('a mirrored SMS offers the number it came from', Model.phoneReplyTo(sms) === '+15551234567',
  Model.phoneReplyTo(sms))
check('an app\'s own notification offers nothing to answer', Model.phoneReplyTo(appNote) === '')
check('nor does a missed call, which is a call and not a message', Model.phoneReplyTo(missed) === '')
check('nor a message that arrived with a name and no number', Model.phoneReplyTo(overAncs) === '')
check('and neither does an empty row', Model.phoneReplyTo(null) === '' && Model.phoneReplyTo({}) === '')
// A number the phone sent as a name-shaped string is still all the desktop
// has to answer with, so the only thing trimmed off is the whitespace.
check('a number arriving with whitespace around it is still an address',
  Model.phoneReplyTo({ kind: 'sms', from: ' +15551234567 ' }) === '+15551234567')

const argvFor = (to, body) => Model.smsCommand({ exec: ['omarchy-connect'] }, to, body)
check('the reply is the command the CLI documents',
  argvFor('+1555', 'hi').slice(0, 2).join(' ') === 'omarchy-connect sms')
check('the number and the message are one argument each',
  argvFor('+1555', 'on my way — running late').length === 4,
  JSON.stringify(argvFor('+1555', 'on my way — running late')))

/* ── a daemon, a phone, and a real reply ──────────────────────────────── */

const daemon = spawn(
  process.execPath,
  [path.join(root, 'bin', 'omarchy-connect.js'), 'start', '--port', String(PORT)],
  {
    env: {
      ...process.env,
      HOME: sandbox,
      XDG_CONFIG_HOME: sandbox,
      OMARCHY_CONNECT_STATE: state,
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

const seen = []
const info = await (await fetch(`${base}/api/info`)).json()
const code = (await (await fetch(`${base}/api/pair-code`, { method: 'POST', headers: local() })).json()).code
const phone = connectPhone(PORT, info.publicKey)
phone.on((m) => seen.push(m))
await phone.ready
phone.send({
  t: 'hello',
  pairCode: code,
  device: { id: 'sms-reply-device', name: 'Test phone', platform: 'android', model: 'Test' },
})

const until = async (match, count = 1, ms = 8000) => {
  const deadline = Date.now() + ms
  for (;;) {
    const hits = seen.filter(match)
    if (hits.length >= count || Date.now() > deadline) return hits
    await new Promise((r) => setTimeout(r, 25))
  }
}

const [hello] = await until((m) => m.t === 'hello.ok' || m.t === 'hello.err')
check('the test phone paired', hello?.t === 'hello.ok', hello?.error)

// A socket that has not asked for `phone` is told nothing about a message to
// send, which would leave the reply below timing out for the wrong reason.
phone.send({ t: 'sub', events: ['phone'] })
const [subscribed] = await until((m) => m.t === 'sub.ok')
check('and asked to hear about messages', subscribed?.events?.includes('phone'), JSON.stringify(subscribed?.events))

let seq = 0
const request = (method, params) => {
  seq += 1
  phone.send({ t: 'req', id: seq, method, params })
  const id = seq
  return until((m) => m.t === 'res' && m.id === id).then(([res]) => res)
}

// A stand-in for libnotify: a mirrored message raises a desktop card, and a
// test run should not put one on the tester's screen.
fs.mkdirSync(path.join(sandbox, 'bin'), { recursive: true })
fs.writeFileSync(path.join(sandbox, 'bin', 'notify-send'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })

const stored = await request('phone.report', { events: [missed, appNote, sms] })
check('the phone mirrored a message, a notification and a missed call', stored?.data?.stored === 3,
  JSON.stringify(stored?.data))

/**
 * The list the panel actually draws, read out of the status file the panel
 * actually watches — rather than the objects invented above, which would let
 * a field on a row survive a daemon that stopped publishing `from`.
 */
const recent = await (async () => {
  const file = path.join(state, 'status.json')
  for (let i = 0; i < 40; i += 1) {
    try {
      const status = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (status.phone?.recent?.length >= 3) return status.phone.recent
    } catch { /* the file is rewritten atomically, but a read can still race a rename */ }
    await new Promise((r) => setTimeout(r, 100))
  }
  return []
})()

const answerable = recent.filter((entry) => Model.phoneReplyTo(entry) !== '')
check('exactly one of the three published rows offers a reply field',
  answerable.length === 1, `${answerable.length} of ${recent.length}`)
check('and it is the message, under the number it came from',
  Model.phoneReplyTo(answerable[0]) === '+15551234567', Model.phoneReplyTo(answerable[0] || {}))

// The phone answers a send instruction the way the app does: it reports back
// that the message went out, which is what unblocks the CLI.
const instruction = new Promise((resolve) => {
  phone.on((m) => {
    if (m.t !== 'ev' || m.event !== 'phone' || m.data?.action !== 'send') return
    resolve(m.data)
    request('phone.sent', { id: m.data.id, ok: true })
  })
})

// Two spaces and an em dash: whatever was typed is what the phone should be
// asked to send, and a message re-split into words on the way would lose both.
const reply = 'on my way  — ten minutes'
const [, ...args] = Model.smsCommand({ exec: ['omarchy-connect'] }, Model.phoneReplyTo(answerable[0]), reply)

/**
 * The CLI, spawned rather than run to completion in one call: the daemon holds
 * an SMS open until the handset confirms it, and the handset here is this very
 * process. `spawnSync` would block the loop that has to answer, and the reply
 * would time out against a phone that was listening the whole time.
 */
const cli = (argv) =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(root, 'bin', 'omarchy-connect.js'), ...argv], {
      env: {
        ...process.env,
        HOME: sandbox,
        XDG_CONFIG_HOME: sandbox,
        OMARCHY_CONNECT_STATE: state,
        OMARCHY_CONNECT_LOG: 'error',
        PATH: `${sandbox}/bin:${process.env.PATH}`,
      },
    })
    let out = ''
    child.stdout.on('data', (c) => { out += c })
    child.stderr.on('data', (c) => { out += c })
    child.on('exit', (status) => resolve({ status, out }))
  })

const run = await cli(args)
check('the reply the panel would have sent leaves without an error', run.status === 0,
  run.status === 0 ? 'exit 0' : run.out.trim().split('\n').pop())

const sent = await Promise.race([instruction, new Promise((r) => setTimeout(() => r(null), 8000))])
check('the phone was asked to send it to the number on the row', sent?.to === '+15551234567', sent?.to)
check('and with the message exactly as it was typed', sent?.body === reply, JSON.stringify(sent?.body))

/* ── and when the phone is not there to send it ───────────────────────── */

// The panel shows what a failed action said, in the urgent colour, which is
// the only thing standing between a user and a reply that silently went
// nowhere. So the CLI has to fail, and it has to say why.
phone.close()
await new Promise((r) => setTimeout(r, 500))
const orphan = await cli(args)
check('a reply with no phone on the socket is refused', orphan.status !== 0, `exit ${orphan.status}`)
check('and the refusal is a sentence the panel can show', /no phone/i.test(orphan.out),
  orphan.out.trim().split('\n').pop())

check('the daemon is still up after all of it', daemon.exitCode === null, `daemon exit ${daemon.exitCode}`)

done('panel reply checks')
