import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { CONFIG_DIR, CONFIG_FILE } from './paths.js'
import { log } from './log.js'

const DEFAULTS = {
  version: 1,
  deviceName: os.hostname(),
  port: 8765,
  autoAcceptClipboard: true,
  openFilesOnReceive: false,
  requireEncryption: true,
  tls: false,
  // Reading an agent is reading everything it saw, and writing to one is a
  // shell. Nothing here is on until `omarchy-connect agent enable` says so.
  agents: { enabled: false, spawn: false },
  /**
   * Whether the phone may reach this desktop from outside its own subnet,
   * over whatever overlay network the machine already runs.
   *
   * Off, like agents, and for the same reason: the promise this project makes
   * is that nothing leaves the subnet, and a promise with an exception in it
   * has to be the user's exception rather than ours. Switching it on is
   * `omarchy-connect remote on` or the panel.
   */
  remote: { enabled: false },
  /**
   * When the desktop holds the Bluetooth hands-free link open.
   *
   * `ring` is the default: the link exists while a call does and not
   * otherwise. It costs the first second or two of a call on a page, and it
   * buys back the rest of the day — a phone left on the hands-free profile is
   * a phone whose audio is stuck in a headset codec whether or not anybody is
   * talking, and BlueZ raises that link on its own the moment the handset is
   * in range. Under this policy the desktop puts it back down.
   *
   * `presence` keeps it up for as long as the phone is on the network, which
   * makes a ringing call answerable the instant it rings; `off` leaves the
   * link entirely to the user. `address` names a handset when more than one is
   * paired and the guess would be one.
   */
  handsfree: { autoConnect: 'ring', address: null },
  /**
   * The sound a ringing phone makes here. `sound` is a path to a file, or null
   * for the desktop's own sound theme; `enabled` false leaves the ringing to
   * the notification card alone.
   */
  ringtone: { enabled: true, sound: null },
  /**
   * The notification that counts while a call is up.
   *
   * A conversation answered from the desktop has no handset in anybody's hand
   * and therefore no call timer, so the card that was ringing stays on screen
   * and counts instead. Off leaves the screen clear the moment a call is
   * picked up, the way it was before.
   */
  callTimer: { enabled: true },
  devices: [],
}

let cache = null

/**
 * The desktop pairs one phone at a time.
 *
 * `devices` stays an array — it is what the status file publishes and what the
 * panel and the app both read — but it never holds more than a single entry.
 * A config written before that rule can hold several, so the newest one is
 * kept and the rest lose their tokens here rather than quietly keeping a way
 * in that no screen would ever show.
 */
function keepOnePhone(cfg) {
  if (!Array.isArray(cfg.devices)) cfg.devices = []
  if (cfg.devices.length < 2) return false
  const [keep, ...dropped] = [...cfg.devices].sort(
    (a, b) => (b.lastSeen || b.pairedAt || 0) - (a.lastSeen || a.pairedAt || 0),
  )
  cfg.devices = [keep]
  log.warn(`only one phone can be paired — kept ${keep.name}, dropped ${dropped.map((d) => d.name).join(', ')}`)
  return true
}

export function loadConfig() {
  if (cache) return cache
  try {
    const raw = fs.readFileSync(CONFIG_FILE, 'utf8')
    cache = { ...DEFAULTS, ...JSON.parse(raw) }
    if (keepOnePhone(cache)) saveConfig(cache)
  } catch (err) {
    if (err.code !== 'ENOENT') log.warn('config unreadable, starting fresh:', err.message)
    cache = { ...DEFAULTS }
    saveConfig(cache)
  }
  return cache
}

/** The paired phone, or null when the desktop is on its own. */
export function pairedDevice() {
  return loadConfig().devices[0] || null
}

export function saveConfig(next = cache) {
  cache = next
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 })
  const tmp = `${CONFIG_FILE}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 })
  fs.renameSync(tmp, CONFIG_FILE)
  return next
}

export function updateConfig(mutator) {
  const cfg = loadConfig()
  mutator(cfg)
  return saveConfig(cfg)
}

export function newToken() {
  return crypto.randomBytes(32).toString('hex')
}

/** Constant-time token comparison — tokens are attacker-suppliable. */
export function tokenMatches(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b))
}

export function findDeviceByToken(token) {
  if (!token) return null
  return loadConfig().devices.find((d) => tokenMatches(d.token, token)) || null
}

/** A set rather than an append: pairing replaces the list, never grows it. */
export function upsertDevice(device) {
  updateConfig((cfg) => {
    const current = cfg.devices.find((d) => d.id === device.id)
    cfg.devices = [current ? { ...current, ...device } : device]
  })
  return device
}

export function removeDevice(id) {
  let removed = null
  updateConfig((cfg) => {
    const i = cfg.devices.findIndex((d) => d.id === id || d.name === id)
    if (i >= 0) removed = cfg.devices.splice(i, 1)[0]
  })
  return removed
}

export function touchDevice(id) {
  updateConfig((cfg) => {
    const d = cfg.devices.find((x) => x.id === id)
    if (d) d.lastSeen = Date.now()
  })
}

export { CONFIG_FILE, path }
