import * as Network from 'expo-network'

import { sendDatagram, datagramsSupported } from '../../modules/omarchy-link'
import { base64FromBytes, macBytes, magicPacket, wakeTargets, type WakeInfo } from '../lib/wol'

/**
 * Waking the desktop.
 *
 * Every other feature in this app is a conversation with a daemon. This one is
 * the opposite: it is used precisely when there is no daemon to talk to, so
 * nothing can be asked at the time — the address, the MAC and the port were
 * handed over at the last `hello` and kept next to the pairing.
 *
 * The packet itself is built in `lib/wol`, where the suite can look at it.
 */

export type { WakeInfo }

/** Sent more than once: a lost broadcast is not retransmitted by anything. */
const REPEATS = 3

/** How long we keep probing for the desktop before admitting it did not come up. */
const WAKE_TIMEOUT_MS = 90_000
const PROBE_EVERY_MS = 2_000

export function canWake(wake: WakeInfo | null | undefined): boolean {
  return datagramsSupported() && Boolean(macBytes(wake?.mac))
}

/**
 * Puts the packet on the wire. Answers with how many datagrams actually left,
 * because "sent" is the strongest word available here — UDP is not
 * acknowledged, a sleeping machine says nothing, and the only real proof is
 * the daemon answering again a minute later.
 */
export async function sendWakePacket(wake: WakeInfo, desktopHost?: string | null): Promise<number> {
  if (!wake?.mac) throw new Error('this desktop never told the app which card to wake')
  if (!datagramsSupported()) {
    throw new Error('waking a desktop needs the Android app — nothing in Expo Go or on iOS can send this packet')
  }

  const payload = base64FromBytes(magicPacket(wake.mac))
  const phoneIp = await Network.getIpAddressAsync().catch(() => null)
  const targets = wakeTargets(wake, phoneIp, desktopHost)

  let sent = 0
  for (let round = 0; round < REPEATS; round += 1) {
    for (const target of targets) {
      try {
        await sendDatagram(payload, target.host, target.port)
        sent += 1
      } catch {
        // One address the phone's network refuses to broadcast on must not
        // stop the others — the whole point of the list is that no single
        // one of them is reliable everywhere.
      }
    }
  }
  if (!sent) throw new Error('the phone could not put a packet on the network')
  return sent
}

/**
 * Waits for the desktop to answer again.
 *
 * A machine coming out of suspend is on the network in a couple of seconds; one
 * coming up from off takes the better part of a minute, and the daemon starts
 * with the graphical session rather than with the kernel. So this is patient,
 * and it gives up out loud rather than leaving a spinner running for ever.
 */
export async function waitForDesktop(
  probe: () => Promise<unknown | null>,
  timeoutMs = WAKE_TIMEOUT_MS,
  every = PROBE_EVERY_MS,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await probe().catch(() => null)) return true
    await new Promise((resolve) => setTimeout(resolve, every))
  }
  return false
}
