import {
  linkService,
  speakerSupported,
  startSpeaker,
  stopSpeaker,
  writeSpeaker,
} from '../../modules/omarchy-link'
import { BASELINE, CHUNK_MS, readPlayFormat, type PlayFormat, type SpeakerChunk } from '../lib/speakerframe.ts'
import type { ConnectClient } from './client'

/**
 * The phone as the desktop's speaker.
 *
 * `api/mic.ts` is this file's mirror and it is worth naming the two ways in
 * which it is not a copy.
 *
 * The first is who holds the bytes. On the microphone road this phone opens an
 * `AudioRecord` and pushes chunks up the socket; here the desktop pushes
 * chunks down it and this phone opens an `AudioTrack` and writes them into it.
 * So there is no permission to ask for — playing sound needs none on Android —
 * and no dialog, which makes this the one live-media road that works with the
 * app in a pocket and nobody looking at it.
 *
 * The second is what silence means. The desktop deliberately sends *nothing*
 * while nothing is playing (`daemon/src/lib/pipesink.js` argues it at length:
 * a loaded sink writes zeroes for as long as it is idle, and carrying those
 * across Wi-Fi would cost a radio and a battery to deliver silence). A track
 * that is not written to underruns, and an underrun here is not a fault — it
 * is what a paused album sounds like. Nothing in this file times out on it,
 * counts it, or tears anything down for it. What ends a playback is the
 * desktop saying so, the socket dying, or Android taking the track away.
 *
 * Three things this deliberately does *not* do, each of which would be a bug:
 *
 *   - **No buffering across a broken socket.** A chunk that arrived while
 *     there was no track is worthless once there is one — the moment it
 *     belonged to has passed — so it is dropped rather than queued.
 *   - **No playing without a desktop that asked.** The only thing that opens a
 *     track is a `play` instruction from the paired desktop, and that channel
 *     is never delivered to a socket that arrived down a tunnel.
 *   - **No silent refusal.** Every reason this cannot play — an old build with
 *     no native player, a track Android would not give — travels back to the
 *     desktop as a sentence, which is what `omarchy-connect speaker` prints
 *     instead of hanging.
 */

/** What a card would draw, for the life of the socket. */
export type SpeakerState = {
  /** Whether this phone is playing the desktop's sound right now. */
  playing: boolean
  /** The desktop's number for this run, while there is one. */
  stream: number | null
  /** What the track was actually opened at, while there is one. */
  format: PlayFormat | null
  /** When it started, by this phone's clock. */
  since: number | null
  /** Why the last attempt did not happen, as a sentence. */
  error: string | null
}

export const NO_SPEAKER: SpeakerState = { playing: false, stream: null, since: null, format: null, error: null }

export type SpeakerResponder = {
  stop: () => void
}

export function startSpeakerResponder(
  client: ConnectClient,
  report: (state: SpeakerState) => void = () => {},
): SpeakerResponder {
  const native = linkService()
  /** The stream number the desktop handed out, or null when not playing. */
  let stream: number | null = null

  let state: SpeakerState = NO_SPEAKER
  const publish = (changes: Partial<SpeakerState>) => {
    const next = { ...state, ...changes }
    if (
      next.playing === state.playing &&
      next.stream === state.stream &&
      next.since === state.since &&
      next.format?.rate === state.format?.rate &&
      next.format?.channels === state.format?.channels &&
      next.error === state.error
    ) {
      return
    }
    state = next
    report(state)
  }

  /** Give the track back, and tell the desktop if it still thinks we have one. */
  const halt = (error?: string) => {
    const ending = stream
    stream = null
    stopSpeaker()
    publish({ playing: false, stream: null, since: null, format: null, ...(error ? { error } : {}) })
    if (ending === null) return
    client.call('audio.hushed', { stream: ending, ...(error ? { error } : {}) }).catch(() => {})
  }

  const off = client.on('ev:audio', async (data: any) => {
    if (data?.action === 'hush') {
      // No `audio.hushed` back for a stop the desktop itself asked for: it has
      // already forgotten the stream, and an answer would only race the next
      // `play`.
      stream = null
      stopSpeaker()
      publish({ playing: false, stream: null, since: null, format: null })
      return
    }
    if (data?.action !== 'play' || !data?.id) return
    try {
      if (!speakerSupported()) throw new Error('this phone cannot play the desktop’s sound')
      if (stream !== null) throw new Error('this phone is already playing the desktop')
      const chunkMs = Number(data.chunkMs) || CHUNK_MS
      const wanted = readPlayFormat(data)
      // The offer first, the baseline if Android will not give a track for
      // it. `AudioTrack.getMinBufferSize` refuses some rates on some
      // hardware and there is no list anywhere of which — the only way to
      // find out is to ask for one — so a phone that cannot do 48 kHz stereo
      // falls back to the format that has always worked rather than telling
      // the desktop it cannot play at all. A person hears their music in
      // telephone quality, which is what they had yesterday; the alternative
      // is silence.
      let opened: PlayFormat
      try {
        opened = startSpeaker(wanted.rate, wanted.channels, chunkMs)
      } catch (err) {
        if (wanted.rate === BASELINE.rate && wanted.channels === BASELINE.channels) throw err
        opened = startSpeaker(BASELINE.rate, BASELINE.channels, chunkMs)
      }
      stream = Number(data.stream)
      publish({ playing: true, stream, since: Date.now(), format: opened, error: null })
      // The format goes back with the answer, and it is the format the track
      // was *built* at rather than the one that was asked for: the desktop
      // sends whatever this says, so a phone that fell back and did not say
      // so would be a phone playing 48 kHz stereo bytes through a 16 kHz mono
      // track — which is not quieter or slower, it is noise.
      await client.call('audio.playing', { id: data.id, ok: true, ...opened })
    } catch (err) {
      stream = null
      stopSpeaker()
      publish({ playing: false, stream: null, since: null, format: null, error: (err as Error).message })
      await client.call('audio.playing', { id: data.id, ok: false, error: (err as Error).message }).catch(() => {})
    }
  })

  /**
   * One chunk, straight into the track.
   *
   * A chunk carrying a stream number this phone is not playing is dropped
   * without a word — that is the ordinary consequence of a run ending while
   * frames were in flight, and it is exactly what the number is in the frame
   * for. Answering each one would turn one stop into fifty error frames a
   * second going back at a desktop that is already doing the right thing.
   */
  const chunkOff = client.on('speaker', (chunk: SpeakerChunk) => {
    if (stream === null || chunk.stream !== stream) return
    try {
      writeSpeaker(chunk.pcm)
    } catch (err) {
      // The track went away underneath the sound — Android reclaimed it, or
      // the device changed. There is nowhere for the bytes to go, and a
      // desktop left believing its speaker is here would be a desktop whose
      // sound has silently stopped.
      halt((err as Error).message)
    }
  })

  /**
   * Android took the track back, or something else on the phone wanted the
   * output. The desktop hears about it as a sentence rather than as silence.
   */
  const stoppedOff = native?.addListener('onSpeakerStopped', ({ error }: { error: string }) => {
    if (stream === null) return
    halt(error || 'the phone stopped playing')
  })

  /**
   * A socket that is no longer connected is a speaker with nothing to play.
   * The desktop takes its sink down on the same event from the other side, so
   * there is nothing to be said for holding a track open here.
   */
  const statusOff = client.on('status', ({ status }: { status: string }) => {
    if (status === 'connected') return
    stream = null
    stopSpeaker()
    publish({ ...NO_SPEAKER })
  })

  return {
    stop: () => {
      off?.()
      chunkOff?.()
      statusOff?.()
      stoppedOff?.remove?.()
      stream = null
      stopSpeaker()
      publish({ ...NO_SPEAKER })
    },
  }
}
