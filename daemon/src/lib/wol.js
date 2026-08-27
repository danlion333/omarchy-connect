import fs from 'node:fs'
import path from 'node:path'
import { run, has } from './exec.js'

/**
 * What a phone needs in order to wake this desktop, and whether waking it
 * would in fact work.
 *
 * Wake-on-LAN is the one feature whose whole point is that the daemon is not
 * running when it is used, so nothing here can be asked at the moment it
 * matters. The address and the MAC are handed to the phone during the
 * handshake instead, while the desktop is still awake, and the phone keeps
 * them next to the pairing.
 *
 * Everything below reads state that needs no privileges and changes nothing.
 * Arming a network card to wake a machine is the user's call, exactly as
 * opening a firewall port is — see `firewall.js`, which this follows.
 */

const netBase = '/sys/class/net'
/** Port 9, the discard service, is where a magic packet is conventionally sent. */
export const WAKE_PORT = 9

/**
 * Whether the card is allowed to wake the machine.
 *
 * `ethtool <iface>` is the usual way to ask, and it is the wrong one here:
 * reading the wake-on-lan word is `ETHTOOL_GWOL`, which the kernel gates on
 * `CAP_NET_ADMIN`, so a daemon running as you gets "Operation not permitted"
 * rather than an answer. The sysfs flag beneath the device is world-readable
 * and says the same thing from the other side: a driver that accepts `wol g`
 * calls `device_set_wakeup_enable()`, which is precisely this file.
 *
 * `null` means the question has no answer here — a USB or virtual adapter has
 * no `device/power/wakeup` at all, and reporting that as "off" would send the
 * user chasing a setting that does not exist.
 */
export function armed(name) {
  if (!name) return null
  try {
    const value = fs.readFileSync(path.join(netBase, name, 'device', 'power', 'wakeup'), 'utf8').trim()
    return value === 'enabled'
  } catch {
    return null
  }
}

/**
 * The NetworkManager connection carrying an interface, so the advice we print
 * names the profile the user actually has rather than a placeholder. Cached
 * per interface: a connection is not renamed mid-session, and this is a
 * subprocess on a path that otherwise touches nothing.
 */
const connectionCache = new Map()

async function connectionFor(name) {
  if (!name || !has('nmcli')) return null
  if (connectionCache.has(name)) return connectionCache.get(name)
  const res = await run('nmcli', ['-t', '-f', 'NAME,DEVICE', 'connection', 'show', '--active'])
  let found = null
  if (res.ok) {
    for (const line of res.stdout.split('\n')) {
      // `-t` escapes a literal colon in a name as `\:`, so split on the last
      // unescaped one rather than the first of any kind.
      const at = line.lastIndexOf(':')
      if (at < 0) continue
      if (line.slice(at + 1) === name) {
        found = line.slice(0, at).replace(/\\:/g, ':')
        break
      }
    }
  }
  connectionCache.set(name, found)
  return found
}

/**
 * How to arm this interface, and to make it stay armed.
 *
 * NetworkManager is the road worth recommending on Omarchy: it re-applies the
 * setting every time the link comes up, which `ethtool -s` on its own does not
 * — that lasts until the next reboot and then quietly stops working, which is
 * the worst possible failure for something you only find out about from the
 * sofa.
 */
function armCommand(name, connection) {
  if (!name) return null
  if (connection) return `nmcli connection modify ${JSON.stringify(connection)} 802-3-ethernet.wake-on-lan magic`
  if (has('ethtool')) return `sudo ethtool -s ${name} wol g`
  return `sudo pacman -S ethtool && sudo ethtool -s ${name} wol g`
}

/**
 * The wake description handed to the phone at `hello` and published in the
 * status file.
 *
 * `net` is a `sys.network()` snapshot — the interface has already been chosen
 * there, and choosing it twice by two different rules is how the phone ends up
 * addressing a packet at a card the desktop does not listen on.
 */
export async function check(net) {
  const name = net?.interface ?? null
  const mac = net?.mac ?? null
  const broadcast = net?.broadcast ?? null
  const type = net?.type ?? 'offline'

  if (!name || !mac) {
    return {
      supported: false,
      interface: name,
      type,
      mac: null,
      broadcast: null,
      port: WAKE_PORT,
      armed: null,
      command: null,
      note: 'no network interface this desktop could be woken on',
    }
  }

  const connection = await connectionFor(name)
  const state = armed(name)

  return {
    // A phone can send the packet whether or not the card is armed — and
    // should be allowed to, because the sysfs flag is a good answer rather
    // than a certain one, and a BIOS is the half nothing here can see.
    supported: true,
    interface: name,
    type,
    mac,
    broadcast,
    port: WAKE_PORT,
    armed: state,
    command: state === true ? null : armCommand(name, connection),
    note:
      type === 'wifi'
        ? 'this desktop is on Wi-Fi, and few cards wake from a magic packet over it — a wired link is what this feature is for'
        : state === false
          ? 'this desktop\'s network card is not set to wake it'
          : null,
  }
}

/** Forget the cached NetworkManager lookup — the CLI runs once and exits. */
export function reset() {
  connectionCache.clear()
}
