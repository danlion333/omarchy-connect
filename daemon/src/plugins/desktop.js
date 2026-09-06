import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { run, has, spawn, spawnDetached, notifyArgs } from '../lib/exec.js'
import { readTheme } from '../lib/theme.js'
import * as hypr from '../lib/hypr.js'

/** Actions that end the session get their own confirm flag from the app. */
const DESTRUCTIVE = new Set(['shutdown', 'reboot', 'logout'])

const POWER = {
  lock: () => (has('omarchy-system-lock') ? ['omarchy-system-lock', []] : ['loginctl', ['lock-session']]),
  sleep: () => ['systemctl', ['suspend']],
  shutdown: () =>
    has('omarchy-system-shutdown') ? ['omarchy-system-shutdown', []] : ['systemctl', ['poweroff']],
  reboot: () => (has('omarchy-system-reboot') ? ['omarchy-system-reboot', []] : ['systemctl', ['reboot']]),
  logout: null, // handled through the compositor socket, see 'system.power'
  screensaver: () => ['omarchy-launch-screensaver', []],
}

const WINDOW_ADDRESS = /^0x[0-9a-f]+$/i

/**
 * The three desktop switches the phone's Home tiles draw.
 *
 * Each one is a different animal on this desktop — a hyprsunset temperature, a
 * flag file under XDG_STATE_HOME, a property living inside the Quickshell
 * process — so each gets its own reader and its own flip, and the phone gets
 * one shape back. `on: null` is the honest answer for a switch this machine
 * cannot be asked about: the script is not installed, the shell is not
 * answering, the output was not what the script promises. The app dims the
 * tile rather than inventing a position for it.
 */
const TOGGLES = {
  nightlight: {
    bin: 'omarchy-toggle-nightlight',
    // `--status` prints {enabled, temperature}; temperature is null when
    // hyprsunset is not running at all, which is simply "not warm".
    read: () => statusEnabled('omarchy-toggle-nightlight', ['--status']),
    // The script resends the temperature until a freshly started hyprsunset
    // stops overriding it — up to ten 0.2 s rounds — so the flip is awaited
    // with room for that, and the reply carries the state it settled on.
    flip: ['omarchy-toggle-nightlight', [], 8000],
  },

  idle: {
    bin: 'omarchy-toggle-idle',
    // "Stay awake" is a flag file, and `status` prints enabled:true when it
    // exists. `enabled` here means the desktop is being held awake — not that
    // idling is enabled, which is what the word looks like it says.
    read: () => statusEnabled('omarchy-toggle-idle', ['status']),
    flip: ['omarchy-toggle-idle', ['toggle'], 5000],
  },

  silencing: {
    // Do-not-disturb lives in the Quickshell process rather than on disk, and
    // `omarchy-toggle-notification-silencing` only ever flips it. `dndState`
    // is the read-only half of the same IPC handler `toggleDnd` calls, so the
    // switch can be read without being moved.
    bin: 'omarchy-shell',
    read: async () => {
      const res = await run('omarchy-shell', ['notifications', 'dndState'])
      if (!res.ok) return null
      const word = res.stdout.split('\n')[0].trim().toLowerCase()
      return word === 'on' ? true : word === 'off' ? false : null
    },
    // Flipping goes through the toggle script rather than straight at the IPC
    // so the bar's bell follows: the script refreshes the indicators after.
    flip: ['omarchy-toggle-notification-silencing', [], 5000],
  },
}

/** What the phone may ask to be started, and what actually starts it. */
const LAUNCH = {
  terminal: ['omarchy-launch-terminal', []],
  // The presentation wrapper builds `omarchy-show-logo; $*; omarchy-show-done`
  // and hands it to bash, so with no command it produces a syntax error rather
  // than a window. A shell is the command that makes it a terminal.
  'floating-terminal': ['omarchy-launch-floating-terminal-with-presentation', ['bash']],
}

/** The `enabled` field of a one-line status JSON, or null if it is not there. */
async function statusEnabled(bin, args) {
  const res = await run(bin, args)
  if (!res.ok) return null
  try {
    const parsed = JSON.parse(res.stdout.split('\n')[0])
    return typeof parsed.enabled === 'boolean' ? parsed.enabled : null
  } catch {
    return null
  }
}

/** One switch as the phone sees it: `{ on }`, or null when it cannot be read. */
async function readToggle(name) {
  const spec = TOGGLES[name]
  if (!has(spec.bin)) return null
  const on = await spec.read()
  return on === null ? null : { on }
}

/** Runs a command to completion with no pipes to inherit, resolving on exit. */
function exited(bin, args, timeout) {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { stdio: 'ignore' })
    const timer = setTimeout(() => {
      child.kill()
      resolve()
    }, timeout)
    child.once('exit', () => {
      clearTimeout(timer)
      resolve()
    })
    child.once('error', () => {
      clearTimeout(timer)
      resolve()
    })
  })
}

export default {
  name: 'desktop',

  capabilities() {
    return {
      power: has('systemctl'),
      hyprland: hypr.available(),
      themes: has('omarchy-theme-list'),
      dns: has('omarchy-dns'),
      screenshot: has('omarchy-capture-screenshot'),
      // One installed switch is enough for the tiles to be worth drawing;
      // the ones this desktop cannot answer for come back null.
      toggles: Object.values(TOGGLES).some((t) => has(t.bin)),
      launch: has('omarchy-launch-terminal'),
      openUrl: has('xdg-open'),
    }
  },

  methods: {
    async 'system.power'({ action, confirm }) {
      if (!Object.hasOwn(POWER, action)) throw new Error(`unknown power action: ${action}`)
      if (DESTRUCTIVE.has(action) && confirm !== true) throw new Error(`${action} requires confirm: true`)
      if (action === 'logout') {
        await hypr.dispatch('hl.dsp.exit()', 'exit')
        return { ok: true, action }
      }
      const entry = POWER[action]
      const [bin, args] = entry()
      if (!has(bin)) throw new Error(`${bin} not installed`)
      // Detached: locking or suspending would otherwise kill our own response.
      spawnDetached(bin, args)
      return { ok: true, action }
    },

    async 'system.screenshot'({ mode = 'fullscreen', target = 'copy' } = {}) {
      if (!has('omarchy-capture-screenshot')) throw new Error('omarchy-capture-screenshot not installed')
      const modes = ['smart', 'region', 'windows', 'fullscreen']
      const targets = ['copy', 'save', 'slurp']
      if (!modes.includes(mode)) throw new Error(`mode must be one of ${modes.join(', ')}`)
      if (!targets.includes(target)) throw new Error(`target must be one of ${targets.join(', ')}`)
      spawnDetached('omarchy-capture-screenshot', [mode, target])
      return { ok: true, mode, target }
    },

    /** Every switch in one round trip, because the tiles are drawn together. */
    async 'system.toggles'() {
      const names = Object.keys(TOGGLES)
      const states = await Promise.all(names.map((name) => readToggle(name)))
      return Object.fromEntries(names.map((name, i) => [name, states[i]]))
    },

    async 'system.toggle'({ name } = {}) {
      if (!Object.hasOwn(TOGGLES, name)) throw new Error(`unknown toggle: ${name}`)
      const spec = TOGGLES[name]
      if (!has(spec.bin)) throw new Error(`${spec.bin} not installed`)
      const [bin, args, timeout] = spec.flip
      if (!has(bin)) throw new Error(`${bin} not installed`)
      // Awaited, not detached: the phone flipped a tile and the answer it
      // needs is where the switch ended up, which is only knowable after.
      // Awaited on exit with no pipes, though — the nightlight script starts
      // hyprsunset in the background the first time, and a child holding an
      // inherited stdout kept `run` waiting for EOF until its timeout while
      // the tile on the phone sat greyed out for eight seconds.
      await exited(bin, args, timeout)
      const state = await readToggle(name)
      return { name, on: state ? state.on : null }
    },

    async 'system.launch'({ app } = {}) {
      if (!Object.hasOwn(LAUNCH, app)) throw new Error(`unknown app: ${app}`)
      const [bin, args] = LAUNCH[app]
      if (!has(bin)) throw new Error(`${bin} not installed`)
      // Detached: these exec into a terminal that outlives the request.
      spawnDetached(bin, args)
      return { ok: true, app }
    },

    async 'system.openUrl'({ url }) {
      if (typeof url !== 'string') throw new Error('url required')
      // Only web URLs: xdg-open on an arbitrary scheme is an app-launch primitive.
      if (!/^https?:\/\/[^\s]+$/i.test(url)) throw new Error('only http(s) URLs are allowed')
      if (!has('xdg-open')) throw new Error('xdg-open not installed')
      spawnDetached('xdg-open', [url])
      return { ok: true, url }
    },

    async 'dns.get'() {
      if (!has('omarchy-dns')) return { provider: null, available: false }
      const res = await run('omarchy-dns', [])
      return { provider: res.ok ? res.stdout.split('\n')[0].trim() : null, available: true }
    },

    /**
     * `omarchy-dns` rewrites a NetworkManager drop-in, so it re-execs itself
     * under sudo. Use `sudo -n` and surface the missing rule as a real error
     * instead of hanging on a password prompt no phone can answer.
     */
    async 'dns.set'({ provider }) {
      const allowed = ['DHCP', 'Cloudflare', 'Google', 'Custom']
      if (!allowed.includes(provider)) throw new Error(`provider must be one of ${allowed.join(', ')}`)
      if (!has('omarchy-dns')) throw new Error('omarchy-dns not installed')
      const res = await run('sudo', ['-n', 'omarchy-dns', provider], { timeout: 20000 })
      if (!res.ok) {
        if (/password|askpass|sudo:/i.test(res.stderr)) {
          throw new Error('changing DNS needs a passwordless sudo rule for omarchy-dns')
        }
        throw new Error(res.stderr || 'omarchy-dns failed')
      }
      return { ok: true, provider }
    },

    'theme.current'() {
      return readTheme()
    },

    async 'theme.list'() {
      if (!has('omarchy-theme-list')) return { themes: [] }
      const res = await run('omarchy-theme-list', [])
      const current = has('omarchy-theme-current') ? (await run('omarchy-theme-current', [])).stdout : ''
      return {
        themes: res.stdout.split('\n').map((s) => s.trim()).filter(Boolean),
        current: current.trim() || null,
      }
    },

    async 'theme.set'({ name }) {
      if (!name || typeof name !== 'string') throw new Error('name required')
      if (!has('omarchy-theme-set')) throw new Error('omarchy-theme-set not installed')
      const res = await run('omarchy-theme-set', [name], { timeout: 20000 })
      if (!res.ok) throw new Error(res.stderr || 'theme switch failed')
      return { ok: true, theme: readTheme() }
    },

    async 'hypr.workspaces'() {
      const [workspaces, active] = await Promise.all([hypr.json('workspaces'), hypr.json('activeworkspace')])
      const list = workspaces
        .filter((w) => w.id > 0)
        .sort((a, b) => a.id - b.id)
        .map((w) => ({ id: w.id, name: w.name, windows: w.windows }))
      return { workspaces: list, activeId: active.id }
    },

    async 'hypr.goto'({ id }) {
      const n = Number(id)
      if (!Number.isInteger(n) || n < 1 || n > 99) throw new Error('workspace id 1..99 required')
      await hypr.dispatch(`hl.dsp.focus{workspace="${n}"}`, `workspace ${n}`)
      return { ok: true, id: n }
    },

    async 'hypr.windows'() {
      const clients = await hypr.json('clients')
      return {
        windows: clients
          .filter((c) => c.mapped)
          .map((c) => ({
            address: c.address,
            title: c.title,
            class: c.class,
            workspace: c.workspace?.id,
            floating: c.floating,
            focused: c.focusHistoryID === 0,
          })),
      }
    },

    async 'hypr.focus'({ address }) {
      if (!WINDOW_ADDRESS.test(String(address || ''))) throw new Error('window address required')
      await hypr.dispatch(`hl.dsp.focus{window="address:${address}"}`, `focuswindow address:${address}`)
      return { ok: true }
    },

    async 'hypr.close'({ address }) {
      if (!WINDOW_ADDRESS.test(String(address || ''))) throw new Error('window address required')
      await hypr.dispatch(`hl.dsp.window.close{window="address:${address}"}`, `closewindow address:${address}`)
      return { ok: true }
    },

    /** Ring the desktop so it can be located in the room. */
    async 'system.locate'() {
      if (has('notify-send')) {
        spawnDetached('notify-send', notifyArgs(['-u', 'critical', '-a', 'Omarchy Connect'], 'Here I am', os.hostname()))
      }
      const sounds = ['/usr/share/sounds/freedesktop/stereo/alarm-clock-elapsed.oga', '/usr/share/sounds/freedesktop/stereo/bell.oga']
      const sound = sounds.find((s) => fs.existsSync(s))
      if (sound && has('pw-play')) spawnDetached('pw-play', [sound])
      return { ok: true, sound: sound ? path.basename(sound) : null }
    },
  },
}
