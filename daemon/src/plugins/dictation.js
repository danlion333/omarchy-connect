import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { has, run } from '../lib/exec.js'
import { log } from '../lib/log.js'
import * as drops from '../agents/drops.js'
import { agentsEnabled } from './agents.js'

/**
 * Dictating into a phone, and having the desktop do the listening.
 *
 * The phone already has a microphone and Android already has a voice keyboard,
 * so the interesting part is not the recording — it is *whose* transcription
 * this is. The desktop is running `voxtype` with a large Whisper model on the
 * GPU and an initial prompt full of this project's own vocabulary: hyprctl,
 * ChaCha20-Poly1305, cherry-pick. That model turns "чому тут off by one у
 * handshake" into those words. A phone keyboard's cloud dictation turns it
 * into something that has to be retyped, and sends it to somebody else's
 * server on the way. So the sound crosses the wire and the text comes back.
 *
 * The audio takes the road a screenshot already takes — `/api/upload` with
 * `dest: agent`, which lands it in the swept drop directory — so there is no
 * new transport here and no new place on the disk where a phone can write.
 * That road is gated on agent control being on, and so is this method: the
 * bytes cannot get here any other way, and a gate that disagreed with the one
 * on the door would only be decoration.
 *
 * Nothing is kept. A recording is a way of typing, not a file anybody meant to
 * save: the drop is deleted the moment the text exists, whether or not the
 * transcription worked, and the 16 kHz copy that whisper actually reads lives
 * in a temp file for the length of one call.
 */

/** Longer than this is a meeting, and `voxtype meeting` is the tool for that. */
const MAX_SECONDS = 300
/** Re-encoding is fast; a minute of it means ffmpeg is stuck on something. */
const ENCODE_TIMEOUT_MS = 60_000
/** Cold GPU, a large model and five minutes of speech, with room to spare. */
const TRANSCRIBE_TIMEOUT_MS = 5 * 60_000

const available = () => has('voxtype') && has('ffmpeg')

/**
 * The transcript, out of everything else `voxtype` says on its way there.
 *
 * In quiet mode it prints a short preamble about the file it opened, then a
 * blank line, then the text — so the blank line is the separator, and taking
 * everything after the *first* one keeps a transcript that has paragraphs in
 * it intact. If some later version drops the preamble the split finds nothing
 * and the whole of stdout is the answer, which is also right.
 */
function textOf(stdout) {
  const split = stdout.indexOf('\n\n')
  const body = split === -1 ? stdout : stdout.slice(split + 2)
  return body.trim()
}

export default {
  name: 'dictation',

  capabilities() {
    return {
      // Published rather than assumed: `voxtype` is a separate install, and a
      // phone that drew a microphone button on a desktop without it would be
      // offering something that can only fail.
      available: available(),
      maxSeconds: MAX_SECONDS,
    }
  },

  methods: {
    /**
     * Turn a recording the phone just uploaded into the words in it.
     *
     * Whisper wants 16 kHz mono PCM and a phone records compressed AAC at
     * whatever rate its microphone likes, so ffmpeg stands between them. `-t`
     * is a clamp rather than a validation: a recording longer than the limit
     * is transcribed up to the limit, because half of a long thought is worth
     * more to the person waiting than an error message about it.
     */
    async 'dictation.transcribe'({ path: dropped } = {}) {
      if (!agentsEnabled()) {
        throw new Error('agent control is off — run `omarchy-connect agent enable` on the desktop')
      }
      if (!has('voxtype')) throw new Error('voxtype is not installed on the desktop')
      if (!has('ffmpeg')) throw new Error('ffmpeg is not installed on the desktop')
      const source = String(dropped || '')
      if (!drops.holds(source)) throw new Error('that file is not one this phone handed over')

      const wav = path.join(os.tmpdir(), `omarchy-connect-dictation-${process.pid}-${Date.now()}.wav`)
      const started = Date.now()
      try {
        const encoded = await run(
          'ffmpeg',
          ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
           '-i', source, '-t', String(MAX_SECONDS),
           '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', '-f', 'wav', wav],
          { timeout: ENCODE_TIMEOUT_MS },
        )
        if (!encoded.ok) throw new Error(`that recording could not be read (${encoded.stderr.split('\n').pop()})`)

        const spoken = await run('voxtype', ['-q', 'transcribe', wav], { timeout: TRANSCRIBE_TIMEOUT_MS })
        if (!spoken.ok) throw new Error(spoken.stderr.split('\n').pop() || 'voxtype could not transcribe that')

        const text = textOf(spoken.stdout)
        log.ok(`dictation: ${text.length} characters in ${Date.now() - started}ms`)
        return { ok: true, text, ms: Date.now() - started }
      } finally {
        // Both copies go, on every road out of here. The phone keeps the
        // recording if it wants one; the desktop was only ever the ear.
        for (const file of [wav, source]) {
          try {
            fs.rmSync(file, { force: true })
          } catch (err) {
            log.debug('could not clear a dictation file:', err.message)
          }
        }
      }
    },
  },
}
