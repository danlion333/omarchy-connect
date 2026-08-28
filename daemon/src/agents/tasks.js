import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * The list an agent is working through, read from where it keeps it.
 *
 * An agent at work produces a great deal of traffic and very little news. The
 * transcript says it ran `grep`, then read a file, then ran `grep` again —
 * true, and no use at all to somebody holding a phone who wants to know
 * whether the thing they asked for is nearly done. The task list is the
 * answer: a handful of sentences the agent wrote about the work rather than
 * about the tools, and a count of how many of them are behind it.
 *
 * Claude Code keeps one directory per session under `~/.claude/tasks/<session
 * id>/`, one small JSON file per task, numbered. Nothing has to be parsed out
 * of a conversation and nothing has to be asked of the agent — the same
 * bargain the rest of the status line strikes.
 *
 * `activeForm` is the field this exists for. It is the present-continuous the
 * CLI shows in its own spinner — "Pushing background-agent state live" — which
 * is exactly the sentence a phone wants where it would otherwise print the
 * name of a tool.
 */

const TASKS_DIR = path.join(os.homedir(), '.claude', 'tasks')

/** A list longer than this is a plan, and a phone is not where you read it. */
const MAX_TASKS = 60
const MAX_SUBJECT = 160
const MAX_DESCRIPTION = 400

const oneLine = (value, max) => {
  const text = String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

/** Remembered per session, because a phone asks on every frame it draws. */
const cache = new Map()
const CACHE_MAX = 32

/** A session id names a directory, so it must not be able to name another one. */
const safe = (id) => /^[\w-]{1,80}$/.test(String(id || ''))

/**
 * The tasks for one session, or `null` when it has never written any.
 *
 * `null` and "an empty list" are different answers and the difference shows on
 * screen: a session with no list gets no panel at all, while one that finished
 * everything gets a panel saying so.
 */
export function read(sessionId) {
  if (!safe(sessionId)) return null
  const dir = path.join(TASKS_DIR, String(sessionId))

  let stat
  try {
    stat = fs.statSync(dir)
  } catch {
    return null
  }
  const hit = cache.get(sessionId)
  if (hit && hit.at === stat.mtimeMs) return hit.value

  let names = []
  try {
    names = fs.readdirSync(dir).filter((name) => /^\d+\.json$/.test(name))
  } catch {
    return null
  }

  const tasks = names
    // Numerically, not lexically: task 10 comes after task 9, and the order is
    // the order the agent wrote them in, which is the order they read in.
    .sort((a, b) => Number.parseInt(a, 10) - Number.parseInt(b, 10))
    .slice(0, MAX_TASKS)
    .map((name) => {
      try {
        const task = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'))
        if (!task || typeof task !== 'object') return null
        return {
          id: String(task.id ?? name.slice(0, -5)),
          subject: oneLine(task.subject, MAX_SUBJECT),
          description: oneLine(task.description, MAX_DESCRIPTION),
          // The spinner's sentence, when there is one; the subject stands in.
          activeForm: oneLine(task.activeForm || task.subject, MAX_SUBJECT),
          status: String(task.status || 'pending'),
          blockedBy: Array.isArray(task.blockedBy) ? task.blockedBy.map(String).slice(0, 20) : [],
        }
      } catch {
        return null
      }
    })
    .filter(Boolean)

  const value = tasks.length
    ? {
        tasks,
        total: tasks.length,
        done: tasks.filter((t) => t.status === 'completed').length,
        // What it is on right now. More than one can be in progress when work
        // was split; the first is the one a one-line summary quotes.
        active: tasks.find((t) => t.status === 'in_progress') || null,
        // …and what it will pick up next, for the moment between two tasks.
        // A strip that says "nothing in progress" during that moment reads as
        // an agent that has stopped, which is the one thing it has not done.
        next: tasks.find((t) => t.status === 'pending' && !t.blockedBy.length) || null,
      }
    : null

  if (cache.size >= CACHE_MAX) cache.clear()
  cache.set(sessionId, { at: stat.mtimeMs, value })
  return value
}

/**
 * The same thing small enough to ride on every session frame.
 *
 * The list itself is one call away; what travels with the row is the sentence
 * and the count, because those are what a list of six sessions needs to tell
 * them apart.
 */
export function summary(sessionId) {
  const value = read(sessionId)
  if (!value) return null
  return {
    total: value.total,
    done: value.done,
    active: value.active ? value.active.activeForm : null,
    next: value.next ? value.next.subject : null,
  }
}
