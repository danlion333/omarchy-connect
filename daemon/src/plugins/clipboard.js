import { run, has, spawn, wlCopy } from '../lib/exec.js'
import { log } from '../lib/log.js'

const MAX_BYTES = 256 * 1024

let lastSeen = null
let watcher = null

async function readClipboard() {
  if (!has('wl-paste')) return null
  const types = await run('wl-paste', ['--list-types'])
  const isText = !types.ok || /text\/plain|text\/uri-list|STRING/i.test(types.stdout)
  if (!isText) {
    const mime = types.stdout.split('\n')[0] || 'application/octet-stream'
    return { kind: 'binary', mime, text: null }
  }
  const res = await run('wl-paste', ['--no-newline', '-t', 'text/plain'])
  if (!res.ok) return null
  const text = res.stdout
  if (Buffer.byteLength(text) > MAX_BYTES) {
    return { kind: 'text', text: text.slice(0, MAX_BYTES), truncated: true }
  }
  return { kind: 'text', text, truncated: false }
}

export default {
  name: 'clipboard',

  capabilities() {
    return { read: has('wl-paste'), write: has('wl-copy') }
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
      if (!clip || clip.kind !== 'text' || !clip.text) return
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
      if (!has('wl-copy')) throw new Error('wl-copy not installed')
      lastSeen = text
      await wlCopy(text)
      return { ok: true, bytes: Buffer.byteLength(text) }
    },
  },
}
