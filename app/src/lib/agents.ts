/**
 * The session list, folded forward one event at a time.
 *
 * Pure and on its own, away from the socket that feeds it, for two reasons.
 * The first is that it can then be read straight through: everything the phone
 * believes about which agents exist and what they are doing is decided by the
 * thirty lines below. The second is the identity contract, which nothing but a
 * test would ever notice and everything renders on top of — see the return of
 * `previous`.
 */
import type { AgentEvent, AgentSession } from '../api/client'

/**
 * The list after the event, or **the very same array** when the event was not
 * about the list at all.
 *
 * Most agent frames are not. `blocks` is the transcript and `draft` is the
 * sentence the agent is halfway through typing — up to two and a half a second
 * — and neither adds, removes or changes a session. Returning `previous` by
 * identity is what lets the caller tell that apart from a real change and stay
 * quiet, rather than pushing a new array through the state and re-rendering
 * the tree for a list that is character for character the one already on it.
 */
export function reduceAgents(previous: AgentSession[], data: AgentEvent): AgentSession[] {
  if (data.kind === 'session') {
    const rest = previous.filter((s) => s.id !== data.id)
    // A finished session is announced by its state change; a session frame
    // carrying `gone` must not put it back in the list.
    if (data.removed || !data.session || data.session.state === 'gone') return rest
    return [...rest, data.session]
  }
  if (data.kind === 'state') {
    if (data.state === 'gone') return previous.filter((s) => s.id !== data.id)
    return previous.map((s) =>
      s.id === data.id
        ? { ...s, state: data.state, prompt: data.prompt, preview: data.preview, lastActivity: data.lastActivity }
        : s,
    )
  }
  return previous
}
