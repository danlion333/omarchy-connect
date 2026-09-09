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
   * The shell on this desktop the phone can type into and read back.
   *
   * The same class of thing as writing to an agent — a prompt is arbitrary
   * code execution — so it is off until `omarchy-connect terminal on` says
   * otherwise, and that command is only reachable from the desktop.
   */
  terminal: { enabled: false },
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
  /**
   * The one-time code inside a mirrored message.
   *
   * `enabled` puts a Copy button on the card of any SMS that turns out to
   * carry a code — the thing you were reaching for the handset to read.
   * `autoCopy` skips the button and puts the code on the clipboard the moment
   * it arrives, which is the faster half of the trade and the less private
   * one: it overwrites whatever was on the clipboard without being asked, so
   * it is off until somebody says otherwise.
   */
  /**
   * How loud the phone's microphone is on this desktop.
   *
   * The handset sends what its hardware heard and nothing more — no automatic
   * gain, on purpose (`lib/mic.js` says why) — and on an ordinary phone that
   * is a voice a Zoom call has to strain for. Whatever fixes that happens on
   * the way in, before the WAV and before the PipeWire source, so both hear
   * the same thing.
   *
   * `auto` is the default and means the desktop follows the level: it opens up
   * slowly for a quiet room and closes fast enough that a laugh does not clip.
   * `gain` is the constant used instead when somebody has taken the knob —
   * four is +12 dB, `1` is untouched samples, sixteen is the ceiling — and it
   * is kept while `auto` is on so that pinning and unpinning is not a number
   * anybody has to remember.
   */
  audio: { auto: true, gain: 4 },
  /**
   * The picture the phone sends when this desktop asks for its camera.
   *
   * The microphone's neighbour above, and here for the same reason: the only
   * place a media setting can live and still be true after a reboot is this
   * file. Without it the numbers were constants in `lib/video.js`, which meant
   * the panel's switch and `cam device on` — neither of which passes a
   * format — always opened 640x480 at 15 fps, and the only way to ask for
   * anything else was to type it out again on every `camera start`.
   *
   * `camera` is which lens, `width`/`height`/`fps` the shape of the stream and
   * `quality` the JPEG knob, 1-100. These are wishes, not promises: every one
   * of them is clamped to the bounds in `lib/video.js` on the way out and
   * clamped again by the handset against what its lens can actually do, so a
   * 4K number here comes back as the nearest thing the phone has. The values
   * are the constants those bounds were written around, so a config nobody has
   * touched behaves exactly as the constants did.
   */
  video: { camera: 'back', width: 640, height: 480, fps: 15, quality: 70 },
  otp: { enabled: true, autoCopy: false },
  devices: [],
}

/**
 * What this process last read, what it last saw on disk, and which file that
 * was.
 *
 * The cache used to be the whole story: first read wins, forever. That is
 * wrong in both directions here, because this config file has more than one
 * writer. The daemon holds it open for days; the CLI and the panel write it
 * from processes that live for a second. So a daemon that never looks at the
 * disk again never hears `agent spawn on`, and a daemon that writes its whole
 * remembered object back on the next pairing puts `tls: false` over the `true`
 * the CLI had just written.
 *
 * The fix is two halves of the same idea — the disk is the truth, and this
 * process only owns the fields it changed itself:
 *
 * - `stamp` says which version of the file `cache` came from, so a read after
 *   somebody else's write re-reads instead of answering from memory.
 * - `baseline` is a deep copy of that same version, untouched by anything this
 *   process has done since, so a write can tell *what this process changed*
 *   from *what it merely remembers* and put only the former onto whatever is
 *   on disk at that moment.
 */
let cache = null
let baseline = null
let stamp = null

/** Which version of the file is on disk — a rename gives each write a new inode. */
function diskStamp() {
  try {
    const s = fs.statSync(CONFIG_FILE)
    return `${s.ino}:${s.mtimeMs}:${s.size}`
  } catch {
    return null
  }
}

const clone = (value) => (value === undefined ? value : JSON.parse(JSON.stringify(value)))
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

/** A key this process removed, which a merge has to remove rather than ignore. */
const REMOVED = Symbol('removed')

/**
 * What changed between the config this process read and the one it is writing.
 *
 * Objects are walked so that two processes can each own a different field of
 * `agents` without either erasing the other's. Arrays are compared whole and
 * replaced whole: `devices` is a set of one by policy, and merging two pairing
 * lists element by element would be inventing a rule nobody asked for.
 */
function changesBetween(before, after) {
  const out = {}
  for (const key of Object.keys(after)) {
    const a = before[key]
    const b = after[key]
    if (isObject(a) && isObject(b)) {
      const inner = changesBetween(a, b)
      if (Object.keys(inner).length) out[key] = inner
    } else if (!(key in before) || !same(a, b)) {
      out[key] = clone(b)
    }
  }
  for (const key of Object.keys(before)) if (!(key in after)) out[key] = REMOVED
  return out
}

/** Those changes, onto whatever is on disk now. */
function applyChanges(target, changes) {
  for (const [key, value] of Object.entries(changes)) {
    if (value === REMOVED) delete target[key]
    else if (isObject(value) && isObject(target[key])) applyChanges(target[key], value)
    else target[key] = clone(value)
  }
  return target
}

/**
 * The cache keeps its identity across a reload.
 *
 * Several callers read the config once and hold the object — the server keeps
 * the one it started from — and handing them a replacement object would leave
 * them reading a snapshot again. So a new version is poured into the object
 * that is already out there.
 */
function adopt(target, source) {
  if (!target) return source
  for (const key of Object.keys(target)) if (!(key in source)) delete target[key]
  return Object.assign(target, source)
}

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

/**
 * Put a setting this file has never heard of into it, once.
 *
 * A default that only exists in this source file is a setting nobody can find:
 * the way anybody changes `video` or `terminal` is by opening the config in an
 * editor, and a key that is not written there is a key they would have to be
 * told about. The values are the defaults, so writing them changes no
 * behaviour whatsoever — it only makes the behaviour visible and editable.
 *
 * Done by taking the missing keys *out of the baseline* rather than by writing
 * the whole object: that is how `saveConfig` is told "this process added
 * these", so the write is a merge like any other and cannot step on a field
 * another process changed in the meantime.
 */
function seedDefaults(parsed, base) {
  let seeded = false
  for (const key of Object.keys(DEFAULTS)) {
    if (key in parsed) continue
    delete base[key]
    seeded = true
  }
  return seeded
}

/**
 * The config, from memory when the file has not moved and from disk when it
 * has.
 *
 * The `stat` on every call is the price of a switch that works on a running
 * daemon: a few microseconds against a config read, and nothing at all
 * against the syscalls the request that asked for it already made.
 */
export function loadConfig() {
  const at = diskStamp()
  if (cache && at !== null && at === stamp) return cache
  let raw = null
  try {
    raw = fs.readFileSync(CONFIG_FILE, 'utf8')
  } catch (err) {
    if (err.code !== 'ENOENT') log.warn('config unreadable, starting fresh:', err.message)
  }
  let parsed = null
  if (raw !== null) {
    try {
      parsed = JSON.parse(raw)
    } catch (err) {
      log.warn('config unreadable, starting fresh:', err.message)
    }
  }
  if (parsed && isObject(parsed)) {
    cache = adopt(cache, { ...DEFAULTS, ...parsed })
    baseline = clone(cache)
    const seeded = seedDefaults(parsed, baseline)
    stamp = at
    if (keepOnePhone(cache) || seeded) saveConfig(cache)
  } else {
    // Nothing readable behind us, so there is nothing to merge with either:
    // this is the one write that is allowed to be the whole object.
    cache = adopt(cache, { ...DEFAULTS })
    baseline = null
    saveConfig(cache)
  }
  return cache
}

/** The paired phone, or null when the desktop is on its own. */
export function pairedDevice() {
  return loadConfig().devices[0] || null
}

/**
 * Write the config, keeping every field this process did not touch.
 *
 * `next` is not written as it stands. What is written is the disk's current
 * contents with this process's own changes laid over it, which is what makes
 * `omarchy-connect tls enable` survive the daemon's next pairing write and
 * the daemon's `otp` write survive the CLI's `tls` one. A save that changed
 * nothing writes nothing, so reading the config never bumps its mtime for
 * everybody else.
 *
 * What is left is the window between reading the disk here and the rename
 * below — two writes that overlap inside those few microseconds still end
 * with one of them winning whole. Closing that needs a lock file, and a lock
 * file needs an answer for a daemon killed while holding it; the writers here
 * are a long-lived daemon and a handful of one-second commands, and this is
 * the race that was actually losing people's settings.
 */
export function saveConfig(next = cache) {
  const changes = baseline ? changesBetween(baseline, next) : null
  const onDisk = changes ? readFileConfig() : null

  if (changes && onDisk && Object.keys(changes).length === 0) {
    // Nothing of ours to write. Leaving the file alone also leaves the cache
    // pointing at the version it was read from, so the next read notices any
    // newer one.
    cache = adopt(cache, next === cache ? next : { ...next })
    return cache
  }

  const merged = changes ? applyChanges({ ...DEFAULTS, ...(onDisk || {}) }, changes) : clone(next)
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 })
  const tmp = `${CONFIG_FILE}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(merged, null, 2) + '\n', { mode: 0o600 })
  fs.renameSync(tmp, CONFIG_FILE)
  cache = adopt(cache, merged)
  baseline = clone(cache)
  stamp = diskStamp()
  return cache
}

/** The file as it stands, or null when it is absent or not readable JSON. */
function readFileConfig() {
  try {
    const parsed = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))
    return isObject(parsed) ? parsed : null
  } catch {
    return null
  }
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

/**
 * The pairing record behind an id, for the places that were handed an id
 * rather than a credential — an HTTP file ticket names the device it was
 * minted for, and the device it names may have been unpaired since.
 */
export function findDeviceById(id) {
  if (!id) return null
  return loadConfig().devices.find((d) => d.id === id) || null
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
