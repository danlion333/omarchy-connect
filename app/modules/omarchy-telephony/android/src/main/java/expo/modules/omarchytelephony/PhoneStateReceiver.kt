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
 *
 * None of that state survives the process it is held in, and Android ends
 * this process whenever it wants the memory — often in the middle of a call,
 * starting it again a minute later purely to deliver the `IDLE`. So the call
 * in hand is written to disk as it moves ([LiveCall]) and picked back up by
 * whoever wakes next; and when the ending arrives with nobody named after all,
 * the phone's own call log is asked ([LastCall]). What used to happen instead
 * was a fresh token minted for the ending alone, and a conversation the
 * desktop had been following all along finishing as a blank second line.
 *
 * The same silence is why a call this phone placed needs `timed`. Off-hook on
 * an outgoing call is the moment of dialling, and nothing is ever broadcast
 * for the moment the far end picks up — so a desktop counting from off-hook
 * counts the ringing as conversation and runs a ring cycle ahead of the timer
 * on the handset's own screen. `CallNotifications` reads the real answer off
 * the dialler's card, the same place it reads the caller's name.
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
    /** When this handset went off-hook — the earliest a conversation can start. */
    @Volatile private var offHookAt = 0L
    /** The base of the dialler's own call timer, once its card shows one. */
    @Volatile private var chronometer = 0L
    /** Whether that event carried a name, which is as good as it gets. */
    @Volatile private var namedOut = false

    /**
     * Whether this process has already looked on disk for a call in progress.
     *
     * Everything above is process memory, and Android ends this process
     * whenever it likes — including in the middle of a conversation, starting
     * it again a minute later for nothing but the `IDLE` broadcast. The first
     * thing that touches the call state in a new process therefore reads
     * [LiveCall] first; after that the fields are the truth and the disk is
     * only their copy.
     */
    @Volatile private var loaded = false

    /**
     * The desktop folds a second report of the same ringing call into the
     * first one, but only for a few seconds after the previous one. Past that
     * window a re-announcement would show up as a second call rather than as
     * the same one, named — so a notification that arrives late is kept for
     * the "ended" event only.
     */
    private const val ENRICH_WINDOW_MS = 5000L

    /**
     * How far the dialler's clock and the telephony broadcast are allowed to
     * disagree before the first is disbelieved. They are two readings of the
     * same `System.currentTimeMillis()`, taken a few hundred milliseconds
     * apart at most; a ring cycle is never inside this.
     */
    private const val CLOCK_SLACK_MS = 2000L

    /** Whether what is held is a name, rather than a number standing in for one. */
    private fun named() = ringingName != null && !Caller.isNumber(ringingName)

    /**
     * A conversation starts: a token the desktop can gather its reports under,
     * and which way it went if that is knowable yet.
     */
    private fun begin(way: String?) {
      callId = java.util.UUID.randomUUID().toString()
      direction = way
      offHookAt = 0L
      chronometer = 0L
    }

    /**
     * Pick the conversation back up, if this process was started in the middle
     * of one somebody else's process began.
     *
     * Runs once per process, from the broadcast and from nowhere else, and
     * never for a call that is beginning: a record on disk when the phone
     * starts ringing belongs to an older call, and [forget] drops it. What is
     * left is the case this exists for — an `OFFHOOK` or an `IDLE` about a
     * call this process never saw begin.
     *
     * It is deliberately not consulted by [identify] or [timed]. Those two are
     * the dialler's notification, and the notification road has its own race
     * with the broadcast: a card that arrives before the phone-state change is
     * how a caller gets named at all. Letting it merge into a record left over
     * from an earlier call would put the wrong person on this one, and the
     * name it carries is written down by the broadcast a moment later anyway.
     *
     * `announcedAt` deliberately does not come back. It is the age of the
     * ringing report *the desktop was sent*, and this process sent nothing —
     * so a name arriving now is past the enrichment window by definition and
     * belongs to the ending, which is exactly what leaving it at zero says.
     */
    private fun restore(context: Context) {
      if (loaded) return
      loaded = true
      val held = LiveCall.read(context.applicationContext) ?: return
      callId = held.callId
      direction = held.direction
      ringingNumber = held.from
      ringingName = held.name
      lastState = held.state
      answered = held.answered
      namedOut = held.namedOut
      offHookAt = held.offHookAt
      chronometer = held.chronometer
      // The token cannot be compared against the last process's logs — the
      // digest salt is drawn per process on purpose — so what this line is for
      // is the fact of the recovery and what came back with it. The desktop is
      // where the two halves of the call meet under one real token.
      Trace.evt(
        "call.restored",
        "call" to Trace.mark(callId),
        "state" to lastState,
        "direction" to direction,
        "named" to named(),
        "ageMs" to (System.currentTimeMillis() - held.savedAt),
      )
    }

    /**
     * Drop whatever is on disk, and stop this process from looking again.
     *
     * A record still there when the next call starts means an ending that was
     * never seen — the process was killed and Android never started it again
     * for the `IDLE`. Worth a line: it is the one way a conversation can go
     * unclosed on the desktop.
     */
    private fun forget(context: Context) {
      if (!loaded) {
        loaded = true
        if (LiveCall.read(context.applicationContext) != null) Trace.warn("call.hold.abandoned")
      }
      LiveCall.clear(context.applicationContext)
    }

    /** Put the call in hand back on disk, wherever it has got to. */
    private fun remember(context: Context) {
      val id = callId ?: return
      LiveCall.save(
        context.applicationContext,
        LiveCall.Held(
          callId = id,
          direction = direction,
          from = ringingNumber,
          name = ringingName,
          state = lastState,
          answered = answered,
          namedOut = namedOut,
          offHookAt = offHookAt,
          chronometer = chronometer,
          savedAt = 0L,
        ),
      )
    }

    /**
     * When the conversation began, as the handset itself has it — or null,
     * when nothing trustworthy has said.
     *
     * The dialler puts an ongoing-call card up with a running chronometer, and
     * that chronometer's base is the moment the call connected: the number on
     * the phone's own screen, in a field a notification listener may read. It
     * is checked rather than believed. A conversation cannot have begun before
     * the line opened, which is what stops the card the dialler raised while
     * the phone was still ringing — stamped with the moment the ringing
     * started — from being read as an answer.
     */
    private fun connectedAt(): Long? {
      val at = chronometer
      if (at <= 0L || offHookAt <= 0L) return null
      if (at < offHookAt - CLOCK_SLACK_MS) return null
      if (at > System.currentTimeMillis() + CLOCK_SLACK_MS) return null
      return at
    }

    /**
     * The dialler's card says when the talking started. Called from the
     * notification listener, and on an outgoing call it is the only report
     * that can say this at all.
     *
     * A card is reposted many times over one call, always with the same base,
     * so only a base that is new is worth a word to the desktop. And only once
     * the line is off-hook: before that the broadcast has not gone out yet,
     * and the one that is about to will carry this with it.
     */
    @Synchronized
    fun timed(context: Context, at: Long) {
      if (at <= 0L || at == chronometer) return
      chronometer = at
      // Held before the two refusals below: a card that is rejected as a
      // report to the desktop is still the best reading of this call's clock
      // there will ever be, and the process may not live to be asked again.
      remember(context)
      // Both refusals below are the guard working as designed — a card raised
      // while the phone was still ringing, or one arriving before the
      // broadcast — and both look from the desktop like a call whose timer
      // simply never started. Saying which is which is the whole point.
      if (connectedAt() == null) {
        Trace.detail("call.timed.rejected", "reason" to "before-offhook", "offHook" to (offHookAt > 0L))
        return
      }
      if (lastState != "active") {
        Trace.detail("call.timed.rejected", "reason" to "not-active", "state" to lastState)
        return
      }
      Trace.evt("call.timed", "call" to Trace.mark(callId), "since" to (at - offHookAt))
      OmarchyTelephonyModule.deliver(context, "onCall", callEvent("active"))
    }

    /** One report of the call in hand, in whatever state it has reached. */
    private fun callEvent(state: String) = mapOf(
      "kind" to "call",
      "at" to System.currentTimeMillis(),
      "call" to callId,
      "state" to state,
      "direction" to direction,
      "from" to ringingNumber,
      "name" to ringingName,
      // The handset's own clock, when it has one to give. The desktop counts
      // from its own arrival without it, which on an outgoing call is early by
      // however long the far end rang.
      "startedAt" to connectedAt(),
      // A call that goes straight from ringing to idle was never picked up —
      // which is the one the desktop most wants to tell you about. A call this
      // phone placed and nobody took is not a missed call on this phone.
      "missed" to (state == "ended" && direction == "incoming" && !answered),
    )

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
      // Who is calling is the one thing the ending most needs and is least
      // able to work out for itself, so it goes to disk the moment it is
      // learned — before any of the reasons below to say nothing about it.
      remember(context)
      // Four ways to learn nothing new, and a desktop showing a number where a
      // name should be has hit exactly one of them. Which one it was is not
      // recoverable after the fact from anywhere else.
      if (ringingNumber == hadNumber && ringingName == hadName) {
        Trace.detail("call.identify.skipped", "reason" to "nothing-new")
        return
      }
      if (namedOut) {
        Trace.detail("call.identify.skipped", "reason" to "already-named")
        return
      }
      if (lastState != "ringing") {
        Trace.detail("call.identify.skipped", "reason" to "not-ringing", "state" to lastState)
        return
      }
      val age = System.currentTimeMillis() - announcedAt
      if (age > ENRICH_WINDOW_MS) {
        // Past the window the desktop would draw this as a second call rather
        // than as the first one, named — so the name is kept for the ending.
        Trace.evt("call.identify.late", "afterMs" to age, "window" to ENRICH_WINDOW_MS)
        return
      }
      announcedAt = System.currentTimeMillis()
      namedOut = named()
      remember(context)
      Trace.evt(
        "call.identify",
        "call" to Trace.mark(callId),
        "from" to Trace.mark(ringingNumber),
        "named" to namedOut,
        "afterMs" to age,
      )
      OmarchyTelephonyModule.deliver(context, "onCall", callEvent("ringing"))
    }
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
    // Before the state in memory is consulted for anything, including for the
    // repeat check below: in a process Android started for this broadcast
    // alone, the state in memory is empty and the call may be an hour old.
    if (state != "ringing" && callId == null) restore(context)

    // The broadcast fires more than once for the same state on some devices.
    if (state == lastState) {
      Trace.detail("call.state.repeat", "state" to state)
      return
    }
    lastState = state

    if (state == "ringing") {
      // A new conversation. Whatever is on disk is an older one — normally
      // nothing, because a call clears its own record when it ends.
      forget(context)
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
      // The floor under every claim about when the talking started. On an
      // incoming call this is the answer itself; on an outgoing one it is the
      // dialling, and the dialler's card supplies the rest.
      offHookAt = System.currentTimeMillis()
    }
    if (state == "ended") {
      // Whatever is still missing, the phone's own log may have it. Asked only
      // when something is missing: a call the notification listener named is
      // already better identified than the log will be in the first second
      // after it ends.
      if (ringingNumber == null || direction == null) {
        val logged = LastCall.since(context, offHookAt)
        if (logged != null) {
          if (ringingNumber == null) ringingNumber = logged.from
          if (!named()) ringingName = logged.name ?: ringingName
          if (direction == null) direction = logged.direction
          if (logged.missed) answered = false
          Trace.evt(
            "call.log.recovered",
            "call" to Trace.mark(callId),
            "from" to Trace.mark(ringingNumber),
            "named" to named(),
            "direction" to direction,
          )
        }
      }
      // Only now, with the disk and the log both asked, is a call with no
      // beginning really a call with no beginning.
      if (callId == null) {
        // Nothing was held and the log had nothing to add, or the record was
        // too old to believe. `call.hold.stale`, `call.log.miss` and
        // `call.hold.unreadable` above say which of those it was.
        Trace.evt("call.orphan.ended", "reason" to "no-beginning-seen", "logged" to (direction != null))
        begin(direction)
      }
    }

    // One line per transition, carrying the token the three reports of a
    // single call share. Reading a log back, this is what turns three
    // anonymous broadcasts into one conversation.
    Trace.evt(
      "call.state",
      "state" to state,
      "call" to Trace.mark(callId),
      "direction" to direction,
      "from" to Trace.mark(ringingNumber),
      "named" to named(),
    )
    OmarchyTelephonyModule.deliver(context, "onCall", callEvent(state))

    if (state == "ended") {
      LiveCall.clear(context.applicationContext)
      ringingNumber = null
      ringingName = null
      answered = false
      namedOut = false
      announcedAt = 0L
      offHookAt = 0L
      chronometer = 0L
      callId = null
      direction = null
    } else {
      remember(context)
    }
  }
}
