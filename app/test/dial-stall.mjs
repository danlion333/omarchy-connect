/**
 * What the phone does while a dial is going nowhere.
 *
 * Off the home wire — somebody else's Wi-Fi, with the tunnel up — the local
 * address is still the first one dialled, and it is the right guess: it costs
 * nothing whenever the phone really is at home. What it must not cost is the
 * link. A TCP connection to 192.168.1.100 from another network does not fail,
 * it hangs, and every part of the reconnection logic used to read that hang as
 * "an attempt is in progress":
 *
 *   - nothing put a deadline on it — `startHelloDeadline` is armed from
 *     `onopen`, which a socket that never opens never reaches, so the wait was
 *     the platform's own connect timeout;
 *   - the probes racing alongside it came back over the tunnel in a second or
 *     two, named this desktop's own key, and were thrown away because the
 *     socket was still `CONNECTING`;
 *   - and the Reconnect button, the return to the foreground and the
 *     network-change callback all landed in `reconnectNow`, saw `CONNECTING`,
 *     and turned round.
 *
 * A real socket cannot be made to hang on demand, so the socket here is a fake
 * one that never opens, which is exactly the state under test. Everything else
 * — the client, the candidate ordering, the race — is the real thing.
 */
import { setTimeout as sleep } from 'node:timers/promises'

import { ConnectClient } from '../src/api/client.ts'
import { check, done } from '../../tools/test-harness.mjs'

const HOME = '192.168.1.100'
const TUNNEL = '100.81.6.104'
const PORT = 8765
const KEY = 'a'.repeat(64)
const device = { id: 'dial-stall', name: 'Test Phone', platform: 'android', model: 'node' }

/** Somebody else's Wi-Fi with Tailscale switched on: the reported facts. */
const AWAY = { online: true, lan: true, vpn: true }

/**
 * A WebSocket that dials and never arrives.
 *
 * `readyState` stays at `CONNECTING` for as long as the client keeps it, which
 * is what the platform does to a SYN into a network that is not there: no
 * `onopen`, no `onerror`, no `onclose`, nothing at all. Every socket ever made
 * is kept, because "did the phone dial again" is the question most of these
 * checks are asking.
 */
const sockets = []
class StalledWebSocket {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSING = 2
  static CLOSED = 3

  constructor(url) {
    this.url = url
    this.readyState = 0
    this.closeCode = null
    this.onopen = null
    this.onmessage = null
    this.onerror = null
    this.onclose = null
    sockets.push(this)
  }

  send() {
    throw new Error('a socket that never opened cannot send')
  }

  close(code) {
    this.readyState = 3
    this.closeCode = code ?? 1000
    this.onclose?.({ code: this.closeCode })
  }
}
globalThis.WebSocket = StalledWebSocket

const host = (socket) => new URL(socket.url).hostname

/* ── a dial has a deadline of its own ───────────────────────────────────── */

const alone = new ConnectClient({
  host: HOME,
  port: PORT,
  publicKey: KEY,
  device,
  network: () => AWAY,
  // The real deadline is seconds; a suite should not sit through it.
  dialTimeout: 300,
})
alone.connect()
check('the phone dials the address it knows', sockets.length === 1 && host(sockets[0]) === HOME, sockets[0]?.url)
check('and the dial is still in flight', sockets[0].readyState === 0 && alone.status === 'connecting', alone.status)

await sleep(500)
check('a dial that never opened is given up on', alone.ws === null, String(alone.ws?.readyState))
check('the socket was dropped', sockets[0].readyState === 3 && sockets[0].closeCode === 4011, String(sockets[0].closeCode))
check('and the phone says which address went quiet', /no answer from 192\.168\.1\.100/.test(String(alone.lastError)), String(alone.lastError))
check('a retry is scheduled rather than an error raised', alone.retryTimer !== null && alone.status === 'reconnecting', alone.status)

// The deadline is not a one-off: the ladder carries on behind it.
await sleep(1_600)
check('and it dials again', sockets.length > 1, String(sockets.length))
alone.close()
check('closing takes the dial deadline down with it', alone.dialTimer === null && alone.status === 'idle')

/* ── the race is applied while the direct dial hangs ────────────────────── */

sockets.length = 0
let probed = 0
const racer = new ConnectClient({
  host: HOME,
  port: PORT,
  publicKey: KEY,
  device,
  network: () => AWAY,
  endpoints: [
    { host: HOME, port: PORT, kind: 'lan', source: 'pairing' },
    { host: TUNNEL, port: PORT, kind: 'tailscale', source: 'desktop' },
  ],
  // Long enough that nothing here can be the deadline firing: whatever moves
  // this client moves it while the first dial is still hanging.
  dialTimeout: 30_000,
  probe: async (at) => {
    probed += 1
    // Only the tunnel address answers, and it answers with this desktop's key.
    return at === TUNNEL ? { publicKey: KEY, certPin: null } : null
  },
})
racer.connect()
check('the local address is still the one dialled first', host(sockets[0]) === HOME, sockets[0]?.url)

await sleep(900)
check('the other addresses were asked in the meantime', probed > 0, String(probed))
check('the phone followed the one that answered', racer.host === TUNNEL, `${racer.host}:${racer.port}`)
check('the hanging dial was dropped for it', sockets[0].readyState === 3 && sockets[0].closeCode === 4009, String(sockets[0].closeCode))
check('and the new dial is to the tunnel', sockets.length === 2 && host(sockets[1]) === TUNNEL, sockets[1]?.url)
check(
  'which is not re-decided back to the local address on the way out',
  racer.ws !== null && host(sockets[sockets.length - 1]) === TUNNEL,
  sockets.map(host).join(' → '),
)
racer.close()

/* ── Reconnect is not a no-op over a hanging dial ───────────────────────── */

sockets.length = 0
const pressed = new ConnectClient({
  host: HOME,
  port: PORT,
  publicKey: KEY,
  device,
  network: () => AWAY,
  dialTimeout: 30_000,
})
pressed.connect()
check('one dial, in flight', sockets.length === 1 && pressed.ws?.readyState === 0)

pressed.reconnectNow()
check(
  'a dial that has only just started is left alone',
  sockets.length === 1,
  String(sockets.length),
)

// Ten seconds into a dial that is going nowhere — the state a person is
// looking at when they press the button.
pressed.dialStartedAt = Date.now() - 10_000
pressed.reconnectNow(true)
check('a press dials again', sockets.length === 2, String(sockets.length))
check('and drops the socket it was waiting on', sockets[0].readyState === 3 && sockets[0].closeCode === 4012, String(sockets[0].closeCode))
check('onto the same address, since that is all this client knows', host(sockets[1]) === HOME, sockets[1]?.url)

pressed.dialStartedAt = Date.now() - 10_000
pressed.reconnectNow()
check('a network change gets the same answer once the dial is stale', sockets.length === 3, String(sockets.length))
pressed.close()
check('and nothing is left ticking', pressed.dialTimer === null && pressed.retryTimer === null)

done('dial stall checks')
