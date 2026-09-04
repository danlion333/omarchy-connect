/**
 * Whether the camera on the pairing screen is allowed to act on the next frame.
 *
 * The QR pane used to decide that for itself, with a `useRef(false)` latch set
 * on the first code it recognised. That would have been enough if the pane
 * stayed on screen, but it does not: while a pairing attempt runs, the screen
 * swaps the scanner for a "Pairing…" card, so React unmounts the pane and the
 * ref dies with it. Every failed attempt therefore handed the camera back with
 * a fresh `false` while the very same QR was still in front of the lens, and
 * `onBarcodeScanned` fired it again immediately. No gesture, no pause: pairing
 * retried itself in a loop until the desktop's five attempts were spent and the
 * session was dead, with the error flashing past too quickly to read.
 *
 * So the decision lives here instead — a phase and a transition over it, plain
 * data with no React in sight, which the screen keeps above the pane in state
 * that outlives any remount. A failure moves the phase to `stopped`, and only
 * an explicit "Scan again" arms it back. That is the whole fix; the rest is
 * where it is held.
 */

/**
 * `armed` — the scanner is live and the next valid code starts an attempt.
 * `pairing` — an attempt is in flight; further frames are ignored so that one
 * QR in the field of view cannot queue up several attempts.
 * `stopped` — the last attempt failed and the user has not asked for another.
 */
export type ScanPhase = 'armed' | 'pairing' | 'stopped'

/**
 * What can move the phase: a frame that parsed as a pairing URL, a frame that
 * did not, the end of an attempt, and the button the user presses to start
 * over. `attempt-failed` is the only outcome that is reported, because a
 * successful pairing takes the whole screen away.
 */
export type ScanEvent = 'valid-code' | 'invalid-code' | 'attempt-failed' | 'scan-again'

/** Only an armed scanner acts on what it sees. */
export function acceptsFrame(phase: ScanPhase): boolean {
  return phase === 'armed'
}

/**
 * The transition. Written total on purpose: the camera keeps delivering frames
 * in every phase, and a phase that has no answer for one of them would be the
 * same class of bug as the latch this replaces.
 */
export function nextPhase(phase: ScanPhase, event: ScanEvent): ScanPhase {
  // Asking again is always allowed, from wherever the screen happens to be.
  if (event === 'scan-again') return 'armed'
  // A failure stops the scanner whatever it was doing, so that the code still
  // in frame cannot start the next attempt by itself.
  if (event === 'attempt-failed') return 'stopped'
  // Codes only matter to a scanner that is armed. A frame seen while pairing,
  // or after a failure, changes nothing at all.
  if (!acceptsFrame(phase)) return phase
  // Something that is not one of our codes leaves the scanner armed: the user
  // has pointed it at the wrong thing, not failed at pairing.
  return event === 'valid-code' ? 'pairing' : 'armed'
}
