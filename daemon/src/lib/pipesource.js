import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { has } from './exec.js'
import { log } from './log.js'

/**
 * The phone's microphone, as a device the rest of the system can see.
 *
 * `plugins/audio.js` already brings live PCM up the encrypted socket and hands
 * it to whoever asked; its first consumer was a WAV in the cache. A file is a
 * fine thing to have and it is not what somebody without a microphone wants.
 * They want Zoom's input list, OBS's input list, `voxtype`'s input list — the
 * ordinary picker every program on this desktop already draws — to contain a
 * line that says *Omarchy Connect (phone)*, and to speak into the handset in
 * their pocket. That is a PipeWire node, not a byte stream, and this file is
 * the piece that turns one into the other.
 *
 * ## Why a FIFO and `module-pipe-source`
 *
 * There are three roads to a node: a native libpipewire client (a C addon this
 * project has no business growing), a `pw-cli`-declared node fed over stdin,
 * or pipewire-pulse's own `module-pipe-source`, which is a source node reading
 * raw PCM out of a named pipe. The third needs nothing installed that is not
 * already here — `pactl` ships with pipewire-pulse, which is what makes
 * `paplay` work in `ringtone.js` — and it takes exactly the format the phone
 * is already sending: `s16le`, 16 kHz, mono, no resampling anywhere.
 *
 * So: `mkfifo`, load the module pointed at the pipe, and write chunks into the
 * write end as they land. The module holds the read end open for as long as it
 * is loaded, which is why opening for writing does not block the daemon even
 * when no program has selected the source yet.
 *
 * ## Nothing may block, and nothing may be believed
 *
 * A pipe with nobody draining it fills — 64 KB on Linux, twenty chunks, two
 * seconds — and an ordinary blocking `write` at that point stops the daemon
 * dead: not the audio, the *daemon*, mid-event-loop, until somebody in another
 * program presses record. That is the failure this whole file is arranged
 * around. The write end is opened `O_NONBLOCK`, a full pipe comes back as
 * `EAGAIN`, and `EAGAIN` means the chunk is dropped and counted. Live sound
 * that nothing is listening to is worth nothing; the daemon is worth a lot.
 *
 * The same reasoning runs the other way when the phone goes quiet. A source
 * whose pipe has no new bytes reads as **silence**, not as an error and not as
 * garbage — verified on this machine with `parec` — so a handset that drops
 * mid-sentence leaves the program on this desktop with a working input that
 * has nothing to say, which is exactly what a microphone in an empty room
 * sounds like. Nothing tears the node down on its own.
 *
 * ## The module outlives nothing
 *
 * A loaded module is global state in somebody else's process. If this daemon
 * exits without unloading it, the source stays in every picker on the machine
 * forever, pointed at a pipe that no longer exists — so `stop()` is
 * deliberately synchronous (`execFileSync`), because `stopPlugins()` does not
 * await, and an unload that returns a promise on the way to `process.exit` is
 * an unload that never happens. `reap()` covers the case where the daemon was
 * killed hard enough that even that did not run: on the way up, any
 * `module-pipe-source` still carrying this source's name is unloaded before a
 * new one is loaded, so there is never a second.
 */

/** The name the module is loaded under — and how an orphan is recognised. */
export const SOURCE_NAME = 'omarchy_connect_phone'

/**
 * What a person reads in the picker. It says *phone* rather than *microphone*
 * because the list it appears in is already a list of microphones, and it says
 * *Omarchy Connect* because that is the thing they would turn off if they
 * wanted it gone.
 */
export const SOURCE_DESCRIPTION = 'Omarchy Connect (phone)'

/** The format the phone already sends. Nothing here resamples anything. */
export const FORMAT = 's16le'
export const RATE = 16000
export const CHANNELS = 1

/**
 * Sleep without an `await`.
 *
 * Everything in this file is synchronous so that it can also run from a signal
 * handler, and the one place that has to wait — the millisecond between the
 * module being loaded and it opening its end of the pipe — cannot become the
 * one place that is not.
 */
function napSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/** Where the pipe lives: runtime state, gone on reboot, not a file anybody keeps. */
export function fifoPath() {
  const runtime = process.env.XDG_RUNTIME_DIR || path.join(os.tmpdir(), `omarchy-connect-${process.getuid?.() ?? 0}`)
  return path.join(runtime, 'omarchy-connect', 'mic.pipe')
}

let probed = null

/**
 * Can this desktop offer the phone as an input at all?
 *
 * `pactl` on PATH is not the question — a machine can have the binary and no
 * server, and a capability that says yes there would put a button on the phone
 * that can only fail. So the probe is a real `pactl info`, cached the way
 * `has()` caches, because a sound server does not appear halfway through a
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

/** Module indices of any `module-pipe-source` still carrying our source name. */
function orphans() {
  try {
    const listing = execFileSync('pactl', ['list', 'modules', 'short'], { encoding: 'utf8', timeout: 5000 })
    return listing
      .split('\n')
      .filter((line) => line.includes('module-pipe-source') && line.includes(`source_name=${SOURCE_NAME}`))
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
      log.warn(`could not unload the phone microphone module ${index}: ${err.message}`)
    }
  }
  return gone
}

/**
 * One loaded source and the pipe feeding it.
 *
 * Deliberately not a singleton: `plugins/audio.js` owns the one instance there
 * is, and a class that could be constructed twice is a class a suite can test
 * without a running daemon.
 */
export class PipeSource {
  constructor({ file = fifoPath(), name = SOURCE_NAME, description = SOURCE_DESCRIPTION } = {}) {
    this.file = file
    this.name = name
    this.description = description
    this.module = null
    this.fd = null
    this.bytes = 0
    this.dropped = 0
    this.startedAt = null
  }

  get running() {
    return this.module !== null
  }

  /**
   * Make the pipe, load the module, open the write end.
   *
   * Synchronous throughout, and on purpose: this happens once when somebody
   * flips a switch, the calls are milliseconds against a local socket, and the
   * alternative is a half-loaded module living between two awaits where a
   * second `start()` can find it.
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

    // The description is quoted twice because it is parsed twice: once out of
    // the module's argument string, and again out of `source_properties` as a
    // property list. One layer of quoting gets a source called "Omarchy".
    let index
    try {
      index = execFileSync(
        'pactl',
        [
          'load-module',
          'module-pipe-source',
          `source_name=${this.name}`,
          `file=${this.file}`,
          `format=${FORMAT}`,
          `rate=${RATE}`,
          `channels=${CHANNELS}`,
          `source_properties="node.description='${this.description}'"`,
        ],
        { encoding: 'utf8', timeout: 10000 },
      ).trim()
    } catch (err) {
      fs.rmSync(this.file, { force: true })
      throw new Error(`pactl could not load the microphone source: ${(err.stderr || err.message).toString().trim()}`)
    }
    this.module = index

    try {
      this.fd = this.openWriteEnd()
    } catch (err) {
      this.stop()
      throw err
    }
    this.bytes = 0
    this.dropped = 0
    this.startedAt = Date.now()
    log.ok(`the phone is now an input on this desktop — "${this.description}" in any picker`)
    return this.summary()
  }

  /**
   * The write end, non-blocking.
   *
   * `ENXIO` is "no reader yet": the module has been told to load but has not
   * opened its side. It is a race of milliseconds rather than a real state, so
   * this waits it out briefly rather than failing a switch the user just
   * flipped.
   */
  openWriteEnd() {
    for (let attempt = 0; attempt < 25; attempt += 1) {
      try {
        return fs.openSync(this.file, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK)
      } catch (err) {
        if (err.code !== 'ENXIO') throw err
        napSync(40)
      }
    }
    throw new Error('the microphone source loaded but never opened its end of the pipe')
  }

  /**
   * One chunk of PCM towards the source. Never throws, never blocks.
   *
   * A short write is treated as a full pipe rather than retried in a loop: the
   * only reason the kernel takes less than a chunk is that there is no room
   * for the rest, and looping there is the blocking write this file exists to
   * avoid, spelled differently.
   */
  write(pcm) {
    if (this.fd === null) return false
    try {
      const wrote = fs.writeSync(this.fd, pcm)
      this.bytes += wrote
      if (wrote < pcm.length) this.dropped += pcm.length - wrote
      return wrote === pcm.length
    } catch (err) {
      if (err.code === 'EAGAIN') {
        // Nobody is reading, or whoever is has fallen behind. Sound with no
        // listener; say nothing, keep the count.
        this.dropped += pcm.length
        return false
      }
      if (err.code === 'EPIPE') {
        // The module went away underneath us — somebody unloaded it by hand.
        log.warn('the phone microphone source disappeared; taking the input down')
        this.stop()
        return false
      }
      log.debug('could not write to the microphone pipe:', err.message)
      this.dropped += pcm.length
      return false
    }
  }

  /**
   * Unload the module, close the pipe, delete it. Synchronous, so that it
   * still runs when the caller is a signal handler on its way to exit.
   */
  stop() {
    const was = this.summary()
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
        log.warn(`could not unload the phone microphone source: ${err.message}`)
      }
      this.module = null
    }
    // Whatever the unload said. A source nobody can reach is better than a
    // pipe left in the runtime directory pointing at nothing.
    reap()
    try {
      fs.rmSync(this.file, { force: true })
    } catch {
      /* gone already */
    }
    this.startedAt = null
    return { ...was, enabled: false }
  }

  summary() {
    return {
      enabled: this.running,
      ...(this.running
        ? {
            source: this.name,
            description: this.description,
            module: this.module,
            file: this.file,
            since: this.startedAt,
            encoding: FORMAT,
            rate: RATE,
            channels: CHANNELS,
            bytes: this.bytes,
            dropped: this.dropped,
          }
        : {}),
    }
  }
}
