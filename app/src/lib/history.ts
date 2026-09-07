/**
 * What the phone keeps of the desktop's clipboard and of the files that came
 * down the link — the part of it that has to survive the process being killed.
 *
 * `LinkState` lives in one object inside one module, which is enough to carry
 * the history across a tab switch, an unmounted screen and a minimised app,
 * and is nothing at all against Android reclaiming the process. The moment
 * anybody actually wants to look at what arrived — the phone is out of
 * signal, the desktop is asleep, the laptop is in a bag — the app has been
 * restarted at least once and the Share screen is empty.
 *
 * So the history is written down. Everything about *what* is written lives
 * here, pure and away from both the socket and the file system, for the same
 * reason `remember` next door is: the rules for what is kept, what is dropped
 * and what an unreadable blob means are worth reading and testing without a
 * daemon at one end and a phone at the other.
 *
 * ## Why it is sealed
 *
 * A clipboard history is not an ordinary cache. It is a list of the things
 * its owner copied, which on any real desktop includes a password out of a
 * manager, a token pasted into a terminal, a private URL. The app already
 * refuses a cloud backup (`allowBackup: false`) and Android keeps one app's
 * files from another, so a plain file would be *adequate* — but adequate here
 * means the entire list is one `adb backup`, one recovery image or one
 * misplaced phone away from being read, and none of those need the app's own
 * keys.
 *
 * It costs a nonce and a `chacha20poly1305` call to do better, so it is done:
 * the blob on disk is sealed under a key that never leaves the platform
 * keystore. Unpairing deletes the key, which makes every copy of the file
 * unreadable rather than merely deleted — the one property a plain file
 * cannot offer.
 *
 * A fresh nonce per write, from the caller, because this file is rewritten on
 * every copy under one long-lived key: reusing a counter from zero the way
 * `filecrypt` does for a single stream would be reusing a nonce, and two
 * histories XORed together are one history in the clear.
 */
import { chacha20poly1305 } from '@noble/ciphers/chacha.js'

import type { ClipboardEvent, FileEvent } from '../api/link'
import { MAX_CLIPBOARD_EVENTS } from './clipboard'

/**
 * How many arrivals and departures are kept.
 *
 * Thirty, as it has always been in `api/link` — this is that constant, moved
 * here so the rule that trims the list and the rule that reads it back off
 * the disk cannot drift apart.
 */
export const MAX_FILE_EVENTS = 30

/** The two lists that outlive the process. */
export type History = {
  clipboard: ClipboardEvent[]
  files: FileEvent[]
}

export const NO_HISTORY: History = { clipboard: [], files: [] }

/**
 * The file list with the newest arrival at its head.
 *
 * Unlike the clipboard there is no identity to move: two files with the same
 * name are two transfers, and the desktop sending the same file twice is two
 * things that happened, each with its own time and its own offer.
 */
export function rememberFile(history: FileEvent[], event: FileEvent): FileEvent[] {
  return [event, ...history].slice(0, MAX_FILE_EVENTS)
}

/* ── on and off the disk ─────────────────────────────────────────────── */

/** The version tag, so a blob written by a build that thought differently is dropped rather than misread. */
const VERSION = 1

export function packHistory(history: History): string {
  return JSON.stringify({
    version: VERSION,
    clipboard: history.clipboard.slice(0, MAX_CLIPBOARD_EVENTS),
    files: history.files.slice(0, MAX_FILE_EVENTS),
  })
}

/**
 * The history a blob describes, read the way `loadLook` reads a preferences
 * blob: leniently, and never throwing at the caller.
 *
 * Every entry is checked for the fields the Share screen indexes by, because
 * a row with no `at` is a row that says `Invalid Date` and a clipboard entry
 * that is neither text nor an offer is a row with nothing on it. The caps are
 * applied again on the way in: a file written by a build with a bigger buffer
 * must not come back as a list this build never trims.
 */
export function parseHistory(raw: string | null | undefined): History {
  try {
    if (!raw) return { ...NO_HISTORY }
    const saved = JSON.parse(raw) as Partial<History> & { version?: number }
    if (saved?.version !== VERSION) return { ...NO_HISTORY }
    return {
      clipboard: (Array.isArray(saved.clipboard) ? saved.clipboard : []).filter(isClipboardEvent).slice(0, MAX_CLIPBOARD_EVENTS),
      files: (Array.isArray(saved.files) ? saved.files : []).filter(isFileEvent).slice(0, MAX_FILE_EVENTS),
    }
  } catch {
    return { ...NO_HISTORY }
  }
}

function isClipboardEvent(entry: unknown): entry is ClipboardEvent {
  if (!entry || typeof entry !== 'object') return false
  const e = entry as ClipboardEvent
  if (typeof e.at !== 'number' || !Number.isFinite(e.at)) return false
  // Text or an offer token — an entry with neither is a row the screen would
  // draw empty and a tap could do nothing with.
  return typeof e.text === 'string' || typeof e.token === 'string'
}

function isFileEvent(entry: unknown): entry is FileEvent {
  if (!entry || typeof entry !== 'object') return false
  const e = entry as FileEvent
  if (e.direction !== 'in' && e.direction !== 'out') return false
  return typeof e.name === 'string' && typeof e.size === 'number'
}

/* ── the seal ────────────────────────────────────────────────────────── */

/** "OCH1" — the same kind of tag `filecrypt` and `crypto` put in front of their bytes. */
export const MAGIC = new Uint8Array([0x4f, 0x43, 0x48, 0x31])
export const NONCE_BYTES = 12
const KEY_BYTES = 32

function keyBytes(hex: string): Uint8Array {
  const clean = (hex || '').trim().toLowerCase()
  if (clean.length !== KEY_BYTES * 2 || /[^0-9a-f]/.test(clean)) throw new Error('a history key is 32 hex bytes')
  const out = new Uint8Array(KEY_BYTES)
  for (let i = 0; i < KEY_BYTES; i += 1) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16)
  return out
}

/** Magic, the nonce it was sealed under, and the sealed JSON. */
export function sealHistory(keyHex: string, history: History, nonce: Uint8Array): Uint8Array {
  if (nonce.length !== NONCE_BYTES) throw new Error('a history nonce is 12 bytes')
  const body = chacha20poly1305(keyBytes(keyHex), nonce).encrypt(new TextEncoder().encode(packHistory(history)))
  const out = new Uint8Array(MAGIC.length + NONCE_BYTES + body.length)
  out.set(MAGIC, 0)
  out.set(nonce, MAGIC.length)
  out.set(body, MAGIC.length + NONCE_BYTES)
  return out
}

/**
 * The history inside a sealed blob, or an empty one.
 *
 * Nothing here throws. A blob under a key that has been rotated away, a file
 * half-written when the process died, a build that changed the format — all
 * of them mean the same thing to the screen, which is that there is no
 * history yet, and none of them is worth failing a launch over.
 */
export function openHistory(keyHex: string, blob: Uint8Array | null | undefined): History {
  try {
    if (!blob || blob.length <= MAGIC.length + NONCE_BYTES) return { ...NO_HISTORY }
    for (let i = 0; i < MAGIC.length; i += 1) if (blob[i] !== MAGIC[i]) return { ...NO_HISTORY }
    const nonce = blob.subarray(MAGIC.length, MAGIC.length + NONCE_BYTES)
    const body = blob.subarray(MAGIC.length + NONCE_BYTES)
    const plain = chacha20poly1305(keyBytes(keyHex), nonce).decrypt(body)
    return parseHistory(new TextDecoder().decode(plain))
  } catch {
    return { ...NO_HISTORY }
  }
}
