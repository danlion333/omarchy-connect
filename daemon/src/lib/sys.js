import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { run, has } from './exec.js'

const readText = (p) => {
  try {
    return fs.readFileSync(p, 'utf8').trim()
  } catch {
    return null
  }
}
const readInt = (p) => {
  const v = readText(p)
  const n = v === null ? NaN : Number.parseInt(v, 10)
  return Number.isFinite(n) ? n : null
}

/* ── CPU ─────────────────────────────────────────────────────────────── */

let lastCpu = null

function cpuSample() {
  const line = (readText('/proc/stat') || '').split('\n')[0]
  const parts = line.split(/\s+/).slice(1).map(Number)
  if (parts.length < 4) return null
  const idle = parts[3] + (parts[4] || 0)
  const total = parts.reduce((a, b) => a + b, 0)
  return { idle, total }
}

export function cpuUsage() {
  const now = cpuSample()
  if (!now) return null
  const prev = lastCpu
  lastCpu = now
  if (!prev || now.total === prev.total) return null
  const usage = 1 - (now.idle - prev.idle) / (now.total - prev.total)
  return Math.max(0, Math.min(1, usage))
}

export function cpuTemp() {
  try {
    for (const zone of fs.readdirSync('/sys/class/thermal')) {
      if (!zone.startsWith('thermal_zone')) continue
      const type = readText(`/sys/class/thermal/${zone}/type`) || ''
      if (/x86_pkg_temp|k10temp|cpu|coretemp|acpitz/i.test(type)) {
        const milli = readInt(`/sys/class/thermal/${zone}/temp`)
        if (milli) return Math.round(milli / 1000)
      }
    }
  } catch {
    /* no thermal zones exposed */
  }
  return null
}

export function cpuModel() {
  const info = readText('/proc/cpuinfo') || ''
  const m = info.match(/^model name\s*:\s*(.+)$/m)
  return m ? m[1].replace(/\s+/g, ' ').trim() : os.cpus()[0]?.model || 'CPU'
}

/* ── Memory ──────────────────────────────────────────────────────────── */

export function memory() {
  const info = readText('/proc/meminfo') || ''
  const kb = (key) => {
    const m = info.match(new RegExp(`^${key}:\\s+(\\d+) kB`, 'm'))
    return m ? Number(m[1]) * 1024 : 0
  }
  const total = kb('MemTotal')
  const available = kb('MemAvailable')
  const swapTotal = kb('SwapTotal')
  const swapFree = kb('SwapFree')
  return {
    total,
    available,
    used: total - available,
    swapTotal,
    swapUsed: swapTotal - swapFree,
  }
}

/* ── Disk ────────────────────────────────────────────────────────────── */

export async function disk(mount = '/') {
  const res = await run('df', ['-B1', '--output=size,used,avail,target', mount])
  if (!res.ok) return null
  const row = res.stdout.split('\n')[1]?.trim().split(/\s+/)
  if (!row || row.length < 4) return null
  return { total: Number(row[0]), used: Number(row[1]), free: Number(row[2]), mount: row[3] }
}

/* ── Battery ─────────────────────────────────────────────────────────── */

export function battery() {
  const base = '/sys/class/power_supply'
  let entries = []
  try {
    entries = fs.readdirSync(base)
  } catch {
    return null
  }
  const bat = entries.find((e) => /^BAT/i.test(e) || readText(path.join(base, e, 'type')) === 'Battery')
  if (!bat) return null
  const dir = path.join(base, bat)
  const capacity = readInt(path.join(dir, 'capacity'))
  if (capacity === null) return null
  const status = readText(path.join(dir, 'status')) || 'Unknown'
  const energyNow = readInt(path.join(dir, 'energy_now')) ?? readInt(path.join(dir, 'charge_now'))
  const powerNow = readInt(path.join(dir, 'power_now')) ?? readInt(path.join(dir, 'current_now'))
  let secondsLeft = null
  if (energyNow && powerNow && powerNow > 0 && status === 'Discharging') {
    secondsLeft = Math.round((energyNow / powerNow) * 3600)
  }
  return {
    percent: capacity,
    status,
    charging: status === 'Charging' || status === 'Full',
    secondsLeft,
    watts: powerNow ? Math.round((powerNow / 1e6) * 10) / 10 : null,
  }
}

/* ── Network ─────────────────────────────────────────────────────────── */

const netBase = '/sys/class/net'
let lastNet = null

/**
 * Interfaces an overlay network puts up: a tunnel that carries a stable
 * unicast address over whatever the machine is actually attached to.
 *
 * Kept here rather than in `overlay.js` because two questions want the same
 * answer — "is this the wire the desktop lives on?" (it is not, so
 * `primaryInterface` has to skip it) and "which of my addresses travel?".
 */
export const OVERLAY_INTERFACE = /^(tailscale|ts|wg|zt|netbird|nb-|nebula|nordlynx|tun)/

function ifaceType(name) {
  if (fs.existsSync(path.join(netBase, name, 'wireless'))) return 'wifi'
  if (name.startsWith('lo')) return 'loopback'
  // Before the `virtual` branch, which swallowed `tun` and `wg` whole — and
  // after `wireless`, because nothing wearing a tunnel name has a radio.
  if (OVERLAY_INTERFACE.test(name)) return 'overlay'
  if (/^(docker|br-|veth|virbr|tap)/.test(name)) return 'virtual'
  return 'ethernet'
}

export function primaryInterface() {
  let candidates = []
  try {
    candidates = fs.readdirSync(netBase)
  } catch {
    return null
  }
  const usable = candidates
    // An overlay is never the primary link: it rides on top of one. Letting
    // `tailscale0` win here would put a 100.x address in the QR, the status
    // file and the certificate's idea of "this desktop" — all of which mean
    // the LAN address and nothing else.
    .filter((n) => !['loopback', 'virtual', 'overlay'].includes(ifaceType(n)))
    .filter((n) => readText(path.join(netBase, n, 'operstate')) === 'up')
  // Prefer a wired link when both are up — that is what actually carries traffic.
  return usable.find((n) => ifaceType(n) === 'ethernet') || usable[0] || null
}

/**
 * `192.168.1.42` + `255.255.255.0` → `192.168.1.255`.
 *
 * The directed broadcast address of the subnet the desktop is on, which is
 * where a magic packet has to be addressed: the machine it is meant for is
 * asleep, so it holds no ARP entry and nothing can be unicast to it.
 */
export function broadcastFor(ip, netmask) {
  if (typeof ip !== 'string' || typeof netmask !== 'string') return null
  const a = ip.split('.').map(Number)
  const m = netmask.split('.').map(Number)
  if (a.length !== 4 || m.length !== 4) return null
  if ([...a, ...m].some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null
  return a.map((octet, i) => octet | (~m[i] & 255)).join('.')
}

function addressesFor(name) {
  const nets = os.networkInterfaces()[name] || []
  const v4 = nets.find((n) => n.family === 'IPv4' && !n.internal)
  const v6 = nets.find((n) => n.family === 'IPv6' && !n.internal && !n.address.startsWith('fe80'))
  return {
    ip: v4?.address || null,
    mac: v4?.mac || nets[0]?.mac || null,
    netmask: v4?.netmask || null,
    broadcast: broadcastFor(v4?.address, v4?.netmask),
    ipv6: v6?.address || null,
  }
}

async function gatewayFor(name) {
  const res = await run('ip', ['-4', 'route', 'show', 'default'])
  if (!res.ok) return null
  for (const line of res.stdout.split('\n')) {
    const m = line.match(/default via (\S+) dev (\S+)/)
    if (m && (!name || m[2] === name)) return m[1]
  }
  return null
}

export async function dnsServers() {
  if (has('resolvectl')) {
    const res = await run('resolvectl', ['dns'])
    if (res.ok) {
      const servers = res.stdout
        .split('\n')
        .flatMap((l) => l.split(':').slice(1).join(':').trim().split(/\s+/))
        .filter((s) => /^[0-9a-f.:]+$/i.test(s) && s.length > 2)
      if (servers.length) return [...new Set(servers)]
    }
  }
  const conf = readText('/etc/resolv.conf') || ''
  return [...new Set(conf.split('\n').filter((l) => l.startsWith('nameserver')).map((l) => l.split(/\s+/)[1]))]
}

/** Well-known resolvers, so the app can show "Cloudflare" instead of an IP. */
const DNS_NAMES = {
  '1.1.1.1': 'Cloudflare',
  '1.0.0.1': 'Cloudflare',
  '8.8.8.8': 'Google',
  '8.8.4.4': 'Google',
  '9.9.9.9': 'Quad9',
  '208.67.222.222': 'OpenDNS',
  '94.140.14.14': 'AdGuard',
}

export function dnsProvider(servers = []) {
  for (const s of servers) if (DNS_NAMES[s]) return DNS_NAMES[s]
  if (servers.some((s) => s.startsWith('127.') || s === '::1')) return 'Local'
  if (servers.some((s) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(s))) return 'DHCP'
  return servers.length ? 'Custom' : 'None'
}

async function wifiDetails(name) {
  if (!has('iw')) return {}
  const res = await run('iw', ['dev', name, 'link'])
  if (!res.ok) return {}
  const ssid = res.stdout.match(/SSID:\s*(.+)/)?.[1]?.trim()
  const signal = res.stdout.match(/signal:\s*(-?\d+)/)?.[1]
  const bitrate = res.stdout.match(/tx bitrate:\s*([\d.]+)\s*MBit\/s/)?.[1]
  return {
    ssid: ssid || null,
    signalDbm: signal ? Number(signal) : null,
    // -30 dBm is a full bar, -90 is unusable; clamp to a 0..1 quality figure.
    signalQuality: signal ? Math.max(0, Math.min(1, (Number(signal) + 90) / 60)) : null,
    linkSpeedMbit: bitrate ? Math.round(Number(bitrate)) : null,
  }
}

export async function network() {
  const name = primaryInterface()
  if (!name) return { interface: null, type: 'offline', up: false }
  const type = ifaceType(name)
  const rx = readInt(path.join(netBase, name, 'statistics', 'rx_bytes')) ?? 0
  const tx = readInt(path.join(netBase, name, 'statistics', 'tx_bytes')) ?? 0
  const now = Date.now()

  let rxRate = 0
  let txRate = 0
  if (lastNet && lastNet.name === name && now > lastNet.at) {
    const dt = (now - lastNet.at) / 1000
    rxRate = Math.max(0, (rx - lastNet.rx) / dt)
    txRate = Math.max(0, (tx - lastNet.tx) / dt)
  }
  lastNet = { name, rx, tx, at: now }

  const [gateway, dns, wifi] = await Promise.all([
    gatewayFor(name),
    dnsServers(),
    type === 'wifi' ? wifiDetails(name) : Promise.resolve({}),
  ])
  const linkSpeed = type === 'ethernet' ? readInt(path.join(netBase, name, 'speed')) : wifi.linkSpeedMbit

  return {
    interface: name,
    type,
    up: readText(path.join(netBase, name, 'operstate')) === 'up',
    ...addressesFor(name),
    gateway,
    dns,
    dnsProvider: dnsProvider(dns),
    linkSpeedMbit: linkSpeed && linkSpeed > 0 ? linkSpeed : null,
    rxRate,
    txRate,
    rxTotal: rx,
    txTotal: tx,
    ...wifi,
  }
}

/* ── Latency ─────────────────────────────────────────────────────────── */

let latency = { pingMs: null, packetLoss: null, target: null, at: 0 }
let pinging = false

/** Ping is slow relative to the stats tick, so it refreshes on its own cadence. */
export async function refreshLatency(target) {
  if (pinging) return latency
  pinging = true
  try {
    const host = target || (await gatewayFor(null)) || '1.1.1.1'
    const res = await run('ping', ['-c', '3', '-W', '1', '-q', host], { timeout: 6000 })
    const out = `${res.stdout}\n${res.stderr}`
    const loss = out.match(/(\d+(?:\.\d+)?)% packet loss/)
    const rtt = out.match(/=\s*[\d.]+\/([\d.]+)\//)
    latency = {
      target: host,
      pingMs: rtt ? Math.round(Number(rtt[1]) * 10) / 10 : null,
      packetLoss: loss ? Number(loss[1]) : null,
      at: Date.now(),
    }
  } finally {
    pinging = false
  }
  return latency
}

export function lastLatency() {
  return latency
}

/* ── Host ────────────────────────────────────────────────────────────── */

export function host() {
  const osRelease = readText('/etc/os-release') || ''
  const pretty = osRelease.match(/^PRETTY_NAME="?([^"\n]+)"?/m)?.[1]
  return {
    hostname: os.hostname(),
    os: pretty || 'Linux',
    kernel: os.release(),
    uptime: Math.round(os.uptime()),
    arch: os.arch(),
    cpuModel: cpuModel(),
    cores: os.cpus().length,
    loadavg: os.loadavg().map((n) => Math.round(n * 100) / 100),
  }
}
