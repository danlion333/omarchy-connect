import {
  headsetFacts,
  headsetSupported,
  startHeadset,
  stopHeadset,
  type HeadsetFacts,
} from '../../modules/omarchy-link'
import type { ConnectClient } from './client'

/**
 * The phone as a headset: `api/mic.ts` and `api/speaker.ts` at the same time.
 *
 * Neither of those two files changes for this. That is the point of it being a
 * mode rather than a third road: the microphone still opens because the
 * desktop asked for it and the track still opens because the desktop asked for
 * that, with the same stream numbers, the same answers and the same endings.
 * What this responder does is put the *phone* into the state those two are
 * opened in — one audio session, the communication source, an
 * `AcousticEchoCanceler` on it, the loudspeaker instead of the earpiece — and
 * it has to happen before either of them opens anything, because every one of
 * those is fixed at the moment `AudioRecord` and `AudioTrack` are constructed
 * and cannot be moved afterwards.
 *
 * So the desktop's order is load-bearing and it is the desktop's to keep:
 * enter the mode, then ask for the microphone, then ask for the track. The
 * native side is written not to punish a different order — a track built
 * before there is a session to join gets one of its own and simply has no
 * canceller behind it — but the desktop keeps it anyway
 * (`daemon/src/plugins/audio.js`, `requestHeadset`).
 *
 * ## Why the answer carries facts rather than an `ok`
 *
 * `AcousticEchoCanceler.isAvailable()` is a per-handset answer, and some
 * handsets say no. A mode that reported "on" on such a phone would be a duplex
 * that howls, with nothing anywhere saying why. So the answer carries what the
 * phone actually got — whether a canceller exists on this device at all, and
 * whether one was created and enabled for this session — and the desktop
 * prints it. Saying so is the whole of what can honestly be done about it from
 * here; an echo canceller written in Kotlin or in Node would be a worse one
 * than the phone's, in the wrong place.
 *
 * ## Leaving
 *
 * Twice as important as entering, and for a reason that outlives the app: a
 * phone left in `MODE_IN_COMMUNICATION` with its communication device forced
 * to the loudspeaker is a phone whose *own* calls and music come out wrong
 * afterwards, and nothing on screen would explain it. So the mode is left when
 * the desktop says so, when the socket goes — a desktop that cannot be reached
 * cannot ask for anything, and this phone should not be waiting in a mode for
 * it — and when the responder itself is stopped.
 */

/** What the phone reports about being a headset, for a card that wants it. */
export type HeadsetState = {
  /** Whether this phone is in the mode right now. */
  on: boolean
  /** Whether the platform gave this session an echo canceller. */
  echoCancellation: boolean
  /** Why the last attempt did not happen, as a sentence. */
  error: string | null
}

export const NO_HEADSET: HeadsetState = { on: false, echoCancellation: false, error: null }

export type HeadsetResponder = {
  stop: () => void
}

export function startHeadsetResponder(
  client: ConnectClient,
  report: (state: HeadsetState) => void = () => {},
): HeadsetResponder {
  let on = false

  let state: HeadsetState = NO_HEADSET
  const publish = (changes: Partial<HeadsetState>) => {
    const next = { ...state, ...changes }
    if (next.on === state.on && next.echoCancellation === state.echoCancellation && next.error === state.error) return
    state = next
    report(state)
  }

  /** Leave the mode without telling anybody — the socket has gone, or we have. */
  const leave = () => {
    on = false
    stopHeadset()
    publish({ ...NO_HEADSET })
  }

  const off = client.on('ev:audio', async (data: any) => {
    if (data?.action !== 'headset' || !data?.id) return
    const wanted = data.on !== false
    try {
      if (!headsetSupported()) throw new Error('this phone cannot be a headset — update the app on it')
      if (wanted) startHeadset()
      else stopHeadset()
      on = wanted
      const facts: HeadsetFacts = headsetFacts()
      publish({ on: wanted, echoCancellation: wanted && facts.aecEnabled, error: null })
      // The facts and not a bare `ok`: a phone with no canceller is in the
      // mode and is going to echo, and the desktop is the end that can say so
      // to a person.
      await client.call('audio.wearing', {
        id: data.id,
        ok: true,
        on: wanted,
        aec: { available: facts.aecAvailable, enabled: facts.aecEnabled },
      })
    } catch (err) {
      // Whatever went wrong on the way in, this phone must not be left half
      // in the mode: the routing and the audio manager's mode outlive the
      // socket that asked for them.
      leave()
      publish({ error: (err as Error).message })
      await client.call('audio.wearing', { id: data.id, ok: false, error: (err as Error).message }).catch(() => {})
    }
  })

  /**
   * A socket that is no longer connected cannot ask for the mode to end, so
   * the phone ends it itself. This is the one piece of state in the app that
   * would be felt in *other* apps if it were left behind.
   */
  const statusOff = client.on('status', ({ status }: { status: string }) => {
    if (status === 'connected' || !on) return
    leave()
  })

  return {
    stop: () => {
      off?.()
      statusOff?.()
      leave()
    },
  }
}
