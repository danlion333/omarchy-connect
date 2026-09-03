import fs from 'node:fs'
import path from 'node:path'
import { OMARCHY_NOTIFICATIONS } from '../lib/paths.js'
import { run, has, notifyArgs } from '../lib/exec.js'
import { log } from '../lib/log.js'

let watcher = null
const seen = new Set()

function readOne(file) {
  try {
    const raw = fs.readFileSync(path.join(OMARCHY_NOTIFICATIONS, file), 'utf8')
    const n = JSON.parse(raw)
    return {
      id: String(n.id ?? file),
      app: n.app || 'system',
      summary: n.summary || '',
      body: n.body || '',
      urgency: n.urgency ?? 0,
      timestamp: n.timestamp || Date.now(),
    }
  } catch {
    return null
  }
}

function listRecent(limit = 30) {
  let files = []
  try {
    files = fs.readdirSync(OMARCHY_NOTIFICATIONS).filter((f) => f.endsWith('.json'))
  } catch {
    return []
  }
  return files
    .map(readOne)
    .filter(Boolean)
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, limit)
}

export default {
  name: 'notifications',

  capabilities() {
    return { mirror: fs.existsSync(OMARCHY_NOTIFICATIONS), send: has('notify-send') }
  },

  start(bus) {
    if (!fs.existsSync(OMARCHY_NOTIFICATIONS)) {
      log.warn('omarchy notification history not found — mirroring disabled')
      return
    }
    // Seed the dedupe set so a restart does not replay the backlog to phones.
    for (const n of listRecent(100)) seen.add(n.id + n.timestamp)
    try {
      watcher = fs.watch(OMARCHY_NOTIFICATIONS, { persistent: false }, (_evt, file) => {
        if (!file || !file.endsWith('.json')) return
        setTimeout(() => {
          const n = readOne(file)
          if (!n) return
          const key = n.id + n.timestamp
          if (seen.has(key)) return
          seen.add(key)
          bus.emit('event', 'notification', n)
        }, 60) // let the writer finish before we read
      })
    } catch (err) {
      log.warn('notification watch failed:', err.message)
    }
  },

  stop() {
    watcher?.close()
    watcher = null
  },

  methods: {
    'notifications.list'({ limit } = {}) {
      return { items: listRecent(Math.min(Number(limit) || 30, 100)) }
    },

    async 'notifications.send'({ summary, body, urgency }) {
      if (!summary) throw new Error('summary required')
      if (!has('notify-send')) throw new Error('notify-send not installed')
      const flags = ['-a', 'Omarchy Connect']
      if (urgency) flags.push('-u', String(urgency))
      const res = await run('notify-send', notifyArgs(flags, summary, body || null))
      if (!res.ok) throw new Error(res.stderr || 'notify-send failed')
      return { ok: true }
    },
  },
}
