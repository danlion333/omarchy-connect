/**
 * The addresses a desktop can be dialled on, and what may be done to the list.
 *
 * Pure, and here rather than beside the keychain for the reason `lib/retry`
 * gives for its own half: this is arithmetic over a saved record, which is
 * exactly the part worth having a test for, and a test cannot load the native
 * module `api/storage` opens with.
 */

/**
 * One address this desktop can be dialled on.
 *
 * `kind` is what the desktop called it, not what the address looks like —
 * `lan` for the wire it lives on, an overlay name for a tunnel, `dns` for a
 * MagicDNS name, `manual` for one typed in here. The distinction matters
 * because the phone decides what to try from the *label*, never from the
 * address range: a 100.x address is a Tailscale address on most desktops and
 * carrier-grade NAT on some, and no amount of squinting at the octets tells
 * the two apart.
 *
 * `source` decides who may overwrite it. What the desktop advertises is the
 * desktop's business and is replaced wholesale on every hello; an address
 * somebody typed in is theirs and outlives every one of those.
 */
export type EndpointKind = 'lan' | 'tailscale' | 'wireguard' | 'zerotier' | 'netbird' | 'nebula' | 'overlay' | 'dns' | 'manual'

export type Endpoint = {
  host: string
  port: number
  /**
   * Widened on purpose. These are the kinds known today, but the label comes
   * off the wire from a desktop that may be newer than this app, and a phone
   * that refuses to store an overlay it has not heard of is a phone that
   * cannot be reached over it. Unknown kinds are simply tried.
   */
  kind: EndpointKind | (string & {})
  source: 'pairing' | 'hello' | 'manual'
  /** When this address last carried a working connection. */
  lastGood?: number
}

/**
 * How many addresses are worth keeping.
 *
 * Not arbitrary: this whole record goes into the keychain as one string, and
 * iOS has historically refused values much over 2 KB. A desktop with more
 * than a handful of ways in is not a desktop this list can help with anyway.
 */
export const MAX_ENDPOINTS = 8

/** Whether an address is one only this network can resolve or route. */
const lanOnly = (host: string): boolean => {
  const name = (host || '').trim().toLowerCase()
  if (!name) return false
  if (name.endsWith('.local') || name.endsWith('.local.')) return true
  const parts = name.split('.')
  if (parts.length !== 4) return false
  const octets = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : -1))
  if (octets.some((octet) => octet < 0 || octet > 255)) return false
  const [a, b] = octets
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a === 169 || a === 127
}

/**
 * A desktop paired before any of this existed, described in the new terms.
 *
 * The one address it has is the one it was paired on, and whether that is a
 * LAN address or something that travels is decided here rather than guessed
 * later — this is the only moment the answer is cheap and nothing else has an
 * opinion. A desktop paired at `100.x` by somebody who already had a tunnel
 * comes through as an overlay address and keeps working from anywhere.
 */
export function migrateEndpoints(desktop: { host?: string; port: number; endpoints?: Endpoint[] }): Endpoint[] {
  if (Array.isArray(desktop.endpoints) && desktop.endpoints.length) return desktop.endpoints
  if (!desktop.host) return []
  return [
    {
      host: desktop.host,
      port: desktop.port,
      kind: lanOnly(desktop.host) ? 'lan' : 'overlay',
      source: 'pairing',
    },
  ]
}

/**
 * The desktop's list, laid over whatever is already here.
 *
 * The desktop is the authority on its own addresses, so everything it said
 * last time goes and everything it says now stands — an address it has
 * stopped advertising is one it has stopped answering on, and keeping it
 * would be keeping a candidate that can only ever waste a probe.
 *
 * A typed-in address survives all of that. Somebody added it because the
 * desktop could not describe itself well enough, and a hello is not evidence
 * that they were wrong.
 */
export function mergeEndpoints(current: Endpoint[] | undefined, advertised: Endpoint[]): Endpoint[] {
  const manual = (current || []).filter((entry) => entry.source === 'manual')
  const lastGood = new Map((current || []).map((entry) => [`${entry.host}:${entry.port}`, entry.lastGood]))
  const fresh: Endpoint[] = []
  const seen = new Set<string>()
  for (const entry of advertised) {
    const key = `${entry.host}:${entry.port}`
    if (!entry.host || seen.has(key)) continue
    seen.add(key)
    // What worked before is worth remembering across a re-advertisement:
    // it is the only evidence the phone has for ordering two candidates it
    // has never been told apart.
    const known = lastGood.get(key)
    fresh.push(known ? { ...entry, source: 'hello', lastGood: known } : { ...entry, source: 'hello' })
  }
  for (const entry of manual) {
    const key = `${entry.host}:${entry.port}`
    if (seen.has(key)) continue
    seen.add(key)
    fresh.push(entry)
  }
  return fresh.slice(0, MAX_ENDPOINTS)
}
