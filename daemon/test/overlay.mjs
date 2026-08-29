// The addresses this desktop can be reached by from off its own subnet, and
// how it tells a socket that arrived over one from a socket off the wire.
// Nothing here touches a tailnet: the Tailscale half is fed a captured
// `status --json` payload and the generic half a captured interface list, so
// the suite gives the same answer on a machine running no overlay at all.
import {
  classify,
  detect,
  forget,
  fromInterfaces,
  fromStatus,
  isCarrierGrade,
  kindFor,
  known,
  normaliseAddress,
  summary,
  toEndpoints,
} from '../src/lib/overlay.js'
import { OVERLAY_INTERFACE } from '../src/lib/sys.js'

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`)
}

/* ── which tunnel put this interface up ─────────────────────────────────── */

check('tailscale names itself', kindFor('tailscale0') === 'tailscale')
check('a wireguard peer is a wireguard peer', kindFor('wg0') === 'wireguard' && kindFor('nordlynx') === 'wireguard')
check('zerotier and netbird are told apart', kindFor('ztabcdef12') === 'zerotier' && kindFor('nb-home') === 'netbird')
check('an unrecognised tunnel is still a tunnel', kindFor('tun0') === 'overlay' && kindFor('') === 'overlay')

check(
  'the interface pattern covers the tunnels and nothing on the wire',
  ['tailscale0', 'wg0', 'zt5u4k', 'netbird0', 'nebula1', 'tun0'].every((n) => OVERLAY_INTERFACE.test(n)) &&
    !['enp0s31f6', 'wlan0', 'eth0', 'docker0', 'br-1a2b', 'lo'].some((n) => OVERLAY_INTERFACE.test(n)),
)

/* ── the address space Tailscale actually uses ──────────────────────────── */

check('the whole of 100.64/10 counts', isCarrierGrade('100.64.0.1') && isCarrierGrade('100.127.255.254'))
check('the edges of it do not', !isCarrierGrade('100.63.255.255') && !isCarrierGrade('100.128.0.1'))
check('an ordinary private address is not carrier-grade', !isCarrierGrade('192.168.1.42') && !isCarrierGrade('10.0.0.1'))
check('junk is not an address', !isCarrierGrade('fd7a::1') && !isCarrierGrade(null) && !isCarrierGrade('100.64.0'))

check('a v4-mapped peer is read as the v4 address it is', normaliseAddress('::ffff:100.64.0.7') === '100.64.0.7')
check('a bare address survives untouched', normaliseAddress('192.168.1.42') === '192.168.1.42')
check('IPv6 is not coerced into an answer', normaliseAddress('fd7a:115c::1') === null && normaliseAddress('::1') === null)

/* ── what a `tailscale status --json` payload is worth ──────────────────── */

const STATUS = {
  Self: {
    TailscaleIPs: ['100.101.102.103', 'fd7a:115c:a1e0::1'],
    DNSName: 'desk.tail1a2b3c.ts.net.',
    KeyExpiry: '2026-11-20T09:00:00Z',
  },
}
const parsed = fromStatus(STATUS)
check('only the IPv4 address is taken', parsed.addresses.length === 1 && parsed.addresses[0] === '100.101.102.103',
  JSON.stringify(parsed.addresses))
check('the MagicDNS name loses its trailing dot', parsed.dnsName === 'desk.tail1a2b3c.ts.net', String(parsed.dnsName))
check('the key expiry becomes a number a warning can compare', parsed.keyExpiry === Date.parse('2026-11-20T09:00:00Z'))

const logged_out = fromStatus({ Self: {} })
check('a logged-out node yields nothing rather than throwing',
  logged_out.addresses.length === 0 && logged_out.dnsName === null && logged_out.keyExpiry === null)
check('so does junk', fromStatus(null).addresses.length === 0 && fromStatus('nope').keyExpiry === null)

/* ── the generic path, over a captured interface list ───────────────────── */

const INTERFACES = {
  lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
  enp0s31f6: [{ address: '192.168.1.42', family: 'IPv4', internal: false }],
  wlan0: [{ address: '192.168.1.77', family: 'IPv4', internal: false }],
  tailscale0: [
    { address: '100.101.102.103', family: 'IPv4', internal: false },
    { address: 'fd7a:115c:a1e0::1', family: 'IPv6', internal: false },
  ],
  wg0: [{ address: '10.9.0.2', family: 'IPv4', internal: false }],
}
const found = fromInterfaces(INTERFACES)
const addresses = found.map((entry) => entry.address).sort()
check('the tunnels are found and the wire is left alone',
  addresses.length === 2 && addresses[0] === '10.9.0.2' && addresses[1] === '100.101.102.103', addresses.join(', '))
check('a private address on a tunnel still counts',
  found.some((entry) => entry.address === '10.9.0.2' && entry.kind === 'wireguard'))
check('IPv6 is left where it is', !found.some((entry) => entry.address.includes(':')))
check('the loopback is not an overlay', !found.some((entry) => entry.iface === 'lo'))

check(
  'a carrier-grade address on an ordinary interface is offered anyway',
  fromInterfaces({ eth1: [{ address: '100.70.0.5', family: 'IPv4', internal: false }] })
    .some((entry) => entry.address === '100.70.0.5' && entry.kind === 'overlay'),
)

/* ── how a socket is told apart ─────────────────────────────────────────── */

const SNAPSHOT = {
  at: Date.now(),
  addresses: [
    { address: '100.101.102.103', iface: 'tailscale0', kind: 'tailscale' },
    { address: '10.9.0.2', iface: 'wg0', kind: 'wireguard' },
  ],
  dnsName: 'desk.tail1a2b3c.ts.net',
  keyExpiry: Date.parse('2026-11-20T09:00:00Z'),
}

check('a socket that arrived on the tailnet address is remote',
  classify('100.101.102.103', SNAPSHOT).via === 'remote' && classify('100.101.102.103', SNAPSHOT).kind === 'tailscale')
check('a v4-mapped one is too', classify('::ffff:10.9.0.2', SNAPSHOT).kind === 'wireguard')
check('a socket that arrived on the wire is not', classify('192.168.1.42', SNAPSHOT).via === 'lan')
check('nor is the loopback the panel talks over', classify('127.0.0.1', SNAPSHOT).via === 'lan')
check('an unreadable local address is treated as the wire, not as remote',
  classify(null, SNAPSHOT).via === 'lan' && classify('::1', SNAPSHOT).via === 'lan')
check('with no overlay up, nothing is remote', classify('100.101.102.103', { addresses: [] }).via === 'lan')

/* ── what the phone is handed ───────────────────────────────────────────── */

const endpoints = toEndpoints(SNAPSHOT, 8765)
check('every overlay address becomes a candidate on the daemon port',
  endpoints.length === 3 && endpoints.every((e) => e.port === 8765), String(endpoints.length))
check('the MagicDNS name comes last and is labelled as a name',
  endpoints[endpoints.length - 1].kind === 'dns' && endpoints[endpoints.length - 1].host === SNAPSHOT.dnsName)
check('an address is never labelled dns', endpoints.slice(0, -1).every((e) => e.kind !== 'dns'))
check('no overlay means no candidates', toEndpoints({ addresses: [], dnsName: null }, 8765).length === 0)

const shown = summary(SNAPSHOT)
check('the summary names the first address and its kind', shown.address === '100.101.102.103' && shown.kind === 'tailscale',
  `${shown.kind} ${shown.address}`)
check('the summary carries the expiry a warning needs', shown.keyExpiresAt === SNAPSHOT.keyExpiry)
check('an empty desktop summarises as empty',
  summary({ addresses: [] }).address === null && summary({ addresses: [] }).kind === null)

/* ── and against whatever this machine is actually running ──────────────── */

// The one check that touches the real host. It cannot assert an address —
// the machine running the suite is allowed to have no overlay at all — only
// that asking is safe and that the answer has the shape everything else here
// has been reading.
const live = await detect({ force: true })
check('asking the machine itself returns a well-formed answer',
  Array.isArray(live.addresses) &&
    live.addresses.every((e) => typeof e.address === 'string' && typeof e.kind === 'string') &&
    (live.dnsName === null || typeof live.dnsName === 'string') &&
    (live.keyExpiry === null || Number.isFinite(live.keyExpiry)),
  `${live.addresses.length} address(es)`)
check('a second ask inside the cache window is the same answer', (await detect()) === live)
check('forgetting the cache empties what is known', (forget(), known().addresses.length === 0))

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} overlay checks passed`)
process.exit(failed.length ? 1 : 0)
