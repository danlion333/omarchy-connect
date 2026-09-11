/**
 * One picture from the camera, in the shape the desktop reads it.
 *
 * The mirror of `daemon/src/lib/video.js`, and — exactly as `micframe.ts` is —
 * deliberately a separate file from the thing that drives the capture: this is
 * nine lines of arithmetic that a suite can hold against the daemon's own
 * parser without a phone, a native module or a socket in the room.
 * `app/test/videoframe.mjs` does that.
 *
 * ```
 * "OCV1" || stream:uint32be || seq:uint32be || jpeg
 * ```
 *
 * `stream` is the number the desktop handed out when it asked for the camera;
 * `seq` counts frames within that stream from zero. Neither is needed to
 * *decrypt* anything — the channel's counter nonce already refuses a reordered
 * or repeated frame — and both are there so the desktop can tell a picture of
 * the run it is watching from a picture of the run it stopped, and can notice
 * where the phone could not keep up.
 *
 * The one thing this shares with `OCA1` besides its shape is the reason it has
 * a magic at all: JSON, sound and pictures travel inside the very same
 * encrypted envelope, and the desktop tells them apart by the first four
 * bytes. `OCA1` and `OCV1` differ in the fourth, and JSON starts with `{`.
 */

export const MAGIC = new Uint8Array([0x4f, 0x43, 0x56, 0x31]) // "OCV1"
export const HEADER_BYTES = MAGIC.length + 8

/**
 * What the capture is asked for when the instruction names nothing.
 *
 * The mirror of `daemon/src/lib/video.js`, and only a fallback on this side:
 * every real instruction carries its own numbers, and the handset clamps them
 * to the sizes its sensor publishes. They moved from 640×480 to 720p with the
 * desktop's, so a phone reading an instruction from a build too old to name a
 * size lands where a new desktop would have put it.
 */
export const WIDTH = 1280
export const HEIGHT = 720
export const FPS = 15
/** JPEG quality, 1–100. Seventy is where the artefacts stop being the story. */
export const QUALITY = 70

/**
 * The largest picture the desktop will take. Anything past it is refused
 * whole (`daemon/src/lib/video.js`), so a phone that would have produced one
 * is better off knowing the number than discovering it as silence.
 */
export const MAX_FRAME_BYTES = 512 * 1024

export function frame(stream: number, seq: number, jpeg: Uint8Array): Uint8Array {
  const out = new Uint8Array(HEADER_BYTES + jpeg.length)
  out.set(MAGIC, 0)
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength)
  view.setUint32(MAGIC.length, stream >>> 0, false)
  view.setUint32(MAGIC.length + 4, seq >>> 0, false)
  out.set(jpeg, HEADER_BYTES)
  return out
}
