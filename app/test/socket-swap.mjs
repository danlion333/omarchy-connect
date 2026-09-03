/**
 * What a socket the client has already replaced is still allowed to do.
 *
 * `Client` opens a WebSocket and hangs four handlers off it, and each of them
 * closed over `this`. That is right for as long as the socket is the client's
 * socket, and wrong the moment it is not: `moveTo` drops the old socket and
 * dials a new address, and React Native delivers the dropped socket's last
 * events on a later tick — by which time the replacement is up. The `onclose`
 * arriving then ran `stopPing()` and `scheduleReconnect()` against the live
 * connection: the ping went off, the status was pinned to `reconnecting`, and
 * the link underneath was perfectly fine. No error, no retry, nothing in the
 * log — just a wrong badge on a working phone, until somebody killed the app.
 *
 * So: one real daemon, one client, and a socket swap between two names for the
 * same address. The handlers of the socket that lost are kept, the way the
 * platform keeps them, and fired afterwards. Nothing they do may reach the
 * connection that won.
 */
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { localHeaders } from '../../daemon/test/sandbox.mjs'
import { ConnectClient } from '../src/api/client.ts'
import { check, done } from '../../tools/test-harness.mjs'

const PORT = Number(process.env.PORT || 8813)
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'omarchy-connect-swap-'))
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

// No `probe`, so nothing here races or upgrades an address on its own: the
// only socket swap in this suite is the one it asks for.
const client = new ConnectClient({
  host: '127.0.0.1',
  port: PORT,
  pairCode: code,
  publicKey: info.publicKey,
  device: { id: 'swap-test', name: 'Test Phone', platform: 'android', model: 'node' },
})

const statuses = []
client.on('status', (s) => statuses.push(s.status))

const helloOnce = (ms) =>
  new Promise((resolve) => {
    const off = client.on('hello', (data) => {
      off()
      resolve(data)
    })
    setTimeout(() => {
      off()
      resolve(null)
    }, ms)
  })

const first = helloOnce(15000)
client.connect()
check('the phone gets a link to start with', (await first) !== null && client.status === 'connected', client.status)
check('and the ping is running on it', client.pingTimer !== null)

/* ── the socket that is about to lose ───────────────────────────────────── */

// Held exactly the way the platform holds them: the socket object and the four
// functions that were on it at the moment it was the client's socket.
const zombie = client.ws
const late = {
  onopen: zombie.onopen,
  onmessage: zombie.onmessage,
  onerror: zombie.onerror,
  onclose: zombie.onclose,
}
check('the losing socket had handlers to begin with', Object.values(late).every((fn) => typeof fn === 'function'))

// Two names for one daemon: a real second handshake, on a socket the client
// treats as a move onto an unproven address, with nothing else changing.
const second = helloOnce(20000)
client.moveTo('localhost', PORT)
check('the client follows the address', client.host === 'localhost')
check('and takes the handlers off the socket it dropped',
  zombie.onopen === null && zombie.onmessage === null && zombie.onerror === null && zombie.onclose === null)
check('which is not the socket it is on any more', client.ws !== zombie)

check('the new address carries a real link', (await second) !== null && client.status === 'connected', client.status)
const settled = statuses.length
const pinger = client.pingTimer
check('with its own ping', pinger !== null)

/* ── and the events it fires afterwards ─────────────────────────────────── */

// Every one of these is a fact about a socket that is gone. None of them is a
// fact about the connection the phone actually has.
late.onclose({ code: 1006, reason: 'zombie' })
late.onerror({})
late.onmessage({ data: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]).buffer })
late.onopen({})

check('a late close does not stop the live ping', client.pingTimer === pinger && client.pingTimer !== null)
check('nor pin the status to reconnecting', client.status === 'connected', client.status)
check('nor say anything about the connection at all', statuses.length === settled,
  statuses.slice(settled).join(' → '))
check('and a late error does not invent one either', client.lastError === null, String(client.lastError))

// Garbage on a dead socket used to reach `handleBinary`, fail to decrypt, and
// close the live socket as an impostor. The proof it does not is that the link
// still answers.
const info2 = await client.call('system.info', {}).catch((err) => err)
check('the live socket still answers a request', !(info2 instanceof Error), String(info2?.message ?? 'ok'))
check('and it is still the socket the client thinks it is on',
  client.ws !== null && client.ws.readyState === 1, String(client.ws?.readyState))

// Nothing on a timer changed its mind a moment later, either.
await sleep(1500)
check('the link is still up a second later', client.status === 'connected' && client.pingTimer !== null, client.status)
check('and the whole run never mentioned an error state', !statuses.includes('error'), statuses.join(' → '))

client.close()
check('closing still takes the socket down', client.ws === null && client.status === 'idle')

done('socket swap checks')
