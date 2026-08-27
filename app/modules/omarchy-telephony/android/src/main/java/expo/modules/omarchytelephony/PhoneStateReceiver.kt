package expo.modules.omarchytelephony

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.telephony.TelephonyManager

/**
 * Ringing, answered, over.
 *
 * Android stopped handing out the caller's number to apps without
 * `READ_CALL_LOG` on API 29, and it never sends one for OFFHOOK or IDLE at
 * all. A ringing number is therefore remembered so the "ended" event can still
 * say who the call was with.
 *
 * On anything targeting API 29 or higher — which is every current build — the
 * number is never sent at all, whatever permissions are held. `CallNotifications`
 * reads it off the dialler's own notification instead and calls `identify`,
 * which may land either just before this broadcast or just after it. Both
 * orders are handled: whoever arrives first is used, and a late identification
 * re-announces the ringing call so the desktop can fill in what it was missing.
 *
 * Which way a call went is read off the same three states, because Android
 * offers an ordinary app nothing better: there is no broadcast for "dialling"
 * and no number in any of them. A call that rang before it went off-hook came
 * in; one that went off-hook out of nowhere was placed from this handset.
 */
class PhoneStateReceiver : BroadcastReceiver() {
  companion object {
    @Volatile private var ringingNumber: String? = null
    @Volatile private var ringingName: String? = null
    @Volatile private var lastState: String? = null
    @Volatile private var answered = false
    /**
     * One conversation, one token, carried by every report of it.
     *
     * Ringing, answered and over are three broadcasts about a single call, and
     * the desktop used to write down three lines. It cannot tell them apart by
     * the caller either — the number is in none of them — so all three arrive
     * anonymous and only their timing separates one call from the next. The
     * phone therefore says which call each report is about, and the desktop
     * keeps one line and moves it along.
     */
    @Volatile private var callId: String? = null
    /** "incoming" or "outgoing", once there is enough to say which. */
    @Volatile private var direction: String? = null
    /** When the last ringing event went out, named or not. */
    @Volatile private var announcedAt = 0L
    /** Whether that event carried a name, which is as good as it gets. */
    @Volatile private var namedOut = false

    /**
     * The desktop folds a second report of the same ringing call into the
     * first one, but only for a few seconds after the previous one. Past that
     * window a re-announcement would show up as a second call rather than as
     * the same one, named — so a notification that arrives late is kept for
     * the "ended" event only.
     */
    private const val ENRICH_WINDOW_MS = 5000L

    /** Whether what is held is a name, rather than a number standing in for one. */
    private fun named() = ringingName != null && !Caller.isNumber(ringingName)

    /**
     * A conversation starts: a token the desktop can gather its reports under,
     * and which way it went if that is knowable yet.
     */
    private fun begin(way: String?) {
      callId = java.util.UUID.randomUUID().toString()
      direction = way
    }

    /**
     * Who the dialler says is calling. Called from the notification listener,
     * which runs in this same process but on its own schedule.
     *
     * Diallers commonly post the call notification twice: bare the instant the
     * phone rings, then again a moment later with the contact filled in. Every
     * post therefore gets a hearing, and only one that adds something the
     * desktop has not been told is forwarded — until a name has gone out, past
     * which there is nothing left to improve on.
     */
    @Synchronized
    fun identify(context: Context, name: String?, number: String?) {
      if (name == null && number == null) return
      val hadNumber = ringingNumber
      val hadName = ringingName
      if (number != null && ringingNumber == null) ringingNumber = number
      // A real name displaces a number that was standing in for one. Held
      // rather than waited for, because on a handset with no contact for the
      // caller that first bare post is all there is ever going to be.
      if (name != null && (ringingName == null || Caller.isNumber(ringingName))) ringingName = name
      // A number learned from the notification is a number the broadcast never
      // carried, so this is the first chance the address book has had at it.
      if (!named() && ringingNumber != null) {
        Contacts.nameFor(context, ringingNumber)?.let { ringingName = it }
      }
      if (ringingNumber == hadNumber && ringingName == hadName) return
      if (namedOut) return
      if (lastState != "ringing") return
      if (System.currentTimeMillis() - announcedAt > ENRICH_WINDOW_MS) return
      announcedAt = System.currentTimeMillis()
      namedOut = named()
      OmarchyTelephonyModule.deliver(context, "onCall", ringingEvent())
    }

    private fun ringingEvent() = mapOf(
      "kind" to "call",
      "at" to System.currentTimeMillis(),
      "call" to callId,
      "state" to "ringing",
      "direction" to "incoming",
      "from" to ringingNumber,
      "name" to ringingName,
      "missed" to false,
    )
  }

  override fun onReceive(context: Context, intent: Intent) {
    if (intent.action != TelephonyManager.ACTION_PHONE_STATE_CHANGED) return
    val raw = intent.getStringExtra(TelephonyManager.EXTRA_STATE) ?: return

    val state = when (raw) {
      TelephonyManager.EXTRA_STATE_RINGING -> "ringing"
      TelephonyManager.EXTRA_STATE_OFFHOOK -> "active"
      TelephonyManager.EXTRA_STATE_IDLE -> "ended"
      else -> return
    }
    // The broadcast fires more than once for the same state on some devices.
    if (state == lastState) return
    lastState = state

    if (state == "ringing") {
      begin("incoming")
      announcedAt = System.currentTimeMillis()
      // Empty on every modern build; kept because it costs nothing and is
      // still the most direct answer on the handsets that do send it.
      @Suppress("DEPRECATION")
      val broadcast = intent.getStringExtra(TelephonyManager.EXTRA_INCOMING_NUMBER)?.takeIf { it.isNotBlank() }
      if (broadcast != null) ringingNumber = broadcast
      if (!named()) Contacts.nameFor(context, ringingNumber)?.let { ringingName = it }
      // The listener may already have named the caller before the broadcast
      // arrived, in which case this first event is the named one.
      namedOut = named()
      answered = false
    }
    if (state == "active") {
      // Off-hook with no ring before it is this handset placing the call. The
      // absence of a ring is the whole of the evidence available: no ordinary
      // app is told that a number is being dialled, only that a line is open.
      if (callId == null) begin("outgoing")
      answered = true
    }
    // A process Android started for the IDLE of a call it never saw begin still
    // has a call to report; it just cannot say which way that one went.
    if (state == "ended" && callId == null) begin(null)

    val event = mapOf(
      "kind" to "call",
      "at" to System.currentTimeMillis(),
      "call" to callId,
      "state" to state,
      "direction" to direction,
      "from" to ringingNumber,
      "name" to ringingName,
      // A call that goes straight from ringing to idle was never picked up —
      // which is the one the desktop most wants to tell you about. A call this
      // phone placed and nobody took is not a missed call on this phone.
      "missed" to (state == "ended" && direction == "incoming" && !answered),
    )
    OmarchyTelephonyModule.deliver(context, "onCall", event)

    if (state == "ended") {
      ringingNumber = null
      ringingName = null
      answered = false
      namedOut = false
      announcedAt = 0L
      callId = null
      direction = null
    }
  }
}
