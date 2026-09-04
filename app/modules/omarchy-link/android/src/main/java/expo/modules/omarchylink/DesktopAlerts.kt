package expo.modules.omarchylink

import android.app.NotificationManager
import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
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

  private const val PREFS = "omarchy-connect.link"

  /**
   * The offer the clipboard card is currently holding, if it is a picture.
   *
   * Written down rather than kept in a field because the two halves of a save
   * are two processes apart: **Save** is answered by a receiver, and the note
   * that says it worked comes back from JavaScript minutes later through
   * `fileNote`, which knows only a token. Without this, that note would look
   * for a file card that never existed and the picture's card would sit there
   * still offering to save something already in the gallery.
   */
  private const val CLIP_TOKEN = "clip.token"
  private const val CLIP_PATH = "clip.path"

  /**
   * How big a preview may get before it is sampled down.
   *
   * A notification's bitmap crosses a Binder transaction with a hard ceiling
   * on it, and a phone screenshot is comfortably over it at full size — an
   * oversized picture is not a smaller card, it is no card at all. Sampling to
   * roughly this on the long edge is more than the shade ever draws.
   */
  private const val PREVIEW_PIXELS = 1024

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
    // A picture copied on the desktop is saved down the very same road — the
    // outbox entry says only "save this token" — so a note about a token the
    // clipboard card is holding belongs on that card, not on a file card that
    // was never posted.
    if (!Shade.holds(app, Shade.FILE, token)) {
      if (holdsPicture(app, token)) clipboardNote(app, token, name, note)
      return
    }
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

    forgetPicture(app)
    Shade.show(app, Shade.CLIP, CLIP_KEY, builder.build())
  }

  /**
   * A picture the desktop copied, on the same one card as the text above.
   *
   * The clipboard holds one thing, so this shares `CLIP_KEY` with the text
   * notification and replaces it — copy a screenshot and then a URL and there
   * is still one line in the shade. It carries both offers a picture has:
   * **Copy**, which puts the image itself in the phone's paste buffer through
   * `ImageClip`, and **Save**, which files it in the gallery down the road
   * `saveOffer` already built.
   *
   * `path` is the bytes already fetched, or null when they could not be — the
   * card goes up either way, because "the desktop copied a picture" is the
   * news and a phone that says nothing is the bug being fixed. **Copy** is
   * offered even then, and answers with why it could not rather than with
   * nothing: a button that is missing looks like a feature this build lacks,
   * while a button that explains itself is a download that failed once.
   */
  fun clipboardImage(context: Context, token: String, name: String, path: String?, desktop: String?) {
    val app = context.applicationContext
    Shade.channel(
      app,
      CLIP_CHANNEL,
      "Desktop clipboard",
      "A silent line holding whatever your desktop last copied.",
      NotificationManager.IMPORTANCE_LOW,
    )

    // The buttons carry the offer token as their key, so the receiver can act
    // without a second lookup; the card itself stays under CLIP_KEY.
    val saving = Shade.act(
      app,
      LinkActionReceiver.ACTION_SAVE,
      Shade.CLIP,
      token,
      mapOf(LinkActionReceiver.EXTRA_TEXT to name),
    )
    // Always present, empty and all: `EXTRA_PATH` is what tells the receiver
    // this **Copy** is a picture's rather than a line of text's.
    val copying = Shade.act(
      app,
      LinkActionReceiver.ACTION_COPY,
      Shade.CLIP,
      token,
      mapOf(LinkActionReceiver.EXTRA_TEXT to name, LinkActionReceiver.EXTRA_PATH to (path ?: "")),
    )

    val builder = NotificationCompat.Builder(app, CLIP_CHANNEL)
      .setSmallIcon(R.drawable.omarchy_clipboard_notification)
      .setContentTitle(desktop?.let { "Copied on $it" } ?: "Copied on the desktop")
      .setContentText(name)
      .setContentIntent(
        Shade.open(app, Shade.CLIP, CLIP_KEY, "omarchy-connect://share?at=${System.currentTimeMillis()}"),
      )
      .setDeleteIntent(Shade.act(app, LinkActionReceiver.ACTION_DISMISS, Shade.CLIP, CLIP_KEY))
      .setAutoCancel(true)
      .setSilent(true)
      .setOnlyAlertOnce(true)
      .setCategory(NotificationCompat.CATEGORY_STATUS)
      .setPriority(NotificationCompat.PRIORITY_LOW)
      // Copy first, as on the text card: it is the one that needs no app and
      // no gallery, and it is what the person who just copied usually meant.
      .addAction(
        NotificationCompat.Action.Builder(R.drawable.omarchy_clipboard_notification, "Copy", copying).build(),
      )
      .addAction(
        NotificationCompat.Action.Builder(R.drawable.omarchy_file_notification, "Save", saving).build(),
      )

    val picture = decode(app, path)
    if (picture != null) {
      builder
        .setLargeIcon(picture)
        // The large icon is dropped while the card is expanded, which is the
        // usual trick: the picture is the picture, not a thumbnail beside it.
        .setStyle(NotificationCompat.BigPictureStyle().bigPicture(picture).bigLargeIcon(null as Bitmap?))
    }

    rememberPicture(app, token, if (picture != null) path else null)
    Shade.show(app, Shade.CLIP, CLIP_KEY, builder.build())
  }

  /**
   * Says what became of a picture the clipboard card was asked to do something
   * with — filed in the gallery, or put on this phone's clipboard.
   *
   * Deliberately the same words and the same shape as `fileNote`, because to
   * the person holding the phone it is the same **Save** — only the card it
   * rewrites is different.
   */
  fun clipboardNote(context: Context, token: String, name: String, note: String) =
    pictureReceipt(context, token, name, note)

  /**
   * Confirms a copied picture in place of the offer, the way `clipboardCopied`
   * does for text: the card that was offering to copy says it has, and the
   * picture stays on it so it still reads as the same notification.
   */
  fun clipboardImageCopied(context: Context, token: String, name: String) =
    pictureReceipt(context, token, "Copied to this phone", name)

  /**
   * The picture card, rewritten as a receipt.
   *
   * Both buttons come off it. **Copy** because a button offering to copy what
   * was just copied reads as one that did nothing — the same reasoning as
   * `clipboardCopied` — and **Save** with it, so that the card says one thing:
   * what happened. The offer itself has not gone anywhere; the share screen
   * still holds it, thumbnail, Save and all.
   */
  private fun pictureReceipt(context: Context, token: String, title: String, note: String) {
    val app = context.applicationContext
    if (!Shade.holds(app, Shade.CLIP, CLIP_KEY) || pictureToken(app) != token) return
    Shade.channel(
      app,
      CLIP_CHANNEL,
      "Desktop clipboard",
      "A silent line holding whatever your desktop last copied.",
      NotificationManager.IMPORTANCE_LOW,
    )
    val builder = NotificationCompat.Builder(app, CLIP_CHANNEL)
      .setSmallIcon(R.drawable.omarchy_clipboard_notification)
      .setContentTitle(title)
      .setContentText(note)
      .setContentIntent(
        Shade.open(app, Shade.CLIP, CLIP_KEY, "omarchy-connect://share?at=${System.currentTimeMillis()}"),
      )
      .setDeleteIntent(Shade.act(app, LinkActionReceiver.ACTION_DISMISS, Shade.CLIP, CLIP_KEY))
      .setAutoCancel(true)
      .setSilent(true)
      .setOnlyAlertOnce(true)
      .setCategory(NotificationCompat.CATEGORY_STATUS)
      .setPriority(NotificationCompat.PRIORITY_LOW)
    // The picture stays on the card it is a receipt for: a note that blanked
    // it would read as a different notification arriving.
    val picture = decode(app, picturePath(app))
    if (picture != null) {
      builder
        .setLargeIcon(picture)
        .setStyle(NotificationCompat.BigPictureStyle().bigPicture(picture).bigLargeIcon(null as Bitmap?))
    }
    Shade.show(app, Shade.CLIP, CLIP_KEY, builder.build())
  }

  /** The offer the clipboard card is holding, for whoever has only a token. */
  fun holdsPicture(context: Context, token: String) =
    Shade.holds(context.applicationContext, Shade.CLIP, CLIP_KEY) && pictureToken(context) == token

  private fun prefs(context: Context) =
    context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

  private fun pictureToken(context: Context): String? = prefs(context).getString(CLIP_TOKEN, null)

  private fun picturePath(context: Context): String? = prefs(context).getString(CLIP_PATH, null)

  private fun rememberPicture(context: Context, token: String, path: String?) {
    prefs(context).edit().putString(CLIP_TOKEN, token).putString(CLIP_PATH, path).apply()
  }

  private fun forgetPicture(context: Context) {
    prefs(context).edit().remove(CLIP_TOKEN).remove(CLIP_PATH).apply()
  }

  /**
   * The picture, small enough to survive the trip to the shade.
   *
   * Read through the resolver rather than by file path: what arrives is the
   * `file://` URI `downloadOffer` wrote, percent-encoded, and the encoding is
   * exactly the part `BitmapFactory.decodeFile` would get wrong. Anything that
   * does not decode is not an error here — it is a card without a picture.
   */
  private fun decode(context: Context, path: String?): Bitmap? {
    if (path.isNullOrBlank()) return null
    return try {
      val uri = Uri.parse(path)
      val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
      context.contentResolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, bounds) }
      var sample = 1
      while (maxOf(bounds.outWidth, bounds.outHeight) / sample > PREVIEW_PIXELS) sample *= 2
      val options = BitmapFactory.Options().apply { inSampleSize = sample }
      context.contentResolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, options) }
    } catch (error: Exception) {
      Trace.warn("clipboard.preview.failed", "error" to error.javaClass.simpleName)
      null
    } catch (error: OutOfMemoryError) {
      Trace.warn("clipboard.preview.failed", "error" to "OutOfMemoryError")
      null
    }
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
    forgetPicture(app)
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
