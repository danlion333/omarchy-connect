import { has, run } from './exec.js'

/**
 * The BlueZ side of the hands-free link.
 *
 * `handsfree.js` drives a link that is already up. This raises the link in the
 * first place, and the two are deliberately separate: PipeWire publishes an
 * audio gateway only once the profile is connected, so nothing in the
 * telephony surface can even see a phone that is merely paired — let alone
 * page it.
 *
 * One profile, never the whole device. BlueZ's `Connect` brings up everything
 * the handset offers, which on a phone means A2DP and AVRCP as well, and a
 * desktop that quietly becomes a speaker every time it wants a microphone is a
 * worse neighbour than one that stays out of the way. `ConnectProfile` with
 * the phone's hands-free UUID raises the one link we have a use for and leaves
 * the rest of the machine's audio exactly where the user put it.
 *
 * `busctl` again, for the reason `handsfree.js` gives: this daemon ships one
 * dependency on purpose, and systemd is not optional on a machine running
 * Omarchy. BlueZ lives on the system bus rather than the session one.
 */

const BUS = 'org.bluez'
const DEVICE = 'org.bluez.Device1'
const OBJECT_MANAGER = 'org.freedesktop.DBus.ObjectManager'

/**
 * Hands-Free Audio Gateway — the *phone's* half of the profile.
 *
 * `ConnectProfile` names the service on the far end, not the role this machine
 * plays, so the desktop asks for `111f` in order to be the `111e` that talks
 * to it.
 */
export const HFP_AG = '0000111f-0000-1000-8000-00805f9b34fb'

/** Paging a handset that is in a pocket takes its time; failing takes longer. */
const CONNECT_TIMEOUT_MS = 20_000

/** `busctl --json=short` wraps every value as { type, data }. */
const unwrap = (value) => (value && typeof value === 'object' && 'data' in value ? value.data : value)

async function busctl(args, { timeout = 5000 } = {}) {
  return run('busctl', ['--system', ...args], { timeout })
}

/** Whether BlueZ is running at all. A missing `busctl` is the same answer. */
export async function available() {
  if (!has('busctl')) return false
  const res = await busctl([
    '--json=short',
    'call',
    'org.freedesktop.DBus',
    '/org/freedesktop/DBus',
    'org.freedesktop.DBus',
    'NameHasOwner',
    's',
    BUS,
  ])
  if (!res.ok) return false
  try {
    return JSON.parse(res.stdout)?.data?.[0] === true
  } catch {
    return false
  }
}

/**
 * Every handset this desktop could raise a hands-free link to.
 *
 * Bonded, and advertising the gateway side of the profile. A phone the user
 * paired for file transfer and nothing else advertises `111f` all the same —
 * every phone does — so this is a list of candidates rather than a decision,
 * and `pick` is where the decision happens.
 */
export async function handsets() {
  const res = await busctl(['--json=short', 'call', BUS, '/', OBJECT_MANAGER, 'GetManagedObjects'], {
    timeout: 6000,
  })
  if (!res.ok) return []

  let objects
  try {
    objects = JSON.parse(res.stdout)?.data?.[0] ?? {}
  } catch {
    return []
  }

  const found = []
  for (const [path, interfaces] of Object.entries(objects)) {
    const props = interfaces[DEVICE]
    if (!props) continue
    const uuids = unwrap(props.UUIDs) || []
    if (unwrap(props.Paired) !== true) continue
    if (!uuids.some((uuid) => String(uuid).toLowerCase() === HFP_AG)) continue
    found.push({
      path,
      address: unwrap(props.Address) ?? null,
      name: unwrap(props.Alias) || unwrap(props.Name) || null,
      icon: unwrap(props.Icon) ?? null,
      trusted: unwrap(props.Trusted) === true,
      connected: unwrap(props.Connected) === true,
    })
  }
  found.sort((a, b) => String(a.address).localeCompare(String(b.address)))
  return found
}

/**
 * The handset an unqualified raise should page.
 *
 * A pinned address wins outright — that is what it is for. Otherwise the
 * desktop guesses, and only when the guess is unambiguous: a phone rather than
 * a headset, and exactly one of them. Two paired phones and no pin is a
 * question the daemon has no business answering on its own, so it answers
 * nothing and `call status` says why.
 */
export function pick(devices, address = null) {
  if (!devices.length) return null
  if (address) {
    const wanted = String(address).toUpperCase()
    return devices.find((d) => String(d.address).toUpperCase() === wanted) ?? null
  }
  const phones = devices.filter((d) => d.icon === 'phone')
  const shortlist = phones.length ? phones : devices
  return shortlist.length === 1 ? shortlist[0] : null
}

export async function connectProfile(path, uuid = HFP_AG) {
  const res = await busctl(['call', BUS, path, DEVICE, 'ConnectProfile', 's', uuid], {
    timeout: CONNECT_TIMEOUT_MS,
  })
  if (res.ok) return { ok: true }
  // BlueZ answers "Already Connected" as an error; from here that is a success
  // with nothing left to do.
  if (/already connected/i.test(res.stderr)) return { ok: true }
  return { ok: false, error: reason(res.stderr) }
}

export async function disconnectProfile(path, uuid = HFP_AG) {
  const res = await busctl(['call', BUS, path, DEVICE, 'DisconnectProfile', 's', uuid], { timeout: 8000 })
  if (res.ok || /not connected/i.test(res.stderr)) return { ok: true }
  return { ok: false, error: reason(res.stderr) }
}

/**
 * `busctl` prints the D-Bus error name and message on one line, and the name
 * is noise to anyone reading a terminal: what the user can act on is "Page
 * Timeout", not `org.bluez.Error.Failed`.
 */
function reason(stderr) {
  const text = String(stderr || '').trim()
  const match = /org\.bluez\.Error\.[A-Za-z]+:\s*(.+)$/m.exec(text)
  const message = (match ? match[1] : text.split('\n').pop() || '').trim()
  if (!message) return 'the handset did not answer'
  if (/page timeout/i.test(message)) return 'the handset did not answer — out of range or asleep'
  return message.toLowerCase()
}
