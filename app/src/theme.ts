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

/**
 * The type scale, in sp.
 *
 * JetBrains Mono is the brand and it stays, but a monospace face is wide: at
 * 15sp a character is 9dp, so a 360dp phone with 16dp of screen padding and
 * 14dp of card padding has room for 33 of them on a line — before a label.
 * The old scale (20sp titles, 15sp values, 14sp body) was set for a laptop
 * bar and produced "192.1…" on every second row. Everything here is one or
 * two steps smaller, and every `Text` in the kit caps the OS font multiplier
 * at 1.2 so an accessibility setting cannot push a value off its row either.
 *
 * `line` is the matching line height: mono needs air above and below or
 * a paragraph reads as a code listing.
 */
export const size = {
  micro: 10,
  label: 12,
  body: 13,
  value: 14,
  /** A card's own title. The screen's title is bigger; a card's is a value in bold. */
  cardTitle: 14,
  title: 16,
  hero: 28,
}

export const line = {
  micro: 14,
  label: 17,
  body: 20,
  value: 20,
  cardTitle: 20,
  title: 22,
  hero: 34,
}

/** The largest OS font scale the layout is allowed to follow. */
export const MAX_FONT_SCALE = 1.2

export const space = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
}

/**
 * `sm` is the chip and the small tile corner, `ctl` every control the thumb
 * lands on (button, icon button, field, segmented, tile), `md` a card, `pill`
 * the fully round ones.
 */
export const radius = { sm: 8, ctl: 10, md: 12, lg: 16, pill: 999 }

/** The one tap target size. Buttons, chips, icon buttons and list rows sit on it. */
export const touch = 44

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

/**
 * The two colours the glass look is made of.
 *
 * The mock paints cards translucent over a wallpaper — `--card` is the dark
 * background at 76%, `--edge` the lighter background at 85% — and the
 * Transparency switch swaps both for the solid colours and turns the
 * wallpaper off. Everything that draws a card surface asks here rather than
 * writing the numbers again.
 */
export function surface(p: Palette, solid: boolean): { card: string; edge: string } {
  if (solid) return { card: p.dark_background, edge: p.lighter_background }
  return { card: alpha(p.dark_background, 0.76), edge: alpha(p.lighter_background, 0.85) }
}
