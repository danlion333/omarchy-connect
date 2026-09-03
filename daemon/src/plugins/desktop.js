import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { run, has, spawnDetached, notifyArgs } from '../lib/exec.js'
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

export default {
  name: 'desktop',

  capabilities() {
    return {
      power: has('systemctl'),
      hyprland: hypr.available(),
      themes: has('omarchy-theme-list'),
      dns: has('omarchy-dns'),
      screenshot: has('omarchy-capture-screenshot'),
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
