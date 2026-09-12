import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import { has } from './exec.js'
import { log } from './log.js'
import { FPS, HEIGHT, MAX_QUEUE_BYTES, WIDTH } from './video.js'

/**
 * The phone's camera, as a camera every program on this desktop can pick.
 *
 * `lib/pipesource.js` is the model, one road over: there, live PCM off the
 * socket becomes a PipeWire *source*, so Zoom's microphone list contains the
 * handset. Here the same argument is made about pictures. `plugins/video.js`
 * already brings JPEG frames up the encrypted socket and hands them to
 * whoever asked, and its first consumer was an MJPEG file in the cache. A
 * file is a fine thing to have and it is not what somebody in a video call
 * wants: they want the camera picker in Meet, in OBS, in Firefox to contain a
 * line that says *Omarchy Connect (phone)*.
 *
 * ## Two roads, because a desktop has two kinds of camera in it
 *
 * A Linux desktop does not have one camera list, it has two, and which one a
 * program reads is not something this daemon gets a vote on.
 *
 * **PipeWire.** A node with `media.class=Video/Source` and
 * `media.role=Camera` is what the portal hands to a browser that asks for a
 * camera the modern way. Nothing has to be installed for it: `gst-plugin-
 * pipewire` is already here, and a node is a process, not a kernel object, so
 * it needs no root and disappears when the process does.
 *
 * **`/dev/videoN`.** Everything older, and a good deal that is not old —
 * Chromium and Zoom still enumerate V4L2 devices — reads character devices,
 * and the only way to invent one is the `v4l2loopback` kernel module. That is
 * a `pacman -S` and a `modprobe`, both of which need root, which this daemon
 * does not have and is not asking for. So the module is the *user's* to load,
 * documented in the README, and this file's whole responsibility towards it is
 * to notice whether it is there and to say what to type when it is not.
 *
 * `mode: 'auto'` prefers the loopback device when one exists, because it is
 * the one more programs can see, and falls back to the PipeWire node — which
 * always works — when it does not.
 *
 * ## Why two child processes and not zero
 *
 * What comes off the wire is JPEG. What a camera node carries is raw frames.
 * Something has to decode, and the options are a JPEG decoder written in this
 * repository (no), a GStreamer one (`jpegdec` lives in `gst-plugins-good`,
 * which is *not* installed on an Omarchy desktop — checked), or `ffmpeg`,
 * which is here, is already a dependency of dictation, and decodes MJPEG in
 * its sleep.
 *
 * So the pipeline is `ffmpeg` turning the stream of JPEGs into raw I420 at a
 * fixed size, and then either:
 *
 * - the same `ffmpeg` writing that straight into `/dev/videoN`, one process; or
 * - `gst-launch-1.0 fdsrc ! rawvideoparse ! pipewiresink mode=provide`, two.
 *
 * `rawvideoparse` rather than a caps filter on `fdsrc` because a pipe carries
 * bytes and a node carries frames, and something has to know where one ends:
 * `fdsrc` will happily hand a sink 4096 bytes of half a picture.
 *
 * ## Nothing may block, and a slow consumer may not grow this process
 *
 * The head of the chain is a child's stdin, which is a pipe, which fills.
 * Node's `write` never blocks — it buffers, without limit, which is the same
 * failure wearing a friendlier face: a desktop that stopped reading turns into
 * a daemon whose memory climbs for as long as the phone films. So the queue is
 * bounded exactly the way `Capture` in `lib/video.js` bounds its own, and for
 * the same reason: whole frames, oldest dropped first, because half a JPEG is
 * not half a picture. A viewer would rather see now than see everything.
 *
 * ## Why the last frame is sent again when nothing arrives
 *
 * A camera nobody is pointing at anything is still a camera. When the phone
 * goes quiet — it locked, it walked out of range, the stream was stopped from
 * the terminal — the node would otherwise simply stop producing, and what a
 * program on this desktop sees then depends entirely on that program's own
 * timeout. Resending the last picture once a second costs nothing measurable
 * (one JPEG a second against fifteen) and turns "the link died" into "the
 * picture is frozen", which is what a person looking at a video call already
 * knows how to read.
 *
 * ## Nothing outlives the daemon
 *
 * A child holding a PipeWire node or a loopback device is exactly the kind of
 * global state `pipesource.js` refuses to leave behind, and it survives a
 * `kill -9` in a way a loaded pulse module does too: reparented to init, still
 * publishing, still in every picker. `stop()` kills it synchronously, because
 * `stopPlugins()` does not await and a promise on the way to `process.exit` is
 * a promise nobody keeps. `reap()` covers the harder case: every child is
 * started with `OMARCHY_CONNECT_CAMERA_SINK` in its environment, so on the way
 * up the daemon can walk `/proc`, find anything still carrying that mark, and
 * kill it before publishing a second node beside it.
 */

/** The node's name, and how an orphan of ours is recognised. */
export const NODE_NAME = 'omarchy_connect_camera'

/**
 * What a person reads in the picker. It says *phone* rather than *camera*
 * because the list it appears in is already a list of cameras, and *Omarchy
 * Connect* because that is the thing they would turn off to make it go away.
 */
export const DESCRIPTION = 'Omarchy Connect (phone)'

/**
 * What `v4l2loopback` must be told to call itself for this daemon to adopt the
 * device. The README's `modprobe` line and this constant are one fact written
 * twice; `v4l2-ctl --list-devices` is where a person sees it.
 */
export const CARD_LABEL = DESCRIPTION

/** In the environment of every child, so an orphan can be told from a stranger. */
export const MARK = 'OMARCHY_CONNECT_CAMERA_SINK'

/** The kernel module this desktop cannot install for you. */
export const MODULE = 'v4l2loopback'

/** What to type. Printed rather than run: the daemon has no root and wants none. */
export const INSTALL_HINT = `sudo pacman -S ${MODULE}-dkms`
export const LOAD_HINT = `sudo modprobe ${MODULE} exclusive_caps=1 card_label="${CARD_LABEL}"`

/**
 * One value inside `gst-launch-1.0`'s `stream-properties` structure, spelled
 * so that both parsers in front of it agree on where it ends.
 *
 * There are two, and this took a broken node on a real desktop to notice.
 * `gst-launch-1.0` lexes its own argument first, splitting on unescaped
 * whitespace and treating `(`…`)` as a type cast; only then does GstStructure
 * parse what is left, where a value containing a space has to be quoted. So a
 * description of *Omarchy Connect (phone)* needs the quotes **and** a
 * backslash in front of every space, bracket and quote — anything less and the
 * pipeline dies at run time with `erroneous pipeline: could not set property`,
 * which is a camera that never appears and a switch that turns itself back
 * off a second later.
 */
export const gstValue = (text) => `\\"${String(text).replace(/[\\"'()\s,;=]/g, (c) => `\\${c}`)}\\"`

/** How often the last picture is sent again while the phone says nothing. */
export const KEEPALIVE_MS = 1000

/**
 * Where the kernel lists what it has. Virtual means invented, means loopback.
 *
 * Overridable only so that a suite can build a `/sys`-shaped directory of its
 * own: a check that says "a desktop with a loopback device writes into it"
 * cannot be had on a machine where loading the module needs root, and a
 * feature whose only tested road is the one this laptop happens to have is a
 * feature that breaks on the first desktop that has the other.
 */
const V4L2_CLASS = process.env.OMARCHY_CONNECT_V4L2_CLASS || '/sys/class/video4linux'

let probed = null

/**
 * The parts of this that cannot change while the daemon runs: the binaries and
 * the GStreamer elements. Cached the way `has()` caches, because a plugin does
 * not get installed halfway through a session — and unlike the loopback
 * module, which very much does, because the README just told somebody to load
 * it and they are about to.
 */
function tools() {
  if (probed !== null) return probed
  const ffmpeg = has('ffmpeg')
  let gst = has('gst-launch-1.0') && has('gst-inspect-1.0')
  if (gst) {
    try {
      // Both halves, because either one missing is the same outcome — a
      // pipeline that fails at run time with the word "erroneous" in it — and
      // a capability that says yes here puts a switch on the panel that can
      // only produce that.
      execFileSync('gst-inspect-1.0', ['pipewiresink'], { stdio: 'ignore', timeout: 5000 })
      execFileSync('gst-inspect-1.0', ['rawvideoparse'], { stdio: 'ignore', timeout: 5000 })
    } catch {
      gst = false
    }
  }
  probed = { ffmpeg, gst }
  return probed
}

/** Only the suites, which change PATH under a daemon that has already looked. */
export function forgetProbe() {
  probed = null
  moduleAt = 0
  moduleInstalled = false
}

let moduleAt = 0
let moduleInstalled = false

/**
 * Is the module even on this machine, never mind loaded?
 *
 * Re-asked at most every fifteen seconds rather than cached forever, because
 * the honest answer changes exactly once in a desktop's life — when somebody
 * reads the sentence this probe is here to print and runs the `pacman` in it —
 * and a status that still says "not installed" after that is a status nobody
 * trusts again. Fifteen seconds so that the panel, which reads this every
 * time it redraws, is not running `modinfo` at one hertz.
 */
function moduleAvailable() {
  const now = Date.now()
  if (moduleInstalled) return true
  if (now - moduleAt < 15_000) return moduleInstalled
  moduleAt = now
  if (!has('modinfo')) return false
  try {
    execFileSync('modinfo', [MODULE], { stdio: 'ignore', timeout: 5000 })
    moduleInstalled = true
  } catch {
    moduleInstalled = false
  }
  return moduleInstalled
}

/**
 * Every `/dev/videoN` the kernel invented rather than found.
 *
 * A real camera hangs off a bus, so its entry in `/sys/class/video4linux`
 * points into `/sys/devices/pci…` or `/sys/devices/platform…`; a
 * `v4l2loopback` device points into `/sys/devices/virtual`. That one
 * distinction is the whole test, and it is a far better one than the name,
 * because a person who forgot `card_label` still gets a device this can find
 * and adopt.
 */
export function loopbacks() {
  let names = []
  try {
    names = fs.readdirSync(V4L2_CLASS)
  } catch {
    return []
  }
  const found = []
  for (const name of names.sort()) {
    if (!/^video\d+$/.test(name)) continue
    try {
      const real = fs.realpathSync(path.join(V4L2_CLASS, name))
      if (!real.includes('/devices/virtual/')) continue
      const label = fs.readFileSync(path.join(V4L2_CLASS, name, 'name'), 'utf8').trim()
      found.push({ device: `/dev/${name}`, label })
    } catch {
      /* it went away between the listing and the read; it is not ours then */
    }
  }
  return found
}

/**
 * The one to write into: ours by name if a person followed the README, and
 * otherwise the first loopback on the machine.
 *
 * Preferring the labelled one matters on a desktop that already had a loopback
 * for something else — OBS's virtual camera is the common case — where taking
 * the first one would mean this daemon quietly writing into somebody else's
 * device.
 */
export function pickDevice(devices = loopbacks()) {
  return devices.find((d) => d.label === CARD_LABEL) || devices[0] || null
}

/**
 * What this desktop can actually do, and what to type about the half it
 * cannot.
 *
 * Deliberately not a boolean. There are four states a person can be in — no
 * `ffmpeg` at all, PipeWire only, the module installed but not loaded, a
 * device sitting there ready — and three of them have a different next step.
 * `plugins/video.js` hands this object out whole and `omarchy-connect cam
 * status` prints the sentence in it.
 */
export function available() {
  const { ffmpeg, gst } = tools()
  const devices = loopbacks()
  const device = pickDevice(devices)
  const pipewire = Boolean(ffmpeg && gst)
  const v4l2 = Boolean(ffmpeg && device)
  const modes = [...(v4l2 ? ['v4l2'] : []), ...(pipewire ? ['pipewire'] : [])]
  return {
    available: modes.length > 0,
    modes,
    default: modes[0] ?? null,
    ffmpeg,
    pipewire,
    v4l2,
    module: device ? 'loaded' : moduleAvailable() ? 'installed' : 'missing',
    device: device?.device ?? null,
    deviceLabel: device?.label ?? null,
    cardLabel: CARD_LABEL,
    devices,
    hint: !ffmpeg
      ? 'this desktop has no ffmpeg, so the phone cannot be decoded into a camera at all'
      : device
        ? null
        : moduleAvailable()
          ? `${MODULE} is installed but not loaded — ${LOAD_HINT}`
          : `${MODULE} is not installed — ${INSTALL_HINT}, then ${LOAD_HINT}`,
  }
}

/**
 * Every process still carrying our mark, ours or not.
 *
 * `/proc/<pid>/environ` is readable only by the owner, which is exactly the
 * fence wanted here: this walks its own user's processes and cannot see, let
 * alone kill, anybody else's. A `readFileSync` that throws is a process that
 * either ended mid-walk or was never ours to look at, and both mean the same
 * thing — not an orphan of this daemon's.
 */
export function orphans() {
  const mine = process.pid
  let pids = []
  try {
    pids = fs.readdirSync('/proc').filter((name) => /^\d+$/.test(name))
  } catch {
    return []
  }
  const found = []
  for (const pid of pids) {
    if (Number(pid) === mine) continue
    try {
      const environ = fs.readFileSync(`/proc/${pid}/environ`, 'utf8')
      if (environ.includes(`${MARK}=${NODE_NAME}`)) found.push(Number(pid))
    } catch {
      /* gone, or not ours */
    }
  }
  return found
}

/** Kill everything this desktop is still running for us. Returns how many. */
export function reap() {
  let gone = 0
  for (const pid of orphans()) {
    try {
      process.kill(pid, 'SIGKILL')
      gone += 1
    } catch {
      /* it ended on its own between the walk and the signal */
    }
  }
  if (gone) log.info(`cleared ${gone} camera process${gone === 1 ? '' : 'es'} left over from a daemon that was killed`)
  return gone
}

/**
 * One virtual camera and the child processes behind it.
 *
 * Deliberately not a singleton, for `PipeSource`'s reason: `plugins/video.js`
 * owns the one instance there is, and a class that can be constructed twice is
 * a class a suite can drive without a running daemon.
 */
export class VideoSink {
  constructor({
    mode = 'auto',
    width = WIDTH,
    height = HEIGHT,
    fps = FPS,
    device = null,
    maxQueueBytes = MAX_QUEUE_BYTES,
    onGone = null,
  } = {}) {
    this.wanted = mode
    this.width = width
    this.height = height
    this.fps = fps
    this.device = device
    this.maxQueueBytes = maxQueueBytes
    this.onGone = onGone

    this.mode = null
    this.decoder = null
    this.publisher = null
    this.startedAt = null
    this.frames = 0
    this.bytes = 0
    this.dropped = 0
    this.repeated = 0
    this.last = null
    this.lastAt = null
    this.keepalive = null
    this.queue = []
    this.queued = 0
    this.ready = true
  }

  get running() {
    return this.decoder !== null
  }

  /**
   * Decide which road this is, and refuse with a sentence rather than a stack
   * when it is neither.
   */
  resolveMode() {
    const state = available()
    const asked = String(this.wanted || 'auto').toLowerCase()
    if (!state.ffmpeg) throw new Error('this desktop has no ffmpeg, so it cannot decode the phone into a camera')
    if (asked === 'v4l2') {
      if (!state.v4l2) throw new Error(state.hint || `there is no ${MODULE} device to write into`)
      return { mode: 'v4l2', device: this.device || state.device }
    }
    if (asked === 'pipewire') {
      if (!state.pipewire) throw new Error('this desktop has no gst-plugin-pipewire, so it cannot publish a camera node')
      return { mode: 'pipewire', device: null }
    }
    if (asked !== 'auto') throw new Error(`unknown camera sink mode: ${this.wanted} — it is "auto", "v4l2" or "pipewire"`)
    if (state.v4l2) return { mode: 'v4l2', device: this.device || state.device }
    if (state.pipewire) return { mode: 'pipewire', device: null }
    throw new Error(state.hint || 'this desktop cannot publish a camera')
  }

  /**
   * Start the children.
   *
   * Anything left over from a daemon that was killed goes first, before a
   * second node is published beside it — `PipeSource.start` reaps for exactly
   * the same reason and in exactly the same place.
   */
  start() {
    if (this.running) return this.summary()
    const { mode, device } = this.resolveMode()
    reap()

    const env = { ...process.env, [MARK]: NODE_NAME }
    const size = `${this.width}x${this.height}`

    // `scale` rather than trusting the handset: the format is a request the
    // phone clamps to whatever its lens can do (`lib/video.js`), so a frame
    // may well not be the size that was asked for — and `rawvideoparse` and
    // `/dev/video` both take the size as a promise rather than reading it off
    // each frame. One wrong-sized picture would be a stream of green diagonal
    // stripes rather than an error.
    //
    // `-fps_mode passthrough` because this is a live source with holes in it.
    // Asking ffmpeg for a constant rate makes it fill a gap by duplicating the
    // last frame *when the next one arrives*, which after twenty quiet seconds
    // is three hundred pictures shoved at the sink at once. Frames go out as
    // they come in, and the keepalive below is what fills the silence, at a
    // rate this file chose rather than one a filter inferred.
    const decode = [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'mjpeg',
      '-i',
      'pipe:0',
      '-vf',
      `scale=${this.width}:${this.height}`,
      '-pix_fmt',
      'yuv420p',
      '-fps_mode',
      'passthrough',
    ]

    if (mode === 'v4l2') {
      this.decoder = spawn('ffmpeg', [...decode, '-f', 'v4l2', device], { env, stdio: ['pipe', 'ignore', 'pipe'] })
    } else {
      this.decoder = spawn('ffmpeg', [...decode, '-f', 'rawvideo', 'pipe:1'], { env, stdio: ['pipe', 'pipe', 'pipe'] })
      this.publisher = spawn(
        'gst-launch-1.0',
        [
          '-q',
          'fdsrc',
          'fd=0',
          '!',
          'rawvideoparse',
          'format=i420',
          `width=${this.width}`,
          `height=${this.height}`,
          `framerate=${this.fps}/1`,
          '!',
          'pipewiresink',
          // `provide` is the mode that publishes a node other programs can
          // connect to, rather than playing into one that already exists.
          'mode=provide',
          `stream-properties=props,media.class=Video/Source,media.role=Camera,node.name=${NODE_NAME},` +
            `node.description=${gstValue(DESCRIPTION)}`,
        ],
        { env, stdio: ['pipe', 'ignore', 'pipe'] },
      )
      this.decoder.stdout.pipe(this.publisher.stdin)
      // A broken pipe here is the publisher having died, which `gone` is
      // already about to be told; without a handler it is an uncaught error
      // event that takes the daemon with it.
      this.publisher.stdin.on('error', () => {})
      this.watch(this.publisher, 'the camera node')
    }

    this.watch(this.decoder, 'the camera decoder')
    this.decoder.stdin.on('error', () => {})
    this.decoder.stdin.on('drain', () => this.flush())

    this.mode = mode
    this.deviceInUse = device
    this.startedAt = Date.now()
    this.frames = 0
    this.bytes = 0
    this.dropped = 0
    this.repeated = 0
    this.last = null
    this.lastAt = null
    this.queue = []
    this.queued = 0
    this.ready = true
    this.keepalive = setInterval(() => this.tick(), KEEPALIVE_MS)
    this.keepalive.unref?.()

    log.ok(
      mode === 'v4l2'
        ? `the phone is now a camera on this desktop — ${device} in any camera list`
        : `the phone is now a camera on this desktop — "${DESCRIPTION}" wherever PipeWire cameras are offered`,
    )
    return this.summary()
  }

  /**
   * Publish the same camera at a different size.
   *
   * The size is a promise this chain makes to everything downstream and never
   * checks per frame — `scale=` in ffmpeg, `rawvideoparse` for the node, the
   * `/dev/video` format — so it cannot be changed in a running pipeline. It is
   * changed by building a second one, which is honest: the device really does
   * become a different camera, and the counters start again with it because
   * they counted frames of a different picture.
   *
   * Answers whether anything moved, so the caller only says so when it did.
   * A sink that is not running takes the numbers and will use them when it is
   * started, which is what makes this safe to call from anywhere.
   */
  retune({ width, height, fps } = {}) {
    const next = {
      width: width ?? this.width,
      height: height ?? this.height,
      fps: fps ?? this.fps,
    }
    if (next.width === this.width && next.height === this.height && next.fps === this.fps) return false
    this.width = next.width
    this.height = next.height
    this.fps = next.fps
    if (!this.running) return true
    this.stop()
    try {
      this.start()
    } catch (err) {
      // The chain that was running is down and a second one could not be
      // built — the loopback device was unloaded underneath it, ffmpeg went
      // away. That is the same fact as a child dying on its own, and the
      // switch upstream has to hear it from the same place.
      this.collapse()
      throw err
    }
    return true
  }

  /**
   * A child that ended by itself.
   *
   * Every way that happens means the same thing to everybody upstream — there
   * is no camera any more — so it is reported once, the rest of the chain is
   * torn down, and `onGone` lets the plugin put the switch back where the
   * truth is. stderr is kept to the last line because ffmpeg and
   * `gst-launch-1.0` both explain themselves in one, and a hundred lines of
   * GStreamer debug in the journal helps nobody.
   */
  watch(child, what) {
    let tail = ''
    child.stderr?.on('data', (bytes) => {
      tail = (tail + bytes.toString()).split('\n').filter(Boolean).slice(-1)[0] || tail
    })
    // Both handlers ask whether this is still *the* child rather than only
    // whether something is running. `retune` stops one chain and starts
    // another within the same tick, and an `exit` from the old decoder arrives
    // after the new one is up — without this it would read as the new chain
    // collapsing and take down the camera that had just been resized.
    const current = () => child === this.decoder || child === this.publisher
    child.on('error', (err) => {
      if (!this.running || !current()) return
      log.warn(`${what} could not be started: ${err.message}`)
      this.collapse()
    })
    child.on('exit', (code, signal) => {
      if (!this.running || this.stopping || !current()) return
      log.warn(`${what} ended (${signal || `code ${code}`})${tail ? `: ${tail}` : ''}`)
      this.collapse()
    })
  }

  /** The chain lost a link. Take the rest down and tell whoever asked for it. */
  collapse() {
    const gone = this.onGone
    this.stop()
    try {
      gone?.()
    } catch (err) {
      log.debug('the camera sink listener threw:', err.message)
    }
  }

  /**
   * One picture towards the camera.
   *
   * Never throws and never grows: a decoder that has stopped reading gets
   * whole frames dropped in front of it, oldest first, exactly as `Capture`
   * does when the disk is behind. Returns whether the frame is on its way.
   */
  write(jpeg) {
    if (!this.running) return false
    this.last = jpeg
    this.lastAt = Date.now()
    this.frames += 1
    return this.push(jpeg)
  }

  push(jpeg) {
    this.bytes += jpeg.length
    if (this.ready) {
      this.ready = this.decoder.stdin.write(jpeg)
      return true
    }
    this.queue.push(jpeg)
    this.queued += jpeg.length
    // Never the last one: a queue emptied to nothing would drop the very
    // picture that is about to be written.
    while (this.queued > this.maxQueueBytes && this.queue.length > 1) {
      const stale = this.queue.shift()
      this.queued -= stale.length
      this.bytes -= stale.length
      this.dropped += 1
    }
    return true
  }

  flush() {
    this.ready = true
    while (this.queue.length) {
      const frame = this.queue.shift()
      this.queued -= frame.length
      if (!this.decoder.stdin.write(frame)) {
        this.ready = false
        return
      }
    }
  }

  /**
   * The second that went by with nothing in it. Send the last picture again,
   * so a frozen phone reads as a frozen picture rather than as a camera that
   * vanished. Counted apart from real frames, because it is not one.
   */
  tick() {
    if (!this.running || !this.last) return
    if (Date.now() - (this.lastAt ?? 0) < KEEPALIVE_MS) return
    this.lastAt = Date.now()
    this.repeated += 1
    this.push(this.last)
  }

  /**
   * Kill the children, in the order that keeps the last one from complaining.
   *
   * Synchronous, so that it still runs when the caller is a signal handler on
   * its way out — and `SIGKILL` rather than `SIGTERM` for the publisher,
   * because `gst-launch-1.0` answers a term by starting a graceful shutdown
   * that a process on its way to `exit()` will not be around to see finish.
   */
  stop() {
    const was = this.summary()
    this.stopping = true
    if (this.keepalive) clearInterval(this.keepalive)
    this.keepalive = null
    for (const child of [this.decoder, this.publisher]) {
      if (!child) continue
      try {
        child.stdin?.destroy()
      } catch {
        /* it went first */
      }
      try {
        child.kill('SIGKILL')
      } catch {
        /* already gone */
      }
    }
    this.decoder = null
    this.publisher = null
    this.queue = []
    this.queued = 0
    this.last = null
    this.startedAt = null
    // Whatever the kills said. A process nobody can see is worse than one this
    // daemon has just gone looking for.
    reap()
    this.stopping = false
    return { ...was, enabled: false }
  }

  summary() {
    const state = available()
    return {
      enabled: this.running,
      available: state.available,
      modes: state.modes,
      module: state.module,
      hint: state.hint,
      description: DESCRIPTION,
      node: NODE_NAME,
      ...(this.running
        ? {
            mode: this.mode,
            ...(this.deviceInUse ? { device: this.deviceInUse } : {}),
            since: this.startedAt,
            width: this.width,
            height: this.height,
            fps: this.fps,
            frames: this.frames,
            bytes: this.bytes,
            dropped: this.dropped,
            repeated: this.repeated,
          }
        : {}),
    }
  }
}
