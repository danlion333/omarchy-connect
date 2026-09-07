import system from './system.js'
import clipboard from './clipboard.js'
import notifications from './notifications.js'
import media from './media.js'
import desktop from './desktop.js'
import share from './share.js'
import input from './input.js'
import device from './device.js'
import phone from './phone.js'
import agents from './agents.js'
import dictation from './dictation.js'
import audio from './audio.js'
import terminal from './terminal.js'

export const plugins = [system, clipboard, notifications, media, desktop, share, input, device, phone, agents, dictation, audio, terminal]

export function buildMethodTable() {
  const table = new Map()
  for (const plugin of plugins) {
    for (const [name, fn] of Object.entries(plugin.methods || {})) {
      if (table.has(name)) throw new Error(`duplicate method ${name}`)
      table.set(name, fn.bind(plugin.methods))
    }
  }
  return table
}

/**
 * What this desktop can do for the phone on the other end of one particular
 * socket.
 *
 * `ctx` describes that socket rather than the machine — today only `remote`,
 * which is true when the phone reached us down a tunnel rather than over the
 * wire. Only the phone plugin reads it; the rest answer the same for
 * everybody, because a tunnel changes nothing about whether `wpctl` is
 * installed.
 */
export function collectCapabilities(ctx = {}) {
  const caps = {}
  for (const plugin of plugins) caps[plugin.name] = plugin.capabilities?.(ctx) ?? {}
  return caps
}

export function startPlugins(bus) {
  for (const plugin of plugins) plugin.start?.(bus)
}

export function stopPlugins() {
  for (const plugin of plugins) {
    try {
      plugin.stop?.()
    } catch {
      /* shutting down anyway */
    }
  }
}
