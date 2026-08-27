/**
 * Which conversation belongs to which running agent.
 *
 * A hook answers this outright — it is handed the transcript path by the agent
 * itself — and everything here exists for the sessions no hook ever reached:
 * the ones started before the hooks were installed, and the ones whose hook
 * could not get through. All `/proc` gives is a process, a working directory
 * and an age, and all the disk gives is a pile of transcripts for that
 * directory. The pairing between them is a guess, and it is labelled as one
 * (`via: "scan"`) — but a guess with a floor under it is worth much more than
 * one without.
 *
 * The floor is time. "The newest transcript in the directory" is the shape the
 * scan used to have and it is wrong far more often than it looks: on a desktop
 * where sessions come and go all day, the newest file in a project directory
 * is usually one that ended, and pinning a live agent to it puts a stranger's
 * conversation on the phone under a live agent's name — with a live agent's
 * pid beside it, which is what makes it dangerous rather than merely untidy.
 *
 * A transcript that stopped changing before its supposed author started is not
 * that author's, and that single subtraction removes the whole class.
 */

/**
 * A transcript's mtime may legitimately sit a moment before the process it
 * belongs to: the agent writes its first line while it is still starting, and
 * a filesystem timestamp and a `/proc` tick count are not the same clock.
 */
const SLACK_MS = 2000

/**
 * Pair processes to transcripts, newest to newest, and refuse the pairs that
 * cannot be true.
 *
 * Processes with a terminal go first, whatever their age. A helper that shares
 * a directory with a real session — a supervisor started from the same shell,
 * say — must never take that session's transcript and leave the session
 * holding nothing, and being at a keyboard is the difference between the two.
 *
 * Returns one entry per process that could be matched; a process with nothing
 * plausible to point at is simply absent, which is the honest answer. An agent
 * that has not written its first line yet — sitting at the trust prompt, most
 * often — is invisible for those few seconds rather than bound to whatever was
 * lying around, and it appears of its own accord once it writes.
 */
export function pair(processes, transcripts, { background = () => null } = {}) {
  const order = [...processes].sort((a, b) => {
    const tty = Number(Boolean(b.tty)) - Number(Boolean(a.tty))
    return tty || b.ticks - a.ticks
  })
  const free = [...transcripts].sort((a, b) => b.mtime - a.mtime)
  const pairs = []

  for (const proc of order) {
    const floor = proc.startedAt ? proc.startedAt - SLACK_MS : 0
    const index = free.findIndex((t) => t.mtime >= floor && agrees(proc, background(t)))
    if (index < 0) continue
    pairs.push({ proc, transcript: free[index] })
    free.splice(index, 1)
  }

  return pairs
}

/**
 * Does this conversation belong to this kind of process?
 *
 * A working directory is not a unique key: a background job and the session
 * that launched it share one, and for the beat between an agent changing
 * directory and its transcript following it, the two cannot be told apart by
 * directory alone. That beat was enough to put a background agent's
 * conversation on the phone under the interactive session's pid, with the
 * interactive session's terminal offered as the way to answer it.
 *
 * A process with a controlling terminal is a session somebody is sitting at,
 * and one without is not. The transcript says which it was. Asking the two to
 * agree costs one read and settles it.
 *
 * An unknown answer constrains nothing — a transcript with no turn in it yet
 * is still a candidate, because refusing it would lose the session rather than
 * place it better.
 */
const agrees = (proc, background) => background === null || background !== Boolean(proc.tty)
