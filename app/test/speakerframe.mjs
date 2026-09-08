/**
 * The two halves of one speaker chunk, held against each other.
 *
 * `micframe.mjs` next door does this for the sound going up, and everything it
 * says applies here with the writer and the reader swapped: `daemon/src/lib/
 * speaker.js` writes the frame and `app/src/lib/speakerframe.ts` reads it — the
 * same twelve bytes of header described twice, in two languages, by two people
 * who will not be in the room together when one of them changes. A desktop
 * that numbers its chunks big-endian against a phone that reads them
 * little-endian is not a crash: it is a stream number nothing recognises and a
 * speaker that stays silent while both ends report success.
 *
 * The second thing checked here is the one that made this road possible at
 * all. Every frame the desktop had ever sent was JSON, so `api/client.ts` ran
 * a `TextDecoder` over each decrypted frame with nothing in front of it. Sound
 * is told from a sentence by four bytes, and it can only be told that way
 * because no JSON the desktop sends can begin with `OCS1` — JSON starts with
 * `{`. That is asserted here rather than believed.
 */
import { check, done } from '../../tools/test-harness.mjs'
import {
  parse,
  frame,
  isSpeakerFrame,
  chunkBytes,
  RATE,
  CHANNELS,
  CHUNK_MS,
  HEADER_BYTES,
} from '../src/lib/speakerframe.ts'
import {
  buildFrame,
  parseFrame,
  isSpeakerFrame as daemonRecognises,
  HEADER_BYTES as DAEMON_HEADER,
  RATE as DAEMON_RATE,
  CHANNELS as DAEMON_CHANNELS,
  CHUNK_MS as DAEMON_CHUNK_MS,
  MAX_CHUNK_BYTES,
} from '../../daemon/src/lib/speaker.js'
import { MAGIC as MIC_MAGIC } from '../../daemon/src/lib/mic.js'

/* ── the two ends describe the same sound ──────────────────────────────── */

check('both ends agree on the sample rate', RATE === DAEMON_RATE, `${RATE} vs ${DAEMON_RATE}`)
check('and on mono', CHANNELS === DAEMON_CHANNELS, `${CHANNELS} vs ${DAEMON_CHANNELS}`)
check('and on how much sound is in one frame', CHUNK_MS === DAEMON_CHUNK_MS, `${CHUNK_MS} vs ${DAEMON_CHUNK_MS}`)
check('and on the size of the header', HEADER_BYTES === DAEMON_HEADER, `${HEADER_BYTES} vs ${DAEMON_HEADER}`)
check('a chunk of the agreed length is 640 bytes', chunkBytes() === 640, String(chunkBytes()))
check('which is well inside what the format allows', chunkBytes() <= MAX_CHUNK_BYTES)

/* ── one chunk, written by the desktop and read by the phone ───────────── */

const pcm = new Uint8Array(chunkBytes())
for (let i = 0; i < pcm.length; i += 1) pcm[i] = (i * 31) % 256

// 70000 and 65538 are both past 16 bits: a stream number or a sequence written
// two bytes wide would come back as 4464 and 2, and an evening of music is
// exactly where that would first be noticed.
const built = buildFrame(70000, 65538, Buffer.from(pcm))
const read = parse(new Uint8Array(built))
check('the phone reads back the stream the desktop wrote', read.stream === 70000, String(read.stream))
check('and the sequence', read.seq === 65538, String(read.seq))
check('and every sample, unchanged', Buffer.from(read.pcm).equals(Buffer.from(pcm)), `${read.pcm.length} bytes`)
check('with nothing but the header in front of them', built.length === HEADER_BYTES + pcm.length)

/* ── and the same frame written by the phone and read by the desktop ───── */

const mirrored = parseFrame(Buffer.from(frame(9, 3, pcm)))
check('the two encoders produce the same bytes', mirrored.stream === 9 && mirrored.seq === 3, JSON.stringify(mirrored.seq))
check('over the same samples', Buffer.from(mirrored.pcm).equals(Buffer.from(pcm)))

/* ── what must be refused rather than played ───────────────────────────── */

let odd = null
try {
  parse(new Uint8Array(buildFrame(1, 0, Buffer.alloc(641))))
} catch (err) {
  odd = err.message
}
check('half a sample is refused rather than shifted', /whole number of samples/.test(odd || ''), String(odd))

let strange = null
try {
  parse(new Uint8Array([0x7b, 0x22, 0x74, 0x22]))
} catch (err) {
  strange = err.message
}
check('and so is something that is not a speaker frame at all', /not a speaker frame/.test(strange || ''), String(strange))

/* ── and never mistakes one kind of frame for another ──────────────────── */

check('the phone recognises what the desktop builds as sound', isSpeakerFrame(new Uint8Array(built)))
check('and the desktop recognises what the phone builds', daemonRecognises(Buffer.from(frame(1, 0, pcm))))
check(
  'no JSON the desktop sends looks like sound',
  ['{"t":"ev"}', '{"t":"res","id":1}', '{"t":"hello.ok"}'].every((json) => !isSpeakerFrame(new TextEncoder().encode(json))),
)
// The one collision that would be silent: the microphone's magic differs from
// the speaker's in a single byte, and the two roads cross in the same socket.
check(
  'and a microphone chunk is not mistaken for a speaker chunk',
  !isSpeakerFrame(new Uint8Array(Buffer.concat([MIC_MAGIC, Buffer.alloc(8 + 640)]))),
)

done('speaker frame checks')
