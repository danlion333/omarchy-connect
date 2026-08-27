/**
 * Runs the real app client (src/api/client.ts) against the real daemon, so the
 * protocol is verified on both sides rather than by two copies of the same
 * assumptions. Node strips the TypeScript types for us.
 */
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ConnectClient } from '../src/api/client.ts'
import { magicPacket, wakeTargets } from '../src/lib/wol.ts'

const PORT = Number(process.env.PORT || 8801)
const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`)
}

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'omarchy-connect-test-'))
const daemon = spawn(process.execPath, ['daemon/bin/omarchy-connect.js', 'start', '--port', String(PORT)], {
  cwd: new URL('../..', import.meta.url).pathname,
  // The status file the desktop client reads is real state — without moving it
  // aside a test run overwrites the record of the daemon you are actually
  // using, and the bar panel goes blank for reasons nothing explains.
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
  fs.rmSync(sandbox, { recursive: true, force: true })
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
const { code } = await (await fetch(`${base}/api/pair-code`, { method: 'POST' })).json()

const client = new ConnectClient({
  host: '127.0.0.1',
  port: PORT,
  pairCode: code,
  publicKey: info.publicKey,
  device: { id: 'integration-test', name: 'Test Phone', platform: 'ios', model: 'node' },
})

check('client derives the same fingerprint as the desktop', client.fingerprint === info.fingerprint, client.fingerprint)

const events = []
client.on('ev', (msg) => events.push(msg))

const hello = await new Promise((resolve, reject) => {
  client.on('hello', resolve)
  client.on('unauthorized', (e) => reject(new Error(e)))
  setTimeout(() => reject(new Error('handshake timed out')), 10000)
  client.connect()
})

check('client pairs and receives hello', hello.protocol === 2, `${hello.server.name} · ${hello.host.os}`)
check('the channel is encrypted end to end', hello.secure === true && hello.fingerprint === info.fingerprint)
check('token is stored on the client', typeof client.token === 'string' && client.token.length === 64)
check('capabilities arrive', Object.keys(hello.capabilities).length >= 6)
check('theme arrives', typeof hello.theme.background === 'string', hello.theme.name)

// Wake-on-LAN is the one thing the phone has to be told before it needs it:
// once the desktop is asleep there is nothing left to ask.
check('the desktop says how it could be woken', hello.wake && typeof hello.wake.supported === 'boolean',
  hello.wake ? `${hello.wake.interface ?? 'no link'} ${hello.wake.mac ?? ''}`.trim() : 'absent')
check(
  'and what it says is enough to build a packet with',
  hello.wake?.supported !== true ||
    (magicPacket(hello.wake.mac).length === 102 && wakeTargets(hello.wake, null, null).length > 0),
  hello.wake?.broadcast ? `${hello.wake.broadcast}:${hello.wake.port}` : 'no broadcast address',
)

const stats = await client.call('system.stats')
check('client.call round trip', stats.memory.total > 0, `${stats.network.type} ${stats.network.ip ?? ''}`)

await client.call('clipboard.set', { text: 'integration test' })
const clip = await client.call('clipboard.get')
check('clipboard through the client', clip.text === 'integration test')

const failure = await client.call('theme.set', { name: 'no-such-theme' }).catch((e) => e.message)
check('errors surface as rejections', typeof failure === 'string' && failure.length > 0, String(failure).slice(0, 60))

await sleep(2200)
check('stats events reach the client', events.filter((e) => e.event === 'stats').length >= 2)

// Reconnect: the token from pairing must be enough on its own.
const second = new ConnectClient({
  host: '127.0.0.1',
  port: PORT,
  token: client.token,
  publicKey: info.publicKey,
  device: { id: 'integration-test', name: 'Test Phone', platform: 'ios', model: 'node' },
})
const rehello = await new Promise((resolve, reject) => {
  second.on('hello', resolve)
  second.on('unauthorized', (e) => reject(new Error(e)))
  setTimeout(() => reject(new Error('reconnect timed out')), 10000)
  second.connect()
})
check('token reconnect works', rehello.device.id === 'integration-test')

const rogue = new ConnectClient({
  host: '127.0.0.1',
  port: PORT,
  token: 'f'.repeat(64),
  publicKey: info.publicKey,
  device: { id: 'rogue', name: 'Rogue', platform: 'android' },
})
const rejected = await new Promise((resolve) => {
  rogue.on('unauthorized', () => resolve(true))
  rogue.on('hello', () => resolve(false))
  setTimeout(() => resolve(false), 8000)
  rogue.connect()
})
check('a bogus token is rejected', rejected)

// Pinning is the whole point: a desktop that cannot prove it holds the key we
// remember must not be able to talk to us, however friendly it sounds.
const impostor = new ConnectClient({
  host: '127.0.0.1',
  port: PORT,
  token: client.token,
  publicKey: 'ab'.repeat(32),
  device: { id: 'integration-test', name: 'Test Phone', platform: 'ios', model: 'node' },
})
const pinned = await new Promise((resolve) => {
  impostor.on('unauthorized', () => resolve(true))
  impostor.on('hello', () => resolve(false))
  setTimeout(() => resolve(false), 8000)
  impostor.connect()
})
check('a desktop with the wrong identity key is refused', pinned)
impostor.close()

client.close()
second.close()
rogue.close()
daemon.kill('SIGTERM')

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length ? 1 : 0)
