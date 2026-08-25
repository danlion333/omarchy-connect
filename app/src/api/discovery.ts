import * as Network from 'expo-network'

export type Discovered = {
  host: string
  port: number
  name: string
  version: string
  protocol: number
  pairing: boolean
  publicKey: string | null
  fingerprint: string | null
  /** Whether the daemon serves https + wss rather than http + ws. */
  tls: boolean
  /** Base64 SHA-256 of the certificate's SubjectPublicKeyInfo, when it does. */
  certPin: string | null
}

const DEFAULT_PORT = 8765
const PROBE_TIMEOUT = 600
const BATCH = 32

async function probeScheme(
  scheme: 'http' | 'https',
  host: string,
  port: number,
  timeout: number,
): Promise<Discovered | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)
  try {
    const res = await fetch(`${scheme}://${host}:${port}/api/info`, { signal: controller.signal })
    if (!res.ok) return null
    const info = await res.json()
    if (info?.app !== 'omarchy-connect') return null
    return {
      host,
      port,
      name: info.name,
      version: info.version,
      protocol: info.protocol,
      pairing: info.pairing,
      publicKey: typeof info.publicKey === 'string' ? info.publicKey : null,
      fingerprint: typeof info.fingerprint === 'string' ? info.fingerprint : null,
      tls: scheme === 'https',
      certPin: typeof info.certPin === 'string' ? info.certPin : null,
    }
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * A daemon with TLS on answers nothing at all on http, so both schemes are
 * tried side by side rather than in sequence — a sweep that probed twice per
 * host in series would take twice as long for the same answer.
 *
 * The https probe only succeeds where the platform already trusts the
 * desktop's certificate (an Android build carrying it as a trust anchor). On
 * anything else this quietly finds nothing, which is the honest outcome: an
 * unverifiable desktop is one we should not be pairing with.
 */
async function probe(host: string, port: number, timeout = PROBE_TIMEOUT): Promise<Discovered | null> {
  const [plain, secure] = await Promise.all([
    probeScheme('http', host, port, timeout),
    probeScheme('https', host, port, timeout),
  ])
  return secure ?? plain
}

export async function probeHost(host: string, port = DEFAULT_PORT) {
  // A hand-typed address deserves a longer fuse than a subnet sweep.
  return probe(host, port, 2500)
}

/**
 * There is no mDNS in Expo Go, so we sweep the phone's own /24 for the
 * discovery endpoint. 254 probes in batches of 32 finish in a couple of
 * seconds on a normal home network.
 */
export async function scanSubnet(
  onFound: (found: Discovered) => void,
  onProgress?: (done: number, total: number) => void,
  port = DEFAULT_PORT,
): Promise<Discovered[]> {
  let ip: string
  try {
    ip = await Network.getIpAddressAsync()
  } catch {
    return []
  }
  const parts = ip.split('.')
  if (parts.length !== 4) return []
  const prefix = parts.slice(0, 3).join('.')

  const hosts: string[] = []
  for (let i = 1; i < 255; i += 1) {
    const host = `${prefix}.${i}`
    if (host !== ip) hosts.push(host)
  }

  const found: Discovered[] = []
  let done = 0
  for (let i = 0; i < hosts.length; i += BATCH) {
    const slice = hosts.slice(i, i + BATCH)
    const results = await Promise.all(slice.map((h) => probe(h, port)))
    for (const result of results) {
      if (result) {
        found.push(result)
        onFound(result)
      }
    }
    done += slice.length
    onProgress?.(done, hosts.length)
  }
  return found
}

export type PairingTarget = {
  host: string
  port: number
  code: string
  name: string
  publicKey: string | null
  tls: boolean
  certPin: string | null
}

/**
 * Parses `omarchy-connect://pair?h=…&p=…&c=…&n=…&k=…&s=1&t=…` from the
 * desktop's QR code. `k` is the desktop's identity key: reading it off the
 * screen instead of off the network is what makes the pairing verified rather
 * than trusting whatever answers at that address. `s` and `t` say the desktop
 * speaks TLS and which certificate is the right one, pinned the same way and
 * for the same reason.
 */
export function parsePairingUrl(raw: string): PairingTarget | null {
  const match = raw.trim().match(/^omarchy-connect:\/\/pair\?(.+)$/i)
  if (!match) return null
  const params = new URLSearchParams(match[1])
  const host = params.get('h')
  const code = params.get('c')
  if (!host || !code) return null
  const key = params.get('k')
  return {
    host,
    port: Number(params.get('p')) || DEFAULT_PORT,
    code,
    name: params.get('n') || host,
    publicKey: key && /^[0-9a-f]{64}$/i.test(key) ? key.toLowerCase() : null,
    tls: params.get('s') === '1',
    certPin: params.get('t'),
  }
}

export { DEFAULT_PORT }

/**
 * Finds a desktop by its identity key rather than its address. Home routers
 * hand out new leases, and the phone should follow the desktop across them
 * without the user re-pairing — matching on the pinned key means we only ever
 * follow the machine we already trust.
 */
export async function findDesktopByKey(
  publicKey: string,
  port = DEFAULT_PORT,
  onProgress?: (done: number, total: number) => void,
): Promise<Discovered | null> {
  let match: Discovered | null = null
  await scanSubnet(
    (found) => {
      if (!match && found.publicKey === publicKey) match = found
    },
    onProgress,
    port,
  )
  return match
}
