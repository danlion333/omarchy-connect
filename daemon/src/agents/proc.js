import fs from 'node:fs'

/**
 * The little that `/proc` has to say about a process.
 *
 * Two halves of the feature need the same three answers — is it alive, what is
 * it called, who is its parent — and they need them about different processes:
 * discovery walks *down* from a hook to the agent that ran it, and writing
 * walks *up* from the agent to the terminal that owns it. Neither is worth a
 * dependency and both are one file read, so they live here rather than being
 * written twice.
 */

export function procFile(pid, name) {
  try {
    return fs.readFileSync(`/proc/${pid}/${name}`, 'utf8')
  } catch {
    return null
  }
}

export const alive = (pid) => Boolean(pid) && fs.existsSync(`/proc/${pid}`)

export const commOf = (pid) => procFile(pid, 'comm')?.trim() || null

/**
 * Everything after the last ')' in `/proc/<pid>/stat` is fixed-width. The
 * comm field before it may contain spaces and parentheses of its own, which
 * is why this is not a plain split — a process called `(ノ° °)ノ` is legal.
 */
const statFields = (pid) => {
  const stat = procFile(pid, 'stat')
  return stat ? stat.slice(stat.lastIndexOf(')') + 2).split(' ') : null
}

export function parentOf(pid) {
  const fields = statFields(pid)
  return fields ? Number(fields[1]) || 0 : 0
}

/** Boot-relative start time, so two agents in one directory can be ordered. */
export function startTicks(pid) {
  const fields = statFields(pid)
  return fields ? Number(fields[19]) || 0 : 0
}

/**
 * A process and its forebears, nearest first.
 *
 * This is how a session is matched to the thing that can be typed into: the
 * agent is a grandchild of a tmux pane's shell, or of the terminal emulator
 * Hyprland knows as a window, and neither of those relationships is recorded
 * anywhere except in the chain of parents between them. The walk is bounded
 * because a cycle would be a kernel bug, but a bounded loop costs nothing and
 * an unbounded one hangs the daemon.
 */
export function ancestors(pid, depth = 12) {
  const chain = []
  let current = Number(pid) || 0
  for (let i = 0; i < depth && current > 1; i += 1) {
    chain.push(current)
    current = parentOf(current)
  }
  return chain
}
