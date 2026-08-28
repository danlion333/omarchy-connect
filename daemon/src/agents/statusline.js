import fs from 'node:fs'
import path from 'node:path'

import { execCommand } from '../lib/paths.js'
import { SETTINGS_FILE, readSettings, shellQuote } from './hooks.js'

/**
 * Claude Code's status line, borrowed as a data feed.
 *
 * The CLI runs the configured `statusLine` command on every update — a new
 * assistant turn, a mode change, a compact — and hands it JSON on stdin that
 * carries the two things nothing else on this desktop publishes fresh: the
 * account's rate-limit percentages as of the latest API response, and the
 * session's own context figures. The hooks say what an agent is *doing*; this
 * is the only channel that says what it is *spending*, at the moment it
 * spends it. Without it the phone reads `~/.claude.json`, which the CLI
 * refreshes on its own schedule — hours apart, and 8% behind reality in the
 * test that motivated this file.
 *
 * The bridge is the same shape as the hook bridge: a subcommand of this CLI
 * that posts what it was handed to the daemon and prints a short status line
 * back, because a status line that says nothing would be a strange thing to
 * install in somebody's terminal.
 *
 * A status line is singular in a way hooks are not — the settings hold one,
 * not a list — so this module refuses to replace one the user wrote. `write`
 * answers `null` for "that slot is somebody else's", and the CLI says so.
 */

export const command = () => [...execCommand().map(shellQuote), 'agent', 'statusline'].join(' ')

export const isOurs = (value) =>
  typeof value === 'string' && value.includes('agent statusline') && value.includes('omarchy-connect')

export function installed() {
  try {
    return isOurs(readSettings().statusLine?.command)
  } catch {
    return false
  }
}

/** Whether the slot is free to install into: empty, or already ours. */
export function available() {
  try {
    const current = readSettings().statusLine
    return !current?.command || isOurs(current.command)
  } catch {
    return false
  }
}

/**
 * Point Claude Code's status line at this CLI — or stop doing so. Returns the
 * command written, `''` for a clean removal, and `null` when the slot holds a
 * status line somebody else configured, which is theirs to keep.
 */
export function write(install) {
  const settings = readSettings()
  const current = settings.statusLine
  if (current?.command && !isOurs(current.command)) return null

  const next = { ...settings }
  if (install) next.statusLine = { type: 'command', command: command() }
  else if (current) delete next.statusLine
  else return ''

  fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true })
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(next, null, 2) + '\n')
  return install ? next.statusLine.command : ''
}
