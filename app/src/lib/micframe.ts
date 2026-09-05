/**
 * One chunk of microphone, in the shape the desktop reads it.
 *
 * The mirror of `daemon/src/lib/mic.js`, and deliberately a separate file from
 * the thing that drives the recorder: this is nine lines of arithmetic that a
 * suite can hold against the daemon's own parser without a phone, a native
 * module or a socket in the room. `app/test/micframe.mjs` does exactly that —
 * the same bargain `api/filecrypt` and `lib/filecrypt` already keep.
 *
 * ```
 * "OCA1" || stream:uint32be || seq:uint32be || pcm (s16le, 16 kHz, mono)
 * ```
 *
 * `stream` is the number the desktop handed out when it asked for the
 * microphone; `seq` counts chunks within that stream from zero. Neither is
 * needed to *decrypt* anything — the channel's counter nonce already refuses a
 * reordered or repeated frame — and both are there so the desktop can tell a
 * chunk of the run it is recording from a chunk of the run it stopped, and can
 * notice a hole where the phone could not keep up.
 */

export const MAGIC = new Uint8Array([0x4f, 0x43, 0x41, 0x31]) // "OCA1"
export const HEADER_BYTES = MAGIC.length + 8

/** What the recorder is asked for, and what the desktop expects to receive. */
export const RATE = 16000
export const CHANNELS = 1
export const BYTES_PER_SAMPLE = 2
/**
 * Twenty milliseconds, which is what the desktop asks for.
 *
 * Only a fallback: `mic.ts` uses the `chunkMs` the start instruction carries,
 * and the desktop has always sent one. It was left at a hundred when #42 took
 * the desktop down to twenty for the sake of the PipeWire ring, which made the
 * two ends' constants disagree for no reason anybody would have chosen — the
 * suite next door has been saying so ever since.
 */
export const CHUNK_MS = 20

/** How many bytes of PCM one chunk carries at the format above. */
export const chunkBytes = (ms: number = CHUNK_MS) => Math.round((RATE * CHANNELS * BYTES_PER_SAMPLE * ms) / 1000)

export function frame(stream: number, seq: number, pcm: Uint8Array): Uint8Array {
  const out = new Uint8Array(HEADER_BYTES + pcm.length)
  out.set(MAGIC, 0)
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength)
  view.setUint32(MAGIC.length, stream >>> 0, false)
  view.setUint32(MAGIC.length + 4, seq >>> 0, false)
  out.set(pcm, HEADER_BYTES)
  return out
}
