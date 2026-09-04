import { chacha20poly1305 } from '@noble/ciphers/chacha.js'

/**
 * The phone half of the sealed file body. Mirrors `daemon/src/lib/filecrypt.js`
 * — that file carries the reasoning; this one has to agree with it byte for
 * byte.
 *
 * Everything the phone says on the socket has been encrypted end to end since
 * pairing, but the *bodies* of `/api/upload` and `/api/download` were a raw
 * stream over plain HTTP, and TLS is off by default and cannot be turned on
 * for an Expo Go build at all. So the photo, the document and the dictation
 * audio were the one part of this app that a stranger on the same Wi-Fi could
 * read. They are sealed here instead, under a key that came down the encrypted
 * socket with the transfer's ticket.
 *
 * Pure JavaScript over `Uint8Array`, like `crypto.ts` beside it, so it runs in
 * Expo Go and under plain Node in the suites. Nothing here touches the file
 * system: the callers own the streaming, and feed this a piece at a time.
 */

export const MAGIC = new Uint8Array([0x4f, 0x43, 0x46, 0x31]) // "OCF1"
export const SCHEME = 'ocf1'
/** The header that says a body is sealed, going out or coming back. */
export const HEADER = 'x-oc-encryption'
export const CHUNK = 64 * 1024
const TAG_BYTES = 16
const HEADER_BYTES = MAGIC.length + 4
const MAX_CHUNK = 4 * 1024 * 1024

export function keyFromHex(hex: string): Uint8Array {
  const clean = (hex || '').trim().toLowerCase()
  if (clean.length !== 64 || /[^0-9a-f]/.test(clean)) throw new Error('a content key is 32 hex bytes')
  const out = new Uint8Array(32)
  for (let i = 0; i < 32; i += 1) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16)
  return out
}

function nonce(counter: bigint): Uint8Array {
  const out = new Uint8Array(12)
  let value = counter
  for (let i = 11; i >= 4; i -= 1) {
    out[i] = Number(value & 0xffn)
    value >>= 8n
  }
  return out
}

function concat(parts: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total)
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}

/** Exactly how long `n` plaintext bytes are once sealed. */
export function encryptedSize(n: number, chunk: number = CHUNK): number {
  const full = Math.floor(n / chunk)
  return HEADER_BYTES + full * (chunk + TAG_BYTES) + (n % chunk) + TAG_BYTES
}

/** What a caller feeds pieces into and gets pieces out of. */
export type Codec = {
  push(piece: Uint8Array): Uint8Array[]
  end(): Uint8Array[]
}

/** Plaintext in, `OCF1` frames out. */
export function sealer(keyHex: string, chunk: number = CHUNK): Codec {
  const key = keyFromHex(keyHex)
  let counter = 0n
  let held: Uint8Array[] = []
  let heldLength = 0
  let started = false

  const seal = (plaintext: Uint8Array): Uint8Array => {
    const frame = chacha20poly1305(key, nonce(counter)).encrypt(plaintext)
    counter += 1n
    return frame
  }

  const preamble = (): Uint8Array[] => {
    if (started) return []
    started = true
    const head = new Uint8Array(HEADER_BYTES)
    head.set(MAGIC, 0)
    new DataView(head.buffer).setUint32(MAGIC.length, chunk, false)
    return [head]
  }

  return {
    push(piece) {
      const out = preamble()
      held.push(piece)
      heldLength += piece.length
      while (heldLength >= chunk) {
        const all = concat(held, heldLength)
        out.push(seal(all.subarray(0, chunk)))
        const rest = all.subarray(chunk)
        held = rest.length ? [rest] : []
        heldLength = rest.length
      }
      return out
    },
    end() {
      const out = preamble()
      // Always a short frame, even an empty one: it marks the end, and it is
      // what lets the desktop tell a finished stream from a cut one.
      out.push(seal(concat(held, heldLength)))
      held = []
      heldLength = 0
      return out
    },
  }
}

/** `OCF1` frames in, plaintext out — or a throw, which is the point. */
export function opener(keyHex: string): Codec {
  const key = keyFromHex(keyHex)
  let counter = 0n
  let buffered: Uint8Array = new Uint8Array(0)
  let chunk = 0

  const open = (frame: Uint8Array): Uint8Array => {
    const plaintext = chacha20poly1305(key, nonce(counter)).decrypt(frame)
    counter += 1n
    return plaintext
  }

  const take = (n: number): Uint8Array => {
    const head = buffered.subarray(0, n)
    buffered = buffered.subarray(n)
    return head
  }

  return {
    push(piece) {
      buffered = concat([buffered, piece], buffered.length + piece.length)
      const out: Uint8Array[] = []
      if (!chunk) {
        if (buffered.length < HEADER_BYTES) return out
        for (let i = 0; i < MAGIC.length; i += 1) {
          if (buffered[i] !== MAGIC[i]) throw new Error('the desktop did not send an encrypted body')
        }
        chunk = new DataView(buffered.buffer, buffered.byteOffset, buffered.length).getUint32(MAGIC.length, false)
        if (chunk < 1 || chunk > MAX_CHUNK) throw new Error('unreasonable frame size')
        take(HEADER_BYTES)
      }
      // Only whole frames here; anything shorter is by definition the last one.
      while (buffered.length >= chunk + TAG_BYTES) out.push(open(take(chunk + TAG_BYTES)))
      return out
    },
    end() {
      if (!chunk) throw new Error('the body ended before its header')
      if (buffered.length < TAG_BYTES) throw new Error('the body was truncated')
      return [open(take(buffered.length))]
    },
  }
}
