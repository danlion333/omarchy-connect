/**
 * The phone that says hello in the first instant the daemon is up.
 *
 * `endpoints()` reads whatever `overlayState` happens to hold when a `hello`
 * is answered, and in a fresh process that starts out as `overlay.known()` —
 * an empty snapshot. So there used to be a window between the listener
 * opening and the first `refreshEnvironment()` returning in which a greeting
 * was answered with the LAN address and nothing else. The phone treats a
 * hello's list as the whole truth and writes it over the one in its keychain,
 * so a greeting caught in that window cost it the tunnel address it needs the
 * next time it is away from home — and it only got it back on the next hello
 * from the LAN, which is the one place it does not need it.
 *
 * The window was never theoretical: the phone redials the moment it hears the
 * start-up announcement, which is the same second the daemon starts.
 *
 * Reproduced honestly rather than with a stub. The daemon is pointed at a
 * `tailscaled` socket of the suite's own, which answers a real local-API
 * request with a real status payload — after most of a second, the way a
 * desktop that has to fall back to `tailscale status --json` does. Then the
 * phone dials in a tight loop from before there is anything to dial, so its
 * hello lands in the first instant the port accepts one.
 *
 * The pairing is made in a first run and used in a second, because that is
 * what the race needs: a phone that already knows the token and the server
 * key has nothing to ask for before it says hello, and neither has the real
 * one after a daemon restart.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { check, done } from '../../tools/test-harness.mjs'
import { connectPhone } from './phone.mjs'
import { quietBluetooth, localHeaders } from './sandbox.mjs'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const PORT = Number(process.env.PORT || 8837)
const TUNNEL = '100.98.11.123'
const ANSWER_DELAY_MS = 800

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'omarchy-connect-greet-race-'))
const socketPath = path.join(sandbox, 'tailscaled.sock')
const local = () => localHeaders(path.join(sandbox, 'state'))
quietBluetooth(sandbox)

fs.mkdirSync(path.join(sandbox, 'omarchy-connect'), { recursive: true })
fs.writeFileSync(
  path.join(sandbox, 'omarchy-connect', 'config.json'),
  JSON.stringify({ port: PORT, remote: { enabled: true }, devices: [] }, null, 2),
)

/* ── a tailscaled that takes its time ───────────────────────────────────── */

let answeredAt = 0
const status = JSON.stringify({
  Self: { TailscaleIPs: [TUNNEL], DNSName: 'desk.fake.ts.net.', KeyExpiry: new Date(Date.now() + 6e8).toISOString() },
})
const tailscaled = http.createServer((req, res) => {
  setTimeout(() => {
    if (!answeredAt) answeredAt = Date.now()
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(status)
  }, ANSWER_DELAY_MS)
})
await new Promise((resolve) => tailscaled.listen(socketPath, resolve))

/* ── the daemon ─────────────────────────────────────────────────────────── */

let daemon = null
const stop = () => {
  if (daemon && !daemon.killed) daemon.kill('SIGTERM')
  daemon = null
}
process.on('exit', () => {
  stop()
  tailscaled.close()
  fs.rmSync(sandbox, { recursive: true, force: true })
})

function start() {
  daemon = spawn(process.execPath, [path.join(root, 'bin', 'omarchy-connect.js'), 'start', '--port', String(PORT)], {
    env: {
      ...process.env,
      XDG_CONFIG_HOME: sandbox,
      OMARCHY_CONNECT_STATE: path.join(sandbox, 'state'),
      OMARCHY_CONNECT_LOG: 'warn',
      OMARCHY_CONNECT_TAILSCALE_SOCKET: socketPath,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  daemon.stderr.on('data', (chunk) => {
    const line = String(chunk)
    if (/error/i.test(line)) process.stderr.write(line)
  })
  return daemon
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

async function info() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/api/info`)
      if (res.ok) return res.json()
    } catch {
      /* not up yet */
    }
    await wait(200)
  }
  throw new Error('the daemon never came up')
}

/** A hello, from the first socket that gets in. */
function greet(publicKey, payload) {
  return new Promise((resolve, reject) => {
    const phone = connectPhone(PORT, publicKey)
    phone.on((msg) => {
      if (msg.t === 'hello.ok') resolve({ hello: msg, phone })
      if (msg.t === 'paired') resolve({ paired: msg, phone })
      if (msg.t === 'hello.err') reject(new Error(msg.error))
    })
    phone.ready.then(() => phone.send({ t: 'hello', ...payload })).catch(reject)
  })
}

/* ── first run: get paired, and learn the server's key ──────────────────── */

start()
const desktop = await info()
const pair = await fetch(`http://127.0.0.1:${PORT}/api/pair-code`, { method: 'POST', headers: local() }).then((r) =>
  r.json(),
)
const first = await greet(desktop.publicKey, {
  pairCode: pair.code,
  device: { id: 'race-phone', name: 'Race Phone' },
})
const token = first.paired?.token
check('the phone paired on the first run', typeof token === 'string' && token.length > 0)
first.phone.close()
stop()
await wait(500)

/* ── second run: dial from before there is a port ───────────────────────── */

answeredAt = 0
const startedAt = Date.now()
start()

let greeting = null
let openedAt = 0
const deadline = Date.now() + 20_000
while (!greeting && Date.now() < deadline) {
  try {
    const result = await greet(desktop.publicKey, { token, device: { id: 'race-phone', name: 'Race Phone' } })
    openedAt = Date.now()
    greeting = result
  } catch {
    await wait(5)
  }
}
if (!greeting) throw new Error('the second run never answered a hello')

const hosts = (greeting.hello.endpoints || []).map((e) => `${e.host}/${e.kind}`)

check(
  'the very first hello after a restart is handed the tunnel address',
  (greeting.hello.endpoints || []).some((e) => e.host === TUNNEL),
  hosts.join(' ') || 'nothing',
)
check(
  'because the port does not open until the overlay has been looked up',
  answeredAt > 0 && openedAt >= answeredAt,
  `tailscaled answered at +${answeredAt - startedAt}ms, the first hello landed at +${openedAt - startedAt}ms`,
)

greeting.phone.close()
stop()
done()
