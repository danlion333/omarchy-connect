import crypto from 'node:crypto'
import { updateConfig, loadConfig } from './config.js'

/**
 * End-to-end encryption for the control channel.
 *
 * The desktop owns a long-lived X25519 identity key. The phone pins that key
 * when it pairs (it travels inside the QR code), so every later session both
 * encrypts the traffic and proves the desktop is the same machine — a
 * man-in-the-middle on the LAN cannot complete the handshake without the
 * matching private key.
 *
 * Handshake, loosely Noise IK:
 *
 *   phone  → desktop   MAGIC || e_pub            (32B ephemeral)
 *   desktop → phone    MAGIC || f_pub            (32B ephemeral)
 *
 *   es = X25519(e, S)      authenticates the desktop
 *   ee = X25519(e, f)      gives forward secrecy
 *   k  = HKDF-SHA256(es || ee, salt = e_pub || f_pub)
 *
 * `es` needs the desktop's static private key, so only the real desktop can
 * derive `k`; `ee` uses two ephemerals that are thrown away with the socket,
 * so a later theft of the identity key does not decrypt recorded sessions.
 */

export const MAGIC = Buffer.from('OCX1')
export const HANDSHAKE_BYTES = MAGIC.length + 32
export const SUITE = 'x25519-chacha20poly1305'

const SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex')
const PKCS8_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex')
const INFO = Buffer.from('omarchy-connect v1 channel')
const TAG_BYTES = 16

const rawToPublic = (raw) =>
  crypto.createPublicKey({ key: Buffer.concat([SPKI_PREFIX, raw]), format: 'der', type: 'spki' })

const rawToPrivate = (raw) =>
  crypto.createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, raw]), format: 'der', type: 'pkcs8' })

const publicToRaw = (key) => key.export({ type: 'spki', format: 'der' }).subarray(SPKI_PREFIX.length)
const privateToRaw = (key) => key.export({ type: 'pkcs8', format: 'der' }).subarray(PKCS8_PREFIX.length)

export function generateKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519')
  return { publicKey: publicToRaw(publicKey), privateKey: privateToRaw(privateKey) }
}

/** The desktop's identity key, minted on first use and kept in the 0600 config. */
export function identity() {
  const cfg = loadConfig()
  if (cfg.identity?.publicKey && cfg.identity?.privateKey) {
    return {
      publicKey: Buffer.from(cfg.identity.publicKey, 'hex'),
      privateKey: Buffer.from(cfg.identity.privateKey, 'hex'),
    }
  }
  const pair = generateKeyPair()
  updateConfig((c) => {
    c.identity = { publicKey: pair.publicKey.toString('hex'), privateKey: pair.privateKey.toString('hex') }
  })
  return pair
}

/**
 * A short, readable digest of a public key. This is what a human compares
 * between the terminal and the phone when they want to be sure.
 */
export function fingerprint(publicKey) {
  const raw = Buffer.isBuffer(publicKey) ? publicKey : Buffer.from(String(publicKey), 'hex')
  const digest = crypto.createHash('sha256').update(raw).digest('hex').slice(0, 16)
  return digest.toUpperCase().match(/.{4}/g).join('-')
}

function deriveKeys(shared, salt) {
  const okm = Buffer.from(crypto.hkdfSync('sha256', shared, salt, INFO, 64))
  // Separate keys per direction so a frame can never be replayed back at its sender.
  return { clientToServer: okm.subarray(0, 32), serverToClient: okm.subarray(32, 64) }
}

/** Server side of the handshake. Returns the reply frame and the live channel. */
export function accept(clientHandshake) {
  if (!Buffer.isBuffer(clientHandshake) || clientHandshake.length !== HANDSHAKE_BYTES) {
    throw new Error('malformed handshake')
  }
  if (!clientHandshake.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('unknown handshake magic')

  const clientEph = clientHandshake.subarray(MAGIC.length)
  const server = identity()
  const ephemeral = generateKeyPair()

  const clientEphKey = rawToPublic(clientEph)
  const es = crypto.diffieHellman({ privateKey: rawToPrivate(server.privateKey), publicKey: clientEphKey })
  const ee = crypto.diffieHellman({ privateKey: rawToPrivate(ephemeral.privateKey), publicKey: clientEphKey })

  const keys = deriveKeys(Buffer.concat([es, ee]), Buffer.concat([clientEph, ephemeral.publicKey]))
  return {
    reply: Buffer.concat([MAGIC, ephemeral.publicKey]),
    channel: new SecureChannel({ send: keys.serverToClient, receive: keys.clientToServer }),
  }
}

/**
 * ChaCha20-Poly1305 over an ordered stream. The nonce is a counter rather than
 * a random value and never travels on the wire: WebSocket delivers frames in
 * order, so both ends already agree on it, and a replayed or reordered frame
 * simply fails to authenticate.
 */
export class SecureChannel {
  constructor({ send, receive }) {
    this.sendKey = send
    this.receiveKey = receive
    this.sendCounter = 0n
    this.receiveCounter = 0n
  }

  static nonce(counter) {
    const nonce = Buffer.alloc(12)
    nonce.writeBigUInt64BE(counter, 4)
    return nonce
  }

  encrypt(plaintext) {
    const cipher = crypto.createCipheriv('chacha20-poly1305', this.sendKey, SecureChannel.nonce(this.sendCounter), {
      authTagLength: TAG_BYTES,
    })
    const body = Buffer.concat([cipher.update(plaintext), cipher.final()])
    this.sendCounter += 1n
    return Buffer.concat([body, cipher.getAuthTag()])
  }

  decrypt(frame) {
    if (!Buffer.isBuffer(frame) || frame.length < TAG_BYTES) throw new Error('short frame')
    const body = frame.subarray(0, frame.length - TAG_BYTES)
    const tag = frame.subarray(frame.length - TAG_BYTES)
    const decipher = crypto.createDecipheriv(
      'chacha20-poly1305',
      this.receiveKey,
      SecureChannel.nonce(this.receiveCounter),
      { authTagLength: TAG_BYTES },
    )
    decipher.setAuthTag(tag)
    const plaintext = Buffer.concat([decipher.update(body), decipher.final()])
    this.receiveCounter += 1n
    return plaintext
  }
}
