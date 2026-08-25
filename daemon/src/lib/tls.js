import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'

import { CONFIG_DIR } from './paths.js'
import { loadConfig } from './config.js'
import { log } from './log.js'

/**
 * TLS for the transport the control channel cannot reach.
 *
 * The WebSocket is already end-to-end encrypted under a key the phone pinned
 * at pairing time, which is a stronger guarantee than TLS gives — but file
 * bodies travel over plain HTTP so that `expo-file-system` can stream them
 * natively, and those bytes were the one thing on the wire in the clear.
 *
 * Turning TLS on wraps the whole listener, uploads and downloads included.
 * The certificate is self-signed and minted here, so there is no CA to trust
 * and nothing to renew by hand; what makes it trustworthy is that the phone
 * pins the public key. The pin is a base64 SHA-256 of the SubjectPublicKeyInfo
 * — the same shape as an HPKP / OkHttp pin — and it travels in the pairing QR
 * next to the identity key, so it is verified at pairing rather than on first
 * use.
 */

export const TLS_DIR = path.join(CONFIG_DIR, 'tls')
export const KEY_FILE = path.join(TLS_DIR, 'key.pem')
export const CERT_FILE = path.join(TLS_DIR, 'cert.pem')

const DAYS = 825
const RENEW_WITHIN_MS = 30 * 24 * 60 * 60 * 1000

/** Is TLS switched on in the config? Off unless asked for. */
export function enabled() {
  return loadConfig().tls === true
}

/** The base64 SHA-256 SubjectPublicKeyInfo pin, the way a phone pins it. */
export function pinOf(certPem) {
  const cert = new crypto.X509Certificate(certPem)
  const spki = cert.publicKey.export({ type: 'spki', format: 'der' })
  return crypto.createHash('sha256').update(spki).digest('base64')
}

/**
 * Every name and address this desktop can be reached by. A certificate that
 * does not cover the current DHCP lease fails verification on the phone with
 * an error nobody can act on, so a changed address is a reason to re-mint.
 */
export function subjectNames() {
  const dns = new Set(['localhost', os.hostname()])
  const ip = new Set(['127.0.0.1'])
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const address of addresses || []) {
      // IPv4 only, deliberately. Discovery, pairing and the status file all
      // speak IPv4, and openssl re-writes IPv6 literals into their expanded
      // uppercase form — which would make "does this certificate still cover
      // us?" compare false every time and re-mint on every start.
      if (address.internal || address.family !== 'IPv4') continue
      ip.add(address.address)
    }
  }
  return {
    dns: [...dns].filter(Boolean).sort(),
    ip: [...ip].sort(),
  }
}

const sanString = ({ dns, ip }) => [...dns.map((d) => `DNS:${d}`), ...ip.map((a) => `IP:${a}`)].join(',')

function readCertificate() {
  const key = fs.readFileSync(KEY_FILE, 'utf8')
  const pem = fs.readFileSync(CERT_FILE, 'utf8')
  const cert = new crypto.X509Certificate(pem)
  return {
    key,
    cert: pem,
    pin: pinOf(pem),
    fingerprint: cert.fingerprint256.replace(/:/g, '').match(/.{4}/g).slice(0, 4).join('-'),
    subject: cert.subject,
    notBefore: cert.validFrom,
    notAfter: cert.validTo,
    expiresAt: Date.parse(cert.validTo),
    // Node hands SANs back as `DNS:a, IP Address:1.2.3.4`; normalise so the
    // set can be compared against what this machine looks like right now.
    sans: (cert.subjectAltName || '')
      .split(',')
      .map((entry) => entry.trim().replace(/^IP Address:/, 'IP:'))
      .filter(Boolean)
      .sort(),
  }
}

/** Why the certificate on disk is no longer good enough, or null if it is. */
function staleReason(current, names) {
  if (!current) return 'no certificate yet'
  if (!Number.isFinite(current.expiresAt)) return 'unreadable expiry'
  if (current.expiresAt - Date.now() < RENEW_WITHIN_MS) return 'certificate is about to expire'
  const wanted = sanString(names).split(',').sort()
  const missing = wanted.filter((entry) => !current.sans.includes(entry))
  if (missing.length) return `certificate does not cover ${missing.join(', ')}`
  return null
}

/**
 * Mints a certificate. The private key is reused unless `newKey` says
 * otherwise, and that is the whole point: the phone pins the public key, so a
 * new DHCP lease has to be answered with a fresh certificate over the *same*
 * key or every paired phone would stop trusting the desktop it paired with.
 */
export function generate({ names = subjectNames(), newKey = false } = {}) {
  fs.mkdirSync(TLS_DIR, { recursive: true, mode: 0o700 })
  const keyTmp = `${KEY_FILE}.${process.pid}.tmp`
  const certTmp = `${CERT_FILE}.${process.pid}.tmp`
  const reuseKey = !newKey && fs.existsSync(KEY_FILE)
  if (reuseKey) fs.copyFileSync(KEY_FILE, keyTmp)
  try {
    execFileSync(
      'openssl',
      [
        'req', '-x509', '-nodes',
        ...(reuseKey ? ['-new', '-key', keyTmp] : ['-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-keyout', keyTmp]),
        '-days', String(DAYS),
        '-subj', `/CN=${os.hostname()}/O=Omarchy Connect`,
        '-addext', `subjectAltName=${sanString(names)}`,
        '-addext', 'basicConstraints=critical,CA:TRUE',
        '-addext', 'keyUsage=critical,digitalSignature,keyEncipherment,keyCertSign',
        '-addext', 'extendedKeyUsage=serverAuth',
        '-out', certTmp,
      ],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    )
  } catch (err) {
    fs.rmSync(keyTmp, { force: true })
    fs.rmSync(certTmp, { force: true })
    const detail = (err.stderr || '').toString().trim().split('\n').pop()
    throw new Error(`openssl could not mint a certificate: ${detail || err.message}`)
  }
  fs.chmodSync(keyTmp, 0o600)
  fs.chmodSync(certTmp, 0o644)
  fs.renameSync(keyTmp, KEY_FILE)
  fs.renameSync(certTmp, CERT_FILE)
  return readCertificate()
}

/** What is on disk, without minting anything. */
export function info() {
  try {
    return readCertificate()
  } catch {
    return null
  }
}

/**
 * The certificate to serve with, minting or re-minting it when the one on
 * disk cannot do the job. Returns null when TLS is off.
 */
export function ensure({ force = false } = {}) {
  const names = subjectNames()
  const current = info()
  const reason = force ? 'refresh requested' : staleReason(current, names)
  if (!reason) return current
  if (current) log.info(`renewing the TLS certificate — ${reason}`)
  const next = generate({ names })
  if (current && current.pin !== next.pin) log.warn('the TLS pin changed — paired phones must pair again')
  log.ok(`TLS certificate valid until ${next.notAfter}`)
  return next
}

/**
 * A brand new key as well as a new certificate. This invalidates the pin every
 * paired phone is holding, so it is only ever done on request.
 */
export function rotate() {
  const next = generate({ newKey: true })
  log.warn('minted a new TLS key — every paired phone has to pair again')
  return next
}

export function remove() {
  fs.rmSync(KEY_FILE, { force: true })
  fs.rmSync(CERT_FILE, { force: true })
}

/** Certificate installers need the cert alone, never the key. */
export function exportCertificate(destination) {
  const current = info()
  if (!current) throw new Error('no certificate — run `omarchy-connect tls enable` first')
  const target = path.resolve(destination)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, current.cert, { mode: 0o644 })
  return { path: target, pin: current.pin }
}
