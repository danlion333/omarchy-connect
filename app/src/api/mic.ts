import {
  linkService,
  micSupported,
  hasMicPermission,
  requestMicPermission,
  startMic,
  stopMic,
} from '../../modules/omarchy-link'
import { CHUNK_MS, frame } from '../lib/micframe'
import type { ConnectClient } from './client'

/**
 * The phone as a microphone the desktop can switch on — and that the person
 * holding the phone can offer.
 *
 * Dictation is the other way round and always was: a person holds a button,
 * the recorder writes an `.m4a`, and the file crosses when they let go. That
 * road is untouched, and it is the right road for "say a sentence and get text
 * back" — the desktop cannot transcribe what has not finished being said.
 *
 * This is the road for sound that has not finished. Somebody asks — the
 * desktop with `omarchy-connect mic start`, or the phone's own microphone card
 * with `audio.offer` — the native recorder opens `AudioRecord` at 16 kHz mono,
 * and every hundred milliseconds a chunk goes up the encrypted socket as a
 * binary frame rather than as JSON. There is no file on this side and nothing
 * is kept here: the phone is the ear, and the bytes are already gone by the
 * time the next ones arrive.
 *
 * Whichever end pressed the button, only one thing ever opens the microphone:
 * an `audio` instruction from the paired desktop. `offer` does not start the
 * recorder — it asks the desktop to ask — so there is exactly one road in, one
 * stream number, and one set of endings.
 *
 * Three things this deliberately does *not* do, and each is a bug it would
 * have if it did:
 *
 *   - **No buffering across a broken socket.** A chunk that missed its socket
 *     is worthless once there is a socket again — the moment it belonged to
 *     has passed. So a failed send stops the recording rather than queueing,
 *     and the microphone indicator goes away with it. A desktop that wants
 *     more asks again.
 *   - **No recording without a desktop that asked.** The only thing that opens
 *     the microphone is an `audio` instruction from the paired desktop, and
 *     that channel is never delivered to a socket that arrived down a tunnel.
 *   - **No silent refusal.** Every reason this cannot record — an old build,
 *     a denied permission, an input another app is holding, a desktop too old
 *     to be offered anything — travels back as a sentence: to the desktop that
 *     asked, and to the card on the phone that offered.
 *
 * ## What the card reads
 *
 * The state below lives here rather than in the screen, and that is the whole
 * reason the card can be trusted. A recording outlives every component that
 * could have held a `useState` for it — the user switches to another tab, puts
 * the phone in a pocket, comes back an hour later — and a card that forgot it
 * was recording would be the one thing worse than no card at all. So the
 * responder owns it for the life of the socket, reports it upwards, and the
 * screen is only ever a view of it.
 */

/** What the microphone card draws, for the life of the socket. */
export type MicState = {
  /** Whether the desktop is listening to this phone right now. */
  listening: boolean
  /** The desktop's number for this stream, while there is one. */
  stream: number | null
  /** When it started, by this phone's clock. */
  since: number | null
  /** The WAV the desktop said it is writing, when it said. */
  path: string | null
  /** Why the last attempt did not happen, as a sentence for the card. */
  error: string | null
  /** A press that has gone out and not been answered yet. */
  busy: boolean
}

export const NO_MIC: MicState = {
  listening: false,
  stream: null,
  since: null,
  path: null,
  error: null,
  busy: false,
}

/**
 * The microphone, borrowed by something else in this app.
 *
 * Every hold is given back exactly once. While one is out, an input that
 * Android takes away is a gap in the live stream rather than the end of it —
 * see `borrowMicrophone` below.
 */
export type MicHold = { release: () => void }

/** A hold over nothing: no socket, no live stream, nothing to give back. */
const NO_HOLD: MicHold = { release: () => {} }

/**
 * The one live stream in this process, for the parts of the app that are
 * nowhere near the socket.
 *
 * Dictation is the case this exists for. It runs from a screen, opens the
 * same one hardware input through `expo-audio`, and knew nothing whatsoever
 * about the stream the desktop is listening to — so a tap on the dictate
 * button opened a second recorder over the first, Android handed the input to
 * whichever it felt like, and the desktop was left with a source that was
 * still in every microphone list on the machine and had silence in it.
 *
 * The responder belongs to the socket and outlives every screen, so it is the
 * only thing that can hold this. One at a time, by construction: `link`
 * starts exactly one responder per socket and stops it before starting the
 * next.
 */
let holder: { borrow: () => MicHold } | null = null

/**
 * Take the microphone for something that is not the live stream, and say so
 * if that cannot be done.
 *
 * Optimistic on purpose. Measured on a OnePlus 9 Pro on Android 14, the two
 * recorders simply coexist — `AudioRecord` at `VOICE_RECOGNITION` keeps
 * delivering chunks the whole time an `expo-audio` `MediaRecorder` is writing
 * its own `.m4a`, in either order, and the desktop hears the room throughout.
 * Refusing dictation on that handset would be taking a working thing away.
 *
 * So the first dictation over a live stream is allowed and watched. If the
 * input does get taken — `onMicStopped` while a hold is out — the stream is
 * put back the moment the hold is given back, and this handset is written
 * down as one that cannot do both. From then on the button says so rather
 * than costing the desktop its microphone a second time. That memory lives
 * for the life of the socket, like every other fact in this file: a fresh
 * connection is a fresh phone as far as anything here knows.
 */
export function borrowMicrophone(): MicHold {
  return holder ? holder.borrow() : NO_HOLD
}

/** The microphone as a person can work it, from the screen. */
export type MicResponder = {
  stop: () => void
  /** Offer the microphone, or take it back. One press either way. */
  offer: () => Promise<void>
  /** Ask the desktop what it is doing, and say so. */
  refresh: () => Promise<void>
}

/**
 * The sentence a card can show, out of whatever the desktop or the runtime
 * threw. The only one worth translating is the oldest desktop's, which says
 * `unknown method` — true, and no use at all to somebody holding a phone.
 */
function sentence(err: unknown): string {
  const message = (err as Error)?.message || String(err || 'something went wrong')
  if (/unknown method/.test(message)) {
    return 'this desktop is too old to be offered the microphone — update Omarchy Connect on it'
  }
  return message
}

export function startMicResponder(client: ConnectClient, report: (state: MicState) => void = () => {}): MicResponder {
  const native = linkService()
  /** The stream number the desktop handed out, or null when not recording. */
  let stream: number | null = null
  /** The chunk length the desktop asked for, kept for a stream put back. */
  let chunkMs = CHUNK_MS
  /** How many holds are out — dictation, and anything that follows it. */
  let lent = 0
  /** The input was taken while a hold was out, and owes the stream back. */
  let interrupted = false
  /**
   * This handset will not run two recorders at once, learned the only way it
   * can be: by one of them taking the input from the other.
   */
  let exclusive = false

  let state: MicState = NO_MIC
  const publish = (changes: Partial<MicState>) => {
    const next = { ...state, ...changes }
    if (
      next.listening === state.listening &&
      next.stream === state.stream &&
      next.since === state.since &&
      next.path === state.path &&
      next.error === state.error &&
      next.busy === state.busy
    ) {
      return
    }
    state = next
    report(state)
  }

  /** Give the microphone back, and say so if the desktop is still listening. */
  const halt = (error?: string) => {
    const ending = stream
    stream = null
    interrupted = false
    stopMic()
    publish({ listening: false, stream: null, since: null, path: null, ...(error ? { error } : {}) })
    if (ending === null) return
    client.call('audio.stopped', { stream: ending, ...(error ? { error } : {}) }).catch(() => {})
  }

  /**
   * Open the input again for a stream that is still the desktop's.
   *
   * The other half of `halt`, and the half that was missing. Nothing here
   * decides to record: the desktop asked for this stream, it has never been
   * told the stream ended, and its file is still open — so putting the input
   * back is finishing what it asked for rather than the phone starting
   * something. `seq` begins again at zero, which the desktop's recorder reads
   * as a chunk that did not skip (`daemon/src/lib/mic.js`), and the gap is
   * however long the other recorder had it.
   *
   * A restart that fails is the real end, and only then does the desktop hear
   * about it.
   */
  const restore = () => {
    if (!interrupted || stream === null) return
    interrupted = false
    try {
      if (!hasMicPermission()) throw new Error('microphone access is no longer granted on the phone')
      startMic(chunkMs)
      publish({ listening: true, error: null })
    } catch (err) {
      halt(sentence(err))
    }
  }

  /**
   * Something in this app took the input while the desktop was listening.
   *
   * Deliberately silent towards the desktop: it is still listening, its file
   * is still open, and an `audio.stopped` here would close a recording that
   * is about to have sound in it again. The card is left saying `listening`
   * for the same reason — it is the desktop's stream that is being asked
   * about, and that has not ended.
   */
  const interrupt = () => {
    exclusive = true
    interrupted = true
    stopMic()
  }

  /** One borrower, and the input back when the last of them lets go. */
  const borrow = (): MicHold => {
    if (stream !== null && exclusive) {
      throw new Error(
        'the desktop is listening through this phone’s microphone, and this phone will only run one recorder at a time — turn the microphone off on the desktop, or on the microphone card, and dictate then',
      )
    }
    lent += 1
    let given = false
    return {
      release: () => {
        if (given) return
        given = true
        lent = Math.max(0, lent - 1)
        if (lent === 0) restore()
      },
    }
  }
  const api = { borrow }
  holder = api

  const off = client.on('ev:audio', async (data: any) => {
    if (data?.action === 'stop') {
      // No `audio.stopped` back for a stop the desktop itself asked for: it
      // closed its own file before sending this, and an answer would only
      // race the next `start`.
      stream = null
      interrupted = false
      stopMic()
      publish({ listening: false, stream: null, since: null, path: null })
      return
    }
    if (data?.action !== 'start' || !data?.id) return
    try {
      if (!micSupported()) throw new Error('this phone cannot stream its microphone')
      if (stream !== null) throw new Error('this phone is already streaming its microphone')
      // Refused rather than asked for. A permission dialog needs an activity,
      // and the whole point of this road is that the desktop can ask while the
      // phone is in a pocket — so a request from here either shows a dialog
      // nobody sees or, with no activity at all, never settles, and the
      // desktop times out on a handset that was about to say no anyway.
      //
      // The card is the one place where asking *is* right, because a finger
      // has just touched the screen; `offer` below does the asking before it
      // says a word to the desktop, so by the time an instruction arrives the
      // answer is already yes or the press already failed.
      //
      // Worth naming the case that made this concrete: Android's **one-time**
      // grant. A "only this time" answer to the microphone prompt is revoked
      // as soon as the app has been in the background for a while, so a phone
      // that streamed happily an hour ago reports the permission gone, and the
      // sentence below is what the desktop prints instead of hanging.
      if (!hasMicPermission()) {
        throw new Error('microphone access is not granted on the phone — open the app and allow it while using the app')
      }
      chunkMs = Number(data.chunkMs) || CHUNK_MS
      startMic(chunkMs)
      stream = Number(data.stream)
      publish({ listening: true, stream, since: Date.now(), error: null })
      await client.call('audio.started', { id: data.id, ok: true })
    } catch (err) {
      stream = null
      stopMic()
      publish({ listening: false, stream: null, since: null, path: null, error: sentence(err) })
      await client.call('audio.started', { id: data.id, ok: false, error: (err as Error).message }).catch(() => {})
    }
  })

  /**
   * One chunk, straight onto the wire.
   *
   * `atob` rather than a Buffer because this runs in Hermes, where there is
   * no Node buffer and the global is the only decoder there is. It is a few
   * thousand bytes ten times a second, which is nothing next to what the
   * recorder itself is doing.
   */
  const chunkOff = native?.addListener('onMicChunk', ({ pcm, seq }) => {
    if (stream === null) return
    try {
      const binary = globalThis.atob(pcm)
      const bytes = new Uint8Array(binary.length)
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
      client.sendBytes(frame(stream, seq, bytes))
    } catch (err) {
      // The socket went away under a live recording. Stopping is the whole
      // answer — there is nowhere for the sound to go, and a microphone left
      // open would be an indicator the user cannot explain.
      halt((err as Error).message)
    }
  })

  /**
   * Android took the input back, or the permission was revoked mid-stream.
   *
   * Which of those it is matters now. With a hold out, something in this app
   * asked for the microphone a moment ago and this is Android answering it —
   * a gap in the desktop's stream, not the end of one, and the input comes
   * back when the borrower lets go. With no hold out it is what it always
   * was: another app, or a permission that is gone, and there is nothing to
   * wait for.
   */
  const stoppedOff = native?.addListener('onMicStopped', ({ error }) => {
    if (lent > 0 && stream !== null) return interrupt()
    halt(error || 'the phone stopped recording')
  })

  /**
   * A socket that is no longer connected is a microphone with nowhere to send
   * to, and unlike `locate` there is nothing to be said for carrying on: the
   * desktop has already closed its file. This is the phone half of "a broken
   * socket leaves nothing hanging".
   */
  const statusOff = client.on('status', ({ status }: { status: string }) => {
    if (status === 'connected') return
    stream = null
    interrupted = false
    stopMic()
    // The card goes with it, error and all: a sentence about a desktop this
    // phone is no longer talking to is a sentence about nothing.
    publish({ ...NO_MIC })
  })

  /**
   * What the desktop is doing, asked rather than assumed.
   *
   * A phone whose app was killed and restarted under a live foreground
   * service knows nothing about a stream the service is still feeding, and
   * neither does one that has just reconnected. The desktop is the only end
   * that can answer, and `audio.status` is already there for it.
   */
  const refresh = async () => {
    try {
      const data = await client.call<any>('audio.status', {})
      const listening = Boolean(data?.streaming)
      if (listening) stream = Number(data.stream)
      publish({
        listening,
        stream: listening ? Number(data.stream) : null,
        since: listening ? state.since ?? Date.now() : null,
        path: listening ? data.path ?? null : null,
      })
    } catch {
      // A desktop that cannot say is not a desktop that is listening, but it
      // is not evidence either way — so nothing is drawn from silence.
    }
  }

  const helloOff = client.on('hello', (msg: any) => {
    if (!(msg?.capabilities?.audio as any)?.receive) return publish({ ...NO_MIC })
    void refresh()
  })

  /**
   * The press.
   *
   * Permission is asked for here and nowhere else on this road, because here
   * is the one moment there is an activity in front of a person who has just
   * decided to be recorded. It is asked *before* the desktop is told anything,
   * so an instruction never arrives at a handset that is still deciding.
   *
   * Then it is the desktop's own `mic start` — `audio.offer` calls exactly
   * what the CLI calls — and the answer waits for the recorder to actually be
   * open. What comes back is either the file the desktop is writing or the
   * sentence saying why it is not.
   */
  const offer = async () => {
    if (state.busy) return
    const stopping = state.listening
    publish({ busy: true, error: null })
    try {
      if (!stopping) {
        if (!micSupported()) throw new Error('this phone cannot stream its microphone')
        if (!hasMicPermission() && !(await requestMicPermission())) {
          throw new Error('microphone access was not granted — Android will not open the microphone without it')
        }
      }
      const data = await client.call<any>('audio.offer', { op: stopping ? 'stop' : 'start' })
      const listening = Boolean(data?.streaming)
      publish({
        listening,
        stream: listening ? Number(data.stream) : null,
        // The instruction landed before this answer did, so `since` is
        // already the moment the recorder opened; only a card that missed it
        // needs one made up here.
        since: listening ? state.since ?? Date.now() : null,
        path: listening ? data.path ?? null : null,
      })
    } catch (err) {
      publish({ error: sentence(err) })
    } finally {
      publish({ busy: false })
    }
  }

  return {
    stop: () => {
      // Whatever else is being torn down, the microphone goes back first.
      stream = null
      interrupted = false
      if (holder === api) holder = null
      stopMic()
      off()
      statusOff()
      helloOff()
      chunkOff?.remove()
      stoppedOff?.remove()
    },
    offer,
    refresh,
  }
}
