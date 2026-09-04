package expo.modules.omarchylink

import android.content.Context
import android.net.wifi.WifiManager
import android.os.PowerManager
import org.json.JSONObject
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetSocketAddress

/**
 * Listening for the desktop saying it is back.
 *
 * The phone's reconnect ladder tops out at two minutes and then knocks on that
 * rung forever — but the ladder is `setTimeout`s inside a headless task, and
 * `LinkService` deliberately holds no wake lock, so on a sleeping handset the
 * next knock happens whenever something else wakes the phone. Turning the
 * desktop on in the morning is not one of those somethings, which is the whole
 * of the bug: the desktop has been up for a quarter of an hour and the phone
 * has not noticed.
 *
 * The desktop cannot ring this phone. It holds an id, a name and a token for
 * it and no address of any kind — by design; the phone is always the side that
 * dials. What it can do is put one short burst of UDP on the subnet's
 * broadcast address when its daemon starts, which is what this reads.
 *
 * Three things make that work on a phone that is asleep, and all three are
 * needed:
 *
 *   - **Somewhere to receive it.** A blocking `receive()` on a thread of the
 *     foreground service. The service is what keeps the process alive; the
 *     thread costs nothing while no packet is arriving.
 *   - **A radio that will deliver it.** Wi-Fi filters out frames not addressed
 *     to this device when it is in power save, and a subnet broadcast is
 *     exactly such a frame. A `MulticastLock` is what turns that filter off;
 *     it is famously named for multicast and has always covered broadcast too.
 *   - **A CPU awake long enough to act.** The packet arriving wakes the
 *     processor for as long as it takes to hand it over and no longer, and
 *     "act" here means a TCP connect and a TLS handshake. So a wake lock is
 *     taken — but a timed one, held for seconds around one announcement, which
 *     is a different thing from the untimed lock `LinkService` refuses to hold
 *     for the life of the link.
 *
 * The packet is a hint and never a credential. Everything in it is what the
 * daemon already gives away to an unauthenticated `GET /api/info`, the key in
 * it is used as a filter and not as proof, and all this asks JavaScript for is
 * a redial of the desktop it already pinned. Anyone on the subnet can forge
 * one; the worst they achieve is the phone dialling the desktop it wanted.
 */
object Announce {
  /** Mirrors `ANNOUNCE_PORT` in the daemon's `lib/announce`. */
  const val PORT = 8766

  private const val APP = "omarchy-connect"
  private const val KIND = "desktop-up"

  /** Nothing this app is interested in is larger; a truncated read is a drop. */
  private const val MAX = 2048

  /**
   * The desktop sends three packets so that one lost frame does not lose the
   * announcement. This is the other end of that: one event out of a burst.
   */
  private const val DEBOUNCE_MS = 8_000L

  /**
   * Long enough for a redial to get through a connect and a handshake, short
   * enough that a subnet full of forged packets cannot hold the phone awake.
   */
  private const val WAKE_MS = 20_000L

  @Volatile
  private var thread: Thread? = null

  @Volatile
  private var socket: DatagramSocket? = null

  private var lock: WifiManager.MulticastLock? = null

  @Volatile
  private var lastAt = 0L

  /** Whether anything is listening, for the log line and for a test to ask. */
  val listening: Boolean
    get() = thread != null

  @Synchronized
  fun start(context: Context) {
    if (thread != null) return
    val app = context.applicationContext
    val bound = try {
      // `reuseAddress` before `bind`, so a service restarted into a process
      // whose old socket is still in TIME_WAIT comes back rather than giving
      // up on the feature until the next reboot.
      DatagramSocket(null).apply {
        reuseAddress = true
        broadcast = true
        bind(InetSocketAddress(PORT))
      }
    } catch (error: Exception) {
      // Another app on the port, or a policy that refuses the bind. The link
      // works exactly as it did before this existed, which is why this is a
      // warning and not a failure.
      Trace.warn("announce.bind.failed", "port" to PORT, "error" to error.javaClass.simpleName)
      return
    }
    socket = bound
    acquireLock(app)
    val worker = Thread({ listen(app, bound) }, "omarchy-announce")
    worker.isDaemon = true
    thread = worker
    worker.start()
    Trace.evt("announce.listening", "port" to PORT, "lock" to (lock?.isHeld == true))
  }

  @Synchronized
  fun stop() {
    val open = socket
    socket = null
    thread = null
    // Closing the socket is how the blocking receive is interrupted; the
    // thread falls out of its loop on the next line after that.
    try {
      open?.close()
    } catch (error: Exception) {
      /* already closed */
    }
    releaseLock()
    Trace.evt("announce.stopped")
  }

  private fun listen(context: Context, bound: DatagramSocket) {
    val buffer = ByteArray(MAX)
    while (true) {
      val packet = DatagramPacket(buffer, buffer.size)
      try {
        bound.receive(packet)
      } catch (error: Exception) {
        // The ordinary end of this thread: `stop()` closed the socket under
        // it. Anything else is worth a line, because a receive loop that has
        // quietly died looks exactly like a desktop that never announced.
        if (socket === bound) Trace.warn("announce.receive.failed", "error" to error.javaClass.simpleName)
        return
      }
      try {
        handle(context, packet)
      } catch (error: Exception) {
        Trace.warn("announce.handle.failed", "error" to error.javaClass.simpleName)
      }
    }
  }

  private fun handle(context: Context, packet: DatagramPacket) {
    val text = String(packet.data, packet.offset, packet.length, Charsets.UTF_8)
    val body = try {
      JSONObject(text)
    } catch (error: Exception) {
      // A UDP port on a busy subnet hears all sorts of things. Not news.
      Trace.detail("announce.ignored", "reason" to "unparseable")
      return
    }
    if (body.optString("app") != APP || body.optString("t") != KIND) {
      Trace.detail("announce.ignored", "reason" to "not-ours")
      return
    }
    val now = System.currentTimeMillis()
    if (now - lastAt < DEBOUNCE_MS) {
      Trace.detail("announce.ignored", "reason" to "debounced")
      return
    }
    lastAt = now

    val from = packet.address?.hostAddress
    // The address is logged, the key is not: it identifies a desktop, and this
    // log is read off a phone somebody else may be holding.
    Trace.evt("announce.heard", "from" to Trace.mark(from), "port" to body.optInt("port", 0))

    // The CPU is awake because a packet arrived, and stays awake exactly that
    // long unless somebody says otherwise. Redialling is a connect and a
    // handshake, so this says otherwise — for twenty seconds, on its own
    // timeout, whatever happens next.
    hold(context)

    // Nothing is written down for later, and nothing should be: an
    // announcement is only worth acting on in the seconds after it arrives,
    // and a phone whose runtime is gone has no link to bring back — the
    // service starting one is what would deliver the next announcement anyway.
    LinkActionReceiver.listener?.let { emit ->
      emit(
        "onDesktopAnnounce",
        mapOf(
          "app" to body.optString("app"),
          "t" to body.optString("t"),
          "name" to body.optString("name").ifBlank { null },
          "host" to body.optString("host").ifBlank { null },
          "port" to body.optInt("port", 0).takeIf { it > 0 },
          "publicKey" to body.optString("publicKey").ifBlank { null },
          "fingerprint" to body.optString("fingerprint").ifBlank { null },
          "protocol" to body.optInt("protocol", 0).takeIf { it > 0 },
          "version" to body.optString("version").ifBlank { null },
          "from" to from,
        ),
      )
    } ?: Trace.detail("announce.parked", "reason" to "no-runtime")
  }

  /** A short, self-releasing hold on the processor. Never an untimed one. */
  private fun hold(context: Context) {
    val power = context.getSystemService(PowerManager::class.java) ?: return
    try {
      val wake = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "omarchy:announce")
      wake.setReferenceCounted(false)
      wake.acquire(WAKE_MS)
    } catch (error: Exception) {
      // Without it the redial may not finish before the phone sleeps again,
      // which is the old behaviour rather than a new failure.
      Trace.warn("announce.wakelock.failed", "error" to error.javaClass.simpleName)
    }
  }

  private fun acquireLock(context: Context) {
    if (lock != null) return
    try {
      val wifi = context.getSystemService(WifiManager::class.java) ?: return
      val held = wifi.createMulticastLock("omarchy-announce")
      held.setReferenceCounted(false)
      held.acquire()
      lock = held
    } catch (error: Exception) {
      // Some devices deliver subnet broadcasts without it. The listener is
      // still worth running: it costs nothing and it works on the ones that do.
      Trace.warn("announce.lock.failed", "error" to error.javaClass.simpleName)
    }
  }

  private fun releaseLock() {
    val held = lock ?: return
    lock = null
    try {
      if (held.isHeld) held.release()
    } catch (error: Exception) {
      /* released under us, or never really held */
    }
  }
}
