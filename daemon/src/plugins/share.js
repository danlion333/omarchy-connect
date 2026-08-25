import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { XDG_DOWNLOAD } from '../lib/paths.js'
import { has, spawnDetached, wlCopy } from '../lib/exec.js'
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

/** Never overwrite: `report.pdf` becomes `report (2).pdf`. */
function uniquePath(dir, name) {
  const safe = path.basename(name).replace(/[/\\]/g, '_') || 'file'
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
    spawnDetached('notify-send', ['-a', 'Omarchy Connect', 'File received', name])
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
          spawnDetached('notify-send', ['-a', 'Omarchy Connect', 'Copied from phone', text.slice(0, 120)])
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
