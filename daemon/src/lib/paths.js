import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = os.homedir()

export const XDG_CONFIG = process.env.XDG_CONFIG_HOME || path.join(home, '.config')
export const XDG_STATE = process.env.XDG_STATE_HOME || path.join(home, '.local', 'state')
export const XDG_CACHE = process.env.XDG_CACHE_HOME || path.join(home, '.cache')
export const XDG_DOWNLOAD = process.env.XDG_DOWNLOAD_DIR || path.join(home, 'Downloads')

export const CONFIG_DIR = path.join(XDG_CONFIG, 'omarchy-connect')
export const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json')

export const OMARCHY_STATE = path.join(XDG_STATE, 'omarchy')
export const OMARCHY_THEME = path.join(OMARCHY_STATE, 'current', 'theme')
export const OMARCHY_COLORS = path.join(OMARCHY_THEME, 'colors.toml')
export const OMARCHY_NOTIFICATIONS = path.join(OMARCHY_STATE, 'notifications', 'history')

/**
 * How this daemon can be invoked again, so neither the panel nor an agent's
 * hook ever needs `$PATH`. A checkout runs out of the checkout; anything else
 * is the installed name.
 */
export function execCommand() {
  const entry = path.resolve(new URL('../../bin/omarchy-connect.js', import.meta.url).pathname)
  return fs.existsSync(entry) ? [process.execPath, entry] : ['omarchy-connect']
}
