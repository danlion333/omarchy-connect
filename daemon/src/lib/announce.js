import dgram from 'node:dgram'

/**
 * The desktop saying "I am back" out loud, once, to nobody in particular.
 *
 * The problem this exists for is entirely on the other side of the wire. A
 * phone that cannot reach its desktop climbs a backoff ladder to two minutes
 * and then knocks on that rung forever — but the timers doing the knocking are
 * `setTimeout`s inside a headless task on a phone that holds no wake lock, so
 * on a sleeping handset the "two minutes" is however long it is until
 * something else wakes the phone up. Meanwhile the desktop, which knows
 * exactly when it came back, says nothing at all.
 *
 * It cannot say anything to the phone in particular: the paired-device record
 * holds an id, a name and a token and no address of any kind, and by design —
 * see `server.js`, where the phone is always the side that dials. What is left
 * is the one address that needs no knowledge of who is listening, which is the
 * subnet's own broadcast address.
 *
 * So: one short burst of UDP on the wire when the daemon starts, and nothing
 * else, ever. It is a nudge and not a beacon — a phone that missed it is
 * exactly where it was before, on its own ladder — and it is a nudge and not a
 * credential: everything in it is already served unauthenticated at
 * `/api/info`, and the phone's decision about who to trust is still made by
 * the pinned key and the handshake. Anyone on the subnet can forge this
 * packet; the worst they achieve is a phone dialling the desktop it already
 * wanted to dial.
 */

/**
 * Where the phone listens. 8766 is the daemon's own port plus one, which is
 * where anyone looking for it would look.
 */
export const ANNOUNCE_PORT = 8766

/** What the packet is, so a listener can drop everything else in one line. */
export const ANNOUNCE_APP = 'omarchy-connect'
export const ANNOUNCE_KIND = 'desktop-up'

/**
 * Three packets over four seconds rather than one.
 *
 * UDP loses packets, a Wi-Fi radio in power save loses more of them than that,
 * and the whole point of this is the one moment it is sent. Three is enough to
 * cover a lost frame and few enough that a listener debouncing them sees one
 * event. The last one is late on purpose: the desktop's own Wi-Fi may still be
 * associating when the daemon's socket is already open.
 */
export const ANNOUNCE_BURST_MS = [0, 1200, 4000]

/**
 * Everything the packet says, and nothing else.
 *
 * Deliberately the same facts `/api/info` gives away to an unauthenticated
 * GET: a name, a version, an address, the identity key. No device token, no
 * local secret, nothing that a pairing rests on — a broadcast frame is read by
 * every machine on the subnet, and a secret on one is a secret no longer.
 *
 * The key is here because it is what makes the packet *ignorable*: a phone
 * holding a pinned key can drop a stranger's announcement without opening a
 * socket to find out. It is not what makes the packet trusted.
 */
export function announcement({ protocol, version, name, host, port, publicKey, fingerprint }) {
  return {
    app: ANNOUNCE_APP,
    t: ANNOUNCE_KIND,
    protocol: protocol ?? null,
    version: version ?? null,
    name: name ?? null,
    host: host ?? null,
    port: port ?? null,
    publicKey: publicKey ?? null,
    fingerprint: fingerprint ?? null,
  }
}

/**
 * A socket that exists only for the burst, and is closed the moment the
 * daemon is.
 *
 * `stop()` is not housekeeping. The burst is spread over four seconds, and a
 * daemon told to stop within those four seconds must not go on announcing
 * itself as a desktop that is up — so the pending sends are cancelled with the
 * same call that closes the listener.
 */
export function createAnnouncer({ port = ANNOUNCE_PORT, schedule = ANNOUNCE_BURST_MS } = {}) {
  let socket = null
  let ready = null
  let timers = new Set()
  let sent = 0

  function open() {
    if (socket) return
    const created = dgram.createSocket({ type: 'udp4', reuseAddr: true })
    // A datagram socket with no reader is a socket nothing recovers from by
    // itself; losing the announcement is survivable and taking the daemon
    // down with it is not.
    created.on('error', () => close())
    ready = new Promise((resolve) => {
      created.bind(() => {
        try {
          created.setBroadcast(true)
        } catch {
          /* a kernel that refuses this simply never delivers the packet */
        }
        resolve()
      })
    })
    // Nothing here should keep the process alive on its own account: the
    // daemon's listener is what holds the loop open, and when that goes this
    // has no business outliving it.
    created.unref()
    socket = created
  }

  function close() {
    for (const timer of timers) clearTimeout(timer)
    timers.clear()
    const open = socket
    socket = null
    ready = null
    if (!open) return
    try {
      open.close()
    } catch {
      /* already closed, or never bound */
    }
  }

  return {
    /** How many datagrams actually left, for a test and for a log line. */
    get sent() {
      return sent
    },
    get live() {
      return socket !== null
    },
    /**
     * One burst at `target`, which is a broadcast address every time it is
     * not a test. Answers with how many packets were scheduled.
     */
    announce(body, target) {
      if (!target) return 0
      const bytes = Buffer.from(JSON.stringify(body))
      open()
      const waiting = ready
      for (const delay of schedule) {
        const fire = () => {
          timers.delete(timer)
          // Between the timer being set and it firing the daemon may have
          // stopped, which is the whole reason `stop()` exists.
          const live = socket
          if (!live) return
          waiting?.then(() => {
            if (socket !== live) return
            live.send(bytes, 0, bytes.length, port, target, (error) => {
              if (!error) sent += 1
            })
          })
        }
        const timer = setTimeout(fire, delay)
        timer.unref?.()
        timers.add(timer)
      }
      return schedule.length
    },
    stop: close,
  }
}
