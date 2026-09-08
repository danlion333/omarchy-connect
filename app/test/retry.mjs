// When the phone tries again, and whether trying could work at all. This is
// the half of reconnection that is arithmetic over an address and a
// description of the network; `api/client` is the half that opens a socket,
// and the half no test can run.
import {
  backoffStep,
  isLanOnlyHost,
  orderCandidates,
  parkedReason,
  reachable,
  reachableEndpoint,
  retryDelay,
} from '../src/lib/retry.ts'
import { MAX_ENDPOINTS, mergeEndpoints, migrateEndpoints } from '../src/lib/endpoints.ts'

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`)
}

/* ── the ladder ─────────────────────────────────────────────────────────── */

check('the first try is a second away', backoffStep(0) === 1_000, String(backoffStep(0)))
check('it doubles for a while', [0, 1, 2, 3].map(backoffStep).join(',') === '1000,2000,4000,8000')
check('the tail is minutes, not fifteen seconds forever', backoffStep(7) === 120_000, String(backoffStep(7)))
check('and it stops there rather than growing without end', backoffStep(99) === backoffStep(7))
check('a negative attempt is still the first rung', backoffStep(-3) === 1_000)
check('a fractional one does not fall off the ladder', backoffStep(2.7) === 4_000, String(backoffStep(2.7)))

/* ── the wobble ─────────────────────────────────────────────────────────── */

check('the low end of the jitter is a fifth under', retryDelay(4, () => 0) === 12_000, String(retryDelay(4, () => 0)))
check('the high end is a fifth over', retryDelay(4, () => 1) === 18_000, String(retryDelay(4, () => 1)))
check('the middle is the rung itself', retryDelay(4, () => 0.5) === 15_000)
check(
  'nothing real ever leaves the band',
  Array.from({ length: 500 }, () => retryDelay(4)).every((d) => d >= 12_000 && d <= 18_000),
)
check(
  'two phones on the same rung do not agree',
  new Set(Array.from({ length: 50 }, () => retryDelay(7))).size > 1,
)

/* ── which addresses only mean something on the local wire ──────────────── */

check('10/8 is the local wire', isLanOnlyHost('10.1.2.3'))
check('192.168/16 is the one everybody has', isLanOnlyHost('192.168.1.20'))
check('172.16/12 counts', isLanOnlyHost('172.16.0.1') && isLanOnlyHost('172.31.255.254'))
check('but 172.15 and 172.32 do not', !isLanOnlyHost('172.15.0.1') && !isLanOnlyHost('172.32.0.1'))
check('a failed DHCP lease is as local as it gets', isLanOnlyHost('169.254.4.5'))
check('loopback too', isLanOnlyHost('127.0.0.1'))
check('an mDNS name answers only on the link', isLanOnlyHost('desktop.local') && isLanOnlyHost('Desktop.Local.'))
check('a public address is not local', !isLanOnlyHost('93.184.216.34'))
check('nor is a hostname', !isLanOnlyHost('desk.example.com'))
check(
  'Tailscale space is reachable from anywhere, whatever the RFC calls it',
  !isLanOnlyHost('100.101.102.103'),
)
check('nonsense is not local either, because guessing wrong parks a good link',
  !isLanOnlyHost('') && !isLanOnlyHost('1.2.3') && !isLanOnlyHost('999.1.1.1') && !isLanOnlyHost('a.b.c.d'))

/* ── whether to bother dialling ─────────────────────────────────────────── */

const LAN = { online: true, lan: true, vpn: false }
const CELL = { online: true, lan: false, vpn: false }
const CELL_VPN = { online: true, lan: false, vpn: true }
const NOTHING = { online: false, lan: false, vpn: false }

check('nobody said, so try — that is what the app always did', reachable('192.168.1.20', null))
check('no network at all, so do not', !reachable('93.184.216.34', NOTHING))
check('on Wi-Fi the desktop is worth a try', reachable('192.168.1.20', LAN))
check('on mobile data a 192.168 address is not', !reachable('192.168.1.20', CELL))
check('but a public one still is', reachable('93.184.216.34', CELL))
check('and a tunnel carries the private one over anything', reachable('192.168.1.20', CELL_VPN))

/* ── what the shade is told ─────────────────────────────────────────────── */

check('with no network it says so', parkedReason(NOTHING) === 'waiting for a network')
check('otherwise it names what it is waiting for', parkedReason(CELL) === 'waiting for your home network')
check('and it never comes back empty', parkedReason(null).length > 0)

/* ── one address at a time ──────────────────────────────────────────────── */

const home = { host: '192.168.1.20', port: 8765, kind: 'lan', source: 'hello' }
const tail = { host: '100.101.102.103', port: 8765, kind: 'tailscale', source: 'hello' }
const wg = { host: '10.9.0.2', port: 8765, kind: 'wireguard', source: 'hello' }
const name = { host: 'desk.tail1a2b3c.ts.net', port: 8765, kind: 'dns', source: 'hello' }
const typed = { host: '203.0.113.9', port: 8765, kind: 'manual', source: 'manual' }

check('at home the wire and a typed-in address are open', reachableEndpoint(home, LAN) && reachableEndpoint(typed, LAN))
check('but a tunnel address needs its tunnel even at home — the name will not resolve without it',
  !reachableEndpoint(tail, LAN) && !reachableEndpoint(name, LAN))
check('a tunnel address needs the tunnel', !reachableEndpoint(tail, CELL) && reachableEndpoint(tail, CELL_VPN))
check('a wireguard peer is judged the same way', !reachableEndpoint(wg, CELL) && reachableEndpoint(wg, CELL_VPN))
check('a MagicDNS name is a tunnel address too', !reachableEndpoint(name, CELL) && reachableEndpoint(name, CELL_VPN))
check(
  'a private tunnel address is not mistaken for the wire',
  reachableEndpoint(wg, CELL_VPN) && !reachable(wg.host, CELL),
)
check('the wire is unreachable off it', !reachableEndpoint(home, CELL) && reachableEndpoint(home, LAN))
check('a typed-in address is always worth a try — somebody knew something we do not',
  reachableEndpoint(typed, CELL) && reachableEndpoint(typed, LAN))
check('but nothing is worth a try with no network at all',
  ![home, tail, wg, name, typed].some((e) => reachableEndpoint(e, NOTHING)))
check('and with nobody saying, everything is', [home, tail, name].every((e) => reachableEndpoint(e, null)))

/* ── and in what order ──────────────────────────────────────────────────── */

const all = [name, tail, home, wg]
const athome = orderCandidates(all, LAN)
check('at home the local address leads', athome[0].kind === 'lan', athome.map((e) => e.kind).join(' → '))
check('and nothing tunnelled is offered at all with the tunnel down',
  athome.length === 1, athome.map((e) => e.kind).join(' → '))

const away = orderCandidates(all, CELL_VPN)
check('away from home a tunnel address is tried before the wire — one is certain, the other is a guess',
  away[0].kind === 'tailscale', away.map((e) => e.kind).join(' → '))
check('the tunnels keep the order the desktop offered them',
  away.findIndex((e) => e.kind === 'tailscale') < away.findIndex((e) => e.kind === 'wireguard'),
  away.map((e) => e.kind).join(' → '))
check('but the wire is kept, because a VPN may well be the road into it',
  away.some((e) => e.kind === 'lan'), away.map((e) => e.kind).join(' → '))
check('and the name is still last', away[away.length - 1].kind === 'dns')

// Somebody else's Wi-Fi, with the tunnel up. Android says `lan` for any
// Wi-Fi and will not say which one without a location permission, so this
// reads exactly like home and the wire is offered first — deliberately, since
// dropping it would park a phone that really is at home. What matters is that
// the tunnels are all still on the list behind it: they are what `client`'s
// probes race against the hanging dial, and what it moves to when one answers.
const FOREIGN_WIFI = { online: true, lan: true, vpn: true }
const foreign = orderCandidates(all, FOREIGN_WIFI)
check('a foreign Wi-Fi is indistinguishable from home, so the wire still leads',
  foreign[0].kind === 'lan', foreign.map((e) => e.kind).join(' → '))
check('but every tunnel is offered behind it, for the race to find the desktop on',
  ['tailscale', 'wireguard', 'dns'].every((kind) => foreign.some((e) => e.kind === kind)),
  foreign.map((e) => e.kind).join(' → '))

const remembered = orderCandidates(all, CELL_VPN, wg.host)
check('what worked last is tried first among the tunnels', remembered[0].host === wg.host,
  remembered.map((e) => e.host).join(' → '))
check('but never ahead of the local network', orderCandidates(all, LAN, wg.host)[0].kind === 'lan')

check('on mobile data with no tunnel there is nothing to try', orderCandidates(all, CELL).length === 0)
check('and a typed-in address is still something', orderCandidates([...all, typed], CELL).length === 1)
check('with no network the list is empty however long it was', orderCandidates([...all, typed], NOTHING).length === 0)
check('junk in the list is dropped rather than dialled',
  orderCandidates([null, { host: '', port: 1, kind: 'lan' }, home], LAN).length === 1)

/* ── what the shade says once there are two ways home ───────────────────── */

check('with a tunnel it names both roads',
  parkedReason(CELL, true) === 'waiting for your home network or vpn')
check('without one the sentence is unchanged',
  parkedReason(CELL, false) === 'waiting for your home network')
check('and no network still trumps everything', parkedReason(NOTHING, true) === 'waiting for a network')

/* ── a desktop paired before any of this existed ────────────────────────── */

check('its one address becomes its one candidate',
  migrateEndpoints({ host: '192.168.1.20', port: 8765 }).length === 1)
check('and is labelled for what it is',
  migrateEndpoints({ host: '192.168.1.20', port: 8765 })[0].kind === 'lan' &&
    migrateEndpoints({ host: '192.168.1.20', port: 8765 })[0].source === 'pairing')
check('a desktop paired at a tailnet address keeps travelling',
  migrateEndpoints({ host: '100.101.102.103', port: 8765 })[0].kind === 'overlay')
check('a list that is already there is left alone',
  migrateEndpoints({ host: '192.168.1.20', port: 8765, endpoints: [typed] })[0].source === 'manual')
check('and a record with no address at all yields none',
  migrateEndpoints({ host: '', port: 8765 }).length === 0)

/* ── and what a fresh hello does to the list ────────────────────────────── */

const merged = mergeEndpoints([{ ...home, lastGood: 1234 }, typed], [home, tail])
check('what the desktop says now stands', merged.some((e) => e.host === tail.host))
check('what it said before and no longer says is gone',
  mergeEndpoints([wg, home], [home]).every((e) => e.host !== wg.host))
check('a typed-in address outlives every hello', merged.some((e) => e.source === 'manual'))
check('and comes after what the desktop advertised', merged[merged.length - 1].source === 'manual')
check('what worked before is remembered through a re-advertisement',
  merged.find((e) => e.host === home.host).lastGood === 1234)
check('the desktop owns the labels it sends', merged.find((e) => e.host === home.host).source === 'hello')
check('an address advertised twice is stored once',
  mergeEndpoints([], [home, home, tail]).length === 2)
check('a typed-in duplicate of an advertised address does not double up',
  mergeEndpoints([{ ...home, source: 'manual' }], [home]).length === 1)
check('the list cannot grow without bound — the keychain is not big',
  mergeEndpoints([], Array.from({ length: 20 }, (_, i) => ({ ...tail, host: `100.64.0.${i}` }))).length === MAX_ENDPOINTS)

/* ── the point of the whole thing ───────────────────────────────────────── */

// An hour of mobile data with a desktop at 192.168.1.20: the old ladder plateaued
// at 15s and never asked whether the attempt could succeed.
const OLD_PLATEAU = 15_000
const oldTries = Math.floor(3_600_000 / OLD_PLATEAU)
check('the old behaviour was 240 doomed attempts an hour', oldTries === 240, String(oldTries))
check('the new one is none of them', !reachable('192.168.1.20', CELL))

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} ok`)
if (failed.length) process.exit(1)
