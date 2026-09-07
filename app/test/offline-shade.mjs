/**
 * The shade that goes over the workspaces when the desktop is gone.
 *
 * Two things are held here, and they are different in kind. The first is the
 * rule itself, `lib/offline.offlineShade`, which is arithmetic over a status
 * and a duration and can simply be run. The second is the shell that draws it:
 * `App.tsx` needs a native runtime this repository's tests do not have, so
 * what a suite can do — the same thing `bar-shape` does — is hold the source
 * to the claims the acceptance criteria make about it. Those claims are about
 * the source anyway: the shade must be over the pager and not instead of it,
 * the bar must be outside it, and Share must be the only door.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { check, done } from '../../tools/test-harness.mjs'
import { SHADE_AFTER_MS, offlineShade } from '../src/lib/offline.ts'
import { backoffStep } from '../src/lib/retry.ts'

const root = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))))
const app = fs.readFileSync(path.join(root, 'app/App.tsx'), 'utf8')

/* ── when the shade is entitled to appear ───────────────────────────────── */

check('a working link draws nothing', offlineShade({ status: 'connected' }) === null)
check('pairing is not shaded — PairScreen already owns the screen', offlineShade({ status: 'pairing' }) === null)

// The criterion: a blip that heals itself must not throw a shade in the way.
check('a fresh drop is not shaded', offlineShade({ status: 'reconnecting', downForMs: 0 }) === null)
check('nor is one three seconds in', offlineShade({ status: 'reconnecting', downForMs: 3_000 }) === null)
check('nor a first dial that is still going', offlineShade({ status: 'connecting', downForMs: 2_000 }) === null)
check('but an outage past the threshold is', offlineShade({ status: 'reconnecting', downForMs: SHADE_AFTER_MS + 1 }) !== null)

// The threshold is a choice, but not an arbitrary one: it has to outlast the
// rungs of the ladder that fix a blip on their own.
const blip = backoffStep(0) + backoffStep(1) + backoffStep(2)
check('the threshold outlasts the ladder’s first three rungs', SHADE_AFTER_MS > blip, `${SHADE_AFTER_MS} > ${blip}`)
check('and does not outlast the fourth', SHADE_AFTER_MS <= blip + backoffStep(3))

// Not trying, or failed for good: nothing is going to age into a success, so
// there is nothing to wait out.
check('parked says so at once', offlineShade({ status: 'parked', downForMs: 0 }) !== null)
check('an error says so at once', offlineShade({ status: 'error', downForMs: 0 }) !== null)
check('idle says so at once', offlineShade({ status: 'idle', downForMs: 0 }) !== null)

/* ── what it says ───────────────────────────────────────────────────────── */

const every = [
  offlineShade({ status: 'parked' }),
  offlineShade({ status: 'error' }),
  offlineShade({ status: 'idle' }),
  offlineShade({ status: 'reconnecting', downForMs: SHADE_AFTER_MS }),
  offlineShade({ status: 'connecting', downForMs: SHADE_AFTER_MS }),
]
check('every shade names the state it was drawn for', every.every((shade) => shade && shade.status))
check('every shade has a title', every.every((shade) => shade.title === 'Not connected'))
// The criterion, in one line: no state where the shade says only "Not
// connected" and stops.
check('no shade is left without a second line', every.every((shade) => shade.reason.trim().length > 0))
// `connecting` and `reconnecting` are one situation with two names — the
// ladder is still trying — so they share a sentence and the other three do not.
const distinct = new Set(every.map((shade) => shade.reason))
check('and the states that differ do not share one', distinct.size === every.length - 1, [...distinct].join(' | '))

const parked = offlineShade({ status: 'parked', parkedNote: 'waiting for your home network or vpn' })
check('parked speaks with parkedNote', parked.reason === 'waiting for your home network or vpn')
check('and falls back to a sentence when the client has none', offlineShade({ status: 'parked' }).reason.includes('home network'))

// `lib/errors` is what turns a native throw into a line; the shade must not
// build its own message out of one.
const thrown = offlineShade({ status: 'error', error: 'java.lang.SecurityException: Permission Denial: no access' })
check('an error is rendered through lib/errors', thrown.reason === 'Permission Denial: no access', thrown.reason)
check('a failing ladder shows the error it failed with', offlineShade({ status: 'reconnecting', downForMs: 20_000, error: 'connection refused' }).reason === 'connection refused')
check('and plain prose when there was none', offlineShade({ status: 'reconnecting', downForMs: 20_000 }).reason.includes('not answering'))
check('an empty error string is not a reason', offlineShade({ status: 'error', error: '' }).reason.length > 0)
check('every shade offers the retry', every.every((shade) => shade.canRetry === true))

/* ── where the shell puts it ────────────────────────────────────────────── */

check('the shell asks lib/offline rather than reading the status itself', app.includes('offlineShade('))
check('the shade is rendered', app.includes('<OfflineShade'))
// Over the pager: `page()` mounts a workspace on its first visit and never
// unmounts it, so a shade that replaced `Workspaces` would take the clipboard
// history with it.
const shell = app.slice(app.indexOf('function Shell()'), app.indexOf('function useLinkDowntime'))
check('the pager is still rendered while the shade stands', shell.indexOf('<Workspaces') < shell.indexOf('<OfflineShade'))
check('the pager holds still under it', shell.includes('locked={Boolean(shade)}'))
check('the bar is outside the box the shade fills', shell.indexOf('<OfflineShade') < shell.indexOf('<OmarchyBar'))
check('the bar is still drawn while the shade stands', /\{shade && !peeking \? <OfflineShade/.test(shell) && shell.includes('<OmarchyBar'))

// Exactly one door, and it leads to Share.
const shade = app.slice(app.indexOf('function OfflineShade'))
const body = shade.slice(0, shade.indexOf('\n}\n'))
const labels = [...body.matchAll(/label="([^"]+)"/g)].map((m) => m[1])
check('the shade offers Reconnect and Share, and nothing else', labels.join(',') === 'Reconnect,Share', labels.join(','))
check('Reconnect calls the link’s own reconnect', shell.includes('onReconnect={reconnect}'))
check('the Share door does not lose the workspace that was open', shell.includes('onShare={() => setPeeking(true)}') && !body.includes('setTab'))
check('the other four workspaces cannot be opened under the shade', shell.includes('if (shade) return setPeeking(next === \'share\')'))
check('and the shade comes back by itself when the link does', shell.includes('if (!shade) setPeeking(false)'))

done()
