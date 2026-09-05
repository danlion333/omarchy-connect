/**
 * The level the phone arrives at, rather than the number somebody typed.
 *
 * `audio.mjs` holds the constant gain to account — a multiply, a saturation, a
 * config key. This suite is about the thing that made the constant not enough.
 *
 * Measured on the real link before this existed, in one recording with one
 * `gain: 4` on it: ordinary speech sat near -19 dBFS while the loud moments
 * were already pinned to the rail, 114 samples at ±32767. Held against the USB
 * webcam on the same desk playing the same sound back through the same
 * speaker, the phone came out about 7 dB under it on the quiet passages and
 * over it on the loud ones. That is not a number that was chosen badly. It is
 * a signal whose dynamic range is wider than any one number, which is what a
 * follower is for.
 *
 * So the checks here are about *shape over time*, not about arithmetic on one
 * buffer: does it open up for a murmur, does it refuse to open up for a room
 * with nobody in it, and does it shut before a laugh reaches the rail rather
 * than after. The last one is the only one with no tolerance in it — a
 * follower that clips is worse than the constant it replaced, because it
 * clips at a level nobody chose.
 */
import { check, done } from '../../tools/test-harness.mjs'
import { Leveller, MAX_AUTO_GAIN, MIN_AUTO_GAIN, RATE, CHUNK_MS, amplify, readAuto } from '../src/lib/mic.js'

const SAMPLES = (RATE * CHUNK_MS) / 1000
const CHUNKS_PER_S = 1000 / CHUNK_MS

/** One chunk of a tone whose peak is `peak`, so a check can talk in levels. */
function tone(peak, { samples = SAMPLES, from = 0 } = {}) {
  const pcm = Buffer.alloc(samples * 2)
  for (let i = 0; i < samples; i += 1) {
    pcm.writeInt16LE(Math.round(peak * Math.sin((2 * Math.PI * 220 * (from + i)) / RATE)), i * 2)
  }
  return pcm
}

/** The loudest sample in a buffer, which is what every check below is about. */
function peakOf(pcm) {
  let peak = 0
  for (let i = 0; i + 2 <= pcm.length; i += 2) {
    const v = Math.abs(pcm.readInt16LE(i))
    if (v > peak) peak = v
  }
  return peak
}

const clipped = (pcm) => {
  let n = 0
  for (let i = 0; i + 2 <= pcm.length; i += 2) {
    const v = pcm.readInt16LE(i)
    if (v >= 32767 || v <= -32767) n += 1
  }
  return n
}

const dB = (v) => 20 * Math.log10(v / 32768)

/** Run `seconds` of a fixed input through a fresh follower, keeping the output. */
function run(peak, seconds, { gain = 1 } = {}) {
  const leveller = new Leveller({ gain })
  const out = []
  let at = 0
  for (let i = 0; i < seconds * CHUNKS_PER_S; i += 1) {
    out.push(leveller.push(tone(peak, { from: at })))
    at += SAMPLES
  }
  return { leveller, out, last: out[out.length - 1] }
}

/* ── the murmur ────────────────────────────────────────────────────────── */

// The case the issue is: speech that arrives around -38 dBFS, which #41's four
// leaves at -26 and the webcam beside it puts near -23.
const QUIET = 400

const started = new Leveller({ gain: 1 })
const first = started.push(tone(QUIET))
check(
  'the first chunk of a quiet voice is not slammed to the target — the follower opens, it does not jump',
  peakOf(first) < QUIET * 2,
  `${peakOf(first)} from ${QUIET}`,
)

// The level the same recording measured for ordinary speech, before any gain:
// a raw peak around 900. This is the case the target was chosen for.
const ORDINARY = 900

const speech = run(ORDINARY, 6)
check(
  'six seconds of ordinary speech ends up at the target rather than where it started',
  dB(peakOf(speech.last)) > -9.5 && dB(peakOf(speech.last)) < -6.5,
  `${dB(peakOf(speech.last)).toFixed(1)} dBFS`,
)

// Quieter than that and the ceiling on the gain arrives first. It still lands
// a long way above the webcam this was measured against, which puts the same
// sound near -23 dBFS on its loudest tenth of a second.
const murmur = run(QUIET, 6)
check(
  'and a voice too quiet even for the ceiling still lands well clear of the webcam beside it',
  dB(peakOf(murmur.last)) > -12,
  `${dB(peakOf(murmur.last)).toFixed(1)} dBFS`,
)
check(
  'and that is louder than the constant four ever made it',
  peakOf(murmur.last) > peakOf(amplify(tone(QUIET), 4)),
  `${peakOf(murmur.last)} vs ${peakOf(amplify(tone(QUIET), 4))}`,
)

// The rate is the whole difference between following a room and pumping. Six
// decibels a second is slow enough that a pause between two sentences does not
// audibly swell and fast enough that nobody says the first sentence twice.
const oneSecond = run(QUIET, 1)
check(
  'the gain climbs no faster than about six decibels a second',
  20 * Math.log10(oneSecond.leveller.gain) < 7,
  `${(20 * Math.log10(oneSecond.leveller.gain)).toFixed(1)} dB in a second`,
)

/* ── the empty room ────────────────────────────────────────────────────── */

// The failure every automatic gain is accused of, and the reason `DEFAULT_GAIN`
// argued for a constant in the first place: silence winding the gain up until
// the hiss is as loud as the voice was. The gate is what forbids it.
const floor = run(50, 20)
check(
  'twenty seconds of an empty room does not wind the gain up at all',
  floor.leveller.gain === 1,
  String(floor.leveller.gain),
)
check('so the noise floor comes out exactly where the phone put it', peakOf(floor.last) === 50, String(peakOf(floor.last)))

// And having opened up for a voice, a pause holds the gain rather than either
// climbing through it or dropping out from under the next word.
const held = new Leveller({ gain: 1 })
for (let i = 0; i < 6 * CHUNKS_PER_S; i += 1) held.push(tone(QUIET, { from: i * SAMPLES }))
const afterSpeech = held.gain
for (let i = 0; i < 5 * CHUNKS_PER_S; i += 1) held.push(tone(50))
check('a pause after speech holds the gain where the speech left it', held.gain === afterSpeech, `${held.gain} vs ${afterSpeech}`)

/* ── the laugh ─────────────────────────────────────────────────────────── */

// The half the constant got wrong in the other direction. The follower is
// standing wide open for a murmur when a loud syllable arrives, and it has one
// chunk to deal with it. Nothing here is allowed to reach the rail.
const open = new Leveller({ gain: 1 })
for (let i = 0; i < 6 * CHUNKS_PER_S; i += 1) open.push(tone(QUIET, { from: i * SAMPLES }))
const wideOpen = open.gain
const burst = open.push(tone(12000))
check('a loud syllable into a wide-open follower does not clip a single sample', clipped(burst) === 0, `${clipped(burst)} samples at the rail`)
check('because the gain is cut on the chunk that provoked it, not over the next few', open.gain < wideOpen / 4, `${open.gain} from ${wideOpen}`)
check('and the same syllable through the old constant four would have clipped', clipped(amplify(tone(12000), 4)) > 0)

// The recording that started this: quiet passages and loud ones in one stream.
const mixed = new Leveller({ gain: 4 })
const heard = []
for (let s = 0; s < 30; s += 1) {
  const peak = s % 10 < 7 ? QUIET : 12000
  for (let i = 0; i < CHUNKS_PER_S; i += 1) heard.push(mixed.push(tone(peak, { from: (s * CHUNKS_PER_S + i) * SAMPLES })))
}
const whole = Buffer.concat(heard)
check('over a stream that keeps changing loudness, nothing reaches the rail', clipped(whole) === 0, `${clipped(whole)} samples`)
check(
  'and the same stream through the constant four does',
  clipped(Buffer.concat(heard.map((_, i) => amplify(tone((Math.floor(i / CHUNKS_PER_S) % 10 < 7 ? QUIET : 12000)), 4)))) > 0,
)

/* ── the bounds ────────────────────────────────────────────────────────── */

const shouting = run(30000, 3)
check('a phone held against a mouth is turned down rather than left to clip', shouting.leveller.gain < 1.2, String(shouting.leveller.gain))
check('but never below the floor', shouting.leveller.gain >= MIN_AUTO_GAIN)
const whisper = run(300, 60)
check('and a very quiet room stops at the ceiling rather than opening for ever', whisper.leveller.gain <= MAX_AUTO_GAIN, String(whisper.leveller.gain))

/* ── the frame the socket handed over ──────────────────────────────────── */

const shared = tone(QUIET)
const before = shared.readInt16LE(40)
new Leveller({ gain: 8 }).push(shared)
check('the follower never writes into the frame it was given, because two consumers read it', shared.readInt16LE(40) === before)
check('an empty chunk comes back empty rather than throwing', new Leveller().push(Buffer.alloc(0)).length === 0)
check(
  'an odd trailing byte is dropped rather than shifting every later sample',
  new Leveller({ gain: 1 }).push(Buffer.alloc(7)).length === 6,
)

/* ── whose knob it is ──────────────────────────────────────────────────── */

check('a config with nothing said about it follows the room', readAuto(undefined) === true && readAuto(null) === true)
check('and a desktop that has pinned its gain is left pinned', readAuto(false) === false)

done()
