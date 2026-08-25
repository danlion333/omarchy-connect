import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { XDG_CONFIG } from './paths.js'
import { run, has } from './exec.js'

/**
 * Installing the desktop client into the Omarchy shell.
 *
 * Omarchy 4 hosts its desktop in one long-running Quickshell process and loads
 * third-party plugins out of `~/.config/omarchy/plugins/<id>/`. Installing is
 * therefore a copy plus two IPC calls — no build step, no restart, and no root.
 * Files are copied rather than symlinked because the shell refuses to load a
 * plugin folder containing a symlink; that check is why `omarchy plugin add`
 * clones instead of linking, and we play by the same rule.
 */
export const PLUGIN_ID = 'omarchy-connect.phone'

const here = path.dirname(fileURLToPath(import.meta.url))

export const SOURCE_DIR = path.resolve(here, '..', '..', '..', 'shell')
export const PLUGINS_DIR = path.join(XDG_CONFIG, 'omarchy', 'plugins')
export const TARGET_DIR = path.join(PLUGINS_DIR, PLUGIN_ID)
export const SHELL_CONFIG = path.join(XDG_CONFIG, 'omarchy', 'shell.json')

const COPYABLE = /\.(qml|js|json|md|svg)$/

function sourceFiles(dir = SOURCE_DIR, prefix = '') {
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? path.join(prefix, entry.name) : entry.name
    if (entry.isSymbolicLink()) continue
    if (entry.isDirectory()) out.push(...sourceFiles(path.join(dir, entry.name), rel))
    else if (entry.isFile() && COPYABLE.test(entry.name)) out.push(rel)
  }
  return out
}

export function available() {
  return fs.existsSync(path.join(SOURCE_DIR, 'manifest.json'))
}

export function installed() {
  return fs.existsSync(path.join(TARGET_DIR, 'manifest.json'))
}

/** Is the plugin in the bar? Third-party enabled ⇔ present in shell.json. */
export function enabled() {
  try {
    return fs.readFileSync(SHELL_CONFIG, 'utf8').includes(`"${PLUGIN_ID}"`)
  } catch {
    return false
  }
}

export function shellRunning() {
  return has('omarchy-shell')
}

export function copyPlugin() {
  if (!available()) throw new Error(`no plugin source at ${SOURCE_DIR}`)
  fs.mkdirSync(TARGET_DIR, { recursive: true })
  const files = sourceFiles()
  for (const rel of files) {
    const target = path.join(TARGET_DIR, rel)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.copyFileSync(path.join(SOURCE_DIR, rel), target)
    fs.chmodSync(target, 0o644)
  }
  // Anything left from an older version would still be loadable code.
  for (const stale of sourceFiles(TARGET_DIR)) {
    if (!files.includes(stale)) fs.rmSync(path.join(TARGET_DIR, stale), { force: true })
  }
  return files
}

export async function validate() {
  if (!has('omarchy')) return { ok: true, skipped: 'omarchy CLI not found' }
  const res = await run('omarchy', ['plugin', 'validate', TARGET_DIR])
  return { ok: res.ok, error: res.stderr || res.stdout }
}

export async function rescan() {
  if (!has('omarchy-shell')) return false
  const res = await run('omarchy-shell', ['shell', 'rescanPlugins'])
  return res.ok
}

export async function enable(section = 'right') {
  if (!has('omarchy')) return { ok: false, error: 'omarchy CLI not found' }
  const res = await run('omarchy', ['plugin', 'enable', PLUGIN_ID, section], { timeout: 15000 })
  return { ok: res.ok, error: res.stderr || res.stdout }
}

export async function disable() {
  if (!has('omarchy')) return { ok: false, error: 'omarchy CLI not found' }
  const res = await run('omarchy', ['plugin', 'disable', PLUGIN_ID], { timeout: 15000 })
  return { ok: res.ok, error: res.stderr || res.stdout }
}

export function removeFiles() {
  fs.rmSync(TARGET_DIR, { recursive: true, force: true })
}
