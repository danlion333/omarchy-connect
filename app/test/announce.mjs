// What the phone does with a packet claiming a desktop just came up. This is
// the whole of the trust decision behind "come back the moment the desktop
// starts", and it is the half that must hold with no desktop, no subnet and
// nobody willing to forge a broadcast frame for a test.
import { shouldRedial, ANNOUNCE_PORT } from '../src/lib/announce.ts'

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`)
}

const OURS = 'ab'.repeat(32)
const THEIRS = 'cd'.repeat(32)

const packet = (over = {}) => ({
  app: 'omarchy-connect',
  t: 'desktop-up',
  protocol: 2,
  version: '0.2.0',
  name: 'omarchy',
  host: '192.168.1.42',
  port: 8765,
  publicKey: OURS,
  fingerprint: 'AB CD EF',
  from: '192.168.1.42',
  ...over,
})

const down = { publicKey: OURS, status: 'reconnecting' }

/* ── the case the feature exists for ────────────────────────────────────── */

check('our desktop announcing itself while the link is down is worth a dial', shouldRedial(packet(), down))
check('a parked phone is exactly the phone this is for', shouldRedial(packet(), { ...down, status: 'parked' }))
check('so is one that has never got a socket up', shouldRedial(packet(), { ...down, status: 'error' }))

/* ── who is allowed to move the phone ───────────────────────────────────── */

// A broadcast frame is readable and writable by everything on the subnet, so
// the packet is a filter and never a credential. The flatmate's Omarchy box
// restarting is not this phone's business, and neither is a forged one.
check("another desktop's announcement is not ours", !shouldRedial(packet({ publicKey: THEIRS }), down))
check('nor is one that names no key at all', !shouldRedial(packet({ publicKey: null }), down))
check('nor one whose key is not a key', !shouldRedial(packet({ publicKey: 42 }), down))
check(
  'a phone that has not paired has nobody to come back to',
  !shouldRedial(packet(), { publicKey: null, status: 'reconnecting' }),
)

/* ── noise on a UDP port ────────────────────────────────────────────────── */

check('a packet from another app is ignored', !shouldRedial(packet({ app: 'something-else' }), down))
check('so is one of ours that says something else', !shouldRedial(packet({ t: 'goodbye' }), down))
check('and so is nothing at all', !shouldRedial(null, down) && !shouldRedial(undefined, down))
check('and a string that parsed into one', !shouldRedial('desktop-up', down))

/* ── a link that is already up ──────────────────────────────────────────── */

// The cautious half of the open question in the issue: the announcement is
// heard only while there is nothing to lose by acting on it. A working socket
// is not dropped for a hint that a desktop is reachable.
check('a connected phone stays on the socket it has', !shouldRedial(packet(), { publicKey: OURS, status: 'connected' }))

/* ── the port both halves agree on ──────────────────────────────────────── */

check('the phone listens where the daemon shouts', ANNOUNCE_PORT === 8766, String(ANNOUNCE_PORT))

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} desktop announcement checks passed`)
process.exit(failed.length ? 1 : 0)
