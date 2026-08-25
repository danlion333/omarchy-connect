import * as Battery from 'expo-battery'
import * as Network from 'expo-network'

import type { ConnectClient } from './client.ts'

/**
 * What the phone volunteers about itself.
 *
 * The desktop streams its own vitals down to us; this is the return leg, and
 * it exists so the Omarchy bar client can say "72%, charging" instead of "--".
 * It is deliberately thin: a battery level, whether it is charging, and how the
 * phone is on the network. Nothing is stored on the desktop beyond the life of
 * the daemon, and the report is only sent to a desktop that says it wants one.
 */
const REPORT_EVERY = 5 * 60 * 1000

type Report = {
  battery: { percent: number; charging: boolean } | null
  network: string | null
}

const CHARGING_STATES = [Battery.BatteryState.CHARGING, Battery.BatteryState.FULL]

async function collect(): Promise<Report> {
  let battery: Report['battery'] = null
  try {
    const power = await Battery.getPowerStateAsync()
    if (power.batteryLevel >= 0) {
      battery = {
        percent: Math.round(power.batteryLevel * 100),
        charging: CHARGING_STATES.includes(power.batteryState),
      }
    }
  } catch {
    // A simulator, or a platform that will not say. The desktop shows "--".
  }

  let network: string | null = null
  try {
    network = (await Network.getNetworkStateAsync()).type ?? null
  } catch {
    /* same */
  }

  return { battery, network }
}

/**
 * Reports once now, again whenever the battery moves, and on a slow timer so a
 * phone sitting still does not go stale. Returns a stop function.
 */
export function startReporting(client: ConnectClient): () => void {
  let stopped = false
  let inFlight = false

  const push = async () => {
    if (stopped || inFlight || client.status !== 'connected') return
    inFlight = true
    try {
      await client.call('device.report', await collect())
    } catch {
      // Losing a telemetry report is not worth surfacing anywhere — the next
      // battery tick or the timer will carry the same numbers.
    } finally {
      inFlight = false
    }
  }

  void push()

  const subscriptions = [
    Battery.addBatteryLevelListener(() => void push()),
    Battery.addBatteryStateListener(() => void push()),
  ]
  const timer = setInterval(() => void push(), REPORT_EVERY)

  return () => {
    stopped = true
    clearInterval(timer)
    subscriptions.forEach((sub) => sub.remove())
  }
}
