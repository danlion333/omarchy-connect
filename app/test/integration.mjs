/**
 * Runs the real app client (src/api/client.ts) against the real daemon, so the
 * protocol is verified on both sides rather than by two copies of the same
 * assumptions. Node strips the TypeScript types for us.
 */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { setTimeout as sleep } from 'node:timers/promises'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { localHeaders } from '../../daemon/test/sandbox.mjs'
import { ConnectClient } from '../src/api/client.ts'
import { mergeEndpoints } from '../src/lib/endpoints.ts'

const PORT = Number(process.env.PORT || 8801)
const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`)
}

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'omarchy-connect-test-'))

// The daemon's local routes are gated on the secret in its status file; a
// caller reads it the way the CLI does.
const local = () => localHeaders(`${sandbox}/state`)
// Set on this process too, not only on the daemon below: the impostor test at
// the end loads the daemon's own crypto in here, and that reads the identity
// key out of the config directory this points at. Pointing it at the sandbox
// is what makes the fake desktop hold the same key as the real one — and it
// keeps a test run from ever opening the config of the daemon you use.
process.env.XDG_CONFIG_HOME = sandbox
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
  fs.rmSync(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
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
const { code } = await (await fetch(`${base}/api/pair-code`, { method: 'POST', headers: local() })).json()

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

/* ── the addresses this desktop says it has ─────────────────────────────── */

check('the desktop hands over the addresses it can be dialled on',
  Array.isArray(hello.endpoints) && hello.endpoints.length > 0,
  (hello.endpoints || []).map((e) => `${e.host} (${e.kind})`).join(', '))
check('and says how this socket got here', hello.link?.via === 'lan', JSON.stringify(hello.link))
check('with remote off, no tunnel is offered', !(hello.endpoints || []).some((e) => e.kind !== 'lan'))
check('the client takes the list it was handed',
  client.endpoints.length === 0 || client.endpoints.every((e) => typeof e.host === 'string'))

// What `api/link` does with the list, without the keychain in the way: the
// merge is the part with the rule in it, and the rule is that an address
// somebody typed in outlives whatever the desktop advertises.
const typed = { host: '203.0.113.9', port: 8765, kind: 'manual', source: 'manual' }
const merged = mergeEndpoints([typed], hello.endpoints.map((e) => ({ ...e, source: 'hello' })))
check('a typed-in address survives what the desktop advertises',
  merged.some((e) => e.source === 'manual') && merged.length === hello.endpoints.length + 1,
  merged.map((e) => e.kind).join(' '))

client.setEndpoints(merged)
check('and the client dials down the merged list',
  client.endpoints.length === merged.length)

const stats = await client.call('system.stats')
check('client.call round trip', stats.memory.total > 0, `${stats.network.type} ${stats.network.ip ?? ''}`)

await client.call('clipboard.set', { text: 'integration test' })
const clip = await client.call('clipboard.get')
check('clipboard through the client', clip.text === 'integration test')

const failure = await client.call('theme.set', { name: 'no-such-theme' }).catch((e) => e.message)
check('errors surface as rejections', typeof failure === 'string' && failure.length > 0, String(failure).slice(0, 60))

// Asked for rather than assumed: the stats feed is subscribed by whatever is
// on screen to read it and by nothing else, so a client nobody is looking at
// gets none. `stats-pause` is the suite about that; this one only wants to see
// an event channel carry something end to end.
const statsFrom = events.filter((e) => e.event === 'stats').length
client.subscribe(['stats'])
await sleep(2200)
check('stats events reach the client once asked for', events.filter((e) => e.event === 'stats').length - statsFrom >= 2)
client.unsubscribe(['stats'])

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

/* ── a text frame is nobody ─────────────────────────── */

// The link is plain TCP unless somebody turns TLS on, so a neighbour who can
// spoof their way onto the wire can push a frame at the phone. Every frame the
// desktop sends after the key exchange is encrypted, which makes a *text*
// frame proof of an impostor rather than a message — and it used to be parsed
// as trusted: an `ev:phone` that sends an SMS from this handset, a `hello.ok`
// that rewrites the addresses the phone remembers.
//
// The fake desktop below is the real server-side handshake (the daemon's own
// `accept`, reading the same identity key out of the sandbox) with one thing
// changed: where the encrypted `hello.ok` belongs, it sends text.
{
  // React Native has no WebSocket server and the app has no need of one; the
  // daemon next door already depends on the library, so borrow it from there.
  const require = createRequire(new URL('../../daemon/package.json', import.meta.url))
  const { WebSocketServer } = require('ws')
  const { accept } = await import('../../daemon/src/lib/crypto.js')

  // Not `PORT + 1`: the suites run side by side, and `PORT + 1` is the port
  // `daemon/test/agents.mjs` starts its own daemon on. Two suites that never
  // met until a third was added to the run then raced for it, and the loser
  // died on `EADDRINUSE` after passing every check it had got to — a failure
  // that says nothing about either test. A port nothing else claims is the
  // whole fix.
  const FAKE = PORT + 19
  const forgedHello = JSON.stringify({
    t: 'hello.ok',
    protocol: 2,
    secure: true,
    endpoints: [{ host: '198.51.100.7', port: 9, kind: 'lan' }],
  })
  const forgedSms = JSON.stringify({
    t: 'ev',
    event: 'phone',
    data: { action: 'send', to: '+15550100', body: 'sent by nobody' },
  })

  // 'before' injects the frame in place of the handshake reply; 'after'
  // completes the handshake honestly and injects once the channel is up.
  let when = 'before'
  const wss = new WebSocketServer({ port: FAKE, path: '/ws' })
  wss.on('connection', (ws) => {
    if (when === 'before') return ws.send(forgedHello)
    let handshaken = false
    ws.on('message', (data) => {
      if (handshaken) return
      handshaken = true
      try {
        const { reply } = accept(Buffer.from(data))
        ws.send(reply, { binary: true })
        ws.send(forgedSms)
      } catch {
        ws.close()
      }
    })
  })
  await new Promise((resolve) => wss.on('listening', resolve))

  const inject = async (phase) => {
    when = phase
    const victim = new ConnectClient({
      host: '127.0.0.1',
      port: FAKE,
      token: client.token,
      publicKey: info.publicKey,
      device: { id: 'integration-test', name: 'Test Phone', platform: 'android', model: 'node' },
    })
    const seen = []
    for (const name of ['hello', 'ev', 'ev:phone', 'paired', 'server-error', 'latency']) {
      victim.on(name, () => seen.push(name))
    }
    await new Promise((resolve) => {
      victim.on('status', ({ status }) => {
        if (status === 'error') resolve()
      })
      setTimeout(resolve, 6000)
      victim.connect()
    })
    // Read the outcome before closing: `close()` is the user hanging up, and
    // it puts the client back to idle with no error to report.
    const outcome = { seen, status: victim.status, error: victim.lastError, hello: victim.hello,
      endpoints: victim.endpoints, token: victim.token }
    victim.close()
    return outcome
  }

  const early = await inject('before')
  check('a text frame instead of the handshake reply is refused',
    early.status === 'error' && /unencrypted/.test(early.error || ''),
    `${early.status} · ${early.error}`)
  check('and nothing in it reaches a listener', early.seen.length === 0, early.seen.join(' '))

  const late = await inject('after')
  check('a text frame after a real key exchange is refused too',
    late.status === 'error' && /unencrypted/.test(late.error || ''),
    `${late.status} · ${late.error}`)
  check('and no `ev:phone` is emitted for `phone.ts` to send an SMS from',
    late.seen.length === 0, late.seen.join(' '))
  // `link.ts` writes the pairing from what `hello.ok` carries, so nothing that
  // arrived in the clear may be the source of that write.
  check('the remembered pairing is untouched by either',
    early.hello === null && late.hello === null &&
      early.endpoints.length === 0 && late.endpoints.length === 0 &&
      early.token === client.token && late.token === client.token)

  wss.close()
}

/* ── the network the client asks about rather than remembers ─────────── */

// Android reports a network change with a callback, and the last network going
// away is the change after which no further callback arrives — so a phone in
// aeroplane mode used to sit on the description it was handed at the moment of
// the loss and dial all night on the strength of it. The client now asks
// before every dial, and this is that asking: the pushed answer says the phone
// is on the local wire, the pulled one says there is no network at all, and
// the dial has to go by the second.
{
  let facts = { online: true, lan: true, vpn: false }
  const asks = new ConnectClient({
    host: '127.0.0.1',
    port: PORT,
    token: client.token,
    publicKey: info.publicKey,
    device: { id: 'integration-test', name: 'Test Phone', platform: 'android', model: 'node' },
    network: () => facts,
  })
  // What a change event would have left behind, and what used to be believed.
  asks.setNetwork({ online: true, lan: true, vpn: false })
  facts = { online: false, lan: false, vpn: false }
  asks.connect()
  check('a stale description of the network does not get a dial', asks.status === 'parked', asks.status)
  check('and the shade is told which kind of waiting it is', asks.parkedNote === 'waiting for a network', asks.parkedNote)

  // And back: the phone rejoins a network, and the fresh reading is what lets
  // it through — the same pull, on the same code path.
  facts = { online: true, lan: true, vpn: false }
  const back = await new Promise((resolve, reject) => {
    asks.on('hello', resolve)
    asks.on('unauthorized', (e) => reject(new Error(e)))
    setTimeout(() => reject(new Error('reconnect timed out')), 10000)
    asks.reconnectNow()
  })
  check('a network that came back is dialled on the next reading', back.device.id === 'integration-test')
  asks.close()
}

/* ── coming home ─────────────────────────────────────────────────────── */

// The bug: candidates were ordered at the moment of dialling and a live socket
// was never dialled again, so a phone that came home over a tunnel stayed on
// the tunnel until that socket happened to die — and the desktop reads such a
// link as remote, which is what switches every telephony surface off. The
// phone now asks, on a network change, whether a better road has opened, and
// follows it only once that address has answered with the key we pinned.
{
  const probe = async (host, port) => {
    try {
      const res = await fetch(`http://${host}:${port}/api/info`, { signal: AbortSignal.timeout(2000) })
      if (!res.ok) return null
      const body = await res.json()
      return { publicKey: body.publicKey ?? null, certPin: null }
    } catch {
      return null
    }
  }
  // Two ways to the same daemon — the loopback range is all one machine, which
  // is what lets one process stand in for a desktop with a tunnel address and
  // a home address at once.
  let facts = { online: true, lan: false, vpn: true }
  const away = new ConnectClient({
    host: '127.0.0.1',
    port: PORT,
    token: client.token,
    publicKey: info.publicKey,
    device: { id: 'integration-test', name: 'Test Phone', platform: 'android', model: 'node' },
    network: () => facts,
    probe,
    endpoints: [
      { host: '127.0.0.1', port: PORT, kind: 'tailscale', source: 'hello' },
      { host: '127.0.0.2', port: PORT, kind: 'lan', source: 'hello' },
    ],
  })
  await new Promise((resolve, reject) => {
    away.on('hello', resolve)
    away.on('unauthorized', (e) => reject(new Error(e)))
    setTimeout(() => reject(new Error('remote dial timed out')), 10000)
    away.connect()
  })
  check('off the wire, the tunnel address is the one dialled', away.host === '127.0.0.1', away.host)

  // Wi-Fi comes back. Nothing about the socket has changed — it is open and
  // working — and that used to be the end of it.
  const home = new Promise((resolve, reject) => {
    away.on('hello', resolve)
    setTimeout(() => reject(new Error('did not move to the local address')), 10000)
  })
  facts = { online: true, lan: true, vpn: false }
  away.setNetwork(facts)
  await home
  check('a working socket moves to the local wire when the phone comes home', away.host === '127.0.0.2', away.host)
  away.close()
}

client.close()
second.close()
rogue.close()
daemon.kill('SIGTERM')

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length ? 1 : 0)
