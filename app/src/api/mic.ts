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
 * The phone as a microphone the desktop can switch on.
 *
 * Dictation is the other way round and always was: a person holds a button,
 * the recorder writes an `.m4a`, and the file crosses when they let go. That
 * road is untouched, and it is the right road for "say a sentence and get text
 * back" — the desktop cannot transcribe what has not finished being said.
 *
 * This is the road for sound that has not finished. The desktop asks, the
 * native recorder opens `AudioRecord` at 16 kHz mono, and every hundred
 * milliseconds a chunk goes up the encrypted socket as a binary frame rather
 * than as JSON. There is no file on this side and nothing is kept here: the
 * phone is the ear, and the bytes are already gone by the time the next ones
 * arrive.
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
 *     a denied permission, an input another app is holding — travels back as
 *     the sentence the desktop prints, because the alternative is a person
 *     waiting on sound that was never coming.
 */
export function startMicResponder(client: ConnectClient): () => void {
  const native = linkService()
  /** The stream number the desktop handed out, or null when not recording. */
  let stream: number | null = null

  /** Give the microphone back, and say so if the desktop is still listening. */
  const halt = (error?: string) => {
    const ending = stream
    stream = null
    stopMic()
    if (ending === null) return
    client.call('audio.stopped', { stream: ending, ...(error ? { error } : {}) }).catch(() => {})
  }

  const off = client.on('ev:audio', async (data: any) => {
    if (data?.action === 'stop') {
      // No `audio.stopped` back for a stop the desktop itself asked for: it
      // closed its own file before sending this, and an answer would only
      // race the next `start`.
      stream = null
      stopMic()
      return
    }
    if (data?.action !== 'start' || !data?.id) return
    try {
      if (!micSupported()) throw new Error('this phone cannot stream its microphone')
      if (stream !== null) throw new Error('this phone is already streaming its microphone')
      if (!hasMicPermission() && !(await requestMicPermission())) {
        throw new Error('microphone access was denied on the phone')
      }
      startMic(Number(data.chunkMs) || CHUNK_MS)
      stream = Number(data.stream)
      await client.call('audio.started', { id: data.id, ok: true })
    } catch (err) {
      stream = null
      stopMic()
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

  /** Android took the input back, or the permission was revoked mid-stream. */
  const stoppedOff = native?.addListener('onMicStopped', ({ error }) => {
    halt(error || 'the phone stopped recording')
  })

  /**
   * A socket that is no longer connected is a microphone with nowhere to send
   * to, and unlike `locate` there is nothing to be said for carrying on: the
   * desktop has already closed its file. This is the phone half of "a broken
   * socket leaves nothing hanging".
   */
  const statusOff = client.on('status', ({ status }: { status: string }) => {
    if (status !== 'connected' && stream !== null) {
      stream = null
      stopMic()
    }
  })

  return () => {
    // Whatever else is being torn down, the microphone goes back first.
    stream = null
    stopMic()
    off()
    statusOff()
    chunkOff?.remove()
    stoppedOff?.remove()
  }
}
