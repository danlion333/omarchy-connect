/**
 * More samples a second, without a native library.
 *
 * The phone speaks at 16 kHz and that is the right rate for everything that
 * listens to *words*: whisper wants it, a WAV in the cache is small, and the
 * link carries it without noticing. It is the wrong rate for the one thing on
 * this desktop that keeps sound waiting by the *frame* rather than by the
 * second. `module-pipe-tunnel`, which is what pipewire-pulse's
 * `module-pipe-source` is underneath, holds a ring of 8192 frames in front of
 * every reader and steers itself to keep it that full — a constant in its
 * source, with no property that changes it. At 16 kHz that is half a second
 * between the phone and Zoom. At 96 kHz it is 85 ms. Nothing about the sound
 * changes; only how many frames a second the module is told it is looking at.
 *
 * So `lib/pipesource.js` loads the module at a multiple of the phone's rate
 * and this file makes the extra samples. It is an ordinary polyphase
 * interpolator: zero-stuff by the factor, low-pass at the original Nyquist
 * with a Kaiser-windowed sinc, and skip the multiplications by the zeros.
 * Forty-eight taps per phase at 70 dB puts the passband edge near 7.3 kHz and
 * the images below the noise, and costs the daemon a few million multiplies a
 * second — a rounding error beside the encryption the same bytes already went
 * through. The filter is 1.5 ms long, which is the whole of what this adds.
 *
 * Integer factors only, and mono, because that is the one road it exists for.
 */

/** Zeroth-order modified Bessel function, by its series. Plenty for a window. */
function besselI0(x) {
  let sum = 1
  let term = 1
  const half = x / 2
  for (let k = 1; k < 64; k += 1) {
    term *= (half / k) ** 2
    sum += term
    if (term < sum * 1e-12) break
  }
  return sum
}

/**
 * The prototype low-pass: a windowed sinc of `length` taps at the output rate,
 * cut off at `cutoff` cycles per output sample, with gain `gain` at DC.
 */
function windowedSinc(length, cutoff, beta, gain) {
  const h = new Float64Array(length)
  const middle = (length - 1) / 2
  const norm = besselI0(beta)
  let sum = 0
  for (let n = 0; n < length; n += 1) {
    const t = n - middle
    const sinc = t === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * t) / (Math.PI * t)
    const r = (2 * t) / (length - 1)
    const window = besselI0(beta * Math.sqrt(Math.max(0, 1 - r * r))) / norm
    h[n] = sinc * window
    sum += h[n]
  }
  for (let n = 0; n < length; n += 1) h[n] *= gain / sum
  return h
}

/**
 * Turns 16-bit mono PCM at one rate into the same sound at `factor` times it.
 *
 * Stateful: it remembers the last `taps - 1` input samples, so the sound is
 * continuous across chunks and a chunk boundary is not audible. `process()`
 * takes a Buffer of little-endian samples and returns a new one `factor`
 * times as long. A factor of 1 is allowed and is a copy.
 */
export class Upsampler {
  constructor({ factor, taps = 48, attenuationDb = 70 } = {}) {
    if (!Number.isInteger(factor) || factor < 1) throw new Error(`cannot upsample by ${factor}`)
    this.factor = factor
    this.taps = taps
    // Kaiser's own rule for the window shape that gives this much rejection.
    const a = attenuationDb
    const beta = a > 50 ? 0.1102 * (a - 8.7) : a >= 21 ? 0.5842 * (a - 21) ** 0.4 + 0.07886 * (a - 21) : 0
    // Cut off a little under the input Nyquist — 0.9 of it, 7.2 kHz for the
    // phone — so the transition band ends where the first image begins rather
    // than straddling it: the top few hundred hertz of a voice are worth less
    // than a mirror of them above 8 kHz. In cycles per output sample, that is
    // 0.9/(2·factor). Gain `factor`, to make up for the zeros.
    const h = windowedSinc(factor * taps, 0.9 / (2 * factor), beta, factor)
    // Phase p of the output uses taps p, p+factor, p+2·factor…, each against a
    // successively older input sample. Laid out phase-major so the inner loop
    // is one contiguous run.
    this.phases = new Float32Array(factor * taps)
    for (let p = 0; p < factor; p += 1) for (let k = 0; k < taps; k += 1) this.phases[p * taps + k] = h[p + k * factor]
    this.history = new Float32Array(taps - 1)
  }

  /** The delay this adds, in input samples: half the window. */
  get delaySamples() {
    return (this.factor * this.taps - 1) / (2 * this.factor)
  }

  process(pcm) {
    const { factor, taps, phases, history } = this
    const n = pcm.length >> 1
    const out = Buffer.allocUnsafe(n * factor * 2)
    if (factor === 1) {
      pcm.copy(out, 0, 0, n * 2)
      return out
    }
    // The window slides over `history ++ input`; the oldest sample it can see
    // is `taps - 1` behind the newest.
    const x = new Float32Array(taps - 1 + n)
    x.set(history, 0)
    for (let i = 0; i < n; i += 1) x[taps - 1 + i] = pcm.readInt16LE(i * 2)
    let o = 0
    for (let i = 0; i < n; i += 1) {
      const newest = taps - 1 + i
      for (let p = 0; p < factor; p += 1) {
        let acc = 0
        const base = p * taps
        for (let k = 0; k < taps; k += 1) acc += phases[base + k] * x[newest - k]
        const v = acc < -32768 ? -32768 : acc > 32767 ? 32767 : Math.round(acc)
        out.writeInt16LE(v, o)
        o += 2
      }
    }
    if (n >= taps - 1) history.set(x.subarray(x.length - (taps - 1)))
    else {
      history.copyWithin(0, n)
      history.set(x.subarray(taps - 1), taps - 1 - n)
    }
    return out
  }
}

/**
 * Fewer samples a second, for the sound going the other way.
 *
 * `Upsampler` above exists because the phone speaks at 16 kHz and PipeWire
 * counts its ring in frames. This exists for the mirror of that problem, and
 * it is not symmetrical. A sink loaded at 16 kHz would need no arithmetic at
 * all — pipewire-pulse would resample every program on the desktop into it —
 * but the ring is 8192 frames whichever way the bytes are pointing, and at
 * 16 kHz that is half a second between pressing play and hearing it. So
 * `lib/pipesink.js` loads the sink at a multiple of the wire's rate for
 * exactly the reason the source is loaded at one, and something has to take
 * the extra samples back out again before they go up a link that speaks
 * 16 kHz mono.
 *
 * Decimation is an interpolator read backwards. The samples that are about to
 * be thrown away carry everything above the *output* Nyquist, and throwing
 * them away without asking first folds all of it down into the audible band —
 * a 10 kHz whistle in a 48 kHz sink comes out of a 16 kHz wire as a 6 kHz one,
 * louder than anything else in the room. So: low-pass at the output Nyquist
 * with the same Kaiser-windowed sinc, then keep every `factor`-th sample.
 *
 * The filter runs at the *input* rate, which is the one honest cost here:
 * 48 taps against every output sample rather than against every input one, so
 * a factor of three costs 16000 × 144 multiplies a second. That is the same
 * rounding error beside ChaCha20 that the interpolator is.
 *
 * Stateful, like its mirror, in two ways that both matter across a chunk
 * boundary: the last `taps - 1` input samples, so the filter does not restart
 * at every read; and where the next kept sample falls, so a chunk whose length
 * is not a multiple of the factor does not shift the phase of everything after
 * it. Sound out of a pipe arrives in whatever lengths the pipe felt like, and
 * a decimator that assumed otherwise would tick.
 */
export class Downsampler {
  constructor({ factor, taps = 48, attenuationDb = 70 } = {}) {
    if (!Number.isInteger(factor) || factor < 1) throw new Error(`cannot downsample by ${factor}`)
    this.factor = factor
    this.taps = taps
    const a = attenuationDb
    const beta = a > 50 ? 0.1102 * (a - 8.7) : a >= 21 ? 0.5842 * (a - 21) ** 0.4 + 0.07886 * (a - 21) : 0
    // The window is `factor * taps` long at the input rate, cut off a little
    // under the *output* Nyquist — 0.9 of it, 7.2 kHz for a 16 kHz wire — so
    // the transition band ends below the fold rather than straddling it. In
    // cycles per input sample that is 0.9/(2·factor), the same number the
    // interpolator uses, because it is the same corner seen from the fast side.
    // Gain 1: nothing is being made up for here, only removed.
    this.filter = windowedSinc(factor * taps, 0.9 / (2 * factor), beta, 1)
    this.length = this.filter.length
    this.history = new Float32Array(this.length - 1)
    /**
     * How far into the next chunk the next kept sample sits. Zero means the
     * first sample of it is kept.
     */
    this.phase = 0
  }

  /** The delay this adds, in output samples: half the window. */
  get delaySamples() {
    return (this.length - 1) / (2 * this.factor)
  }

  /**
   * `pcm` at a `factor`-th of the rate. A Buffer of little-endian samples in,
   * a new one out, and a factor of 1 is a copy — the same contract the
   * interpolator keeps, because `pipesink.js` should not have to know which of
   * the two it was handed.
   */
  process(pcm) {
    const { factor, length, filter, history } = this
    const n = pcm.length >> 1
    if (factor === 1) {
      const flat = Buffer.allocUnsafe(n * 2)
      pcm.copy(flat, 0, 0, n * 2)
      return flat
    }
    // The window slides over `history ++ input`, and only the positions where
    // a sample is being kept are ever evaluated.
    const x = new Float32Array(length - 1 + n)
    x.set(history, 0)
    for (let i = 0; i < n; i += 1) x[length - 1 + i] = pcm.readInt16LE(i * 2)

    const kept = n > this.phase ? Math.ceil((n - this.phase) / factor) : 0
    const out = Buffer.allocUnsafe(kept * 2)
    let o = 0
    let i = this.phase
    for (; i < n; i += factor) {
      const newest = length - 1 + i
      let acc = 0
      for (let k = 0; k < length; k += 1) acc += filter[k] * x[newest - k]
      const v = acc < -32768 ? -32768 : acc > 32767 ? 32767 : Math.round(acc)
      out.writeInt16LE(v, o)
      o += 2
    }
    this.phase = i - n

    if (n >= length - 1) history.set(x.subarray(x.length - (length - 1)))
    else {
      history.copyWithin(0, n)
      history.set(x.subarray(length - 1), length - 1 - n)
    }
    return out
  }
}
