/**
 * The gate in front of the pairing camera.
 *
 * The bug this suite stands guard over was a loop: a failed pairing attempt put
 * the scanner back on screen with its "already handled this code" latch reset,
 * the same QR was still in the field of view, and the app fired the attempt
 * again — around and around until the desktop's five attempts were gone and the
 * pairing session was dead, without the user touching anything.
 *
 * The screen itself is React and a camera, neither of which a suite here can
 * mount. What decides the loop, though, is a two-line state machine over plain
 * strings, so that is what is asked the questions: does a failure stop the
 * scanner, does a code seen after a failure do nothing at all, and is the only
 * way back to armed the button the user presses.
 */
import { acceptsFrame, nextPhase } from '../src/lib/pair-scan.ts'
import { check, done } from '../../tools/test-harness.mjs'

const PHASES = ['armed', 'pairing', 'stopped']
const EVENTS = ['valid-code', 'invalid-code', 'attempt-failed', 'scan-again']

// The happy path, one frame at a time.
check('an armed scanner acts on a frame', acceptsFrame('armed'))
check('a valid code starts an attempt', nextPhase('armed', 'valid-code') === 'pairing')
check('a scanner that is pairing ignores frames', !acceptsFrame('pairing'))
check(
  'the same code seen again while pairing changes nothing',
  nextPhase('pairing', 'valid-code') === 'pairing',
)

// The bug, stated as a test: after a failure the code is still in front of the
// lens, and it must not be able to start anything.
const afterFailure = nextPhase('pairing', 'attempt-failed')
check('a failed attempt stops the scanner', afterFailure === 'stopped')
check('a stopped scanner ignores frames', !acceptsFrame(afterFailure))
check(
  'the same QR still in frame starts nothing after a failure',
  nextPhase(afterFailure, 'valid-code') === 'stopped',
)
check(
  'a hundred frames of it still start nothing',
  Array.from({ length: 100 }).reduce((p) => nextPhase(p, 'valid-code'), afterFailure) === 'stopped',
)

// The only way out is the gesture.
check('"scan again" arms the scanner', nextPhase(afterFailure, 'scan-again') === 'armed')
check(
  'and the next code is then accepted, on one frame',
  nextPhase(nextPhase(afterFailure, 'scan-again'), 'valid-code') === 'pairing',
)
check(
  '"scan again" is accepted from any phase',
  PHASES.every((p) => nextPhase(p, 'scan-again') === 'armed'),
)

// Pointing the camera at something that is not one of our codes is a mistake,
// not a failure: the scanner stays live so the right code can follow.
check('an unknown code leaves an armed scanner armed', nextPhase('armed', 'invalid-code') === 'armed')
check('an unknown code does not revive a stopped scanner', nextPhase('stopped', 'invalid-code') === 'stopped')

// A failure is reported once per attempt, but saying it twice must not matter.
check(
  'a failure is idempotent',
  PHASES.every((p) => nextPhase(nextPhase(p, 'attempt-failed'), 'attempt-failed') === 'stopped'),
)

// Totality: the camera delivers frames in every phase, so every pair has an
// answer, and never one outside the three.
check(
  'every phase answers every event with a phase',
  PHASES.every((p) => EVENTS.every((e) => PHASES.includes(nextPhase(p, e)))),
)

done('pairing scanner gate checks')
