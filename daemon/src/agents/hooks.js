import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { execCommand } from '../lib/paths.js'

/**
 * Claude Code's lifecycle hooks, as this desktop installs them.
 *
 * A transcript says what an agent did; only a hook can say that it has stopped
 * and is waiting for an answer, because a permission prompt is drawn on the
 * terminal and never written to disk. So the hooks are the half of the feature
 * that earns the notification, and both the CLI and the panel need to know
 * whether they are in place — which is why this lives beside the adapter
 * rather than inside the CLI that used to own it.
 *
 * Nothing here runs an agent or reads a transcript: it is one JSON file,
 * edited without disturbing whatever else the user has hooked.
 */

const HOME = os.homedir()

export const SETTINGS_FILE = path.join(HOME, '.claude', 'settings.json')

/** The lifecycle events worth a hook: everything the state machine needs. */
export const EVENTS = ['SessionStart', 'UserPromptSubmit', 'Stop', 'Notification', 'SessionEnd']

const shellQuote = (value) => (/[\s"'$`\\]/.test(value) ? `'${value.replace(/'/g, `'\\''`)}'` : value)

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
    value = EVENTS.every((event) => (hooks[event] || []).some((group) => (group.hooks || []).some(isOurs)))
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
    for (const event of EVENTS) {
      hooks[event] = [...(hooks[event] || []), { hooks: [{ type: 'command', command: line, timeout: 5 }] }]
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
