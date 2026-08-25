/**
 * The app wears whatever theme the desktop is wearing. Until a desktop is
 * connected we fall back to the Omarchy default palette, and every screen
 * reads its colours from here so a theme switch on the desktop repaints the
 * phone within a frame.
 */
export type Palette = {
  name: string
  mode: 'dark' | 'light'
  accent: string
  background: string
  dark_background: string
  darker_background: string
  lighter_background: string
  selection: string
  muted: string
  foreground: string
  dark_foreground: string
  light_foreground: string
  bright_foreground: string
  red: string
  yellow: string
  orange: string
  green: string
  cyan: string
  blue: string
  magenta: string
}

export const FALLBACK_PALETTE: Palette = {
  name: 'omarchy',
  mode: 'dark',
  accent: '#789978',
  background: '#101010',
  dark_background: '#131313',
  darker_background: '#080808',
  lighter_background: '#242424',
  selection: '#2a2a2a',
  muted: '#555555',
  foreground: '#cccccc',
  dark_foreground: '#555555',
  light_foreground: '#aaaaaa',
  bright_foreground: '#ffffff',
  red: '#d70000',
  yellow: '#abab77',
  orange: '#ffaa88',
  green: '#789978',
  cyan: '#77aa99',
  blue: '#7788aa',
  magenta: '#aa88aa',
}

export const font = {
  regular: 'JetBrainsMono_400Regular',
  medium: 'JetBrainsMono_500Medium',
  bold: 'JetBrainsMono_700Bold',
}

export const size = {
  micro: 10,
  label: 12,
  body: 14,
  value: 15,
  title: 20,
  hero: 34,
}

export const space = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
}

export const radius = { sm: 6, md: 10, lg: 14 }

/** Blends a colour toward black — used for pressed states and meter tracks. */
export function shade(hex: string, amount: number): string {
  const clean = hex.replace('#', '')
  const full = clean.length === 3 ? clean.split('').map((c) => c + c).join('') : clean
  const n = Number.parseInt(full, 16)
  if (!Number.isFinite(n)) return hex
  const r = Math.round(((n >> 16) & 255) * (1 - amount))
  const g = Math.round(((n >> 8) & 255) * (1 - amount))
  const b = Math.round((n & 255) * (1 - amount))
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`
}

/** Adds an alpha channel to a #rrggbb colour. */
export function alpha(hex: string, a: number): string {
  const clean = hex.replace('#', '')
  const full = clean.length === 3 ? clean.split('').map((c) => c + c).join('') : clean
  return `#${full}${Math.round(Math.max(0, Math.min(1, a)) * 255).toString(16).padStart(2, '0')}`
}
