import fs from 'node:fs'
import path from 'node:path'

import { XDG_DATA, execCommand } from './paths.js'

/**
 * "Send to phone" in the Nautilus context menu.
 *
 * Sending a file from the desktop already has two doors — `omarchy-connect
 * send <file>` in a terminal, and a drop on the bar icon — and both of them
 * ask the user to leave the file manager first. This is the third door, in the
 * place where the file is already under the cursor.
 *
 * Nautilus is the only file manager here on purpose. The portable answer would
 * have been one `.desktop` file in `~/.local/share/applications/` claiming
 * every MIME type, and it does not work: `update-desktop-database` refuses
 * `MimeType=all/all` outright ("all" is an unregistered media type), and
 * `text/*` is copied into `mimeinfo.cache` literally, where `gio mime
 * text/plain` never looks. So it is Nautilus's own mechanism or nothing, and
 * of its two — a script in this directory, or a `nautilus-python` extension —
 * this is the one that costs no dependency. The price is that the item sits
 * one level down, under "Scripts".
 *
 * What gets installed is four lines of `sh` that hand straight over to this
 * daemon's CLI. Nautilus passes the selection in the environment, so the
 * script has nothing to parse and nothing to quote: `NAUTILUS_SCRIPT_SELECTED_URIS`
 * is inherited by the child, and the reading of it happens in JavaScript, next
 * to the panel's version of the same job.
 */

export const SCRIPTS_DIR = path.join(XDG_DATA, 'nautilus', 'scripts')

/** The filename *is* the menu entry — Nautilus shows it verbatim. */
export const SCRIPT_NAME = 'Send to phone'
export const SCRIPT_FILE = path.join(SCRIPTS_DIR, SCRIPT_NAME)

/** What says this file is ours and not a script somebody wrote by hand. */
const MARKER = 'omarchy-connect nautilus'

/**
 * The selected files, out of the variable Nautilus sets.
 *
 * This is `dropPaths()` from `shell/Model.js:159` again, and deliberately so:
 * a drag off a Nautilus window and a right-click inside one produce the same
 * `file://` URIs, with the same escaping, the same foreign hosts to refuse and
 * the same duplicates to fold. The two copies exist because one of them has to
 * run inside Quickshell's QML engine and the other inside this daemon; the
 * suite in `daemon/test/nautilus.mjs` holds them against each other on the
 * same inputs so they cannot drift apart quietly.
 *
 * Newline-separated, because that is what Nautilus writes.
 */
export function uriPaths(raw) {
  const paths = []
  for (const line of String(raw || '').split('\n')) {
    const item = line.trim()
    if (item === '') continue
    let found = ''
    if (item.toLowerCase().startsWith('file:')) {
      const rest = item.slice(5).replace(/^\/\//, '')
      const slash = rest.indexOf('/')
      if (slash < 0) continue
      const host = rest.slice(0, slash).toLowerCase()
      if (host !== '' && host !== 'localhost') continue
      found = rest.slice(slash)
      // A name with a stray `%` is a name, not a broken escape: keep the
      // characters rather than throwing the whole file away.
      try {
        found = decodeURIComponent(found)
      } catch {
        /* the escape is lost, the file is not */
      }
    } else if (item.startsWith('/')) {
      found = item
    } else {
      continue
    }
    if (found !== '' && !paths.includes(found)) paths.push(found)
  }
  return paths
}

/** One argument, safe inside single quotes whatever is in it. */
const quote = (word) => `'${String(word).replaceAll("'", `'\\''`)}'`

/**
 * The script Nautilus runs, with this daemon's own name baked in.
 *
 * `execCommand()` rather than `omarchy-connect`, because a checkout has no
 * installed binary and Nautilus's child does not inherit an interactive
 * shell's `$PATH`. `exec` so the item leaves no shell behind it.
 */
export function scriptBody(exec = execCommand()) {
  return [
    '#!/bin/sh',
    `# ${MARKER} — "${SCRIPT_NAME}" in the Nautilus context menu.`,
    '# Written by `omarchy-connect nautilus install`; delete it with',
    '# `omarchy-connect nautilus remove` rather than by hand.',
    '#',
    '# Nautilus puts the selection in NAUTILUS_SCRIPT_SELECTED_URIS, which the',
    '# child inherits, so there is nothing to pass and nothing to quote here.',
    `exec ${exec.map(quote).join(' ')} nautilus send`,
    '',
  ].join('\n')
}

export function installed() {
  try {
    return fs.readFileSync(SCRIPT_FILE, 'utf8').includes(MARKER)
  } catch {
    return false
  }
}

/**
 * Put the item in the menu.
 *
 * The directory is created only when it is missing, and at 0700 — the mode
 * Nautilus itself uses for it. An existing one is left exactly as it is,
 * permissions included: it is the user's directory and may hold their own
 * scripts.
 */
export function install() {
  fs.mkdirSync(SCRIPTS_DIR, { recursive: true, mode: 0o700 })
  fs.writeFileSync(SCRIPT_FILE, scriptBody(), { mode: 0o755 })
  fs.chmodSync(SCRIPT_FILE, 0o755)
  return SCRIPT_FILE
}

/**
 * Take it back out.
 *
 * Only our own file goes. The directory stays even when it is left empty: it
 * predates us on most desktops, Nautilus made it, and removing somebody's
 * directory to tidy up after ourselves is not our call.
 */
export function remove() {
  const was = fs.existsSync(SCRIPT_FILE)
  fs.rmSync(SCRIPT_FILE, { force: true })
  return was
}
