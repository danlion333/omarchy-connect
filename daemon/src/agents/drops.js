import fs from 'node:fs'
import path from 'node:path'

import { XDG_CACHE } from '../lib/paths.js'
import { log } from '../lib/log.js'

/**
 * Where a picture from the phone lands before an agent is told about it.
 *
 * An agent reads an image the way it reads everything else — by path — so the
 * whole of "show Claude this screenshot" is two steps: put the bytes somewhere
 * on the desktop, then type where they are. This module is the somewhere.
 *
 * Deliberately not the share inbox. A screenshot handed to an agent is
 * scaffolding for one question, not a file anybody meant to keep: routing it
 * through `~/Downloads/Omarchy Connect` would fill a directory people actually
 * look at with pictures they never asked to save, and fire a desktop
 * notification for each one. The cache is what this is, so the cache is where
 * it lives.
 *
 * Nothing deletes a drop when the agent is done with it, because nothing knows
 * when that is — a conversation comes back to a screenshot ten minutes later
 * as readily as ten seconds. So the directory is swept instead: old first,
 * then oldest-beyond-the-count, on the way in.
 */

export const DROPS = path.join(XDG_CACHE, 'omarchy-connect', 'agent')

/** How long a dropped file stays readable to the agent that was given it. */
const TTL_MS = 24 * 60 * 60 * 1000
/** …and how many survive regardless, so a busy hour cannot fill a disk. */
const MAX_FILES = 200
/** One picture. Anything larger is a file transfer wearing a disguise. */
export const MAX_DROP = 32 * 1024 * 1024

/**
 * A name safe to type into a terminal.
 *
 * The path is going to be typed at a TUI prompt as a bare word, so a space in
 * it would arrive as two arguments and a quote as something worse. The phone
 * chose this name and the desktop is under no obligation to keep it — what
 * matters is that the extension survives, because that is what tells the agent
 * it is looking at a picture.
 */
function safeName(raw) {
  const base = path.basename(String(raw || '')).replace(/[^A-Za-z0-9._-]+/g, '-')
  const trimmed = base.replace(/^[-.]+/, '').slice(0, 80)
  return trimmed || `drop-${Date.now()}`
}

function entries() {
  let names = []
  try {
    names = fs.readdirSync(DROPS)
  } catch {
    return []
  }
  return names
    .map((name) => {
      try {
        const file = path.join(DROPS, name)
        const stat = fs.statSync(file)
        return stat.isFile() ? { path: file, name, at: stat.mtimeMs } : null
      } catch {
        return null
      }
    })
    .filter(Boolean)
    .sort((a, b) => b.at - a.at)
}

/** Drop what is old, then what is merely surplus. */
export function sweep() {
  const now = Date.now()
  const list = entries()
  const doomed = list.filter((file, i) => now - file.at > TTL_MS || i >= MAX_FILES)
  for (const file of doomed) {
    try {
      fs.rmSync(file.path, { force: true })
    } catch (err) {
      log.debug('could not sweep an agent drop:', err.message)
    }
  }
  return doomed.length
}

/** Never overwrite: two screenshots taken in the same second are two files. */
export function pathFor(name) {
  fs.mkdirSync(DROPS, { recursive: true, mode: 0o700 })
  sweep()
  const safe = safeName(name)
  const ext = path.extname(safe)
  const stem = safe.slice(0, safe.length - ext.length)
  let candidate = path.join(DROPS, safe)
  for (let n = 2; fs.existsSync(candidate); n += 1) candidate = path.join(DROPS, `${stem}-${n}${ext}`)
  return candidate
}

/**
 * Is this a path this desktop put here?
 *
 * `agents.attach` types whatever it is handed into a terminal, so the one
 * thing it must never do is type a path the phone made up. Containment is
 * checked against the resolved directory rather than the string, because a
 * `..` is exactly the guess worth defeating and a symlink is the same guess
 * spelled differently.
 */
export function holds(candidate) {
  let real
  let root
  try {
    real = fs.realpathSync(String(candidate || ''))
    root = fs.realpathSync(DROPS)
  } catch {
    return false
  }
  if (real !== path.join(root, path.basename(real))) return false
  try {
    return fs.statSync(real).isFile()
  } catch {
    return false
  }
}
