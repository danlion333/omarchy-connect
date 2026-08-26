package expo.modules.omarchytelephony

import android.app.Notification
import android.app.Person
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.os.Build
import android.provider.Settings
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification

/**
 * Who is calling, read off the phone's own screen.
 *
 * Android stopped putting the caller's number in the `PHONE_STATE` broadcast
 * for anything targeting API 29 or higher — no permission brings it back, and
 * the call log is only written once the call is over. So a mirrored call
 * arrives knowing its state and nothing about who it is with, which is the
 * least useful half of the news.
 *
 * The dialler already knows. It puts the contact's name on a notification the
 * moment the phone starts ringing, and a notification listener is allowed to
 * read it. That is the same trick the iPhone side of this project plays with
 * ANCS — the desktop learns who is calling from the notification the handset
 * raises, not from the telephony stack.
 *
 * This deliberately reads call notifications and nothing else. Notification
 * access is the broadest permission on the phone, and a file-sharing app that
 * asks for it should be able to say exactly what it does with it.
 */
class CallNotifications : NotificationListenerService() {
  companion object {
    /** Telecom raises the call notification itself on most builds. */
    private const val TELECOM = "com.android.server.telecom"

    /** Whether the user has granted notification access to this app. */
    fun enabled(context: Context): Boolean {
      val flat = Settings.Secure.getString(context.contentResolver, "enabled_notification_listeners") ?: return false
      val us = context.packageName
      return flat.split(':').any { entry ->
        ComponentName.unflattenFromString(entry)?.packageName == us
      }
    }

    /**
     * Notification access is not a runtime permission — there is no dialog to
     * raise, only a settings screen to send the user to.
     */
    fun openSettings(context: Context) {
      val intent = Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS)
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      context.startActivity(intent)
    }

    /** A title that is all digits is a number the dialler could not name. */
    private val NUMBERISH = Regex("""^[+()\-\s\d*#]+$""")

    /** `tel:+380…` on the notification's Person, when the dialler attaches one. */
    private fun numberFrom(notification: Notification): String? {
      val extras = notification.extras
      val uris = mutableListOf<String>()
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
        val people = extras.getParcelableArray(Notification.EXTRA_PEOPLE_LIST)
        people?.forEach { person -> (person as? Person)?.uri?.let(uris::add) }
      }
      @Suppress("DEPRECATION")
      extras.getStringArray(Notification.EXTRA_PEOPLE)?.let(uris::addAll)
      return uris
        .firstOrNull { it.startsWith("tel:") }
        ?.removePrefix("tel:")
        ?.let(android.net.Uri::decode)
        ?.takeIf { it.isNotBlank() }
    }
  }

  /**
   * The dialler's own notification, and telecom's. Anything else that declares
   * itself a call — a VoIP app — is left alone: this mirrors the cellular call
   * the rest of the module reports on, and a WhatsApp call arriving as if it
   * were one would be a lie the desktop cannot tell apart.
   */
  private fun ours(sbn: StatusBarNotification): Boolean {
    if (sbn.packageName == TELECOM) return true
    val dialler = try {
      (getSystemService(Context.TELECOM_SERVICE) as? android.telecom.TelecomManager)?.defaultDialerPackage
    } catch (error: Exception) {
      null
    }
    return dialler != null && sbn.packageName == dialler
  }

  override fun onNotificationPosted(sbn: StatusBarNotification) {
    val notification = sbn.notification ?: return
    if (notification.category != Notification.CATEGORY_CALL) return
    if (!ours(sbn)) return

    val title = notification.extras.getCharSequence(Notification.EXTRA_TITLE)?.toString()?.trim()
    var number = numberFrom(notification)
    var name: String? = title?.takeIf { it.isNotEmpty() }

    // The dialler shows the raw number when it has no contact for it; passing
    // that on as a name would put the number on the desktop twice.
    if (name != null && NUMBERISH.matches(name)) {
      if (number == null) number = name
      name = null
    }
    if (name == null && number != null) name = Contacts.nameFor(this, number)
    if (name == null && number == null) return

    PhoneStateReceiver.identify(this, name, number)
  }

  override fun onNotificationRemoved(sbn: StatusBarNotification) {
    // Nothing to do: the call ending is what PHONE_STATE reports, and it is
    // that broadcast — not this one — that clears the remembered caller.
  }
}
