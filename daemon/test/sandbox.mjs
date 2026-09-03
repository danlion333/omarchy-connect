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
 *
 * The ringtone is the same kind of reach. A suite that mirrors a ringing call
 * would otherwise ring out loud on the machine running it, so it is off here
 * too — and `calls.mjs`, which does assert on it, turns it back on against a
 * stand-in player rather than the sound card.
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
    JSON.stringify(
      {
        ...current,
        handsfree: { autoConnect: 'off', address: null },
        ringtone: { enabled: false, sound: null },
        ...extra,
      },
      null,
      2,
    ),
    { mode: 0o600 },
  )
  return file
}

/**
 * The headers a suite needs to be allowed through a local route.
 *
 * The daemon gates everything that used to be "localhost only" on a secret it
 * publishes in its own status file, so a suite reaches those routes the same
 * way the CLI does: by reading the file. The read happens on every call rather
 * than once, because the secret is minted per daemon and a suite that restarts
 * one would otherwise keep presenting the dead daemon's password.
 */
export function localHeaders(stateDir = process.env.OMARCHY_CONNECT_STATE) {
  let secret = null
  try {
    secret = JSON.parse(fs.readFileSync(path.join(stateDir, 'status.json'), 'utf8')).localSecret
  } catch {
    // A suite that asks before the daemon has published gets the plain
    // headers and a 403 that says so, which is a clearer failure than a
    // throw from inside a helper.
  }
  return { 'content-type': 'application/json', ...(secret ? { 'x-oc-local': secret } : {}) }
}
