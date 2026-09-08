import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { has } from './exec.js'
import { log } from './log.js'
import { Downsampler } from './resample.js'
import { CHANNELS as WIRE_CHANNELS, CHUNK_MS, RATE as WIRE_RATE, chunkBytes } from './speaker.js'

/**
 * The phone's speaker, as a device the rest of this desktop can pick.
 *
 * `lib/pipesource.js` is the mirror of this file and every argument in it was
 * re-read to write this one, because a mirror is not a copy: there the daemon
 * *writes* into a FIFO and the danger is a full pipe blocking the event loop;
 * here the daemon **reads** a FIFO and the dangers are the opposite two — a
 * pipe nobody drains, and silence mistaken for a broken link.
 *
 * What a person wants out of this is one line in the output picker every
 * program on the machine already draws — *Omarchy Connect (phone)*, beside
 * their speakers and their headset — and for whatever they route into it to
 * come out of the handset in their pocket. That is a PipeWire node, not a byte
 * stream, and this file is the piece that turns the node back into bytes.
 *
 * ## Why a FIFO and `module-pipe-sink`
 *
 * The same three roads the source had, decided the same way. `module-pipe-sink`
 * is a sink node that writes raw PCM into a named pipe; it ships with
 * pipewire-pulse, which is already here because `paplay` plays the ringtone,
 * and it needs no native client and no `pw-cli` graph. Verified on this
 * machine: `pactl load-module module-pipe-sink sink_name=… file=… format=s16le
 * rate=48000 channels=1` gives a sink that shows up in `pactl list sinks
 * short` and in `wpctl status`, and unloading it takes the sink out of every
 * picker on the machine.
 *
 * It also does not block on load, which is the one thing about a FIFO that
 * could have made this road impossible: the module opens the pipe `O_RDWR`, so
 * loading it with nobody reading yet returns immediately rather than hanging
 * until this daemon opens its end.
 *
 * ## Why the module is told a rate the wire does not speak
 *
 * `module-pipe-sink` is `module-pipe-tunnel` underneath — the very same module
 * the source is — so it keeps the same ring of **8192 frames** and steers its
 * clock to keep it that full, with no property that changes it. A delay
 * counted in frames is as long as the frames are:
 *
 * | module rate | ring   |
 * |-------------|--------|
 * | 16 kHz      | 512 ms |
 * | 48 kHz      | 171 ms |
 * | 96 kHz      | 85 ms  |
 *
 * At 16 kHz — which is what the wire speaks, and what would need no
 * arithmetic anywhere — half a second stands between pressing play and hearing
 * it, and a video meeting at half a second out of sync is unusable. So the
 * sink is loaded at a multiple of the wire's rate and `Downsampler` takes the
 * extra samples back out (`lib/resample.js`). Forty-eight kilohertz is the
 * default rather than the source's ninety-six for the reason the two
 * directions differ: the ring here is *ahead* of a Wi-Fi hop rather than
 * behind one, so nothing about it absorbs a late chunk — what absorbs those is
 * the phone's own `AudioTrack` buffer — and a shorter ring here would only
 * mean the daemon has to be woken more often to say the same thing.
 * `OMARCHY_CONNECT_OUTPUT_RATE` moves it for anyone who wants to.
 *
 * Mono, and the sink says so: pipewire-pulse downmixes every stereo program
 * into it on the way, which is both free and better than anything this file
 * would do with two channels it is about to add together anyway.
 *
 * ## Silence is silence, not an outage
 *
 * The asymmetry that is easy to miss. A `pipe-source` with nothing in its pipe
 * reads as silence to whoever selected it — a microphone in an empty room. A
 * `pipe-sink` with nothing playing *writes nothing at all*: verified here, a
 * freshly loaded sink sits `SUSPENDED` and the pipe stays empty until the
 * first program connects to it, after which the module keeps writing — silence
 * included — for as long as it is `IDLE` or `RUNNING`.
 *
 * Both of those have to reach the phone as *nothing happening*, and neither
 * may reach it as a broken stream. So: a tick that reads no bytes sends
 * nothing, and a chunk that is entirely zeroes is counted and dropped rather
 * than sent. Silence costs no traffic, no radio and no battery, and an
 * `AudioTrack` that is not written to underruns into exactly the silence it
 * would have been sent. Nothing tears the stream down for either of them —
 * a person who paused their music has not disconnected their speaker.
 *
 * ## Nothing may block, and nothing may pile up
 *
 * The read end is opened `O_NONBLOCK` for the same reason the source's write
 * end is: a `read` that waits is the event loop that stopped. An empty pipe
 * comes back `EAGAIN` and the tick ends.
 *
 * The pipe filling is this direction's version of the source's dropped chunk.
 * The module writes at real time whether or not anybody is draining, so a
 * daemon that fell behind for a second — a suspended laptop, a busy event
 * loop — comes back to a pipe holding a second of sound that is already too
 * old to play, in front of the sound that is not. Every tick therefore drains
 * everything the pipe has and keeps only the newest `MAX_BACKLOG_MS`; what is
 * dropped is counted, because sound nobody will hear until after the moment it
 * belonged to is worth less than the moment that is arriving. `lib/mic.js`
 * makes the same bargain in the same words for the recording queue.
 *
 * ## The module outlives nothing
 *
 * A loaded module is global state in somebody else's process, so `stop()` is
 * synchronous (`execFileSync`) — `stopPlugins()` does not await, and an unload
 * that returns a promise on the way to `process.exit` is an unload that never
 * happens — and `reap()` unloads any `module-pipe-sink` still carrying this
 * sink's name on the way up, so a daemon that was killed hard cannot leave a
 * second one behind.
 */

/** The name the module is loaded under — and how an orphan is recognised. */
export const SINK_NAME = 'omarchy_connect_phone'

/**
 * What a person reads in the picker. The source's words exactly, and on
 * purpose: they appear in two different lists — inputs and outputs — and
 * somebody who has turned both on should see one name for one phone rather
 * than two names for what they think of as one thing.
 */
export const SINK_DESCRIPTION = 'Omarchy Connect (phone)'

/** The wire's format — but see `RATE`: the module is told more than that. */
export const FORMAT = 's16le'
export const CHANNELS = WIRE_CHANNELS

/**
 * How many frames the module keeps behind every writer, whatever the rate.
 * Not ours to change: `target_buffer` in PipeWire's module-pipe-tunnel.
 */
export const RING_FRAMES = 8192

/** How long that ring lasts at a given rate. The latency this road adds. */
export const ringMs = (rate) => Math.round((RING_FRAMES / rate) * 1000)

/** The multiple of the wire's rate the module is loaded at by default. */
export const DEFAULT_RATE = 48000

/**
 * The rate the module is told, from the environment or the default. Must be a
 * whole multiple of what the wire carries, because the decimator only drops
 * whole samples; anything else falls back to the default with a warning.
 */
export function moduleRate(asked = process.env.OMARCHY_CONNECT_OUTPUT_RATE) {
  if (asked === undefined || asked === '') return DEFAULT_RATE
  const rate = Number(asked)
  if (Number.isInteger(rate) && rate >= WIRE_RATE && rate % WIRE_RATE === 0 && rate <= 768000) return rate
  log.warn(`OMARCHY_CONNECT_OUTPUT_RATE=${asked} is not a multiple of ${WIRE_RATE}; using ${DEFAULT_RATE}`)
  return DEFAULT_RATE
}

export const RATE = moduleRate()

/** How often the pipe is drained. One chunk's worth, the same 20 ms. */
export const POLL_MS = CHUNK_MS

/**
 * The most sound that may stand in front of what is arriving now. A tenth of
 * a second: long enough that an ordinary scheduling hiccup costs nothing,
 * short enough that a person cannot hear the recovery as a delay.
 */
export const MAX_BACKLOG_MS = 100

/**
 * How long a pipe with no writer at all is tolerated before the sink is
 * declared gone.
 *
 * A FIFO read end that comes back with end-of-file rather than `EAGAIN` means
 * nothing holds the write end — which is what somebody unloading the module by
 * hand looks like from here, and it is the mirror of the `EPIPE` the source
 * watches for. It is also what the first few milliseconds after `load-module`
 * look like, before the module has opened its side, so it is only believed
 * after it has held for this long.
 */
const VANISHED_MS = 3000

/** Sleep without an `await`, so that everything here can run from a signal handler. */
function napSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/** Where the pipe lives: runtime state, gone on reboot, not a file anybody keeps. */
export function fifoPath() {
  const runtime = process.env.XDG_RUNTIME_DIR || path.join(os.tmpdir(), `omarchy-connect-${process.getuid?.() ?? 0}`)
  return path.join(runtime, 'omarchy-connect', 'speaker.pipe')
}

let probed = null

/**
 * Can this desktop offer the phone as an output at all?
 *
 * `pactl` on PATH is not the question — a machine can have the binary and no
 * server, and a capability that says yes there would put a button on the phone
 * that can only fail. So the probe is a real `pactl info`, cached the way the
 * source's is, because a sound server does not appear halfway through a
 * session either.
 */
export function available() {
  if (probed !== null) return probed
  if (!has('pactl') || !has('mkfifo')) {
    probed = false
    return probed
  }
  try {
    execFileSync('pactl', ['info'], { stdio: 'ignore', timeout: 5000 })
    probed = true
  } catch {
    probed = false
  }
  return probed
}

/** Only the suites, which change PATH under a daemon that has already looked. */
export function forgetProbe() {
  probed = null
}

/** Module indices of any `module-pipe-sink` still carrying our sink name. */
function orphans() {
  try {
    const listing = execFileSync('pactl', ['list', 'modules', 'short'], { encoding: 'utf8', timeout: 5000 })
    return listing
      .split('\n')
      .filter((line) => line.includes('module-pipe-sink') && line.includes(`sink_name=${SINK_NAME}`))
      .map((line) => line.split('\t')[0]?.trim())
      .filter(Boolean)
  } catch {
    return []
  }
}

/** Unload every module this desktop is still holding for us. Returns how many. */
export function reap() {
  let gone = 0
  for (const index of orphans()) {
    try {
      execFileSync('pactl', ['unload-module', index], { stdio: 'ignore', timeout: 5000 })
      gone += 1
    } catch (err) {
      log.warn(`could not unload the phone speaker module ${index}: ${err.message}`)
    }
  }
  return gone
}

/**
 * One loaded sink and the pipe it writes into.
 *
 * Deliberately not a singleton, for the reason `PipeSource` is not one:
 * `plugins/audio.js` owns the one instance there is, and a class that can be
 * constructed twice is a class a suite can drive without a running daemon.
 */
export class PipeSink {
  constructor({
    file = fifoPath(),
    name = SINK_NAME,
    description = SINK_DESCRIPTION,
    rate = RATE,
    pollMs = POLL_MS,
    onChunk = null,
    onGone = null,
  } = {}) {
    if (!Number.isInteger(rate) || rate < WIRE_RATE || rate % WIRE_RATE !== 0) {
      throw new Error(`the sink rate must be a whole multiple of ${WIRE_RATE}, not ${rate}`)
    }
    this.file = file
    this.name = name
    this.description = description
    this.rate = rate
    this.pollMs = pollMs
    /** Where a chunk of the desktop's sound goes, at the wire's rate. */
    this.onChunk = onChunk
    /** Somebody unloaded the module underneath us. */
    this.onGone = onGone
    this.downsampler = null
    this.module = null
    this.fd = null
    this.timer = null
    /** Wire bytes that did not add up to a whole chunk last tick. */
    this.rest = Buffer.alloc(0)
    this.bytes = 0
    this.chunks = 0
    this.silent = 0
    this.dropped = 0
    this.startedAt = null
    this.emptySince = null
  }

  get running() {
    return this.module !== null
  }

  /** How many bytes of sink-rate PCM one second is. The unit everything here counts in. */
  get bytesPerSecond() {
    return this.rate * CHANNELS * 2
  }

  /**
   * Make the pipe, load the module, open the read end.
   *
   * Synchronous throughout, and for the source's reasons: this happens once
   * when somebody flips a switch, the calls are milliseconds against a local
   * socket, and the alternative is a half-loaded module living between two
   * awaits where a second `start()` can find it.
   */
  start() {
    if (this.running) return this.summary()
    if (!available()) throw new Error('this desktop has no pipewire-pulse — `pactl` cannot reach a sound server')

    // Anything left over from a daemon that was killed rather than stopped.
    // Before the pipe is remade, because unloading the module is what lets go
    // of the old inode.
    reap()

    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 })
    fs.rmSync(this.file, { force: true })
    execFileSync('mkfifo', ['-m', '600', this.file], { stdio: 'ignore', timeout: 5000 })

    // The read end is opened *before* the module, and that ordering is not
    // decoration: a FIFO opened `O_RDONLY | O_NONBLOCK` succeeds with no writer
    // in sight, so this cannot block, and having it open means not one sample
    // the module writes on its way up is written into a pipe with nobody at
    // the other end.
    try {
      this.fd = fs.openSync(this.file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK)
    } catch (err) {
      fs.rmSync(this.file, { force: true })
      throw new Error(`could not open the speaker pipe: ${err.message}`)
    }

    // The description is quoted twice because it is parsed twice: once out of
    // the module's argument string, and again out of `sink_properties` as a
    // property list. One layer of quoting gets a sink called "Omarchy".
    let index
    try {
      index = execFileSync(
        'pactl',
        [
          'load-module',
          'module-pipe-sink',
          `sink_name=${this.name}`,
          `file=${this.file}`,
          `format=${FORMAT}`,
          `rate=${this.rate}`,
          `channels=${CHANNELS}`,
          `sink_properties="node.description='${this.description}'"`,
        ],
        { encoding: 'utf8', timeout: 10000 },
      ).trim()
    } catch (err) {
      try {
        fs.closeSync(this.fd)
      } catch {
        /* nothing to close */
      }
      this.fd = null
      fs.rmSync(this.file, { force: true })
      throw new Error(`pactl could not load the speaker sink: ${(err.stderr || err.message).toString().trim()}`)
    }
    this.module = index
    // The module opens its end within a millisecond or two of `load-module`
    // returning. Nothing depends on having waited — the pipe is already open
    // here and an empty read is an ordinary tick — but it keeps the first
    // reading of `vanished` honest.
    napSync(20)

    this.downsampler = new Downsampler({ factor: this.rate / WIRE_RATE })
    this.rest = Buffer.alloc(0)
    this.bytes = 0
    this.chunks = 0
    this.silent = 0
    this.dropped = 0
    this.emptySince = null
    this.startedAt = Date.now()
    this.timer = setInterval(() => this.drain(), this.pollMs)
    this.timer.unref?.()
    log.ok(`the phone is now an output on this desktop — "${this.description}" in any picker`)
    return this.summary()
  }

  /**
   * Everything the pipe is holding, turned into chunks for the wire.
   *
   * Never throws and never blocks: this runs fifty times a second on a timer
   * nobody is watching, and the one thing it must not do is take the daemon
   * down with it.
   */
  drain() {
    if (this.fd === null) return 0
    const bin = Buffer.allocUnsafe(65536)
    const pieces = []
    let read = 0
    let eof = false
    for (;;) {
      let got = 0
      try {
        got = fs.readSync(this.fd, bin, 0, bin.length, null)
      } catch (err) {
        if (err.code === 'EAGAIN') break
        log.debug('could not read the speaker pipe:', err.message)
        break
      }
      if (got === 0) {
        // No writer at all, as opposed to a writer with nothing to say.
        eof = true
        break
      }
      pieces.push(Buffer.from(bin.subarray(0, got)))
      read += got
      // A single tick will not sit here forever emptying a pipe somebody is
      // filling faster than the wire can carry: whatever is left is read next
      // tick, and the backlog ceiling below is what keeps it from growing.
      if (read >= this.bytesPerSecond) break
    }

    if (read === 0) {
      if (eof) this.checkVanished()
      else this.emptySince = null
      return 0
    }
    this.emptySince = null

    let pcm = Buffer.concat(pieces)
    // What is already too old to play, in front of what is not. Dropped from
    // the front, which is the same bargain `Recorder` makes: nobody has heard
    // any of this, and the newest is the part that belongs to now.
    const ceiling = Math.round((this.bytesPerSecond * MAX_BACKLOG_MS) / 1000)
    if (pcm.length > ceiling) {
      this.dropped += pcm.length - ceiling
      pcm = pcm.subarray(pcm.length - ceiling)
    }
    // A whole number of samples, always: the tail of a half-written sample
    // waits for the rest of itself rather than shifting every sample after it
    // by a byte.
    const usable = pcm.length - (pcm.length % 2)
    if (usable !== pcm.length) pcm = pcm.subarray(0, usable)
    if (usable === 0) return 0

    this.emit(this.downsampler.process(pcm))
    return read
  }

  /** Wire-rate PCM, cut into chunks and handed on. Leftovers wait for next tick. */
  emit(wire) {
    const size = chunkBytes()
    let buf = this.rest.length ? Buffer.concat([this.rest, wire]) : wire
    let at = 0
    while (buf.length - at >= size) {
      const chunk = buf.subarray(at, at + size)
      at += size
      // Silence is not sent. The sink writes zeroes for as long as it is idle
      // rather than suspended, and a phone whose track is simply not written
      // to plays the very same silence for free.
      if (isSilent(chunk)) {
        this.silent += 1
        continue
      }
      this.bytes += chunk.length
      this.chunks += 1
      try {
        this.onChunk?.(Buffer.from(chunk))
      } catch (err) {
        log.debug('a speaker listener threw:', err.message)
      }
    }
    this.rest = at < buf.length ? Buffer.from(buf.subarray(at)) : Buffer.alloc(0)
  }

  /**
   * A pipe with no writer, for longer than a module takes to open one.
   *
   * The mirror of the source's `EPIPE`: somebody unloaded the module by hand,
   * and a sink that is not in anybody's picker any more should not leave this
   * desktop believing it has an output.
   */
  checkVanished() {
    const now = Date.now()
    if (this.emptySince === null) {
      this.emptySince = now
      return
    }
    if (now - this.emptySince < VANISHED_MS) return
    log.warn('the phone speaker sink disappeared; taking the output down')
    this.emptySince = null
    const gone = this.onGone
    this.stop()
    try {
      gone?.()
    } catch (err) {
      log.debug('the speaker teardown threw:', err.message)
    }
  }

  /**
   * Unload the module, close the pipe, delete it. Synchronous, so that it
   * still runs when the caller is a signal handler on its way to exit.
   */
  stop() {
    const was = this.summary()
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    if (this.fd !== null) {
      try {
        fs.closeSync(this.fd)
      } catch {
        /* the module may have gone first */
      }
      this.fd = null
    }
    if (this.module !== null) {
      try {
        execFileSync('pactl', ['unload-module', this.module], { stdio: 'ignore', timeout: 5000 })
      } catch (err) {
        log.warn(`could not unload the phone speaker sink: ${err.message}`)
      }
      this.module = null
    }
    // Whatever the unload said. A sink nobody can reach is better than a pipe
    // left in the runtime directory pointing at nothing.
    reap()
    try {
      fs.rmSync(this.file, { force: true })
    } catch {
      /* gone already */
    }
    this.rest = Buffer.alloc(0)
    this.startedAt = null
    this.emptySince = null
    return { ...was, enabled: false }
  }

  summary() {
    return {
      enabled: this.running,
      ...(this.running
        ? {
            sink: this.name,
            description: this.description,
            module: this.module,
            file: this.file,
            since: this.startedAt,
            encoding: FORMAT,
            rate: this.rate,
            wireRate: WIRE_RATE,
            ringMs: ringMs(this.rate),
            channels: CHANNELS,
            bytes: this.bytes,
            chunks: this.chunks,
            silent: this.silent,
            dropped: this.dropped,
          }
        : {}),
    }
  }
}

/**
 * Is there nothing in this chunk?
 *
 * A 16-bit read rather than a byte-wise one, because that is what a sample is
 * — and exact zero rather than a threshold, because the only thing being
 * recognised here is PipeWire's own silence, which is memset and not a quiet
 * room. Anything a microphone or a decoder produced belongs on the wire even
 * when it is inaudible.
 */
export function isSilent(pcm) {
  for (let i = 0; i + 1 < pcm.length; i += 2) if (pcm.readInt16LE(i) !== 0) return false
  return true
}
