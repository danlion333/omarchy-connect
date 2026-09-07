import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { XDG_DOWNLOAD } from '../lib/paths.js'
import { pathToFileURL } from 'node:url'
import { has, spawn, spawnDetached, wlCopy, notifyArgs } from '../lib/exec.js'
import { drawsButtons, watchSweep } from '../lib/cards.js'
import { claimBytes } from './clipboard.js'
import { newKey, SCHEME } from '../lib/filecrypt.js'
import { log } from '../lib/log.js'

export const INBOX = path.join(XDG_DOWNLOAD, 'Omarchy Connect')

/** Files the desktop has offered to phones, keyed by a one-time token. */
const offers = new Map()
const OFFER_TTL = 30 * 60 * 1000

function sweepOffers() {
  const now = Date.now()
  for (const [token, offer] of offers) if (offer.expiresAt < now) offers.delete(token)
}

export function offerFile(filePath) {
  const resolved = path.resolve(filePath)
  const stat = fs.statSync(resolved)
  if (!stat.isFile()) throw new Error('not a regular file')
  sweepOffers()
  const token = crypto.randomBytes(24).toString('hex')
  offers.set(token, {
    path: resolved,
    name: path.basename(resolved),
    size: stat.size,
    expiresAt: Date.now() + OFFER_TTL,
  })
  return { token, name: path.basename(resolved), size: stat.size }
}

export function resolveOffer(token) {
  sweepOffers()
  return offers.get(token) || null
}

/**
 * Tickets: what the HTTP file routes accept instead of the device token.
 *
 * The token a phone gets when it pairs is the whole of its identity — hand it
 * to anyone listening and they can run their own key exchange on `/ws` and
 * own the desktop. It used to ride on every upload as `x-oc-token` and on
 * every download as `?token=…`, and with TLS off (which is the default) both
 * went out in cleartext; the query one also settled into proxy logs and URL
 * history, where it outlives the transfer by years.
 *
 * So the credential stays on the encrypted channel, and the phone asks it for
 * a ticket per transfer: 32 random bytes, good for one request, two minutes,
 * and one direction. Losing one to a sniffer costs nothing — it cannot be
 * replayed, it cannot be turned into a socket, and it is worthless by the
 * time anyone has read it out of a log.
 *
 * A ticket now carries a second secret the same way: 32 bytes of key material
 * the body is sealed under (`lib/filecrypt.js`). It is minted here rather than
 * derived from the socket's own channel keys so that it belongs to exactly one
 * transfer and dies with the ticket, and because the HTTP route has a ticket in
 * its hand and no socket. It only ever exists on the encrypted channel and in
 * the two processes at the ends of it.
 */
const tickets = new Map()
const TICKET_TTL = 2 * 60 * 1000

function sweepTickets() {
  const now = Date.now()
  for (const [value, ticket] of tickets) if (ticket.expiresAt < now) tickets.delete(value)
}

export function issueTicket(deviceId, use) {
  sweepTickets()
  const value = crypto.randomBytes(32).toString('base64url')
  const key = newKey()
  const expiresAt = Date.now() + TICKET_TTL
  tickets.set(value, { deviceId, use, key, expiresAt })
  return { ticket: value, use, key, scheme: SCHEME, expiresAt, ttlMs: TICKET_TTL }
}

/**
 * Answers with the device the ticket was minted for and the key its body is
 * sealed under, or null — and either way the ticket is gone. Deleting before
 * the checks is deliberate: a ticket that was presented for the wrong
 * direction, or after it expired, has been seen by somebody, and a seen
 * ticket is spent whatever it bought.
 */
export function redeemTicket(value, use) {
  sweepTickets()
  if (typeof value !== 'string' || !value) return null
  const ticket = tickets.get(value)
  if (!ticket) return null
  tickets.delete(value)
  if (ticket.expiresAt < Date.now()) return null
  if (ticket.use !== use) return null
  return { deviceId: ticket.deviceId, key: ticket.key }
}

/** For the suites: nothing outstanding between one daemon and the next. */
export function forgetTickets() {
  tickets.clear()
}

/**
 * The inbox keeps the name the phone chose, minus the parts of it that are
 * not really a name.
 *
 * Unlike an agent drop — which is going to be typed at a prompt as a bare
 * word, and so gets flattened to `[A-Za-z0-9._-]` — a received file is for
 * the person, and `звіт за березень.pdf` should still be called that when
 * they open the inbox. What cannot survive is anything that is not filename
 * material at all: a NUL, which `fs` refuses with a synchronous throw, and
 * the other control characters, which arrive invisible and make a file nobody
 * can name in a shell. Separators go too, so a name can never climb out of
 * the inbox.
 */
function safeInboxName(raw) {
  // eslint-disable-next-line no-control-regex
  const stripped = String(raw ?? '').replace(/[\u0000-\u001f\u007f]/g, '')
  return path.basename(stripped).replace(/[/\\]/g, '_').replace(/^\.+$/, '') || 'file'
}

/** Never overwrite: `report.pdf` becomes `report (2).pdf`. */
function uniquePath(dir, name) {
  const safe = safeInboxName(name)
  const ext = path.extname(safe)
  const stem = safe.slice(0, safe.length - ext.length)
  let candidate = path.join(dir, safe)
  let n = 2
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${stem} (${n})${ext}`)
    n += 1
  }
  return candidate
}

export function inboxPathFor(name) {
  fs.mkdirSync(INBOX, { recursive: true })
  return uniquePath(INBOX, name)
}

/**
 * How large a received file may be before the clipboard stops carrying its
 * bytes. The same 32 MiB a copied picture is carried under in the other
 * direction (`plugins/clipboard.js`); above it the file is offered as a
 * `text/uri-list` like any non-picture, which pastes the file itself and
 * costs nothing to hold.
 */
const COPY_MAX_BYTES = 32 * 1024 * 1024

/**
 * Pictures the clipboard can hand over as bytes.
 *
 * Only pictures, and only by extension. What an editor or a chat window means
 * by "paste an image" is the decoded picture, and it asks the clipboard for it
 * by MIME type — so a `.png` has to arrive as `image/png` or it arrives as
 * nothing. Everything else is better as the file: a PDF pasted into a chat
 * should be the attachment, not a screenful of bytes.
 */
const IMAGE_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.tiff': 'image/tiff',
  '.tif': 'image/tiff',
  '.svg': 'image/svg+xml',
}

/** The picture type of a file, or null if it is not one we hand over as bytes. */
function imageTypeOf(filePath) {
  return IMAGE_TYPES[path.extname(filePath).toLowerCase()] || null
}

/**
 * Put the file itself on the clipboard — the file, not its path.
 *
 * A picture goes as its own bytes under its own type, so it pastes into an
 * editor or a chat window as the picture. Everything else goes as
 * `text/uri-list` holding one `file://` URL, which is what a file manager,
 * a mail client and a browser upload field all read as "this file" — pasting
 * it into Nautilus copies the file, not a line of text.
 *
 * Through `claimBytes` rather than `wl-copy` because the clipboard plugin is
 * watching: an unclaimed write is republished as a fresh desktop copy, and the
 * file would go straight back to the phone that had just sent it.
 */
export async function copyReceivedFile(filePath) {
  const mime = imageTypeOf(filePath)
  let stat = null
  try {
    stat = fs.statSync(filePath)
  } catch (err) {
    log.warn(`could not copy the received file: ${err.message}`)
    return null
  }
  if (mime && stat.size <= COPY_MAX_BYTES) {
    try {
      await claimBytes(fs.readFileSync(filePath), mime)
      log.ok('copied to the clipboard:', path.basename(filePath), `(${mime})`)
      return mime
    } catch (err) {
      log.warn(`could not copy the picture: ${err.message}`)
      return null
    }
  }
  try {
    await claimBytes(Buffer.from(`${pathToFileURL(filePath).href}\r\n`, 'utf8'), 'text/uri-list')
    log.ok('copied to the clipboard:', path.basename(filePath), '(text/uri-list)')
    return 'text/uri-list'
  } catch (err) {
    log.warn(`could not copy the received file: ${err.message}`)
    return null
  }
}

/**
 * The card a file arrives on, and the two things it can now do.
 *
 * A file that has just come off a phone is wanted in the next five seconds —
 * opened, or pasted into whatever window is already in front of you — and
 * until now the card announcing it could do neither: the only ways to the file
 * were the inbox button in the panel and `openFilesOnReceive`, which opens
 * every file whether you wanted this one or not. So the card becomes the
 * remote control the ringing call's card already is: `notify-send -A` holds
 * the notification open and prints the name of whatever was clicked.
 *
 * `default` is registered alongside the named pair because some servers draw
 * no buttons and only run the action a click invokes; on those the body says
 * what the two gestures are, and the right mouse button — which libnotify
 * never reports — is read off the bus as a sweep (`lib/cards.js`).
 *
 * When `openFilesOnReceive` has already opened the file, Open is not offered:
 * the card would be inviting you to do the thing that has just been done.
 */
function raiseFileCard(filePath, { opened }) {
  const name = path.basename(filePath)
  const buttons = drawsButtons()
  const actions = opened
    ? ['-A', 'default=Copy', '-A', 'copy=Copy']
    : ['-A', 'default=Open', '-A', 'open=Open', '-A', 'copy=Copy']
  // Only where there are no buttons to press, and only where there is
  // something for the sweep to mean.
  const watch = buttons ? null : watchSweep(() => void copyReceivedFile(filePath))
  const gestures = watch ? (opened ? 'click to copy' : 'click to open, right-click to copy') : null
  const child = spawn(
    'notify-send',
    notifyArgs(['-a', 'Omarchy Connect', '-p', ...actions], 'File received', gestures ? `${name} · ${gestures}` : name),
    { stdio: ['ignore', 'pipe', 'ignore'] },
  )
  child.on('error', () => watch?.stop())
  child.stdout.setEncoding('utf8')
  let printed = ''
  child.stdout.on('data', (chunk) => {
    printed += chunk
    // `-p` prints the server's id first; the clicked action, if there is one,
    // follows on a later line. The id is what lets the sweep watch know which
    // card on this desktop is ours.
    const first = printed.split('\n', 1)[0].trim()
    if (/^\d+$/.test(first)) watch?.card(Number(first))
  })
  child.on('exit', () => {
    watch?.stop()
    const clicked = printed
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line === 'default' || line === 'open' || line === 'copy')
    if (!clicked) return
    if (clicked === 'copy' || (opened && clicked === 'default')) {
      void copyReceivedFile(filePath)
      return
    }
    if (has('xdg-open')) spawnDetached('xdg-open', [filePath])
  })
  // A card waiting for a click is not a reason for the daemon to stay up.
  child.unref()
}

export function announceReceivedFile(filePath, { open = false } = {}) {
  if (has('notify-send')) raiseFileCard(filePath, { opened: open && has('xdg-open') })
  if (open && has('xdg-open')) spawnDetached('xdg-open', [filePath])
  log.ok('received file:', filePath)
}

export default {
  name: 'share',

  capabilities() {
    return { receiveFiles: true, sendFiles: true, inbox: INBOX, clipboard: has('wl-copy') }
  },

  methods: {
    async 'share.text'({ text, action = 'clipboard' }) {
      if (typeof text !== 'string' || !text) throw new Error('text required')
      if (action === 'clipboard') {
        if (!has('wl-copy')) throw new Error('wl-copy not installed')
        await wlCopy(text)
        if (has('notify-send')) {
          spawnDetached('notify-send', notifyArgs(['-a', 'Omarchy Connect'], 'Copied from phone', text.slice(0, 120)))
        }
        return { ok: true, action }
      }
      if (action === 'file') {
        const target = inboxPathFor(`shared-${Date.now()}.txt`)
        fs.writeFileSync(target, text)
        announceReceivedFile(target)
        return { ok: true, action, path: target }
      }
      throw new Error(`unknown action: ${action}`)
    },

    /**
     * A one-use pass for one HTTP file transfer, in the direction it names,
     * and the key that transfer's body is sealed under. Only reachable over
     * the WebSocket, which is encrypted end to end and already knows which
     * device is asking — which is the whole point: neither the long-lived
     * credential nor the content key ever has to leave that channel.
     */
    'share.ticket'({ use = 'upload' } = {}, ctx = {}) {
      if (use !== 'upload' && use !== 'download') throw new Error(`unknown ticket use: ${use}`)
      const deviceId = ctx.device?.id
      if (!deviceId) throw new Error('not authenticated')
      return issueTicket(deviceId, use)
    },

    'share.offers'() {
      sweepOffers()
      return {
        offers: [...offers.entries()].map(([token, o]) => ({
          token,
          name: o.name,
          size: o.size,
          expiresAt: o.expiresAt,
        })),
      }
    },

    'share.inbox'({ limit = 20 } = {}) {
      let entries = []
      try {
        entries = fs.readdirSync(INBOX)
      } catch {
        return { path: INBOX, items: [] }
      }
      const items = entries
        .map((name) => {
          try {
            const stat = fs.statSync(path.join(INBOX, name))
            return stat.isFile() ? { name, size: stat.size, at: stat.mtimeMs } : null
          } catch {
            return null
          }
        })
        .filter(Boolean)
        .sort((a, b) => b.at - a.at)
        .slice(0, Math.min(Number(limit) || 20, 100))
      return { path: INBOX, items }
    },
  },
}
