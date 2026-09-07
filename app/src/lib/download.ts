import { Directory, File, Paths } from 'expo-file-system'

import type { TransferPass } from '../api/client'
import { fileUriIn } from './filename'
import { openFile } from './transfer'

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
 * The pass carries the one-use ticket the desktop wants for this fetch, and
 * the key the body comes sealed under. The URL carries only which file is
 * being asked for, because a URL is the part of a request that gets written
 * down — proxy logs, history, a crash report — and a credential written down
 * outlives the transfer by years.
 *
 * A sealed body lands beside the real file and is opened into it, because the
 * platform downloader writes to disk and knows nothing about frames. A desktop
 * too old to seal hands us an empty key and the download is what it always
 * was.
 */
/** Where an offer's bytes land. One directory per offer — see `downloadOffer`. */
function offerDir(token: string): Directory {
  return new Directory(Paths.cache, 'omarchy-connect', token.slice(0, 12))
}

/**
 * The offer's bytes, if this phone still has them.
 *
 * The rows on the Share screen outlive the process now, and the files they
 * point at outlive it too — right up until Android reclaims the cache, which
 * it may do at any time and without telling anybody. So the screen asks the
 * disk rather than remembering: an answer here is a thumbnail, a viewer and
 * a Save that work with the desktop switched off, and `null` is a row that
 * has to say the bytes are gone instead of spinning on a download that
 * cannot start.
 */
export function cachedOffer(token: string, name: string): string | null {
  try {
    const dir = offerDir(token)
    if (!dir.exists) return null
    const file = new File(fileUriIn(dir.uri, name))
    return file.exists ? file.uri : null
  } catch {
    return null
  }
}

export async function downloadOffer(url: string, token: string, name: string, pass: TransferPass): Promise<string> {
  const dir = offerDir(token)
  if (!dir.exists) dir.create({ intermediates: true })
  // Built as a finished URI rather than as `new File(dir, name)`: the join
  // `File` would do leaves `[` and its kind unescaped, and the platform's URI
  // parser throws on them before the file is ever read. See `fileUriIn`.
  const target = new File(fileUriIn(dir.uri, name))
  if (target.exists) target.delete()
  if (!pass.key) {
    const file = await File.downloadFileAsync(url, target, { headers: pass.headers })
    return file.uri
  }
  const wrapped = new File(fileUriIn(dir.uri, `${name}.ocf1`))
  if (wrapped.exists) wrapped.delete()
  const sealed = await File.downloadFileAsync(url, wrapped, { headers: pass.headers, idempotent: true })
  await openFile(sealed, target, pass.key)
  return target.uri
}
