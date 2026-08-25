/**
 * What the phone chooses to tell the desktop about itself.
 *
 * The desktop already streams its own vitals down to the phone; this is the
 * return leg, and it exists for the desktop client — a panel that can show a
 * phone's name but not whether it is about to die is half a status card.
 * Everything here is opt-in from the phone's side and lives only in memory,
 * so unpairing or restarting forgets it.
 */
const reports = new Map()

const num = (value, min, max) => {
  const n = Number(value)
  if (!Number.isFinite(n)) return null
  return Math.max(min, Math.min(max, Math.round(n)))
}

export function telemetryFor(deviceId) {
  return reports.get(deviceId) || null
}

export function forget(deviceId) {
  reports.delete(deviceId)
}

let notify = null

export default {
  name: 'device',

  capabilities() {
    return { report: true }
  },

  start(bus) {
    notify = () => bus.emit('device.report')
  },

  stop() {
    reports.clear()
    notify = null
  },

  methods: {
    /**
     * `{ battery: { percent, charging }, network: 'wifi'|'cellular'|… }`
     * Every field is optional; an absent one clears rather than freezes.
     */
    'device.report'(params = {}, ctx = {}) {
      const id = ctx.device?.id
      if (!id) throw new Error('not authenticated')

      const battery = params.battery && typeof params.battery === 'object' ? params.battery : null
      const percent = battery ? num(battery.percent, 0, 100) : null

      const report = {
        at: Date.now(),
        battery: percent === null ? null : { percent, charging: battery.charging === true },
        network: typeof params.network === 'string' ? params.network.slice(0, 16) : null,
      }
      reports.set(id, report)
      notify?.()
      return { ok: true }
    },
  },
}
