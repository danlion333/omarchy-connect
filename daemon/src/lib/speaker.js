/**
 * The desktop's sound, on its way to the phone.
 *
 * `lib/mic.js` is this file's mirror and was written first: the phone speaks,
 * the desktop listens, and the whole road — a magic-prefixed binary frame
 * inside the encrypted channel — was built for that direction. Sound has run
 * exactly one way in this project ever since, and the asymmetry was never a
 * decision anybody made. A phone is a speaker with its own battery that is
 * always in the room; a laptop whose own output is broken, a video meeting
 * whose audio should come out of the handset in somebody's pocket, music in the
 * next room are all one module away from working, and this is that module's
 * frame.
 *
 * ## The frame
 *
 * ```
 * "OCS1" || stream:uint32be || seq:uint32be || pcm
 *   4            4                  4          n
 * ```
 *
 * Byte for byte `OCA1`'s header — and `OCV1`'s — with one letter changed, and
 * that is deliberate: three roads that differ only in what they carry should
 * not differ in how they are read. The magic is what tells the *phone* a frame
 * is not JSON, which is the thing that could not happen before this file
 * existed. `app/src/api/client.ts` used to hand every decrypted frame to a
 * `TextDecoder` unconditionally, so a binary frame arriving at the handset
 * would have been mangled into a string and dropped on `JSON.parse` — silently,
 * fifty times a second.
 *
 * `stream` is the number this desktop handed out when it switched the speaker
 * on. It exists for exactly the reason the microphone's does: a chunk from a
 * run that has already ended — one in flight when the sink went away, or one
 * that arrives after the phone reconnected — has to be recognised and dropped
 * rather than played into the middle of the next one. `seq` counts chunks
 * within one stream from zero, and a gap in it is the desktop having dropped a
 * chunk it could not get onto the socket in time. Neither is needed to
 * decrypt: the channel's counter nonce already refuses a repeated or reordered
 * frame.
 *
 * ## Two formats, agreed once per run
 *
 * This road began at 16 kHz mono because that is what the microphone
 * direction speaks and the number was carried across without anybody choosing
 * it. It is 32 KB/s for the whole desktop's sound, and it is telephone
 * quality: nothing above about 7.2 kHz survives the anti-alias filter, and
 * two channels of a record become one before they ever reach the wire. Right
 * for a meeting; audibly wrong for music, which is what the desktop's output
 * mostly carries.
 *
 * So there are two formats now, and the second one is the default: 48 kHz
 * stereo, 192 KB/s, which is what the sink was already being *loaded* at
 * (`lib/pipesink.js` says why — the module's ring is counted in frames, so a
 * low rate is a long delay) and therefore what the desktop already has in its
 * hand before any arithmetic happens at all. At 48 kHz stereo the whole
 * resampling road degenerates into a copy: `Downsampler`'s factor becomes one
 * and nothing is filtered, folded or downmixed on the way.
 *
 * The old format is the **baseline** and it never goes away, because an app
 * built before this change reads `rate` and `channels` straight out of the
 * `play` instruction and opens a mono track at whatever it finds there. So
 * the instruction keeps carrying the baseline in those two fields, and what
 * is new travels in a field an old build does not read — `offer`. A phone
 * that understands it opens the offered format and *says which format it
 * opened* in its `audio.playing` answer; a phone that does not answers as it
 * always has, and the desktop hears the absence of those fields as the
 * baseline. Neither end has to know the other's version number.
 *
 * The phone's answer is the authority rather than the desktop's request, and
 * that is the point of the round trip: `AudioTrack.getMinBufferSize` refuses
 * some rates on some hardware, and headset mode forces the baseline for its
 * echo canceller's sake. The desktop cannot know any of that; the handset
 * answers with what it actually got.
 *
 * What is deliberately *not* here is a format negotiated per chunk: a frame
 * whose meaning depends on a state the two ends have to agree about is the
 * one bug this whole road is arranged to avoid. The format is fixed for the
 * life of one `stream` number, exactly as `lib/video.js` fixes a picture's
 * size for the life of one camera run.
 */

export const MAGIC = Buffer.from('OCS1')
export const HEADER_BYTES = MAGIC.length + 8

/**
 * The baseline: what an end that has been told nothing else assumes.
 *
 * `lib/mic.js`'s format, and this road's original one. It stays exported
 * under these names because that is what every other end of the link — the
 * phone's `speakerframe.ts`, the suites that hold the two against each other
 * — means by "the format", and because an old app opens exactly this when it
 * reads a `play` instruction it only half understands.
 */
export const RATE = 16000
export const CHANNELS = 1
export const BYTES_PER_SAMPLE = 2

/**
 * What the desktop would rather send, and what it sends unless the handset
 * says otherwise: the sink's own format, carried whole.
 *
 * Forty-eight kilohertz because that is what `lib/pipesink.js` loads the
 * module at anyway and a wire that speaks it needs no resampling at all; two
 * channels because the desktop's output *is* two channels, and this is the
 * one direction where mono was a loss rather than a saving.
 */
export const OFFER_RATE = 48000
export const OFFER_CHANNELS = 2

/**
 * Every rate and channel count either end may name.
 *
 * A closed set rather than a range, and for `lib/pipesink.js`'s arithmetic:
 * the decimator drops whole samples, so a wire rate has to divide the rate
 * the module is loaded at. 44100 does not divide 48000 and is therefore not
 * on this list however much a person might expect it to be — the note in
 * `lib/resample.js` is the long version.
 */
export const RATES = [16000, 48000]
export const CHANNEL_COUNTS = [1, 2]

/**
 * A format from a request, or the nearest thing to one that this speaks.
 *
 * `lib/video.js`'s `readFormat` is the shape being followed, and the reason
 * is the same: what a caller names wins, what it leaves out comes from the
 * defaults behind it, and what nobody has an answer for falls back to the
 * constants — so a `play` instruction with no `offer` in it, or an
 * `audio.playing` answer from a build that has never heard of the field, is a
 * request for the baseline rather than an error. Anything unrecognised is
 * clamped to the baseline rather than refused: a format nobody can play is
 * worse than a format that is merely old.
 */
export function readFormat({ rate, channels } = {}, defaults = {}) {
  const pick = (value, allowed, fallback) => {
    if (value === undefined || value === null || value === '') return fallback
    const n = Math.round(Number(value))
    return allowed.includes(n) ? n : fallback
  }
  const base = defaults || {}
  return {
    rate: pick(rate, RATES, pick(base.rate, RATES, RATE)),
    channels: pick(channels, CHANNEL_COUNTS, pick(base.channels, CHANNEL_COUNTS, CHANNELS)),
  }
}

/** The two numbers as everything else on this road passes them about. */
export const BASELINE = { rate: RATE, channels: CHANNELS }
export const OFFER = { rate: OFFER_RATE, channels: OFFER_CHANNELS }

/** Is this the format an end that knows nothing else would have assumed? */
export const isBaseline = (format) => format?.rate === RATE && format?.channels === CHANNELS

/**
 * How much sound is in one frame: 20 ms, 640 bytes, fifty a second.
 *
 * The microphone's number, for the microphone's reason — a chunk is how long a
 * sample waits before it is sent at all — plus one that belongs to this
 * direction only. What is on the other end is an `AudioTrack`, and a track
 * that is starved plays silence and then plays late; twenty milliseconds is
 * small enough that the phone's own buffer can absorb the jitter of a chunk
 * that lands after its neighbour without ever being empty.
 */
export const CHUNK_MS = 20

/**
 * How many bytes of PCM one chunk carries at a given format.
 *
 * Defaults to the baseline, so every caller that was written when there was
 * only one format still means what it meant. At the offered one a chunk is
 * 3840 bytes rather than 640 — six times the sound, the same twenty
 * milliseconds of it.
 */
export const chunkBytes = (ms = CHUNK_MS, format = BASELINE) => {
  const { rate, channels } = readFormat(format)
  return Math.round((rate * channels * BYTES_PER_SAMPLE * ms) / 1000)
}

/** How many bytes one sample of every channel is: the unit a frame aligns to. */
export const frameBytes = (format = BASELINE) => readFormat(format).channels * BYTES_PER_SAMPLE

/** A frame far larger than a chunk is not one this speaks; refuse it whole. */
export const MAX_CHUNK_BYTES = 64 * 1024

export const bytesPerSecond = (format = BASELINE) => {
  const { rate, channels } = readFormat(format)
  return rate * channels * BYTES_PER_SAMPLE
}

/** Is this decrypted frame desktop sound rather than the JSON everything else is? */
export function isSpeakerFrame(frame) {
  return Buffer.isBuffer(frame) && frame.length >= HEADER_BYTES && frame.subarray(0, MAGIC.length).equals(MAGIC)
}

/** One chunk, on the wire. The desktop is the writer on this road. */
export function buildFrame(stream, seq, pcm) {
  const head = Buffer.alloc(HEADER_BYTES)
  MAGIC.copy(head, 0)
  head.writeUInt32BE(stream >>> 0, MAGIC.length)
  head.writeUInt32BE(seq >>> 0, MAGIC.length + 4)
  return Buffer.concat([head, Buffer.from(pcm)])
}

/**
 * Read one back off the wire — which on this road the desktop only ever does
 * in a suite, because the phone is the reader.
 *
 * It exists here anyway, and it is not ceremony: the phone's own parser
 * (`app/src/lib/speakerframe.ts`) is nine lines of arithmetic in another
 * language, and the only way to know the two agree is to hold one against the
 * other in a test. Throws rather than returning a half-understood frame, for
 * the reason `lib/mic.js` gives: a `{ stream: NaN }` would be dropped much
 * later and much less obviously.
 */
export function parseFrame(frame) {
  if (!isSpeakerFrame(frame)) throw new Error('not a speaker frame')
  const pcm = frame.subarray(HEADER_BYTES)
  if (pcm.length > MAX_CHUNK_BYTES) throw new Error(`speaker chunk of ${pcm.length} bytes is too large`)
  // An odd length is half a sample: the two ends disagree about the format,
  // and every sample after the seam would be shifted by a byte. Better said
  // than played.
  if (pcm.length % BYTES_PER_SAMPLE !== 0) throw new Error('speaker chunk is not a whole number of samples')
  return {
    stream: frame.readUInt32BE(MAGIC.length),
    seq: frame.readUInt32BE(MAGIC.length + 4),
    pcm,
  }
}
