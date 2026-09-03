/**
 * The gate on the daemon's own local routes.
 *
 * These endpoints send an SMS from the paired phone, mint a pairing code, drop
 * the pairing, flip the remote and agent switches. They used to be guarded by
 * the peer address and nothing else, which admits every process on the machine
 * — and, through a `no-cors` form POST from a page in a browser, something
 * that is not even on the machine. So the daemon now asks for a secret it
 * publishes in its own 0600 status file, plus two things a web page cannot
 * produce: a header of the daemon's own naming and a JSON content type. A
 * request that carries an `Origin` at all is a request from a page, and is
 * refused whatever else it brought.
 *
 * What is checked here is the gate, on one representative route, and then the
 * two callers that have to keep working through it: the CLI, which is also the
 * road the shell panel takes, and `/api/info`, which is deliberately open
 * because it is how a phone finds this desktop in the first place.
 */
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { check, done } from '../../tools/test-harness.mjs'
import { quietBluetooth } from './sandbox.mjs'

const PORT = Number(process.env.PORT || 8812)
const base = `http://127.0.0.1:${PORT}`
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'omarchy-connect-local-auth-'))
const stateDir = path.join(sandbox, 'state')

quietBluetooth(sandbox)

const daemon = spawn(process.execPath, [path.join(root, 'bin', 'omarchy-connect.js'), 'start', '--port', String(PORT)], {
  env: {
    ...process.env,
    HOME: sandbox,
    XDG_CONFIG_HOME: sandbox,
    OMARCHY_CONNECT_STATE: stateDir,
    OMARCHY_CONNECT_LOG: 'error',
  },
  stdio: ['ignore', 'ignore', 'inherit'],
})
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

const status = () => JSON.parse(fs.readFileSync(path.join(stateDir, 'status.json'), 'utf8'))
const secret = status().localSecret

/* ── the secret itself ────────────────────────────────────────────────── */

check('the daemon publishes a local secret', typeof secret === 'string' && secret.length >= 32)
check(
  'and the status file it is in stays readable by nobody else',
  (fs.statSync(path.join(stateDir, 'status.json')).mode & 0o077) === 0,
)

/* ── the gate, on a route that mints a pairing code ───────────────────── */

const pairCode = (headers) => fetch(`${base}/api/pair-code`, { method: 'POST', headers })

const good = { 'content-type': 'application/json', 'x-oc-local': secret }

check('a local POST with no secret is refused', (await pairCode({ 'content-type': 'application/json' })).status === 403)
check(
  'and so is one holding the wrong secret',
  (await pairCode({ 'content-type': 'application/json', 'x-oc-local': 'x'.repeat(secret.length) })).status === 403,
)
check(
  'a secret of the wrong length is refused rather than throwing',
  (await pairCode({ 'content-type': 'application/json', 'x-oc-local': 'short' })).status === 403,
)
check('a form-style content type is refused', (await pairCode({ ...good, 'content-type': 'text/plain' })).status === 403)
check('so is a request with no content type at all', (await pairCode({ 'x-oc-local': secret })).status === 403)
check(
  'a request carrying an Origin is refused even holding the secret',
  (await pairCode({ ...good, origin: 'https://evil.example' })).status === 403,
)

// `no-cors` is the shape of the attack this was written for: a page can make
// the browser send this, and cannot read a word of what comes back — but the
// daemon would still have sent the SMS. It is refused before that.
const forged = await fetch(`${base}/api/pair-code`, {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'https://evil.example' },
  body: 'id=smoke-test-device',
})
check('a browser-shaped form post is refused', forged.status === 403)
check('and it is told nothing about why', (await forged.json()).error === 'localhost only')

const minted = await pairCode(good)
const mintedBody = await minted.json()
check('the same request with the secret works', minted.status === 200, `status ${minted.status}`)
check('and it really did mint a code', /^\d{6}$/.test(mintedBody.code || ''), mintedBody.code)

/* ── what is deliberately still open ──────────────────────────────────── */

const info = await fetch(`${base}/api/info`)
check('/api/info is still answered without any of it', info.ok && (await info.json()).app === 'omarchy-connect')

/* ── the CLI, which is also the panel's road ──────────────────────────── */

// The panel drives every one of these endpoints by running the CLI, so a CLI
// that still gets through is a panel that still gets through. `agent enable`
// is the cheapest of them to ask for: it is a switch, the daemon owns the
// write, and the CLI warns on stderr when the running daemon would not take
// it — which is exactly what a rejected request would look like.
const cli = spawnSync(process.execPath, [path.join(root, 'bin', 'omarchy-connect.js'), 'agent', 'enable'], {
  env: {
    ...process.env,
    HOME: sandbox,
    XDG_CONFIG_HOME: sandbox,
    OMARCHY_CONNECT_STATE: stateDir,
  },
  encoding: 'utf8',
})
check('the CLI drives a gated route unchanged', cli.status === 0, cli.stderr?.trim())
check('and the running daemon took it', /did not take it/.test(cli.stderr || '') === false)
check('so the switch is live in the status file', status().agents?.enabled === true)

/* ── one run, one secret ──────────────────────────────────────────────── */

// Both readers open the file again on their next command, so rotating on every
// start costs nothing — and a secret that outlived the daemon that minted it
// would be a password lying in a file with nothing behind it.
check('the secret is stable while the daemon runs', status().localSecret === secret)

daemon.kill('SIGTERM')
for (let i = 0; i < 40 && status().running; i += 1) await new Promise((r) => setTimeout(r, 250))
check('a stopped daemon leaves no secret behind', status().localSecret === null)

done('local-auth checks')
