/**
 * What the phone does about a desktop shouting "I am up" on the subnet.
 *
 * The desktop broadcasts one short burst when its daemon starts — see the
 * daemon's `lib/announce` for why it has to be a broadcast and not a message
 * addressed to this handset. The phone's own retry ladder tops out at two
 * minutes and then knocks on that rung forever, and on a sleeping phone even
 * that is a fiction: the timers are `setTimeout`s in a headless task holding
 * no wake lock, so the next attempt happens whenever something else wakes the
 * phone. The announcement is what makes the desktop's start-up be that
 * something.
 *
 * Everything here is the part that needs no socket and no Android: which
 * packets are worth acting on. It is deliberately a pure function of the
 * packet and what the phone already knows, because the whole risk of this
 * feature lives in that decision — a broadcast frame can be forged by anyone
 * on the network, and the answer to a forged one must be "nothing happened".
 *
 * Note what acting on it *is*: `reconnectNow(true)`, and nothing else. The
 * packet is never a reason to trust an address, a key or a certificate. The
 * phone dials the desktop it already pinned, over the endpoints it already
 * has, and `isOurDesktop` decides who is on the other end exactly as before.
 * The worst a stranger achieves by forging one is that the phone tries the
 * desktop it wanted to reach anyway.
 */

/** Where the phone listens. Mirrors `ANNOUNCE_PORT` in the daemon. */
export const ANNOUNCE_PORT = 8766

const ANNOUNCE_APP = 'omarchy-connect'
const ANNOUNCE_KIND = 'desktop-up'

/**
 * The packet as it arrives, plus `from` — the source address the native
 * receiver read off the datagram, which is not in the payload and cannot be
 * written by whoever composed it.
 */
export type DesktopAnnouncement = {
  app?: string | null
  t?: string | null
  protocol?: number | null
  version?: string | null
  name?: string | null
  host?: string | null
  port?: number | null
  publicKey?: string | null
  fingerprint?: string | null
  from?: string | null
}

/** What the phone knows about the desktop it is paired with, right now. */
export type LinkFacts = {
  /** The identity key pinned at pairing, as hex, or `null` when unpaired. */
  publicKey: string | null
  /** Whatever the socket is doing — `connected` means there is nothing to do. */
  status: string
}

/**
 * Whether this packet is reason enough to dial right now.
 *
 * Four ways to be ignored, and each of them is a case that happened to
 * somebody:
 *
 *   - **Not ours to read.** Anything on the port that is not this app's
 *     announcement, including the noise a busy subnet puts on any UDP port.
 *   - **Nobody to dial.** A phone with no pinned key has not paired, and there
 *     is no desktop for it to come back to.
 *   - **Somebody else's desktop.** Two Omarchy boxes on one network is a
 *     normal thing to have, and the flatmate's daemon restarting is not this
 *     phone's business. The key in the packet is a filter and not a
 *     credential: it saves a socket, it does not grant one.
 *   - **Already there.** The link is up; the announcement is stale news, and
 *     a redial would be dropping a working socket for a hope. This is the
 *     cautious half of the open question in the issue — the packet is heard
 *     only while the link is down.
 */
export function shouldRedial(packet: unknown, facts: LinkFacts): boolean {
  const announce = packet as DesktopAnnouncement | null
  if (!announce || typeof announce !== 'object') return false
  if (announce.app !== ANNOUNCE_APP || announce.t !== ANNOUNCE_KIND) return false
  if (!facts.publicKey) return false
  if (typeof announce.publicKey !== 'string' || announce.publicKey !== facts.publicKey) return false
  return facts.status !== 'connected'
}
