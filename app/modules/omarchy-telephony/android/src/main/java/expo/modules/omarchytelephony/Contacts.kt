package expo.modules.omarchytelephony

import android.content.Context
import android.net.Uri
import android.provider.ContactsContract

/**
 * A number is not a name. The desktop notification is far more useful reading
 * "Mum" than "+380…", so look the number up when the user has granted contact
 * access — and shrug and return null when they have not.
 */
object Contacts {
  fun nameFor(context: Context, number: String?): String? {
    if (number.isNullOrBlank()) return null
    return try {
      val uri = Uri.withAppendedPath(ContactsContract.PhoneLookup.CONTENT_FILTER_URI, Uri.encode(number))
      context.contentResolver
        .query(uri, arrayOf(ContactsContract.PhoneLookup.DISPLAY_NAME), null, null, null)
        ?.use { cursor -> if (cursor.moveToFirst()) cursor.getString(0) else null }
    } catch (error: Exception) {
      null
    }
  }
}
