/**
 * What an event costs the screen.
 *
 * The app's whole UI hangs off one link state, and two of the things that
 * write to it write constantly: the desktop's stats sampler once a second, and
 * the draft of the sentence an agent is typing about twice that. Every one of
 * those used to make a new state object, which made a new context value, which
 * re-rendered every consumer in the tree — including the `usePalette()` inside
 * every `Label`, `Body`, `Card` and `Button` in the app, none of which have
 * ever had an opinion about the CPU.
 *
 * A React render is not something a suite in this repository can watch, and
 * mounting the tree to count renders would be testing React rather than this
 * app. What decides the renders, though, is entirely arithmetic on plain
 * objects: the provider hands each context the slice it serves, and React
 * re-renders that context's consumers exactly when the slice it was handed is
 * not the one from last time. So the identities are the test. A stats frame
 * that leaves the status slice shallow-equal is a stats frame that re-renders
 * nothing which reads only the palette or the status, and that is the claim.
 */
import { agentsSlice, merged, shallowEqual, statusSlice } from '../src/lib/state.ts'
import { reduceAgents } from '../src/lib/agents.ts'
import { check, done } from '../../tools/test-harness.mjs'

const PALETTE = { bg: '#000', fg: '#fff', accent: '#0af', red: '#f00', orange: '#fa0' }

/** A phone that is connected, themed, and watching one agent work. */
const session = (id, state = 'idle') => ({ id, title: id, state, preview: '', prompt: null, lastActivity: 1 })

const base = {
  ready: true,
  status: 'connected',
  error: null,
  desktop: { host: '10.0.0.2', port: 8765, token: 't', publicKey: 'k' },
  hello: { version: '1', capabilities: {} },
  palette: PALETTE,
  stats: { at: 1, uptime: 10, cpu: { usage: 3 } },
  agents: [session('a'), session('b', 'waiting')],
  agentLimits: null,
  agentJobs: [],
  clipboard: null,
  files: [],
  latencyMs: 12,
  relocating: false,
  waking: false,
  client: null,
}

/* ── a state that did not move is not news ──────────────────────────────── */

check('changing nothing hands back the same state', merged(base, { status: 'connected' }) === base)
check('an empty patch does too', merged(base, {}) === base)
check(
  'and so does one whose every field is already what it says',
  merged(base, { status: 'connected', agents: base.agents, palette: base.palette }) === base,
)
check('a real change makes a new state', merged(base, { status: 'reconnecting' }) !== base)
check('which carries the change', merged(base, { latencyMs: 40 }).latencyMs === 40)
check('and leaves everything else alone by identity', merged(base, { latencyMs: 40 }).agents === base.agents)
check('null is a value like any other', merged(base, { stats: null }) !== base)
check('setting null twice is not a change', merged(merged(base, { stats: null }), { stats: null }).stats === null)
check(
  'the second one is the same state object',
  (() => {
    const once = merged(base, { stats: null })
    return merged(once, { stats: null }) === once
  })(),
)

/* ── a stats frame, once a second, forever ──────────────────────────────── */

const ticked = merged(base, { stats: { at: 2, uptime: 11, cpu: { usage: 7 } } })

check('the sampler does move the state', ticked !== base)
check('and the stats context sees a new snapshot', ticked.stats !== base.stats)
check(
  'but the status slice is the same in every field',
  shallowEqual(statusSlice(base), statusSlice(ticked)),
)
check('so the palette is untouched', ticked.palette === base.palette)
check('and the agent slice is unmoved too', shallowEqual(agentsSlice(base), agentsSlice(ticked)))

// The other direction, so that the check above is a claim about stats rather
// than about a slice that never changes for anything.
const dialled = merged(base, { status: 'reconnecting' })
check('a socket that drops does reach the status slice', !shallowEqual(statusSlice(base), statusSlice(dialled)))
check('and a new theme reaches the palette', merged(base, { palette: { ...PALETTE, accent: '#f0f' } }).palette !== PALETTE)

/* ── the sentence an agent is halfway through ───────────────────────────── */

const draft = { kind: 'draft', id: 'a', append: ' and then' }
const blocks = { kind: 'blocks', id: 'a', blocks: [{ role: 'agent', text: 'hi' }], cursor: 3 }

check('a draft frame returns the very list it was given', reduceAgents(base.agents, draft) === base.agents)
check('so does a block frame', reduceAgents(base.agents, blocks) === base.agents)
check('and patching with it changes no state at all', merged(base, { agents: reduceAgents(base.agents, draft) }) === base)

/* ── the frames that are about the list ─────────────────────────────────── */

const started = reduceAgents(base.agents, { kind: 'session', id: 'c', removed: false, session: session('c') })
check('a new session is added', started.length === 3 && started.some((s) => s.id === 'c'))
check('and that is a new array', started !== base.agents)
check(
  'a session that arrives already gone is not added',
  reduceAgents(base.agents, { kind: 'session', id: 'c', removed: false, session: session('c', 'gone') }).length === 2,
)
check(
  'a removal takes it out',
  reduceAgents(base.agents, { kind: 'session', id: 'a', removed: true, session: null }).length === 1,
)
const waiting = reduceAgents(base.agents, {
  kind: 'state',
  id: 'a',
  state: 'waiting',
  prompt: 'may I?',
  preview: '',
  lastActivity: 2,
})
check('a state change rewrites just that session', waiting.find((s) => s.id === 'a').state === 'waiting')
check('and leaves the others by identity', waiting.find((s) => s.id === 'b') === base.agents[1])
check('gone means gone', reduceAgents(base.agents, { kind: 'state', id: 'b', state: 'gone' }).length === 1)
check('an event about a session nobody knows changes nothing', reduceAgents(base.agents, {
  kind: 'state',
  id: 'zz',
  state: 'busy',
  prompt: null,
  preview: '',
  lastActivity: 3,
}).every((s, i) => s === base.agents[i]))

/* ── the badge on the tab bar ───────────────────────────────────────────── */

check('the waiting count is what the badge reads', agentsSlice(base).agentsWaiting === 1)
check('and it moves when one starts waiting', agentsSlice(merged(base, { agents: waiting })).agentsWaiting === 2)
check(
  'a state that only changed its stats leaves the count identical',
  agentsSlice(ticked).agentsWaiting === agentsSlice(base).agentsWaiting,
)

done('re-render cost of a link event')
