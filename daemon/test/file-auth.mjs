/**
 * What the HTTP file roads will accept, and what they will not.
 *
 * `/api/upload` and `/api/download/` used to be authorised by the device
 * token — the credential a phone gets when it pairs, and the one that lets
 * anybody holding it run their own key exchange on `/ws` and drive the
 * desktop. It rode in the `x-oc-token` header on every upload and, worse, in
 * the query string of every download, where it settles into proxy logs and
 * URL history and outlives the transfer by years. TLS is off until somebody
 * turns it on, so both went out in cleartext on the default configuration:
 * one afternoon of passive listening on a café network for the whole box.
 *
 * Now the credential never leaves the encrypted socket. A transfer asks that
 * socket for a ticket — one use, one direction, two minutes — and the HTTP
 * side takes the ticket and nothing else. This suite is the fence around
 * that: the token buys nothing on either road, a ticket works exactly once,
 * a ticket for the other direction is refused, and the whole thing shuts with
 * remote access the way the WebSocket does.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { check, done } from '../../tools/test-harness.mjs'
import { connectPhone } from './phone.mjs'
import { quietBluetooth, localHeaders } from './sandbox.mjs'

const PORT = Number(process.env.PORT || 8809)
const base = `http://127.0.0.1:${PORT}`
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'omarchy-connect-file-auth-'))

// The local HTTP routes are gated on the secret the daemon publishes in its
// own status file, so every post below reads it the way the CLI does.
const local = () => localHeaders(path.join(sandbox, 'state'))
const downloads = path.join(sandbox, 'Downloads')
fs.mkdirSync(downloads, { recursive: true })
quietBluetooth(sandbox)

// Nothing here should raise a desktop notification on the machine running it.
const fakeBin = path.join(sandbox, 'bin')
fs.mkdirSync(fakeBin, { recursive: true })
fs.writeFileSync(path.join(fakeBin, 'notify-send'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })

// The daemon starts with remote access on and the loopback declared an
// overlay, so every request this suite makes arrives "over the tunnel" as far
// as the server is concerned. That is the state that is hard to reach by hand
// and easy to get wrong, and it is the state the last two checks need.
fs.mkdirSync(path.join(sandbox, 'omarchy-connect'), { recursive: true })
fs.writeFileSync(
  path.join(sandbox, 'omarchy-connect', 'config.json'),
  JSON.stringify({ port: PORT, remote: { enabled: true }, devices: [] }, null, 2),
)

let daemon = null
const stop = () => {
  if (daemon && !daemon.killed) daemon.kill('SIGTERM')
  fs.rmSync(sandbox, { recursive: true, force: true })
}
process.on('exit', stop)

daemon = spawn(process.execPath, [path.join(root, 'bin', 'omarchy-connect.js'), 'start', '--port', String(PORT)], {
  env: {
    ...process.env,
    PATH: `${fakeBin}:${process.env.PATH}`,
    XDG_CONFIG_HOME: sandbox,
    XDG_DOWNLOAD_DIR: downloads,
    OMARCHY_CONNECT_STATE: path.join(sandbox, 'state'),
    OMARCHY_CONNECT_LOG: 'warn',
    OMARCHY_CONNECT_FAKE_OVERLAY: '127.0.0.1',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
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
let seq = 0
let token = null

const req = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++seq
    pending.set(id, { resolve, reject })
    phone.send({ t: 'req', id, method, params })
    setTimeout(() => pending.has(id) && (pending.delete(id), reject(new Error(`${method} timed out`))), 8000)
  })

await new Promise((resolve, reject) => {
  phone.on((msg) => {
    if (msg.t === 'paired') token = msg.token
    if (msg.t === 'hello.ok') resolve(msg)
    if (msg.t === 'hello.err') reject(new Error(msg.error))
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
        device: { id: 'ticket-phone', name: 'Ticket Phone', platform: 'android' },
      }),
    )
    .catch(reject)
})

const ticketFor = async (use) => (await req('share.ticket', { use })).ticket

/* ── the ticket itself ──────────────────────────────────────────────────── */

const minted = await req('share.ticket', { use: 'upload' })
check('the socket mints a ticket', typeof minted.ticket === 'string' && minted.ticket.length >= 32,
  `${String(minted.ticket).length} chars`)
check('it is short-lived and says so', minted.expiresAt - Date.now() <= 5 * 60 * 1000 && minted.ttlMs > 0,
  `${Math.round((minted.expiresAt - Date.now()) / 1000)}s`)
check('and it is not the device token', minted.ticket !== token)

const wrongUse = await req('share.ticket', { use: 'whatever' }).then(() => null, (e) => e.message)
check('a ticket for a direction that does not exist is refused', /unknown ticket use/.test(String(wrongUse)), String(wrongUse))

/* ── upload ─────────────────────────────────────────────────────────────── */

const upload = (headers, body = 'ticket test payload') =>
  fetch(`${base}/api/upload`, { method: 'POST', headers: { 'x-oc-filename': 'ticket.txt', ...headers }, body })

check('an upload with nothing at all is refused', (await upload({})).status === 401)
check('the device token in the header buys nothing', (await upload({ 'x-oc-token': token })).status === 401)
check('nor does it in the query',
  (await fetch(`${base}/api/upload?token=${token}&name=ticket.txt`, { method: 'POST', body: 'x' })).status === 401)
check('a made-up ticket is refused', (await upload({ 'x-oc-ticket': 'a'.repeat(43) })).status === 401)

const goodTicket = await ticketFor('upload')
const uploaded = await upload({ 'x-oc-ticket': goodTicket })
const uploadedBody = await uploaded.json()
check('a ticket carries the file', uploaded.ok && uploadedBody.size > 0, `${uploadedBody.name} · ${uploadedBody.size}B`)
check('and it is spent — the same ticket a second time is refused',
  (await upload({ 'x-oc-ticket': goodTicket })).status === 401)

check('a download ticket does not open the upload road',
  (await upload({ 'x-oc-ticket': await ticketFor('download') })).status === 401)

/* ── download ───────────────────────────────────────────────────────────── */

const offer = await (
  await fetch(`${base}/api/offer`, {
    method: 'POST',
    headers: local(),
    body: JSON.stringify({ path: path.join(root, 'package.json') }),
  })
).json()
check('the desktop has a file to offer', typeof offer.token === 'string', offer.name)

const download = (headers, query = '') => fetch(`${base}/api/download/${offer.token}${query}`, { headers })

check('a download with nothing at all is refused', (await download({})).status === 401)
check('the device token in the query buys nothing', (await download({}, `?token=${token}`)).status === 401)
check('nor does it in the header', (await download({ 'x-oc-token': token })).status === 401)
check('an upload ticket does not open the download road',
  (await download({ 'x-oc-ticket': await ticketFor('upload') })).status === 401)

const downloadTicket = await ticketFor('download')
const got = await download({ 'x-oc-ticket': downloadTicket })
const bytes = await got.text()
check('a ticket fetches the offered file', got.ok && bytes.includes('omarchy-connect'), `${bytes.length} bytes`)
check('and that one is spent too', (await download({ 'x-oc-ticket': downloadTicket })).status === 401)

/* ── and the gate the WebSocket has always had ──────────────────────────── */

// Minted while remote is still on, so what the last two checks measure is the
// road being shut and not the ticket being refused.
const remoteUpload = await ticketFor('upload')
const remoteDownload = await ticketFor('download')

const control = (op) =>
  fetch(`${base}/api/remote/control`, {
    method: 'POST',
    headers: local(),
    body: JSON.stringify({ op }),
  }).then((r) => r.json())

const off = await control('disable')
check('remote access goes off', off.ok === true && off.remote.enabled === false)

const refusedUpload = await upload({ 'x-oc-ticket': remoteUpload })
const refusedUploadBody = await refusedUpload.json().catch(() => ({}))
check('with remote off an upload over the tunnel is refused', refusedUpload.status === 403, `HTTP ${refusedUpload.status}`)
check('and the refusal names the fix, the way the hello does',
  /remote access is off/.test(refusedUploadBody.error || '') && /omarchy-connect remote on/.test(refusedUploadBody.error || ''),
  refusedUploadBody.error)
check('a download over the tunnel is refused too',
  (await download({ 'x-oc-ticket': remoteDownload })).status === 403)

await control('enable')

done('file-transfer auth checks')
