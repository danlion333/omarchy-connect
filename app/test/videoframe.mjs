/**
 * The two halves of one camera frame, held against each other.
 *
 * `app/src/lib/videoframe.ts` writes the frame and `daemon/src/lib/video.js`
 * reads it — the same twelve bytes of header described twice, in two
 * languages, by two people who will not be in the room together when one of
 * them changes. `app/test/micframe.mjs` says at length why that is worth a
 * suite of its own, and every word of it holds here.
 *
 * What is new, and is the reason this file exists rather than a few more
 * checks next door, is that there are now *three* things inside one encrypted
 * envelope: JSON, a chunk of sound, and a picture. The desktop tells them
 * apart by the first four bytes, so the property that has to be asserted is no
 * longer "JSON is not audio" but a full three-way exclusion — and the
 * dangerous pair is the new one, because `OCA1` and `OCV1` differ in a single
 * byte. A phone that got that byte wrong would send pictures into a WAV, and
 * the desktop would report success the whole time.
 */
import { check, done } from '../../tools/test-harness.mjs'
import { frame, MAGIC, HEADER_BYTES, MAX_FRAME_BYTES, WIDTH, HEIGHT, FPS, QUALITY } from '../src/lib/videoframe.ts'
import { frame as audioFrame, chunkBytes } from '../src/lib/micframe.ts'
import {
  parseFrame,
  isVideoFrame,
  HEADER_BYTES as DAEMON_HEADER,
  WIDTH as DAEMON_WIDTH,
  HEIGHT as DAEMON_HEIGHT,
  FPS as DAEMON_FPS,
  QUALITY as DAEMON_QUALITY,
  MAX_FRAME_BYTES as DAEMON_MAX,
} from '../../daemon/src/lib/video.js'
import { isAudioFrame } from '../../daemon/src/lib/mic.js'

/* ── the two ends describe the same pictures ───────────────────────────── */

check('both ends agree on the size of the header', HEADER_BYTES === DAEMON_HEADER, `${HEADER_BYTES} vs ${DAEMON_HEADER}`)
check('and on the default frame size', WIDTH === DAEMON_WIDTH && HEIGHT === DAEMON_HEIGHT, `${WIDTH}x${HEIGHT} vs ${DAEMON_WIDTH}x${DAEMON_HEIGHT}`)
check('and on how many a second', FPS === DAEMON_FPS, `${FPS} vs ${DAEMON_FPS}`)
check('and on the JPEG quality asked for', QUALITY === DAEMON_QUALITY, `${QUALITY} vs ${DAEMON_QUALITY}`)
check('and on the largest frame that will be taken', MAX_FRAME_BYTES === DAEMON_MAX, `${MAX_FRAME_BYTES} vs ${DAEMON_MAX}`)

/* ── one picture, written by the phone and read by the desktop ─────────── */

// A JPEG only in the ways this road cares about: it starts with the SOI marker
// the desktop checks for, and every later byte is recognisable, so a frame
// that is the right length and the wrong bytes is still a failure.
const jpeg = new Uint8Array(4096)
jpeg[0] = 0xff
jpeg[1] = 0xd8
for (let i = 2; i < jpeg.length; i += 1) jpeg[i] = (i * 31) % 256

// 70000 and 65538 are both past 16 bits: a stream number or a sequence written
// two bytes wide would come back as 4464 and 2, and a long capture is exactly
// where that would first be noticed.
const built = frame(70000, 65538, jpeg)
const read = parseFrame(Buffer.from(built))
check('the desktop reads back the stream the phone wrote', read.stream === 70000, String(read.stream))
check('and the sequence', read.seq === 65538, String(read.seq))
check('and every byte of the picture, unchanged', Buffer.from(jpeg).equals(read.jpeg), `${read.jpeg.length} bytes`)
check('with nothing but the header in front of them', built.length === HEADER_BYTES + jpeg.length)

/* ── and never mistakes one kind of frame for another ──────────────────── */

check('the desktop recognises what the phone builds as video', isVideoFrame(Buffer.from(built)))
check('and does not mistake it for sound', !isAudioFrame(Buffer.from(built)))

const sound = audioFrame(1, 0, new Uint8Array(chunkBytes()))
check('a chunk of microphone is not mistaken for a picture', !isVideoFrame(Buffer.from(sound)))
check('and is still recognised as sound', isAudioFrame(Buffer.from(sound)))
check('the two magics differ in exactly one byte, which is why the pair above is checked at all', MAGIC[3] === 0x31 && MAGIC[2] === 0x56)

check(
  'and none of the JSON the phone sends is mistaken for a picture',
  [
    { t: 'hello', token: 'OCV1' },
    { t: 'req', id: 1, method: 'video.status' },
    { t: 'sub', events: ['video'] },
    { t: 'req', id: 2, method: 'clipboard.set', params: { text: 'OCV1 is not a frame' } },
    { t: 'req', id: 3, method: 'video.started', params: { id: 'OCV1OCV1OCV1', ok: true } },
  ].every((msg) => !isVideoFrame(Buffer.from(JSON.stringify(msg)))),
)

/* ── the frame nothing should accept ───────────────────────────────────── */

const refuses = (bytes, pattern) => {
  try {
    parseFrame(Buffer.from(bytes))
    return false
  } catch (err) {
    return pattern.test(err.message)
  }
}

check('a frame with no picture in it is refused', refuses(frame(1, 0, new Uint8Array(0)), /no picture/))
check(
  'a frame that does not begin with a JPEG marker is refused rather than written into an MJPEG file nothing can open',
  refuses(frame(1, 0, new Uint8Array([0x00, 0x01, 0x02, 0x03])), /JPEG marker/),
)
check('and one past the ceiling is refused whole', refuses(frame(1, 0, (() => {
  const big = new Uint8Array(MAX_FRAME_BYTES + 1)
  big[0] = 0xff
  big[1] = 0xd8
  return big
})()), /too large/))

done('camera frame checks')
