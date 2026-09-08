/**
 * The phone half of the encrypted channel, written against Node's own crypto
 * rather than the daemon's module. Two independent implementations agreeing is
 * what makes the protocol test worth running — a shared helper would only
 * prove the daemon agrees with itself.
 */
import crypto from 'node:crypto'

import { isSpeakerFrame, parseFrame as parseSpeakerFrame } from '../src/lib/speaker.js'
import WebSocket from 'ws'

const MAGIC = Buffer.from('OCX1')
const SPKI = Buffer.from('302a300506032b656e032100', 'hex')
const PKCS8 = Buffer.from('302e020100300506032b656e04220420', 'hex')
const INFO = Buffer.from('omarchy-connect v1 channel')

const toPublic = (raw) => crypto.createPublicKey({ key: Buffer.concat([SPKI, raw]), format: 'der', type: 'spki' })
const toPrivate = (raw) => crypto.createPrivateKey({ key: Buffer.concat([PKCS8, raw]), format: 'der', type: 'pkcs8' })

function nonce(counter) {
  const buf = Buffer.alloc(12)
  buf.writeBigUInt64BE(counter, 4)
  return buf
}

/** Opens an encrypted socket to the daemon, pinning `serverKeyHex`. */
export function connectPhone(port, serverKeyHex, { host = '127.0.0.1', tls = false, ca = null } = {}) {
  const server = Buffer.from(serverKeyHex, 'hex')
  const pair = crypto.generateKeyPairSync('x25519')
  const ePub = pair.publicKey.export({ type: 'spki', format: 'der' }).subarray(SPKI.length)
  const ePriv = pair.privateKey.export({ type: 'pkcs8', format: 'der' }).subarray(PKCS8.length)

  const ws = new WebSocket(`${tls ? 'wss' : 'ws'}://${host}:${port}/ws`, ca ? { ca } : undefined)
  const listeners = []
  const binaryListeners = []
  let sendKey = null
  let receiveKey = null
  let sendCounter = 0n
  let receiveCounter = 0n

  const ready = new Promise((resolve, reject) => {
    ws.on('open', () => ws.send(Buffer.concat([MAGIC, ePub]), { binary: true }))
    ws.on('error', reject)
    ws.on('close', (code, reason) => reject(new Error(`closed ${code} ${reason}`)))
    ws.once('message', (raw) => {
      try {
        const frame = Buffer.from(raw)
        if (frame.length !== 36 || !frame.subarray(0, 4).equals(MAGIC)) throw new Error('bad handshake reply')
        const serverEph = frame.subarray(4)
        const es = crypto.diffieHellman({ privateKey: toPrivate(ePriv), publicKey: toPublic(server) })
        const ee = crypto.diffieHellman({ privateKey: toPrivate(ePriv), publicKey: toPublic(serverEph) })
        const okm = Buffer.from(
          crypto.hkdfSync('sha256', Buffer.concat([es, ee]), Buffer.concat([ePub, serverEph]), INFO, 64),
        )
        sendKey = okm.subarray(0, 32)
        receiveKey = okm.subarray(32, 64)
        ws.on('message', (data) => {
          const cipher = Buffer.from(data)
          const body = cipher.subarray(0, cipher.length - 16)
          const tag = cipher.subarray(cipher.length - 16)
          const decipher = crypto.createDecipheriv('chacha20-poly1305', receiveKey, nonce(receiveCounter), {
            authTagLength: 16,
          })
          decipher.setAuthTag(tag)
          const plain = Buffer.concat([decipher.update(body), decipher.final()])
          receiveCounter += 1n
          // Not everything the desktop sends is a sentence any more. Since the
          // speaker road there are binary frames coming *down* as well as up,
          // told apart from JSON by four bytes, and a stand-in phone that ran
          // `JSON.parse` over one of those would throw inside a socket handler
          // and take the suite with it — which is exactly the bug the real app
          // had until `api/client.ts` learned the same branch.
          if (isSpeakerFrame(plain)) {
            const chunk = parseSpeakerFrame(plain)
            for (const listener of binaryListeners) listener(chunk)
            return
          }
          const msg = JSON.parse(plain.toString())
          for (const listener of listeners) listener(msg)
        })
        resolve()
      } catch (err) {
        reject(err)
      }
    })
  })

  /**
   * One frame, sealed. Everything the phone says goes through here — the JSON
   * of a request and the raw bytes of a chunk of microphone alike, because on
   * the wire they are the same encrypted frame and are told apart only by what
   * is inside it.
   */
  const sendBytes = (payload) => {
    const cipher = crypto.createCipheriv('chacha20-poly1305', sendKey, nonce(sendCounter), { authTagLength: 16 })
    const body = Buffer.concat([cipher.update(Buffer.from(payload)), cipher.final()])
    sendCounter += 1n
    ws.send(Buffer.concat([body, cipher.getAuthTag()]), { binary: true })
  }

  const send = (obj) => sendBytes(Buffer.from(JSON.stringify(obj)))

  return {
    ws,
    ready,
    send,
    sendBytes,
    on: (fn) => listeners.push(fn),
    /** Chunks of the desktop's own sound, for the suites that ask for them. */
    onChunk: (fn) => binaryListeners.push(fn),
    close: () => ws.close(),
  }
}
