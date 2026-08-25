package expo.modules.omarchytelephony

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.provider.CallLog
import android.provider.Telephony
import android.telecom.TelecomManager
import android.telephony.SmsManager
import expo.modules.interfaces.permissions.Permissions
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * Incoming SMS and call state, forwarded to the desktop.
 *
 * Reading messages and the call log is not something Expo Go can do — the
 * permissions have to be declared in a real build — so this is a local module
 * rather than a library, and it is Android only. iOS gives no app any access
 * to either, at any price, so there is deliberately no iOS half to write.
 *
 * Two ways in:
 *
 *   live      the app is running, a listener is attached, events go straight
 *             to JavaScript and on to the desktop
 *   backlog   the app is closed; Android still starts the process for the
 *             broadcast, the receiver writes the event down, and the app
 *             forwards it the next time it runs
 *
 * Nothing here holds a socket open in the background. A message that arrives
 * while the app is closed reaches the desktop when the app is next opened, not
 * the instant it lands — that is the honest limit of doing this without a
 * foreground service.
 */
class OmarchyTelephonyModule : Module() {
  companion object {
    @Volatile private var live: OmarchyTelephonyModule? = null

    /**
     * Straight to JavaScript if anyone is listening, into the backlog if not.
     * Called from the broadcast receivers, which may be running in a process
     * that has no JavaScript at all.
     */
    fun deliver(context: Context, event: String, payload: Map<String, Any?>) {
      val module = live
      if (module != null && module.observing) {
        try {
          module.sendEvent(event, payload)
          return
        } catch (error: Exception) {
          // The bridge went away between the check and the send. Fall through
          // and keep the event rather than dropping it.
        }
      }
      Backlog.add(context.applicationContext, payload)
    }
  }

  @Volatile private var observing = false

  private val context: Context
    get() = appContext.reactContext ?: throw CodedException("no android context")

  private val readPermissions = arrayOf(
    Manifest.permission.RECEIVE_SMS,
    Manifest.permission.READ_SMS,
    Manifest.permission.READ_CALL_LOG,
    Manifest.permission.READ_PHONE_STATE,
    Manifest.permission.READ_CONTACTS,
  )

  override fun definition() = ModuleDefinition {
    Name("OmarchyTelephony")

    Events("onMessage", "onCall")

    OnCreate { live = this@OmarchyTelephonyModule }
    OnDestroy {
      observing = false
      if (live === this@OmarchyTelephonyModule) live = null
    }

    OnStartObserving { observing = true }
    OnStopObserving { observing = false }

    Function("isAvailable") { true }

    AsyncFunction("getPermissionsAsync") { promise: Promise ->
      Permissions.getPermissionsWithPermissionsManager(appContext.permissions, promise, *readPermissions)
    }

    AsyncFunction("requestPermissionsAsync") { promise: Promise ->
      Permissions.askForPermissionsWithPermissionsManager(appContext.permissions, promise, *readPermissions)
    }

    /** Sending is asked for separately: it is the one thing that costs money. */
    AsyncFunction("requestSendPermissionAsync") { promise: Promise ->
      Permissions.askForPermissionsWithPermissionsManager(
        appContext.permissions,
        promise,
        Manifest.permission.SEND_SMS,
      )
    }

    /** As is answering: picking up someone's call is not a passive act. */
    AsyncFunction("requestCallPermissionAsync") { promise: Promise ->
      Permissions.askForPermissionsWithPermissionsManager(
        appContext.permissions,
        promise,
        Manifest.permission.ANSWER_PHONE_CALLS,
      )
    }

    Function("canAnswerCalls") { canAnswerCalls() }

    AsyncFunction("answerCall") { answerCall() }

    AsyncFunction("rejectCall") { rejectCall() }

    /** Everything that arrived while no listener was attached, and forgets it. */
    AsyncFunction("drainBacklog") {
      Backlog.drain(context.applicationContext)
    }

    Function("backlogSize") { Backlog.size(context.applicationContext) }

    AsyncFunction("recentMessages") { limit: Int ->
      readMessages(limit.coerceIn(1, 200))
    }

    AsyncFunction("recentCalls") { limit: Int ->
      readCalls(limit.coerceIn(1, 200))
    }

    AsyncFunction("sendMessage") { to: String, text: String ->
      sendMessage(to, text)
    }
  }

  /* ── content providers ─────────────────────────────────────────────── */

  private fun readMessages(limit: Int): List<Map<String, Any?>> {
    val projection = arrayOf(
      Telephony.Sms.ADDRESS,
      Telephony.Sms.BODY,
      Telephony.Sms.DATE,
      Telephony.Sms.READ,
    )
    val out = mutableListOf<Map<String, Any?>>()
    context.contentResolver
      .query(Telephony.Sms.Inbox.CONTENT_URI, projection, null, null, "${Telephony.Sms.DATE} DESC")
      ?.use { cursor ->
        // Bounded here rather than with a LIMIT clause: SQLite accepts one
        // inside the sort order, but not every OEM's provider passes it on.
        while (cursor.moveToNext() && out.size < limit) {
          val from = cursor.getString(0)
          out.add(
            mapOf(
              "kind" to "sms",
              "at" to cursor.getLong(2),
              "from" to from,
              "name" to Contacts.nameFor(context, from),
              "body" to cursor.getString(1),
              "read" to (cursor.getInt(3) == 1),
            ),
          )
        }
      }
    return out
  }

  private fun readCalls(limit: Int): List<Map<String, Any?>> {
    val projection = arrayOf(
      CallLog.Calls.NUMBER,
      CallLog.Calls.CACHED_NAME,
      CallLog.Calls.DATE,
      CallLog.Calls.DURATION,
      CallLog.Calls.TYPE,
    )
    val out = mutableListOf<Map<String, Any?>>()
    context.contentResolver
      .query(CallLog.Calls.CONTENT_URI, projection, null, null, "${CallLog.Calls.DATE} DESC")
      ?.use { cursor ->
        while (cursor.moveToNext() && out.size < limit) {
          val number = cursor.getString(0)
          val type = cursor.getInt(4)
          out.add(
            mapOf(
              "kind" to "call",
              "at" to cursor.getLong(2),
              "from" to number,
              "name" to (cursor.getString(1) ?: Contacts.nameFor(context, number)),
              "seconds" to cursor.getLong(3),
              "direction" to when (type) {
                CallLog.Calls.OUTGOING_TYPE -> "outgoing"
                CallLog.Calls.MISSED_TYPE, CallLog.Calls.REJECTED_TYPE -> "missed"
                else -> "incoming"
              },
              "missed" to (type == CallLog.Calls.MISSED_TYPE || type == CallLog.Calls.REJECTED_TYPE),
            ),
          )
        }
      }
    return out
  }

  /* ── call control ──────────────────────────────────────────────────── */

  /**
   * Answering and rejecting on the desktop's behalf.
   *
   * `acceptRingingCall` and `endCall` are both marked deprecated, and the
   * deprecation note points companion apps at `InCallService` instead. That
   * route is closed to us: binding an InCallService means being the device's
   * default dialer, which is a role no file-sharing app should take over from
   * the one the user chose. Deprecated is not removed — these still work under
   * ANSWER_PHONE_CALLS, and they are the only door open to an ordinary app.
   *
   * Note what this does *not* do: it does not move the audio. Android has
   * refused non-system apps `AudioSource.VOICE_CALL` since Android 10, so a
   * call answered this way is answered on the handset. Bluetooth is the path
   * that carries the conversation, and the desktop prefers it when it is there.
   */
  private fun telecom(): TelecomManager =
    context.getSystemService(Context.TELECOM_SERVICE) as? TelecomManager
      ?: throw CodedException("this device has no telecom service")

  private fun canAnswerCalls(): Boolean =
    Build.VERSION.SDK_INT >= Build.VERSION_CODES.O &&
      context.checkSelfPermission(Manifest.permission.ANSWER_PHONE_CALLS) ==
      PackageManager.PERMISSION_GRANTED

  private fun answerCall(): Map<String, Any?> {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
      throw CodedException("answering needs Android 8 or newer")
    }
    if (!canAnswerCalls()) throw CodedException("permission to answer calls was not granted")
    try {
      @Suppress("DEPRECATION")
      telecom().acceptRingingCall()
    } catch (error: SecurityException) {
      throw CodedException("android refused: ${error.message}")
    }
    return mapOf("ok" to true, "audio" to "handset")
  }

  private fun rejectCall(): Map<String, Any?> {
    // endCall arrived two releases after acceptRingingCall. Below API 28 there
    // is no supported way for a normal app to hang up, and pretending
    // otherwise with reflection onto ITelephony is exactly the kind of thing
    // that breaks silently on the next OEM ROM.
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.P) {
      throw CodedException("rejecting needs Android 9 or newer")
    }
    if (!canAnswerCalls()) throw CodedException("permission to answer calls was not granted")
    val ended = try {
      @Suppress("DEPRECATION")
      telecom().endCall()
    } catch (error: SecurityException) {
      throw CodedException("android refused: ${error.message}")
    }
    if (!ended) throw CodedException("there was no call to end")
    return mapOf("ok" to true)
  }

  /* ── sending ───────────────────────────────────────────────────────── */

  private fun sendMessage(to: String, text: String): Map<String, Any?> {
    if (to.isBlank()) throw CodedException("no number to send to")
    if (text.isEmpty()) throw CodedException("nothing to send")

    val manager =
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
        context.getSystemService(SmsManager::class.java)
      } else {
        @Suppress("DEPRECATION")
        SmsManager.getDefault()
      } ?: throw CodedException("this device has no SMS service")

    // A reply typed on a desktop keyboard is very easily longer than one part.
    val parts = manager.divideMessage(text)
    if (parts.size > 1) {
      manager.sendMultipartTextMessage(to, null, parts, null, null)
    } else {
      manager.sendTextMessage(to, null, text, null, null)
    }
    return mapOf("ok" to true, "to" to to, "parts" to parts.size)
  }
}
