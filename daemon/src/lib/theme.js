import fs from 'node:fs'
import path from 'node:path'
import { OMARCHY_COLORS, OMARCHY_THEME, XDG_CONFIG } from './paths.js'

const THEMES_DIR = path.join(XDG_CONFIG, 'omarchy', 'themes')
import { log } from './log.js'

/**
 * Omarchy themes ship a flat colors.toml (`key = "#rrggbb"  # comment`).
 * A full TOML parser would be overkill: the file is generated, flat, and
 * every value we care about is a quoted string.
 */
export function parseColors(text) {
  const out = {}
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*"([^"]*)"/)
    if (m) out[m[1]] = m[2]
  }
  return out
}

export const FALLBACK_THEME = {
  name: 'omarchy',
  mode: 'dark',
  accent: '#78a9ff',
  background: '#161616',
  dark_background: '#131313',
  darker_background: '#0b0b0b',
  lighter_background: '#262626',
  selection: '#393939',
  muted: '#525252',
  foreground: '#d0d0d0',
  dark_foreground: '#525252',
  light_foreground: '#f2f2f2',
  bright_foreground: '#ffffff',
  red: '#ee5396',
  yellow: '#f1c21b',
  orange: '#ff832b',
  green: '#42be65',
  cyan: '#3ddbd9',
  blue: '#78a9ff',
  magenta: '#be95ff',
}

/**
 * `current/theme` is a plain directory, so the active theme's name is not in
 * the path. Themes generate colors.toml with their own name in the header
 * comment; fall back to matching the file against the installed themes.
 */
function themeName() {
  try {
    const head = fs.readFileSync(OMARCHY_COLORS, 'utf8').split('\n')[0]
    const m = head.match(/^#\s*([a-z0-9][a-z0-9._-]*)/i)
    if (m) return m[1]
  } catch {
    /* fall through */
  }
  try {
    const active = fs.readFileSync(OMARCHY_COLORS, 'utf8')
    for (const entry of fs.readdirSync(THEMES_DIR)) {
      const candidate = path.join(THEMES_DIR, entry, 'colors.toml')
      if (fs.existsSync(candidate) && fs.readFileSync(candidate, 'utf8') === active) return entry
    }
  } catch {
    /* no installed themes to match against */
  }
  return 'omarchy'
}

export function readTheme() {
  try {
    const colors = parseColors(fs.readFileSync(OMARCHY_COLORS, 'utf8'))
    return { ...FALLBACK_THEME, ...colors, name: themeName() }
  } catch {
    return { ...FALLBACK_THEME }
  }
}

/** Calls onChange whenever the active Omarchy theme changes. Returns a stop fn. */
export function watchTheme(onChange) {
  let timer = null
  let watcher = null
  const fire = () => {
    clearTimeout(timer)
    timer = setTimeout(() => onChange(readTheme()), 150)
  }
  try {
    watcher = fs.watch(OMARCHY_THEME, { persistent: false }, fire)
  } catch (err) {
    log.debug('theme watch unavailable:', err.message)
  }
  return () => {
    clearTimeout(timer)
    watcher?.close()
  }
}
