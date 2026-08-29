// When the phone tries again, and whether trying could work at all. This is
// the half of reconnection that is arithmetic over an address and a
// description of the network; `api/client` is the half that opens a socket,
// and the half no test can run.
import { backoffStep, isLanOnlyHost, parkedReason, reachable, retryDelay } from '../src/lib/retry.ts'

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
