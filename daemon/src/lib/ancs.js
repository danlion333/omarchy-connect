import { EventEmitter } from 'node:events'

import { has, run, spawn } from './exec.js'
import { log } from './log.js'

/**
 * The desktop as an iPhone's notification consumer.
 *
 * iOS never lets an ordinary app read the notification centre, the message
 * store, or the call log — no permission exists to ask for, so the app half of
 * this project simply cannot reach any of it. That looks like a dead end until
 * you notice that Apple *does* publish all three, in full, to a completely
 * different kind of peer: a Bluetooth accessory.
 *
 * The Apple Notification Center Service is how a watch or a car knows who is
 * calling. The iPhone is the GATT server; anything bonded to it over Bluetooth
 * Low Energy may subscribe and receive every notification the phone raises —
 * the originating app, the title, the body, the timestamp — and may act on the
 * two buttons a notification carries. A Messages notification therefore
 * carries the sender and the text; an incoming call carries the caller's name
 * as the phone knows it, contact card and all.
 *
 * So the iOS half of this project is not written in the app at all. It is
 * written here, and it needs nothing installed on the phone.
 *
 * This sits beside `lib/handsfree.js` and the division is deliberate:
 *
 *   - Hands-free (classic Bluetooth) carries the *voice* and answers calls.
 *   - ANCS (low energy) carries the *text* — who, what, and from which app.
 *
 * Both are the same phone and often the same bond, and together they are as
 * close to the Android feature set as iOS can be brought. The one thing
 * neither can do is send a message: reading is a notification, writing is an
 * API, and iOS publishes only the first.
 *
 * ## How this talks to BlueZ
 *
 * Same reasoning as the hands-free side — this daemon ships one dependency on
 * purpose — but the system bus forces one difference. `busctl monitor` needs
 * `org.freedesktop.DBus.Monitoring`, which is root-only, so writes and reads go
 * through `busctl --system` while incoming GATT notifications are read from
 * `gdbus monitor`, which subscribes as an ordinary client. GLib prints a byte
 * array as `[byte 0x01, 0x02, …]` — hex, never a bytestring, even when the
 * payload is printable — so the wire format survives the round trip through
 * text intact.
 */

const BLUEZ = 'org.bluez'
const OBJECT_MANAGER = 'org.freedesktop.DBus.ObjectManager'
const DEVICE = 'org.bluez.Device1'
const GATT_SERVICE = 'org.bluez.GattService1'
const GATT_CHARACTERISTIC = 'org.bluez.GattCharacteristic1'

/** Apple Notification Center Service, and the three characteristics on it. */
const ANCS = '7905f431-b5ce-4e99-a40f-4b1e122d00d0'
const NOTIFICATION_SOURCE = '9fbf120d-6301-42d9-8c58-25e699a21dbd'
const CONTROL_POINT = '69d1d8f3-45e1-49a8-9821-9bbdfdaad9d9'
const DATA_SOURCE = '22eac6e9-24d6-4bb5-be44-b36ace7c7bfb'

const EVENT = { added: 0, modified: 1, removed: 2 }
const FLAG = { silent: 1, important: 2, preExisting: 4, positive: 8, negative: 16 }

/**
 * Apple's category list. We keep the names because they are the only hint the
 * protocol gives about what a notification *is* — an incoming call and a
 * podcast episode are otherwise the same eight bytes.
 */
const CATEGORY = [
  'other',
  'incomingCall',
  'missedCall',
  'voicemail',
  'social',
  'schedule',
  'email',
  'news',
  'health',
  'business',
  'location',
  'entertainment',
]

const ATTR = { app: 0, title: 1, subtitle: 2, message: 3, size: 4, date: 5, positive: 6, negative: 7 }
const COMMAND = { attributes: 0, appAttributes: 1, action: 2 }
/** Id 0 again, but on an app reply it is the display name, not the bundle. */
const APP_DISPLAY_NAME = 0
const ACTION = { positive: 0, negative: 1 }

/** What we ask for about every notification, and how much of it we will take. */
const WANTED = [
  [ATTR.app, 0],
  [ATTR.title, 64],
  [ATTR.subtitle, 64],
  [ATTR.message, 512],
  [ATTR.date, 0],
  [ATTR.positive, 32],
  [ATTR.negative, 32],
]

/** The apps whose notifications are messages rather than announcements. */
const MESSAGING = new Set([
  'com.apple.MobileSMS',
  'com.apple.mobilesms',
  'net.whatsapp.WhatsApp',
  'org.telegram.messenger',
  'com.facebook.Messenger',
  'ph.telegra.Telegraph',
  'com.viber',
  'com.tencent.xin',
  'com.hammerandchisel.discord',
  'com.toyopagroup.picaboo',
  'com.burbn.instagram',
  'com.apple.MobileSMS.MessageExtension',
])

const SETTLE_MS = 200
const REQUEST_TIMEOUT_MS = 5000
/** How long a pairing window stays open, matching the app's own pairing code. */
const PAIRING_SECONDS = 120

const unwrap = (value) => (value && typeof value === 'object' && 'data' in value ? value.data : value)

function properties(dict) {
  const out = {}
  for (const [key, value] of Object.entries(dict || {})) out[key] = unwrap(value)
  return out
}

const uuid = (value) => String(value || '').toLowerCase()

async function busctl(args, { timeout = 5000 } = {}) {
  return run('busctl', ['--system', ...args], { timeout })
}

/**
 * `<[byte 0x01, 0x02]>` from `gdbus monitor`, back into bytes. An empty array
 * prints as `<@ay []>` instead, which parses to nothing and is not an error.
 */
export function parseBytes(text) {
  const out = []
  for (const match of String(text || '').matchAll(/0x([0-9a-f]{1,2})/gi)) out.push(parseInt(match[1], 16))
  return Buffer.from(out)
}

/**
 * The eight bytes the phone pushes whenever a notification appears, changes or
 * goes away. Everything else about it has to be asked for.
 */
export function parseNotification(bytes) {
  if (!bytes || bytes.length < 8) return null
  const flags = bytes[1]
  return {
    event: Object.keys(EVENT).find((k) => EVENT[k] === bytes[0]) ?? 'unknown',
    category: CATEGORY[bytes[2]] ?? 'other',
    categoryCount: bytes[3],
    uid: bytes.readUInt32LE(4),
    silent: Boolean(flags & FLAG.silent),
    important: Boolean(flags & FLAG.important),
    /** Set on everything already on screen when we subscribed — not news. */
    preExisting: Boolean(flags & FLAG.preExisting),
    positive: Boolean(flags & FLAG.positive),
    negative: Boolean(flags & FLAG.negative),
  }
}

/**
 * A reply to a Control Point request, as `attribute id → string`.
 *
 * Anything longer than the negotiated MTU arrives in pieces, so this is
 * written to be handed the buffer as it grows and to say `null` until the last
 * tuple is whole. `count` is how many attributes we asked for; the protocol
 * gives no other end marker.
 */
export function parseAttributes(buffer, count) {
  if (!buffer.length) return null
  const command = buffer[0]
  let at = 1
  let key = null

  if (command === COMMAND.appAttributes) {
    // The app identifier comes back NUL-terminated before the tuples do.
    const end = buffer.indexOf(0, at)
    if (end < 0) return null
    key = buffer.toString('utf8', at, end)
    at = end + 1
  } else {
    if (buffer.length < 5) return null
    key = buffer.readUInt32LE(1)
    at = 5
  }

  const attributes = {}
  for (let i = 0; i < count; i += 1) {
    if (at + 3 > buffer.length) return null
    const id = buffer[at]
    const length = buffer.readUInt16LE(at + 1)
    if (at + 3 + length > buffer.length) return null
    attributes[id] = buffer.toString('utf8', at + 3, at + 3 + length)
    at += 3 + length
  }
  return { command, key, attributes }
}

/** ANCS timestamps are local wall clock: `20260825T173000`. */
export function parseDate(value) {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/.exec(String(value || '').trim())
  if (!m) return null
  const at = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime()
  return Number.isFinite(at) ? at : null
}

export class Ancs extends EventEmitter {
  constructor() {
    super()
    this.state = { available: false, device: null, subscribed: false }
    this.chars = { source: null, control: null, data: null }
    this.monitor = null
    this.settle = null
    this.stopped = true
    this.apps = new Map()
    /** Control Point allows one question at a time; this is the queue. */
    this.inflight = null
    this.chain = Promise.resolve()
    this.pairing = null
  }

  /** Is there a BlueZ on this machine at all? */
  async probe() {
    if (!has('busctl')) return false
    const res = await busctl([
      '--json=short',
      'call',
      'org.freedesktop.DBus',
      '/org/freedesktop/DBus',
      'org.freedesktop.DBus',
      'NameHasOwner',
      's',
      BLUEZ,
    ])
    if (!res.ok) return false
    try {
      return JSON.parse(res.stdout)?.data?.[0] === true
    } catch {
      return false
    }
  }

  /**
   * Find the bonded iPhone and the three characteristics on it.
   *
   * BlueZ publishes a connected device's whole GATT tree as D-Bus objects
   * underneath it, so this is one call rather than a discovery dance — and it
   * finds nothing at all, quietly, on a machine where no iPhone has ever been
   * near. A device only counts once its services are resolved: before that the
   * tree is still filling in and the characteristics would be missing for no
   * reason worth reporting.
   */
  async read() {
    const res = await busctl(['--json=short', 'call', BLUEZ, '/', OBJECT_MANAGER, 'GetManagedObjects'], {
      timeout: 8000,
    })
    if (!res.ok) return { available: false, device: null, chars: { source: null, control: null, data: null } }

    let objects
    try {
      objects = JSON.parse(res.stdout)?.data?.[0] ?? {}
    } catch {
      return { available: true, device: null, chars: { source: null, control: null, data: null } }
    }

    const devices = new Map()
    const services = new Map()
    const characteristics = []

    for (const [path, interfaces] of Object.entries(objects)) {
      if (interfaces[DEVICE]) {
        const props = properties(interfaces[DEVICE])
        devices.set(path, {
          path,
          address: props.Address ?? null,
          name: props.Alias || props.Name || null,
          connected: props.Connected === true,
          paired: props.Paired === true,
          resolved: props.ServicesResolved === true,
          uuids: (props.UUIDs || []).map(uuid),
        })
      }
      if (interfaces[GATT_SERVICE]) {
        const props = properties(interfaces[GATT_SERVICE])
        services.set(path, { path, uuid: uuid(props.UUID), device: props.Device ?? null })
      }
      if (interfaces[GATT_CHARACTERISTIC]) {
        const props = properties(interfaces[GATT_CHARACTERISTIC])
        characteristics.push({ path, uuid: uuid(props.UUID), service: props.Service ?? null })
      }
    }

    const service = [...services.values()].find((s) => s.uuid === ANCS && devices.get(s.device)?.resolved)
    if (!service) {
      // Nothing to talk to, but say whether an iPhone is at least in the list —
      // "paired but not offering ANCS" and "no phone here" want different advice.
      const candidate = [...devices.values()].find((d) => d.uuids.includes(ANCS)) ?? null
      return { available: true, device: candidate, chars: { source: null, control: null, data: null } }
    }

    const mine = characteristics.filter((c) => c.service === service.path)
    return {
      available: true,
      device: devices.get(service.device) ?? null,
      chars: {
        source: mine.find((c) => c.uuid === NOTIFICATION_SOURCE)?.path ?? null,
        control: mine.find((c) => c.uuid === CONTROL_POINT)?.path ?? null,
        data: mine.find((c) => c.uuid === DATA_SOURCE)?.path ?? null,
      },
    }
  }

  get connected() {
    return Boolean(this.state.device?.connected && this.state.subscribed)
  }

  async startNotify(path) {
    const res = await busctl(['call', BLUEZ, path, GATT_CHARACTERISTIC, 'StartNotify'])
    // Subscribing twice is the normal case after a reconnect, not a failure.
    if (!res.ok && !/already|in progress/i.test(res.stderr)) throw new Error(res.stderr || 'StartNotify refused')
    return true
  }

  async write(path, bytes) {
    const res = await busctl([
      'call',
      BLUEZ,
      path,
      GATT_CHARACTERISTIC,
      'WriteValue',
      'aya{sv}',
      String(bytes.length),
      ...[...bytes].map(String),
      '0',
    ])
    if (!res.ok) throw new Error(res.stderr || 'the phone refused the write')
    return true
  }

  /**
   * Ask the phone about one notification and wait for the answer.
   *
   * Serialised on purpose: the Control Point is a single conversation, and
   * answers longer than the MTU come back as a run of unlabelled fragments
   * that can only be reassembled if nothing else is talking at the same time.
   */
  request(payload, count) {
    const run = async () => {
      if (!this.chars.control || !this.chars.data) throw new Error('not subscribed to ANCS')
      const outcome = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          if (this.inflight?.reject === reject) this.inflight = null
          reject(new Error('the phone did not answer'))
        }, REQUEST_TIMEOUT_MS)
        timer.unref?.()
        this.inflight = { buffer: Buffer.alloc(0), count, resolve, reject, timer }
      })
      try {
        await this.write(this.chars.control, payload)
      } catch (err) {
        // Otherwise the abandoned slot sits there until it times out, and the
        // next reply to arrive gets spliced into a buffer nobody is reading.
        this.discard(err)
        throw err
      }
      return outcome
    }
    // Keep the chain alive even when a link in it fails.
    const next = this.chain.then(run, run)
    this.chain = next.then(
      () => {},
      () => {},
    )
    return next
  }

  /** Abandon whatever the Control Point was waiting for. */
  discard(err) {
    const pending = this.inflight
    if (!pending) return
    this.inflight = null
    clearTimeout(pending.timer)
    pending.reject(err instanceof Error ? err : new Error(String(err)))
  }

  /** Fragments of a Control Point answer, spliced back together. */
  onData(bytes) {
    const pending = this.inflight
    if (!pending) return
    pending.buffer = Buffer.concat([pending.buffer, bytes])
    let parsed = null
    try {
      parsed = parseAttributes(pending.buffer, pending.count)
    } catch {
      // A malformed answer is the phone's problem, not a reason to wedge the
      // queue behind a promise nobody will ever settle.
      this.discard(new Error('the phone sent something we could not read'))
      return
    }
    if (!parsed) return // more fragments still to come
    clearTimeout(pending.timer)
    this.inflight = null
    pending.resolve(parsed)
  }

  /** An app's display name — asked once, then remembered for the session. */
  async appName(id) {
    if (!id) return null
    if (this.apps.has(id)) return this.apps.get(id)
    let name = null
    try {
      const payload = Buffer.concat([
        Buffer.from([COMMAND.appAttributes]),
        Buffer.from(id, 'utf8'),
        Buffer.from([0, APP_DISPLAY_NAME]),
      ])
      const reply = await this.request(payload, 1)
      name = reply.attributes[APP_DISPLAY_NAME] || null
    } catch {
      // Not worth a second attempt; the bundle id is a usable fallback.
    }
    this.apps.set(id, name)
    return name
  }

  /** Everything the phone will say about one notification. */
  async describe(uid) {
    const payload = Buffer.alloc(5 + WANTED.reduce((n, [, len]) => n + (len ? 3 : 1), 0))
    payload[0] = COMMAND.attributes
    payload.writeUInt32LE(uid, 1)
    let at = 5
    for (const [id, length] of WANTED) {
      payload[at] = id
      at += 1
      if (length) {
        payload.writeUInt16LE(length, at)
        at += 2
      }
    }
    const reply = await this.request(payload, WANTED.length)
    const a = reply.attributes
    const app = a[ATTR.app] || null
    return {
      uid,
      app,
      appName: (await this.appName(app)) || app,
      title: a[ATTR.title] || null,
      subtitle: a[ATTR.subtitle] || null,
      message: a[ATTR.message] || null,
      at: parseDate(a[ATTR.date]),
      positiveLabel: a[ATTR.positive] || null,
      negativeLabel: a[ATTR.negative] || null,
    }
  }

  /**
   * Press one of the two buttons the notification carries.
   *
   * For an incoming call those are Answer and Decline, which makes this a
   * second road to picking up an iPhone — worth having, but not the one to
   * prefer: it moves no audio, so `handsfree` still answers when it can.
   */
  async act(uid, which = 'positive') {
    if (!this.chars.control) throw new Error('no iPhone is connected over Bluetooth LE')
    const id = which === 'negative' ? ACTION.negative : ACTION.positive
    const payload = Buffer.alloc(6)
    payload[0] = COMMAND.action
    payload.writeUInt32LE(uid, 1)
    payload[5] = id
    await this.write(this.chars.control, payload)
    return { ok: true, via: 'ancs', uid, action: which }
  }

  /**
   * A notification arrived. Ask what it says, then hand it on.
   *
   * `preExisting` marks whatever was already on the phone's lock screen when
   * we subscribed. Those are real notifications but they are not *news*, and
   * replaying a morning's worth of them onto the desktop the moment the phone
   * walks into the room would be its own kind of broken.
   */
  async onNotification(head) {
    if (head.event === 'removed') {
      this.emit('removed', head)
      return
    }
    if (head.preExisting) return
    if (head.event === 'modified') return
    try {
      const detail = await this.describe(head.uid)
      const entry = { ...head, ...detail, at: detail.at ?? Date.now(), messaging: MESSAGING.has(detail.app) }
      this.emit('notification', entry)
    } catch (err) {
      log.debug(`ancs: could not read notification ${head.uid}: ${err.message}`)
    }
  }

  /**
   * `gdbus monitor` rather than `busctl monitor`: the system bus reserves
   * `BecomeMonitor` for root, while an ordinary signal subscription — which is
   * all this needs — is open to anyone. Value changes on the two notifiable
   * characteristics are the payload; everything else on the name means the
   * topology moved and is worth a re-read.
   */
  watch() {
    if (!has('gdbus')) {
      log.warn('gdbus missing — iPhone notification mirroring disabled')
      return
    }
    const child = spawn('gdbus', ['monitor', '--system', '--dest', BLUEZ], {
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    child.on('error', () => {
      this.monitor = null
    })
    child.stdout.setEncoding('utf8')
    let buffered = ''
    child.stdout.on('data', (chunk) => {
      buffered += chunk
      const lines = buffered.split('\n')
      buffered = lines.pop() ?? ''
      for (const line of lines) this.onLine(line)
    })
    child.on('exit', () => {
      this.monitor = null
      if (!this.stopped) setTimeout(() => this.start().catch(() => {}), 2000).unref?.()
    })
    child.unref()
    this.monitor = child
  }

  onLine(line) {
    const match = /^(\S+): org\.freedesktop\.DBus\.Properties\.PropertiesChanged \('org\.bluez\.GattCharacteristic1'/.exec(
      line,
    )
    if (!match) {
      // InterfacesAdded, a device connecting, services resolving — all of them
      // mean the tree we cached may be wrong now.
      if (/Interfaces(Added|Removed)|'(Connected|ServicesResolved)'/.test(line)) this.bump()
      return
    }
    const path = match[1]
    if (path !== this.chars.source && path !== this.chars.data) return
    const value = /'Value': <(.*?)>\}/.exec(line)
    if (!value) return
    const bytes = parseBytes(value[1])
    if (!bytes.length) return
    if (path === this.chars.data) {
      this.onData(bytes)
      return
    }
    const head = parseNotification(bytes)
    if (head) this.onNotification(head).catch(() => {})
  }

  bump() {
    if (this.settle || this.stopped) return
    this.settle = setTimeout(() => {
      this.settle = null
      this.attach().catch((err) => log.debug(`ancs refresh failed: ${err.message}`))
    }, SETTLE_MS)
  }

  /** Re-read the tree and subscribe if an iPhone is there to subscribe to. */
  async attach() {
    const next = await this.read()
    const before = this.state.device?.path ?? null
    const wasSubscribed = this.state.subscribed

    this.chars = next.chars
    let subscribed = false
    if (next.chars.source && next.chars.data) {
      try {
        await this.startNotify(next.chars.data)
        await this.startNotify(next.chars.source)
        subscribed = true
      } catch (err) {
        log.debug(`ancs: could not subscribe: ${err.message}`)
      }
    }
    if (!subscribed) this.apps.clear()

    this.state = { available: next.available, device: next.device, subscribed }
    if (before !== (next.device?.path ?? null) || wasSubscribed !== subscribed) {
      this.emit('device', this.state.device, subscribed)
    }
    return this.state
  }

  async start() {
    this.stopped = false
    if (!(await this.probe())) {
      this.state = { available: false, device: null, subscribed: false }
      return false
    }
    await this.attach()
    if (!this.monitor) this.watch()
    return true
  }

  stop() {
    this.stopped = true
    if (this.settle) clearTimeout(this.settle)
    if (this.inflight) clearTimeout(this.inflight.timer)
    this.settle = this.inflight = null
    this.monitor?.kill()
    this.monitor = null
    this.stopPairing()
    this.removeAllListeners()
  }

  /**
   * Open a window in which an iPhone will offer us ANCS.
   *
   * An iPhone does not hand its notifications to anything it has merely been
   * paired with over classic Bluetooth: the bond has to be a low-energy one,
   * and the phone has to have been told, at pairing time, that we are the kind
   * of device that wants notifications. Advertising the ANCS UUID as a
   * *solicitation* is how an accessory says exactly that — it is a request to
   * be given the service, not an offer to provide it — and it is what makes
   * iOS show the "…would like to access your notifications" prompt.
   *
   * `bluetoothctl` already knows how to register an advertisement with BlueZ,
   * which spares us exporting a D-Bus object of our own; the advertisement
   * lives exactly as long as the process does, which is precisely the window
   * we want anyway.
   */
  pair({ seconds = PAIRING_SECONDS, name = null } = {}) {
    if (!has('bluetoothctl')) throw new Error('bluetoothctl is not installed')
    this.stopPairing()
    // No keypad, no screen: the phone offers Just Works rather than asking the
    // desktop to read back a passkey nobody would be standing next to.
    const child = spawn('bluetoothctl', ['--agent', 'NoInputNoOutput'], { stdio: ['pipe', 'pipe', 'ignore'] })
    const script = [
      'power on',
      'default-agent',
      // Both timeouts are handed to BlueZ rather than kept here on purpose:
      // this process being killed outright must not leave the machine
      // advertising itself to the street for the rest of the afternoon.
      `discoverable-timeout ${seconds}`,
      'pairable on',
      'menu advertise',
      ...(name ? [`name ${name}`] : ['name on']),
      `solicit ${ANCS.toUpperCase()}`,
      'discoverable on',
      `timeout ${seconds}`,
      'back',
      'advertise peripheral',
      'discoverable on',
      '',
    ].join('\n')
    child.stdin.write(script)
    child.stdout.setEncoding('utf8')
    const stop = setTimeout(() => this.stopPairing(), seconds * 1000)
    stop.unref?.()
    child.on('exit', () => {
      if (this.pairing?.child === child) this.pairing = null
    })
    this.pairing = { child, stop, until: Date.now() + seconds * 1000 }
    return { ok: true, seconds, until: this.pairing.until }
  }

  stopPairing() {
    if (!this.pairing) return false
    const { child, stop } = this.pairing
    this.pairing = null
    clearTimeout(stop)
    try {
      child.stdin.write('advertise off\ndiscoverable off\npairable off\nquit\n')
    } catch {
      /* it has already gone */
    }
    setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* likewise */
      }
    }, 300).unref?.()
    return true
  }

  /** What the panel and `status --json` show. */
  summary() {
    const device = this.state.device
    return {
      available: this.state.available,
      connected: this.connected,
      subscribed: this.state.subscribed,
      device: device?.name || device?.address || null,
      address: device?.address ?? null,
      // A phone that is bonded and offers ANCS but is not connected right now
      // is a different problem from one that was never paired.
      paired: Boolean(device?.paired),
      pairing: this.pairing ? { until: this.pairing.until } : null,
    }
  }
}

export const ancs = new Ancs()
export const ANCS_UUID = ANCS
