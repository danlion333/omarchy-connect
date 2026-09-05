/**
 * The address list the desktop sends *after* it has said hello.
 *
 * A hello carries every address the desktop can be dialled on, and the phone
 * writes that list over the one in its keychain — the desktop is the authority
 * on its own addresses, so an address it has stopped advertising is one it has
 * stopped answering on. That rule is right, and it is exactly what made the
 * correction matter: a daemon that greeted the phone before it had looked its
 * own tunnel up handed over a LAN-only list, the phone stored it, and the
 * tunnel address was gone from the keychain.
 *
 * The desktop does correct itself. `announceEndpoints` pushes `ev endpoints`
 * the moment the list changes — a tunnel coming up, remote access being
 * switched on — and the client took it into memory. Nothing wrote it down. So
 * the correction lived exactly as long as the process did, and a phone whose
 * app Android had torn down came back holding the list from the bad hello,
 * with nothing to dial from outside the house and no error to show for it.
 *
 * Run against the real daemon and the real `api/link`, because the question is
 * about the wiring between the two: whether the event reaches storage at all.
 * The tunnel is a `tailscaled` of the suite's own on a unix socket, and it is
 * brought into the list by switching remote access on rather than by waiting
 * out the daemon's environment tick.
 */
import module from 'node:module'
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

import { localHeaders } from '../../daemon/test/sandbox.mjs'
import { check, done } from '../../tools/test-harness.mjs'

module.register('./stubs/loader.mjs', import.meta.url)

const PORT = Number(process.env.PORT || 8815)
const TUNNEL = '100.98.11.123'

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'omarchy-connect-endpoints-event-'))
const local = () => localHeaders(`${sandbox}/state`)
const socketPath = path.join(sandbox, 'tailscaled.sock')

/* ── a tunnel to be told about ──────────────────────────────────────────── */

const status = JSON.stringify({
  Self: { TailscaleIPs: [TUNNEL], DNSName: 'desk.fake.ts.net.', KeyExpiry: new Date(Date.now() + 6e8).toISOString() },
})
const tailscaled = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(status)
})
await new Promise((resolve) => tailscaled.listen(socketPath, resolve))

// Remote access starts off, so the first hello is honestly LAN-only — the
// same list a daemon that has not looked up its tunnel yet would send.
fs.mkdirSync(path.join(sandbox, 'omarchy-connect'), { recursive: true })
fs.writeFileSync(
  path.join(sandbox, 'omarchy-connect', 'config.json'),
  JSON.stringify({ port: PORT, remote: { enabled: false }, devices: [] }, null, 2),
)

const daemon = spawn(process.execPath, ['daemon/bin/omarchy-connect.js', 'start', '--port', String(PORT)], {
  cwd: new URL('../..', import.meta.url).pathname,
  env: {
    ...process.env,
    XDG_CONFIG_HOME: sandbox,
    OMARCHY_CONNECT_STATE: `${sandbox}/state`,
    OMARCHY_CONNECT_LOG: 'warn',
    OMARCHY_CONNECT_TAILSCALE_SOCKET: socketPath,
  },
  stdio: ['ignore', 'ignore', 'inherit'],
})
process.on('exit', () => {
  daemon.kill('SIGTERM')
  tailscaled.close()
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

/* ── the phone ──────────────────────────────────────────────────────────── */

const { link } = await import('../src/api/link.ts')
const { loadDesktop } = await import('../src/api/storage.ts')

const stored = async () => ((await loadDesktop())?.endpoints ?? []).map((e) => `${e.host}/${e.kind}`)
const hasTunnel = async () => (await stored()).some((entry) => entry.startsWith(TUNNEL))

await link.pair({
  host: '127.0.0.1',
  port: PORT,
  code,
  name: 'Test Desktop',
  publicKey: info.publicKey,
  tls: false,
  certPin: null,
})

// What the desktop is advertising with remote access off: its LAN address and
// nothing else. That is the state the phone has just been greeted in, and it
// is the shape of the bad hello this is all about — a list with no way into
// the house from outside it.
const control = (op) =>
  fetch(`${base}/api/remote/control`, { method: 'POST', headers: local(), body: JSON.stringify({ op }) }).then((r) =>
    r.json(),
  )
const lanAdvertised = (await control('status')).remote.endpoints.map((e) => `${e.host}/${e.kind}`)
check('with remote off the desktop advertises no tunnel',
  lanAdvertised.length > 0 && !lanAdvertised.some((entry) => entry.startsWith(TUNNEL)), lanAdvertised.join(' '))

const lanOnly = await stored()
check('so the phone comes out of the hello with no tunnel address to dial',
  lanOnly.length > 0 && !lanOnly.some((entry) => entry.startsWith(TUNNEL)), lanOnly.join(' ') || 'nothing')

/* ── and then the desktop corrects itself ───────────────────────────────── */

await control('enable')

for (let i = 0; i < 100 && !(await hasTunnel()); i += 1) await sleep(100)

const after = await stored()
check('an `ev endpoints` carrying a tunnel address is written down, not only remembered',
  after.some((entry) => entry.startsWith(TUNNEL)), after.join(' ') || 'nothing')
check('together with the LAN address the same event named',
  lanAdvertised.every((entry) => after.includes(entry)), after.join(' '))

/* ── a typed-in address still outlives all of it ────────────────────────── */

// A real address, because `addEndpoint` refuses one that does not answer as
// this desktop — `localhost` is the same daemon under another name.
const added = await link.addEndpoint('localhost', PORT)
check('an address typed in by hand is accepted', added.ok === true, added.error ?? '')

await control('disable')
for (let i = 0; i < 100 && (await hasTunnel()); i += 1) await sleep(100)

const narrowed = await stored()
check('switching remote off takes the tunnel back out of the keychain too',
  !narrowed.some((entry) => entry.startsWith(TUNNEL)), narrowed.join(' '))
check('but an address somebody typed in survives the event, as it does a hello',
  narrowed.some((entry) => entry.startsWith('localhost')), narrowed.join(' '))

await link.forget()
done('endpoint event checks')
