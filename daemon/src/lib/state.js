import fs from 'node:fs'
import path from 'node:path'

import { XDG_STATE, XDG_CONFIG } from './paths.js'
import { loadConfig } from './config.js'
import { identity, fingerprint, SUITE } from './crypto.js'
import * as tls from './tls.js'
import { INBOX } from '../plugins/share.js'

/**
 * The desktop client's data file.
 *
 * The Omarchy shell panel is strictly a display: it watches this file and
 * draws whatever appears there, the same way the built-in agents widget
 * watches the usage records it never writes. Keeping the contract in a file
 * rather than in a socket means the panel needs no credentials, survives the
 * daemon restarting under it, and can still describe the desktop — name,
 * fingerprint, the paired phone — while the daemon is stopped.
 *
 * Written with mktemp + rename so a reader never sees a half-written file.
 * That is the same write pattern `omarchy-agent-usage-update` uses, and the
 * shell's FileView follows it across the rename.
 */
// `OMARCHY_CONNECT_STATE` moves the whole thing aside — the test suite uses it
// so a smoke run cannot overwrite the status file of the daemon you are
// actually using, and it lets a second daemon run beside the first.
export const STATE_DIR = process.env.OMARCHY_CONNECT_STATE || path.join(XDG_STATE, 'omarchy-connect')
export const STATUS_FILE = path.join(STATE_DIR, 'status.json')

export const STATE_VERSION = 1

/** How this daemon can be invoked again, so the panel never needs $PATH. */
export function execCommand() {
  const entry = path.resolve(new URL('../../bin/omarchy-connect.js', import.meta.url).pathname)
  return fs.existsSync(entry) ? [process.execPath, entry] : ['omarchy-connect']
}

/**
 * Whether `install-service` has been run. The desktop client offers to start
 * and stop the daemon, and a switch that silently does nothing because there
 * is no unit behind it is worse than no switch.
 */
export function serviceState() {
  const dir = path.join(XDG_CONFIG, 'systemd', 'user')
  const unit = path.join(dir, 'omarchy-connect.service')
  // `systemctl is-enabled` would mean a synchronous subprocess on every
  // republish. The unit is `WantedBy=graphical-session.target`, and enabling it
  // is precisely the act of creating that symlink, so checking for the link
  // answers the same question for the cost of a stat.
  const wants = path.join(dir, 'graphical-session.target.wants', 'omarchy-connect.service')
  return {
    unit: 'omarchy-connect.service',
    installed: fs.existsSync(unit),
    enabled: fs.existsSync(wants),
    path: unit,
  }
}

/** What the panel needs to say about TLS, with or without a running daemon. */
function tlsSummary(cfg) {
  if (cfg.tls !== true) return { enabled: false, pin: null, fingerprint: null, notAfter: null }
  const cert = tls.info()
  return {
    enabled: true,
    pin: cert?.pin ?? null,
    fingerprint: cert?.fingerprint ?? null,
    notAfter: cert?.notAfter ?? null,
  }
}

const publicDevice = (d) => ({
  id: d.id,
  name: d.name,
  platform: d.platform || 'unknown',
  model: d.model || '',
  pairedAt: d.pairedAt || null,
  lastSeen: d.lastSeen || null,
  online: false,
  address: null,
  battery: null,
})

/**
 * Everything that is knowable without a running daemon. `start()` layers the
 * live half — who is connected, what moved — on top of this.
 */
export function baseSnapshot({ version = null, port = null } = {}) {
  const cfg = loadConfig()
  const key = identity().publicKey.toString('hex')
  return {
    v: STATE_VERSION,
    at: Date.now(),
    running: false,
    pid: null,
    version,
    name: cfg.deviceName,
    host: null,
    port: port || cfg.port,
    publicKey: key,
    fingerprint: fingerprint(key),
    suite: SUITE,
    encryption: cfg.requireEncryption !== false ? 'required' : 'optional',
    scheme: cfg.tls === true ? 'https' : 'http',
    tls: tlsSummary(cfg),
    inbox: INBOX,
    exec: execCommand(),
    service: serviceState(),
    pairing: null,
    firewall: { blocked: false, tool: null, command: null },
    devices: cfg.devices.map(publicDevice),
    transfers: [],
    counters: { filesIn: 0, filesOut: 0, notifications: 0 },
    phone: {
      messages: 0,
      calls: 0,
      missed: 0,
      sent: 0,
      answered: 0,
      rejected: 0,
      notifications: 0,
      recent: [],
      // The live call, from whichever road saw it. Nothing is live while the
      // daemon is down, and the panel's remote control stays off the screen.
      call: null,
      // Bluetooth is the daemon's to watch, so with the daemon down the panel
      // shows the profile as unknown rather than guessing it is absent.
      bluetooth: { available: false, connected: false, device: null, audio: null, call: null, calls: 0 },
      // Same for the low-energy link an iPhone mirrors its notifications over.
      ios: { available: false, connected: false, subscribed: false, device: null, paired: false, pairing: null },
    },
    // Coding agents are discovered by a running daemon and nothing else, so
    // with it stopped the panel shows the switch rather than a stale list.
    agents: { enabled: cfg.agents?.enabled === true, adapters: [], running: 0, waiting: 0, sessions: [] },
  }
}

export function publish(snapshot) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 })
    const tmp = path.join(STATE_DIR, `.status.${process.pid}.tmp`)
    fs.writeFileSync(tmp, JSON.stringify(snapshot, null, 2) + '\n', { mode: 0o600 })
    fs.renameSync(tmp, STATUS_FILE)
  } catch {
    // A desktop that cannot write its status file is still a working daemon;
    // the panel degrades to "not running" rather than the phone losing its
    // connection over a full disk.
  }
  return snapshot
}

export function read() {
  try {
    const parsed = JSON.parse(fs.readFileSync(STATUS_FILE, 'utf8'))
    return parsed && parsed.v === STATE_VERSION ? parsed : null
  } catch {
    return null
  }
}

/** Mark the daemon down without losing the desktop's identity from the panel. */
export function clear() {
  const last = read()
  const snapshot = last ? { ...last } : baseSnapshot()
  snapshot.at = Date.now()
  snapshot.running = false
  snapshot.pid = null
  snapshot.pairing = null
  snapshot.devices = (snapshot.devices || []).map((d) => ({ ...d, online: false, address: null }))
  // Agent sessions are the daemon's live view of other processes: with it
  // stopped there is nothing watching them, so the list is not merely stale,
  // it is unknown.
  snapshot.agents = { ...(snapshot.agents || {}), running: 0, waiting: 0, sessions: [] }
  return publish(snapshot)
}
