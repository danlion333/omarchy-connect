import { has, run } from '../lib/exec.js'
import { log } from '../lib/log.js'
import * as hypr from '../lib/hypr.js'

/**
 * Turns the phone into a touchpad and keyboard for the desktop.
 *
 * Pointer motion, buttons and scroll all go through Hyprland's own dispatchers,
 * so there is nothing to install and no uinput permissions to hand out — the
 * usual price of admission for remote input on Wayland.
 *
 * Two details shape the implementation:
 *
 *  - `cursor.move` is absolute only, so relative motion is kept here as a
 *    cached position. The cache is re-read from the compositor whenever it
 *    goes stale, because the human at the desk may have moved the real mouse.
 *  - key events are delivered to a window, not to "the desktop", so the active
 *    window is resolved and named explicitly on every keystroke.
 */

const BUTTONS = { left: 'mouse:272', right: 'mouse:273', middle: 'mouse:274', back: 'mouse:275', forward: 'mouse:276' }
/**
 * Hyprland can inject keys and buttons but not scroll axes — verified, not
 * assumed. So a wheel is only real when ydotool is installed (`pacman -S
 * ydotool`); otherwise scrolling falls back to arrow keys, and says so, rather
 * than quietly doing something different from what the gesture implied.
 */
const SCROLL_KEYS = { up: 'Up', down: 'Down', left: 'Left', right: 'Right' }
const CURSOR_STALE_MS = 800
const CLICK_GAP_MS = 12

let cursor = null
let cursorAt = 0
let bounds = null
let boundsAt = 0

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** The union of every monitor, in the logical coordinates the cursor uses. */
async function layout() {
  if (bounds && Date.now() - boundsAt < 5000) return bounds
  const monitors = await hypr.json('monitors')
  if (!Array.isArray(monitors) || !monitors.length) throw new Error('no monitors reported')
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const m of monitors) {
    const scale = m.scale || 1
    minX = Math.min(minX, m.x)
    minY = Math.min(minY, m.y)
    maxX = Math.max(maxX, m.x + m.width / scale)
    maxY = Math.max(maxY, m.y + m.height / scale)
  }
  bounds = { minX, minY, maxX, maxY }
  boundsAt = Date.now()
  return bounds
}

async function readCursor() {
  const raw = (await hypr.request('cursorpos')).trim()
  const [x, y] = raw.split(',').map((n) => Number(n.trim()))
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('hyprland did not report a cursor position')
  return { x, y }
}

async function currentCursor() {
  if (!cursor || Date.now() - cursorAt > CURSOR_STALE_MS) cursor = await readCursor()
  return cursor
}

async function moveTo(x, y) {
  const area = await layout()
  const clamped = {
    x: Math.round(Math.min(Math.max(x, area.minX), area.maxX - 1)),
    y: Math.round(Math.min(Math.max(y, area.minY), area.maxY - 1)),
  }
  await hypr.dispatch(`hl.dsp.cursor.move{x=${clamped.x},y=${clamped.y}}`, `movecursor ${clamped.x} ${clamped.y}`)
  cursor = clamped
  cursorAt = Date.now()
  return clamped
}

/** Where keystrokes should land. Naming the window beats relying on focus. */
async function activeWindowRef() {
  try {
    const active = await hypr.json('activewindow')
    return active?.address ? `address:${active.address}` : null
  } catch {
    return null
  }
}

async function keyState(key, state, mods = '') {
  const target = await activeWindowRef()
  const window = target ? `, window="${target}"` : ''
  await hypr.dispatch(
    `hl.dsp.send_key_state{mods="${mods}", key="${key}", state="${state}"${window}}`,
    `sendkeystate ${mods || 'NONE'}, ${key}, ${state === 'down' ? '1' : '0'}`,
  )
}

/**
 * wtype's names for Hyprland's modifiers. wtype speaks xkb keysyms, which is
 * the vocabulary `input.key` already promises (`Return`, `BackSpace`, `Up`).
 */
const WTYPE_MODS = { SUPER: 'logo', CTRL: 'ctrl', ALT: 'alt', SHIFT: 'shift' }

/**
 * One key press and release.
 *
 * Verified on Hyprland 0.56, not assumed: `hl.dsp.send_key_state` answers
 * `ok` for `a` and `key not found` for `Return`, and delivers neither to the
 * focused window — a `read` in the target terminal sees nothing. wtype, which
 * the daemon already needs for `input.text`, delivers both text and named
 * keys through the virtual-keyboard protocol. So a keyboard key goes through
 * wtype whenever it is installed, and the compositor's dispatcher is the road
 * only when it is not. Mouse buttons (`mouse:272`) are not keys wtype knows
 * and keep the dispatcher.
 */
async function tap(key, mods = '') {
  if (!key.startsWith('mouse:') && has('wtype')) {
    const held = String(mods)
      .split(/\s+/)
      .filter(Boolean)
      .map((m) => WTYPE_MODS[m])
      .filter(Boolean)
    const args = []
    for (const m of held) args.push('-M', m)
    args.push('-k', key)
    for (const m of [...held].reverse()) args.push('-m', m)
    const res = await run('wtype', args, { timeout: 5000 })
    if (!res.ok) throw new Error(res.stderr || `wtype could not press ${key}`)
    return
  }
  await keyState(key, 'down', mods)
  await sleep(CLICK_GAP_MS)
  await keyState(key, 'up', mods)
}

const buttonFor = (name) => {
  // hasOwn, not a truthiness check: `BUTTONS['constructor']` would otherwise
  // hand back an inherited property and put it straight into a Lua string.
  const key = String(name || 'left').toLowerCase()
  if (!Object.hasOwn(BUTTONS, key)) throw new Error(`unknown button: ${name}`)
  return BUTTONS[key]
}

export default {
  name: 'input',

  capabilities() {
    const hyprland = hypr.available()
    return {
      pointer: hyprland,
      buttons: hyprland,
      keys: hyprland || has('wtype'),
      scroll: hyprland || has('wtype'),
      // 'wheel' is a real scroll axis; 'keys' moves by arrow key instead.
      scrollMode: has('ydotool') ? 'wheel' : hyprland ? 'keys' : 'none',
      // wtype types arbitrary text, including anything that is not on a
      // keyboard, and is how named keys are pressed too (see `tap`).
      text: has('wtype'),
    }
  },

  methods: {
    /** Current pointer position and the area it may move in. */
    async 'input.state'() {
      const [position, area] = await Promise.all([readCursor(), layout()])
      cursor = position
      cursorAt = Date.now()
      return {
        cursor: position,
        bounds: area,
        width: area.maxX - area.minX,
        height: area.maxY - area.minY,
      }
    },

    /** Relative motion — the touchpad's bread and butter. */
    async 'input.move'({ dx = 0, dy = 0 }) {
      if (!Number.isFinite(dx) || !Number.isFinite(dy)) throw new Error('dx and dy must be numbers')
      const at = await currentCursor()
      return moveTo(at.x + dx, at.y + dy)
    },

    async 'input.moveTo'({ x, y }) {
      if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('x and y must be numbers')
      return moveTo(x, y)
    },

    async 'input.click'({ button = 'left', count = 1 }) {
      const code = buttonFor(button)
      const times = Math.min(Math.max(Number(count) || 1, 1), 3)
      for (let i = 0; i < times; i += 1) {
        if (i) await sleep(40)
        await tap(code)
      }
      return { button, count: times }
    },

    /** Press and hold, or release — this is what makes drag work. */
    async 'input.button'({ button = 'left', down = true }) {
      const code = buttonFor(button)
      await keyState(code, down ? 'down' : 'up')
      return { button, down: Boolean(down) }
    },

    async 'input.scroll'({ dy = 0, dx = 0 }) {
      const vertical = Math.min(Math.abs(Math.round(dy)), 15)
      const horizontal = Math.min(Math.abs(Math.round(dx)), 15)
      if (!vertical && !horizontal) return { steps: 0, mode: 'none' }

      if (has('ydotool')) {
        const res = await run('ydotool', [
          'mousemove',
          '--wheel',
          '-x',
          String(horizontal ? (dx > 0 ? horizontal : -horizontal) : 0),
          '-y',
          String(vertical ? (dy > 0 ? vertical : -vertical) : 0),
        ])
        if (res.ok) return { steps: vertical + horizontal, mode: 'wheel' }
        // ydotool needs its daemon and uinput access; if it is not set up,
        // say so once and carry on with the fallback rather than failing.
        log.debug('ydotool scroll failed, falling back to keys:', res.stderr)
      }

      const steps = []
      for (let i = 0; i < vertical; i += 1) steps.push(dy > 0 ? SCROLL_KEYS.down : SCROLL_KEYS.up)
      for (let i = 0; i < horizontal; i += 1) steps.push(dx > 0 ? SCROLL_KEYS.right : SCROLL_KEYS.left)
      for (const step of steps) await tap(step)
      return { steps: steps.length, mode: 'keys' }
    },

    /**
     * A named key, optionally with modifiers — `Return`, `BackSpace`, `Tab`,
     * `XF86AudioPlay`, or a letter. Mods are Hyprland's own names, space
     * separated: `SUPER`, `CTRL`, `ALT`, `SHIFT`.
     */
    async 'input.key'({ key, mods = '' }) {
      if (typeof key !== 'string' || !key.trim()) throw new Error('key is required')
      if (!/^[A-Za-z0-9_+:]+$/.test(key)) throw new Error('that does not look like a key name')
      const modifiers = String(mods)
        .toUpperCase()
        .split(/[\s,+]+/)
        .filter((m) => ['SUPER', 'CTRL', 'ALT', 'SHIFT'].includes(m))
        .join(' ')
      await tap(key, modifiers)
      return { key, mods: modifiers }
    },

    /** Types literal text, emoji and all. */
    async 'input.text'({ text }) {
      if (typeof text !== 'string' || !text.length) throw new Error('text is required')
      if (text.length > 4096) throw new Error('that is too much text to type at once')
      if (!has('wtype')) throw new Error('wtype is not installed — the desktop cannot type arbitrary text')
      const res = await run('wtype', ['--', text], { timeout: 15_000 })
      if (!res.ok) throw new Error(res.stderr || 'wtype failed')
      return { typed: text.length }
    },
  },
}
