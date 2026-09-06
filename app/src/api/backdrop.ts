import { Directory, File, Paths } from 'expo-file-system'

import { bytesFromBase64 } from '../lib/base64'

/**
 * The desktop's own wallpaper, on the phone.
 *
 * The picture is fetched once and then lives in the app's cache under the id
 * the desktop gave it, so the second launch paints it before the socket is
 * even up and the daemon is only asked whether that id is still the current
 * one. A theme switch changes the id; nothing else does.
 */

export type Backdrop = { id: string; uri: string }

export type BackdropReply = {
  available: boolean
  unchanged?: boolean
  id?: string
  name?: string
  mime?: string
  data?: string
  reason?: string
}

const DIR = ['omarchy-connect', 'wallpaper']

/** What is already on this phone, or null. */
export function cachedBackdrop(): Backdrop | null {
  const dir = new Directory(Paths.cache, ...DIR)
  if (!dir.exists) return null
  const files = dir.list().filter((entry): entry is File => entry instanceof File)
  const file = files[0]
  return file ? { id: file.name.replace(/\.[^.]+$/, ''), uri: file.uri } : null
}

/**
 * Ask the desktop for its wallpaper, handing over what we hold so the usual
 * answer is "still that one" and no bytes move.
 *
 * `null` means the desktop has no wallpaper to give — no theme background, or
 * one it cannot scale down — and the caller falls back to the gradient.
 */
export async function fetchBackdrop(
  call: <T>(method: string, params?: Record<string, unknown>) => Promise<T>,
  held: Backdrop | null,
): Promise<Backdrop | null> {
  const reply = await call<BackdropReply>('theme.background', { id: held?.id })
  if (!reply.available) return null
  if (reply.unchanged && held) return held
  if (!reply.id || !reply.data) return null
  return write(reply.id, reply.data, reply.mime)
}

/**
 * The new picture replaces the old one rather than joining it: the cache holds
 * one wallpaper, the current one, and a phone that has switched themes a dozen
 * times is not carrying a dozen desktop backgrounds around.
 */
function write(id: string, base64: string, mime?: string): Backdrop {
  const dir = new Directory(Paths.cache, ...DIR)
  if (!dir.exists) dir.create({ intermediates: true })
  for (const entry of dir.list()) entry.delete()
  const file = new File(dir, `${id}.${mime === 'image/png' ? 'png' : 'jpg'}`)
  file.create()
  file.write(bytesFromBase64(base64))
  return { id, uri: file.uri }
}
