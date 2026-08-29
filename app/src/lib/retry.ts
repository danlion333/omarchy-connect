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

/** Why the phone is not trying, in the words the notification uses. */
export function parkedReason(network: NetworkFacts | null): string {
  if (network && !network.online) return 'waiting for a network'
  return 'waiting for your home network'
}
