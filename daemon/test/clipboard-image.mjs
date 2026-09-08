/**
 * A picture on the desktop clipboard, and how it reaches the phone.
 *
 * `readClipboard` has always been able to tell that the clipboard is holding
 * something that is not text — and then nothing downstream did anything with
 * it. The watcher dropped the change, `clipboard.get` answered with a shape
 * whose `text` was null, and a screenshot had to go through a manual file
 * share to get to the handset that was going to hand it to an agent.
 *
 * What replaces that is deliberately not a new road: the bytes are spooled to
 * the cache and registered as an ordinary file offer, so the phone gets a
 * token and fetches the picture over `/api/download/<token>` behind the same
 * one-use ticket as everything else. This suite is the fence around that —
 * the event carries a token, the token really fetches those exact bytes, the
 * same answer comes back from `clipboard.get`, a clipboard too big to carry
 * says so instead of lying, and text — echo suppression included — behaves
 * exactly as it did before.
 *
 * The Wayland clipboard is a stand-in on PATH, as in `otp.mjs`, for two
 * reasons: a suite must not overwrite the clipboard of whoever is running it,
 * and `wl-paste --watch` really does fire on every change no matter who made
 * it, which is the behaviour the echo check exists for.
 */
import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { check, done } from '../../tools/test-harness.mjs'
import { connectPhone } from './phone.mjs'
import { quietBluetooth, localHeaders } from './sandbox.mjs'

const PORT = Number(process.env.PORT || 8817)
const base = `http://127.0.0.1:${PORT}`
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'omarchy-connect-clipboard-'))
const local = () => localHeaders(path.join(sandbox, 'state'))
const downloads = path.join(sandbox, 'Downloads')
fs.mkdirSync(downloads, { recursive: true })
quietBluetooth(sandbox)

/* ── the stand-in clipboard ─────────────────────────────────────────────── */

const fakeBin = path.join(sandbox, 'bin')
fs.mkdirSync(fakeBin, { recursive: true })
fs.writeFileSync(path.join(fakeBin, 'notify-send'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })

const clipFile = path.join(sandbox, 'clipboard')
const typesFile = path.join(sandbox, 'types')
fs.writeFileSync(clipFile, '')
fs.writeFileSync(typesFile, 'text/plain\n')

/**
 * What the desktop copies, as far as the daemon can tell.
 *
 * Written beside and renamed into place, never written in place. A real
 * clipboard hands over a whole selection or none of it; a file being filled
 * with 33 MB can be read halfway through by the watcher polling every tenth of
 * a second, and what the daemon then sees is a picture that is genuinely
 * shorter than the one that was copied. That is not the behaviour under test —
 * it made this suite fail one run in every few, under load, on a check about
 * the spool — and `rename(2)` inside one directory is what makes the change
 * happen all at once.
 */
function copy(content, types = 'text/plain\n') {
  const staged = `${clipFile}.staged`
  fs.writeFileSync(typesFile, types)
  fs.writeFileSync(staged, content)
  fs.renameSync(staged, clipFile)
}

// `wl-copy` is the desktop copying text — it puts the clipboard back to text,
// which is what the real one does and what the echo check below depends on.
fs.writeFileSync(
  path.join(fakeBin, 'wl-copy'),
  ['#!/bin/sh', `printf 'text/plain\\n' > ${JSON.stringify(typesFile)}`, `cat > ${JSON.stringify(clipFile)}`, ''].join(
    '\n',
  ),
  { mode: 0o755 },
)

fs.writeFileSync(
  path.join(fakeBin, 'wl-paste'),
  [
    '#!/bin/sh',
    'case " $* " in',
    '  *" --watch "*)',
    '    shift',
    // Content rather than mtime, as in the OTP suite: whole-second comparisons
    // miss two copies made inside the same second.
    `    seen=${JSON.stringify(path.join(sandbox, 'clipseen'))}`,
    `    cp ${JSON.stringify(clipFile)} "$seen"`,
    '    while true; do',
    `      if ! cmp -s ${JSON.stringify(clipFile)} "$seen"; then`,
    `        cp ${JSON.stringify(clipFile)} "$seen"`,
    '        "$@"',
    '      fi',
    '      sleep 0.1',
    '    done ;;',
    `  *--list-types*) cat ${JSON.stringify(typesFile)} ;;`,
    `  *) cat ${JSON.stringify(clipFile)} ;;`,
    'esac',
    '',
  ].join('\n'),
  { mode: 0o755 },
)

/* ── the daemon ─────────────────────────────────────────────────────────── */

let daemon = null
process.on('exit', () => {
  if (daemon && !daemon.killed) daemon.kill('SIGTERM')
  // The daemon may still be finishing a write in there as it goes down.
  fs.rmSync(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

daemon = spawn(process.execPath, [path.join(root, 'bin', 'omarchy-connect.js'), 'start', '--port', String(PORT)], {
  env: {
    ...process.env,
    PATH: `${fakeBin}:${process.env.PATH}`,
    XDG_CONFIG_HOME: sandbox,
    XDG_CACHE_HOME: path.join(sandbox, 'cache'),
    XDG_DOWNLOAD_DIR: downloads,
    OMARCHY_CONNECT_STATE: path.join(sandbox, 'state'),
    OMARCHY_CONNECT_LOG: 'error',
  },
  stdio: ['ignore', 'ignore', 'pipe'],
})
daemon.stderr.on('data', (chunk) => {
  const line = String(chunk)
  if (/error/i.test(line)) process.stderr.write(line)
})

async function info() {
  for (let i = 0; i < 40; i += 1) {
    try {
      const res = await fetch(`${base}/api/info`)
      if (res.ok) return res.json()
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error('the daemon never came up')
}

const desktop = await info()
const pair = await (await fetch(`${base}/api/pair-code`, { method: 'POST', headers: local() })).json()

const phone = connectPhone(PORT, desktop.publicKey)
const pending = new Map()
const events = []
let seq = 0

const req = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++seq
    pending.set(id, { resolve, reject })
    phone.send({ t: 'req', id, method, params })
    setTimeout(() => pending.has(id) && (pending.delete(id), reject(new Error(`${method} timed out`))), 8000)
  })

await new Promise((resolve, reject) => {
  phone.on((msg) => {
    if (msg.t === 'hello.ok') resolve(msg)
    if (msg.t === 'hello.err') reject(new Error(msg.error))
    if (msg.t === 'ev' && msg.event === 'clipboard') events.push(msg.data)
    if (msg.t === 'res') {
      const p = pending.get(msg.id)
      if (!p) return
      pending.delete(msg.id)
      msg.ok ? p.resolve(msg.data) : p.reject(new Error(msg.error))
    }
  })
  phone.ready
    .then(() =>
      phone.send({
        t: 'hello',
        pairCode: pair.code,
        device: { id: 'clip-phone', name: 'Clip Phone', platform: 'android' },
      }),
    )
    .catch(reject)
})

phone.send({ t: 'sub', events: ['clipboard'] })
await new Promise((r) => setTimeout(r, 300))

/** The next clipboard event, or null if the desktop stayed quiet. */
async function nextEvent(ms = 4000) {
  const from = events.length
  for (let waited = 0; waited < ms; waited += 100) {
    if (events.length > from) return events[events.length - 1]
    await new Promise((r) => setTimeout(r, 100))
  }
  return null
}

const ticket = async (use) => (await req('share.ticket', { use })).ticket
const download = async (token) =>
  fetch(`${base}/api/download/${token}`, { headers: { 'x-oc-ticket': await ticket('download') } })

/* ── text, exactly as before ────────────────────────────────────────────── */

copy('a plain copied sentence')
const textEvent = await nextEvent()
check('copying text still publishes it', textEvent?.kind === 'text' && textEvent.text === 'a plain copied sentence')

/* ── a picture ──────────────────────────────────────────────────────────── */

// A real 1×1 PNG: the point is that the bytes that come back are these bytes,
// and that nothing between here and there decoded them as text on the way.
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)
const digest = crypto.createHash('sha256').update(png).digest('hex')

copy(png, 'image/png\n')
const imageEvent = await nextEvent()
check('copying an image publishes an event too', imageEvent?.kind === 'binary', String(imageEvent?.kind))
check('it says what the picture is', imageEvent?.mime === 'image/png', String(imageEvent?.mime))
check('it carries no bytes of its own', imageEvent?.text === null)
check(
  'it carries a download token instead',
  typeof imageEvent?.token === 'string' && imageEvent.token.length >= 32,
  String(imageEvent?.token).slice(0, 12),
)
check(
  'with a name the phone can guess a picture from, and a size',
  /\.png$/.test(String(imageEvent?.name)) && imageEvent?.size === png.length,
  `${imageEvent?.name} · ${imageEvent?.size}B`,
)

const fetched = await download(imageEvent.token)
const got = Buffer.from(await fetched.arrayBuffer())
check(
  'the token fetches the picture over the download road that already existed',
  fetched.ok && crypto.createHash('sha256').update(got).digest('hex') === digest,
  `${got.length}B`,
)

const asked = await req('clipboard.get')
check('clipboard.get answers with the same offer shape', asked.kind === 'binary' && asked.mime === 'image/png')
check('and the same token, because the bytes have not changed', asked.token === imageEvent.token)
check('the download road is the only way to the bytes', asked.text === null)

/* ── a picture too big to carry ─────────────────────────────────────────── */

// 33 MB, one over the ceiling. What matters is that the answer says so rather
// than looking like an empty clipboard — and that the daemon is still there.
copy(Buffer.alloc(33 * 1024 * 1024, 7), 'image/png\n')
const huge = await req('clipboard.get')
check('a clipboard too large to carry is refused, not faked',
  huge.kind === 'binary' && huge.token === null, huge.reason)
check('and it says why', /large/.test(String(huge.reason)), String(huge.reason))

/* ── text again, echo included ──────────────────────────────────────────── */

copy('back to text')
const backToText = await nextEvent()
check('text after a picture is published as text', backToText?.kind === 'text' && backToText.text === 'back to text')

// `clipboard.set` is the route that claims the text first — the same claim the
// OTP copier goes through — so a code copied off a mirrored SMS never travels
// back to the handset that sent it.
const before = events.length
await req('clipboard.set', { text: 'this came off the phone' })
const echo = await nextEvent(2500)
check('what the phone copied does not sail back to it',
  echo === null && events.length === before, `${events.length - before} events`)

const after = await req('clipboard.get')
check('the desktop clipboard really did change', after.kind === 'text' && after.text === 'this came off the phone')

/* ── the spool ──────────────────────────────────────────────────────────── */

const spool = path.join(sandbox, 'cache', 'omarchy-connect', 'clipboard')
const spooled = fs.existsSync(spool) ? fs.readdirSync(spool) : []
check('the picture waits in the cache, not in the inbox', spooled.length === 1, spooled.join(', '))
check('and nothing was filed in Downloads', fs.readdirSync(downloads).length === 0)

phone.close()
done()
