import { Asset, requestPermissionsAsync } from 'expo-media-library'

/**
 * Copies a downloaded file into the phone's own photo library, where the
 * gallery — and everything else that reads it — can find it. Until this runs,
 * a file the desktop sent lives in the app's cache and leaves with the app.
 *
 * The permission is asked for write-only: putting a picture in the gallery
 * needs nothing more, and asking to read the whole library back would be a
 * much larger thing to ask for a much smaller favour. On Android 13 and up
 * that costs no prompt at all, because writing through MediaStore is allowed
 * outright; older versions still ask once for storage.
 */
export async function saveToGallery(uri: string) {
  const permission = await requestPermissionsAsync(true)
  if (!permission.granted) throw new Error('the photo library said no')
  await Asset.create(uri)
}
