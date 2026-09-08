/**
 * What a hello does when the disk will not take the config write it makes.
 *
 * Every hello writes: `touchDevice` stamps `lastSeen`, and a phone that
 * renamed itself goes through `upsertDevice` as well. Both land in
 * `saveConfig`, which is `mkdirSync` / `writeFileSync` / `renameSync` with no
 * `try` anywhere near it. The handler that called them is `async`, so a throw
 * became a rejected promise nobody was waiting on — a line from the crash
 * guard, and then silence.
 *
 * Silence was the bug. The throw happened after the socket had been given its
 * device and after its ten-second handshake timer had been cleared, so the
 * daemon was left holding an authenticated socket that had never been greeted
 * and would never be closed, while the app — which clears `connecting` only on
 * `hello.ok` — sat in `connecting` until somebody killed it by hand.
 *
 * The failure is injected the honest way, by taking the write bit off the
 * config directory, so what is exercised is a real ENOSPC/EACCES shape rather
 * than a stubbed function agreeing to fail.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { check, done } from '../../tools/test-harness.mjs'
import { connectPhone } from './phone.mjs'
import { quietBluetooth, localHeaders } from './sandbox.mjs'

const PORT = Number(process.env.PORT || 8829)
const base = `http://127.0.0.1:${PORT}`
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'omarchy-connect-hello-write-'))
const configDir = path.join(sandbox, 'omarchy-connect')
const local = () => localHeaders(path.join(sandbox, 'state'))
quietBluetooth(sandbox)

const daemon = spawn(process.execPath, [path.join(root, 'bin', 'omarchy-connect.js'), 'start', '--port', String(PORT)], {
  env: {
    ...process.env,
    XDG_CONFIG_HOME: sandbox,
    OMARCHY_CONNECT_STATE: path.join(sandbox, 'state'),
    OMARCHY_CONNECT_LOG: 'error',
  },
  stdio: ['ignore', 'ignore', 'inherit'],
})
const writable = () => fs.chmodSync(configDir, 0o700)
process.on('exit', () => {
  daemon.kill('SIGTERM')
  try {
    writable()
  } catch {
    /* the directory may already be gone */
  }
  fs.rmSync(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

for (let i = 0; i < 40; i += 1) {
  try {
    if ((await fetch(`${base}/api/info`)).ok) break
  } catch {
    await new Promise((r) => setTimeout(r, 250))
  }
}

const info = await (await fetch(`${base}/api/info`)).json()

/** One socket, one hello, and whatever the desktop said back. */
function greet(message, { ms = 8000 } = {}) {
  const phone = connectPhone(PORT, info.publicKey)
  return new Promise((resolve) => {
    const outcome = { ok: null, err: null, closed: null, phone }
    const finish = () => resolve(outcome)
    const timer = setTimeout(finish, ms)
    phone.ws.on('close', (code) => {
      outcome.closed = code
      clearTimeout(timer)
      finish()
    })
    phone.on((msg) => {
      if (msg.t === 'paired') outcome.token = msg.token
      if (msg.t === 'hello.ok') {
        outcome.ok = msg
        clearTimeout(timer)
        finish()
      }
      if (msg.t === 'hello.err') outcome.err = msg.error
    })
    phone.ready.then(() => phone.send(message)).catch((err) => {
      outcome.err = err.message
      clearTimeout(timer)
      finish()
    })
  })
}

const identity = (name) => ({ id: 'hello-write-device', name, platform: 'android', model: 'Test' })

/* ── a phone that pairs while the disk is fine ─────────────────────────── */

const code = (await (await fetch(`${base}/api/pair-code`, { method: 'POST', headers: local() })).json()).code
const paired = await greet({ t: 'hello', pairCode: code, device: identity('Test phone') })
const token = paired.token
check('the test phone pairs', Boolean(paired.ok) && typeof token === 'string', paired.err || '')
paired.phone.close()

/* ── a hello whose config write cannot land ────────────────────────────── */

// A rename is the load-bearing write on the hello path: it goes through
// `upsertDevice`, and the device it produces is the one the socket is given.
fs.chmodSync(configDir, 0o500)
const broken = await greet({ t: 'hello', token, device: identity('Renamed phone') })
check('a hello whose config write throws is answered with hello.err', Boolean(broken.err), String(broken.err))
check('and the socket is closed rather than left hanging', broken.closed !== null, String(broken.closed))
check(
  'with a code the phone reads as "try again", not as a revoked pairing',
  broken.closed !== 4003 && broken.closed !== 4005,
  String(broken.closed),
)

// The proof that the socket did not stay in `clients` holding a device: the
// daemon's own view of who is connected.
const state = await (await fetch(`${base}/api/info`)).json()
check('the daemon is still answering afterwards', Boolean(state.publicKey))
const status = JSON.parse(fs.readFileSync(path.join(sandbox, 'state', 'status.json'), 'utf8'))
check(
  'and it is not holding the failed socket as a connected device',
  !(status.devices || []).some((d) => d.online),
  JSON.stringify((status.devices || []).map((d) => [d.name, d.online])),
)

/* ── and the next hello, once the disk is back ─────────────────────────── */

writable()
const again = await greet({ t: 'hello', token, device: identity('Renamed phone') })
check('the same token connects normally afterwards', Boolean(again.ok), again.err || String(again.closed))
check('and the rename it was carrying landed', again.ok?.device?.name === 'Renamed phone', again.ok?.device?.name)
again.phone.close()

/* ── a write that only telemetry cared about ───────────────────────────── */

// Nothing but `lastSeen` is written by a hello that carries the name the
// desktop already has, and `lastSeen` is not worth a connection.
await new Promise((r) => setTimeout(r, 300))
fs.chmodSync(configDir, 0o500)
const telemetry = await greet({ t: 'hello', token, device: identity('Renamed phone') })
check(
  'a hello whose only failing write is lastSeen still gets hello.ok',
  Boolean(telemetry.ok),
  telemetry.err || String(telemetry.closed),
)
telemetry.phone.close()
writable()

done('hello write-failure checks')
