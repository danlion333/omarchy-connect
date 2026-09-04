import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { XDG_DOWNLOAD } from '../lib/paths.js'
import { has, spawnDetached, wlCopy, notifyArgs } from '../lib/exec.js'
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

export function announceReceivedFile(filePath, { open = false } = {}) {
  const name = path.basename(filePath)
  if (has('notify-send')) {
    spawnDetached('notify-send', notifyArgs(['-a', 'Omarchy Connect'], 'File received', name))
  }
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
