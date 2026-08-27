// The magic packet, byte for byte, and the list of addresses it is aimed at.
// Everything here is the half of waking a desktop that can be checked without
// one: `api/wake` opens the socket, and nothing in a test can watch a machine
// come out of suspend.
import { base64FromBytes, broadcastOf, macBytes, magicPacket, wakeTargets } from '../src/lib/wol.ts'

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`)
}

const MAC = '04:42:1a:9a:7a:59'

/* ── reading a MAC ──────────────────────────────────────────────────────── */

check('colons are the usual spelling', [...(macBytes(MAC) ?? [])].join(',') === '4,66,26,154,122,89',
  [...(macBytes(MAC) ?? [])].join(','))
check('dashes and bare hex say the same thing',
  String(macBytes('04-42-1A-9A-7A-59')) === String(macBytes(MAC)) &&
    String(macBytes('04421a9a7a59')) === String(macBytes(MAC)))
check('a short address is not a MAC', macBytes('04:42:1a:9a:7a') === null)
check('nor is a long one', macBytes('04:42:1a:9a:7a:59:60') === null)
check('nor is nothing at all', macBytes(null) === null && macBytes(undefined) === null && macBytes('') === null)

/* ── the packet ─────────────────────────────────────────────────────────── */

const packet = magicPacket(MAC)
const address = macBytes(MAC)

check('a magic packet is 102 bytes', packet.length === 102, String(packet.length))
check('it opens with six 0xFF', [...packet.slice(0, 6)].every((b) => b === 0xff))
check(
  'then the MAC, sixteen times over',
  Array.from({ length: 16 }, (_, i) => String(packet.slice(6 + i * 6, 12 + i * 6)) === String(address)).every(Boolean),
)
check('a card that is not a card is refused', (() => {
  try {
    magicPacket('not-a-mac')
    return false
  } catch {
    return true
  }
})())

/* ── the packet, as the bridge carries it ───────────────────────────────── */

const roundTrip = (bytes) => String(new Uint8Array(Buffer.from(base64FromBytes(bytes), 'base64')))

check('base64 survives the packet', roundTrip(packet) === String(packet))
check('and every awkward length around a group of three',
  [0, 1, 2, 3, 4, 5, 7, 8].every((n) => {
    const bytes = new Uint8Array(Array.from({ length: n }, (_, i) => (i * 37 + 11) & 255))
    return roundTrip(bytes) === String(bytes)
  }))
check('it is padded the way base64 is', base64FromBytes(new Uint8Array([0xff])) === '/w==' &&
  base64FromBytes(new Uint8Array([0xff, 0xff])) === '//8=', base64FromBytes(new Uint8Array([0xff])))

/* ── where it is aimed ──────────────────────────────────────────────────── */

check('a /24 broadcast is guessed from an address', broadcastOf('192.168.1.42') === '192.168.1.255')
check('junk is not', broadcastOf('192.168.1') === null && broadcastOf('192.168.1.999') === null &&
  broadcastOf(null) === null)

const wake = { supported: true, interface: 'enp8s0', type: 'ethernet', mac: MAC, broadcast: '192.168.1.255', port: 9, armed: true, command: null, note: null }
const targets = wakeTargets(wake, '192.168.1.7', '192.168.1.20')

check("the desktop's own broadcast is tried first", targets[0].host === '192.168.1.255' && targets[0].port === 9,
  JSON.stringify(targets[0]))
check('port 7 is tried as well as 9', targets.some((t) => t.port === 7) && targets.some((t) => t.port === 9))
check('the limited broadcast is a fallback, not the only road',
  targets.some((t) => t.host === '255.255.255.255') && targets.length > 2)
check('one address is not tried twice', new Set(targets.map((t) => `${t.host}:${t.port}`)).size === targets.length)
check('nothing is unicast at a machine that is asleep',
  !targets.some((t) => t.host === '192.168.1.20' || t.host === '192.168.1.7'))

const blind = wakeTargets({ ...wake, broadcast: null, port: 0 }, '10.0.0.9', null)
check("a desktop that gave no broadcast falls back to the phone's own subnet",
  blind[0].host === '10.0.0.255' && blind[0].port === 9, JSON.stringify(blind[0]))
check('and a phone that does not know its own address still broadcasts',
  wakeTargets(null, null, null).every((t) => t.host === '255.255.255.255'))

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} wake checks passed`)
process.exit(failed.length ? 1 : 0)
