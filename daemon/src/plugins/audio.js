import crypto from 'node:crypto'

import { loadConfig, updateConfig } from '../lib/config.js'
import { log } from '../lib/log.js'
import {
  CHUNK_MS,
  CHANNELS,
  Leveller,
  MAX_GAIN,
  MAX_SECONDS,
  RATE,
  Recorder,
  amplify,
  parseFrame,
  pathFor,
  readAuto,
  readGain,
} from '../lib/mic.js'
import { PipeSource, SOURCE_DESCRIPTION, SOURCE_NAME, available as pipeAvailable } from '../lib/pipesource.js'
import { PipeSink, SINK_DESCRIPTION, SINK_NAME, available as sinkAvailable, offerFor } from '../lib/pipesink.js'
import {
  BASELINE as PLAY_BASELINE,
  CHUNK_MS as WIRE_CHUNK_MS,
  buildFrame as buildSpeakerFrame,
  isBaseline as isBaselineFormat,
  readFormat as readPlayFormat,
} from '../lib/speaker.js'

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
 * ## The desktop's output
 *
 * And the same road pointed the other way, which is younger than everything
 * above it: `lib/pipesink.js` loads a PipeWire **sink**, so that a person can
 * route this desktop's sound — a meeting, an album, everything — at the phone
 * in their pocket and hear it come out of the handset. It is a toggle for the
 * microphone's reason (a program picks its output before anybody presses play)
 * and it differs from the input in exactly two places, both of them because a
 * sink that nothing is carrying away *swallows sound*:
 *
 *   - turning it off tells the handset to close its track, because there is
 *     nothing left on this road for a phone to be playing;
 *   - a socket that dies takes the sink down with it, where a dead socket
 *     leaves the microphone's source loaded and silent.
 *
 * ## Both at once
 *
 * And then the pair of them together, which is not the sum of the two
 * switches: a phone playing the desktop through its loudspeaker while
 * recording the same room two centimetres away sends the desktop its own voice
 * back. `requestHeadset` is that case, and what it really is is an *order* —
 * both directions down, a mode set on the handset, the microphone opened, and
 * only then the track — because everything Android will do about the loop
 * (`AcousticEchoCanceler` on one shared audio session, the communication
 * source, the routing) is fixed at the moment the recorder and the track are
 * constructed. `app/modules/omarchy-link/.../Headset.kt` argues the phone's
 * half; this file's job is the order and the honesty about what came back.
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

/** The desktop's output, when it is switched on. Never more than one. */
let output = null
/**
 * The phone that is playing, or null. `session` is the socket the chunks are
 * being sent down, so a handset that reconnected does not have the sound of a
 * run it has already forgotten pushed at it.
 */
let playing = null
/** The `play` instruction that has gone out and not been answered yet. */
let askedToPlay = null
/** Handed out ascending, so a chunk of a finished run is recognisable. */
let nextPlayStream = 1

/**
 * The headset, when the phone is being one: both directions at once, in the
 * one state on the handset that keeps them from howling at each other.
 *
 * `startedMic` and `startedPlay` say which of the two directions this mode
 * raised itself: the mode may have found one already running — somebody had
 * the speaker on and then asked for a headset — and turning the mode off must
 * not take away a switch it did not flip. The input toggle makes no such
 * distinction, for the reason `requestInput` gives: a microphone is a thing
 * in somebody's pocket, and taking it off the desktop takes it off the phone.
 */
let headset = null
/** The `headset` instruction that has gone out and not been answered yet. */
let askedHeadset = null

const format = () => ({ encoding: 's16le', rate: RATE, channels: CHANNELS, chunkMs: CHUNK_MS })

/**
 * The other direction's format, as an app that has never heard of the offer
 * reads it.
 *
 * Sixteen kilohertz mono, forever, in the two fields an old build takes
 * literally — `lib/speaker.js` explains at length why the new format could
 * not simply be written into them. Everything a newer app needs is in
 * `offer`, beside these rather than instead of them.
 */
const playBaseline = () => ({
  encoding: 's16le',
  ...PLAY_BASELINE,
  chunkMs: WIRE_CHUNK_MS,
})

/**
 * What this desktop would rather send, when the handset can take it.
 *
 * Not a constant: a sink loaded at a rate the offer does not divide can only
 * feed the baseline, and `offerFor` in `lib/pipesink.js` is where that
 * arithmetic lives. Headset mode is the other thing that takes the offer off
 * the table, and that is decided at the instruction rather than here — a
 * capability list is what this desktop can do, not what it is doing.
 */
const playOffer = () => offerFor(output?.rate)

/**
 * The format of the playback that is actually running, or the baseline when
 * nothing is.
 *
 * The thing `omarchy-connect speaker status` prints. It is the handset's
 * answer rather than this desktop's request, because the handset is the end
 * that opened a track and the only end that knows what Android gave it.
 */
const playFormat = () => ({
  encoding: 's16le',
  ...(playing?.format || PLAY_BASELINE),
  chunkMs: WIRE_CHUNK_MS,
})

/**
 * Say, on this desktop only, that the microphone picture has moved.
 *
 * The bar panel reads `status.json` and nothing else, so a stream that starts
 * or ends, or a source that is loaded or unloaded, has to reach the file the
 * same way a phone connecting does. It rides an internal bus channel rather
 * than the `audio` event the handset subscribes to: this is news for the
 * desktop's own panel, and the phone already knows — it is the one speaking.
 */
const changed = () => bus?.emit('audio.state')

export function summary() {
  const desktop = { input: inputSummary(), output: outputSummary(), headset: headsetSummary() }
  if (!live) return { streaming: false, gain: currentGain(), auto: currentAuto(), ...desktop }
  return {
    streaming: true,
    stream: live.stream,
    since: live.startedAt,
    // `gain` is always the number a person would get by turning the follower
    // off right now: their own when they chose one, and otherwise wherever the
    // follower has arrived. Rounded, because two decimals of a live gain is
    // noise in a status line that redraws every second.
    gain: live.auto ? Math.round(live.leveller.gain * 10) / 10 : live.gain,
    auto: live.auto,
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
    changed()
    return inputSummary()
  }
  unfeed?.()
  unfeed = null
  const was = input ? input.stop() : { enabled: false }
  input = null
  if (was.enabled !== undefined) log.info('the phone is no longer an input on this desktop')
  changed()
  return { available: pipeAvailable(), name: SOURCE_NAME, description: SOURCE_DESCRIPTION, enabled: false }
}

/* ── the phone as this desktop's speaker ─────────────────────────────── */

/**
 * What the output toggle is doing, and whether the handset is playing it.
 *
 * Two facts, kept apart the way `inputSummary` and `streaming` are kept apart,
 * because they fail separately: the sink can be loaded on a desktop whose
 * phone is asleep — every program on the machine can route into it and nothing
 * comes out — and the phone can be playing a run whose sink somebody has since
 * unloaded, which is the state that lasts for one tick.
 */
export function outputSummary() {
  return {
    available: sinkAvailable(),
    name: SINK_NAME,
    description: SINK_DESCRIPTION,
    playing: Boolean(playing),
    // `sent` and `missed` are the two halves of one fact and are only ever
    // read together: a run with a hundred of each is a link that is carrying
    // half the sound, and a status that printed the hundred it carried would
    // read as a healthy one. `PipeSink.summary` already tells the same story
    // about the desktop end of the road (`silent`, `dropped`); this is the
    // socket's end of it.
    ...(playing
      ? {
          stream: playing.stream,
          playingSince: playing.startedAt,
          sent: playing.sent,
          missed: playing.missed,
        }
      : {}),
    ...(output ? output.summary() : { enabled: false }),
    // The format this run is actually being sent in, which used to be a pair
    // of constants and is now the handset's own answer. It comes from the
    // sink while there is one — the sink is the thing that was told, so it is
    // the thing that knows — and from the run itself when the sink has
    // already gone but the answer has not been forgotten yet. A person whose
    // music still sounds like a telephone line reads these two numbers to
    // find out whether their phone took the offer.
    ...(playing && !output ? { wireRate: playing.format.rate, wireChannels: playing.format.channels } : {}),
  }
}

/** Is the phone currently offered as an output here? */
export const outputEnabled = () => Boolean(output?.running)

/**
 * One chunk of this desktop's sound, towards the handset.
 *
 * Nothing is queued and nothing is retried. A chunk that missed its socket is
 * worthless by the time there is a socket again — the moment it belonged to
 * has passed — which is the very rule `client.sendBytes` keeps on the phone
 * for the microphone going the other way. What a refused chunk earns is a
 * number in the summary — `missed`, beside `sent`, printed by `omarchy-connect
 * speaker status` — so a link that cannot keep up is visible as sound that
 * never left rather than as a mystery.
 *
 * There are exactly three ways `audio.bytes` answers false, and all three are
 * this counter's business: the socket is not encrypted (sound is never put on
 * a plaintext link), the socket is closing, or its buffer is already deeper
 * than live sound can be carried through (`SOCKET_BACKLOG_BYTES`).
 */
function pushChunk(pcm) {
  if (!playing || !bus) return
  const frame = buildSpeakerFrame(playing.stream, playing.seq, pcm)
  playing.seq += 1
  bus.emit('audio.bytes', frame, playing.session, (sent) => {
    if (sent) playing.sent += 1
    else playing.missed += 1
  })
}

/**
 * Switch the desktop output on or off.
 *
 * Idempotent in both directions, which is what makes it safe as a toggle a
 * phone can press: turning on something already on answers with the sink that
 * is already there rather than loading a second module beside it.
 *
 * Turning it *off* also tells the handset to close its track. That is not the
 * same bargain the input makes — there, a stream somebody started from the
 * terminal outlives the switch — because there is nothing on this road for a
 * phone to be playing once the sink is gone: every byte it would play comes
 * out of that pipe.
 */
export function setOutput(on) {
  if (on) {
    if (output?.running) return outputSummary()
    if (!sinkAvailable()) {
      throw new Error('this desktop has no pipewire-pulse, so it cannot offer the phone as an output')
    }
    const sink = new PipeSink({
      onChunk: pushChunk,
      // Somebody unloaded the module by hand. The sink is already down by the
      // time this runs; what is left is to stop the handset playing a stream
      // nothing is feeding any more.
      onGone: () => {
        output = null
        hushPhone('the sink went away')
        changed()
      },
    })
    sink.start()
    output = sink
    changed()
    return outputSummary()
  }
  const was = output ? output.stop() : { enabled: false }
  output = null
  hushPhone('the desktop switched the speaker off')
  if (was.enabled !== undefined) log.info('the phone is no longer an output on this desktop')
  changed()
  return { available: sinkAvailable(), name: SINK_NAME, description: SINK_DESCRIPTION, playing: false, enabled: false }
}

/**
 * Tell the handset to close its track, if one is open, and forget it.
 *
 * Always safe to call, which matters because four different things end a
 * playback — the switch, the socket, the module being unloaded, the daemon
 * stopping — and they race.
 */
function hushPhone(why, { tell = true } = {}) {
  if (askedToPlay) {
    clearTimeout(askedToPlay.timer)
    askedToPlay.reject(new Error(why))
    askedToPlay = null
  }
  const current = playing
  if (!current) return null
  playing = null
  log.info(
    `the phone stopped being this desktop's speaker (${why}): ${current.sent} chunks sent` +
      (current.missed ? `, ${current.missed} the socket could not take` : ''),
  )
  if (tell) bus?.emit('event', 'audio', { action: 'hush', stream: current.stream })
  // The other half of the same rule `finish` keeps: a mode neither direction
  // is left in is a mode the phone should not still be sitting in.
  maybeLeaveHeadset()
  return current
}

/** How long the desktop waits for the handset to say whether it could play. */
const PLAY_TTL_MS = 15_000

/**
 * Ask the handset to open its speaker, and hold the answer until it has.
 *
 * `requestMic`'s shape exactly, and for the same reason: a success has to mean
 * a track is open on the phone rather than that a message went into the dark.
 */
function askPhoneToPlay() {
  if (!bus) throw new Error('daemon is not running')
  if (playing) throw new Error('the phone is already playing this desktop')
  if (askedToPlay) throw new Error('the phone has already been asked and has not answered yet')

  const stream = nextPlayStream
  nextPlayStream += 1
  const id = crypto.randomUUID()
  const outcome = new Promise((resolve, reject) => {
    askedToPlay = {
      id,
      stream,
      resolve,
      reject,
      timer: setTimeout(() => {
        askedToPlay = null
        reject(new Error('the phone did not answer — it may be off, asleep or off this network'))
      }, PLAY_TTL_MS),
    }
    askedToPlay.timer.unref?.()
  })
  // The baseline in the fields an old build reads, and the offer in a field it
  // does not — except in headset mode, where the whole point of the track is
  // the platform's echo canceller and that wants 16 kHz mono on a voice
  // session. A handset in the mode would refuse the offer anyway; not making
  // it is one round trip fewer and one less thing to go wrong in the middle of
  // a call.
  const offer = headset ? null : playOffer()
  bus.emit('event', 'audio', {
    action: 'play',
    id,
    stream,
    ...playBaseline(),
    ...(offer && !isBaselineFormat(offer) ? { offer } : {}),
  })
  return { id, stream, outcome }
}

/**
 * The toggle as a person means it: an output on this desktop, coming out of
 * the phone.
 *
 * `setOutput` is the mechanism and this is the intent, and the order is the
 * same one `requestInput` argues for: the sink is loaded *first*, because a
 * sink that exists and is silent is a far better outcome than no sink and an
 * error — a program picks its output before anybody presses play, and a
 * handset that was asleep can be asked again. A phone that refuses is reported
 * beside a sink that is nonetheless there.
 */
export async function requestOutput(op = 'status') {
  const action = String(op || 'status').toLowerCase()
  if (action === 'status') return outputSummary()
  if (!['on', 'off', 'start', 'stop', 'enable', 'disable'].includes(action)) {
    throw new Error(`unknown output action: ${op}`)
  }
  if (['off', 'stop', 'disable'].includes(action)) return setOutput(false)

  const state = setOutput(true)
  if (playing || askedToPlay) return { ...state, playing: Boolean(playing) }
  try {
    await askPhoneToPlay().outcome
    return outputSummary()
  } catch (err) {
    // The switch worked; the handset did not answer it. Both facts go back.
    return { ...outputSummary(), phone: err.message }
  }
}

/**
 * The socket carrying the sound away went down.
 *
 * The sink goes with it, and that is a deliberate difference from the
 * microphone's `hangUp`, which leaves the source loaded and silent. A source
 * nobody is speaking into is a microphone in an empty room; a *sink* nobody is
 * carrying away is a desktop whose sound is being swallowed — every program
 * routed into it plays into a pipe that goes nowhere, with no sound and no
 * error anywhere on the machine. Unloading it puts those programs back on the
 * speakers they had, which is what somebody whose phone just walked out of
 * Wi-Fi range wants to happen.
 */
export function hangUpOutput(session) {
  if (!playing || playing.session !== session) return
  hushPhone('the socket closed', { tell: false })
  if (output) {
    try {
      setOutput(false)
    } catch (err) {
      log.warn(`could not take the phone output down: ${err.message}`)
    }
  }
}

/**
 * How loud the phone is on this desktop, and how to change it.
 *
 * The number lives in the config because it is a property of a handset and a
 * room rather than of a session: the same phone in the same place needs the
 * same multiply tomorrow. It is applied to a stream that is already running
 * as well as saved, because nobody can choose a gain from a number — they
 * choose it by listening to the input in the program that was too quiet, and
 * a value that only took effect on the next `mic start` would make that a
 * game of stop and start.
 */
export function currentGain() {
  if (live) return live.auto ? live.leveller.gain : live.gain
  return readGain(loadConfig().audio?.gain)
}

/** Is the follower in charge, on a running stream or on the next one? */
export function currentAuto() {
  return live ? live.auto : readAuto(loadConfig().audio?.auto)
}

/**
 * Take the knob, or give it back.
 *
 * A number is a person saying they would rather have a constant than a
 * follower — nobody types `mic gain 6` while something is already choosing
 * for them — so a number turns the follower off as well as setting the
 * number. `auto` is how they hand it back, and the number they had chosen is
 * left in the config so that handing it over and taking it again is not a
 * choice they have to make twice.
 */
export function setGain(value) {
  if (value === 'auto' || value === true) {
    updateConfig((cfg) => {
      cfg.audio = { ...(cfg.audio || {}), auto: true }
    })
    if (live) {
      live.auto = true
      // From where the constant left off, not from one: the level the person
      // was hearing a moment ago is the least surprising place to start
      // following from.
      live.leveller = new Leveller({ gain: live.gain })
    }
    log.info("the phone's microphone follows the room again on this desktop")
    changed()
    return currentGain()
  }
  const asked = Number(value)
  if (!Number.isFinite(asked) || asked <= 0) throw new Error('the microphone gain is a number greater than zero')
  if (asked > MAX_GAIN) throw new Error(`the microphone gain tops out at ${MAX_GAIN}`)
  updateConfig((cfg) => {
    cfg.audio = { ...(cfg.audio || {}), gain: asked, auto: false }
  })
  if (live) {
    live.gain = asked
    live.auto = false
  }
  log.info(`the phone's microphone is now ${asked}x on this desktop`)
  changed()
  return currentGain()
}

/** Is the phone currently offered as an input here? */
export const inputEnabled = () => Boolean(input?.running)

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
    // Told unconditionally, the way `setOutput(false)` hushes the speaker on
    // the road right beside this one. It used to be asked only when *this*
    // toggle had started the stream, which left the phone's `AudioRecord`
    // open — indicator lit — whenever the stream had come up any other way:
    // `mic start` from a terminal, or a second `on` that returned early below
    // and so never set the flag the `off` was looking for. The state that
    // matters is the handset's, and a desktop that has given the microphone
    // back has no business leaving one recording in somebody's pocket.
    if (live) await requestMic({ op: 'stop' }).outcome.catch(() => null)
    return setInput(false)
  }

  const state = setInput(true)
  if (live || asked) return { ...state, streaming: Boolean(live) }
  try {
    await requestMic({ op: 'start' }).outcome
    return { ...inputSummary(), streaming: true }
  } catch (err) {
    // The switch worked; the handset did not answer it. Both facts go back.
    return { ...inputSummary(), streaming: false, phone: err.message }
  }
}

/* ── the phone as a headset ──────────────────────────────────────────── */

/** How long the desktop waits for the handset to say it is a headset. */
const HEADSET_TTL_MS = 15_000

/**
 * What the duplex is, and what the phone could actually do about the echo.
 *
 * `available` is this desktop's half — a headset needs both a source and a
 * sink, so a machine with no pipewire-pulse cannot offer one — and everything
 * else is the handset's own answer, kept verbatim rather than reduced to a
 * boolean. A phone with no `AcousticEchoCanceler` is still a working duplex
 * for one person talking at a time, and the honest thing to do with that fact
 * is print it, not hide it behind an `on: true`.
 */
export function headsetSummary() {
  const available = pipeAvailable() && sinkAvailable()
  if (!headset) return { available, on: false }
  return {
    available,
    on: true,
    since: headset.since,
    echoCancellation: Boolean(headset.aec?.enabled),
    aec: headset.aec || null,
    listening: Boolean(live),
    playing: Boolean(playing),
  }
}

/** Is this desktop running the phone as a headset right now? */
export const headsetOn = () => Boolean(headset)

/**
 * Tell the handset to enter the mode, or leave it, and hold the answer.
 *
 * `askPhoneToPlay`'s shape, and for its reason: a success has to mean the
 * phone is actually in the mode — one session, the communication source, a
 * canceller if it has one — rather than that a message went into the dark,
 * because the two things that follow it depend on the phone being in it
 * before they open anything.
 */
function askPhoneHeadset(on) {
  if (!bus) throw new Error('daemon is not running')
  if (askedHeadset) throw new Error('the phone has already been asked and has not answered yet')
  const id = crypto.randomUUID()
  const outcome = new Promise((resolve, reject) => {
    askedHeadset = {
      id,
      on,
      resolve,
      reject,
      timer: setTimeout(() => {
        askedHeadset = null
        reject(new Error('the phone did not answer — it may be off, asleep or off this network'))
      }, HEADSET_TTL_MS),
    }
    askedHeadset.timer.unref?.()
  })
  bus.emit('event', 'audio', { action: 'headset', id, on })
  return { id, outcome }
}

/**
 * Put the phone back out of the mode, and forget it here.
 *
 * Always safe to call, which matters because five things end a headset — the
 * switch, either direction ending on its own, the socket, the daemon stopping
 * — and they race. `tell` is false when there is nobody left to tell: the
 * phone leaves the mode by itself when its socket goes, which is the half of
 * this that a dead link cannot be trusted to deliver.
 */
function leaveHeadset(why, { tell = true } = {}) {
  if (askedHeadset) {
    clearTimeout(askedHeadset.timer)
    askedHeadset.reject(new Error(why))
    askedHeadset = null
  }
  const current = headset
  if (!current) return null
  headset = null
  log.info(`the phone is no longer a headset for this desktop (${why})`)
  if (tell) bus?.emit('event', 'audio', { action: 'headset', id: crypto.randomUUID(), on: false })
  changed()
  return current
}

/**
 * Both directions have ended, so the mode has nothing left to be about.
 *
 * This is the answer to the one failure a person would feel *outside* this
 * app: a handset left in `MODE_IN_COMMUNICATION` with its communication device
 * forced to the loudspeaker plays its own calls and its own music wrong
 * afterwards, and nothing on its screen says why. So the mode does not outlive
 * the last of the two things it was for — whichever of them ended last, and
 * whatever ended it.
 */
function maybeLeaveHeadset() {
  if (!headset || live || playing) return
  leaveHeadset('nothing is left of either direction')
}

/**
 * The phone as a headset: the microphone and the speaker at once, in the mode
 * that keeps the one from hearing the other.
 *
 * `requestInput` and `requestOutput` are the two halves and this is not a
 * third road beside them — it is those two, in an order that matters, around
 * an instruction that changes what the handset opens them as. The order is the
 * whole reason this exists as a function rather than as advice in the README:
 *
 *   1. **Both directions down first.** A microphone already streaming was
 *      opened at `VOICE_RECOGNITION` on a session of its own, and neither can
 *      be changed on a running `AudioRecord`. The same is true of a track
 *      already playing. So anything running is stopped and started again
 *      inside the mode rather than left as a half-duplex that quietly does not
 *      cancel anything.
 *   2. **The mode, before either end opens.** The source, the session and the
 *      canceller are fixed when the phone constructs its recorder and its
 *      track.
 *   3. **The microphone before the speaker.** The canceller hangs on the
 *      *record* session, and the track has to join a session that exists.
 *
 * A phone that cannot answer leaves the sink and the source loaded and says
 * so, exactly as `requestOutput` does: a desktop with a working, silent pair
 * of devices and a sentence is in a better place than one with an error and no
 * devices.
 */
export async function requestHeadset(op = 'status') {
  const action = String(op || 'status').toLowerCase()
  if (action === 'status') return headsetSummary()
  if (!['on', 'off', 'start', 'stop', 'enable', 'disable'].includes(action)) {
    throw new Error(`unknown headset action: ${op}`)
  }

  if (['off', 'stop', 'disable'].includes(action)) {
    const was = headset
    // Told first, so the phone is out of the mode before either direction is
    // taken away under it. Told even when this desktop thinks the mode is
    // already off, because the state that matters is the handset's and this is
    // the one instruction that can put a stuck phone right.
    await askPhoneHeadset(false).outcome.catch(() => null)
    leaveHeadset('the desktop switched the headset off', { tell: false })
    if (was?.startedMic && live) await requestMic({ op: 'stop' }).outcome.catch(() => null)
    if (was?.startedPlay && output) {
      try {
        setOutput(false)
      } catch (err) {
        log.warn(`could not take the phone output down: ${err.message}`)
      }
    }
    return headsetSummary()
  }

  if (!pipeAvailable() || !sinkAvailable()) {
    throw new Error('this desktop has no pipewire-pulse, so it cannot use the phone as a headset')
  }
  // Already in the mode is not already finished. A person who stopped the
  // microphone an hour ago and now asks for a headset again wants the half
  // that is missing back, not a summary saying the switch is on while nothing
  // is being heard — so the mode is left exactly as it is and the two
  // directions below are raised as if it had just been entered.
  if (!headset) {
    // Whatever was running was opened in the wrong state for a duplex. Both go
    // back, and both come up again below inside the mode.
    if (live) await requestMic({ op: 'stop' }).outcome.catch(() => null)
    if (playing) hushPhone('the headset is taking the track back')

    // The devices first, for `requestInput`'s reason: a program picks its input
    // and its output before anybody speaks, and a pair that exists and is silent
    // beats an error and no pair at all.
    setInput(true)
    setOutput(true)

    let aec = null
    try {
      const answer = await askPhoneHeadset(true).outcome
      aec = answer?.aec || null
    } catch (err) {
      return { ...headsetSummary(), phone: err.message }
    }

    headset = { since: Date.now(), aec, startedMic: false, startedPlay: false }
  } else {
    // The devices can have been unloaded under a mode that is still on — the
    // speaker switch does exactly that — so they are asked for again before
    // anything is played into them. Both are idempotent.
    setInput(true)
    setOutput(true)
  }

  // The microphone before the track, because the canceller hangs on the
  // record session and the track joins it. A refusal on either is reported
  // beside a mode that is nonetheless on: the person can wake the phone and
  // ask again without losing the state that was set up for them.
  const trouble = []
  if (!live) {
    try {
      await requestMic({ op: 'start' }).outcome
      headset.startedMic = true
      // And now — not before — the phone can be asked what it actually got.
      // An `AcousticEchoCanceler` is created against a *record session*, so
      // the answer to the instruction that opened the mode was necessarily
      // given by a phone that had no session yet and could only say whether
      // the platform has a canceller at all. This second ask is the same
      // idempotent instruction (the phone is already in the mode, so nothing
      // is reopened) and it is the one whose answer is true.
      const bound = await askPhoneHeadset(true).outcome.catch(() => null)
      if (bound?.aec) headset.aec = bound.aec
    } catch (err) {
      trouble.push(err.message)
    }
  } else {
    // Still streaming after being asked to stop: whatever this is, it is not
    // a stream this mode opened, so it is not one this mode may close.
    headset.startedMic = false
  }
  if (!playing) {
    try {
      await askPhoneToPlay().outcome
      headset.startedPlay = true
    } catch (err) {
      trouble.push(err.message)
    }
  } else {
    headset.startedPlay = false
  }
  log.ok(
    headset.aec?.enabled
      ? 'the phone is a headset for this desktop, with its own echo canceller'
      : 'the phone is a headset for this desktop — no echo canceller was fitted, so expect to hear yourself',
  )
  changed()
  return { ...headsetSummary(), ...(trouble.length ? { phone: trouble.join('; ') } : {}) }
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
  // A headset with no microphone left in it is half a headset, and the half
  // that is left costs the handset its own audio routing until somebody says
  // otherwise. Checked here rather than only in the switch, because most of
  // the ways a stream ends are not switches.
  maybeLeaveHeadset()
  changed()
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
  // Loud once, for everybody. The WAV and the PipeWire source are two readers
  // of the same bytes, and a desktop where the recording and the input in
  // Zoom's list disagreed about the level would be a bug nobody could hear
  // their way out of. That is also why the follower lives on this line and not
  // in `pipesource.js`: one gain, chosen once, ahead of every consumer.
  const pcm = live.auto ? live.leveller.push(chunk.pcm) : amplify(chunk.pcm, live.gain)
  live.recorder.push(pcm, chunk.seq)
  for (const listener of listeners) {
    try {
      listener(pcm, live.stream)
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
    // First, and without telling anybody: the socket is going with this
    // process, so the instruction would not arrive — and the phone leaves the
    // mode by itself when the socket dies, which is the half of it that has to
    // be reliable.
    leaveHeadset('the daemon is stopping', { tell: false })
    if (live) void finish('the daemon is stopping', { tell: false })
    // The speaker first, because it is the one whose absence is silent: a
    // `module-pipe-sink` left loaded by a daemon on its way out is an output
    // in every picker on this machine that swallows whatever is routed into
    // it. Synchronous for the same reason `setInput(false)` is.
    try {
      if (output) setOutput(false)
      else hushPhone('the daemon is stopping', { tell: false })
    } catch (err) {
      log.warn(`could not take the phone output down: ${err.message}`)
    }
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
      // And whether it can go the other way: this desktop's own sound out of
      // the handset's speaker. False on the same machines for the same reason,
      // and separately from `input` because a phone talking to a desktop that
      // has one and not the other must draw one button and not two.
      output: outputSummary(),
      // The format the desktop will send when it does. Advertised so an app
      // can build its track before the first chunk lands rather than after —
      // the baseline in the fields it has always been in, and beside them the
      // better format this desktop would rather send if the handset can open
      // a track for it. An app that does not read `offer` is an app that gets
      // exactly what it got before.
      play: { ...playBaseline(), offer: playOffer() },
      // And whether the two can be had at once. False wherever `input` and
      // `output` are false, because a headset is those two and not a third
      // thing — the app draws one switch for it, or none.
      headset: headsetSummary(),
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
        // Read once, here, rather than out of the config on every chunk ten
        // times a second. `setGain` moves it under a running stream on
        // purpose, because the only way to pick this number is to hear it.
        gain: readGain(loadConfig().audio?.gain),
        auto: readAuto(loadConfig().audio?.auto),
        // One follower per stream. A reconnect is a new room as far as this is
        // concerned, and starting it at the saved constant means the first
        // second of a fresh stream is no quieter than #41 already made it.
        leveller: new Leveller({ gain: readGain(loadConfig().audio?.gain) }),
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
      changed()
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
     * The handset's answer to being asked to become this desktop's speaker.
     *
     * `audio.started`'s twin, down to the fifteen seconds and the sentence:
     * `ok` false is a refusal with a reason — no track could be opened, the
     * build is too old to have one — and the desktop's `omarchy-connect
     * speaker` prints it rather than timing out on sound that was never going
     * to be played.
     */
    'audio.playing'({ id, ok = true, error, rate, channels } = {}, ctx = {}) {
      const pending = askedToPlay
      if (!pending || pending.id !== id) throw new Error('nothing is waiting on that speaker request')
      clearTimeout(pending.timer)
      askedToPlay = null
      if (!ok) {
        pending.reject(new Error(error || 'the phone could not open its speaker'))
        return { ok: false }
      }
      // What the handset says it opened, which is the authority on this road:
      // an app that never heard of the offer names no format at all and gets
      // the baseline, and one that tried the offer and was refused a track by
      // Android names what it settled for. The sink is told before the first
      // chunk is built, and `playing` is what lets any chunk be built at all.
      const agreed = readPlayFormat({ rate, channels })
      try {
        if (output) output.setWire(agreed)
      } catch (err) {
        log.warn(`could not put the sink on ${agreed.rate} Hz: ${err.message}`)
      }
      playing = {
        stream: pending.stream,
        session: ctx.session,
        startedAt: Date.now(),
        seq: 0,
        sent: 0,
        missed: 0,
        format: agreed,
      }
      log.ok(
        `the phone is this desktop's speaker at ${agreed.rate} Hz ${agreed.channels === 2 ? 'stereo' : 'mono'}`,
      )
      changed()
      pending.resolve({ ok: true, stream: playing.stream, ...playFormat() })
      return { ok: true, stream: playing.stream, ...agreed }
    },

    /**
     * The handset saying it has stopped playing — because the desktop asked,
     * because Android took the track away, or because something else on the
     * phone wanted the speaker. The sink stays exactly where it is: it is this
     * desktop's device, a person may have routed a meeting into it, and it is
     * not a handset's to unload. What ends is the sending.
     */
    'audio.hushed'({ stream, error } = {}, ctx = {}) {
      if (!playing || playing.session !== ctx.session) return { ok: true }
      if (stream !== undefined && Number(stream) !== playing.stream) return { ok: true }
      hushPhone(error ? `the phone stopped: ${error}` : 'the phone stopped', { tell: false })
      changed()
      return { ok: true }
    },

    /**
     * The phone flipping the desktop's output on or off.
     *
     * The switch is here as well as in the CLI for the reason the microphone's
     * is: the speaker is on the handset, and somebody walking into the room
     * with the phone in their hand should be able to offer it without going to
     * the keyboard first. It rides `audio`, so like everything else on that
     * channel it is refused to a socket that came down a tunnel — a desktop
     * whose sound is quietly rerouted to a handset in another building is
     * exactly the shape of thing the fence is there for.
     */
    async 'audio.speaker'({ op = 'status' } = {}, ctx = {}) {
      remoteRefused(ctx)
      return requestOutput(op)
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

    /**
     * The handset's answer to being asked to be a headset.
     *
     * `audio.started` and `audio.playing`'s twin, with one difference that is
     * the point of the whole road: `ok: true` is not the end of the answer.
     * The phone also says what it *got* — whether this handset has an
     * `AcousticEchoCanceler` at all, and whether one was created and enabled
     * for the session it is about to record into — because a duplex without
     * one works and howls, and the desktop is the end that can tell somebody
     * that before they start a call rather than during it.
     */
    'audio.wearing'({ id, ok = true, error, aec } = {}) {
      const pending = askedHeadset
      if (!pending || pending.id !== id) throw new Error('nothing is waiting on that headset request')
      clearTimeout(pending.timer)
      askedHeadset = null
      if (!ok) {
        pending.reject(new Error(error || 'the phone could not be a headset'))
        return { ok: false }
      }
      pending.resolve({ ok: true, on: pending.on, aec: aec || null })
      return { ok: true }
    },

    /**
     * The phone flipping the headset on or off.
     *
     * Here as well as in the CLI for the reason `audio.speaker` and
     * `audio.input` are: both halves of a headset are in somebody's hand, and
     * the switch for them was on a machine in another room. Refused down a
     * tunnel like everything else on this channel — it turns a microphone on.
     */
    async 'audio.headset'({ op = 'status' } = {}, ctx = {}) {
      remoteRefused(ctx)
      return requestHeadset(op)
    },
  },
}
