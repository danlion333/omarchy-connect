/**
 * The parts of a test sandbox that exist to protect the person running it.
 *
 * A suite here starts a real daemon, and a real daemon reaches for the real
 * machine. Most of that is handled by putting stand-ins ahead of the real
 * tools on PATH — but one reach cannot be: the daemon holds a Bluetooth
 * hands-free link open for as long as a phone is on the network, and during a
 * test run "a phone" means whatever handset the tester has paired. Pairing one
 * should not mean a test suite pages it, steals its call audio and leaves it
 * connected.
 *
 * So the sandbox says no, through the ordinary setting rather than a
 * test-shaped back door: every suite gets a config with the policy off, and
 * the link's own behaviour is tested against a stub in `calls.mjs` where it
 * can be checked without a handset in the room.
 */
import fs from 'node:fs'
import path from 'node:path'

export function quietBluetooth(configHome, extra = {}) {
  const dir = path.join(configHome, 'omarchy-connect')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'config.json')
  let current = {}
  try {
    current = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    /* a fresh sandbox is the normal case */
  }
  fs.writeFileSync(
    file,
    JSON.stringify({ ...current, handsfree: { autoConnect: 'off', address: null }, ...extra }, null, 2),
    { mode: 0o600 },
  )
  return file
}
