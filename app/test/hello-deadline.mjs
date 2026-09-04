/**
 * The deadline the phone puts on a greeting it is owed.
 *
 * `connecting` is set the moment a socket is dialled and cleared in exactly
 * one place — the `hello.ok` branch. Everything in between was unguarded: a
 * desktop that accepted the connection, answered the key exchange and then
 * failed to finish the handshake (a config write that threw, before the daemon
 * learned to catch it) left the app in `connecting` with no way out. The
 * desktop's WebSocket heartbeat keeps that half-open socket alive, so no
 * `onclose` ever fires, so `scheduleReconnect` is never reached, and the phone
 * stays like that until somebody kills the app by hand.
 *
 * The desktop has had the mirror of this deadline all along — ten seconds to
 * say hello or be closed. This is the phone's half, tested against a desktop
 * that does the one thing the daemon must never be trusted not to do: go
 * quiet after the handshake.
 */
import { setTimeout as sleep } from 'node:timers/promises'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import ws from 'ws'

// `ws` reaches this suite as CommonJS, so the server class comes off the
// default export rather than as a named one.
const WebSocketServer = ws.Server

import { ConnectClient } from '../src/api/client.ts'
import { check, done } from '../../tools/test-harness.mjs'

const PORT = Number(process.env.PORT || 8830)
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'omarchy-connect-hello-deadline-'))
process.env.XDG_CONFIG_HOME = sandbox

// The desktop's own handshake code, so what the client pins here is a real
// identity key and the reply it gets is a real key exchange. Imported after
// the config home is pointed at the sandbox, because that is where the key is
// minted.
const { accept, identity } = await import('../../daemon/src/lib/crypto.js')
const publicKey = identity().publicKey.toString('hex')

/** A desktop that answers the key exchange and then says nothing, ever. */
const greeted = []
const server = new WebSocketServer({ port: PORT, path: '/ws' })
server.on('connection', (ws) => {
  ws.on('message', (raw) => {
    const frame = Buffer.isBuffer(raw) ? raw : Buffer.from(raw)
    try {
      const { reply } = accept(frame)
      ws.send(reply, { binary: true })
    } catch {
      // Anything after the handshake is the hello this desktop will not
      // answer. Counted, so the test knows the phone really did ask.
      greeted.push(frame.length)
    }
  })
})
process.on('exit', () => {
  server.close()
  fs.rmSync(sandbox, { recursive: true, force: true })
})

const client = new ConnectClient({
  host: '127.0.0.1',
  port: PORT,
  token: 'a-token-this-desktop-will-never-answer',
  publicKey,
  device: { id: 'hello-deadline', name: 'Test Phone', platform: 'android', model: 'node' },
  // The real deadline is twenty seconds, deliberately longer than the
  // desktop's ten. A suite should not sit through either of them.
  helloTimeout: 1200,
})

const statuses = []
client.on('status', (s) => statuses.push(s.status))

client.connect()
await sleep(400)
check('the phone opens a socket and waits for a greeting', client.status === 'connecting', client.status)
check('and it did send the hello', greeted.length > 0, String(greeted.length))
check('with a deadline armed on it', client.helloTimer !== null)

await sleep(1400)
check('the greeting that never came is not still being waited on', client.status !== 'connecting', client.status)
check('the socket was closed', client.ws === null || client.ws.readyState > 1, String(client.ws?.readyState))
check('and a reconnect was scheduled', client.retryTimer !== null, client.status)
check(
  'which is a retry, not a rejection — the pairing is not blamed for it',
  client.status === 'reconnecting' && !statuses.includes('error'),
  statuses.join(' → '),
)
check('and the phone says what it is waiting on', /handshake/.test(String(client.lastError)), String(client.lastError))

// It keeps trying, rather than giving up after the one deadline.
const before = greeted.length
await sleep(2600)
check('it dials again and asks again', greeted.length > before, `${before} → ${greeted.length}`)

client.close()
check('closing takes the deadline down with it', client.helloTimer === null && client.status === 'idle')

done('hello deadline checks')
