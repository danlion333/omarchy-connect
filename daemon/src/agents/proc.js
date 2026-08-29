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
 * Does this process have a controlling terminal?
 *
 * The one question that separates a session somebody is sitting at from a
 * helper the agent forked for its own reasons. Claude Code's supervisor, its
 * pty hosts and its spare workers all carry the binary's name and its
 * `comm`, and every one of them runs with `tty_nr` zero; an agent at a prompt
 * — in a terminal window or in a tmux pane — always has one. It is also what
 * says a background session cannot be typed into: it may own a pty, but no
 * keyboard is attached to it, so the window its parents lead to belongs to
 * somebody else.
 */
export function hasTty(pid) {
  const fields = statFields(pid)
  return fields ? Number(fields[4]) > 0 : false
}

/**
 * When the machine booted, in unix milliseconds.
 *
 * `/proc/<pid>/stat` dates a process in ticks since boot, which is only
 * comparable with a file's mtime once boot itself has a date. It cannot change
 * while the daemon runs, so it is read once.
 */
let bootMs = 0

function bootTime() {
  if (bootMs) return bootMs
  let stat = ''
  try {
    stat = fs.readFileSync('/proc/stat', 'utf8')
  } catch {
    return 0
  }
  const match = /^btime (\d+)$/m.exec(stat)
  bootMs = match ? Number(match[1]) * 1000 : 0
  return bootMs
}

/**
 * The kernel counts a process's age in USER_HZ, which is 100 on every Linux
 * this daemon runs on — the constant is compiled into the ABI rather than
 * being a tunable, and nothing in `/proc` reports it.
 */
const TICKS_PER_SECOND = 100

/**
 * When this process started, in unix milliseconds.
 *
 * This is what lets a transcript be told from a stranger's. Pairing a running
 * agent with "the newest file in its directory" is a guess with no floor under
 * it: on a desktop where sessions come and go, the newest transcript in a
 * directory is very often one that ended an hour ago, and binding a live agent
 * to it puts somebody else's conversation on the phone under a live agent's
 * name. A file the agent cannot have written — because it stopped changing
 * before the agent existed — is not a candidate, and that is one subtraction
 * rather than a heuristic.
 */
export function startedAt(pid) {
  const boot = bootTime()
  const ticks = startTicks(pid)
  return boot && ticks ? boot + Math.round((ticks / TICKS_PER_SECOND) * 1000) : 0
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

/**
 * A few named variables out of a process's environment, and nothing else.
 *
 * `/proc/<pid>/environ` is the environment a process was handed at exec, which
 * is how a multiplexer's own bookkeeping reaches everything it starts: a
 * herdr pane tells its shell which pane it is, and the agent that shell runs
 * inherits that answer whether or not anybody thought to record it. Walking
 * the process tree can find a *terminal*; only this can name the pane.
 *
 * The filter is not tidiness. An agent's environment is one of the more
 * sensitive files on the desktop — it is where API keys live — and this
 * daemon has no business holding any of it. Asking for names rather than
 * reading the file into a map means what is not asked for is never kept.
 */
export function envOf(pid, names) {
  const raw = procFile(pid, 'environ')
  if (!raw) return null
  const wanted = new Set(names)
  const found = {}
  for (const entry of raw.split('\0')) {
    const eq = entry.indexOf('=')
    if (eq < 1) continue
    const key = entry.slice(0, eq)
    if (wanted.has(key)) found[key] = entry.slice(eq + 1)
  }
  return found
}
