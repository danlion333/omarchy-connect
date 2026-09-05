/**
 * The two halves of one microphone chunk, held against each other.
 *
 * `app/src/lib/micframe.ts` writes the frame and `daemon/src/lib/mic.js` reads
 * it — the same twelve bytes of header described twice, in two languages, by
 * two people who will not be in the room together when one of them changes. A
 * phone that numbers its chunks little-endian against a desktop that reads
 * them big-endian is not a crash: it is a recording that plays as noise, or a
 * stream number nothing recognises and a file that stays empty while
 * everything reports success. That is exactly the bug a suite on one side
 * cannot see, so this one imports both.
 *
 * The second thing checked here is subtler and is the reason the format has a
 * magic at all: a JSON control frame and a chunk of sound travel inside the
 * very same encrypted envelope, and the desktop tells them apart by the first
 * four bytes. If any JSON the app sends could begin with `OCA1`, a message
 * would be swallowed as audio. It cannot — JSON starts with `{` — and this is
 * where that is written down as an assertion rather than as a belief.
 */
import { check, done } from '../../tools/test-harness.mjs'
import { frame, chunkBytes, RATE, CHANNELS, CHUNK_MS, HEADER_BYTES } from '../src/lib/micframe.ts'
import {
  parseFrame,
  isAudioFrame,
  HEADER_BYTES as DAEMON_HEADER,
  RATE as DAEMON_RATE,
  CHANNELS as DAEMON_CHANNELS,
  CHUNK_MS as DAEMON_CHUNK_MS,
  MAX_CHUNK_BYTES,
} from '../../daemon/src/lib/mic.js'

/* ── the two ends describe the same sound ──────────────────────────────── */

check('both ends agree on the sample rate', RATE === DAEMON_RATE, `${RATE} vs ${DAEMON_RATE}`)
check('and on mono', CHANNELS === DAEMON_CHANNELS, `${CHANNELS} vs ${DAEMON_CHANNELS}`)
check('and on how much sound is in one frame', CHUNK_MS === DAEMON_CHUNK_MS, `${CHUNK_MS} vs ${DAEMON_CHUNK_MS}`)
check('and on the size of the header', HEADER_BYTES === DAEMON_HEADER, `${HEADER_BYTES} vs ${DAEMON_HEADER}`)
check('a chunk of the agreed length is 640 bytes', chunkBytes() === 640, String(chunkBytes()))
check('which the desktop will accept', chunkBytes() <= MAX_CHUNK_BYTES)

/* ── one chunk, written by the phone and read by the desktop ───────────── */

const pcm = new Uint8Array(chunkBytes())
for (let i = 0; i < pcm.length; i += 1) pcm[i] = (i * 31) % 256

// 70000 and 65538 are both past 16 bits: a stream number or a sequence written
// two bytes wide would come back as 4464 and 2, and a long recording is
// exactly where that would first be noticed.
const built = frame(70000, 65538, pcm)
const read = parseFrame(Buffer.from(built))
check('the desktop reads back the stream the phone wrote', read.stream === 70000, String(read.stream))
check('and the sequence', read.seq === 65538, String(read.seq))
check('and every sample, unchanged', Buffer.from(pcm).equals(read.pcm), `${read.pcm.length} bytes`)
check('with nothing but the header in front of them', built.length === HEADER_BYTES + pcm.length)

/* ── and never mistakes one kind of frame for the other ────────────────── */

check('the desktop recognises what the phone builds as audio', isAudioFrame(Buffer.from(built)))
check(
  'and recognises none of the JSON the phone sends as audio',
  [
    { t: 'hello', token: 'OCA1' },
    { t: 'req', id: 1, method: 'audio.status' },
    { t: 'sub', events: ['audio'] },
    { t: 'req', id: 2, method: 'clipboard.set', params: { text: 'OCA1 is not a frame' } },
  ].every((msg) => !isAudioFrame(Buffer.from(JSON.stringify(msg)))),
)

done('microphone frame checks')
