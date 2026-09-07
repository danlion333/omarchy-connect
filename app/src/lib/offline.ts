/**
 * Whether the app is entitled to keep drawing the desktop, and what to say
 * when it is not.
 *
 * Nothing in this app invalidates `hello`, `stats`, `palette` or the agent
 * list when the socket dies, so every workspace goes on painting the last
 * snapshot it was given as if it were the present. On a phone that has been in
 * a pocket since yesterday that is not a stale number, it is a lie with a
 * live-looking clock next to it, and the cost is trust in every other figure
 * on the screen. So once the link has plainly stopped working, the workspaces
 * are covered rather than corrected.
 *
 * The decision is here, as arithmetic over a status and a duration, because
 * the shell that renders it cannot be mounted by a test in this repository and
 * a rule nobody can exercise is a rule that quietly rots. `App.tsx` holds the
 * clock; this holds the judgement.
 */
import { errorLine } from './errors.ts'
import { parkedReason } from './retry.ts'
import type { ConnectionStatus } from '../api/client'

/**
 * How long a link may be down before the app stops pretending.
 *
 * Read off the backoff ladder in `lib/retry.ts`: the first three rungs are a
 * second, two and four, so a blip that the ladder itself fixes is over inside
 * seven seconds and the fourth attempt is the first one that admits the cause
 * is not a blip. Eight seconds is that moment, plus the jitter the ladder adds
 * to each rung. Shorter and a lift ride between two access points throws a
 * full-screen shade in the user's face; much longer and the numbers on Home
 * have been wrong for a while before anything says so.
 *
 * The number is a choice, not a fact — the repository never wrote one down.
 */
export const SHADE_AFTER_MS = 8_000

/** What the shade says. `reason` is never empty: "offline" alone explains nothing. */
export type Shade = {
  /** The state, kept so the shell can key an animation or a test can name it. */
  status: ConnectionStatus
  title: string
  /** The second line — why this phone is not talking to that desktop. */
  reason: string
  /** Whether asking again could plausibly help right now. */
  canRetry: boolean
}

/** The states the ladder is still working on, where waiting is the right answer. */
const SETTLING: ConnectionStatus[] = ['connecting', 'reconnecting']

/**
 * The shade to draw over the workspaces, or `null` to leave them alone.
 *
 * `downForMs` is how long the link has been out of `connected`, which only
 * matters while something is still trying: a `parked` link is not trying at
 * all and an `error` is not going to age into a success, so those say so at
 * once. `pairing` draws nothing because `PairScreen` already owns the whole
 * screen when it is reachable.
 */
export function offlineShade(input: {
  status: ConnectionStatus
  /** The link's own last error, as `lib/errors` would render it. */
  error?: unknown
  /** `ConnectClient.parkedNote` — the sentence the notification uses. */
  parkedNote?: string | null
  /** Milliseconds since the link was last `connected`. */
  downForMs?: number
}): Shade | null {
  const { status, error = null, parkedNote = null, downForMs = 0 } = input
  if (status === 'connected' || status === 'pairing') return null

  const line = error == null || error === '' ? null : errorLine(error)

  if (SETTLING.includes(status)) {
    if (downForMs < SHADE_AFTER_MS) return null
    return {
      status,
      title: 'Not connected',
      // The error, when the dial actually failed with one; otherwise the plain
      // truth, which is that the desktop is not answering and the phone has
      // not given up. Either way a second line, never the bare word.
      reason: line || 'the desktop is not answering — still trying',
      canRetry: true,
    }
  }

  if (status === 'parked') {
    return {
      status,
      title: 'Not connected',
      reason: parkedNote || parkedReason(null),
      canRetry: true,
    }
  }

  if (status === 'error') {
    return { status, title: 'Not connected', reason: line || 'the last attempt to reach the desktop failed', canRetry: true }
  }

  // `idle`: nothing is dialling. Reached after the link is closed on purpose —
  // there is no ladder running that could fix this, so the button is the fix.
  return { status, title: 'Not connected', reason: line || 'the link is not running — tap Reconnect to dial the desktop', canRetry: true }
}
