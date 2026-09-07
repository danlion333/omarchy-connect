import { AudioModule, RecordingPresets, setAudioModeAsync } from 'expo-audio'
import type { AudioRecorder, RecordingOptions } from 'expo-audio'

import type { ConnectClient } from './client'
import { upload } from './attach'
import { borrowMicrophone, type MicHold } from './mic'

/**
 * Talking to an agent instead of typing to it — with the desktop doing the
 * listening.
 *
 * The phone has a microphone and Android has a voice keyboard, so the part
 * worth building is not the recording, it is *whose* transcription this is.
 * The desktop runs `voxtype` against a large Whisper model on its GPU, primed
 * with a prompt full of the vocabulary these conversations are actually made
 * of — hyprctl, cherry-pick, ChaCha20-Poly1305. That is the difference between
 * a sentence you send and a sentence you retype. It is also the difference
 * between a recording that stays on your own two machines and one that goes to
 * a keyboard vendor.
 *
 * So the sound goes over the same wire a screenshot goes over — the encrypted
 * link for the request, `/api/upload` for the bytes — and what comes back is
 * text, which lands in the composer rather than in the conversation. Whisper
 * mishears a name occasionally, and the fix for that is a cursor, not a
 * retake.
 */

/**
 * Voice, not music.
 *
 * 16 kHz mono is what whisper resamples to anyway, so recording at it saves
 * the upload the three quarters of every file that the desktop was going to
 * throw away — which on a phone's uplink is most of the wait. AAC at 32 kbit/s
 * is transparent for speech at that rate.
 */
export const RECORDING: RecordingOptions = {
  ...RecordingPresets.HIGH_QUALITY,
  extension: '.m4a',
  sampleRate: 16000,
  numberOfChannels: 1,
  bitRate: 32000,
}

/**
 * The live stream's microphone, while a dictation is holding it.
 *
 * There is one dictation at a time in this app — one composer, one recorder,
 * one button — so one hold is the whole of the bookkeeping. It lives here
 * rather than in the screen because the two ends of it are two separate
 * taps with a whole recording between them, and a component that unmounts in
 * the middle of that must still give the microphone back: `release` is what
 * the screen calls on its way out.
 */
let hold: MicHold | null = null

/** Give the live stream its input back, whether or not this took it. */
export function release(): void {
  hold?.release()
  hold = null
}

/**
 * Ask for the microphone, and put the audio session in a state that can use it.
 *
 * `allowsRecording` is the iOS half — a session configured for playback
 * records silence — and it costs nothing to set on Android.
 *
 * The borrow is the part that is not obvious. This is the second recorder on
 * one hardware input: the first is the live stream the desktop is listening
 * to (`api/mic`), which knows nothing about this screen and was, until this
 * line existed, simply taken from underneath. `borrowMicrophone` throws a
 * sentence on a handset that has already been seen to do that — which the
 * screen shows — and otherwise stands watch, so that an input Android hands
 * over is handed back when `finish` releases rather than left dead.
 */
export async function ready(): Promise<void> {
  const permission = await AudioModule.requestRecordingPermissionsAsync()
  if (!permission.granted) throw new Error('microphone access was denied')
  release()
  hold = borrowMicrophone()
  try {
    await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true })
  } catch (err) {
    release()
    throw err
  }
}

/** Stop the recorder and hand back the file, or nothing if it caught none. */
export async function finish(recorder: AudioRecorder): Promise<string | null> {
  try {
    await recorder.stop()
    return recorder.uri
  } finally {
    // The input goes back before the file goes anywhere: transcription is a
    // second and a half on the desktop, and a live stream should not spend it
    // waiting.
    release()
  }
}

/**
 * Push the recording across and come back with the words in it.
 *
 * The bytes travel as an agent drop — the road a screenshot already takes,
 * gated on the same switch — and the desktop deletes them as soon as it has
 * read them: a recording is a way of typing, not a file anybody meant to keep.
 */
export async function transcribe(
  client: ConnectClient,
  call: <T>(method: string, params?: Record<string, unknown>) => Promise<T>,
  uri: string,
): Promise<string> {
  const path = await upload(client, { uri, name: `dictation-${Date.now().toString(36)}.m4a` })
  const { text } = await call<{ text: string }>('dictation.transcribe', { path })
  return (text || '').trim()
}
