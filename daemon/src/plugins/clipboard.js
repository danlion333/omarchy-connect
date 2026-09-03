import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

import { run, has, spawn, wlCopy, capture } from '../lib/exec.js'
import { XDG_CACHE } from '../lib/paths.js'
import { log } from '../lib/log.js'
import { offerFile, resolveOffer } from './share.js'

const MAX_BYTES = 256 * 1024

/**
 * How large a copied picture may be before the desktop stops carrying it.
 *
 * The text ceiling above cannot be the same number for both: 256 KiB is a
 * generous paragraph and a small screenshot, so a shared limit would mean the
 * feature silently not working for the one thing it exists for. 32 MiB is
 * what an agent drop already allows in the other direction — the same picture
 * travelling the other way — and above it a clipboard is holding something
 * that is a file transfer wearing a disguise, which the share screen does
 * better than a clipboard event ever will.
 */
const MAX_BINARY_BYTES = 32 * 1024 * 1024

/**
 * Where a copied picture waits while the phone decides whether to fetch it.
 *
 * The cache, for the reason agent drops are in the cache: nobody copied a
 * screenshot in order to keep a file, and `~/Downloads` is a directory people
 * really look at. The lifetime is the offer's lifetime — a token nobody can
 * redeem any more is a file nobody can ask for — plus a count, so an hour of
 * copying screenshots cannot fill a disk. Both are enforced on the way in,
 * because a daemon that has stopped copying things has nothing left to sweep
 * for and a timer that fires anyway is a wakeup for nothing.
 */
const SPOOL = path.join(XDG_CACHE, 'omarchy-connect', 'clipboard')
const SPOOL_TTL_MS = 60 * 60 * 1000
const SPOOL_MAX_FILES = 20

let lastSeen = null
/** The token of the last binary clipboard published, for the same echo check. */
let lastBinaryToken = null
/** The picture currently spooled: content hash, path, and its standing offer. */
let spooled = null
let watcher = null

/**
 * What to call the file, given only a MIME type.
 *
 * The extension is not decoration: the phone picks a preview, the gallery
 * picks a decoder and an agent decides whether it is looking at a picture,
 * all from the end of the name. A type this list does not know still gets its
 * subtype rather than `.bin`, because `image/avif` is more use to everything
 * downstream than nothing at all.
 */
const EXTENSIONS = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/bmp': '.bmp',
  'image/tiff': '.tiff',
  'image/svg+xml': '.svg',
  'application/pdf': '.pdf',
}

function extensionFor(mime) {
  if (EXTENSIONS[mime]) return EXTENSIONS[mime]
  const subtype = String(mime || '').split('/')[1] || ''
  const clean = subtype.split(/[+;]/)[0].replace(/[^A-Za-z0-9]/g, '')
  return clean ? `.${clean.toLowerCase().slice(0, 8)}` : '.bin'
}

/**
 * Which of the offered types to ask for.
 *
 * A compositor lists everything the source can produce, and a screenshot tool
 * often advertises more than one flavour of the same image. An `image/*` is
 * what this is for, so it wins over whatever happened to be listed first.
 */
function pickBinaryType(listing) {
  const types = String(listing || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  return types.find((type) => type.startsWith('image/')) || types[0] || 'application/octet-stream'
}

function sweepSpool() {
  const now = Date.now()
  let names = []
  try {
    names = fs.readdirSync(SPOOL)
  } catch {
    return
  }
  const files = names
    .map((name) => {
      try {
        const file = path.join(SPOOL, name)
        const stat = fs.statSync(file)
        return stat.isFile() ? { path: file, at: stat.mtimeMs } : null
      } catch {
        return null
      }
    })
    .filter(Boolean)
    .sort((a, b) => b.at - a.at)
  for (const [i, file] of files.entries()) {
    if (now - file.at <= SPOOL_TTL_MS && i < SPOOL_MAX_FILES) continue
    try {
      fs.rmSync(file.path, { force: true })
    } catch (err) {
      log.debug('could not sweep a clipboard spool file:', err.message)
    }
  }
}

/**
 * Bytes on the clipboard become a file the phone can already fetch.
 *
 * No new road: this is `offerFile`, the same one the share screen and the
 * `file` event use, so the picture comes down `/api/download/<token>` behind
 * the same one-use ticket as everything else, and lands in the phone's hands
 * as something it already knows how to preview, save and hand to an agent.
 *
 * Identical bytes keep their token. The watcher fires on every clipboard
 * change, and a compositor will happily announce the same picture twice — a
 * fresh token each time would mean two rows on the phone for one copy, two
 * spool files, and a second fetch of a screenshot it already has.
 */
function offerBytes(bytes, mime) {
  const hash = crypto.createHash('sha256').update(bytes).digest('hex')
  if (spooled?.hash === hash && resolveOffer(spooled.offer.token) && fs.existsSync(spooled.path)) {
    return spooled.offer
  }
  fs.mkdirSync(SPOOL, { recursive: true, mode: 0o700 })
  sweepSpool()
  const file = path.join(SPOOL, `clipboard-${Date.now()}-${hash.slice(0, 8)}${extensionFor(mime)}`)
  fs.writeFileSync(file, bytes, { mode: 0o600 })
  const offer = offerFile(file)
  spooled = { hash, path: file, offer }
  return offer
}

async function readClipboard() {
  if (!has('wl-paste')) return null
  const types = await run('wl-paste', ['--list-types'])
  const isText = !types.ok || /text\/plain|text\/uri-list|STRING/i.test(types.stdout)
  if (!isText) {
    const mime = pickBinaryType(types.stdout)
    const got = await capture('wl-paste', ['--no-newline', '-t', mime], { limit: MAX_BINARY_BYTES })
    // A picture nobody can fetch is still worth answering with: a caller
    // asking `clipboard.get` deserves to be told the desktop is holding an
    // image it will not carry, rather than a shape that looks like an empty
    // clipboard. `token: null` is what says so.
    if (!got.ok || !got.bytes?.length) {
      const reason = got.tooLarge ? 'too large' : got.error || 'unreadable'
      log.debug('clipboard holds', mime, 'but it was not carried:', reason)
      return { kind: 'binary', mime, text: null, token: null, reason }
    }
    return { kind: 'binary', mime, text: null, ...offerBytes(got.bytes, mime) }
  }
  const res = await run('wl-paste', ['--no-newline', '-t', 'text/plain'])
  if (!res.ok) return null
  const text = res.stdout
  if (Buffer.byteLength(text) > MAX_BYTES) {
    return { kind: 'text', text: text.slice(0, MAX_BYTES), truncated: true }
  }
  return { kind: 'text', text, truncated: false }
}

/**
 * Put text on the clipboard as if the user had copied it.
 *
 * The `lastSeen` write is the whole reason this is not a bare `wlCopy`. The
 * watcher fires on every clipboard change including ours, and a change it does
 * not recognise is published to the phone as "the desktop copied something" —
 * so a one-time code copied off a mirrored SMS would sail straight back to the
 * handset it came from. Claiming the text first makes that echo silent.
 */
export async function claim(text) {
  if (!has('wl-copy')) throw new Error('wl-copy not installed')
  lastSeen = text
  await wlCopy(text)
  return { ok: true, bytes: Buffer.byteLength(text) }
}

export default {
  name: 'clipboard',

  capabilities() {
    return { read: has('wl-paste'), write: has('wl-copy'), binary: has('wl-paste') }
  },

  start(bus) {
    if (!has('wl-paste')) {
      log.warn('wl-paste missing — clipboard sync disabled')
      return
    }
    // `wl-paste --watch` fires a command on every clipboard change. Use it as a
    // bare signal and read the content ourselves, so multi-line payloads stay intact.
    watcher = spawn('wl-paste', ['--watch', 'printf', 'x'], { stdio: ['ignore', 'pipe', 'ignore'] })
    watcher.stdout.on('data', async () => {
      const clip = await readClipboard()
      if (!clip) return
      if (clip.kind === 'binary') {
        // Nothing fetchable is nothing to say. And the token is the echo
        // check for this side: identical bytes keep theirs, so a compositor
        // announcing the same picture twice publishes it once.
        if (!clip.token || clip.token === lastBinaryToken) return
        lastBinaryToken = clip.token
        bus.emit('event', 'clipboard', { ...clip, source: 'desktop', at: Date.now() })
        return
      }
      if (!clip.text) return
      if (clip.text === lastSeen) return
      lastSeen = clip.text
      bus.emit('event', 'clipboard', { ...clip, source: 'desktop', at: Date.now() })
    })
    watcher.on('error', (err) => log.warn('clipboard watcher:', err.message))
    watcher.on('exit', (code) => log.debug('clipboard watcher exited', String(code)))
  },

  stop() {
    watcher?.kill()
    watcher = null
  },

  methods: {
    async 'clipboard.get'() {
      const clip = await readClipboard()
      if (!clip) throw new Error('clipboard unavailable')
      return clip
    },

    async 'clipboard.set'({ text }) {
      if (typeof text !== 'string') throw new Error('text required')
      if (Buffer.byteLength(text) > MAX_BYTES) throw new Error('clipboard payload too large')
      return claim(text)
    },
  },
}
