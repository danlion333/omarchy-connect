package expo.modules.omarchylink

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.net.Uri
import androidx.core.content.FileProvider
import java.io.File

/**
 * Puts a picture — not its name — on this phone's clipboard.
 *
 * Text goes on the clipboard as itself; a picture cannot. What a clipboard
 * carries for anything larger than a string is a `content://` URI, and the app
 * that pastes it reads the bytes back through the provider that URI names. So
 * a copied screenshot needs three things the text path never did: a provider
 * willing to hand the file out (`ClipFileProvider`), a URI minted through it,
 * and a `ClipData` built with the resolver so the clip carries the picture's
 * real MIME type — a chat that is offered `text/plain` will paste a file name.
 *
 * The read grant is the system's to give: `ClipboardManager` hands temporary
 * read permission to whoever takes the clip, which is why the provider is not
 * exported and no `FLAG_GRANT_READ_URI_PERMISSION` is set here. It is also why
 * this works from a broadcast receiver with no app on screen — the same
 * property the **Copy** on a copied *text* has relied on all along.
 *
 * Everything that can go wrong throws with a sentence rather than a stack:
 * the two callers — a notification button and a row on the share screen — both
 * have somewhere visible to put a sentence, and a receiver that dies silently
 * is the failure this replaces.
 */
object ImageClip {
  /** Kept in step with the `android:authorities` in the module's manifest. */
  private const val AUTHORITY = ".omarchylink.clips"

  private const val LABEL = "Omarchy Connect"

  /**
   * `path` is what `downloadOffer` wrote: a percent-encoded `file://` URI in
   * this app's cache. Answers with the MIME type the clip went out as, which
   * is the one thing worth logging about a paste that later looks wrong.
   */
  fun put(context: Context, path: String?): String {
    val app = context.applicationContext
    if (path.isNullOrBlank()) throw IllegalStateException("the picture never reached this phone")

    val source = Uri.parse(path)
    val shared = when (source.scheme) {
      // Already a provider URI — the share sheet's own doing — and re-wrapping
      // one of those in a provider of ours would only break it.
      "content" -> source
      else -> {
        // `Uri.getPath` is the decoded path, which is the half `File` wants;
        // the encoding in the URI is exactly what a raw string join gets wrong.
        val file = File(source.path ?: path)
        if (!file.exists()) throw IllegalStateException("the picture is no longer on this phone")
        try {
          FileProvider.getUriForFile(app, "${app.packageName}$AUTHORITY", file)
        } catch (error: IllegalArgumentException) {
          /* the file is outside every root the provider is configured for */
          throw IllegalStateException("Android would not hand this file to another app")
        }
      }
    }

    val resolver = app.contentResolver
    val manager = app.getSystemService(ClipboardManager::class.java)
      ?: throw IllegalStateException("this phone has no clipboard to write to")
    manager.setPrimaryClip(ClipData.newUri(resolver, LABEL, shared))
    return resolver.getType(shared) ?: "image/*"
  }
}

/**
 * A provider of our own name, holding nothing but the offer cache.
 *
 * A subclass rather than `androidx.core.content.FileProvider` itself because
 * the manifest merger keys providers by class name: an app that already ships
 * one — and an Expo app ships several — would collide with a second
 * declaration of the same class under a different authority, and the build
 * would fail somewhere far from here. The roots come from the manifest's
 * `FILE_PROVIDER_PATHS` meta-data rather than from the resource constructor,
 * which is newer than the oldest `androidx.core` this build might resolve.
 */
class ClipFileProvider : FileProvider()
