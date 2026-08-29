import os from 'node:os'
import http from 'node:http'

import { OVERLAY_INTERFACE } from './sys.js'
import { has, run } from './exec.js'
import { log } from './log.js'

/**
 * The addresses this desktop can be reached by from outside its own subnet.
 *
 * Not a tunnel of our own: the desktop asks whatever overlay the user already
 * runs — Tailscale, Headscale, WireGuard, ZeroTier, NetBird — what address it
 * was handed, and hands that on to the phone. Every one of them comes down to
 * the same thing, a stable unicast IPv4 over a tun device, so the generic path
 * is interface enumeration and the Tailscale path only exists because it can
 * also answer two questions enumeration cannot: what the MagicDNS name is, and
 * when the node key expires.
 *
 * Nothing here decides whether remote access is *allowed* — that is the
 * config gate in the server. This module only ever reports what is there.
 *
 * IPv4 only, deliberately, the same way `tls.subjectNames` and discovery are:
 * a `fd7a:` ULA would be a second address family to carry through the QR, the
 * status file and the phone's candidate list for no reachability that the
 * 100.x address does not already give.
 */

const TAILSCALED_SOCKET = process.env.OMARCHY_CONNECT_TAILSCALE_SOCKET || '/var/run/tailscale/tailscaled.sock'
const LOCALAPI_TIMEOUT_MS = 1500

/**
 * Short, because two callers want different things from it: the 30-second
 * environment tick wants a fresh answer, and socket classification wants an
 * answer *now*, once per connection, without a syscall storm.
 */
const CACHE_MS = 5_000

const KINDS = [
  [/^(tailscale|ts)/, 'tailscale'],
  [/^(wg|nordlynx)/, 'wireguard'],
  [/^zt/, 'zerotier'],
  [/^(netbird|nb-)/, 'netbird'],
  [/^nebula/, 'nebula'],
]

/** What kind of overlay put an interface up, as far as its name admits. */
export function kindFor(iface) {
  const name = String(iface || '')
  for (const [pattern, kind] of KINDS) if (pattern.test(name)) return kind
  return 'overlay'
}

const isIPv4 = (value) => typeof value === 'string' && /^\d{1,3}(\.\d{1,3}){3}$/.test(value)

/** Carrier-grade NAT space on paper, Tailscale's address pool in practice. */
export function isCarrierGrade(address) {
  if (!isIPv4(address)) return false
  const [a, b] = address.split('.').map(Number)
  return a === 100 && b >= 64 && b <= 127
}

/** `::ffff:100.64.0.1` and `[::1]` both arrive here; only a bare IPv4 leaves. */
export function normaliseAddress(value) {
  if (typeof value !== 'string') return null
  const bare = value.replace(/^::ffff:/i, '').replace(/^\[|\]$/g, '')
  return isIPv4(bare) ? bare : null
}

/* ── Tailscale, through its own local API ───────────────────────────────── */

function localApiRequest(path) {
  return new Promise((resolve) => {
    const req = http.request(
      {
        socketPath: TAILSCALED_SOCKET,
        path,
        method: 'GET',
        // The daemon rejects a request that does not name the socket, as a
        // guard against a browser being talked into making one.
        headers: { Host: 'local-tailscaled.sock' },
        timeout: LOCALAPI_TIMEOUT_MS,
      },
      (res) => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (chunk) => {
          body += chunk
        })
        res.on('end', () => resolve(res.statusCode === 200 ? body : null))
      },
    )
    // Every failure here is the same answer — "no Tailscale to ask" — and
    // none of them is worth a line in the log on a desktop that runs none.
    req.on('error', () => resolve(null))
    req.on('timeout', () => {
      req.destroy()
      resolve(null)
    })
    req.end()
  })
}

/**
 * The three things worth having out of a `tailscale status` payload. Pure, so
 * the test can hand it a fixture rather than a tailnet.
 */
export function fromStatus(status) {
  const self = status && typeof status === 'object' ? status.Self || {} : {}
  const addresses = (Array.isArray(self.TailscaleIPs) ? self.TailscaleIPs : []).filter(isIPv4)
  const dnsName = typeof self.DNSName === 'string' && self.DNSName ? self.DNSName.replace(/\.$/, '') : null
  const expiry = Date.parse(self.KeyExpiry)
  return {
    addresses,
    dnsName,
    // A node key that has expired takes the peer off the tailnet without
    // taking the interface down, so the phone sees a plausible address that
    // silently answers nothing. Worth a warning two weeks out.
    keyExpiry: Number.isFinite(expiry) ? expiry : null,
  }
}

async function tailscaleStatus() {
  const body = await localApiRequest('/localapi/v0/status')
  if (body) {
    try {
      return fromStatus(JSON.parse(body))
    } catch {
      log.debug('tailscaled answered with something that is not JSON')
    }
  }
  // The socket is root-owned and group-restricted, so a daemon running as a
  // plain user gets EACCES rather than an answer. The CLI is setuid-free and
  // asks the same question through the same socket with the right credentials.
  if (!has('tailscale')) return null
  const result = await run('tailscale', ['status', '--json'], { timeout: 3000 })
  if (!result.ok) return null
  try {
    return fromStatus(JSON.parse(result.stdout))
  } catch {
    return null
  }
}

/* ── Everything else, through the interface list ────────────────────────── */

/**
 * Overlay addresses as the kernel has them. This is the whole of the generic
 * path and the last resort of the Tailscale one.
 *
 * A carrier-grade address on an interface with an ordinary name is included
 * too: some overlays name their device after the profile rather than the
 * product. The cost of being wrong is one candidate the phone probes once and
 * never reaches, which is cheaper than missing the address that works.
 */
export function fromInterfaces(interfaces = os.networkInterfaces()) {
  const found = []
  for (const [iface, addresses] of Object.entries(interfaces || {})) {
    const tunnelled = OVERLAY_INTERFACE.test(iface)
    for (const entry of addresses || []) {
      if (entry.internal || entry.family !== 'IPv4') continue
      if (!tunnelled && !isCarrierGrade(entry.address)) continue
      found.push({ address: entry.address, iface, kind: tunnelled ? kindFor(iface) : 'overlay' })
    }
  }
  return found
}

/* ── What the rest of the daemon asks for ───────────────────────────────── */

let cache = null

/**
 * Which overlay to offer the phone first when a desktop is on more than one.
 *
 * Tailscale leads because it is the one that says out loud whether it is
 * working — a name, an expiry, a daemon to ask — and because it is the one
 * that traverses NAT without a port forward. The rest sort by address so the
 * order is at least stable between ticks; a candidate list that reshuffles is
 * a phone that re-dials for no reason.
 */
const ORDER = ['tailscale', 'wireguard', 'netbird', 'zerotier', 'nebula', 'overlay']
const rank = (a, b) => {
  const byKind = ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind)
  return byKind || a.address.localeCompare(b.address)
}

/**
 * Every overlay address this desktop currently has, the MagicDNS name if
 * there is one, and when the node key runs out.
 */
export async function detect({ force = false } = {}) {
  if (!force && cache && Date.now() - cache.at < CACHE_MS) return cache

  const interfaces = fromInterfaces()
  const byAddress = new Map(interfaces.map((entry) => [entry.address, entry]))

  const status = await tailscaleStatus()
  if (status) {
    for (const address of status.addresses) {
      const known = byAddress.get(address)
      // Tailscale is the authority on which of these addresses are its own,
      // so its verdict overrides a kind guessed from an interface name.
      byAddress.set(address, { address, iface: known?.iface ?? null, kind: 'tailscale' })
    }
  }

  cache = {
    at: Date.now(),
    addresses: [...byAddress.values()].sort(rank),
    dnsName: status?.dnsName ?? null,
    keyExpiry: status?.keyExpiry ?? null,
  }
  return cache
}

/** The last answer without asking again — for callers on a hot path. */
export function known() {
  return cache || { at: 0, addresses: [], dnsName: null, keyExpiry: null }
}

export function forget() {
  cache = null
}

/**
 * How a socket got here, decided by the address it arrived *on*.
 *
 * The kernel already routed the connection, so the local end of it names the
 * interface it came in through — no prefix matching, no route parsing, and no
 * guessing from the peer's address, which is the mistake that has broken
 * every project that tried to tell friend from stranger by IP range.
 */
export function classify(localAddress, snapshot = known()) {
  const address = normaliseAddress(localAddress)
  if (!address) return { via: 'lan', kind: null }
  const hit = (snapshot?.addresses || []).find((entry) => entry.address === address)
  return hit ? { via: 'remote', kind: hit.kind } : { via: 'lan', kind: null }
}

/**
 * The overlay half of what the phone is told it can dial, in the order it
 * should try: addresses first because they are ground truth, the MagicDNS
 * name last because it only resolves while the tailnet's DNS is switched on.
 */
export function toEndpoints(snapshot, port) {
  const list = (snapshot?.addresses || []).map((entry) => ({ host: entry.address, port, kind: entry.kind }))
  if (snapshot?.dnsName) list.push({ host: snapshot.dnsName, port, kind: 'dns' })
  return list
}

/** A one-line summary for the status file, the panel and the CLI. */
export function summary(snapshot = known()) {
  const first = snapshot?.addresses?.[0] || null
  return {
    kind: first?.kind ?? null,
    address: first?.address ?? null,
    iface: first?.iface ?? null,
    dnsName: snapshot?.dnsName ?? null,
    keyExpiresAt: snapshot?.keyExpiry ?? null,
  }
}
