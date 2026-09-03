import { has, run, spawn } from './exec.js'

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
const ADAPTER = 'org.bluez.Adapter1'
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
/** BlueZ gives whoever is holding the handset a minute to tap Pair. */
const PAIR_TIMEOUT_MS = 75_000

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
 * Bonded, and either advertising the gateway side of the profile or looking
 * enough like a phone to be worth asking. The `111f` UUID used to be the whole
 * filter, on the reasoning that every phone advertises it — and every phone
 * does, once BlueZ has actually read its SDP records. What BlueZ publishes is
 * a *cache* of that read, and it is empty for a handset bonded over low energy
 * alone: an LE bond carries GATT services and no classic ones, so a phone
 * paired that way lists `1800`, `1801` and its vendor GATT UUIDs and nothing
 * else. Filtering on `111f` made that phone invisible, and an invisible phone
 * is reported as no phone at all — which sends whoever reads it to the pairing
 * screen for a handset that is already paired, rather than to the one thing
 * that would fix it.
 *
 * So the UUID stops being a filter and becomes what it always was: evidence.
 * `hfp` records whether the profile is in the cache, `pick` prefers a handset
 * that has it, and a handset that does not is still tried — because a cold
 * cache and a phone that genuinely cannot do this look identical from here,
 * and only `ConnectProfile` can tell them apart.
 *
 * This is a list of candidates rather than a decision; `pick` is where the
 * decision happens.
 */
export async function handsets() {
  return (await devices()).filter((d) => d.paired && phoneish(d))
}

/**
 * Whether a device on the tree is worth treating as a handset at all.
 *
 * The profile in the cache is the strong answer. `Icon` is BlueZ's own
 * readable one, and the class of device is the one that survives a handset
 * BlueZ has no icon rule for — its major field, bits 8 to 12, says `phone`
 * as 2. A device that answers none of the three is a mouse, a speaker or a
 * keyboard, and neither pairing nor paging has any business with it.
 */
export function phoneish(device) {
  return Boolean(device?.hfp) || device?.icon === 'phone' || device?.major === 2
}

/**
 * Every device on BlueZ's tree, bonded or not, sorted so two reads of an
 * unchanged tree are the same list.
 *
 * `handsets` wants the bonded ones. Pairing wants the ones that are not
 * bonded *yet*, and a scan puts both on the same tree: a handset BlueZ has
 * merely heard advertise is a `Device1` like any other, with `Paired` false
 * and an `RSSI` saying how close it is. One read answers both questions, so
 * there is one read.
 */
export async function devices() {
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
    const klass = unwrap(props.Class)
    found.push({
      path,
      address: unwrap(props.Address) ?? null,
      name: unwrap(props.Alias) || unwrap(props.Name) || null,
      icon: unwrap(props.Icon) ?? null,
      /** Whether BlueZ has actually seen the hands-free profile on this one. */
      hfp: uuids.some((uuid) => String(uuid).toLowerCase() === HFP_AG),
      /** The major device class, or null on a device that published none. */
      major: Number.isFinite(klass) ? (klass >> 8) & 0x1f : null,
      /**
       * `public` or `random`. A classic handset is always public; a `random`
       * entry is the low-energy half of the same phone, advertising under a
       * rotating address, and bonding with that one produces exactly the LE
       * bond that cannot carry the hands-free profile.
       */
      addressType: unwrap(props.AddressType) ?? null,
      paired: unwrap(props.Paired) === true,
      trusted: unwrap(props.Trusted) === true,
      connected: unwrap(props.Connected) === true,
      /**
       * Present only while a scan is running and the device is in earshot,
       * which is exactly what makes it the evidence that a phone is the one
       * in the room rather than one BlueZ remembers hearing last week.
       */
      rssi: Number.isFinite(unwrap(props.RSSI)) ? unwrap(props.RSSI) : null,
    })
  }
  found.sort((a, b) => String(a.address).localeCompare(String(b.address)))
  return found
}

/**
 * Names, reduced to the part two of them can actually be compared on.
 *
 * `OnePlus 9 Pro 5G`, `OnePlus_9_Pro_5G` and `oneplus 9 pro 5g` are one
 * handset written down by three different pieces of software.
 */
const normalise = (value) =>
  String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()

/**
 * Below this, a containment match is not evidence of anything.
 *
 * `G7` sits inside plenty of names it has nothing to do with, and a paired car
 * kit called `BT` would otherwise match every phone on the list.
 */
const NEAR_MIN = 4

/**
 * The handset that is the phone this desktop is already paired with.
 *
 * This is the whole answer to "connect to the right one, not to whatever is
 * lying around". The desktop cannot ask the phone for its Bluetooth address —
 * Android has handed every ordinary app the constant `02:00:00:00:00:00` since
 * Android 6, and the permission that lifts that is signature-only — so the
 * join has to be made on something both sides already publish. A name is
 * exactly that, and an unusually good one here: the name the app reports over
 * the LAN and the alias BlueZ carries are both the phone's own device name, so
 * on an untouched handset they are not merely similar but identical.
 *
 * Exact first. Containment only as a fallback, only when it leaves exactly one
 * candidate, and only for names long enough to mean something — somebody who
 * renamed their phone in one place and not the other is still recognised,
 * while `G7` does not get to be a OnePlus.
 */
export function matchesName(device, expect) {
  const wanted = normalise(expect)
  const name = normalise(device?.name)
  if (!wanted || !name) return false
  if (name === wanted) return true
  if (Math.min(name.length, wanted.length) < NEAR_MIN) return false
  return name.includes(wanted) || wanted.includes(name)
}

/**
 * Is the pairing question BlueZ is asking about the handset this window was
 * opened for?
 *
 * The question itself carries no name and no address — see `agent` — so this
 * is inference, and it is stated here rather than buried in a callback so
 * that it can be argued with and tested. The evidence is the tree BlueZ
 * publishes at the moment of the question: a device in the middle of pairing
 * is one this desktop is `Connected` to and has not `Paired` with. On the
 * ordinary path there is exactly one of those, and it is the phone.
 *
 * Three answers:
 *
 *   - Nothing is mid-pairing. BlueZ is asking about something this side
 *     cannot see, so no. A window that answers questions it cannot account
 *     for is the window this function exists to close.
 *   - Everything mid-pairing is the expected handset — by name, or by the
 *     address this desktop itself just paged. Yes.
 *   - Somebody else is in there too. No, and deliberately so: with a stranger
 *     and the right phone both connected there is no way to tell whose
 *     question this is, and the honest move is to answer neither. It costs a
 *     retry — the bond window pages again on its own — and a stranger who
 *     stands close enough for long enough can keep a bond from being made,
 *     which is a far smaller thing than being bonded to.
 *
 * With no name to expect, the caller has nothing to hold anything against and
 * should not be calling this at all; it says so by answering no.
 */
export function requestIsExpected(tree, { expected = null, address = null } = {}) {
  if (!normalise(expected) && !address) return false
  const pairing = (Array.isArray(tree) ? tree : []).filter((d) => d && d.connected && !d.paired)
  if (!pairing.length) return false
  const mine = (d) => matchesName(d, expected) || (address && d.address === address)
  return pairing.every(mine)
}

function byName(devices, expect) {
  if (!normalise(expect)) return null
  const exact = devices.filter((d) => normalise(d.name) === normalise(expect))
  if (exact.length) return exact.length === 1 ? exact[0] : null
  const near = devices.filter((d) => matchesName(d, expect))
  return near.length === 1 ? near[0] : null
}

/**
 * The handset an unqualified raise should page.
 *
 * Three answers, in descending order of how much they are actually worth.
 *
 * A pinned address wins outright — that is what it is for, and somebody who
 * typed an address is not to be second-guessed by any amount of inference.
 *
 * Then the handset that *is* the phone paired over the LAN, by name. This is
 * the one that turns "the desktop guesses" into "the desktop knows", and it is
 * why a machine bonded to a car kit, two sets of earbuds and a phone reaches
 * for the phone rather than giving up on the ambiguity.
 *
 * And only then the old guess, for a desktop with no LAN pairing to join
 * against: a handset that advertises the profile before one that merely might,
 * a phone rather than a headset, and exactly one of them. Two candidates and
 * nothing to separate them is a question the daemon has no business answering
 * on its own, so it answers nothing and `call status` says why.
 */
export function pick(devices, address = null, expect = null) {
  if (!devices.length) return null
  if (address) {
    const wanted = String(address).toUpperCase()
    return devices.find((d) => String(d.address).toUpperCase() === wanted) ?? null
  }
  const named = byName(devices, expect)
  if (named) return named
  // Narrow by the strongest evidence first, and only fall back to the weaker
  // pool when the stronger one is empty — so a desktop with one properly
  // bonded phone behaves exactly as it did before any of this, and the
  // fallback is reached only by a desktop that would otherwise have found
  // nothing at all.
  const advertised = devices.filter((d) => d.hfp)
  const pool = advertised.length ? advertised : devices
  const phones = pool.filter((d) => d.icon === 'phone')
  const shortlist = phones.length ? phones : pool
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
 * And the whole device, for the connection nobody here asked for.
 *
 * `disconnectProfile` is the ordinary verb: the daemon raises one profile, so
 * one profile is what it puts back down. A handset that paged this desktop on
 * its own is a different animal — BlueZ and the phone bring up everything the
 * bond carries, A2DP and AVRCP beside the hands-free profile, and putting down
 * our one profile leaves the device connected by the rest. To a Bluetooth
 * screen, and to a phone deciding where its audio lives, that phone is still
 * attached to the desktop it was supposed to be parked from.
 * `Device1.Disconnect` is the counterpart of the auto-connect that raised it:
 * everything at once, bond and trust kept.
 */
export async function disconnectDevice(path) {
  const res = await busctl(['call', BUS, path, DEVICE, 'Disconnect'], { timeout: 8000 })
  if (res.ok || /not connected/i.test(res.stderr)) return { ok: true }
  return { ok: false, error: reason(res.stderr) }
}

/**
 * `busctl` prints the D-Bus error name and message on one line, and the name
 * is noise to anyone reading a terminal: what the user can act on is "Page
 * Timeout", not `org.bluez.Error.Failed`.
 *
 * Two of BlueZ's answers are worth spelling out, because both are a sentence
 * about the world rather than about D-Bus, and neither is guessable from the
 * token it arrives as.
 */
function reason(stderr) {
  const text = String(stderr || '').trim()
  const match = /org\.bluez\.Error\.[A-Za-z]+:\s*(.+)$/m.exec(text)
  // Without an error name to strip, the last line still carries busctl's own
  // "Call failed: " in front of the part that means something.
  const message = (match ? match[1] : (text.split('\n').pop() || '').replace(/^call failed:\s*/i, '')).trim()
  if (!message) return 'the handset did not answer'
  if (/page timeout/i.test(message)) return 'the handset did not answer — out of range or asleep'
  /**
   * The bond exists, and it is not a bond the profile can use.
   *
   * Hands-free is a classic BR/EDR profile and needs a classic link key that
   * *both* ends still hold. Two roads lead to not having one: a handset
   * paired over low energy alone — an LE bond is real, is listed, and has no
   * classic key at all — and a classic bond gone one-sided, which is what a
   * radio that hangs mid-pairing leaves behind: this end remembers the key,
   * the handset never kept it. The error is the same from here and so is the
   * cure — nothing on the desktop can mint the missing key, so the pairing
   * has to be made again, and removed on both sides first so neither end
   * trusts a corpse.
   */
  if (/connection-key-missing|key.missing|authentication.failed/i.test(message)) {
    return 'the pairing is broken — remove this desktop on the phone, then pair again with `omarchy-connect call bond`'
  }
  return message.toLowerCase()
}

/* ── bonding ──────────────────────────────────────────────────────────── */

/**
 * Making the bond, rather than using one that is already there.
 *
 * Everything above this line assumes the bond exists, because for most of this
 * project's life the bond was somebody else's job: you pair a phone at a
 * Bluetooth screen once, and a daemon that pages it afterwards has no business
 * in that conversation. What that left behind was a dead end — a panel row
 * reading "no handset is paired over Bluetooth" with no button under it, which
 * tells the user what is wrong and nothing about what to do, while the desktop
 * sitting there already knows which phone it wants: the one it is paired with
 * over the LAN, by name.
 *
 * So the desktop makes the bond itself. Three things have to be true at once
 * and none of them is the default:
 *
 *   - Something has to answer BlueZ's pairing questions. That is an *agent*,
 *     and exporting a D-Bus object to be one is exactly the dependency this
 *     daemon does not ship — so `bluetoothctl` is borrowed as the agent, the
 *     same trick and the same reasoning as `ancs.js` uses for the iPhone.
 *   - The adapter has to be pairable and discoverable, because half the time
 *     it is the *phone* that initiates — an Android handset is discoverable
 *     only while its Bluetooth screen is open, so a desktop that can only scan
 *     would be waiting on a window the user has to hold open by hand.
 *   - And the bond has to be classic. Hands-free is a BR/EDR profile; an LE
 *     bond is listed, is real, and has no key for this road — which is the
 *     failure `reason` already knows how to spell out, and the one worth not
 *     creating in the first place.
 */

/**
 * The adapter's object path — `/org/bluez/hci0` on a machine with one radio.
 *
 * Read rather than assumed, and read every time rather than cached: a desktop
 * whose Bluetooth is a USB dongle can have it pulled out mid-session, and the
 * whole of this file is careful about answering "there is no radio" correctly.
 * Pairing happens a handful of times in a session, so the tree read costs
 * nothing that anybody can feel.
 */
export async function adapter() {
  const res = await busctl(['--json=short', 'call', BUS, '/', OBJECT_MANAGER, 'GetManagedObjects'], {
    timeout: 6000,
  })
  if (!res.ok) return null
  try {
    const objects = JSON.parse(res.stdout)?.data?.[0] ?? {}
    // A dongle that hangs and re-enumerates leaves its old index on the tree
    // for a moment beside the new one, and only one of them has power. Prefer
    // the adapter that is actually on; fall back to any, so a radio that is
    // merely off still gets named in the error the caller shows.
    const found = []
    for (const [path, interfaces] of Object.entries(objects)) {
      if (interfaces[ADAPTER]) found.push({ path, powered: unwrap(interfaces[ADAPTER].Powered) === true })
    }
    return (found.find((a) => a.powered) ?? found[0])?.path ?? null
  } catch {
    return null
  }
}

async function setProperty(path, iface, name, signature, value) {
  const res = await busctl(['set-property', BUS, path, iface, name, signature, String(value)])
  return res.ok ? { ok: true } : { ok: false, error: reason(res.stderr) }
}

/**
 * Be visible, and be willing — for `seconds` and not a moment longer.
 *
 * Both timeouts are handed to BlueZ rather than kept on a timer here, for the
 * reason `ancs.js` gives about its advertisement: this process being killed
 * outright must not leave the machine offering itself to the street for the
 * rest of the afternoon.
 */
export async function openToPairing(path, seconds) {
  await setProperty(path, ADAPTER, 'DiscoverableTimeout', 'u', seconds)
  await setProperty(path, ADAPTER, 'PairableTimeout', 'u', seconds)
  const pairable = await setProperty(path, ADAPTER, 'Pairable', 'b', 'true')
  const discoverable = await setProperty(path, ADAPTER, 'Discoverable', 'b', 'true')
  if (!pairable.ok) return pairable
  return discoverable
}

/**
 * And stop being either, which is the half that has to run even when the rest
 * of the attempt fell over. Failures are swallowed on purpose: this is the
 * cleanup path, and there is nobody left to tell.
 */
export async function closeToPairing(path) {
  await setProperty(path, ADAPTER, 'Discoverable', 'b', 'false').catch(() => {})
  await setProperty(path, ADAPTER, 'Pairable', 'b', 'false').catch(() => {})
}

/**
 * Ask for the bond.
 *
 * This blocks for as long as the far end takes to answer, and the far end is a
 * person deciding whether to tap Pair — BlueZ gives them a minute, so the
 * timeout here has to outlast that rather than cut it short and leave a
 * half-made bond behind.
 */
export async function pairDevice(path) {
  const res = await busctl(['call', BUS, path, DEVICE, 'Pair'], { timeout: PAIR_TIMEOUT_MS })
  if (res.ok || /already exists/i.test(res.stderr)) return { ok: true }
  return { ok: false, error: reason(res.stderr) }
}

/**
 * Trust it, which is a separate fact from having bonded with it.
 *
 * A bond says the two ends know each other. Trust says this desktop will let
 * that handset connect a profile without asking anybody first — and without
 * it, the phone reconnecting on its own after a call is a prompt nobody is
 * standing at the desktop to answer, so the reconnect quietly fails. Every
 * Bluetooth settings panel sets this at pairing time; so does this one.
 */
export async function trustDevice(path) {
  return setProperty(path, DEVICE, 'Trusted', 'b', 'true')
}

/**
 * The PIN this desktop answers with when a pairing goes the old way.
 *
 * It should never be needed. Both ends of a modern pairing speak Secure
 * Simple Pairing, and with this side declaring `NoInputNoOutput` that settles
 * on Just Works — the handset shows "pair with pc?", nobody types anything.
 * But *legacy* PIN pairing is still in the protocol, and a handset falls back
 * to it the moment it fails to learn that the far end speaks SSP — which is
 * exactly what a radio that hangs mid-handshake causes, and was watched
 * happening on an RTL8761BU that reset itself between the feature exchange
 * and the pairing. When that happens the phone asks its user for a code
 * "usually 0000 or 1234", BlueZ asks this agent the same question, and an
 * agent with no answer leaves both ends waiting on a page timeout.
 *
 * So the answer is the code every headset has answered with since 1998, the
 * one the phone's own dialog suggests, and the caller is told the moment it
 * was used so a screen can say "type 0000 on the phone".
 */
export const BOND_PIN = '0000'

/**
 * Somebody to answer BlueZ when it asks whether this pairing is wanted — and,
 * for the length of the window, somebody to be looking.
 *
 * `NoInputNoOutput` says the desktop has neither keypad nor screen for this,
 * which is what makes both ends settle on Just Works: the handset shows its
 * own "pair with pc?" prompt and nothing has to be read back on this side.
 * That is the honest capability for a daemon — there is no dialog here — and
 * it is what `ancs.js` already claims for the same reason.
 *
 * Honest about capability, not deaf. BlueZ routes *every* pairing question to
 * the default agent whatever capability it declared, and bluetoothctl prints
 * each one as a prompt on stdout and waits on stdin — so the questions the
 * happy path never asks are read and answered here rather than left hanging:
 * a legacy PIN request gets `BOND_PIN`, and the yes/no family — confirm this
 * passkey, accept this pairing, authorize this service — is put to `confirm`.
 * Without the PIN answer, a handset that fell back to legacy pairing sat on
 * "Enter PIN code:" until the page timed out, which read from the outside as
 * pairing that silently never works.
 *
 * `confirm` exists because "the window is the consent" was too generous a
 * reading of consent. The window is thirty seconds of a *discoverable*
 * adapter in a room this desktop does not own, and an agent that answers yes
 * to every yes/no question bonds with whoever asks first — a stranger's
 * handset in the next seat gets the same yes as the phone the button was
 * pressed for. So the answer is the caller's to give, and the caller knows
 * which phone it is waiting for.
 *
 * What the caller does *not* get is the question's subject, and that is worth
 * writing down because it shapes everything downstream. bluetoothctl's
 * prompts do not name the device: they read "Confirm passkey %06u (yes/no):",
 * "Accept pairing (yes/no):", "Authorize service %s (yes/no):" — a passkey, a
 * UUID, no address anywhere (checked against 5.87). The identity has to come
 * from BlueZ's own tree at the moment the question is asked, which is what
 * `requestIsExpected` is for. `confirm` is therefore asynchronous, and the
 * prompt is left waiting on stdin while it is answered — bluetoothctl is
 * happy to wait, and a D-Bus read takes a fraction of the time BlueZ allows.
 *
 * With no `confirm` the old behaviour stands: yes to everything. That is the
 * right default for a caller that has nothing to hold a request against, and
 * the only caller in this repository passes one.
 *
 * The scan belongs in here rather than in a `busctl` call of its own, and the
 * reason is a detail of BlueZ worth writing down: `SetDiscoveryFilter` is
 * remembered per D-Bus client and forgotten the moment that client goes away.
 * Every `busctl` invocation is its own client, alive for milliseconds, so a
 * filter set that way is gone before the scan it was meant to shape ever
 * starts — and an unfiltered scan on a modern adapter is mostly low-energy
 * beacons, every fitness band and thermometer in the building. This process
 * lasts the whole window, so the filter it sets does too.
 *
 * `default-agent` is what makes BlueZ route its questions here; when the
 * process goes, BlueZ hands the role back to whatever else was registered,
 * which on Omarchy is the system's own agent.
 */
export function agent({ pin = BOND_PIN, notify, confirm = null } = {}) {
  if (!has('bluetoothctl')) return null
  const child = spawn('bluetoothctl', ['--agent', 'NoInputNoOutput'], { stdio: ['pipe', 'pipe', 'ignore'] })
  const write = (text) => {
    try {
      child.stdin.write(text)
    } catch {
      /* it has already gone; the caller finds out when pairing fails */
    }
  }
  const tell = (kind, value) => {
    try {
      notify?.(kind, value)
    } catch {
      /* the listener's problem is not the pairing's problem */
    }
  }
  /**
   * bluetoothctl's questions arrive as prompts with no newline after them, so
   * this watches the tail of the stream rather than lines. Scan chatter — a
   * `[NEW] Device` per phone in the building — flows through the same pipe,
   * which is why every match anchors to the end.
   */
  let tail = ''
  /**
   * The caller's answer, or yes when there is no caller to ask.
   *
   * A `confirm` that throws or that cannot tell is a no. The cost of a wrong
   * no is one page that has to be retried, and the bond window retries by
   * itself; the cost of a wrong yes is a bond with a device nobody chose.
   */
  const decide = async () => {
    if (!confirm) return true
    try {
      return (await confirm()) === true
    } catch {
      return false
    }
  }
  let answering = Promise.resolve()
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    tail = (tail + chunk).slice(-2048)
    if (/Enter PIN code:\s*$/.test(tail)) {
      tail = ''
      write(`${pin}\n`)
      tell('pin', pin)
    } else if (/\(yes\/no\):\s*$/.test(tail)) {
      tail = ''
      // One at a time, in the order asked. Two questions can arrive while the
      // first is still being thought about — two handsets in the room is the
      // whole reason this is here — and answering them out of order would put
      // the wrong yes against the wrong request.
      answering = answering.then(async () => {
        const yes = await decide()
        write(yes ? 'yes\n' : 'no\n')
        tell(yes ? 'confirm' : 'declined', null)
      })
    }
  })
  write(['power on', 'default-agent', 'menu scan', 'transport bredr', 'back', 'scan on', ''].join('\n'))
  child.on('error', () => {})
  return {
    stop() {
      write('scan off\nquit\n')
      setTimeout(() => {
        try {
          child.kill()
        } catch {
          /* likewise */
        }
      }, 300).unref?.()
    },
  }
}
