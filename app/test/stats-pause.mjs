/**
 * What the desktop is sampling while nobody is looking at it.
 *
 * The stats feed is the only event on the protocol's list that costs the
 * desktop real work to produce: once a second it reads /proc, the battery, the
 * disk and the network and sends the lot down every subscribed socket. The app
 * used to subscribe to it at the handshake and never let go, so a phone in a
 * pocket with the foreground service holding the link open was paying for a
 * per-second snapshot for as long as it stayed paired.
 *
 * So this suite is about a negative. Most of what it asserts is that nothing
 * arrives — for two and a half seconds at a time, which at 1 Hz is two ticks
 * that would have shown up and did not. A negative is only worth anything next
 * to the positive it is meant to be the absence of, so every silence here is
 * bracketed by a subscription that does produce frames, on the same socket, in
 * the same run.
 *
 * The client is the real `ConnectClient` against a real daemon, because the
 * bookkeeping being tested is split between them: the client remembers what it
 * asked for so a reconnect asks again, and the daemon reference-counts what it
 * was asked for so the sampler knows to idle. Either half alone agrees with
 * itself.
 */
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { localHeaders } from '../../daemon/test/sandbox.mjs'
import { ConnectClient } from '../src/api/client.ts'
import { check, done } from '../../tools/test-harness.mjs'

/** Two ticks of the 1 Hz sampler, plus room for a slow machine. */
const TWO_TICKS = 2500

const PORT = Number(process.env.PORT || 8817)
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'omarchy-connect-stats-'))
const local = () => localHeaders(`${sandbox}/state`)

const daemon = spawn(process.execPath, ['daemon/bin/omarchy-connect.js', 'start', '--port', String(PORT)], {
  cwd: new URL('../..', import.meta.url).pathname,
  env: {
    ...process.env,
    XDG_CONFIG_HOME: sandbox,
    OMARCHY_CONNECT_STATE: `${sandbox}/state`,
    OMARCHY_CONNECT_LOG: 'warn',
  },
  stdio: ['ignore', 'ignore', 'inherit'],
})
process.on('exit', () => {
  daemon.kill('SIGTERM')
  try {
    fs.rmSync(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  } catch {
    /* a leftover directory in /tmp is not a test failure */
  }
})

const base = `http://127.0.0.1:${PORT}`
for (let i = 0; i < 40; i += 1) {
  try {
    if ((await fetch(`${base}/api/info`)).ok) break
  } catch {
    await sleep(250)
  }
}
const info = await (await fetch(`${base}/api/info`)).json()
const { code } = await (await fetch(`${base}/api/pair-code`, { method: 'POST', headers: local() })).json()

const post = (route, body) =>
  fetch(`${base}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...local() },
    body: JSON.stringify(body),
  })

const client = new ConnectClient({
  host: '127.0.0.1',
  port: PORT,
  pairCode: code,
  publicKey: info.publicKey,
  device: { id: 'stats-pause-test', name: 'Test Phone', platform: 'android', model: 'node' },
})

/** Every event that reached the phone, counted by name. */
const arrived = []
client.on('ev', (msg) => arrived.push(msg))
const count = (event) => arrived.filter((m) => m.event === event).length

const linked = new Promise((resolve) => {
  const off = client.on('hello', (msg) => {
    off()
    resolve(msg)
  })
  setTimeout(() => {
    off()
    resolve(null)
  }, 15000)
})
client.connect()
check('the phone gets a link', (await linked) !== null && client.status === 'connected', client.status)

/* ── what a fresh socket asks for ───────────────────────────────────────── */

check(
  'a fresh client does not ask for stats',
  !client.subscribed.includes('stats'),
  client.subscribed.join(', '),
)
check(
  'but does ask for everything that is news rather than a display',
  ['clipboard', 'theme', 'file', 'agent', 'phone', 'endpoints'].every((e) => client.subscribed.includes(e)),
  client.subscribed.join(', '),
)
// The two channels the desktop *instructs* the handset on. A responder that
// listens for `ev:audio` or `ev:video` and a socket that never asked for the
// channel is the exact shape of a feature that works in every suite and does
// nothing at all on a phone: the instruction is fanned out only to sockets
// subscribed to it, so the desktop times out on a handset that heard nothing.
// #58 shipped that way for one afternoon, which is why this is a check.
check(
  'including the two channels the desktop asks this handset to open something on',
  ['audio', 'video'].every((e) => client.subscribed.includes(e)),
  client.subscribed.join(', '),
)

{
  const before = count('stats')
  await sleep(TWO_TICKS)
  check('and no snapshot arrives while nothing is watching', count('stats') === before, `${count('stats') - before} frames`)
}

// The sampler idling must not take the one-shot with it: this is the request
// the dashboard makes the moment it comes back, so that the numbers on screen
// are this second's rather than the ones from when it was last open.
{
  const snapshot = await client.call('system.stats', {}).catch((err) => err)
  check(
    'a stats request still answers with nobody subscribed',
    !(snapshot instanceof Error) && Number.isFinite(snapshot?.at),
    String(snapshot?.message ?? snapshot?.at),
  )
}

/* ── the other subscriptions, meanwhile ─────────────────────────────────── */

// `phone` is the channel the desktop uses to ask this handset to do something,
// and it is the one event on the list that can be provoked from outside the
// daemon without touching the machine: asking it to find the phone is a
// message to this very socket and nothing else.
async function phoneEventArrives(label) {
  const before = count('phone')
  // Not awaited: the desktop holds this request open until the handset says it
  // is ringing, and the handset here is this suite, three lines further down.
  post('/api/locate', { op: 'start', seconds: 2 }).catch(() => {})
  for (let i = 0; i < 100 && count('phone') === before; i += 1) await sleep(50)
  check(label, count('phone') > before)
  await post('/api/locate', { op: 'stop' }).catch(() => {})
}

// The other half of that exchange. A search nobody answers is left ringing for
// its whole window, which would put the daemon's idea of this phone somewhere
// the next check has to wait out.
client.on('ev:phone', (data) => {
  if (data?.action === 'locate') client.call('phone.located', { id: data.id, ok: true }).catch(() => {})
})

await phoneEventArrives('the phone channel is delivered while stats are paused')

/* ── a screen opens ─────────────────────────────────────────────────────── */

client.subscribe(['stats'])
check('watching adds stats to the list', client.subscribed.includes('stats'), client.subscribed.join(', '))
{
  const before = count('stats')
  await sleep(TWO_TICKS)
  const frames = count('stats') - before
  check('and the snapshots start arriving', frames >= 2, `${frames} frames`)
  const last = arrived.filter((m) => m.event === 'stats').pop()
  check('each one carries a fresh sample', Number.isFinite(last?.data?.at) && Number.isFinite(last?.data?.memory?.total))
}

/* ── and closes again ───────────────────────────────────────────────────── */

client.unsubscribe(['stats'])
check('letting go takes stats off the list', !client.subscribed.includes('stats'), client.subscribed.join(', '))
check(
  'and leaves every other subscription alone',
  ['clipboard', 'theme', 'file', 'agent', 'phone', 'endpoints'].every((e) => client.subscribed.includes(e)),
  client.subscribed.join(', '),
)
{
  // A frame already on the wire when the `unsub` went out is not a failure, so
  // the silence is measured from a moment after the round trip, not from now.
  await sleep(300)
  const before = count('stats')
  await sleep(TWO_TICKS)
  check('the feed stops again', count('stats') === before, `${count('stats') - before} frames`)
}

await phoneEventArrives('and the phone channel is still delivered afterwards')

/* ── across a reconnect ─────────────────────────────────────────────────── */

// The set the client keeps is the set it re-sends after every handshake. A
// screen that was open when the socket dropped has to be watching again when
// it comes back, and a screen that was not must not be.
client.subscribe(['stats'])
{
  const back = new Promise((resolve) => {
    const off = client.on('hello', (msg) => {
      off()
      resolve(msg)
    })
    setTimeout(() => {
      off()
      resolve(null)
    }, 15000)
  })
  // Killed the way a phone's socket dies rather than asked to move: the
  // client is connected, so anything short of the socket going away is not a
  // reconnect at all.
  client.ws.close(4000, 'test')
  check('the socket comes back', (await back) !== null && client.status === 'connected', client.status)
  const before = count('stats')
  await sleep(TWO_TICKS)
  check('and a watch held across it is still a watch', count('stats') - before >= 2, `${count('stats') - before} frames`)
}

client.unsubscribe(['stats'])
client.close()
done('stats subscription checks')
