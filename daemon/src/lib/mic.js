import fs from 'node:fs'
import path from 'node:path'

import { XDG_CACHE } from './paths.js'
import { log } from './log.js'

/**
 * The phone's microphone, as bytes on this desktop.
 *
 * Everything the app has sent up to now has been a *file*: a photo, a
 * document, a dictation the recorder finished writing before the first byte
 * left the handset. That is the right shape for a thing with an end. It is the
 * wrong shape for a microphone, which has no end — the interesting property of
 * a live microphone is that you can hear it *now*, and a road that only
 * delivers after the person stops speaking cannot carry one.
 *
 * So there is a second road, and this file is the desktop half of its
 * plumbing: the frame the sound travels in, and the thing that writes it down
 * without letting a slow disk turn into an unbounded queue in memory.
 *
 * ## The frame
 *
 * The control channel is already binary and already encrypted
 * (`lib/crypto.js`), and the only thing that was ever inside one of its frames
 * was JSON. Audio goes inside the very same encrypted frames — no second
 * socket, no second handshake, no second key — and is told apart from JSON by
 * a magic prefix, which is unambiguous because a JSON frame's first byte is
 * always `{`:
 *
 * ```
 * "OCA1" || stream:uint32be || seq:uint32be || pcm
 *   4            4                  4          n
 * ```
 *
 * `pcm` is signed 16-bit little-endian, 16 kHz, mono — the format
 * `dictation.js` already resamples to before whisper reads it, and the one
 * `#38` will want to hand to PipeWire. At 100 ms a chunk that is 3200 bytes
 * ten times a second, which is a rate the channel does not notice and a
 * latency a person does not either.
 *
 * `stream` is the number the desktop handed out when it asked for the
 * microphone. It exists so that a chunk from a run that has already been
 * stopped — one that was in flight when the phone was told to stop, or one the
 * phone sent after a reconnect — is recognised and dropped rather than glued
 * onto the end of the next recording.
 *
 * `seq` counts chunks within one stream from zero. The channel's counter nonce
 * already guarantees order and non-repetition for anything that authenticates
 * at all, so `seq` is not there to reorder: it is there so the desktop can
 * *notice* a gap. A gap can only happen one way — the phone dropped a chunk
 * because it could not keep up — and the recording says how many, rather than
 * silently splicing the two sides of a hole together and calling it audio.
 *
 * ## The slow consumer
 *
 * A microphone produces bytes whether or not anything is reading them, which
 * is the one failure mode a file transfer never has. If the disk stalls, or a
 * later consumer (#38) reads slower than the phone speaks, the difference has
 * to go somewhere, and "somewhere" must not be an array that grows until the
 * daemon is killed.
 *
 * `Recorder` therefore holds a queue with a hard ceiling in bytes and drops
 * the *oldest* chunk when it is full. Oldest rather than newest on purpose: if
 * the desktop cannot keep up with a live microphone, the sound nobody has
 * heard yet is worth more than the sound from eight seconds ago. What is lost
 * is counted and reported, so a recording that dropped is a recording that
 * says it dropped.
 */

/** Where a recording lands. The cache, because it is a byproduct, not a file. */
export const AUDIO_DIR = path.join(XDG_CACHE, 'omarchy-connect', 'audio')

export const MAGIC = Buffer.from('OCA1')
export const HEADER_BYTES = MAGIC.length + 8

/** Voice, and the same voice `dictation.js` already asks ffmpeg for. */
export const RATE = 16000
export const CHANNELS = 1
export const BYTES_PER_SAMPLE = 2
/** How much sound is in one frame. Ten a second, 3200 bytes each. */
export const CHUNK_MS = 100

/** A frame far larger than a chunk is not one this speaks; refuse it whole. */
export const MAX_CHUNK_BYTES = 64 * 1024

/**
 * What the desktop will hold in memory when the disk cannot keep up: eight
 * seconds of speech. Small enough that a stalled sink is visible as dropped
 * audio rather than as a growing process, large enough that an ordinary write
 * hiccup costs nothing at all.
 */
export const MAX_QUEUE_BYTES = 256 * 1024

/** Half an hour is a recording; longer than that is a mistake nobody stopped. */
export const MAX_SECONDS = 30 * 60

/** How long a recording stays in the cache, and how many survive regardless. */
const TTL_MS = 24 * 60 * 60 * 1000
const MAX_FILES = 20

export const bytesPerSecond = () => RATE * CHANNELS * BYTES_PER_SAMPLE

/** Is this decrypted frame audio rather than the JSON everything else is? */
export function isAudioFrame(frame) {
  return Buffer.isBuffer(frame) && frame.length >= HEADER_BYTES && frame.subarray(0, MAGIC.length).equals(MAGIC)
}

/** The desktop's own encoder, which exists so the suites can speak the format. */
export function buildFrame(stream, seq, pcm) {
  const head = Buffer.alloc(HEADER_BYTES)
  MAGIC.copy(head, 0)
  head.writeUInt32BE(stream >>> 0, MAGIC.length)
  head.writeUInt32BE(seq >>> 0, MAGIC.length + 4)
  return Buffer.concat([head, Buffer.from(pcm)])
}

/**
 * Read one off the wire. Throws rather than returning a half-understood
 * frame — the caller's answer to a frame it cannot read is to drop it, and a
 * `{ stream: NaN }` would be dropped much later and much less obviously.
 */
export function parseFrame(frame) {
  if (!isAudioFrame(frame)) throw new Error('not an audio frame')
  const pcm = frame.subarray(HEADER_BYTES)
  if (pcm.length > MAX_CHUNK_BYTES) throw new Error(`audio chunk of ${pcm.length} bytes is too large`)
  // An odd length is half a sample, which means the sender and this desktop
  // disagree about the format — better to say so than to write a file whose
  // every later sample is shifted by a byte.
  if (pcm.length % BYTES_PER_SAMPLE !== 0) throw new Error('audio chunk is not a whole number of samples')
  return {
    stream: frame.readUInt32BE(MAGIC.length),
    seq: frame.readUInt32BE(MAGIC.length + 4),
    pcm,
  }
}

/**
 * How much louder the desktop makes what the phone sends, by default.
 *
 * The phone opens `VOICE_RECOGNITION` and deliberately leaves Android's
 * automatic gain off, because a gain that rides over pauses is exactly what
 * ruins a transcription. The price of that honesty is the level: on the
 * handset this was measured on, ordinary speech at arm's length peaks around
 * -15 dBFS and sits near -33 dBFS, which is a recording you have to lean into
 * and a Zoom call where somebody asks you to speak up.
 *
 * So the desktop multiplies. Four is +12 dB: it puts the same speech near
 * -3 dBFS at the peaks with the loudest measured sample still short of the
 * rail, and — because it is a constant and not a compressor — it moves the
 * noise floor by exactly as much as it moves the voice. That is the whole
 * reason a plain multiply was chosen over `AutomaticGainControl` on the phone:
 * the ratio between speech and silence is left exactly where the microphone
 * put it, and nothing swells during a pause.
 */
export const DEFAULT_GAIN = 4

/** The most a person can ask for. Past this every room is a wall of hiss. */
export const MAX_GAIN = 16

/** A configured gain, or the default when it is missing or not a number. */
export function readGain(value) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_GAIN
  return Math.min(n, MAX_GAIN)
}

/**
 * `pcm` again, `gain` times louder, saturating at the rail.
 *
 * A new buffer rather than a multiply in place: what comes out of `parseFrame`
 * is a window onto the frame the socket decrypted, and two consumers read it.
 * A gain of one is the identity and is handed straight back, so a desktop that
 * has turned this off pays nothing for the feature existing.
 *
 * Clipping is a clamp and not a wrap. A sample that overflows is a sample that
 * was going to be ugly whatever we did; ±32767 is the quietest ugly available,
 * whereas letting an int16 wrap turns one loud syllable into a click that is
 * louder than the syllable.
 */
export function amplify(pcm, gain = DEFAULT_GAIN) {
  if (!(gain > 0) || gain === 1) return pcm
  const out = Buffer.allocUnsafe(pcm.length - (pcm.length % BYTES_PER_SAMPLE))
  for (let i = 0; i + BYTES_PER_SAMPLE <= out.length; i += BYTES_PER_SAMPLE) {
    const scaled = Math.round(pcm.readInt16LE(i) * gain)
    out.writeInt16LE(scaled > 32767 ? 32767 : scaled < -32768 ? -32768 : scaled, i)
  }
  return out
}

/**
 * A 44-byte canonical WAV header for `bytes` of PCM.
 *
 * Raw samples would be the honest thing to write and a nuisance to listen to —
 * `paplay` needs to be told the rate, the channels and the encoding, and
 * anybody checking a recording has better things to remember. A WAV is the
 * same bytes with a preamble that says all three, so the file plays by being
 * double-clicked. The sizes are patched in when the recording ends, which is
 * the only moment they are known.
 */
export function wavHeader(bytes) {
  const head = Buffer.alloc(44)
  head.write('RIFF', 0)
  head.writeUInt32LE(36 + bytes, 4)
  head.write('WAVE', 8)
  head.write('fmt ', 12)
  head.writeUInt32LE(16, 16) // PCM fmt chunk length
  head.writeUInt16LE(1, 20) // format 1 = uncompressed PCM
  head.writeUInt16LE(CHANNELS, 22)
  head.writeUInt32LE(RATE, 24)
  head.writeUInt32LE(bytesPerSecond(), 28)
  head.writeUInt16LE(CHANNELS * BYTES_PER_SAMPLE, 32) // block align
  head.writeUInt16LE(BYTES_PER_SAMPLE * 8, 34)
  head.write('data', 36)
  head.writeUInt32LE(bytes, 40)
  return head
}

/** Old first, then merely surplus — the same bargain the agent drops keep. */
export function sweep() {
  let names = []
  try {
    names = fs.readdirSync(AUDIO_DIR)
  } catch {
    return 0
  }
  const now = Date.now()
  const files = names
    .map((name) => {
      try {
        const file = path.join(AUDIO_DIR, name)
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
      log.debug('could not sweep a recording:', err.message)
    }
  }
  return doomed.length
}

/** Never overwrite: two recordings in the same second are two files. */
export function pathFor(stamp = Date.now()) {
  fs.mkdirSync(AUDIO_DIR, { recursive: true, mode: 0o700 })
  sweep()
  const stem = new Date(stamp).toISOString().replace(/[:.]/g, '-').replace('Z', '')
  let candidate = path.join(AUDIO_DIR, `mic-${stem}.wav`)
  for (let n = 2; fs.existsSync(candidate); n += 1) candidate = path.join(AUDIO_DIR, `mic-${stem}-${n}.wav`)
  return candidate
}

/**
 * One recording, on its way to one file, with a ceiling on what it will hold
 * in memory while the file is not keeping up.
 *
 * `sink` is injectable so a suite can be the slow consumer without needing a
 * slow disk: it takes a chunk and returns whatever `Writable.write` returns —
 * false meaning "wait for drain".
 */
export class Recorder {
  constructor({ file, maxQueueBytes = MAX_QUEUE_BYTES, sink = null } = {}) {
    this.file = file
    this.maxQueueBytes = maxQueueBytes
    this.bytes = 0
    this.dropped = 0
    this.gaps = 0
    this.queued = 0
    this.queue = []
    this.closed = false
    this.startedAt = Date.now()
    this.nextSeq = 0
    /** `write` said yes last time, so the next chunk may go straight through. */
    this.ready = true

    if (sink) {
      this.out = sink
    } else {
      this.out = fs.createWriteStream(file)
      // Room for the header, patched with the real lengths on close. Writing
      // it now rather than assembling the file afterwards is what keeps this a
      // stream: a recording that is killed mid-word is still a file on disk
      // with only its length wrong.
      this.out.write(wavHeader(0))
      this.out.on('error', (err) => {
        this.error = err.message
        log.warn(`the recording could not be written: ${err.message}`)
      })
    }
    this.out.on('drain', () => this.flush())
  }

  /** How much sound has actually reached the sink, in seconds. */
  get seconds() {
    return this.bytes / bytesPerSecond()
  }

  /**
   * One chunk in. `seq` is what the phone numbered it; a number that skipped
   * ahead is a hole the phone made and is counted rather than papered over.
   */
  push(pcm, seq = this.nextSeq) {
    if (this.closed) return false
    if (seq > this.nextSeq) this.gaps += seq - this.nextSeq
    this.nextSeq = seq + 1
    this.bytes += pcm.length
    if (this.ready) {
      this.ready = this.out.write(pcm)
      return true
    }
    this.queue.push(pcm)
    this.queued += pcm.length
    // The ceiling. Oldest out first: nobody has heard any of this yet, and the
    // newest chunk is the one closest to what is being said right now.
    while (this.queued > this.maxQueueBytes && this.queue.length > 1) {
      const stale = this.queue.shift()
      this.queued -= stale.length
      this.bytes -= stale.length
      this.dropped += stale.length
    }
    return true
  }

  flush() {
    this.ready = true
    while (this.queue.length) {
      const chunk = this.queue.shift()
      this.queued -= chunk.length
      if (!this.out.write(chunk)) {
        this.ready = false
        return
      }
    }
  }

  /**
   * End it, and patch the header so the file is a WAV rather than a WAV-shaped
   * prefix. Never throws: a recording that could not be finished is still
   * worth reporting on, and the caller is usually a socket that just closed.
   */
  async close() {
    if (this.closed) return this.summary()
    this.closed = true
    this.queue = []
    this.queued = 0
    await new Promise((resolve) => {
      this.out.end(resolve)
      // A sink that never calls back — a test double, a pipe with no
      // reader — must not hold the socket's close handler open.
      setTimeout(resolve, 2000).unref?.()
    })
    if (this.file) {
      try {
        const handle = await fs.promises.open(this.file, 'r+')
        try {
          await handle.write(wavHeader(this.bytes), 0, 44, 0)
        } finally {
          await handle.close()
        }
      } catch (err) {
        log.warn(`the recording's header could not be finished: ${err.message}`)
      }
    }
    return this.summary()
  }

  summary() {
    return {
      path: this.file,
      bytes: this.bytes,
      seconds: Math.round(this.seconds * 100) / 100,
      dropped: this.dropped,
      gaps: this.gaps,
      ...(this.error ? { error: this.error } : {}),
    }
  }
}
