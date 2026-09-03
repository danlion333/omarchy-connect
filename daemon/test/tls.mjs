// TLS end to end: a daemon serving https + wss, and a phone that pins its
// certificate. Kept apart from the smoke suite because it needs a daemon
// started differently, not because it tests anything less important.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import https from 'node:https'
import http from 'node:http'
import crypto from 'node:crypto'
import { spawn, execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { quietBluetooth, localHeaders } from './sandbox.mjs'

import { connectPhone } from './phone.mjs'

const PORT = Number(process.env.PORT || 8798)
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const entry = path.join(root, 'bin', 'omarchy-connect.js')

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'omarchy-connect-tls-'))

// The local HTTP routes are gated on the secret the daemon publishes in its
// own status file, so every post below reads it the way the CLI does.
const local = () => localHeaders(path.join(sandbox, 'state'))
const env = {
  ...process.env,
  XDG_CONFIG_HOME: sandbox,
  OMARCHY_CONNECT_STATE: path.join(sandbox, 'state'),
  OMARCHY_CONNECT_LOG: 'warn',
}

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`)
}

let daemon = null
process.on('exit', () => {
  daemon?.kill('SIGTERM')
  fs.rmSync(sandbox, { recursive: true, force: true })
})

const cli = (...args) => execFileSync(process.execPath, [entry, ...args], { env, encoding: 'utf8' })

/** Verified against the desktop's own certificate — never a disabled check. */
const get = (pathname, ca) =>
  new Promise((resolve) => {
    const req = https.request({ host: '127.0.0.1', port: PORT, path: pathname, ca, timeout: 4000 }, (res) => {
      let text = ''
      res.on('data', (c) => (text += c))
      res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(text) }))
    })
    req.on('timeout', () => req.destroy(new Error('timeout')))
    req.on('error', (err) => resolve({ status: 0, error: err }))
    req.end()
  })

cli('tls', 'enable')
cli('config', 'port', String(PORT))

const certPath = path.join(sandbox, 'omarchy-connect', 'tls', 'cert.pem')
const ca = fs.readFileSync(certPath)
const spki = new crypto.X509Certificate(ca).publicKey.export({ type: 'spki', format: 'der' })
const expectedPin = crypto.createHash('sha256').update(spki).digest('base64')

quietBluetooth(sandbox)
daemon = spawn(process.execPath, [entry, 'start'], { env, stdio: ['ignore', 'ignore', 'inherit'] })

let info = null
for (let i = 0; i < 40; i += 1) {
  const res = await get('/api/info', ca)
  if (res.status === 200) {
    info = res.json
    break
  }
  await new Promise((r) => setTimeout(r, 250))
}
check('https serves /api/info', info?.app === 'omarchy-connect', `${info?.name} v${info?.version}`)
check('the daemon says it is behind TLS', info?.tls === true)
check('the pin it publishes is its certificate', info?.certPin === expectedPin, info?.certPin)

// A phone that has not pinned this certificate gets nothing, which is the
// whole point — this is the check an attacker on the LAN has to beat.
const unpinned = await get('/api/info', undefined)
check('an unpinned client is rejected', unpinned.status === 0, unpinned.error?.code || 'no answer')

// So does anything that expects plaintext on the same port.
const plaintext = await new Promise((resolve) => {
  const req = http.request({ host: '127.0.0.1', port: PORT, path: '/api/info', timeout: 3000 }, (res) =>
    resolve(res.statusCode),
  )
  req.on('timeout', () => req.destroy(new Error('timeout')))
  req.on('error', () => resolve(0))
  req.end()
})
check('plain http is not served', plaintext === 0)

/* ── a phone pairing over wss ──────────────────────────────────────────── */

const codeRes = await new Promise((resolve) => {
  const req = https.request(
    { host: '127.0.0.1', port: PORT, path: '/api/pair-code', method: 'POST', ca, timeout: 4000, headers: local() },
    (res) => {
      let text = ''
      res.on('data', (c) => (text += c))
      res.on('end', () => resolve(JSON.parse(text)))
    },
  )
  req.on('error', () => resolve(null))
  req.end()
})
check('POST /api/pair-code over https', /^\d{6}$/.test(codeRes?.code || ''))

const phone = connectPhone(PORT, info.publicKey, { tls: true, ca })
const hello = await new Promise((resolve, reject) => {
  phone.ready
    .then(() => {
      phone.on((msg) => {
        if (msg.t === 'hello.ok') resolve(msg)
        if (msg.t === 'hello.err') reject(new Error(msg.error))
      })
      phone.send({
        t: 'hello',
        pairCode: codeRes.code,
        device: { id: 'tls-test-device', name: 'TLS Phone', platform: 'android' },
      })
    })
    .catch(reject)
  setTimeout(() => reject(new Error('no hello')), 8000)
}).catch((err) => err)

check('wss carries the encrypted handshake', hello?.secure === true, hello?.message || hello?.fingerprint)
check('the identity fingerprint is unchanged by TLS', hello?.fingerprint === info.fingerprint)

/* ── a new address must not break what phones pinned ───────────────────── */

const before = cli('tls', 'status')
cli('tls', 'refresh')
const after = cli('tls', 'status')
const pinOf = (text) => text.split('\n').find((line) => line.includes('PIN'))
check('refreshing the certificate keeps the pin', pinOf(before) === pinOf(after), 'same key, new certificate')

phone.close()
const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} TLS checks passed`)
process.exit(failed.length ? 1 : 0)
