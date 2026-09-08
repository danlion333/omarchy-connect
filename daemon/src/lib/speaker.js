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
 * ## Why 16 kHz mono, when the sink is 48
 *
 * The channel already speaks 16 kHz mono `s16le`, and the wire keeps speaking
 * it. That is 32 KB/s for the whole desktop's sound, against 192 KB/s for
 * 48 kHz stereo — and it is the difference between a road a phone can hold
 * open on a slow Wi-Fi and one it cannot. The honest cost is that this is
 * telephone quality: fine for a meeting, for a call, for anything anybody
 * would put a phone on the table for, and audibly not a hi-fi. The sink is
 * *loaded* at 48 kHz mono all the same (`lib/pipesink.js` says why: the ring
 * is counted in frames), so pipewire-pulse does the mixing and the channel
 * downmix, and `Downsampler` in `lib/resample.js` takes the rate back down
 * with a real anti-alias filter in front of it rather than by dropping two
 * samples in three.
 *
 * If a later issue wants music, the second format goes here — one more field
 * in the `play` instruction, an `AudioTrack` built to match it on the phone —
 * and both formats fit inside the 1 MB `maxPayload` with room to spare. What
 * is deliberately *not* here is a format negotiated per chunk: a frame whose
 * meaning depends on a state the two ends have to agree about is the one bug
 * this whole road is arranged to avoid.
 */

export const MAGIC = Buffer.from('OCS1')
export const HEADER_BYTES = MAGIC.length + 8

/** The wire's format, and `lib/mic.js`'s. One channel, one rate, both ways. */
export const RATE = 16000
export const CHANNELS = 1
export const BYTES_PER_SAMPLE = 2

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

/** How many bytes of PCM one chunk carries at the format above. */
export const chunkBytes = (ms = CHUNK_MS) => Math.round((RATE * CHANNELS * BYTES_PER_SAMPLE * ms) / 1000)

/** A frame far larger than a chunk is not one this speaks; refuse it whole. */
export const MAX_CHUNK_BYTES = 64 * 1024

export const bytesPerSecond = () => RATE * CHANNELS * BYTES_PER_SAMPLE

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
