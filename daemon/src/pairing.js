import crypto from 'node:crypto'
import { run, has } from './lib/exec.js'
import { pairedDevice } from './lib/config.js'
import { log } from './lib/log.js'

const TTL_MS = 3 * 60 * 1000
const MAX_ATTEMPTS = 5

let active = null

/**
 * Mints a code, or explains why it will not.
 *
 * A desktop pairs one phone at a time, so a live code while a phone already
 * holds a token would be a second way in — one nothing on screen would ever
 * name. Dropping the phone you have is a deliberate act, and this refuses
 * rather than making it a side effect of someone else scanning a QR.
 */
export function createPairingCode() {
  const paired = pairedDevice()
  if (paired) {
    return {
      ok: false,
      device: paired,
      error: `${paired.name} is already paired — run \`omarchy-connect unpair\` first`,
    }
  }
  // 6 digits: short enough to type, and only valid for three minutes.
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0')
  active = { code, expiresAt: Date.now() + TTL_MS, attempts: 0 }
  return { ok: true, code: active.code, expiresAt: active.expiresAt }
}


export function activePairing() {
  if (active && active.expiresAt < Date.now()) active = null
  return active
}

export function consumePairingCode(candidate) {
  const pairing = activePairing()
  if (!pairing) return { ok: false, error: 'no pairing in progress — run `omarchy-connect pair`' }
  // The code outlives the moment it was minted, and a phone could have paired
  // in between. One phone at a time means the second arrival is turned away
  // here rather than overwriting the first.
  const paired = pairedDevice()
  if (paired) {
    active = null
    return { ok: false, error: `${paired.name} is already paired — unpair it on the desktop first` }
  }
  if (pairing.attempts >= MAX_ATTEMPTS) {
    active = null
    return { ok: false, error: 'too many attempts — start pairing again' }
  }
  pairing.attempts += 1
  const a = Buffer.from(String(candidate || ''))
  const b = Buffer.from(pairing.code)
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, error: 'wrong pairing code' }
  }
  active = null
  return { ok: true }
}

export function pairingUrl({ host, port, code, name, key, tls = false, pin = null }) {
  const params = new URLSearchParams({ h: host, p: String(port), c: code, n: name })
  // With TLS on, the phone has to know two things before it dials: that the
  // desktop speaks https, and which certificate is the right one. Both ride
  // the QR, so the certificate is pinned at pairing rather than trusted the
  // first time it is seen.
  if (tls) {
    params.set('s', '1')
    if (pin) params.set('t', pin)
  }
  // Carrying the identity key in the QR is what turns pairing from
  // trust-on-first-use into a verified one: the phone pins this key and will
  // refuse to talk to anything that cannot prove it holds the private half.
  if (key) params.set('k', key)
  return `omarchy-connect://pair?${params}`
}

/** Renders the pairing URL as a QR block in the terminal. */
export async function renderQr(text) {
  if (!has('qrencode')) {
    log.warn('qrencode not installed — enter the address and code manually')
    return null
  }
  const res = await run('qrencode', ['-t', 'ANSIUTF8', '-m', '1', '-o', '-', text])
  return res.ok ? res.stdout : null
}
