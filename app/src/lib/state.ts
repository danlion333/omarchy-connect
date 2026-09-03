/**
 * What changed, and who has to hear about it.
 *
 * The link keeps one flat object for everything a screen can render, and for
 * a long time every event rewrote the whole of it: a new `LinkState` a second
 * for the stats sampler, another two and a half a second while an agent types.
 * That is cheap in itself — spreading a dozen fields costs nothing — and
 * ruinous one layer up, because a new object is a new context value, and a new
 * context value re-renders every consumer in the tree whether or not the field
 * it reads has moved. `usePalette()` sits in every `Label`, `Body`, `Card` and
 * `Button` in the app, and none of them have ever cared what the CPU is doing.
 *
 * So the state is cut two ways here, both of them pure so that a test can say
 * what a render would have done without mounting anything:
 *
 * - `merged` refuses to make a new state out of changes that change nothing,
 *   which is what a `draft` frame carrying the same session list amounts to;
 * - the slice selectors take the fields one context's consumers read, so that
 *   `shallowEqual` can answer "would this event have been news to them?" — no
 *   for stats and agents against the status slice, which is the whole point.
 */
import type { AgentJob, AgentLimits, AgentSession, ConnectClient, ConnectionStatus, Hello } from '../api/client'
import type { ClipboardEvent, FileEvent, LinkState } from '../api/link'
import type { SavedDesktop } from '../api/storage'

/** Same keys, same values by identity. Values are never compared deeply. */
export function shallowEqual(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  if (a === b) return true
  const keys = Object.keys(a)
  if (keys.length !== Object.keys(b).length) return false
  return keys.every((key) => Object.is(a[key], b[key]))
}

/**
 * The state with the changes applied, or the very same state when every one
 * of them was already what it says.
 *
 * Returning the old object is the signal, not an optimisation detail: the
 * caller takes it to mean "nobody needs telling", and skips the subscribers
 * altogether rather than handing React an object it would have to diff its way
 * out of re-rendering.
 */
export function merged<T extends object>(state: T, changes: Partial<T>): T {
  const keys = Object.keys(changes) as (keyof T)[]
  if (keys.every((key) => Object.is(state[key], changes[key]))) return state
  return { ...state, ...changes }
}

/** What a screen reads about the link itself: the socket, not its traffic. */
export type StatusSlice = {
  ready: boolean
  status: ConnectionStatus
  error: string | null
  desktop: SavedDesktop | null
  hello: Hello | null
  clipboard: ClipboardEvent[]
  files: FileEvent[]
  latencyMs: number | null
  relocating: boolean
  waking: boolean
  client: ConnectClient | null
}

export function statusSlice(state: LinkState): StatusSlice {
  return {
    ready: state.ready,
    status: state.status,
    error: state.error,
    desktop: state.desktop,
    hello: state.hello,
    clipboard: state.clipboard,
    files: state.files,
    latencyMs: state.latencyMs,
    relocating: state.relocating,
    waking: state.waking,
    client: state.client,
  }
}

/** The agent list and the two numbers that hang off it. */
export type AgentsSlice = {
  agents: AgentSession[]
  /** Agents blocked on a question — the one thing a phone can actually fix. */
  agentsWaiting: number
  agentLimits: AgentLimits | null
  agentJobs: AgentJob[]
}

export function agentsSlice(state: LinkState): AgentsSlice {
  return {
    agents: state.agents,
    agentsWaiting: state.agents.filter((a) => a.state === 'waiting').length,
    agentLimits: state.agentLimits,
    agentJobs: state.agentJobs,
  }
}
