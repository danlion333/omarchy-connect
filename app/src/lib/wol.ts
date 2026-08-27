/**
 * The shape of a magic packet, and where to aim it.
 *
 * Nothing here touches the network or the platform — it is arithmetic over
 * addresses, which is precisely the part worth having a test for. `api/wake`
 * is the half that opens a socket, and the half no test can run.
 *
 * A magic packet is not a protocol so much as a shape the network card is
 * watching for while the rest of the machine is off: six 0xFF bytes, then the
 * card's own MAC sixteen times over. It is carried by UDP only because UDP is
 * the cheapest way to get a broadcast frame onto the wire — nothing is
 * listening on the port, and nothing answers.
 */

/** What the desktop told us it would need to be woken. */
export type WakeInfo = {
  supported: boolean
  interface: string | null
  type: string
  mac: string | null
  broadcast: string | null
  port: number
  /** Whether the card is set to wake the machine. `null` when it cannot tell. */
  armed: boolean | null
  /** The command that arms it, when it is not armed. */
  command: string | null
  note: string | null
}

/** Port 9 is the convention; 7 costs one more packet and occasionally is the one. */
const FALLBACK_PORT = 7
const DEFAULT_PORT = 9

/** `aa:bb:cc:dd:ee:ff`, `AA-BB-…` or `aabbccddeeff` → six bytes, or nothing. */
export function macBytes(mac: string | null | undefined): Uint8Array | null {
  if (typeof mac !== 'string') return null
  const hex = mac.replace(/[^0-9a-f]/gi, '').toLowerCase()
  if (hex.length !== 12) return null
  const bytes = new Uint8Array(6)
  for (let i = 0; i < 6; i += 1) bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return bytes
}

/** Six 0xFF bytes followed by the MAC sixteen times: 102 bytes, always. */
export function magicPacket(mac: string): Uint8Array {
  const address = macBytes(mac)
  if (!address) throw new Error(`not a MAC address: ${mac}`)
  const packet = new Uint8Array(6 + 16 * 6)
  packet.fill(0xff, 0, 6)
  for (let i = 0; i < 16; i += 1) packet.set(address, 6 + i * 6)
  return packet
}

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/**
 * bytes → base64, by hand, for the same reason `attach.ts` decodes by hand:
 * the packet crosses to Kotlin as a string, and a string is the one argument
 * type nothing about the bridge can be clever with.
 */
export function base64FromBytes(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]
    const b = bytes[i + 1]
    const c = bytes[i + 2]
    out += ALPHABET[a >> 2]
    out += ALPHABET[((a & 3) << 4) | ((b ?? 0) >> 4)]
    out += i + 1 < bytes.length ? ALPHABET[((b & 15) << 2) | ((c ?? 0) >> 6)] : '='
    out += i + 2 < bytes.length ? ALPHABET[c & 63] : '='
  }
  return out
}

/** `192.168.1.42` → `192.168.1.255`, the /24 guess the subnet sweep already makes. */
export function broadcastOf(ip: string | null | undefined): string | null {
  if (typeof ip !== 'string') return null
  const parts = ip.split('.')
  if (parts.length !== 4 || parts.some((p) => !/^\d{1,3}$/.test(p) || Number(p) > 255)) return null
  return `${parts[0]}.${parts[1]}.${parts[2]}.255`
}

/**
 * Everywhere worth aiming the packet, best guess first.
 *
 * The desktop's own broadcast address is the right answer and comes from the
 * desktop itself, netmask and all. The other two are what is left when it is
 * missing or when the desktop moved: the phone's own /24, and the limited
 * broadcast — which some Android builds and some access points drop, which is
 * exactly why it is not the only one tried.
 *
 * Nothing is unicast at the desktop's last address. The machine is asleep, so
 * it answers no ARP request, and a frame the phone cannot address goes nowhere
 * — it would look like an attempt and be none.
 */
export function wakeTargets(wake: WakeInfo | null | undefined, phoneIp: string | null, desktopHost?: string | null) {
  const hosts: string[] = []
  for (const candidate of [wake?.broadcast, broadcastOf(phoneIp), broadcastOf(desktopHost), '255.255.255.255']) {
    if (candidate && !hosts.includes(candidate)) hosts.push(candidate)
  }
  const ports = [wake?.port || DEFAULT_PORT]
  if (!ports.includes(FALLBACK_PORT)) ports.push(FALLBACK_PORT)
  return hosts.flatMap((host) => ports.map((port) => ({ host, port })))
}
