import { Directory, File, Paths } from 'expo-file-system'

import type { TransferPass } from '../api/client'
import { opener, sealer } from '../api/filecrypt'

/**
 * Sealing a file on its way out and opening one on its way in, a piece at a
 * time.
 *
 * The bytes never all exist at once. `expo-file-system` hands out a real
 * `ReadableStream` and a real `WritableStream`, so a 4 GB video is sealed
 * 64 KiB at a time into a scratch file next to it, handed to the native
 * uploader — which is the part that has always streamed and must keep doing
 * so — and then deleted. A download is the same in reverse: the platform
 * writes the sealed body to disk, and it is opened into its real name and
 * thrown away.
 *
 * The scratch file is the price of keeping the native uploader. Encrypting
 * inside the request body would mean building the request in JavaScript, which
 * means the whole file in memory, which is the one thing a phone cannot do.
 */

const scratchDir = () => {
  const dir = new Directory(Paths.cache, 'omarchy-connect', 'sealed')
  if (!dir.exists) dir.create({ intermediates: true })
  return dir
}

const scratch = (suffix: string) => {
  const file = new File(scratchDir(), `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}${suffix}`)
  if (file.exists) file.delete()
  return file
}

const forget = (file: File) => {
  try {
    if (file.exists) file.delete()
  } catch {
    /* the cache is swept by the platform anyway; a leftover is not worth a failed transfer */
  }
}

/** Seal `source` into a new cache file and hand it over. The caller deletes it. */
export async function sealFile(source: File, key: string): Promise<File> {
  const target = scratch('.ocf1')
  target.create()
  const codec = sealer(key)
  const reader = source.readableStream().getReader()
  const writer = target.writableStream().getWriter()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value?.length) for (const frame of codec.push(value)) await writer.write(frame)
    }
    for (const frame of codec.end()) await writer.write(frame)
    await writer.close()
  } catch (error) {
    await writer.abort?.(error).catch(() => {})
    forget(target)
    throw error
  } finally {
    reader.releaseLock()
  }
  return target
}

/** Open `source` into `target`, in place of it. `source` is gone either way. */
export async function openFile(source: File, target: File, key: string): Promise<void> {
  if (target.exists) target.delete()
  target.create()
  const codec = opener(key)
  const reader = source.readableStream().getReader()
  const writer = target.writableStream().getWriter()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value?.length) for (const piece of codec.push(value)) await writer.write(piece)
    }
    for (const piece of codec.end()) await writer.write(piece)
    await writer.close()
  } catch (error) {
    await writer.abort?.(error).catch(() => {})
    forget(target)
    throw error
  } finally {
    reader.releaseLock()
    forget(source)
  }
}

export { forget as forgetScratch, scratch as scratchFile }

/**
 * Push a file at `/api/upload`, sealed when the desktop handed us a key.
 *
 * Both places that send a file go through here — the share screen, where
 * somebody picked it, and `api/attach`, where it is a screenshot or a
 * dictation on its way to an agent — so there is one answer to "was it
 * encrypted", not two.
 */
export async function uploadFile(url: string, uri: string, pass: TransferPass) {
  const source = new File(uri)
  const sealed = pass.key ? await sealFile(source, pass.key) : null
  try {
    return await (sealed ?? source).upload(url, { httpMethod: 'POST', headers: pass.headers })
  } finally {
    if (sealed) forget(sealed)
  }
}
