/**
 * One chunk of the desktop's sound, in the shape the phone reads it.
 *
 * The mirror of `daemon/src/lib/speaker.js`, and the mirror of `micframe.ts`
 * in this directory — with the roles swapped. On the microphone road this
 * phone is the *writer*: it builds a frame and the desktop parses it. Here it
 * is the reader, and this is the first binary frame the desktop has ever sent
 * in this project's life.
 *
 * ```
 * "OCS1" || stream:uint32be || seq:uint32be || pcm (s16le, 16 kHz, mono)
 * ```
 *
 * Deliberately a separate file from the thing that drives the player, for the
 * reason `micframe.ts` is separate from `api/mic.ts`: it is a dozen lines of
 * arithmetic that a suite can hold against the daemon's own encoder with no
 * phone, no native module and no socket in the room. `app/test/speakerframe.mjs`
 * does exactly that.
 *
 * The magic is what makes this road possible at all. Every decrypted frame
 * used to go through a `TextDecoder` unconditionally in `api/client.ts`, so a
 * chunk of PCM arriving at the handset would have become a mangled string and
 * then a swallowed `JSON.parse` — fifty times a second, with nothing in any
 * log. Four bytes are what tell the two apart, and they are unambiguous
 * because a JSON frame's first byte is always `{`.
 */

export const MAGIC = new Uint8Array([0x4f, 0x43, 0x53, 0x31]) // "OCS1"
export const HEADER_BYTES = MAGIC.length + 8

/** What the desktop sends, and what the track is opened for. */
export const RATE = 16000
export const CHANNELS = 1
export const BYTES_PER_SAMPLE = 2

/**
 * Twenty milliseconds, which is what the desktop sends.
 *
 * Only a fallback: the `play` instruction carries a `chunkMs`, and the size of
 * a chunk is not something this end has any say in — what it is used for here
 * is the track's own buffer, which wants to be a few chunks deep whatever a
 * chunk turns out to be.
 */
export const CHUNK_MS = 20

/** How many bytes of PCM one chunk carries at the format above. */
export const chunkBytes = (ms: number = CHUNK_MS) => Math.round((RATE * CHANNELS * BYTES_PER_SAMPLE * ms) / 1000)

/** Is this decrypted frame sound rather than the JSON everything else is? */
export function isSpeakerFrame(bytes: Uint8Array): boolean {
  if (bytes.length < HEADER_BYTES) return false
  for (let i = 0; i < MAGIC.length; i += 1) if (bytes[i] !== MAGIC[i]) return false
  return true
}

export type SpeakerChunk = { stream: number; seq: number; pcm: Uint8Array }

/**
 * Read one off the wire.
 *
 * Throws rather than returning a half-understood frame, exactly as the
 * daemon's parser does: what the caller does with a frame it cannot read is
 * drop it, and a `{ stream: NaN }` would be dropped much later and much less
 * obviously — after it had been handed to a track that would play it as noise.
 */
export function parse(bytes: Uint8Array): SpeakerChunk {
  if (!isSpeakerFrame(bytes)) throw new Error('not a speaker frame')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const pcm = bytes.subarray(HEADER_BYTES)
  // An odd length is half a sample: the two ends disagree about the format,
  // and every sample after the seam would be shifted by a byte. A track fed
  // that plays a whistle rather than what was sent.
  if (pcm.length % BYTES_PER_SAMPLE !== 0) throw new Error('speaker chunk is not a whole number of samples')
  return {
    stream: view.getUint32(MAGIC.length, false),
    seq: view.getUint32(MAGIC.length + 4, false),
    pcm,
  }
}

/**
 * The encoder, which this end uses only in its own suite.
 *
 * It is here for the same reason the daemon keeps a `parseFrame` it never
 * calls in anger: a format described twice in two languages is a format that
 * drifts, and the only way to know it has not is for each side to be able to
 * write what the other reads.
 */
export function frame(stream: number, seq: number, pcm: Uint8Array): Uint8Array {
  const out = new Uint8Array(HEADER_BYTES + pcm.length)
  out.set(MAGIC, 0)
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength)
  view.setUint32(MAGIC.length, stream >>> 0, false)
  view.setUint32(MAGIC.length + 4, seq >>> 0, false)
  out.set(pcm, HEADER_BYTES)
  return out
}
