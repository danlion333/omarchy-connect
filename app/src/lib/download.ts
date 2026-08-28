import { Directory, File, Paths } from 'expo-file-system'

/**
 * Fetches an offered file into the app's cache and answers with its URI.
 *
 * Lives here rather than on the share screen because it is wanted from two
 * places now: the screen, where a tap asks for it, and the background link,
 * where **Save** on a notification asks for it with no screen mounted at all.
 *
 * A directory per offer, so two files the desktop happened to call the same
 * thing keep their own bytes — and their own name, which is what the gallery
 * and the share sheet end up showing.
 */
export async function downloadOffer(url: string, token: string, name: string): Promise<string> {
  const dir = new Directory(Paths.cache, 'omarchy-connect', token.slice(0, 12))
  if (!dir.exists) dir.create({ intermediates: true })
  const target = new File(dir, name)
  if (target.exists) target.delete()
  const file = await File.downloadFileAsync(url, target)
  return file.uri
}
