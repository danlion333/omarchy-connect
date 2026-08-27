// What the desktop hands a phone so it can be woken later: the broadcast
// address a magic packet has to be aimed at, and an honest reading of whether
// the card would act on one. Nothing here touches the network — the sysfs and
// `nmcli` halves are the machine's own answers, and the machine running the
// suite is allowed to have a different one.
import { broadcastFor } from '../src/lib/sys.js'
import * as wol from '../src/lib/wol.js'

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`)
}

/* ── where the packet is addressed ──────────────────────────────────────── */

check('a /24 broadcasts on .255', broadcastFor('192.168.1.42', '255.255.255.0') === '192.168.1.255',
  broadcastFor('192.168.1.42', '255.255.255.0'))
check('a /16 carries the host half through', broadcastFor('172.20.3.9', '255.255.0.0') === '172.20.255.255',
  broadcastFor('172.20.3.9', '255.255.0.0'))
check('a /25 stops at the middle of the range', broadcastFor('10.0.0.5', '255.255.255.128') === '10.0.0.127',
  broadcastFor('10.0.0.5', '255.255.255.128'))
check('a /8 reaches the whole of 10', broadcastFor('10.1.2.3', '255.0.0.0') === '10.255.255.255')
check('a /32 is its own broadcast', broadcastFor('192.168.1.42', '255.255.255.255') === '192.168.1.42')
check('nothing sensible comes of nothing', broadcastFor(null, '255.255.255.0') === null &&
  broadcastFor('192.168.1.42', null) === null)
check('an IPv6 address is not an IPv4 one', broadcastFor('fe80::1', '255.255.255.0') === null)
check('junk octets are refused rather than coerced', broadcastFor('192.168.1.x', '255.255.255.0') === null &&
  broadcastFor('192.168.1.999', '255.255.255.0') === null)

/* ── what a phone is told ───────────────────────────────────────────────── */

const wired = await wol.check({ interface: 'enp0s31f6', type: 'ethernet', mac: '04:42:1a:9a:7a:59', broadcast: '192.168.1.255' })
check('a wired link can be woken', wired.supported === true)
check('the packet has an address and a port', wired.broadcast === '192.168.1.255' && wired.port === 9)
check('the MAC travels as the desktop reported it', wired.mac === '04:42:1a:9a:7a:59')
check(
  'an unarmed card comes with the command that arms it',
  wired.armed === true ? wired.command === null : typeof wired.command === 'string' && wired.command.length > 0,
  `armed=${wired.armed}`,
)

const wifi = await wol.check({ interface: 'wlan0', type: 'wifi', mac: 'aa:bb:cc:dd:ee:ff', broadcast: '192.168.1.255' })
check('Wi-Fi is not refused, only warned about', wifi.supported === true && typeof wifi.note === 'string',
  wifi.note ?? 'no note')

const offline = await wol.check({ interface: null, type: 'offline', mac: null, broadcast: null })
check('a desktop with no link up says so', offline.supported === false && offline.mac === null && offline.command === null)
check('so does one asked about nothing at all', (await wol.check(null)).supported === false)

/* ── the card's own flag ────────────────────────────────────────────────── */

check('an interface that does not exist has no answer', wol.armed('nosuchdev0') === null)
check('neither does no interface', wol.armed(null) === null)
check('a real one answers yes, no, or "cannot tell"', [true, false, null].includes(wol.armed('lo')))

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} wake-on-LAN checks passed`)
process.exit(failed.length ? 1 : 0)
