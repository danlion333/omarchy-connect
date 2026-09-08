/**
 * The bytes of a file, on the wire, on the default configuration.
 *
 * Everything a phone says on `/ws` has been end-to-end encrypted for a long
 * time. The file *bodies* were not: `/api/upload` and `/api/download` are
 * plain HTTP on the same listener, and the only thing that would have covered
 * them was TLS, which is off on a fresh install and which an Expo Go build
 * cannot be made to trust at all. So a photo, a document and — worst of the
 * three — the audio of somebody dictating into their own machine went out in
 * the clear while the sentence that asked for the transfer did not.
 *
 * This is the fence around the fix. The upload body is sealed under a key that
 * came down with the ticket, so what a listener sees is `OCF1` and noise; the
 * file on the other side is byte-identical; the download comes back the same
 * way; a phone paired before any of this existed still transfers; and a body
 * that was edited, truncated or sealed under the wrong key is refused rather
 * than written to somebody's inbox.
 *
 * The wire is checked by holding the exact request body against the marker,
 * which is stronger than a packet capture and needs no root: these are the
 * bytes the socket is handed.
 */
import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { buffer } from 'node:stream/consumers'
import { fileURLToPath } from 'node:url'

import { check, done } from '../../tools/test-harness.mjs'
import { connectPhone } from './phone.mjs'
import { quietBluetooth, localHeaders } from './sandbox.mjs'
import { encryptStream, decryptStream, encryptedSize, CHUNK, HEADER, SCHEME } from '../src/lib/filecrypt.js'

const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex')
const through = async (bytes, transform) => buffer(Readable.from([bytes]).pipe(transform))

/* ── the framing on its own ─────────────────────────────────────────────── */

const key = crypto.randomBytes(32).toString('hex')

for (const size of [0, 1, 100, CHUNK - 1, CHUNK, CHUNK + 1, 3 * CHUNK + 7]) {
  const plain = crypto.randomBytes(size)
  const sealed = await through(plain, encryptStream(key))
  const opened = await through(sealed, decryptStream(key))
  check(`${size} bytes seal and open unchanged`, sha(opened) === sha(plain) && opened.length === size)
  check(`${size} bytes has the length the header promises`, sealed.length === encryptedSize(size),
    `${sealed.length} vs ${encryptedSize(size)}`)
}

// The one property the whole issue is about, at the smallest possible scale.
const marker = Buffer.from('MARKER-9f4c2a-the-secret-in-the-file')
const sealedMarker = await through(marker, encryptStream(key))
check('the sealed bytes do not contain the plaintext', !sealedMarker.includes(marker))
check('and they are recognisably a sealed body', sealedMarker.subarray(0, 4).toString() === 'OCF1')

const wrong = crypto.randomBytes(32).toString('hex')
const underWrongKey = await through(sealedMarker, decryptStream(wrong)).then(() => null, (e) => e.message)
check('another key does not open it', /could not decrypt/.test(String(underWrongKey)), String(underWrongKey))

const edited = Buffer.from(sealedMarker)
edited[edited.length - 1] ^= 0x01
const tampered = await through(edited, decryptStream(key)).then(() => null, (e) => e.message)
check('an edited body is refused', /could not decrypt/.test(String(tampered)), String(tampered))

// A stream cut on a frame boundary is the case a length alone would miss: the
// last frame is always short, so its absence is what says "this was cut".
const long = await through(crypto.randomBytes(2 * CHUNK), encryptStream(key))
const cut = await through(long.subarray(0, 8 + (CHUNK + 16)), decryptStream(key)).then(() => null, (e) => e.message)
check('a truncated body is refused rather than short', /truncated|could not decrypt/.test(String(cut)), String(cut))

/* ── and now over the real routes ───────────────────────────────────────── */

const PORT = Number(process.env.PORT || 8823)
const base = `http://127.0.0.1:${PORT}`
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'omarchy-connect-file-crypto-'))
const local = () => localHeaders(path.join(sandbox, 'state'))
const downloads = path.join(sandbox, 'Downloads')
fs.mkdirSync(downloads, { recursive: true })
quietBluetooth(sandbox)

const fakeBin = path.join(sandbox, 'bin')
fs.mkdirSync(fakeBin, { recursive: true })
fs.writeFileSync(path.join(fakeBin, 'notify-send'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })

fs.mkdirSync(path.join(sandbox, 'omarchy-connect'), { recursive: true })
// Nothing is turned on here: `tls` is left at its default, which is off. That
// is the configuration the claim is about.
fs.writeFileSync(
  path.join(sandbox, 'omarchy-connect', 'config.json'),
  JSON.stringify({ port: PORT, devices: [] }, null, 2),
)

let daemon = null
const stop = () => {
  if (daemon && !daemon.killed) daemon.kill('SIGTERM')
  fs.rmSync(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
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
check('TLS is off, as it is on a fresh install', desktop.tls !== true, `tls=${String(desktop.tls)}`)

const pair = await (await fetch(`${base}/api/pair-code`, { method: 'POST', headers: local() })).json()
const phone = connectPhone(PORT, desktop.publicKey)
const pending = new Map()
let seq = 0

const req = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++seq
    pending.set(id, { resolve, reject })
    phone.send({ t: 'req', id, method, params })
    setTimeout(() => pending.has(id) && (pending.delete(id), reject(new Error(`${method} timed out`))), 20000)
  })

await new Promise((resolve, reject) => {
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
  phone.ready
    .then(() =>
      phone.send({
        t: 'hello',
        pairCode: pair.code,
        device: { id: 'sealed-phone', name: 'Sealed Phone', platform: 'android' },
      }),
    )
    .catch(reject)
})

/* ── upload ─────────────────────────────────────────────────────────────── */

const passUp = await req('share.ticket', { use: 'upload' })
check('the ticket carries a content key', /^[0-9a-f]{64}$/.test(String(passUp.key)), `scheme=${passUp.scheme}`)

// A file with something in it worth not leaking, at a size that has to be
// framed rather than sealed in one go.
const secret = Buffer.concat([
  Buffer.from('MARKER-9f4c2a-the-secret-in-the-file\n'),
  crypto.randomBytes(CHUNK),
  Buffer.from('\nMARKER-9f4c2a-the-secret-in-the-file'),
])
const wire = await through(secret, encryptStream(passUp.key))
check('what goes on the wire has no plaintext marker in it', !wire.includes(Buffer.from('MARKER-9f4c2a')))

const uploaded = await (
  await fetch(`${base}/api/upload`, {
    method: 'POST',
    headers: { 'x-oc-ticket': passUp.ticket, 'x-oc-filename': 'sealed.bin', [HEADER]: SCHEME },
    body: wire,
  })
).json()
check('the desktop takes a sealed upload', uploaded.ok === true, JSON.stringify(uploaded))
check('and reports the size of the file, not of the frames', uploaded.size === secret.length,
  `${uploaded.size} vs ${secret.length}`)

const landed = fs.readFileSync(path.join(downloads, 'Omarchy Connect', uploaded.name))
check('the file in the inbox is byte-identical', sha(landed) === sha(secret), sha(landed).slice(0, 16))

/* ── download ───────────────────────────────────────────────────────────── */

const offered = path.join(sandbox, 'offered.bin')
fs.writeFileSync(offered, secret)
const offer = await (
  await fetch(`${base}/api/offer`, { method: 'POST', headers: local(), body: JSON.stringify({ path: offered }) })
).json()

const passDown = await req('share.ticket', { use: 'download' })
const got = await fetch(`${base}/api/download/${offer.token}`, {
  headers: { 'x-oc-ticket': passDown.ticket, [HEADER]: SCHEME },
})
const sealedDown = Buffer.from(await got.arrayBuffer())
check('the download says it is sealed', got.headers.get(HEADER) === SCHEME)
check('its content-length was exact', Number(got.headers.get('content-length')) === sealedDown.length,
  `${got.headers.get('content-length')} vs ${sealedDown.length}`)
check('and no marker crossed the wire', !sealedDown.includes(Buffer.from('MARKER-9f4c2a')))

const opened = await through(sealedDown, decryptStream(passDown.key))
check('the file the phone ends up with is byte-identical', sha(opened) === sha(secret), sha(opened).slice(0, 16))

/* ── the phone that has not been updated ────────────────────────────────── */

const oldPass = await req('share.ticket', { use: 'upload' })
const oldUpload = await (
  await fetch(`${base}/api/upload`, {
    method: 'POST',
    headers: { 'x-oc-ticket': oldPass.ticket, 'x-oc-filename': 'legacy.txt' },
    body: 'a phone that has never heard of OCF1',
  })
).json()
check('a phone that does not seal is still served', oldUpload.ok === true, JSON.stringify(oldUpload))

const oldOffer = await (
  await fetch(`${base}/api/offer`, { method: 'POST', headers: local(), body: JSON.stringify({ path: offered }) })
).json()
const oldDown = await fetch(`${base}/api/download/${oldOffer.token}`, {
  headers: { 'x-oc-ticket': (await req('share.ticket', { use: 'download' })).ticket },
})
const oldBytes = Buffer.from(await oldDown.arrayBuffer())
check('and still fetches, in the clear, exactly as before', sha(oldBytes) === sha(secret))
check('with nothing claiming it was sealed', oldDown.headers.get(HEADER) === null)

/* ── a body that is not what it says it is ──────────────────────────────── */

const badPass = await req('share.ticket', { use: 'upload' })
const badUpload = await fetch(`${base}/api/upload`, {
  method: 'POST',
  headers: { 'x-oc-ticket': badPass.ticket, 'x-oc-filename': 'liar.bin', [HEADER]: SCHEME },
  body: Buffer.concat([Buffer.from('OCF1'), Buffer.alloc(4, 0), crypto.randomBytes(200)]),
})
check('a body that will not open is refused', badUpload.status === 400, `${badUpload.status}`)
// The refusal is sent before the half-written file is unlinked, so give the
// daemon the moment it needs to tidy up before asking whether it did.
await new Promise((r) => setTimeout(r, 500))
check('and nothing of it is left in the inbox',
  !fs.existsSync(path.join(downloads, 'Omarchy Connect', 'liar.bin')))

// The daemon is still the daemon after all that.
check('the daemon is still answering', (await fetch(`${base}/api/info`)).ok)

phone.close?.()
done()
