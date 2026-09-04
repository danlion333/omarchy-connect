import { Directory, File, Paths } from 'expo-file-system'

import { fileUriIn } from './filename'

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
 *
 * The headers carry the one-use ticket the desktop wants for this fetch. The
 * URL carries only which file is being asked for, because a URL is the part
 * of a request that gets written down — proxy logs, history, a crash report —
 * and a credential written down outlives the transfer by years.
 */
export async function downloadOffer(
  url: string,
  token: string,
  name: string,
  headers: Record<string, string> = {},
): Promise<string> {
  const dir = new Directory(Paths.cache, 'omarchy-connect', token.slice(0, 12))
  if (!dir.exists) dir.create({ intermediates: true })
  // Built as a finished URI rather than as `new File(dir, name)`: the join
  // `File` would do leaves `[` and its kind unescaped, and the platform's URI
  // parser throws on them before the file is ever read. See `fileUriIn`.
  const target = new File(fileUriIn(dir.uri, name))
  if (target.exists) target.delete()
  const file = await File.downloadFileAsync(url, target, { headers })
  return file.uri
}
