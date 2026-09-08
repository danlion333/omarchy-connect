import crypto from 'node:crypto'

import { log } from '../lib/log.js'
import {
  Capture,
  FPS,
  HEIGHT,
  MAX_SECONDS,
  QUALITY,
  WIDTH,
  parseFrame,
  pathFor,
  readFormat,
} from '../lib/video.js'

/**
 * Watching through the phone's camera from the desktop.
 *
 * The same road `plugins/audio.js` built, carrying pictures. The desktop asks
 * and the handset answers; the answer is held open until the camera is
 * actually open, so a success on the terminal means a camera is running rather
 * than that a message went into the dark. What arrives afterwards is not a
 * request at all — JPEG frames climb the same encrypted socket as raw binary
 * (`lib/video.js` describes them), which is what keeps fifteen pictures a
 * second from costing fifteen JSON parses.
 *
 * One stream at a time, from one handset, into one file. Not a limitation
 * being apologised for: there is one paired phone, and a second concurrent
 * capture would be two views of the same room from the same lens.
 *
 * ## What this deliberately is not
 *
 * **Not a webcam.** There is no `/dev/video`, no `v4l2loopback`, no PipeWire
 * node — a desktop sink is its own issue and its own set of questions about
 * loopback modules and who is allowed to load them. `onFrame` is the seam that
 * one will sit on, and the MJPEG file in the cache is simply the first
 * consumer written against it, exactly as the WAV was for sound. That ordering
 * is on purpose: a road with one honest consumer is a road that can be proved
 * to work before anything harder is built on it.
 *
 * **Not a switch anybody can flip from off the network.** The instruction goes
 * out on the `video` channel, and like `audio` and `phone` that channel is
 * never delivered to a socket that arrived down a tunnel. A microphone in a
 * room you are not in is the one capability where "the pairing is trusted" is
 * not the whole question — and a camera is that argument with the volume up.
 */

/** How long the desktop waits for the handset to say whether it could look. */
const ANSWER_TTL_MS = 15_000

let bus = null

/**
 * The live capture, or null. `session` is the socket feeding it, so a frame
 * arriving on a different socket — a reconnect the phone has not noticed
 * yet — is dropped rather than mixed in.
 */
let live = null
/** The instruction that has gone out and not been answered yet. */
let asked = null
/** Handed out ascending so a late frame from a finished run is recognisable. */
let nextStream = 1
/** Whoever wants the pictures as they land. A desktop sink will be one. */
const listeners = new Set()

const format = () => ({ encoding: 'jpeg', width: WIDTH, height: HEIGHT, fps: FPS, quality: QUALITY })

/**
 * Say, on this desktop only, that the camera picture has moved.
 *
 * The bar panel reads `status.json` and nothing else, so a capture that starts
 * or ends has to reach the file the same way a phone connecting does. An
 * internal bus channel rather than the `video` event the handset subscribes
 * to: this is news for the desktop's own panel, and the phone already knows —
 * it is the one looking.
 */
const changed = () => bus?.emit('video.state')

export function summary() {
  if (!live) return { streaming: false }
  return {
    streaming: true,
    stream: live.stream,
    since: live.startedAt,
    camera: live.camera,
    ...live.format,
    ...live.capture.summary(),
  }
}

/** Live frames, for anything on this desktop that wants to see them. */
export function onFrame(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/**
 * Close the current capture down, whatever ended it — the desktop asking, the
 * phone saying it could not go on, the socket dying, or the ceiling.
 * Always safe to call; always tells the phone, unless the phone is the reason.
 */
async function finish(why, { tell = true } = {}) {
  const current = live
  if (!current) return null
  live = null
  clearTimeout(current.ceiling)
  const result = await current.capture.close()
  log.info(
    `camera stream ${current.stream} ended (${why}): ${result.frames} frames in ${result.seconds}s ` +
      `at ${result.fps} fps into ${result.path}` +
      (result.dropped ? `, ${result.dropped} frames dropped` : '') +
      (result.gaps ? `, ${result.gaps} the phone never sent` : ''),
  )
  if (tell) bus?.emit('event', 'video', { action: 'stop', stream: current.stream })
  changed()
  return { ...result, why }
}

/**
 * The desktop asking for the camera, or asking for it back.
 *
 * Returns the promise the CLI holds open, exactly as `requestMic` does: a
 * success means the handset has actually opened the camera.
 */
export function requestVideo({ op = 'start', camera = 'back', ...wanted } = {}) {
  if (!bus) throw new Error('daemon is not running')
  const action = String(op || 'start').toLowerCase()
  if (!['start', 'stop'].includes(action)) throw new Error(`unknown camera action: ${op}`)

  if (action === 'stop') {
    if (!live) throw new Error('the phone is not streaming its camera')
    // Told before the file is closed rather than after, so the handset stops
    // looking into a socket the desktop has already stopped reading.
    bus.emit('event', 'video', { action: 'stop', stream: live.stream })
    return { outcome: finish('the desktop asked', { tell: false }) }
  }

  if (live) throw new Error('the phone is already streaming its camera')
  if (asked) throw new Error('the phone has already been asked and has not answered yet')

  const lens = String(camera || 'back').toLowerCase()
  if (!['back', 'front'].includes(lens)) throw new Error(`unknown camera: ${camera} — it is "back" or "front"`)
  const chosen = readFormat(wanted)

  const stream = nextStream
  nextStream += 1
  const id = crypto.randomUUID()
  const outcome = new Promise((resolve, reject) => {
    asked = {
      id,
      stream,
      camera: lens,
      format: chosen,
      resolve,
      reject,
      timer: setTimeout(() => {
        asked = null
        reject(new Error('the phone did not answer — it may be off, asleep or off this network'))
      }, ANSWER_TTL_MS),
    }
    asked.timer.unref?.()
  })
  bus.emit('event', 'video', {
    action: 'start',
    id,
    stream,
    camera: lens,
    encoding: 'jpeg',
    ...chosen,
    maxSeconds: MAX_SECONDS,
  })
  return { id, stream, outcome }
}

/**
 * One frame off the wire.
 *
 * Deliberately silent about everything it refuses, for the reason `feed` in
 * `plugins/audio.js` gives: a frame for a stream that has ended is the
 * ordinary consequence of stopping something in flight, and answering each one
 * would turn one stop into a burst of error frames at a phone that is already
 * doing the right thing.
 */
export function feed(session, frame) {
  if (!live || live.session !== session) return false
  let picture
  try {
    picture = parseFrame(frame)
  } catch (err) {
    log.debug('dropping a video frame:', err.message)
    if (live) live.refused += 1
    return false
  }
  if (picture.stream !== live.stream) return false
  live.capture.push(picture.jpeg, picture.seq)
  for (const listener of listeners) {
    try {
      listener(picture.jpeg, live.stream)
    } catch (err) {
      log.debug('a video listener threw:', err.message)
    }
  }
  return true
}

/**
 * The socket carrying the pictures went away.
 *
 * Nothing is left hanging: the file is finished on this side within the tick,
 * and the phone stops on its own because its socket died too. A reconnect
 * starts a fresh stream with a fresh number.
 */
export function hangUp(session) {
  if (!live || live.session !== session) return
  void finish('the socket closed', { tell: false })
}

/** The fence every phone-initiated switch on this channel stands behind. */
function remoteRefused(ctx = {}) {
  if (ctx.via === 'remote') throw new Error('not available on a remote link')
}

export default {
  name: 'video',

  start(eventBus) {
    bus = eventBus
  },

  stop() {
    if (live) void finish('the daemon is stopping', { tell: false })
    asked = null
    listeners.clear()
    bus = null
  },

  capabilities() {
    return {
      // The desktop can always receive; whether the handset can send is the
      // phone's own answer, and it gives it by starting or refusing.
      receive: true,
      ...format(),
      maxSeconds: MAX_SECONDS,
      // Whether the handset may start the capture itself rather than wait to
      // be asked. Advertised so an app talking to an older desktop can say
      // "this desktop is too old for that" instead of drawing a button that
      // answers `unknown method`.
      offer: true,
      cameras: ['back', 'front'],
    }
  },

  methods: {
    /**
     * The handset's answer to being asked for its camera. `ok` false is a
     * refusal with a reason — the permission was denied, there is no camera,
     * another app is holding it — and `omarchy-connect camera` prints it
     * rather than timing out on a stream that was never going to arrive.
     */
    'video.started'({ id, ok = true, error } = {}, ctx = {}) {
      const pending = asked
      if (!pending || pending.id !== id) throw new Error('nothing is waiting on that camera request')
      clearTimeout(pending.timer)
      asked = null
      if (!ok) {
        pending.reject(new Error(error || 'the phone could not open its camera'))
        return { ok: false }
      }
      const file = pathFor()
      live = {
        stream: pending.stream,
        session: ctx.session,
        startedAt: Date.now(),
        camera: pending.camera,
        format: pending.format,
        /** Frames that arrived and were not pictures. Reported, not answered. */
        refused: 0,
        capture: new Capture({ file }),
        // The ceiling is a backstop rather than a feature: something that
        // asked for a camera and then crashed must not leave a handset filming
        // into a file all night.
        ceiling: setTimeout(() => {
          bus?.emit('event', 'video', { action: 'stop', stream: live?.stream })
          void finish(`the ${MAX_SECONDS}s ceiling`, { tell: false })
        }, MAX_SECONDS * 1000),
      }
      live.ceiling.unref?.()
      log.ok(`the phone is streaming its ${pending.camera} camera into ${file}`)
      changed()
      pending.resolve({ ok: true, stream: live.stream, path: file, camera: pending.camera, ...pending.format })
      return { ok: true, stream: live.stream }
    },

    /**
     * The handset saying it has stopped — because the desktop asked, because
     * the user revoked the camera, or because Android took it away. The file
     * is finished either way; the reason is what the desktop prints.
     */
    async 'video.stopped'({ stream, error } = {}, ctx = {}) {
      if (!live || live.session !== ctx.session) return { ok: true }
      if (stream !== undefined && Number(stream) !== live.stream) return { ok: true }
      const result = await finish(error ? `the phone stopped: ${error}` : 'the phone stopped', { tell: false })
      return { ok: true, ...result }
    },

    /** What, if anything, this desktop is watching. */
    'video.status'() {
      return summary()
    },

    /**
     * The phone offering its camera, rather than being asked for it.
     *
     * `audio.offer` says why this exists at length and every word of it holds
     * here: the lens is in somebody's hand, and the only switch for it was on
     * a machine in another room. It is `requestVideo` and nothing else — the
     * same one instruction, the same one stream, the same endings — so a
     * capture started from here stops with `omarchy-connect camera stop`, ends
     * with the socket, and hits the same ceiling.
     */
    async 'video.offer'({ op = 'start', ...rest } = {}, ctx = {}) {
      remoteRefused(ctx)
      const action = String(op || 'start').toLowerCase()
      if (action === 'status') return summary()
      const result = await requestVideo({ op: action, ...rest }).outcome
      // `summary()` is read after the outcome on purpose: by then `live` is
      // either set or gone, so the state the app draws from is the state the
      // press actually produced rather than the one before it.
      return { ...summary(), ...(result?.path ? { path: result.path } : {}) }
    },
  },
}
