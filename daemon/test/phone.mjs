/**
 * The phone half of the encrypted channel, written against Node's own crypto
 * rather than the daemon's module. Two independent implementations agreeing is
 * what makes the protocol test worth running — a shared helper would only
 * prove the daemon agrees with itself.
 */
import crypto from 'node:crypto'
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
          const msg = JSON.parse(plain.toString())
          for (const listener of listeners) listener(msg)
        })
        resolve()
      } catch (err) {
        reject(err)
      }
    })
  })

  const send = (obj) => {
    const cipher = crypto.createCipheriv('chacha20-poly1305', sendKey, nonce(sendCounter), { authTagLength: 16 })
    const body = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(obj))), cipher.final()])
    sendCounter += 1n
    ws.send(Buffer.concat([body, cipher.getAuthTag()]), { binary: true })
  }

  return { ws, ready, send, on: (fn) => listeners.push(fn), close: () => ws.close() }
}
