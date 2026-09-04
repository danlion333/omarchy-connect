/**
 * The two halves of the sealed file body, held against each other.
 *
 * `app/src/api/filecrypt.ts` and `daemon/src/lib/filecrypt.js` are the same
 * format written twice, in two languages, by two people who will not be in the
 * room together when one of them is changed. A phone that seals a photo the
 * desktop cannot open is a file transfer that fails; a desktop that seals an
 * offer the phone cannot open is a Save button that does nothing. Neither
 * shows up in a suite that only tests one side, which is why this one imports
 * both and makes them talk.
 *
 * Also here: the properties the codec has to hold on its own — no plaintext in
 * the frames, a truncated stream refused rather than quietly short, and a body
 * under the wrong key refused.
 */
import crypto from 'node:crypto'
import { Readable } from 'node:stream'
import { buffer } from 'node:stream/consumers'

import { check, done } from '../../tools/test-harness.mjs'
import { encryptStream, decryptStream, encryptedSize as daemonSize } from '../../daemon/src/lib/filecrypt.js'
import { sealer, opener, encryptedSize, CHUNK, SCHEME, HEADER } from '../src/api/filecrypt.ts'

const key = crypto.randomBytes(32).toString('hex')
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex')

/** The phone's codec, run over a whole buffer the way a stream would feed it. */
const phoneSeal = (bytes, piece = 7919) => {
  const codec = sealer(key)
  const out = []
  for (let at = 0; at < bytes.length; at += piece) out.push(...codec.push(bytes.subarray(at, at + piece)))
  out.push(...codec.end())
  return Buffer.concat(out.map(Buffer.from))
}

const phoneOpen = (bytes, piece = 4093) => {
  const codec = opener(key)
  const out = []
  for (let at = 0; at < bytes.length; at += piece) out.push(...codec.push(bytes.subarray(at, at + piece)))
  out.push(...codec.end())
  return Buffer.concat(out.map(Buffer.from))
}

const daemonSeal = (bytes) => buffer(Readable.from([bytes]).pipe(encryptStream(key)))
const daemonOpen = (bytes) => buffer(Readable.from([bytes]).pipe(decryptStream(key)))

check('both sides name the scheme the same thing', SCHEME === 'ocf1' && HEADER === 'x-oc-encryption')
check('and agree on the chunk size', CHUNK === 64 * 1024)

for (const size of [0, 1, 1000, CHUNK - 1, CHUNK, CHUNK + 1, 2 * CHUNK + 13]) {
  const plain = crypto.randomBytes(size)
  check(`${size} bytes: both sides predict the same sealed length`, encryptedSize(size) === daemonSize(size))

  const fromPhone = phoneSeal(plain)
  check(`${size} bytes: the phone seals what the desktop opens`, sha(await daemonOpen(fromPhone)) === sha(plain))
  check(`${size} bytes: and it is the length both predicted`, fromPhone.length === encryptedSize(size))

  const fromDesktop = await daemonSeal(plain)
  check(`${size} bytes: the desktop seals what the phone opens`, sha(phoneOpen(fromDesktop)) === sha(plain))
  check(`${size} bytes: byte for byte the same frames`, sha(fromPhone) === sha(fromDesktop))
}

/* ── the properties, on the phone's side ────────────────────────────────── */

const secret = Buffer.from('MARKER-be71d4-what-the-microphone-heard'.repeat(400))
const sealed = phoneSeal(secret)
check('a dictation the phone sealed carries no plaintext', !sealed.includes(Buffer.from('MARKER-be71d4')))
check('it is a recognisable frame stream', sealed.subarray(0, 4).toString() === 'OCF1')

const other = crypto.randomBytes(32).toString('hex')
let refused = null
try {
  const codec = opener(other)
  codec.push(sealed)
  codec.end()
} catch (err) {
  refused = err.message
}
check('a body under another key does not open on the phone either', refused !== null, String(refused))

let truncated = null
try {
  const codec = opener(key)
  codec.push(sealed.subarray(0, sealed.length - 40))
  codec.end()
} catch (err) {
  truncated = err.message
}
check('and a cut stream is an error, not a shorter file', truncated !== null, String(truncated))

done()
