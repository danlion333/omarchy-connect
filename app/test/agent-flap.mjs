/**
 * A notification you cannot read is worse than none.
 *
 * The complaint: a card saying an agent is waiting arrives on the phone and is
 * gone about two seconds later, buzzing on its way in. The desktop half of the
 * cause is fixed where it belongs (`daemon/test/agents.mjs` — a subagent's
 * tool calls, and the turn that asks being older than the question it asks).
 * This is the phone's half: what `syncAgentAlerts` does when the list stops
 * saying `waiting` for a moment and then says it again.
 *
 * The rule under test is a hold, not a delay. A question that really is
 * standing there still buzzes on the very call the list arrives on — that
 * latency is the entire point of the feature and nothing here is allowed to
 * spend it. What changes is the other end: a card already on screen is taken
 * down when the question has been gone for `SETTLE_MS`, not the instant one
 * list frame disagrees with it.
 *
 * `api/alerts` is plain decisions over plain data, so this needs no phone and
 * no daemon: the two imports that only exist on a device are swapped for the
 * stubs in `test/stubs`, and the clock is a variable.
 */
import module from 'node:module'

import { check, done } from '../../tools/test-harness.mjs'

module.register('./stubs/loader.mjs', import.meta.url)

/** The clock `api/alerts` reads. Every step below is a moment on it. */
let clock = 1_700_000_000_000
Date.now = () => clock
const at = (ms) => {
  clock = 1_700_000_000_000 + ms
}

const { syncAgentAlerts, resetAlerts } = await import('../src/api/alerts.ts')

/** What the native shade was asked to do, newest last. */
const shade = () => globalThis.__shade
const since = (mark) => shade().slice(mark)
const mark = () => shade().length

const session = (state, extra = {}) => [{
  id: 'claude:s1',
  agent: 'claude',
  title: 'omarchy-connect',
  state,
  prompt: state === 'waiting' ? 'Bash needs your permission: rm -rf build' : null,
  preview: 'clearing the build directory',
  writable: 'tmux:0',
  lastActivity: clock,
  ...extra,
}]

/* ── the question that really is standing there ─────────────────────────── */

at(0)
syncAgentAlerts(session('working'))
check('an agent at work says nothing', shade().length === 0, JSON.stringify(shade()))

at(300)
let step = mark()
syncAgentAlerts(session('waiting'))
const raised = since(step)
check(
  'a waiting agent is announced on the very call that brings the news',
  raised.length === 1 && raised[0].call === 'notifyAgentWaiting',
  JSON.stringify(raised),
)
check('and it buzzes, because it is the first anyone has heard of it', raised[0]?.args[0]?.alert === true)
check('and it carries the question', String(raised[0]?.args[0]?.prompt || '').includes('rm -rf build'))

/* ── the flap ───────────────────────────────────────────────────────────── */

// Two seconds later the desktop says `working` — the number in the complaint,
// and the daemon's own tail poll. Nothing was answered.
at(2_300)
step = mark()
syncAgentAlerts(session('working'))
check('a moment of "working" does not take the card down', since(step).length === 0, JSON.stringify(since(step)))

// And the question is back on the next frame, as it always was.
at(2_600)
step = mark()
syncAgentAlerts(session('waiting'))
check('the same question coming back raises nothing new', since(step).length === 0, JSON.stringify(since(step)))
check('so the phone buzzed exactly once for it', shade().filter((c) => c.call === 'notifyAgentWaiting').length === 1)

/* ── the question that really is gone ───────────────────────────────────── */

at(10_000)
step = mark()
syncAgentAlerts(session('working'))
check('the hold starts again from the moment it stopped waiting', since(step).length === 0)

at(14_000)
step = mark()
syncAgentAlerts(session('working'))
check('and holds for as long as a flap could last', since(step).length === 0, JSON.stringify(since(step)))

at(15_100)
step = mark()
syncAgentAlerts(session('working'))
const cleared = since(step)
check(
  'a question gone for longer than that takes its card with it',
  cleared.length === 1 && cleared[0].call === 'clearAlert' && cleared[0].args[0] === 'agent',
  JSON.stringify(cleared),
)

// Cleared means forgotten: the next question under the same session is news
// again, and buzzes again.
at(20_000)
step = mark()
syncAgentAlerts(session('waiting'))
check('the next question is news again', since(step)[0]?.args[0]?.alert === true, JSON.stringify(since(step)))

/* ── the session that ended ─────────────────────────────────────────────── */

// Nothing to hold a card for: a session that is off the list cannot be
// answered from the phone, whatever it was asking a moment ago.
at(20_500)
step = mark()
syncAgentAlerts([])
const gone = since(step)
check(
  'a session that ends takes its card at once',
  gone.some((c) => c.call === 'clearAlert' && c.args[0] === 'agent'),
  JSON.stringify(gone),
)

resetAlerts()
done()
