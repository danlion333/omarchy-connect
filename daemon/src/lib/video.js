import fs from 'node:fs'
import path from 'node:path'

import { XDG_CACHE } from './paths.js'
import { log } from './log.js'

/**
 * The phone's camera, as bytes on this desktop.
 *
 * The sibling of `lib/mic.js`, deliberately written as one rather than folded
 * into it. Sound and pictures share a shape — a live thing with no end, coming
 * up the encrypted socket in binary frames the desktop numbers and counts —
 * and they share nothing else. A chunk of PCM is 640 bytes and there are fifty
 * a second; a JPEG is tens of kilobytes and there are fifteen. One is a whole
 * number of samples or it is corrupt; the other is a self-delimiting file that
 * either decodes or does not. Merging them would mean a module whose every
 * constant needed an argument saying which of the two it meant, and the first
 * bug would be a video ceiling applied to audio or the other way round.
 *
 * ## The frame
 *
 * The same bargain `OCA1` struck, with a magic of its own:
 *
 * ```
 * "OCV1" || stream:uint32be || seq:uint32be || jpeg
 *   4            4                  4          n
 * ```
 *
 * Told apart from JSON because a JSON frame's first byte is `{`, and told
 * apart from audio because the fourth byte differs — `isVideoFrame` and
 * `isAudioFrame` cannot both be true of one buffer, and `test/video.mjs` says
 * so out loud rather than leaving it to be noticed.
 *
 * `stream` and `seq` mean exactly what they mean for sound, for exactly the
 * same reasons: a frame from a run that has already been stopped is dropped
 * rather than glued onto the next recording, and a `seq` that skipped is a
 * hole the phone made, counted rather than papered over. On a camera the hole
 * is the ordinary case rather than the alarming one — a handset that cannot
 * encode fast enough drops the frame it is holding, which is the right answer
 * for live pictures and the wrong one for a file transfer — so the count is
 * the number that says how well the link is actually doing.
 *
 * ## Why JPEG and not H.264
 *
 * Because the desktop has no decoder in it and this road has to be *visible*
 * before it is efficient. A file of concatenated JPEGs is an MJPEG stream:
 * `ffprobe` counts its frames, `ffplay` plays it, and `mpv` scrubs it, with
 * nothing on this side doing anything cleverer than appending bytes to a file.
 * The price is the wire — measured on this desk at 640×480 and 15 fps, roughly
 * 25–40 KB a frame, so about half a megabyte a second against the microphone's
 * 32 KB — and that price is worth one release of being able to see what
 * arrived. `MediaCodec` and H.264 are the conversation to have once the
 * traffic is a number somebody has looked at rather than a guess.
 *
 * ## The ceiling
 *
 * `MAX_FRAME_BYTES` is 512 KiB, half the socket's `maxPayload`. That is not a
 * budget for a frame anybody expects — a 640×480 JPEG that reached half a
 * megabyte would be a photograph of static — it is the line past which a frame
 * is refused whole rather than written to a file that would then not decode.
 * The socket would refuse anything over 1 MiB by closing the connection, so a
 * frame refused here is refused *without* costing the link.
 */

/** Where a capture lands. The cache, because it is a byproduct, not a file. */
export const VIDEO_DIR = path.join(XDG_CACHE, 'omarchy-connect', 'video')

export const MAGIC = Buffer.from('OCV1')
export const HEADER_BYTES = MAGIC.length + 8

/** The two lenses a phone is asked for by name, and the one nobody names. */
export const CAMERAS = ['back', 'front']
export const CAMERA = 'back'

/** What the desktop asks for, and what the phone clamps towards. */
export const WIDTH = 640
export const HEIGHT = 480
export const FPS = 15
/** JPEG quality, 1–100. Seventy is where the artefacts stop being the story. */
export const QUALITY = 70

/** Bounds a request may name. The phone clamps to these as well. */
export const MIN_WIDTH = 160
export const MAX_WIDTH = 1920
export const MIN_HEIGHT = 120
export const MAX_HEIGHT = 1080
export const MIN_FPS = 1
export const MAX_FPS = 30

/** A frame past this is not one this speaks; refuse it whole. See above. */
export const MAX_FRAME_BYTES = 512 * 1024

/**
 * What the desktop will hold in memory when the disk cannot keep up.
 *
 * A second and a half of pictures rather than the microphone's eight seconds
 * of sound, and the difference is the point: a late video frame is worth less
 * than a late chunk of audio, because a viewer would rather see now than see
 * everything. Small enough that a stalled sink shows up as dropped frames in
 * the status rather than as a process that grows.
 */
export const MAX_QUEUE_BYTES = 1024 * 1024

/** Ten minutes is a capture; longer is a camera nobody turned off. */
export const MAX_SECONDS = 10 * 60

/** How long a capture stays in the cache, and how many survive regardless. */
const TTL_MS = 24 * 60 * 60 * 1000
const MAX_FILES = 10

/** The two bytes every JPEG begins with. A frame without them is not one. */
const SOI = 0xffd8

/** Is this decrypted frame video rather than JSON or sound? */
export function isVideoFrame(frame) {
  return Buffer.isBuffer(frame) && frame.length >= HEADER_BYTES && frame.subarray(0, MAGIC.length).equals(MAGIC)
}

/** The desktop's own encoder, which exists so the suites can speak the format. */
export function buildFrame(stream, seq, jpeg) {
  const head = Buffer.alloc(HEADER_BYTES)
  MAGIC.copy(head, 0)
  head.writeUInt32BE(stream >>> 0, MAGIC.length)
  head.writeUInt32BE(seq >>> 0, MAGIC.length + 4)
  return Buffer.concat([head, Buffer.from(jpeg)])
}

/**
 * Read one off the wire. Throws rather than returning a half-understood frame,
 * for the reason `parseFrame` in `lib/mic.js` gives: a picture that is not one
 * has to be refused where it arrives, not written into a file that nothing can
 * open an hour later.
 */
export function parseFrame(frame) {
  if (!isVideoFrame(frame)) throw new Error('not a video frame')
  const jpeg = frame.subarray(HEADER_BYTES)
  if (jpeg.length > MAX_FRAME_BYTES) throw new Error(`video frame of ${jpeg.length} bytes is too large`)
  if (jpeg.length === 0) throw new Error('video frame carries no picture')
  // The cheapest possible sanity check, and the one that matters: an MJPEG
  // file is only readable because every frame starts with the marker a decoder
  // resynchronises on. One frame of something else in the middle costs the
  // rest of the file, so it never gets written.
  if (jpeg.readUInt16BE(0) !== SOI) throw new Error('video frame does not begin with a JPEG marker')
  return {
    stream: frame.readUInt32BE(MAGIC.length),
    seq: frame.readUInt32BE(MAGIC.length + 4),
    jpeg,
  }
}

/**
 * What a request may actually ask for, clamped rather than refused.
 *
 * Two layers, and the second one is why this takes a second argument. What a
 * caller names wins; what it leaves out comes from `defaults` — the desktop's
 * own `video` config block, which is where the panel's switch and `cam device
 * on` get their numbers from, since neither of them names any. Only when
 * *neither* has an answer do the constants above decide, which is what keeps a
 * desktop whose config has never been touched behaving as it always did.
 *
 * The defaults are clamped on their own way through, so a config file with
 * `"width": 99999` in it is still a request for 1920 rather than a way around
 * the bounds.
 */
export function readFormat({ width, height, fps, quality } = {}, defaults = {}) {
  const clamp = (value, low, high, fallback) => {
    // `null` and `''` both become 0 through `Number`, which a clamp would then
    // turn into the smallest legal value rather than the default — a request
    // that left a field out would come back as one frame a second.
    if (value === undefined || value === null || value === '') return fallback
    const n = Math.round(Number(value))
    if (!Number.isFinite(n)) return fallback
    return Math.min(high, Math.max(low, n))
  }
  const base = defaults || {}
  return {
    width: clamp(width, MIN_WIDTH, MAX_WIDTH, clamp(base.width, MIN_WIDTH, MAX_WIDTH, WIDTH)),
    height: clamp(height, MIN_HEIGHT, MAX_HEIGHT, clamp(base.height, MIN_HEIGHT, MAX_HEIGHT, HEIGHT)),
    fps: clamp(fps, MIN_FPS, MAX_FPS, clamp(base.fps, MIN_FPS, MAX_FPS, FPS)),
    quality: clamp(quality, 1, 100, clamp(base.quality, 1, 100, QUALITY)),
  }
}

/**
 * Which lens, from a request or from the config behind it.
 *
 * The same shape as `readFormat` and for the same reason: `cam device on`
 * names no camera, so a desktop that has said `front` in its config should get
 * the front one. A word neither side recognises is the back lens rather than
 * an error here — `plugins/video.js` is where an explicitly wrong `--camera`
 * is refused to the person's face, and a typo in a config file should not stop
 * the camera from opening at all.
 */
export function readCamera(value, fallback = CAMERA) {
  const named = String(value ?? '').toLowerCase()
  if (CAMERAS.includes(named)) return named
  const behind = String(fallback ?? '').toLowerCase()
  return CAMERAS.includes(behind) ? behind : CAMERA
}

/** Old first, then merely surplus — the same bargain the recordings keep. */
export function sweep() {
  let names = []
  try {
    names = fs.readdirSync(VIDEO_DIR)
  } catch {
    return 0
  }
  const now = Date.now()
  const files = names
    .map((name) => {
      try {
        const file = path.join(VIDEO_DIR, name)
        const stat = fs.statSync(file)
        return stat.isFile() ? { path: file, at: stat.mtimeMs } : null
      } catch {
        return null
      }
    })
    .filter(Boolean)
    .sort((a, b) => b.at - a.at)
  const doomed = files.filter((file, i) => now - file.at > TTL_MS || i >= MAX_FILES)
  for (const file of doomed) {
    try {
      fs.rmSync(file.path, { force: true })
    } catch (err) {
      log.debug('could not sweep a capture:', err.message)
    }
  }
  return doomed.length
}

/** Never overwrite: two captures in the same second are two files. */
export function pathFor(stamp = Date.now()) {
  fs.mkdirSync(VIDEO_DIR, { recursive: true, mode: 0o700 })
  sweep()
  const stem = new Date(stamp).toISOString().replace(/[:.]/g, '-').replace('Z', '')
  let candidate = path.join(VIDEO_DIR, `cam-${stem}.mjpeg`)
  for (let n = 2; fs.existsSync(candidate); n += 1) candidate = path.join(VIDEO_DIR, `cam-${stem}-${n}.mjpeg`)
  return candidate
}

/**
 * One capture, on its way to one MJPEG file, with a ceiling on what it will
 * hold while the file is not keeping up.
 *
 * `Recorder` in `lib/mic.js` is the model and the differences are all in the
 * unit. Sound queues in bytes because a byte of PCM is a fixed slice of time;
 * pictures queue in whole frames, because half a JPEG is not half a picture,
 * it is a corrupt file. So the ceiling is still bytes — memory is what is
 * being bounded — but nothing is ever split, and the thing dropped to make
 * room is the *oldest whole frame*. Same reasoning as sound: nobody has seen
 * any of this yet, and the newest frame is the one closest to what the camera
 * is pointing at right now.
 *
 * There is no header to patch on close. That is the quiet advantage of MJPEG
 * over a container: a capture killed mid-frame is a file with one truncated
 * picture at the end, and every frame before it still plays.
 */
export class Capture {
  constructor({ file, maxQueueBytes = MAX_QUEUE_BYTES, sink = null } = {}) {
    this.file = file
    this.maxQueueBytes = maxQueueBytes
    this.bytes = 0
    this.frames = 0
    /** Frames thrown away in front of a sink that was not keeping up. */
    this.dropped = 0
    /** Frames the phone never sent, counted from the holes in `seq`. */
    this.gaps = 0
    this.queued = 0
    this.queue = []
    this.closed = false
    this.startedAt = Date.now()
    this.nextSeq = 0
    this.ready = true

    if (sink) {
      this.out = sink
    } else {
      this.out = fs.createWriteStream(file)
      this.out.on('error', (err) => {
        this.error = err.message
        log.warn(`the capture could not be written: ${err.message}`)
      })
    }
    this.out.on('drain', () => this.flush())
  }

  /** How long this capture has been running, in seconds. */
  get seconds() {
    return (Date.now() - this.startedAt) / 1000
  }

  /** Frames a second, over the life of the capture. The link's real answer. */
  get fps() {
    const elapsed = this.seconds
    return elapsed > 0 ? Math.round((this.frames / elapsed) * 10) / 10 : 0
  }

  /**
   * One picture in. `seq` is what the phone numbered it; a number that skipped
   * ahead is a frame the phone could not encode or could not send, and that is
   * counted rather than papered over.
   */
  push(jpeg, seq = this.nextSeq) {
    if (this.closed) return false
    if (seq > this.nextSeq) this.gaps += seq - this.nextSeq
    this.nextSeq = seq + 1
    this.bytes += jpeg.length
    this.frames += 1
    if (this.ready) {
      this.ready = this.out.write(jpeg)
      return true
    }
    this.queue.push(jpeg)
    this.queued += jpeg.length
    // The ceiling. Whole frames, oldest first, and never the last one — a
    // queue emptied down to nothing would drop the very frame that is about to
    // be written.
    while (this.queued > this.maxQueueBytes && this.queue.length > 1) {
      const stale = this.queue.shift()
      this.queued -= stale.length
      this.bytes -= stale.length
      this.frames -= 1
      this.dropped += 1
    }
    return true
  }

  flush() {
    this.ready = true
    while (this.queue.length) {
      const frame = this.queue.shift()
      this.queued -= frame.length
      if (!this.out.write(frame)) {
        this.ready = false
        return
      }
    }
  }

  /**
   * End it. Never throws: a capture that could not be finished is still worth
   * reporting on, and the caller is usually a socket that just closed.
   */
  async close() {
    if (this.closed) return this.summary()
    this.closed = true
    this.endedAt = Date.now()
    this.queue = []
    this.queued = 0
    await new Promise((resolve) => {
      this.out.end(resolve)
      // A sink that never calls back — a test double, a pipe with no reader —
      // must not hold the socket's close handler open.
      setTimeout(resolve, 2000).unref?.()
    })
    return this.summary()
  }

  summary() {
    const elapsed = ((this.endedAt ?? Date.now()) - this.startedAt) / 1000
    return {
      path: this.file,
      bytes: this.bytes,
      frames: this.frames,
      seconds: Math.round(elapsed * 100) / 100,
      fps: elapsed > 0 ? Math.round((this.frames / elapsed) * 10) / 10 : 0,
      dropped: this.dropped,
      gaps: this.gaps,
      ...(this.error ? { error: this.error } : {}),
    }
  }
}
