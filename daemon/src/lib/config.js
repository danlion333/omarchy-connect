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
  devices: [],
}

let cache = null

export function loadConfig() {
  if (cache) return cache
  try {
    const raw = fs.readFileSync(CONFIG_FILE, 'utf8')
    cache = { ...DEFAULTS, ...JSON.parse(raw) }
  } catch (err) {
    if (err.code !== 'ENOENT') log.warn('config unreadable, starting fresh:', err.message)
    cache = { ...DEFAULTS }
    saveConfig(cache)
  }
  return cache
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

export function upsertDevice(device) {
  updateConfig((cfg) => {
    const i = cfg.devices.findIndex((d) => d.id === device.id)
    if (i >= 0) cfg.devices[i] = { ...cfg.devices[i], ...device }
    else cfg.devices.push(device)
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
