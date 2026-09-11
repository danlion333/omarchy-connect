import {
  linkService,
  cameraSupported,
  hasCameraPermission,
  requestCameraPermission,
  startCamera,
  stopCamera,
} from '../../modules/omarchy-link'
import { FPS, HEIGHT, QUALITY, WIDTH, frame } from '../lib/videoframe'
import type { ConnectClient } from './client'

/**
 * The phone as a camera the desktop can switch on — and that the person
 * holding the phone can offer.
 *
 * `api/mic.ts` is the road this was built from, one lens up, and the three
 * things it deliberately does *not* do are the same three, for the same
 * reasons:
 *
 *   - **No buffering across a broken socket.** A picture that missed its
 *     socket is worthless once there is a socket again. So a failed send stops
 *     the capture rather than queueing, and the camera indicator goes away with
 *     it. A desktop that wants more asks again.
 *   - **No filming without a desktop that asked.** The only thing that opens
 *     the camera is a `video` instruction from the paired desktop, and that
 *     channel is never delivered to a socket that arrived down a tunnel.
 *   - **No silent refusal.** Every reason this cannot film — an old build, a
 *     denied permission, a lens another app is holding, a desktop too old to
 *     be offered anything — travels back as a sentence.
 *
 * The one real difference from the microphone is what a dropped frame means.
 * Sound has to be continuous or it is a dropout somebody hears; pictures do
 * not, and a phone that cannot encode fast enough should skip to *now* rather
 * than fall behind sending history. So the native side throttles and the
 * desktop counts what never arrived, and neither end treats that as a fault.
 */

/** What a camera card would draw, for the life of the socket. */
export type VideoState = {
  /** Whether the desktop is watching through this phone right now. */
  filming: boolean
  /** The desktop's number for this stream, while there is one. */
  stream: number | null
  /** Which lens, while there is one. */
  camera: 'front' | 'back' | null
  /** When it started, by this phone's clock. */
  since: number | null
  /** The file the desktop said it is writing, when it said. */
  path: string | null
  /** Why the last attempt did not happen, as a sentence. */
  error: string | null
  /** A press that has gone out and not been answered yet. */
  busy: boolean
}

export const NO_VIDEO: VideoState = {
  filming: false,
  stream: null,
  camera: null,
  since: null,
  path: null,
  error: null,
  busy: false,
}

export type VideoResponder = {
  stop: () => void
  /** Offer the camera, or take it back. One press either way. */
  offer: (camera?: 'front' | 'back') => Promise<void>
  /** Ask the desktop what it is doing, and say so. */
  refresh: () => Promise<void>
}

/** The sentence a card can show, out of whatever the desktop or runtime threw. */
function sentence(err: unknown): string {
  const message = (err as Error)?.message || String(err || 'something went wrong')
  if (/unknown method/.test(message)) {
    return 'this desktop is too old to be offered the camera — update Omarchy Connect on it'
  }
  return message
}

export function startVideoResponder(
  client: ConnectClient,
  report: (state: VideoState) => void = () => {},
): VideoResponder {
  const native = linkService()
  /** The stream number the desktop handed out, or null when not filming. */
  let stream: number | null = null

  let state: VideoState = NO_VIDEO
  const publish = (changes: Partial<VideoState>) => {
    const next = { ...state, ...changes }
    if (
      next.filming === state.filming &&
      next.stream === state.stream &&
      next.camera === state.camera &&
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

  /** Give the camera back, and say so if the desktop is still watching. */
  const halt = (error?: string) => {
    const ending = stream
    stream = null
    stopCamera()
    publish({ filming: false, stream: null, camera: null, since: null, path: null, ...(error ? { error } : {}) })
    if (ending === null) return
    client.call('video.stopped', { stream: ending, ...(error ? { error } : {}) }).catch(() => {})
  }

  const off = client.on('ev:video', async (data: any) => {
    if (data?.action === 'stop') {
      // No `video.stopped` back for a stop the desktop itself asked for: it
      // closed its own file before sending this, and an answer would only race
      // the next `start`.
      stream = null
      stopCamera()
      publish({ filming: false, stream: null, camera: null, since: null, path: null })
      return
    }
    if (data?.action !== 'start' || !data?.id) return
    try {
      if (!cameraSupported()) throw new Error('this phone cannot stream its camera')
      if (stream !== null) throw new Error('this phone is already streaming its camera')
      // Refused rather than asked for, for the reason `api/mic.ts` gives at
      // length: a permission dialog needs an activity, and the whole point of
      // this road is that the desktop can ask while the phone is in a pocket.
      // Android's one-time grant is the case that makes it concrete — a phone
      // that filmed happily an hour ago reports the permission gone.
      if (!hasCameraPermission()) {
        throw new Error('camera access is not granted on the phone — open the app and allow it while using the app')
      }
      const camera = data.camera === 'front' ? 'front' : 'back'
      const opened = startCamera({
        camera,
        width: Number(data.width) || WIDTH,
        height: Number(data.height) || HEIGHT,
        fps: Number(data.fps) || FPS,
        quality: Number(data.quality) || QUALITY,
      })
      stream = Number(data.stream)
      publish({ filming: true, stream, camera, since: Date.now(), error: null })
      // What the lens actually opened at, which is the desktop's only way of
      // knowing: it publishes a camera at this size and scales every frame to
      // it, so a request this phone could not honour has to come back as the
      // size it could. `api/speaker.ts` answers `audio.playing` the same way
      // and for the same reason.
      await client.call('video.started', { id: data.id, ok: true, ...opened })
    } catch (err) {
      stream = null
      stopCamera()
      publish({ filming: false, stream: null, camera: null, since: null, path: null, error: sentence(err) })
      await client.call('video.started', { id: data.id, ok: false, error: (err as Error).message }).catch(() => {})
    }
  })

  /**
   * One picture, straight onto the wire.
   *
   * Straight in the literal sense: the bytes the native module encoded are the
   * bytes that go into the frame, with no base64 in between. This used to
   * `atob` the payload and then walk it with `charCodeAt` — the only decoder
   * Hermes has — for tens of kilobytes fifteen times a second, which is
   * hundreds of thousands of interpreted iterations a second on the same
   * thread the interface is drawn on. The native side now hands over a
   * `Uint8Array`, and the whole of that work is a slice of memory the JNI
   * layer copied once. The microphone still sends base64 and should: a chunk
   * is hundreds of bytes, and there is nothing there to win.
   */
  const frameOff = native?.addListener('onCameraFrame', ({ jpeg, seq }) => {
    if (stream === null) return
    try {
      client.sendBytes(frame(stream, seq, jpeg))
    } catch (err) {
      // The socket went away under a live capture. Stopping is the whole
      // answer — there is nowhere for the pictures to go, and a camera left
      // open would be an indicator the user cannot explain.
      halt((err as Error).message)
    }
  })

  /** Android took the lens back, or the permission was revoked mid-stream. */
  const stoppedOff = native?.addListener('onCameraStopped', ({ error }) => {
    halt(error || 'the phone stopped filming')
  })

  /**
   * A socket that is no longer connected is a camera with nowhere to send to,
   * and the desktop has already closed its file.
   */
  const statusOff = client.on('status', ({ status }: { status: string }) => {
    if (status === 'connected') return
    stream = null
    stopCamera()
    publish({ ...NO_VIDEO })
  })

  /**
   * What the desktop is doing, asked rather than assumed. A phone whose app
   * was killed and restarted under a live foreground service knows nothing
   * about a stream the service is still feeding.
   */
  const refresh = async () => {
    try {
      const data = await client.call<any>('video.status', {})
      const filming = Boolean(data?.streaming)
      if (filming) stream = Number(data.stream)
      publish({
        filming,
        stream: filming ? Number(data.stream) : null,
        camera: filming ? (data.camera === 'front' ? 'front' : 'back') : null,
        since: filming ? state.since ?? Date.now() : null,
        path: filming ? data.path ?? null : null,
      })
    } catch {
      // A desktop that cannot say is not a desktop that is watching, but it is
      // not evidence either way — so nothing is drawn from silence.
    }
  }

  const helloOff = client.on('hello', (msg: any) => {
    if (!(msg?.capabilities?.video as any)?.receive) return publish({ ...NO_VIDEO })
    void refresh()
  })

  /**
   * The press.
   *
   * Permission is asked for here and nowhere else on this road, because here
   * is the one moment there is an activity in front of a person who has just
   * decided to be filmed. It is asked *before* the desktop is told anything,
   * so an instruction never arrives at a handset that is still deciding.
   */
  const offer = async (camera: 'front' | 'back' = 'back') => {
    if (state.busy) return
    const stopping = state.filming
    publish({ busy: true, error: null })
    try {
      if (!stopping) {
        if (!cameraSupported()) throw new Error('this phone cannot stream its camera')
        if (!hasCameraPermission() && !(await requestCameraPermission())) {
          throw new Error('camera access was not granted — Android will not open the camera without it')
        }
      }
      const data = await client.call<any>('video.offer', stopping ? { op: 'stop' } : { op: 'start', camera })
      const filming = Boolean(data?.streaming)
      publish({
        filming,
        stream: filming ? Number(data.stream) : null,
        camera: filming ? (data.camera === 'front' ? 'front' : 'back') : null,
        // The instruction landed before this answer did, so `since` is already
        // the moment the lens opened; only a card that missed it needs one
        // made up here.
        since: filming ? state.since ?? Date.now() : null,
        path: filming ? data.path ?? null : null,
      })
    } catch (err) {
      publish({ error: sentence(err) })
    } finally {
      publish({ busy: false })
    }
  }

  return {
    stop: () => {
      // Whatever else is being torn down, the camera goes back first.
      stream = null
      stopCamera()
      off()
      statusOff()
      helloOff()
      frameOff?.remove()
      stoppedOff?.remove()
    },
    offer,
    refresh,
  }
}
