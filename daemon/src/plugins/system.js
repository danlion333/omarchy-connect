import * as sys from '../lib/sys.js'
import { readTheme, watchTheme } from '../lib/theme.js'

const TICK_MS = 1000
const LATENCY_EVERY = 10 // ticks

let timer = null
let stopThemeWatch = null
let ticks = 0

async function snapshot() {
  const [network, disk] = await Promise.all([sys.network(), sys.disk()])
  return {
    at: Date.now(),
    cpu: { usage: sys.cpuUsage(), tempC: sys.cpuTemp(), loadavg: sys.host().loadavg },
    memory: sys.memory(),
    disk,
    battery: sys.battery(),
    network: { ...network, ...sys.lastLatency() },
    uptime: Math.round(process.uptime() > 0 ? sys.host().uptime : 0),
  }
}

export default {
  name: 'system',

  capabilities() {
    return { stats: true, theme: true }
  },

  start(bus) {
    sys.cpuUsage() // prime the CPU delta so the first tick is meaningful
    sys.refreshLatency()

    timer = setInterval(async () => {
      // Nobody is watching: skip the work entirely.
      if (!bus.hasSubscribers('stats')) return
      ticks += 1
      if (ticks % LATENCY_EVERY === 1) sys.refreshLatency()
      try {
        bus.emit('event', 'stats', await snapshot())
      } catch {
        /* a transient /proc read failure must not kill the loop */
      }
    }, TICK_MS)
    timer.unref?.()

    stopThemeWatch = watchTheme((theme) => bus.emit('event', 'theme', theme))
  },

  stop() {
    clearInterval(timer)
    timer = null
    stopThemeWatch?.()
    stopThemeWatch = null
  },

  methods: {
    'system.stats': () => snapshot(),
    'system.info': () => ({ host: sys.host(), theme: readTheme() }),
    'system.theme': () => readTheme(),
  },
}
