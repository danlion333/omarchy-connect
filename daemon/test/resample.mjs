/**
 * The interpolator under `lib/pipesource.js`.
 *
 * The phone speaks at 16 kHz and the PipeWire source is loaded at a multiple
 * of it, because the module's ring is counted in frames and the only way to
 * make it shorter is to make the frames shorter. This is the piece that makes
 * the extra frames, and the checks are the ones that decide whether it is a
 * microphone or a filter somebody will hear: a tone comes out as the same tone
 * at the same height, voice-band content is not touched, what is above the
 * phone's band is gone rather than mirrored, silence is silence, a chunk
 * boundary is not audible, and it is cheap enough to run on every chunk.
 */
import { check, done } from '../../tools/test-harness.mjs'
import { Upsampler, Downsampler } from '../src/lib/resample.js'
import { RATE, CHUNK_MS } from '../src/lib/mic.js'
import { RATE as SOURCE_RATE } from '../src/lib/pipesource.js'
import { RATE as SINK_RATE } from '../src/lib/pipesink.js'

const AMPLITUDE = 10000
const chunkSamples = (RATE * CHUNK_MS) / 1000

/** A tone at `hz`, as the phone's chunks, through one interpolator. */
function tone(up, hz, chunks = 25) {
  const out = []
  let t = 0
  for (let c = 0; c < chunks; c += 1) {
    const pcm = Buffer.alloc(chunkSamples * 2)
    for (let i = 0; i < chunkSamples; i += 1, t += 1) {
      pcm.writeInt16LE(Math.round(AMPLITUDE * Math.sin((2 * Math.PI * hz * t) / RATE)), i * 2)
    }
    out.push(up.process(pcm))
  }
  return Buffer.concat(out)
}

const peak = (pcm, from = 0) => {
  let top = 0
  for (let i = from; i + 1 < pcm.length; i += 2) top = Math.max(top, Math.abs(pcm.readInt16LE(i)))
  return top
}
const dB = (ratio) => 20 * Math.log10(ratio)

/* ── what the daemon actually uses ─────────────────────────────────────── */

const factor = SOURCE_RATE / RATE
check('the source rate is a whole multiple of the phone\'s', Number.isInteger(factor) && factor >= 1, `${SOURCE_RATE} / ${RATE}`)

for (const L of [...new Set([factor, 3, 6, 12])]) {
  const to = RATE * L
  const up = new Upsampler({ factor: L })
  const skip = up.taps * L * 2 // past the start-up transient

  const out = tone(up, 1000)
  check(`x${L}: a chunk comes back ${L} times as long`, out.length === 25 * chunkSamples * 2 * L, `${out.length} bytes`)

  // The same tone, delayed by exactly the filter's group delay, to within a
  // sample's rounding: no gain, no phase, no ripple worth a name.
  const delay = up.delaySamples * L
  let worst = 0
  for (let j = skip; j + 1 < out.length / 2; j += 1) {
    const want = AMPLITUDE * Math.sin((2 * Math.PI * 1000 * (j - delay)) / to)
    worst = Math.max(worst, Math.abs(out.readInt16LE(j * 2) - want))
  }
  check(`x${L}: a 1 kHz tone is the same tone, ${up.delaySamples.toFixed(2)} samples later`, worst <= 2, `worst error ${worst.toFixed(2)} LSB`)

  // Voice-band content is untouched; the top of the phone's band is rolled
  // off rather than mirrored above it.
  const level = (hz) => dB(peak(tone(new Upsampler({ factor: L }), hz), skip * 2) / AMPLITUDE)
  check(`x${L}: 3 kHz passes flat`, Math.abs(level(3000)) < 0.5, `${level(3000).toFixed(2)} dB`)
  check(`x${L}: 6.5 kHz passes flat`, Math.abs(level(6500)) < 1, `${level(6500).toFixed(2)} dB`)
  check(`x${L}: 7.9 kHz is gone`, level(7900) < -50, `${level(7900).toFixed(1)} dB`)

  // Zeros in, zeros out: a quiet room does not hiss.
  const quiet = new Upsampler({ factor: L }).process(Buffer.alloc(chunkSamples * 2))
  check(`x${L}: silence is silence`, peak(quiet) === 0, `peak ${peak(quiet)}`)

  // Chunking is invisible: one call over the whole signal equals many calls
  // over its pieces, byte for byte.
  const whole = new Upsampler({ factor: L })
  const pieces = new Upsampler({ factor: L })
  const signal = Buffer.alloc(chunkSamples * 2 * 7)
  for (let i = 0; i < signal.length / 2; i += 1) signal.writeInt16LE(((i * 977) % 20000) - 10000, i * 2)
  const atOnce = whole.process(signal)
  const cut = []
  for (let at = 0; at < signal.length; at += 50 * 2) cut.push(pieces.process(signal.subarray(at, at + 100)))
  check(`x${L}: a chunk boundary changes nothing`, Buffer.concat(cut).equals(atOnce), `${Buffer.concat(cut).length} vs ${atOnce.length}`)

  // Cheap: the encryption the same chunk already went through costs more.
  const chunk = Buffer.alloc(chunkSamples * 2)
  const started = performance.now()
  for (let i = 0; i < 200; i += 1) up.process(chunk)
  const perChunk = (performance.now() - started) / 200
  check(`x${L}: one chunk costs well under its own length`, perChunk < CHUNK_MS / 10, `${perChunk.toFixed(3)} ms for ${CHUNK_MS} ms`)
}

/* ── and the decimator under `lib/pipesink.js` ─────────────────────────── */

/**
 * The other direction, which has one danger the interpolator does not.
 *
 * Throwing samples away without filtering first folds everything above the
 * output's Nyquist back down into the band — a 6 kHz whistle in a 48 kHz sink
 * would come out of a 16 kHz wire as a 2 kHz one, louder than anything else in
 * the room and impossible to explain. So the checks that matter are: a tone in
 * the voice band survives at its own height, a tone above the wire's Nyquist
 * is *gone* rather than moved, a chunk boundary is inaudible whatever lengths
 * the pipe hands over, and it is cheap.
 */
for (const D of [SINK_RATE / RATE, 3, 6]) {
  const down = new Downsampler({ factor: D })
  const inRate = RATE * D
  /** A tone at `hz`, as the sink's own PCM, through one decimator. */
  const played = (hz, seconds = 0.3) => {
    const samples = Math.round(inRate * seconds)
    const pcm = Buffer.alloc(samples * 2)
    for (let i = 0; i < samples; i += 1) pcm.writeInt16LE(Math.round(AMPLITUDE * Math.sin((2 * Math.PI * hz * i) / inRate)), i * 2)
    return down.process(pcm)
  }

  const voice = played(1000)
  check(`÷${D}: the output is a ${D}th as long`, voice.length === Math.round((inRate * 0.3) / D) * 2, `${voice.length} bytes`)
  // Past the filter's own warm-up, which is half a window.
  const kept = peak(voice, 400)
  check(`÷${D}: a 1 kHz tone keeps its height`, Math.abs(dB(kept / AMPLITUDE)) < 0.5, `${dB(kept / AMPLITUDE).toFixed(2)} dB`)

  const above = new Downsampler({ factor: D })
  const inRate2 = RATE * D
  const samples = Math.round(inRate2 * 0.3)
  const pcm = Buffer.alloc(samples * 2)
  // 10 kHz: comfortably above the wire's 8 kHz Nyquist, and exactly the sort
  // of thing a desktop plays all day.
  for (let i = 0; i < samples; i += 1) pcm.writeInt16LE(Math.round(AMPLITUDE * Math.sin((2 * Math.PI * 10000 * i) / inRate2)), i * 2)
  const folded = peak(above.process(pcm), 400)
  check(`÷${D}: a tone above the wire's Nyquist is gone, not folded down`, dB(folded / AMPLITUDE) < -50, `${dB(Math.max(folded, 1) / AMPLITUDE).toFixed(1)} dB`)

  // Ragged lengths on purpose: a pipe hands over whatever it has, and a
  // decimator that assumed a multiple of the factor would shift its phase at
  // every read and tick once a chunk.
  const whole = new Downsampler({ factor: D })
  const pieces = new Downsampler({ factor: D })
  const signal = Buffer.alloc(D * 2 * 700)
  for (let i = 0; i < signal.length / 2; i += 1) signal.writeInt16LE(((i * 977) % 20000) - 10000, i * 2)
  const atOnce = whole.process(signal)
  const cut = []
  for (let at = 0; at < signal.length; at += 47 * 2) cut.push(pieces.process(signal.subarray(at, at + 47 * 2)))
  check(`÷${D}: reads of a ragged length change nothing`, Buffer.concat(cut).equals(atOnce), `${Buffer.concat(cut).length} vs ${atOnce.length}`)

  const silence = new Downsampler({ factor: D }).process(Buffer.alloc(D * 2 * 100))
  check(`÷${D}: silence stays silence`, peak(silence) === 0, String(peak(silence)))

  const block = Buffer.alloc(D * chunkSamples * 2)
  const startedDown = performance.now()
  for (let i = 0; i < 200; i += 1) down.process(block)
  const perChunkDown = (performance.now() - startedDown) / 200
  check(`÷${D}: one chunk costs well under its own length`, perChunkDown < CHUNK_MS / 2, `${perChunkDown.toFixed(3)} ms for ${CHUNK_MS} ms`)
}

check('a decimation factor that is not a whole number is refused', (() => { try { new Downsampler({ factor: 2.5 }); return false } catch { return true } })())
check('and a factor of one is a copy', new Downsampler({ factor: 1 }).process(Buffer.from([1, 2, 3, 4])).equals(Buffer.from([1, 2, 3, 4])))

check('a factor that is not a whole number is refused', (() => { try { new Upsampler({ factor: 2.5 }); return false } catch { return true } })())
check('a factor of one is a copy', new Upsampler({ factor: 1 }).process(Buffer.from([1, 2, 3, 4])).equals(Buffer.from([1, 2, 3, 4])))

done()
