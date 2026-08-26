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

export const plugins = [system, clipboard, notifications, media, desktop, share, input, device, phone, agents]

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

export function collectCapabilities() {
  const caps = {}
  for (const plugin of plugins) caps[plugin.name] = plugin.capabilities?.() ?? {}
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
