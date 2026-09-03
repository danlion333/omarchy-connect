import * as Clipboard from 'expo-clipboard'
import * as DocumentPicker from 'expo-document-picker'
import * as ImagePicker from 'expo-image-picker'
import { Directory, File, Paths } from 'expo-file-system'

import type { ConnectClient } from './client'

/**
 * Getting a picture out of a phone and onto the desktop an agent is running on.
 *
 * Three sources, because a screenshot lives in a different place depending on
 * how it got there: the camera roll if the phone took it, the file browser if
 * something else saved it, and the clipboard if it was cropped, marked up or
 * copied out of another app a moment ago. The last one is the one that matters
 * most in practice and is the one a picker cannot reach.
 *
 * What crosses the wire is the file. What reaches the agent is its *path* —
 * the desktop writes the bytes into a swept cache directory and answers with
 * where it put them, and `agents.attach` types that. Not a shortcut: a
 * terminal carries text and nothing else, and an agent reads an image by
 * opening it.
 */

export type Picked = {
  /** Where the bytes are on this phone. */
  uri: string
  name: string
}

/** A picture on the desktop, waiting for an agent to be told about it. */
export type Attachment = {
  /** Stable across the upload, so a thumbnail does not jump when the path lands. */
  key: string
  uri: string
  name: string
  /** Where the desktop wrote it. Absent until the upload finishes. */
  path?: string
  error?: string
}

const stamp = () => Date.now().toString(36)

/* ── the three sources ─────────────────────────────────────────────────── */

/** The camera roll. */
export async function fromLibrary(): Promise<Picked | null> {
  const permission = await ImagePicker.requestMediaLibraryPermissionsAsync()
  if (!permission.granted) throw new Error('photo access was denied')
  const picked = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 1 })
  if (picked.canceled) return null
  const asset = picked.assets[0]
  return { uri: asset.uri, name: asset.fileName || `photo-${stamp()}.jpg` }
}

/** The file browser, for a screenshot that never reached the camera roll. */
export async function fromFiles(): Promise<Picked | null> {
  const picked = await DocumentPicker.getDocumentAsync({ type: 'image/*', copyToCacheDirectory: true })
  if (picked.canceled) return null
  const asset = picked.assets[0]
  return { uri: asset.uri, name: asset.name || `image-${stamp()}.png` }
}

export const clipboardHasImage = () => Clipboard.hasImageAsync().catch(() => false)

/**
 * The clipboard, which is where a picture is the moment after it was cropped.
 *
 * It arrives as base64 rather than as a file, so it has to be written to one
 * before anything can upload it — the upload moves a file off the disk, and a
 * string in memory is not one. The clipboard hands it over as a `data:` URI
 * with the MIME type in front, which is the one part the desktop does not need.
 */
export async function fromClipboard(): Promise<Picked | null> {
  const image = await Clipboard.getImageAsync({ format: 'png' })
  if (!image?.data) return null
  const base64 = image.data.startsWith('data:') ? image.data.slice(image.data.indexOf(',') + 1) : image.data
  const file = scratchFile(`clipboard-${stamp()}.png`)
  file.write(bytesFromBase64(base64))
  return { uri: file.uri, name: file.name }
}

/* ── handing it over ───────────────────────────────────────────────────── */

/**
 * Push the bytes to the desktop and come back with the path it wrote.
 *
 * `dest: agent` is what keeps this out of `~/Downloads/Omarchy Connect` and
 * out of the desktop's notifications: a picture attached to a question is not
 * a file transfer, and treating it as one would fill a directory people
 * actually look at with pictures nobody asked to keep.
 */
export async function upload(client: ConnectClient, picked: Picked): Promise<string> {
  const result = await new File(picked.uri).upload(`${client.baseUrl}/api/upload`, {
    httpMethod: 'POST',
    headers: await client.uploadHeaders(picked.name, 'agent'),
  })
  let body: { path?: string; error?: string } = {}
  try {
    body = JSON.parse(result.body || '{}')
  } catch {
    /* a proxy or a crash answered with something that is not JSON */
  }
  if (result.status >= 400 || !body.path) {
    throw new Error(body.error || `the desktop refused the picture (${result.status})`)
  }
  return body.path
}

/* ── odds and ends ─────────────────────────────────────────────────────── */

function scratchFile(name: string): File {
  const dir = new Directory(Paths.cache, 'omarchy-connect')
  if (!dir.exists) dir.create({ intermediates: true })
  const file = new File(dir, name)
  if (file.exists) file.delete()
  file.create()
  return file
}

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const INDEX = new Uint8Array(128)
for (let i = 0; i < ALPHABET.length; i += 1) INDEX[ALPHABET.charCodeAt(i)] = i

/**
 * base64 → bytes, by hand.
 *
 * `atob` is present in this runtime and would do, but it decodes to a string
 * of char codes that then has to be walked into a `Uint8Array` anyway — so the
 * loop exists either way, and doing it here costs one function and depends on
 * nothing.
 */
function bytesFromBase64(base64: string): Uint8Array {
  const clean = base64.replace(/[^A-Za-z0-9+/]/g, '')
  const bytes = new Uint8Array(Math.floor((clean.length * 3) / 4))
  let out = 0
  for (let i = 0; i < clean.length; i += 4) {
    const a = INDEX[clean.charCodeAt(i)]
    const b = INDEX[clean.charCodeAt(i + 1)]
    const c = INDEX[clean.charCodeAt(i + 2)]
    const d = INDEX[clean.charCodeAt(i + 3)]
    bytes[out++] = (a << 2) | (b >> 4)
    if (i + 2 < clean.length) bytes[out++] = ((b & 15) << 4) | (c >> 2)
    if (i + 3 < clean.length) bytes[out++] = ((c & 3) << 6) | d
  }
  return bytes.subarray(0, out)
}
