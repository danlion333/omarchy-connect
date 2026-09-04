import crypto from 'node:crypto'

import { log } from '../lib/log.js'
import { CHUNK_MS, CHANNELS, MAX_SECONDS, RATE, Recorder, parseFrame, pathFor } from '../lib/mic.js'
import { PipeSource, SOURCE_DESCRIPTION, SOURCE_NAME, available as pipeAvailable } from '../lib/pipesource.js'

/**
 * Listening to the phone's microphone from the desktop.
 *
 * The desktop asks and the phone speaks, which is the opposite way round from
 * dictation and is the whole point. Dictation is a person deciding to say
 * something: they hold a button, the recorder writes a file, and the file
 * crosses when they let go. This is the desktop deciding it wants to *hear* —
 * because a person asked for a handset in the next room, or because something
 * on this machine wants a microphone it does not have — and there is no file
 * to wait for, because the sound has not finished happening.
 *
 * So the shape here is `locate`'s rather than `dictation`'s: an instruction on
 * the event bus, an answer from the handset saying whether it could, and then
 * a thing that keeps going until it is stopped. What arrives is not a request
 * at all — the chunks come up the same encrypted socket as raw binary frames
 * (`lib/mic.js` describes them), which is what keeps ten frames a second from
 * costing ten JSON parses and ten `res` round trips.
 *
 * One stream at a time, from one handset, into one file. That is not a
 * limitation being apologised for: there is one paired phone, it has one
 * microphone, and a second concurrent stream would be two copies of the same
 * room. `onChunk` is the seam for anything that wants the sound live rather
 * than afterwards, and the file is simply the first consumer written against
 * it.
 *
 * ## The desktop's input
 *
 * The second consumer is the point of the whole road: `lib/pipesource.js`
 * turns those same chunks into a PipeWire source, so that Zoom, OBS,
 * `voxtype` or anything else with an input list shows *Omarchy Connect
 * (phone)* and a person with no microphone has one. It is a toggle rather
 * than a consequence of streaming, because a program picks its input before
 * anybody speaks: the source has to exist, and be selectable, and be silent,
 * for as long as somebody wants it — and it must not appear and vanish under
 * a running call every time the handset reconnects.
 *
 * Turning it on asks the handset for its microphone as well, when the handset
 * is there and is not already streaming. That is a convenience and not a
 * dependency: the source is loaded either way, and a phone that is asleep
 * leaves a working, silent input rather than a failed switch.
 *
 * **The default input is never touched.** `plugins/phone.js` says the same
 * thing about the hands-free gateway and it is the same rule: appearing in
 * the list is the feature, and quietly becoming the microphone of a machine
 * whose owner did not ask is not.
 *
 * ## Who presses the button
 *
 * Both ends can. The desktop asking is the original road and the reason the
 * shape is `locate`'s. But the microphone is physically in somebody's hand,
 * and until `audio.offer` the only switch for it was on a machine in another
 * room — so a person holding the phone could be recorded by a desktop they
 * were not at, and could not offer the same microphone deliberately. The two
 * meet in `requestMic`: one stream, one instruction, one set of endings,
 * whoever started it.
 *
 * **Not a switch anybody can flip from off the network.** The instruction goes
 * out on the `audio` channel, and like `phone` that channel is never delivered
 * to a socket that arrived down a tunnel: a microphone in a room you are not
 * in is the one capability where "the pairing is trusted" is not the whole
 * question.
 */

/** How long the desktop waits for the handset to say whether it could listen. */
const ANSWER_TTL_MS = 15_000

let bus = null

/**
 * The live stream, or null. `session` is the socket that is feeding it, so a
 * chunk arriving on a different socket — a reconnect the phone has not noticed
 * yet — is dropped rather than mixed in.
 */
let live = null
/** The instruction that has gone out and not been answered yet. */
let asked = null
/** Handed out ascending so a late chunk from a finished run is recognisable. */
let nextStream = 1
/** Whoever wants the chunks as they land — the PipeWire source is one. */
const listeners = new Set()

/** The desktop's input, when it is switched on. Never more than one. */
let input = null
/** Undo for the `onChunk` subscription that feeds it. */
let unfeed = null

const format = () => ({ encoding: 's16le', rate: RATE, channels: CHANNELS, chunkMs: CHUNK_MS })

export function summary() {
  const desktop = { input: inputSummary() }
  if (!live) return { streaming: false, ...desktop }
  return {
    streaming: true,
    stream: live.stream,
    since: live.startedAt,
    ...live.recorder.summary(),
    ...desktop,
  }
}

/** What the input toggle is doing, whether or not anything is streaming. */
export function inputSummary() {
  return {
    available: pipeAvailable(),
    name: SOURCE_NAME,
    description: SOURCE_DESCRIPTION,
    ...(input ? input.summary() : { enabled: false }),
  }
}

/**
 * Switch the desktop input on or off.
 *
 * Idempotent in both directions, which is what makes it safe as a toggle a
 * phone can press: turning on something already on answers with the source
 * that is already there rather than loading a second module beside it.
 */
export function setInput(on) {
  if (on) {
    if (input?.running) return inputSummary()
    if (!pipeAvailable()) throw new Error('this desktop has no pipewire-pulse, so it cannot offer the phone as an input')
    const source = new PipeSource()
    source.start()
    input = source
    // Subscribed only while the source is loaded, so a stream that is running
    // for the file alone costs nothing extra when the input is off.
    unfeed = onChunk((pcm) => source.write(pcm))
    return inputSummary()
  }
  unfeed?.()
  unfeed = null
  const was = input ? input.stop() : { enabled: false }
  input = null
  if (was.enabled !== undefined) log.info('the phone is no longer an input on this desktop')
  return { available: pipeAvailable(), name: SOURCE_NAME, description: SOURCE_DESCRIPTION, enabled: false }
}

/** Is the phone currently offered as an input here? */
export const inputEnabled = () => Boolean(input?.running)

/**
 * Did this toggle start the stream that is running? Only then does turning
 * the input off stop it — somebody who ran `mic start` for the recording and
 * then switched the input on has not asked for their recording to end.
 */
let startedTheStream = false

/**
 * The toggle as a person means it: an input on this desktop, with sound in it.
 *
 * `setInput` is the mechanism and this is the intent. Turning on loads the
 * source and *then* asks the handset to speak, because the source must exist
 * whether or not the phone answers: a silent input a program can select is a
 * far better outcome than no input and an error, and the phone can be asked
 * again with `mic start` once it wakes up. A handset that refuses is reported
 * beside a source that is nonetheless there.
 */
export async function requestInput(op = 'status') {
  const action = String(op || 'status').toLowerCase()
  if (action === 'status') return inputSummary()
  if (!['on', 'off', 'start', 'stop', 'enable', 'disable'].includes(action)) {
    throw new Error(`unknown input action: ${op}`)
  }

  if (['off', 'stop', 'disable'].includes(action)) {
    const stopping = startedTheStream && live ? requestMic({ op: 'stop' }).outcome.catch(() => null) : null
    startedTheStream = false
    await stopping
    return setInput(false)
  }

  const state = setInput(true)
  if (live || asked) return { ...state, streaming: Boolean(live) }
  try {
    await requestMic({ op: 'start' }).outcome
    startedTheStream = true
    return { ...inputSummary(), streaming: true }
  } catch (err) {
    // The switch worked; the handset did not answer it. Both facts go back.
    return { ...inputSummary(), streaming: false, phone: err.message }
  }
}

/** Live chunks, for anything on this desktop that wants to hear them. */
export function onChunk(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/**
 * Close the current stream down, whatever ended it — the desktop asking, the
 * phone saying it could not go on, the socket dying, or the half-hour ceiling.
 * Always safe to call; always tells the phone, unless the phone is the reason.
 */
async function finish(why, { tell = true } = {}) {
  const current = live
  if (!current) return null
  live = null
  clearTimeout(current.ceiling)
  const result = await current.recorder.close()
  log.info(
    `microphone stream ${current.stream} ended (${why}): ${result.seconds}s in ${result.path}` +
      (result.dropped ? `, ${result.dropped} bytes dropped` : ''),
  )
  if (tell) bus?.emit('event', 'audio', { action: 'stop', stream: current.stream })
  return { ...result, why }
}

/**
 * The desktop asking for the microphone, or asking for it back.
 *
 * Returns the promise the CLI holds open, exactly as `requestLocate` does: a
 * success means the handset has actually started recording, not that a message
 * went into the dark.
 */
export function requestMic({ op = 'start' } = {}) {
  if (!bus) throw new Error('daemon is not running')
  const action = String(op || 'start').toLowerCase()
  if (!['start', 'stop'].includes(action)) throw new Error(`unknown microphone action: ${op}`)

  if (action === 'stop') {
    if (!live) throw new Error('the phone is not streaming its microphone')
    // Told before the file is closed rather than after, so the handset stops
    // speaking into a socket the desktop has already stopped listening on.
    bus.emit('event', 'audio', { action: 'stop', stream: live.stream })
    return { outcome: finish('the desktop asked', { tell: false }) }
  }

  if (live) throw new Error('the phone is already streaming its microphone')
  if (asked) throw new Error('the phone has already been asked and has not answered yet')

  const stream = nextStream
  nextStream += 1
  const id = crypto.randomUUID()
  const outcome = new Promise((resolve, reject) => {
    asked = {
      id,
      stream,
      resolve,
      reject,
      timer: setTimeout(() => {
        asked = null
        reject(new Error('the phone did not answer — it may be off, asleep or off this network'))
      }, ANSWER_TTL_MS),
    }
    asked.timer.unref?.()
  })
  bus.emit('event', 'audio', {
    action: 'start',
    id,
    stream,
    ...format(),
    maxSeconds: MAX_SECONDS,
  })
  return { id, stream, outcome }
}

/**
 * One chunk off the wire.
 *
 * Deliberately silent about everything it refuses. A chunk for a stream that
 * has ended is the ordinary consequence of stopping something that is in
 * flight, and answering each one would turn one stop into a hundred error
 * frames going back at a phone that is already doing the right thing.
 */
export function feed(session, frame) {
  if (!live || live.session !== session) return false
  let chunk
  try {
    chunk = parseFrame(frame)
  } catch (err) {
    log.debug('dropping an audio frame:', err.message)
    return false
  }
  if (chunk.stream !== live.stream) return false
  live.recorder.push(chunk.pcm, chunk.seq)
  for (const listener of listeners) {
    try {
      listener(chunk.pcm, live.stream)
    } catch (err) {
      log.debug('an audio listener threw:', err.message)
    }
  }
  return true
}

/**
 * The socket carrying the sound went away.
 *
 * Nothing is left hanging: the file is finished on this side within the tick,
 * and the phone stops on its own because its socket died too — it has no
 * desktop left to send to. A reconnect starts a fresh stream with a fresh
 * number, so nothing from the dead one can be glued onto it.
 */
export function hangUp(session) {
  if (!live || live.session !== session) return
  void finish('the socket closed', { tell: false })
}

/**
 * The fence every phone-initiated switch on this channel stands behind.
 *
 * The `audio` *events* are already kept off a tunnelled socket in the server's
 * fan-out, which is what stops a desktop instructing a handset it cannot see.
 * This is the other direction: a request arriving from one. Refusing it here
 * rather than trusting the fan-out matters, because a method that starts a
 * stream is a method that turns a microphone on, and "the pairing is trusted"
 * is not the whole question when the room is one nobody at this desktop can
 * look into.
 */
function remoteRefused(ctx = {}) {
  if (ctx.via === 'remote') throw new Error('not available on a remote link')
}

export default {
  name: 'audio',

  start(eventBus) {
    bus = eventBus
  },

  stop() {
    startedTheStream = false
    if (live) void finish('the daemon is stopping', { tell: false })
    // Before the listeners are cleared, and synchronously: a module left
    // loaded by a daemon on its way out is a source in every picker on this
    // machine, pointing at a pipe that no longer exists.
    try {
      if (input) setInput(false)
    } catch (err) {
      log.warn(`could not take the phone input down: ${err.message}`)
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
      // Whether the handset may start the stream itself rather than wait to
      // be asked. Advertised so an app talking to an older desktop can say
      // "this desktop is too old for that" instead of drawing a button that
      // answers `unknown method`.
      offer: true,
      // Whether this desktop can turn the stream into an input the rest of
      // the system sees. False on a machine without pipewire-pulse, and the
      // app draws no button for it — the same bargain `dictation` and
      // `media` already make about `voxtype` and `wpctl`.
      input: inputSummary(),
    }
  },

  methods: {
    /**
     * The handset's answer to being asked for its microphone. `ok` false is a
     * refusal with a reason — the permission was denied, the phone has no
     * native recorder — and the desktop's `omarchy-connect mic` prints it
     * rather than timing out on a stream that was never going to arrive.
     */
    'audio.started'({ id, ok = true, error } = {}, ctx = {}) {
      const pending = asked
      if (!pending || pending.id !== id) throw new Error('nothing is waiting on that microphone request')
      clearTimeout(pending.timer)
      asked = null
      if (!ok) {
        pending.reject(new Error(error || 'the phone could not open its microphone'))
        return { ok: false }
      }
      const file = pathFor()
      live = {
        stream: pending.stream,
        session: ctx.session,
        startedAt: Date.now(),
        recorder: new Recorder({ file }),
        // The half hour is a backstop rather than a feature: something that
        // asked for a microphone and then crashed must not leave a handset
        // recording into a file all night.
        ceiling: setTimeout(() => {
          bus?.emit('event', 'audio', { action: 'stop', stream: live?.stream })
          void finish(`the ${MAX_SECONDS}s ceiling`, { tell: false })
        }, MAX_SECONDS * 1000),
      }
      live.ceiling.unref?.()
      log.ok(`the phone is streaming its microphone into ${file}`)
      pending.resolve({ ok: true, stream: live.stream, path: file, ...format() })
      return { ok: true, stream: live.stream }
    },

    /**
     * The handset saying it has stopped — because the desktop asked, because
     * the user revoked the microphone, or because Android took it away. The
     * file is finished either way; the reason is what the desktop prints.
     */
    async 'audio.stopped'({ stream, error } = {}, ctx = {}) {
      if (!live || live.session !== ctx.session) return { ok: true }
      if (stream !== undefined && Number(stream) !== live.stream) return { ok: true }
      const result = await finish(error ? `the phone stopped: ${error}` : 'the phone stopped', { tell: false })
      return { ok: true, ...result }
    },

    /** What, if anything, this desktop is listening to. */
    'audio.status'() {
      return summary()
    },

    /**
     * The phone offering its microphone, rather than being asked for it.
     *
     * Everything else on this channel runs the other way round: the desktop
     * decides it wants to hear and the handset answers. That is the right
     * shape for a phone in a pocket, and it is the wrong shape for the person
     * holding the phone, because the microphone is in their hand and the only
     * switch for it was on a machine in another room. This is that switch,
     * where the microphone is.
     *
     * It is `requestMic` and nothing else — the same one instruction, the
     * same one stream, the same fifteen seconds — so a stream started from
     * here stops with `omarchy-connect mic stop`, ends with the socket, and
     * hits the same half-hour ceiling as one the desktop asked for. What is
     * new is only who pressed the button.
     *
     * The answer is held open until the handset is actually recording, so the
     * app can say *the desktop is writing this file* rather than *the message
     * left*. A refusal — already streaming, a request already outstanding,
     * a handset that never answered — comes back as the sentence the card
     * shows, which is the phone half of "no silent refusal".
     */
    async 'audio.offer'({ op = 'start' } = {}, ctx = {}) {
      remoteRefused(ctx)
      const action = String(op || 'start').toLowerCase()
      if (action === 'status') return summary()
      const result = await requestMic({ op: action }).outcome
      // `summary()` is read after the outcome on purpose: by then `live` is
      // either set or gone, so the state the app draws from is the state the
      // press actually produced rather than the one before it.
      return { ...summary(), ...(result?.path ? { path: result.path } : {}) }
    },

    /**
     * The phone flipping the desktop's input on or off.
     *
     * The switch is here as well as in the CLI because the microphone is on
     * the handset: somebody walking to their desk with the phone in their
     * hand should be able to offer it before they sit down, without a
     * terminal. It rides `audio`, so like everything else on that channel it
     * is refused to a socket that came down a tunnel.
     */
    async 'audio.input'({ op = 'status' } = {}, ctx = {}) {
      remoteRefused(ctx)
      return requestInput(op)
    },
  },
}
