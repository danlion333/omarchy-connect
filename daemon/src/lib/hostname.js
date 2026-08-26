import dns from 'node:dns/promises'

/**
 * Naming a phone that could not name itself.
 *
 * The app tells the desktop what the phone calls itself, but only a real build
 * of the Android module can ask the platform for that name; everything short of
 * one — Expo Go, iOS, an app older than the question — falls back to a label
 * that names a species rather than a device, and the panel ends up showing
 * "Android phone" to someone holding a OnePlus.
 *
 * The network knows better. A phone asks for its own name as the hostname on
 * its DHCP lease, and the router answers reverse lookups with it, so the
 * address the socket already arrived from is enough to get "OnePlus-9-Pro-5G"
 * back without the phone being asked anything.
 *
 * This is a fallback and never an override: a phone that can say its own name
 * is always the better authority, and `isGeneric` is how the caller tells the
 * two apart.
 */

/** What a phone answers with when nothing could tell it who it is. */
const GENERIC = new Set(['', 'phone', 'android', 'android phone', 'iphone', 'ipad', 'ios', 'unknown', 'unknown device'])

export function isGeneric(name) {
  return GENERIC.has(String(name ?? '').trim().toLowerCase())
}

/**
 * Hostnames that are the network's own invention rather than anyone's choice.
 * Android publishes `Android_T9UWKJ01` over mDNS and `android-<hex>` on older
 * releases; a resolver with nothing to say often echoes the address back. None
 * of them are worth putting in front of the person who owns the phone.
 */
const JUNK = [/^android[-_]/i, /^localhost$/i, /^unknown/i, /^\d+(\.\d+)*$/, /^[0-9a-f]{12,}$/i]

/** Loopback: a phone is never there, and the test suite always is. */
const LOOPBACK = /^(127\.|::1$|0\.0\.0\.0$)/

/**
 * A hostname as a person would write it — the first label only, since the
 * search domain is the router's business, and the separators DHCP forced on it
 * turned back into the spaces they stood in for.
 */
export function prettyHostname(hostname) {
  const label = String(hostname ?? '')
    .trim()
    .split('.')[0]
  if (!label || JUNK.some((pattern) => pattern.test(label))) return null
  const name = label.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim()
  return name && !isGeneric(name) ? name.slice(0, 64) : null
}

/**
 * The name the network has for whoever is on the other end of `peer`, or null
 * when it has none worth using. `reverse` is injectable so the tests can ask
 * the question without a resolver on the other side of it.
 */
export async function nameFromNetwork(peer, { reverse = dns.reverse, timeout = 1500 } = {}) {
  const ip = String(peer ?? '')
    .replace(/^::ffff:/i, '')
    .replace(/%.*$/, '')
    .trim()
  if (!ip || LOOPBACK.test(ip)) return null

  let names
  try {
    names = await withTimeout(reverse(ip), timeout)
  } catch {
    // No PTR record, no resolver, a router that keeps its leases to itself —
    // one answer covers all three: the network cannot name this phone either.
    return null
  }

  for (const name of names || []) {
    const pretty = prettyHostname(name)
    if (pretty) return pretty
  }
  return null
}

/**
 * A resolver that never answers must not hold up a hello. The timer is cleared
 * the moment the lookup settles, so it is never the thing keeping the process
 * awake — and it is deliberately not unref'd, or a quiet event loop would exit
 * before the timeout it is waiting on could fire.
 */
function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('name lookup timed out')), ms)
    Promise.resolve(promise)
      .then(resolve, reject)
      .finally(() => clearTimeout(timer))
  })
}
