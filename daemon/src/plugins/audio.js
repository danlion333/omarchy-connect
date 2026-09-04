import crypto from 'node:crypto'

import { log } from '../lib/log.js'
import { CHUNK_MS, CHANNELS, MAX_SECONDS, RATE, Recorder, parseFrame, pathFor } from '../lib/mic.js'

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
 * room. `#38` will read the live chunks as they land — `onChunk` below is that
 * seam, and the file is simply the first consumer written against it.
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
/** Whoever wants the chunks as they land. `#38` is the reason this is a set. */
const listeners = new Set()

const format = () => ({ encoding: 's16le', rate: RATE, channels: CHANNELS, chunkMs: CHUNK_MS })

export function summary() {
  if (!live) return { streaming: false }
  return {
    streaming: true,
    stream: live.stream,
    since: live.startedAt,
    ...live.recorder.summary(),
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

export default {
  name: 'audio',

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
  },
}
