// The desktop saying "I am up" on the wire, which is the half of "bring the
// phone back at start-up" that can be checked with no phone in the room. A
// real socket is bound and the real datagrams are read off it: the packet is
// the feature, so asserting on a function that builds one would prove nothing
// about whether anything left the machine.
import dgram from 'node:dgram'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { check, done } from '../../tools/test-harness.mjs'
import { announcement, createAnnouncer, ANNOUNCE_PORT, ANNOUNCE_APP, ANNOUNCE_KIND } from '../src/lib/announce.js'
import { broadcastFor } from '../src/lib/sys.js'
import { quietBluetooth } from './sandbox.mjs'

/* ── a listener that stands in for the phone ────────────────────────────── */

/**
 * Everything that arrives on a loopback port, in order.
 *
 * Loopback rather than the machine's real broadcast address on purpose: the
 * suite has to run on a laptop with the Wi-Fi off and on a machine whose
 * subnet belongs to somebody else, and shouting across either is neither
 * reliable nor polite.
 */
async function listener() {
  const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true })
  const heard = []
  socket.on('message', (buf) => {
    try {
      heard.push(JSON.parse(buf.toString('utf8')))
    } catch {
      heard.push({ unparseable: buf.toString('utf8') })
    }
  })
  await new Promise((resolve) => socket.bind(0, '127.0.0.1', resolve))
  return {
    port: socket.address().port,
    heard,
    close: () => socket.close(),
    async wait(count, ms = 4000) {
      const until = Date.now() + ms
      while (heard.length < count && Date.now() < until) await new Promise((r) => setTimeout(r, 50))
      return heard.length >= count
    },
  }
}

/* ── what the packet says ───────────────────────────────────────────────── */

const body = announcement({
  protocol: 2,
  version: '0.2.0',
  name: 'omarchy',
  host: '192.168.1.42',
  port: 8765,
  publicKey: 'ab'.repeat(32),
  fingerprint: 'AB CD EF',
})

check('the packet names itself', body.app === ANNOUNCE_APP && body.t === ANNOUNCE_KIND, `${body.app}/${body.t}`)
check(
  'it carries the address a phone would dial',
  body.host === '192.168.1.42' && body.port === 8765,
  `${body.host}:${body.port}`,
)
check(
  'and the identity key the phone pinned',
  body.publicKey === 'ab'.repeat(32) && body.protocol === 2,
)
check(
  'its shape does not change from one desktop to another',
  Object.keys(announcement({})).join(',') === Object.keys(body).join(','),
  Object.keys(body).join(','),
)

// Everything here is broadcast to a whole subnet, so the thing worth asserting
// is what is *not* in it. A device token is the pairing, and a pairing on the
// wire in the clear would be the feature handing itself to the neighbours.
const words = JSON.stringify(body).toLowerCase()
check(
  'no token, no secret, nothing a pairing rests on',
  !words.includes('token') && !words.includes('secret') && !words.includes('password'),
)

/* ── one burst, and only one ────────────────────────────────────────────── */

const ear = await listener()
const burst = createAnnouncer({ port: ear.port, schedule: [0, 120, 240] })
burst.announce(body, '127.0.0.1')
check('the burst arrives', await ear.wait(3), `${ear.heard.length} packets`)
check('every packet is the same announcement', ear.heard.every((p) => p.t === ANNOUNCE_KIND && p.app === ANNOUNCE_APP))
burst.stop()

const stopped = createAnnouncer({ port: ear.port, schedule: [0, 300, 600] })
const before = ear.heard.length
stopped.announce(body, '127.0.0.1')
await ear.wait(before + 1)
const afterFirst = ear.heard.length
stopped.stop()
await new Promise((r) => setTimeout(r, 800))
check(
  'stopping cancels the packets that had not gone yet',
  ear.heard.length === afterFirst && afterFirst < before + 3,
  `${afterFirst - before} of 3 sent`,
)

/* ── where a real one is aimed ──────────────────────────────────────────── */

// The daemon does not compute this itself: `sysinfo.network()` hands it the
// broadcast address of the interface it is on, which is `broadcastFor` of the
// address and the mask. Asserting the arithmetic here keeps the two halves
// tied together — a change to either shows up as a failure in one of them.
check(
  'a /24 desktop announces on its own .255',
  broadcastFor('192.168.1.42', '255.255.255.0') === '192.168.1.255',
)
check('the default port is not the wake port', ANNOUNCE_PORT === 8766 && ANNOUNCE_PORT !== 9)

/* ── the daemon's own start and stop ────────────────────────────────────── */

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'omarchy-announce-'))
quietBluetooth(sandbox)
process.env.XDG_CONFIG_HOME = sandbox
process.env.OMARCHY_CONNECT_STATE = path.join(sandbox, 'state')
process.env.OMARCHY_CONNECT_LOG = 'warn'
// The one back door: a suite has no subnet it may broadcast across, so the
// address the burst is aimed at is pointed at the listener above instead.
process.env.OMARCHY_ANNOUNCE_TO = `127.0.0.1:${ear.port}`

const { createServer } = await import('../src/server.js')
const server = createServer({ port: 8813, version: '0.0.0-test' })
const mark = ear.heard.length
await server.start()
const announced = await ear.wait(mark + 1, 3000)
const packet = ear.heard[mark]
check('starting the daemon puts an announcement on the wire', announced, `${ear.heard.length - mark} packets`)
check(
  'it is this daemon, on this port',
  Boolean(packet) && packet.port === 8813 && typeof packet.publicKey === 'string' && packet.publicKey.length === 64,
  packet ? `${packet.host}:${packet.port}` : 'nothing heard',
)
check(
  'and carries no device token',
  Boolean(packet) && !JSON.stringify(packet).toLowerCase().includes('token'),
)

const beforeStop = ear.heard.length
await server.stop()
// Long enough for the rest of the real burst to have gone out had nothing
// stopped it: the schedule's last rung is four seconds.
await new Promise((r) => setTimeout(r, 4500))
check(
  'a stopped daemon stops announcing itself',
  ear.heard.length === beforeStop,
  `${ear.heard.length - beforeStop} packets after stop()`,
)

ear.close()
fs.rmSync(sandbox, { recursive: true, force: true })
done('desktop announcement checks')
