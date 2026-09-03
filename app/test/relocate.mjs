/**
 * What happens when a stranger on the LAN claims to be the desktop.
 *
 * Following an address is cheap and it has to stay cheap: the router hands the
 * desktop a new lease, the phone sweeps the subnet, finds the machine and
 * carries on. The mistake was treating the answer to that sweep as proof. An
 * `/api/info` response is a host describing itself in plaintext, and the field
 * the phone read out of it — `publicKey` — is the very value it pinned, which
 * every host on the subnet can see in that same response from the real
 * desktop. Echo it back and the phone would move to your address, write it
 * into the keychain, fail the handshake, and read the resulting close as *the
 * desktop rejected this phone* — a terminal error with no reconnect behind it.
 * One rogue HTTP server, and the link is down until somebody pairs again.
 *
 * So: a real daemon, and next to it a fake desktop that echoes the daemon's
 * key on `/api/info` and cannot do anything else. The client is pointed at it
 * exactly the way `api/link.relocate` points it at a sweep result, and the
 * question is what the client does next.
 */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { setTimeout as sleep } from 'node:timers/promises'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { localHeaders } from '../../daemon/test/sandbox.mjs'
import { ConnectClient } from '../src/api/client.ts'
import { check, done } from '../../tools/test-harness.mjs'

const PORT = Number(process.env.PORT || 8811)
const FAKE = PORT + 1

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'omarchy-connect-relocate-'))

// The daemon's local routes are gated on the secret in its status file; a
// caller reads it the way the CLI does.
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
  // A daemon that is still writing its state on the way out turns the tidy-up
  // into a crashed suite, which is a lie about a run that passed everything.
  try {
    fs.rmSync(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  } catch {
    /* a leftover directory in /tmp is not a test failure */
  }
})

const base = `http://127.0.0.1:${PORT}`
for (let i = 0; i < 40; i += 1) {
  try {
    const res = await fetch(`${base}/api/info`)
    if (res.ok) break
  } catch {
    await sleep(250)
  }
}
const info = await (await fetch(`${base}/api/info`)).json()

/* ── the impostor ───────────────────────────────────────────────────────── */

// Everything a subnet sweep looks at, and nothing else. It has no private key
// and so cannot answer the handshake — it replies with noise, which is what
// any host that is not the desktop amounts to at that point in the protocol.
const require = createRequire(new URL('../../daemon/package.json', import.meta.url))
const { WebSocketServer } = require('ws')

let probesAnswered = 0
const rogueHttp = http.createServer((req, res) => {
  probesAnswered += 1
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ name: 'not-your-desktop', publicKey: info.publicKey, certPin: null }))
})
const rogueWs = new WebSocketServer({ server: rogueHttp, path: '/ws' })
rogueWs.on('connection', (ws) => {
  ws.on('message', () => ws.send(crypto.randomBytes(64), { binary: true }))
})
await new Promise((resolve) => rogueHttp.listen(FAKE, '127.0.0.1', resolve))

const probe = async (host, port) => {
  const res = await fetch(`http://${host}:${port}/api/info`)
  const body = await res.json()
  return { publicKey: body.publicKey ?? null, certPin: body.certPin ?? null }
}

const found = await probe('127.0.0.1', FAKE)
check('a stranger can echo the pinned key on a probe', found.publicKey === info.publicKey, `port ${FAKE}`)

/* ── a phone that already knows its desktop ─────────────────────────────── */

const { code } = await (await fetch(`${base}/api/pair-code`, { method: 'POST', headers: local() })).json()
const client = new ConnectClient({
  host: '127.0.0.1',
  port: PORT,
  pairCode: code,
  publicKey: info.publicKey,
  device: { id: 'relocate-test', name: 'Test Phone', platform: 'android', model: 'node' },
  probe,
})

const statuses = []
const unauthorized = []
client.on('status', (s) => statuses.push(s.status))
client.on('unauthorized', (e) => unauthorized.push(e ?? 'unauthorized'))

const waitFor = (event, ms) =>
  new Promise((resolve) => {
    const off = client.on(event, (data) => {
      off()
      resolve(data)
    })
    setTimeout(() => {
      off()
      resolve(null)
    }, ms)
  })

const hello = await new Promise((resolve, reject) => {
  client.on('hello', resolve)
  setTimeout(() => reject(new Error('the daemon never said hello')), 15000)
  client.connect()
})
check('the phone pairs with the real desktop first', hello.protocol >= 2, `${client.host}:${client.port}`)

/* ── and is sent after the impostor ─────────────────────────────────────── */

// `moveTo` is the one door every probe result goes through — the subnet sweep
// in `link.relocate`, the race in `raceOthers`, the upgrade in `preferBetter`.
// Whatever suggested the address, this is a move onto an unproven one.
client.moveTo('127.0.0.1', FAKE)
check('the client follows a probe result, as it always has', client.port === FAKE)

const back = await waitFor('hello', 20000)
check('a failed handshake on a candidate is not read as unauthorized', unauthorized.length === 0)
check('and does not put the link into a terminal error state', client.status !== 'error' && !statuses.includes('error'), statuses.join(' → '))
check('the client falls back to the address it knows', client.host === '127.0.0.1' && client.port === PORT)
check('and carries on until it is connected there again', back !== null && client.status === 'connected')
// The stored pairing is written by `link.rememberAddress` off the back of this
// very `hello`, from the address the client is on — so an impostor that never
// gets one can no longer put its address in the keychain.
check('so the address a hello would be remembered from is the real one', `${client.host}:${client.port}` === `127.0.0.1:${PORT}`)
check('the impostor is remembered as one and not chased again', client.suspect('127.0.0.1', FAKE))

const beforeIdle = probesAnswered
await sleep(1500)
check('and the link stays up rather than bouncing between the two', client.status === 'connected' && probesAnswered === beforeIdle,
  `${probesAnswered - beforeIdle} further probes`)

client.close()

/* ── the desktop we know saying no is still a real no ───────────────────── */

// The distinction only pays if it is a distinction: a rejection from the
// address this phone is actually paired to has to stay terminal, or a genuine
// unpairing would turn into an endless retry loop.
const disowned = new ConnectClient({
  host: '127.0.0.1',
  port: PORT,
  token: 'f'.repeat(64),
  publicKey: info.publicKey,
  device: { id: 'relocate-test', name: 'Test Phone', platform: 'android', model: 'node' },
})
const refused = await new Promise((resolve) => {
  disowned.on('unauthorized', () => resolve(true))
  disowned.on('hello', () => resolve(false))
  setTimeout(() => resolve(false), 15000)
  disowned.connect()
})
check('a rejection from the known address is still terminal', refused && disowned.status === 'error', disowned.lastError ?? '')
disowned.close()

rogueWs.close()
rogueHttp.close()
done('relocation checks')
