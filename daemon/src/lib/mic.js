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
 * `#38` will want to hand to PipeWire. At 20 ms a chunk that is 640 bytes
 * fifty times a second, which is a rate the channel does not notice and a
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
/**
 * How much sound is in one frame: 20 ms, 640 bytes, fifty a second.
 *
 * A chunk is how long a sample waits on the phone before it is sent at all,
 * and it is the burst PipeWire's ring has to swallow on top of what it already
 * holds (`lib/pipesource.js` explains the ring). Ten a second was a round
 * number for a WAV in the cache; fifty is what a microphone somebody is
 * talking through wants, and the channel notices neither. The phone clamps at
 * 20 either way.
 */
export const CHUNK_MS = 20

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
 * How much louder the desktop makes what the phone sends, when a person has
 * taken the knob into their own hands.
 *
 * The phone opens `VOICE_RECOGNITION` and deliberately leaves Android's
 * automatic gain off. That is still the right choice — it is why this handset
 * has a *lower* noise floor than the USB webcam it is being held against
 * (measured on this desk with nobody speaking: phone -71 dBFS raw against the
 * webcam's -51 dBFS) — and it is why every decibel this desktop adds is added
 * to a clean signal rather than to hiss the phone already inflated.
 *
 * The price of that honesty is the level, and #41 tried to pay it with one
 * number. Four is +12 dB, which is the right amount for exactly one loudness
 * of speaking. Measured on the real link afterwards, in a single recording:
 * ordinary speech sat near -19 dBFS while the loud moments already hit the
 * rail — 114 samples pinned at ±32767. One multiplier cannot be both small
 * enough for the shouting and large enough for the murmur, which is the whole
 * reason `Leveller` below exists and is on by default.
 *
 * This number survives as the manual override: `omarchy-connect mic gain N`
 * is a person saying they would rather have a constant than a follower, and a
 * constant is what they then get.
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
 * Whether the follower is in charge, out of the config.
 *
 * Absent means yes. A desktop upgraded from #41 has an `audio.gain` in its
 * config and no `audio.auto` beside it, and that desktop is exactly the one
 * this issue is about — it gets the follower, and keeps its number for the
 * moment it asks for it back.
 */
export function readAuto(value) {
  return value === undefined || value === null ? true : Boolean(value)
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
 * Where the follower aims a syllable's peak, as a fraction of the rail.
 *
 * -8 dBFS. Not louder, because the follower reacts to the chunk it is holding
 * and a consonant can be sharper than the vowel that announced it, so the
 * headroom above this is what absorbs the surprise. Not quieter, because the
 * point of the exercise is to land beside a webcam that puts the same speech
 * around -23 dBFS on its loudest tenth of a second, and a peak here does that
 * with room to spare.
 */
const TARGET_PEAK = 0.4 * 32767

/**
 * The rail the follower will not let a sample past, as a fraction of full
 * scale. Below `TARGET_PEAK` there is nothing to do; above it the gain is cut
 * on the spot rather than eased down, because eased-down is another word for
 * clipped.
 */
const CEILING = 0.92 * 32767

/**
 * The quietest chunk that is allowed to *raise* the gain.
 *
 * Measured with nobody in the room, the handset's raw peaks sit under 60. A
 * gate ten decibels above that is a gate that a breath crosses and a fridge
 * does not, and holding the gain — rather than winding it up — through the
 * silence is the whole of what stops a follower from turning every pause into
 * a swell of hiss. It is also why the comment above `DEFAULT_GAIN` still
 * stands: nothing here swells, it only stops chasing.
 */
const GATE_PEAK = 200

/** The widest the follower will open. Past this the room is louder than the voice. */
export const MAX_AUTO_GAIN = 24

/** The narrowest. A phone held against a mouth needs less than one. */
export const MIN_AUTO_GAIN = 0.5

/** How fast the follower may open up, in decibels per second. */
const RISE_DB_PER_S = 6

/**
 * A slow automatic gain, on the desktop, over the phone's untouched signal.
 *
 * ## Why here and not on the handset
 *
 * Android will hand out an `AutomaticGainControl` on the capture session, and
 * that is the obvious place for this. It is the wrong place for three
 * reasons. It rides *before* the noise floor is known, so it lifts hiss and
 * voice together with no way to tell them apart; it is a different black box
 * on every handset, which makes the desktop's level a property of somebody's
 * silicon; and it cannot be turned off from here, so the manual override
 * would stop meaning anything. Doing it on this side keeps the wire carrying
 * what the microphone actually heard — which is also what a transcriber
 * wants — and keeps the one knob a person can reach.
 *
 * ## What it does
 *
 * Per chunk: look at the loudest sample, work out the gain that would put it
 * at `TARGET_PEAK`, and move towards that gain — but never faster than
 * `RISE_DB_PER_S` upwards, and never at all upwards while the chunk is below
 * `GATE_PEAK`. Downwards is different: when the gain already in hand would
 * push this chunk past `CEILING`, it is cut to whatever keeps the chunk under
 * the rail and it is cut *before* the chunk is written, not eased into over
 * the next few. That asymmetry is the difference between a compressor and a
 * limiter, and a microphone needs to be both: slow enough that a room does
 * not breathe, fast enough that a laugh does not clip.
 *
 * Upward moves are interpolated across the chunk sample by sample so that a
 * step in gain never lands as a step in the waveform. Downward moves are not,
 * deliberately: the whole point of a cut is that it applies to the sample
 * that provoked it.
 *
 * Stateful, and one per stream. `feed()` makes a fresh one for every stream so
 * that a reconnect starts from the same place rather than inheriting a gain
 * chosen for a conversation that has ended.
 *
 * ## And when the phone is a headset
 *
 * The paragraphs above assume the signal the handset was built to send: the
 * unprocessed `VOICE_RECOGNITION` source, no gain riding, no suppression. In
 * headset mode that assumption stops being true — the communication path
 * brings the platform's own gain control and noise suppressor with it, and
 * neither can be switched off from this desktop (`Headset.kt`). This follower
 * is left exactly as it is all the same, and the reason is a measurement
 * rather than a preference: on the handset on this desk, with the desktop gain
 * pinned at 1, the room floor arrived at **-66.5 dBFS** in the mode against
 * **-41.7 dBFS** outside it. The gaps get *quieter*, which is the direction
 * the gate wants; and a signal that arrives already near `TARGET_PEAK` asks
 * this follower for a gain of one, so the two loops have nothing to fight
 * about. `daemon/test/audio-level.mjs` holds both of those as checks.
 */
export class Leveller {
  constructor({ rate = RATE, gain = 1 } = {}) {
    this.rate = rate
    /** The gain in hand — what the previous chunk went out at. */
    this.gain = gain
  }

  /** The most this gain may be multiplied by over one chunk of `samples`. */
  #riseLimit(samples) {
    return 10 ** ((RISE_DB_PER_S * (samples / this.rate)) / 20)
  }

  /**
   * `pcm` levelled. Always a new buffer, for the same reason `amplify` makes
   * one: what `parseFrame` hands over is a window onto the decrypted frame and
   * more than one consumer reads it.
   */
  push(pcm) {
    const usable = pcm.length - (pcm.length % BYTES_PER_SAMPLE)
    const samples = usable / BYTES_PER_SAMPLE
    if (samples === 0) return Buffer.alloc(0)

    let peak = 0
    for (let i = 0; i < usable; i += BYTES_PER_SAMPLE) {
      const v = Math.abs(pcm.readInt16LE(i))
      if (v > peak) peak = v
    }

    const from = this.gain
    let to = from
    if (peak > 0 && peak * from > CEILING) {
      // The limiter. Applied flat across the whole chunk, including the
      // samples before the loud one, because a ramp that arrives after the
      // transient has arrived after the clipping too.
      to = CEILING / peak
    } else if (peak >= GATE_PEAK) {
      const wanted = TARGET_PEAK / peak
      to = wanted > from ? Math.min(wanted, from * this.#riseLimit(samples)) : wanted
    }
    to = Math.min(MAX_AUTO_GAIN, Math.max(MIN_AUTO_GAIN, to))
    const flat = to < from

    const out = Buffer.allocUnsafe(usable)
    for (let i = 0, n = 0; i < usable; i += BYTES_PER_SAMPLE, n += 1) {
      const g = flat ? to : from + ((to - from) * (n + 1)) / samples
      const scaled = Math.round(pcm.readInt16LE(i) * g)
      out.writeInt16LE(scaled > 32767 ? 32767 : scaled < -32768 ? -32768 : scaled, i)
    }
    this.gain = to
    return out
  }
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
