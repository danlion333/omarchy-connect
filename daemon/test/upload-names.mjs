/**
 * What a bad filename is allowed to cost.
 *
 * The upload endpoint decodes the name the phone sent, and the names phones
 * really send include `100%.txt` — a percent sign that is not the start of an
 * escape, which `decodeURIComponent` answers with a synchronous `URIError`.
 * That throw happened inside the `createServer` handler, where nothing was
 * catching it and the process had no `uncaughtException` handler at all, so
 * one awkward filename killed the daemon and every other device's socket
 * along with it. This suite is the fence around that: a bad request gets a
 * status code, everybody else keeps their connection, and an exception nobody
 * caught is a line in the log rather than the end of the process.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { check, done } from '../../tools/test-harness.mjs'
import { connectPhone } from './phone.mjs'
import { quietBluetooth, localHeaders } from './sandbox.mjs'

const PORT = Number(process.env.PORT || 8806)
const base = `http://127.0.0.1:${PORT}`
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'omarchy-connect-names-'))

// The local HTTP routes are gated on the secret the daemon publishes in its
// own status file, so every post below reads it the way the CLI does.
const local = () => localHeaders(path.join(sandbox, 'state'))
const downloads = path.join(sandbox, 'Downloads')
fs.mkdirSync(downloads, { recursive: true })
quietBluetooth(sandbox)

// A stand-in for libnotify ahead of the real one: one of the checks below
// really does receive a file, and the person running the suite should not get
// a desktop notification out of it.
const fakeBin = path.join(sandbox, 'bin')
fs.mkdirSync(fakeBin, { recursive: true })
fs.writeFileSync(path.join(fakeBin, 'notify-send'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })

// The inbox is derived from the environment at import time, so it has to be
// pointed at the sandbox before `share.js` is loaded — these checks are about
// the name a file gets, and none of them should leave anything in the real
// Downloads directory.
process.env.XDG_DOWNLOAD_DIR = downloads
const { inboxPathFor, INBOX } = await import('../src/plugins/share.js')

/* ── the name a file gets, before any of it reaches the disk ──────────── */

const CONTROL = /[\u0000-\u001f\u007f]/

const nulName = inboxPathFor('re\u0000port.pdf')
check('a NUL never reaches the inbox path', !CONTROL.test(nulName), JSON.stringify(path.basename(nulName)))
check('neither do the other control characters', !CONTROL.test(inboxPathFor('a\u0007b\u001bc.txt')),
  JSON.stringify(path.basename(inboxPathFor('a\u0007b\u001bc.txt'))))
check('what is left of the name is still the name', path.basename(nulName) === 'report.pdf',
  path.basename(nulName))
check('a name in Cyrillic survives intact', path.basename(inboxPathFor('звіт.pdf')) === 'звіт.pdf')
check('spaces survive too — this is the inbox, not a shell word',
  path.basename(inboxPathFor('quarterly report.pdf')) === 'quarterly report.pdf')
check('a name cannot climb out of the inbox', path.dirname(inboxPathFor('../../etc/passwd')) === INBOX,
  inboxPathFor('../../etc/passwd'))
check('a name that is nothing but dots still gets a file',
  path.basename(inboxPathFor('..')) === 'file', path.basename(inboxPathFor('..')))

/* ── a daemon, a phone, and one bad request ───────────────────────────── */

const daemon = spawn(process.execPath, [path.join(root, 'bin', 'omarchy-connect.js'), 'start', '--port', String(PORT)], {
  env: {
    ...process.env,
    PATH: `${fakeBin}:${process.env.PATH}`,
    HOME: sandbox,
    XDG_CONFIG_HOME: sandbox,
    XDG_DOWNLOAD_DIR: downloads,
    XDG_CACHE_HOME: path.join(sandbox, '.cache'),
    OMARCHY_CONNECT_STATE: path.join(sandbox, 'state'),
    OMARCHY_CONNECT_LOG: 'error',
  },
  stdio: ['ignore', 'ignore', 'inherit'],
})
process.on('exit', () => {
  daemon.kill('SIGTERM')
  fs.rmSync(sandbox, { recursive: true, force: true })
})

const alive = async () => {
  try {
    return (await fetch(`${base}/api/info`)).ok
  } catch {
    return false
  }
}

for (let i = 0; i < 40; i += 1) {
  if (await alive()) break
  await new Promise((r) => setTimeout(r, 250))
}

const info = await (await fetch(`${base}/api/info`)).json()
const pair = await (await fetch(`${base}/api/pair-code`, { method: 'POST', headers: local() })).json()
const phone = connectPhone(PORT, info.publicKey)
const pending = new Map()
let seq = 0

const req = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++seq
    pending.set(id, { resolve, reject })
    phone.send({ t: 'req', id, method, params })
    setTimeout(() => pending.has(id) && (pending.delete(id), reject(new Error(`${method} timed out`))), 8000)
  })

await new Promise((resolve, reject) => {
  phone.ready
    .then(() =>
      phone.send({
        t: 'hello',
        pairCode: pair.code,
        device: { id: 'names-test', name: 'Names Phone', platform: 'android' },
      }),
    )
    .catch(reject)
  phone.on((msg) => {
    if (msg.t === 'hello.ok') resolve(msg)
    if (msg.t === 'hello.err') reject(new Error(msg.error))
    if (msg.t === 'res') {
      const p = pending.get(msg.id)
      if (!p) return
      pending.delete(msg.id)
      msg.ok ? p.resolve(msg.data) : p.reject(new Error(msg.error))
    }
  })
  phone.ws.on('error', reject)
})

// A ticket per upload, asked for over the socket: the HTTP road no longer
// takes the device token at all.
const ticketFor = async (use) => (await req('share.ticket', { use })).ticket

const upload = async (name, body = 'hello') =>
  fetch(`${base}/api/upload`, {
    method: 'POST',
    headers: { 'x-oc-ticket': await ticketFor('upload'), 'x-oc-filename': name },
    body,
  })

const percent = await upload('100%.txt')
const percentBody = await percent.json().catch(() => ({}))
check('an upload named 100%.txt gets an answer, not a dead socket',
  percent.status === 400 || percent.status === 500, `HTTP ${percent.status}`)
check('and the answer says what was wrong with it', typeof percentBody.error === 'string', percentBody.error)

const truncated = await upload('%E4%')
check('so does a name cut off mid-escape', truncated.status === 400 || truncated.status === 500,
  `HTTP ${truncated.status}`)

check('the daemon is still up afterwards', await alive())

// The socket that did *not* send the bad request is the one this is about.
check('the other device is still connected', phone.ws.readyState === 1, `readyState ${phone.ws.readyState}`)
const stats = await req('system.stats').then((s) => Boolean(s?.memory), () => false)
check('and it can still be asked for something', stats)

/* ── a control character, all the way through the real endpoint ───────── */

const sneaky = await upload(encodeURIComponent('sne\u0000ak\u001by.txt'), 'payload')
const landed = await sneaky.json().catch(() => ({}))
check('a name with a NUL is accepted and cleaned rather than refused', sneaky.ok, `HTTP ${sneaky.status}`)
check('the file on disk has no control characters in its name',
  typeof landed.name === 'string' && !CONTROL.test(landed.name), JSON.stringify(landed.name))
check('and it really is in the inbox under that name',
  fs.existsSync(path.join(downloads, 'Omarchy Connect', String(landed.name))), String(landed.name))

/* ── a request the router itself cannot parse ─────────────────────────── */

// A Host header that is not a host makes `new URL` throw before any route has
// looked at the request — the other way into the same crash.
const rawReply = await new Promise((resolve) => {
  const sock = net.connect(PORT, '127.0.0.1', () => {
    sock.write('GET /api/info HTTP/1.1\r\nHost: not a host\r\nConnection: close\r\n\r\n')
  })
  let buf = ''
  sock.on('data', (d) => (buf += d))
  sock.on('close', () => resolve(buf))
  sock.on('error', () => resolve(''))
  setTimeout(() => {
    sock.destroy()
    resolve(buf)
  }, 4000)
})
check('a request the router cannot even parse gets a status line back', /^HTTP\/1\.1 \d{3}/.test(rawReply),
  rawReply.split('\r\n')[0] || 'nothing came back')
check('the daemon survives that too', await alive())

/* ── the last resort: an exception nobody caught ──────────────────────── */

// Not thrown at the running daemon — there is no route left that would do it,
// which is the point — but at the same guard, installed in a process of its
// own that then throws from a timer with no `try` above it.
const guardSource = [
  `import { installCrashGuard } from ${JSON.stringify(path.join(root, 'src', 'lib', 'guard.js'))}`,
  `installCrashGuard({ label: 'daemon' })`,
  `setTimeout(() => { throw new Error('boom from a timer') }, 10)`,
  `Promise.reject(new Error('nobody awaited this'))`,
  `setTimeout(() => { console.log('STILL-ALIVE'); process.exit(0) }, 500)`,
].join('\n')

const guarded = await new Promise((resolve) => {
  const child = spawn(process.execPath, ['--input-type=module', '-e', guardSource], {
    env: { ...process.env, OMARCHY_CONNECT_LOG: 'error' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let out = ''
  let err = ''
  child.stdout.on('data', (d) => (out += d))
  child.stderr.on('data', (d) => (err += d))
  child.on('exit', (code) => resolve({ code, out, err }))
})
check('a throw from a timer does not end the process', guarded.out.includes('STILL-ALIVE'), `exit ${guarded.code}`)
check('it is logged, loudly, with its stack',
  guarded.err.includes('uncaught exception') && guarded.err.includes('boom from a timer'))
check('an unhandled rejection is logged the same way', guarded.err.includes('unhandled rejection'))

phone.ws.close()
daemon.kill('SIGTERM')
done('bad-filename checks')
