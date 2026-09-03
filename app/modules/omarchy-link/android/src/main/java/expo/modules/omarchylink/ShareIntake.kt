package expo.modules.omarchylink

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.OpenableColumns
import android.webkit.MimeTypeMap
import java.io.File

/**
 * The system share sheet, turned into something JavaScript can hold.
 *
 * When another app shares to Omarchy Connect the activity is started with an
 * `ACTION_SEND` (or `ACTION_SEND_MULTIPLE`) intent whose attachments are
 * `content://` URIs belonging to that other app. Two things make them useless
 * to the JavaScript side as they stand: the read permission is granted to this
 * activity's intent and expires with it, and `expo-file-system` uploads a file
 * off the disk, not a content provider row.
 *
 * So the copy happens here, at the first moment the bytes are legally ours,
 * and what crosses the bridge is an ordinary `file://` in this app's cache
 * with the name the sharing app gave it. The name matters: it is what the
 * desktop writes into `~/Downloads/Omarchy Connect`, and "content" would be a
 * poor name for every photo anybody ever sent.
 */
object ShareIntake {
  /** Where the copies live. Cleared of anything the phone has finished with. */
  private const val DIR = "omarchy-share"

  /** A copy older than this was delivered, or abandoned, long ago. */
  private const val KEEP_MS = 60L * 60L * 1000L

  fun isShare(intent: Intent?): Boolean =
    intent != null && (intent.action == Intent.ACTION_SEND || intent.action == Intent.ACTION_SEND_MULTIPLE)

  /**
   * Read one share, copying every attachment it carries.
   *
   * The answer is the shape `lib/share.ts` expects: the text, the files, and
   * the number of attachments that could not be read at all. That last number
   * is the honest half — a stream that fails to copy is reported rather than
   * quietly missing from the list.
   */
  fun read(context: Context, intent: Intent): Map<String, Any?> {
    val uris = streams(intent)
    val files = ArrayList<Map<String, Any?>>()
    var dropped = 0
    sweep(context)
    for (uri in uris) {
      val copied = copy(context, uri)
      if (copied == null) {
        Trace.warn("share.stream.unreadable", "scheme" to (uri.scheme ?: "?"))
        dropped += 1
      } else {
        files.add(copied)
      }
    }
    val text = intent.getCharSequenceExtra(Intent.EXTRA_TEXT)?.toString()?.trim()
    Trace.evt("share.intake", "files" to files.size, "dropped" to dropped, "text" to !text.isNullOrEmpty())
    return mapOf(
      "text" to (if (text.isNullOrEmpty()) null else text),
      "files" to files,
      "dropped" to dropped,
    )
  }

  /**
   * Spend the intent.
   *
   * The activity is `singleTask`, so the intent that started it is still
   * hanging off it long after the share has been delivered — every later
   * resume would otherwise look like the same photo being shared again.
   * Emptying it in place is what makes taking a share idempotent.
   */
  fun spend(intent: Intent) {
    intent.action = Intent.ACTION_MAIN
    intent.removeExtra(Intent.EXTRA_STREAM)
    intent.removeExtra(Intent.EXTRA_TEXT)
    intent.clipData = null
  }

  /** Every attachment the intent carries, whichever way it chose to carry it. */
  private fun streams(intent: Intent): List<Uri> {
    val out = ArrayList<Uri>()
    if (intent.action == Intent.ACTION_SEND_MULTIPLE) {
      out.addAll(parcelableList(intent))
    } else {
      parcelable(intent)?.let { out.add(it) }
    }
    // Some apps put the attachments only in the clip data — `EXTRA_STREAM` is
    // the convention, not the enforcement. Anything already seen is skipped.
    val clip = intent.clipData
    if (clip != null) {
      for (i in 0 until clip.itemCount) {
        val uri = clip.getItemAt(i).uri ?: continue
        if (!out.contains(uri)) out.add(uri)
      }
    }
    return out
  }

  @Suppress("DEPRECATION")
  private fun parcelable(intent: Intent): Uri? =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java)
    } else {
      intent.getParcelableExtra(Intent.EXTRA_STREAM)
    }

  @Suppress("DEPRECATION")
  private fun parcelableList(intent: Intent): List<Uri> =
    (if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM, Uri::class.java)
    } else {
      intent.getParcelableArrayListExtra<Uri>(Intent.EXTRA_STREAM)
    }) ?: emptyList()

  /**
   * One attachment, on our disk, under its own name.
   *
   * Each copy gets a directory of its own so that sharing two files called
   * `IMG_0001.jpg` from two albums does not have one overwrite the other on
   * the way through.
   */
  private fun copy(context: Context, uri: Uri): Map<String, Any?>? {
    return try {
      val name = displayName(context, uri)
      val dir = File(File(context.cacheDir, DIR), System.nanoTime().toString())
      dir.mkdirs()
      val out = File(dir, name)
      val bytes = context.contentResolver.openInputStream(uri)?.use { input ->
        out.outputStream().use { output -> input.copyTo(output) }
      } ?: return null
      mapOf("uri" to Uri.fromFile(out).toString(), "name" to name, "size" to bytes)
    } catch (error: Exception) {
      Trace.warn("share.copy.failed", "error" to error.javaClass.simpleName)
      null
    }
  }

  /**
   * What the sharing app calls this file, reduced to something safe.
   *
   * A display name arrives as untrusted text from another application, so
   * anything that could climb out of a directory is flattened before it is
   * used as a filename here — and it is used again on the desktop, where the
   * daemon does its own checking of the same string.
   */
  private fun displayName(context: Context, uri: Uri): String {
    var name: String? = null
    try {
      context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
        val column = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
        if (column >= 0 && cursor.moveToFirst()) name = cursor.getString(column)
      }
    } catch (error: Exception) {
      /* a provider that will not answer questions still hands over bytes */
    }
    if (name.isNullOrBlank()) name = uri.lastPathSegment
    val safe = (name ?: "").replace(Regex("[/\\\\]"), "_").trim().trimStart('.')
    if (safe.isNotEmpty() && safe != "." && safe != "..") return safe.take(180)
    val extension = MimeTypeMap.getSingleton()
      .getExtensionFromMimeType(context.contentResolver.getType(uri) ?: "")
      ?: "bin"
    return "shared-${System.currentTimeMillis()}.$extension"
  }

  /** Throw away what an earlier share left behind. */
  private fun sweep(context: Context) {
    try {
      val root = File(context.cacheDir, DIR)
      val cutoff = System.currentTimeMillis() - KEEP_MS
      for (dir in root.listFiles() ?: emptyArray()) {
        if (dir.lastModified() < cutoff) dir.deleteRecursively()
      }
    } catch (error: Exception) {
      /* a cache we cannot tidy is not a reason to refuse a share */
    }
  }
}
