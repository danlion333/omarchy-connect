package expo.modules.omarchylink

import android.app.NotificationManager
import android.content.Context
import androidx.core.app.NotificationCompat

/**
 * The two things the desktop hands the phone without being asked.
 *
 * Both used to arrive silently and sit in the app waiting to be discovered,
 * which meant the desktop half of `omarchy-connect send` and the whole of
 * clipboard sync only worked for somebody already looking at the phone.
 *
 *   - **A file.** `omarchy-connect send <file>` puts an offer up; the phone
 *     says so, and for a picture or a video the notification carries a **Save**
 *     that fetches it and files it in the gallery without the app being
 *     opened. Anything else is a tap through to the share screen, because
 *     "save" for an arbitrary file means picking a destination, and that is a
 *     conversation, not a button.
 *   - **The clipboard.** Silent, and one notification that keeps replacing
 *     itself — a desktop clipboard is a single thing, and a phone that pinged
 *     on every Ctrl+C would be uninstalled by lunchtime. **Copy** is handled
 *     entirely in the receiver: writing the clipboard needs no app on screen
 *     and no round trip, so the text is one tap from being in the phone's
 *     paste buffer.
 */
object DesktopAlerts {
  private const val FILE_CHANNEL = "omarchy-file"
  private const val CLIP_CHANNEL = "omarchy-clipboard"

  /** A single, self-replacing entry: the desktop clipboard holds one thing. */
  private const val CLIP_KEY = "current"

  fun file(context: Context, token: String, name: String, size: String, desktop: String?, saveable: Boolean) {
    val app = context.applicationContext
    Shade.channel(
      app,
      FILE_CHANNEL,
      "Files from the desktop",
      "When your desktop sends this phone a file.",
      NotificationManager.IMPORTANCE_DEFAULT,
    )

    val builder = NotificationCompat.Builder(app, FILE_CHANNEL)
      .setSmallIcon(R.drawable.omarchy_file_notification)
      .setContentTitle(name)
      .setContentText(listOfNotNull(size.ifBlank { null }, desktop?.let { "from $it" }).joinToString(" · "))
      .setContentIntent(
        Shade.open(app, Shade.FILE, token, "omarchy-connect://share?at=${System.currentTimeMillis()}"),
      )
      .setDeleteIntent(Shade.act(app, LinkActionReceiver.ACTION_DISMISS, Shade.FILE, token))
      .setAutoCancel(true)
      .setOnlyAlertOnce(true)
      .setCategory(NotificationCompat.CATEGORY_STATUS)
      .setPriority(NotificationCompat.PRIORITY_DEFAULT)

    if (saveable) {
      val pending = Shade.act(
        app,
        LinkActionReceiver.ACTION_SAVE,
        Shade.FILE,
        token,
        mapOf(LinkActionReceiver.EXTRA_TEXT to name),
      )
      builder.addAction(
        NotificationCompat.Action.Builder(R.drawable.omarchy_file_notification, "Save", pending).build(),
      )
    }

    Shade.show(app, Shade.FILE, token, builder.build())
  }

  /** Says what became of a file the shade was asked to save. */
  fun fileNote(context: Context, token: String, name: String, note: String) {
    val app = context.applicationContext
    if (!Shade.holds(app, Shade.FILE, token)) return
    Shade.channel(
      app,
      FILE_CHANNEL,
      "Files from the desktop",
      "When your desktop sends this phone a file.",
      NotificationManager.IMPORTANCE_DEFAULT,
    )
    val builder = NotificationCompat.Builder(app, FILE_CHANNEL)
      .setSmallIcon(R.drawable.omarchy_file_notification)
      .setContentTitle(name)
      .setContentText(note)
      .setContentIntent(
        Shade.open(app, Shade.FILE, token, "omarchy-connect://share?at=${System.currentTimeMillis()}"),
      )
      .setDeleteIntent(Shade.act(app, LinkActionReceiver.ACTION_DISMISS, Shade.FILE, token))
      .setAutoCancel(true)
      .setOnlyAlertOnce(true)
      .setCategory(NotificationCompat.CATEGORY_STATUS)
      .setPriority(NotificationCompat.PRIORITY_LOW)
    Shade.show(app, Shade.FILE, token, builder.build())
  }

  fun clipboard(context: Context, text: String, desktop: String?) {
    val app = context.applicationContext
    Shade.channel(
      app,
      CLIP_CHANNEL,
      "Desktop clipboard",
      "A silent line holding whatever your desktop last copied.",
      NotificationManager.IMPORTANCE_LOW,
    )

    val pending = Shade.act(
      app,
      LinkActionReceiver.ACTION_COPY,
      Shade.CLIP,
      CLIP_KEY,
      mapOf(LinkActionReceiver.EXTRA_TEXT to text),
    )

    val builder = NotificationCompat.Builder(app, CLIP_CHANNEL)
      .setSmallIcon(R.drawable.omarchy_clipboard_notification)
      .setContentTitle(desktop?.let { "Copied on $it" } ?: "Copied on the desktop")
      .setContentText(text)
      .setStyle(NotificationCompat.BigTextStyle().bigText(text))
      .setContentIntent(
        Shade.open(app, Shade.CLIP, CLIP_KEY, "omarchy-connect://share?at=${System.currentTimeMillis()}"),
      )
      .setDeleteIntent(Shade.act(app, LinkActionReceiver.ACTION_DISMISS, Shade.CLIP, CLIP_KEY))
      .setAutoCancel(true)
      .setSilent(true)
      .setOnlyAlertOnce(true)
      .setCategory(NotificationCompat.CATEGORY_STATUS)
      .setPriority(NotificationCompat.PRIORITY_LOW)
      .addAction(
        NotificationCompat.Action.Builder(R.drawable.omarchy_clipboard_notification, "Copy", pending).build(),
      )

    Shade.show(app, Shade.CLIP, CLIP_KEY, builder.build())
  }

  /**
   * Confirms the copy in place of the offer.
   *
   * Android 13 and up draws its own "copied" toast, so this is for everything
   * older — and for the shade afterwards, where a card still offering to copy
   * something already copied reads as a button that did nothing.
   */
  fun clipboardCopied(context: Context, text: String) {
    val app = context.applicationContext
    if (!Shade.holds(app, Shade.CLIP, CLIP_KEY)) return
    Shade.channel(
      app,
      CLIP_CHANNEL,
      "Desktop clipboard",
      "A silent line holding whatever your desktop last copied.",
      NotificationManager.IMPORTANCE_LOW,
    )
    val builder = NotificationCompat.Builder(app, CLIP_CHANNEL)
      .setSmallIcon(R.drawable.omarchy_clipboard_notification)
      .setContentTitle("Copied to this phone")
      .setContentText(text)
      .setStyle(NotificationCompat.BigTextStyle().bigText(text))
      .setDeleteIntent(Shade.act(app, LinkActionReceiver.ACTION_DISMISS, Shade.CLIP, CLIP_KEY))
      .setAutoCancel(true)
      .setSilent(true)
      .setOnlyAlertOnce(true)
      .setCategory(NotificationCompat.CATEGORY_STATUS)
      .setPriority(NotificationCompat.PRIORITY_LOW)
    Shade.show(app, Shade.CLIP, CLIP_KEY, builder.build())
  }
}
