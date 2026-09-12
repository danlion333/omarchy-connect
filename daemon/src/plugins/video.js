import crypto from 'node:crypto'

import { log } from '../lib/log.js'
import {
  CAMERAS,
  Capture,
  MAX_SECONDS,
  parseFrame,
  pathFor,
  readCamera,
  readFormat,
} from '../lib/video.js'
import { loadConfig } from '../lib/config.js'
import {
  DESCRIPTION as SINK_DESCRIPTION,
  NODE_NAME,
  VideoSink,
  available as sinkAvailable,
  reap,
} from '../lib/videosink.js'

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
 * ## The desktop's camera
 *
 * The second consumer is the point of the whole road: `lib/videosink.js`
 * turns those same frames into a camera the rest of the system can pick, so
 * Meet, OBS, Firefox or Zoom show *Omarchy Connect (phone)* and a desktop
 * with no webcam has one. It is a toggle rather than a consequence of
 * streaming, for the reason `plugins/audio.js` gives about its input: a
 * program picks its camera before anybody points it at anything, so the
 * device has to exist as its own decision. `onFrame` is the seam it sits on,
 * and the MJPEG file in the cache is simply the first consumer written
 * against that seam, exactly as the WAV was for sound.
 *
 * ## What this deliberately is not
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
/** Whoever wants the pictures as they land. The desktop camera is one. */
const listeners = new Set()

/** The desktop's camera, when it is switched on. Never more than one. */
let sink = null
/** Undo for the `onFrame` subscription that feeds it. */
let unfeed = null

/**
 * The picture this desktop asks for when nobody says otherwise.
 *
 * Read from the config on every call rather than remembered, exactly as
 * `currentGain` reads the microphone's: `loadConfig` re-reads the file when it
 * has moved (`lib/config.js`), so editing `video` in it takes effect on the
 * next `camera start` without restarting anything.
 */
const configured = () => {
  const wanted = loadConfig().video || {}
  return { camera: readCamera(wanted.camera), ...readFormat({}, wanted) }
}

const format = () => ({ encoding: 'jpeg', ...configured() })

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
  // The format is said whether or not anything is streaming, the way `audio`
  // says its `gain` at rest: what the panel and `camera status` want to show
  // is the picture the next `camera start` will ask for, and a status that
  // only has an answer while the lens is open is no help to anybody deciding
  // whether to open it.
  if (!live) return { streaming: false, ...configured(), device: deviceSummary() }
  return {
    streaming: true,
    stream: live.stream,
    since: live.startedAt,
    camera: live.camera,
    // The phone's numbers, not the desktop's wish. A handset whose sensor has
    // no 1280×720 mode opens the nearest thing it has and says so, and what
    // `camera status` prints has to be the size the file in the cache actually
    // is — anything else is a status that disagrees with `ffprobe`.
    ...live.format,
    // Kept beside it rather than instead of it, because "you asked for 1280
    // and this phone gave you 1024" is the sentence somebody needs when the
    // picture is not the size they set in the config.
    requested: live.requested,
    ...live.capture.summary(),
    device: deviceSummary(),
  }
}

/* ── the phone as this desktop's camera ────────────────────────── */

/**
 * What the camera toggle is doing, whether or not anything is streaming.
 *
 * Two facts kept apart the way `inputSummary` and `streaming` are kept apart
 * in `plugins/audio.js`, because they fail separately: the device can be
 * published while the phone is asleep, and the phone can be filming into a
 * cache file with no device published at all. `hint` is the third: a desktop
 * that cannot do the `/dev/video` half says which command would fix that,
 * rather than offering a switch that silently does the other half instead.
 */
export function deviceSummary() {
  const state = sinkAvailable()
  return {
    node: NODE_NAME,
    description: SINK_DESCRIPTION,
    ...state,
    ...(sink ? sink.summary() : { enabled: false }),
  }
}

/** Is the phone currently published as a camera here? */
export const deviceEnabled = () => Boolean(sink?.running)

/**
 * Switch the desktop camera on or off.
 *
 * Idempotent in both directions, which is what makes it safe as a toggle a
 * panel can press twice: turning on something already on answers with the
 * camera that is already there rather than starting a second node beside it.
 */
export function setDevice(on, { mode = 'auto' } = {}) {
  if (on) {
    if (sink?.running) return deviceSummary()
    const next = configured()
    const state = sinkAvailable()
    if (!state.available) throw new Error(state.hint || 'this desktop cannot publish a camera')
    const started = new VideoSink({
      mode,
      // Whatever the live stream actually negotiated, so a phone that clamped
      // 1280×720 down to what its lens can do is not published at a size it
      // never sends. Nothing streaming yet means the format the next request
      // will ask for, which is the same default the phone clamps towards.
      width: live?.format?.width ?? next.width,
      height: live?.format?.height ?? next.height,
      fps: live?.format?.fps ?? next.fps,
      // A child that died on its own — somebody killed the node, PipeWire went
      // away, the loopback device was unloaded underneath it. The switch has
      // to go back to where the truth is, or the panel offers an "off" for a
      // camera that is already gone.
      onGone: () => {
        sink = null
        unfeed?.()
        unfeed = null
        changed()
      },
    })
    started.start()
    sink = started
    // Subscribed only while the camera is published, so a capture running for
    // the file alone costs nothing extra when the switch is off.
    unfeed = onFrame((jpeg) => started.write(jpeg))
    changed()
    return deviceSummary()
  }
  unfeed?.()
  unfeed = null
  const was = sink ? sink.stop() : { enabled: false }
  sink = null
  if (was.enabled) log.info('the phone is no longer a camera on this desktop')
  changed()
  return deviceSummary()
}

/**
 * Put the published camera on the size the phone is really sending.
 *
 * The device is published *before* the handset has answered — `requestDevice`
 * says why, and that order is not the thing to change: a camera a program can
 * select and see frozen beats no camera at all. The consequence is that the
 * first size it is published at is a guess, the desktop's own request, and a
 * phone with no such mode sends something else. ffmpeg would then scale every
 * frame back to the guess, so a 1280×720 desktop asking a phone that can only
 * do 1024×768 would publish a stretched 720p picture and a `cam status` that
 * disagreed with the file in the cache.
 *
 * So the chain is rebuilt at the size that actually arrives. This is cheap and
 * it happens in the window between the switch and the first frame, when
 * nothing has opened the device yet — a program already reading it would see
 * the source blink, which is why nothing calls this except the answer to a
 * `start` that the switch itself sent.
 */
function retune(chosen) {
  if (!sink?.running) return
  try {
    const moved = sink.retune(chosen)
    if (moved) log.info(`the camera on this desktop is now ${chosen.width}\u00d7${chosen.height} at ${chosen.fps} fps`)
  } catch (err) {
    log.warn(`could not put the camera on ${chosen.width}\u00d7${chosen.height}: ${err.message}`)
  }
}

/**
 * The toggle as a person means it: a camera on this desktop, with a picture
 * in it.
 *
 * `setDevice` is the mechanism and this is the intent. Turning on publishes
 * the device and *then* asks the handset to film, in that order and for
 * `requestInput`'s reason: the device has to exist whether or not the phone
 * answers, because a camera a program can select and see frozen is a better
 * outcome than no camera and an error. A handset that refuses is reported
 * beside a device that is nonetheless there.
 */
export async function requestDevice(op = 'status', { mode = 'auto', ...wanted } = {}) {
  const action = String(op || 'status').toLowerCase()
  if (action === 'status') return deviceSummary()
  if (!['on', 'off', 'start', 'stop', 'enable', 'disable'].includes(action)) {
    throw new Error(`unknown camera device action: ${op}`)
  }

  if (['off', 'stop', 'disable'].includes(action)) {
    // Told unconditionally, exactly as `setOutput(false)` hushes the speaker
    // and as turning the headset off tells the phone even when this desktop
    // thinks it is already out of the mode: the state that matters is the
    // handset's. This used to be asked only when *this* toggle had started
    // the stream, which left the camera filming — indicator lit, `AudioRecord`
    // or `CameraDevice` open — every time the stream had come up any other
    // way: `camera start` from a terminal, the phone offering with
    // `video.offer`, or a second `on` that returned early below and so never
    // set the flag the `off` was looking for. Somebody who took the camera
    // away from this desktop has taken it away from the phone too; a
    // recording that only the desktop knew about is a poor reason to keep a
    // lens open on a device in somebody's pocket.
    if (live) await requestVideo({ op: 'stop' }).outcome.catch(() => null)
    return setDevice(false)
  }

  const state = setDevice(true, { mode })
  if (live || asked) return { ...state, streaming: Boolean(live) }
  try {
    await requestVideo({ op: 'start', ...wanted }).outcome
    return { ...deviceSummary(), streaming: true }
  } catch (err) {
    // The switch worked; the handset did not answer it. Both facts go back.
    return { ...deviceSummary(), streaming: false, phone: err.message }
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
export function requestVideo({ op = 'start', camera, ...wanted } = {}) {
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

  // The config is the base and the call is the override, for both halves of
  // the request: a `camera start --width 1280` is one capture at 1280 and
  // leaves the file alone, while `cam device on`, which names nothing, is
  // whatever the file says. A lens named out loud and wrongly is still an
  // error — that is a person's typo, not a missing setting.
  const wish = loadConfig().video || {}
  if (camera !== undefined && camera !== null && camera !== '' && !CAMERAS.includes(String(camera).toLowerCase())) {
    throw new Error(`unknown camera: ${camera} — it is "back" or "front"`)
  }
  const lens = readCamera(camera, wish.camera)
  const chosen = readFormat(wanted, wish)

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
    // Anything a daemon that was killed rather than stopped left publishing.
    // Here rather than in `setDevice`, because an orphaned child is a camera
    // in every picker on this machine whether or not anybody ever flips this
    // desktop's switch again — `pipesource.js` reaps a stale module for the
    // same reason, one layer down.
    try {
      reap()
    } catch (err) {
      log.debug('could not look for leftover camera processes:', err.message)
    }
  },

  stop() {
    if (live) void finish('the daemon is stopping', { tell: false })
    // Before the listeners are cleared, and synchronously: a child left
    // running by a daemon on its way out is a camera in every picker on this
    // machine, showing whatever the last frame happened to be.
    try {
      if (sink) setDevice(false)
    } catch (err) {
      log.warn(`could not take the phone camera down: ${err.message}`)
    }
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
      cameras: CAMERAS,
      // Whether this desktop can turn the stream into a camera the rest of
      // the system sees. False on a machine with no ffmpeg, and the app draws
      // no button for it — the same bargain `audio.input` makes about
      // pipewire-pulse.
      device: deviceSummary(),
    }
  },

  methods: {
    /**
     * The handset's answer to being asked for its camera. `ok` false is a
     * refusal with a reason — the permission was denied, there is no camera,
     * another app is holding it — and `omarchy-connect camera` prints it
     * rather than timing out on a stream that was never going to arrive.
     */
    'video.started'({ id, ok = true, error, width, height, fps } = {}, ctx = {}) {
      const pending = asked
      if (!pending || pending.id !== id) throw new Error('nothing is waiting on that camera request')
      clearTimeout(pending.timer)
      asked = null
      if (!ok) {
        pending.reject(new Error(error || 'the phone could not open its camera'))
        return { ok: false }
      }
      const file = pathFor()
      // What the handset says it opened, which is the authority on this road
      // exactly as it is for the speaker in `plugins/audio.js`: the phone
      // clamps a request to the sizes its sensor really offers and picks the
      // nearest by pixel count, and until it said so the desktop had no way of
      // knowing which one that was. An app too old to name a size names none,
      // and `readFormat` falls back to what was asked for — which is what this
      // road did for every build before this one.
      const chosen = readFormat({ width, height, fps }, pending.format)
      const moved =
        chosen.width !== pending.format.width ||
        chosen.height !== pending.format.height ||
        chosen.fps !== pending.format.fps
      live = {
        stream: pending.stream,
        session: ctx.session,
        startedAt: Date.now(),
        camera: pending.camera,
        format: chosen,
        requested: pending.format,
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
      log.ok(
        `the phone is streaming its ${pending.camera} camera at ${chosen.width}\u00d7${chosen.height} into ${file}` +
          (moved
            ? ` — the nearest it has to the ${pending.format.width}\u00d7${pending.format.height} at ` +
              `${pending.format.fps} fps it was asked for`
            : ''),
      )
      // Before the resolve, so the terminal that was holding a `cam device on`
      // open prints a device that is already the right size.
      retune(chosen)
      changed()
      pending.resolve({
        ok: true,
        stream: live.stream,
        path: file,
        camera: pending.camera,
        ...chosen,
        requested: pending.format,
      })
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
