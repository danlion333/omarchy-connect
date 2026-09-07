import { x25519 } from '@noble/curves/ed25519.js'
import { chacha20poly1305 } from '@noble/ciphers/chacha.js'
import { hkdf } from '@noble/hashes/hkdf.js'
import { sha256 } from '@noble/hashes/sha2.js'

/**
 * The phone half of the encrypted control channel. Mirrors
 * `daemon/src/lib/crypto.js` — see that file for the handshake rationale.
 *
 * Everything here is pure JavaScript on purpose: it runs unchanged in Expo Go,
 * so encryption is not a feature you have to make a native build to get.
 */

export const MAGIC = new Uint8Array([0x4f, 0x43, 0x58, 0x31]) // "OCX1"
export const HANDSHAKE_BYTES = MAGIC.length + 32
const INFO = new TextEncoder().encode('omarchy-connect v1 channel')
const TAG_BYTES = 16

type RandomSource = (length: number) => Uint8Array

let randomSource: RandomSource | null = null

/**
 * Hands this module a CSPRNG. The app wires in expo-crypto at startup; keeping
 * the dependency out of the module itself is what lets the protocol tests run
 * the very same file under plain Node.
 */
export function setRandomSource(source: RandomSource) {
  randomSource = source
}

/**
 * Exported because the handshake is no longer the only thing that needs
 * unguessable bytes: the sealed clipboard history wants a key and a fresh
 * nonce, and it should ask the module that already knows where this phone's
 * randomness comes from rather than reach for a second source of its own.
 */
export function randomBytes(length: number): Uint8Array {
  if (randomSource) return randomSource(length)
  const webCrypto = (globalThis as { crypto?: Crypto }).crypto
  if (webCrypto?.getRandomValues) return webCrypto.getRandomValues(new Uint8Array(length))
  throw new Error('no secure random source — call setRandomSource() during startup')
}

export function toHex(bytes: Uint8Array): string {
  let out = ''
  for (const b of bytes) out += b.toString(16).padStart(2, '0')
  return out
}

export function fromHex(hex: string): Uint8Array {
  const clean = hex.trim().toLowerCase()
  if (clean.length % 2 !== 0 || /[^0-9a-f]/.test(clean)) throw new Error('not a hex string')
  const out = new Uint8Array(clean.length / 2)
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16)
  return out
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(total)
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}

/** The same short digest the daemon prints, so the two can be compared by eye. */
export function fingerprint(publicKey: Uint8Array | string): string {
  const raw = typeof publicKey === 'string' ? fromHex(publicKey) : publicKey
  return toHex(sha256(raw))
    .slice(0, 16)
    .toUpperCase()
    .replace(/(.{4})(?=.)/g, '$1-')
}

export class SecureChannel {
  private sendKey: Uint8Array
  private receiveKey: Uint8Array
  private sendCounter = 0n
  private receiveCounter = 0n

  constructor(sendKey: Uint8Array, receiveKey: Uint8Array) {
    this.sendKey = sendKey
    this.receiveKey = receiveKey
  }

  private static nonce(counter: bigint): Uint8Array {
    const nonce = new Uint8Array(12)
    let value = counter
    for (let i = 11; i >= 4; i -= 1) {
      nonce[i] = Number(value & 0xffn)
      value >>= 8n
    }
    return nonce
  }

  encrypt(plaintext: Uint8Array): Uint8Array {
    const frame = chacha20poly1305(this.sendKey, SecureChannel.nonce(this.sendCounter)).encrypt(plaintext)
    this.sendCounter += 1n
    return frame
  }

  decrypt(frame: Uint8Array): Uint8Array {
    if (frame.length < TAG_BYTES) throw new Error('short frame')
    const plaintext = chacha20poly1305(this.receiveKey, SecureChannel.nonce(this.receiveCounter)).decrypt(frame)
    this.receiveCounter += 1n
    return plaintext
  }
}

/**
 * Starts a handshake against a desktop whose identity key we already pinned.
 * `finish` throws unless the desktop can prove it holds the private half.
 */
export function startHandshake(serverPublicKey: Uint8Array | string) {
  const server = typeof serverPublicKey === 'string' ? fromHex(serverPublicKey) : serverPublicKey
  if (server.length !== 32) throw new Error('bad desktop key')

  const privateKey = randomBytes(32)
  const publicKey = x25519.getPublicKey(privateKey)

  return {
    frame: concat(MAGIC, publicKey),
    finish(reply: Uint8Array): SecureChannel {
      if (reply.length !== HANDSHAKE_BYTES) throw new Error('malformed handshake reply')
      for (let i = 0; i < MAGIC.length; i += 1) {
        if (reply[i] !== MAGIC[i]) throw new Error('unknown handshake magic')
      }
      const serverEphemeral = reply.subarray(MAGIC.length)
      const es = x25519.getSharedSecret(privateKey, server)
      const ee = x25519.getSharedSecret(privateKey, serverEphemeral)
      const okm = hkdf(sha256, concat(es, ee), concat(publicKey, serverEphemeral), INFO, 64)
      // The desktop encrypts with the second half and reads with the first.
      return new SecureChannel(okm.subarray(0, 32), okm.subarray(32, 64))
    },
  }
}
