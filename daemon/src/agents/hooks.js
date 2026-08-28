import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { execCommand } from '../lib/paths.js'

/**
 * Claude Code's lifecycle hooks, as this desktop installs them.
 *
 * A transcript says what an agent did; only a hook can say that it has stopped
 * and is waiting for an answer. A permission prompt is drawn on the terminal
 * and never written to disk at all, and a question the agent asked is worse
 * than that: Claude Code holds the whole assistant turn back until the tool
 * inside it has returned, so by the time `AskUserQuestion` reaches the file it
 * has already been answered at the keyboard. Both of the moments a person on
 * the sofa could help are moments the transcript is silent about. So the hooks
 * are the half of the feature that earns the notification, and both the CLI
 * and the panel need to know whether they are in place — which is why this
 * lives beside the adapter rather than inside the CLI that used to own it.
 *
 * Nothing here runs an agent or reads a transcript: it is one JSON file,
 * edited without disturbing whatever else the user has hooked.
 */

const HOME = os.homedir()

export const SETTINGS_FILE = path.join(HOME, '.claude', 'settings.json')

/**
 * Every hook this desktop installs: the lifecycle events the state machine
 * needs, and the two tool events that carry a question.
 *
 * The tool pair is narrowed with a matcher, and the narrowing is not tidiness.
 * An unmatched `PreToolUse` spawns a process on every `Bash` an agent runs,
 * which is a tax on the agent for the sake of one tool in a hundred; scoped to
 * `AskUserQuestion` it fires only when there is something for a phone to do.
 */
export const HOOKS = [
  { event: 'SessionStart' },
  { event: 'UserPromptSubmit' },
  { event: 'Stop' },
  { event: 'Notification' },
  { event: 'SessionEnd' },
  { event: 'PreToolUse', matcher: 'AskUserQuestion' },
  { event: 'PostToolUse', matcher: 'AskUserQuestion' },
  // The permission prompt, the moment it is decided rather than six seconds
  // after it is drawn: `Notification` waits out an idle threshold before it
  // says anything, and those seconds are the whole latency budget of a phone
  // that exists to answer exactly this. The hook offers no opinion — exit 0
  // with no output leaves the prompt exactly as it was — it only tells us.
  { event: 'PermissionRequest' },
  // The heartbeat of a turn. One firing per batch of tool calls, which is what
  // clears a stale `waiting` when the prompt was answered at the keyboard —
  // no other hook says anything between the answer and the end of the turn,
  // and the turn can be minutes long.
  { event: 'PostToolBatch' },
  // The fan-out. Sidechain traffic is hidden from the chat on purpose, so
  // these two are the only sign a session is more than one agent.
  { event: 'SubagentStart' },
  { event: 'SubagentStop' },
]

/** The events, in installation order — what the CLI and the panel report. */
export const EVENTS = HOOKS.map((hook) => hook.event)

export const shellQuote = (value) => (/[\s"'$`\\]/.test(value) ? `'${value.replace(/'/g, `'\\''`)}'` : value)

/** How a hook invokes this CLI again, without depending on `$PATH`. */
export const command = () => [...execCommand().map(shellQuote), 'agent', 'hook'].join(' ')

export const isOurs = (entry) =>
  typeof entry?.command === 'string' && entry.command.includes('agent hook') && entry.command.includes('omarchy-connect')

export function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'))
  } catch (err) {
    if (err.code === 'ENOENT') return {}
    throw new Error(`${SETTINGS_FILE} is not valid JSON — fix it first`)
  }
}

// `installed()` is read on every status publish, and a publish happens every
// time a phone breathes. The answer only changes when the file does, so the
// mtime is what is consulted and the parse is what is skipped.
let cache = { at: -1, value: false }

export function installed() {
  let mtime = -1
  try {
    mtime = fs.statSync(SETTINGS_FILE).mtimeMs
  } catch {
    cache = { at: -1, value: false }
    return false
  }
  if (mtime === cache.at) return cache.value
  let value = false
  try {
    const hooks = readSettings().hooks || {}
    // The matcher is part of what is installed, not a detail: an installation
    // that predates the question hooks has the events but not the narrowing,
    // and reporting that as installed would leave the phone in the dark.
    value = HOOKS.every(({ event, matcher }) =>
      (hooks[event] || []).some(
        (group) => (group.matcher || undefined) === matcher && (group.hooks || []).some(isOurs),
      ),
    )
  } catch {
    // Settings we cannot parse are settings we have not hooked.
    value = false
  }
  cache = { at: mtime, value }
  return value
}

/**
 * Add — or remove — our hook from Claude Code's settings without disturbing
 * anybody else's. Every write strips our own entries first, so running this
 * twice leaves one hook rather than two.
 */
export function write(install) {
  const settings = readSettings()
  const hooks = { ...(settings.hooks || {}) }
  const line = command()

  for (const event of Object.keys(hooks)) {
    const groups = (hooks[event] || [])
      .map((group) => ({ ...group, hooks: (group.hooks || []).filter((h) => !isOurs(h)) }))
      .filter((group) => group.hooks.length)
    if (groups.length) hooks[event] = groups
    else delete hooks[event]
  }

  if (install) {
    for (const { event, matcher } of HOOKS) {
      const group = { ...(matcher ? { matcher } : {}), hooks: [{ type: 'command', command: line, timeout: 5 }] }
      hooks[event] = [...(hooks[event] || []), group]
    }
  }

  const next = { ...settings }
  if (Object.keys(hooks).length) next.hooks = hooks
  else delete next.hooks
  fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true })
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(next, null, 2) + '\n')
  cache = { at: -1, value: false }
  return line
}
