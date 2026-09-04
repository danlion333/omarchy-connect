import crypto from 'node:crypto'
import { Transform } from 'node:stream'

/**
 * The encryption the file bodies ride under, and the reason it is not TLS.
 *
 * Everything a phone says on `/ws` has been end-to-end encrypted for a long
 * time — `SecureChannel`, under a key the phone pinned when it paired. The
 * file *bodies* never went that way: `/api/upload` and `/api/download` are
 * plain HTTP routes on the same listener, and the bytes were a raw stream in
 * both directions. The only thing that would have covered them was TLS, and
 * TLS is off on a fresh install and cannot simply be turned on: an Android
 * build trusts this desktop's self-signed certificate only when it carries
 * `assets/desktop-ca.pem`, and Expo Go cannot be made to trust it at all
 * (`docs/PROTOCOL.md`). So a photo, a document, and — worst of the three —
 * the audio of somebody dictating into their own machine crossed the LAN in
 * the clear, while the sentence that asked for the transfer did not.
 *
 * The fix is therefore at the application layer, where the key already is.
 * A ticket is minted on the encrypted socket for every transfer; it now
 * carries 32 random bytes with it, and the body is sealed under those. No
 * certificate, no trust store, nothing to configure, and nothing that Expo Go
 * cannot do.
 *
 * The framing, `OCF1`:
 *
 *   "OCF1" || chunk:u32be                       8-byte header
 *   seal(plaintext[0 .. chunk])                 chunk + 16, repeated
 *   ...
 *   seal(plaintext[.. < chunk])                 16 .. chunk + 15, exactly one
 *
 * Every frame is ChaCha20-Poly1305 under the ticket key with a counter nonce,
 * the same construction the control channel uses — a frame that was reordered,
 * replayed or edited simply fails to open. The last frame is always short (a
 * file whose length is an exact multiple of the chunk ends with an empty one),
 * which is what makes the stream self-terminating: a reader that runs out of
 * bytes on a frame boundary knows it was cut off, so truncation is an error
 * rather than a shorter file.
 *
 * Both directions stay streams. A 4 GB video is sealed and opened 64 KiB at a
 * time on either end, and the ciphertext length is a pure function of the
 * plaintext length (`encryptedSize`), so `content-length` is still exact on a
 * download and the phone's native uploader still knows what it is sending.
 */

export const MAGIC = Buffer.from('OCF1')
export const SCHEME = 'ocf1'
/** The header a request or a response wears when its body is sealed. */
export const HEADER = 'x-oc-encryption'
export const CHUNK = 64 * 1024
export const TAG_BYTES = 16
export const HEADER_BYTES = MAGIC.length + 4
/** Nothing legitimate asks for a bigger frame; a huge one is an allocation attack. */
const MAX_CHUNK = 4 * 1024 * 1024

export const keyFromHex = (hex) => {
  const key = Buffer.from(String(hex ?? ''), 'hex')
  if (key.length !== 32) throw new Error('a content key is 32 bytes')
  return key
}

/** Fresh key material for one transfer. Never reused, never leaves `/ws`. */
export const newKey = () => crypto.randomBytes(32).toString('hex')

function nonce(counter) {
  const out = Buffer.alloc(12)
  out.writeBigUInt64BE(counter, 4)
  return out
}

function seal(key, counter, plaintext) {
  const cipher = crypto.createCipheriv('chacha20-poly1305', key, nonce(counter), { authTagLength: TAG_BYTES })
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()])
  return Buffer.concat([body, cipher.getAuthTag()])
}

function open(key, counter, frame) {
  const body = frame.subarray(0, frame.length - TAG_BYTES)
  const tag = frame.subarray(frame.length - TAG_BYTES)
  const decipher = crypto.createDecipheriv('chacha20-poly1305', key, nonce(counter), { authTagLength: TAG_BYTES })
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(body), decipher.final()])
}

/** How many bytes `n` plaintext bytes become on the wire. Exact, not an estimate. */
export function encryptedSize(n, chunk = CHUNK) {
  const full = Math.floor(n / chunk)
  return HEADER_BYTES + full * (chunk + TAG_BYTES) + (n % chunk) + TAG_BYTES
}

/** Plaintext in, `OCF1` out. */
export function encryptStream(keyHex, chunk = CHUNK) {
  const key = keyFromHex(keyHex)
  let counter = 0n
  let pending = Buffer.alloc(0)
  let started = false

  const start = (push) => {
    if (started) return
    started = true
    const header = Buffer.alloc(HEADER_BYTES)
    MAGIC.copy(header, 0)
    header.writeUInt32BE(chunk, MAGIC.length)
    push(header)
  }

  return new Transform({
    transform(piece, _enc, next) {
      start((b) => this.push(b))
      pending = pending.length ? Buffer.concat([pending, piece]) : piece
      while (pending.length >= chunk) {
        this.push(seal(key, counter, pending.subarray(0, chunk)))
        counter += 1n
        pending = pending.subarray(chunk)
      }
      next()
    },
    flush(done) {
      start((b) => this.push(b))
      // Always a short frame, even an empty one: it is the end-of-stream mark.
      this.push(seal(key, counter, pending))
      done()
    },
  })
}

/** `OCF1` in, plaintext out — or an error, which is the point. */
export function decryptStream(keyHex) {
  const key = keyFromHex(keyHex)
  let counter = 0n
  let buffered = Buffer.alloc(0)
  let chunk = 0

  return new Transform({
    transform(piece, _enc, next) {
      buffered = buffered.length ? Buffer.concat([buffered, piece]) : piece
      try {
        if (!chunk) {
          if (buffered.length < HEADER_BYTES) return next()
          if (!buffered.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('not an encrypted body')
          chunk = buffered.readUInt32BE(MAGIC.length)
          if (chunk < 1 || chunk > MAX_CHUNK) throw new Error('unreasonable frame size')
          buffered = buffered.subarray(HEADER_BYTES)
        }
        // Only whole frames are opened here. A frame shorter than this is by
        // definition the last one, and belongs to `flush`.
        while (buffered.length >= chunk + TAG_BYTES) {
          this.push(open(key, counter, buffered.subarray(0, chunk + TAG_BYTES)))
          counter += 1n
          buffered = buffered.subarray(chunk + TAG_BYTES)
        }
        next()
      } catch (err) {
        next(new Error(`could not decrypt the body: ${err.message}`))
      }
    },
    flush(done) {
      try {
        if (!chunk) throw new Error('the body ended before its header')
        if (buffered.length < TAG_BYTES) throw new Error('the body was truncated')
        this.push(open(key, counter, buffered))
        done()
      } catch (err) {
        done(new Error(`could not decrypt the body: ${err.message}`))
      }
    },
  })
}

/** Whether a request or a response said its body is sealed. */
export const wantsEncryption = (value) => String(value ?? '').toLowerCase() === SCHEME
