/**
 * When to try the desktop again, and whether trying could work at all.
 *
 * Both halves are arithmetic over an address and a description of the network,
 * which is exactly the part worth having a test for. `api/client` is the half
 * that opens a socket, and the half no test can run.
 *
 * The problem this solves: the socket used to retry every fifteen seconds
 * forever, whatever the phone was attached to. On mobile data, with a desktop
 * that lives at 192.168.1.x, that is a guaranteed failure repeated two hundred
 * and forty times an hour — all night, on battery, for a connection that
 * cannot be made until the phone is back on the same network.
 */

/**
 * How long to wait before attempt N.
 *
 * The first few steps are short because most disconnections are a blip — a
 * suspended desktop coming back, a Wi-Fi handover — and the phone should be
 * back before anyone notices. The tail is long because by two minutes in, the
 * cause is not a blip and nothing on this ladder is going to fix it.
 *
 * A long tail is only affordable because waiting it out is the unlikely path:
 * the app returning to the foreground, the network changing, a call arriving
 * and the Reconnect button all re-dial immediately and reset the ladder to its
 * first rung. See `ConnectClient.reconnectNow`.
 */
const BACKOFF = [1_000, 2_000, 4_000, 8_000, 15_000, 30_000, 60_000, 120_000]

/**
 * How far a delay is allowed to wander from its rung, either way.
 *
 * Without this every phone paired to a desktop retries on the same cadence,
 * and a router that restarts hands them all the same start time — so they
 * arrive together, fail together, and come back together. A fifth is enough to
 * break that up and too little for anyone to feel.
 */
const JITTER = 0.2

/** The rung itself, before jitter. Exposed for the test, and for reading. */
export function backoffStep(attempt: number): number {
  const index = Math.max(0, Math.min(Math.floor(attempt), BACKOFF.length - 1))
  return BACKOFF[index]
}

/** The rung with the wobble on it. `random` is injectable so a test can pin it. */
export function retryDelay(attempt: number, random: () => number = Math.random): number {
  const step = backoffStep(attempt)
  return Math.round(step * (1 - JITTER + random() * JITTER * 2))
}

/**
 * What the phone is attached to, as much of it as Android will say without
 * asking for a location permission.
 *
 * `lan` covers Wi-Fi and Ethernet — anything that could plausibly put this
 * handset on the same wire as a desktop. `vpn` is separate because a tunnel
 * carries private addresses over any transport underneath it, which is the
 * whole point of running one.
 */
export type NetworkFacts = {
  online: boolean
  lan: boolean
  vpn: boolean
}

/**
 * Whether an address is one that only means anything on the local wire.
 *
 * Deliberately narrow. Getting this wrong in one direction costs nothing —
 * the phone retries as it always did — and in the other direction it parks a
 * link that would have worked, which is the bug this module was written to
 * avoid causing. So only the ranges that are unambiguously LAN-only are
 * listed, and everything unrecognised is treated as reachable.
 *
 * The notable omission is 100.64.0.0/10. It is carrier-grade NAT space on
 * paper, but in practice it is where Tailscale puts its addresses, and a
 * Tailscale address is reachable from mobile data — parking on it would break
 * precisely the setup that needs no parking.
 */
export function isLanOnlyHost(host: string): boolean {
  const name = (host || '').trim().toLowerCase()
  if (!name) return false

  // mDNS names resolve through a responder that only answers on the local
  // link, so they are as LAN-bound as a 192.168 address.
  if (name.endsWith('.local') || name.endsWith('.local.')) return true

  const parts = name.split('.')
  if (parts.length !== 4) return false
  const octets = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : -1))
  if (octets.some((octet) => octet < 0 || octet > 255)) return false

  const [a, b] = octets
  if (a === 10) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 169 && b === 254) return true // link-local, an address that failed DHCP
  if (a === 127) return true
  return false
}

/**
 * Whether dialling this desktop could succeed on the network the phone is on.
 *
 * `null` facts mean nobody has told us — iOS, Expo Go, or a device that
 * refused the network callback — and the honest answer there is to try, which
 * is what the app did before any of this existed.
 */
export function reachable(host: string, network: NetworkFacts | null): boolean {
  if (!network) return true
  if (!network.online) return false
  if (network.vpn || network.lan) return true
  return !isLanOnlyHost(host)
}

/**
 * One address the desktop can be dialled on, as far as this module cares.
 *
 * Structurally the same as `api/storage`'s `Endpoint` and deliberately not
 * imported from it: this file is arithmetic over a description of the
 * network, and the day it needs the keychain to explain itself is the day it
 * has stopped being testable.
 */
export type Candidate = {
  host: string
  port: number
  kind: string
  source?: string
  lastGood?: number
}

/** The labels the desktop uses for an address that only exists on the wire. */
const LAN_KINDS = ['lan']

/**
 * The labels that mean "this address arrives through a tunnel".
 *
 * A tag, not a range. The address itself is no help — `100.101.102.103` is a
 * Tailscale address on most desktops and carrier-grade NAT on a few, and
 * `10.9.0.2` is a WireGuard peer on this desktop and the office printer on
 * the next one. Only the machine that owns the address knows which, and it
 * says so when it advertises it.
 */
const TUNNEL_KINDS = ['tailscale', 'wireguard', 'zerotier', 'netbird', 'nebula', 'overlay', 'dns']

export const isTunnelKind = (kind: string): boolean => TUNNEL_KINDS.includes(kind)

/**
 * Whether this particular address is worth dialling on this network.
 *
 * Two rules on top of `reachable`, and both of them err towards trying:
 *
 * A tunnelled address needs the tunnel. The phone can see whether a VPN is up
 * — that is a fact Android hands over without a permission — and dialling a
 * tailnet address with Tailscale switched off is a guaranteed timeout, over
 * and over, on battery. The desktop is the one that labelled the address, so
 * this is a rule about what the desktop said rather than about what the
 * address looks like.
 *
 * A typed-in address is always tried. Somebody added it precisely because
 * they knew something this arithmetic does not, and second-guessing them is
 * how a working link gets parked.
 */
export function reachableEndpoint(endpoint: Candidate, network: NetworkFacts | null): boolean {
  if (!network) return true
  if (!network.online) return false
  if (endpoint.source === 'manual') return true
  if (isTunnelKind(endpoint.kind)) return network.vpn === true
  return reachable(endpoint.host, network)
}

/**
 * The addresses worth trying, in the order to try them.
 *
 * The local network first, because when the phone is home it is the fastest
 * and freest road and it is always right. Then whatever last worked, because
 * a desktop that answered here five minutes ago is the best guess available.
 * Then the tunnels, in the order the desktop offered them. A MagicDNS name
 * comes last of all: it is a real endpoint, but only while the tailnet's own
 * resolver is switched on, so it is the fallback for an address rather than a
 * replacement for one.
 *
 * Unreachable candidates are dropped rather than sorted to the back — a list
 * with nothing in it is what tells the caller to park, and a list with a
 * hopeless address at the end of it would say the opposite.
 */
export function orderCandidates(
  endpoints: Candidate[],
  network: NetworkFacts | null,
  lastGoodHost?: string | null,
): Candidate[] {
  // On the wire the local address is a certainty. Off it, with a tunnel up,
  // it is only a guess — the VPN *might* be a road into that network — and a
  // guess does not go ahead of the tunnel address, which is a certainty of
  // its own. It stays in the list either way, because dropping a guess that
  // would have worked is the failure this module exists to avoid.
  const onTheWire = !network || network.lan
  const rank = (endpoint: Candidate): number => {
    if (LAN_KINDS.includes(endpoint.kind)) return onTheWire ? 0 : 4
    if (lastGoodHost && endpoint.host === lastGoodHost) return 1
    if (endpoint.kind === 'dns') return 5
    if (endpoint.source === 'manual') return 2
    return 3
  }
  return (endpoints || [])
    .filter((endpoint) => endpoint && endpoint.host && reachableEndpoint(endpoint, network))
    .map((endpoint, index) => ({ endpoint, index }))
    .sort((a, b) => rank(a.endpoint) - rank(b.endpoint) || a.index - b.index)
    .map((entry) => entry.endpoint)
}

/**
 * Why the phone is not trying, in the words the notification uses.
 *
 * `hasTunnel` changes the sentence rather than adding one. "Waiting for your
 * home network" is a lie on a desktop that can also be reached over a tunnel
 * — there are two ways back and the shade should name both, so that switching
 * the VPN on reads as a fix rather than as an unrelated act.
 */
export function parkedReason(network: NetworkFacts | null, hasTunnel = false): string {
  if (network && !network.online) return 'waiting for a network'
  if (hasTunnel) return 'waiting for your home network or vpn'
  return 'waiting for your home network'
}
