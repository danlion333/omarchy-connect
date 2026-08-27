import http from 'node:http'
import https from 'node:https'
import fs from 'node:fs'
import crypto from 'node:crypto'
import { WebSocketServer } from 'ws'

import { log } from './lib/log.js'
import {
  loadConfig,
  newToken,
  upsertDevice,
  findDeviceByToken,
  touchDevice,
  removeDevice,
  pairedDevice,
} from './lib/config.js'
import { readTheme } from './lib/theme.js'
import { host as hostInfo } from './lib/sys.js'
import { isGeneric, nameFromNetwork } from './lib/hostname.js'
import { Bus } from './bus.js'
import { consumePairingCode, activePairing, createPairingCode } from './pairing.js'
import { buildMethodTable, collectCapabilities, startPlugins, stopPlugins } from './plugins/index.js'
import { inboxPathFor, announceReceivedFile, resolveOffer, offerFile } from './plugins/share.js'
import { accept as acceptHandshake, identity, fingerprint, SUITE } from './lib/crypto.js'
import { telemetryFor, forget as forgetTelemetry } from './plugins/device.js'
import {
  summary as phoneSummary,
  requestSend as requestSms,
  requestCall,
  trackConnections,
} from './plugins/phone.js'
import {
  summary as agentsSummary,
  hook as agentHook,
  setEnabled as setAgentsEnabled,
  agentsEnabled,
} from './plugins/agents.js'
import * as agentDrops from './agents/drops.js'
import { handsfree } from './lib/handsfree.js'
import { ancs } from './lib/ancs.js'
import * as state from './lib/state.js'
import * as firewall from './lib/firewall.js'
import * as tls from './lib/tls.js'
import * as sysinfo from './lib/sys.js'

export const PROTOCOL_VERSION = 2
const MAX_UPLOAD = 512 * 1024 * 1024
const MAX_MESSAGE = 1 * 1024 * 1024
const HEARTBEAT_MS = 20_000
export const DEFAULT_EVENTS = ['stats', 'clipboard', 'notification', 'theme', 'file', 'phone', 'agent']
const RECENT_TRANSFERS = 8
const FIREWALL_RECHECK_MS = 5 * 60 * 1000

const json = (res, status, body) => {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  })
  res.end(payload)
}

const isLoopback = (req) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)

export function createServer({ port, version = '0.1.0' } = {}) {
  const cfg = loadConfig()
  const listenPort = port || cfg.port || 8765
  // Minted (or renewed) before anything listens: a certificate that fails to
  // appear must stop the daemon rather than silently drop it back to plaintext
  // after the user asked for TLS.
  let certificate = tls.enabled() ? tls.ensure() : null
  const scheme = certificate ? 'https' : 'http'
  const bus = new Bus()
  const methods = buildMethodTable()
  const clients = new Set()

  /* ── desktop-client state ──────────────────────────────────────────────
   *
   * Everything the Omarchy shell panel draws is a projection of this. It is
   * republished on every change rather than polled, so the panel reacts the
   * moment a phone connects instead of on the next tick of a timer.
   */
  const counters = { filesIn: 0, filesOut: 0, notifications: 0 }
  const transfers = []
  let localAddress = null
  let firewallState = { blocked: false, tool: null, command: null }
  let firewallCheckedAt = 0

  function recordTransfer(entry) {
    transfers.unshift({ ...entry, at: Date.now() })
    transfers.length = Math.min(transfers.length, RECENT_TRANSFERS)
  }

  function snapshot() {
    const live = new Map()
    for (const client of clients) {
      if (client.device) live.set(client.device.id, client)
    }
    const base = state.baseSnapshot({ version, port: listenPort })
    return {
      ...base,
      running: true,
      pid: process.pid,
      host: localAddress,
      pairing: activePairing(),
      firewall: firewallState,
      scheme,
      tls: certificate
        ? { enabled: true, pin: certificate.pin, fingerprint: certificate.fingerprint, notAfter: certificate.notAfter }
        : { enabled: false, pin: null, fingerprint: null, notAfter: null },
      devices: base.devices.map((device) => {
        const client = live.get(device.id)
        const report = telemetryFor(device.id)
        return {
          ...device,
          online: Boolean(client),
          since: client ? client.since : null,
          address: client ? client.address : null,
          secure: client ? Boolean(client.secure) : null,
          battery: report?.battery ?? null,
          network: report?.network ?? null,
          reportedAt: report?.at ?? null,
        }
      }),
      transfers: [...transfers],
      counters: { ...counters },
      phone: phoneSummary(),
      agents: agentsSummary(),
    }
  }

  const publishState = () => state.publish(snapshot())

  /**
   * Whether any paired phone is on the network right now.
   *
   * Only one thing listens for this — the hands-free link, which holds the
   * Bluetooth profile open for as long as the handset is in the room — but it
   * is announced rather than reached for, because a socket lifecycle is the
   * server's business and what anyone does about it is not.
   */
  const announcePresence = () => {
    bus.emit('presence', [...clients].some((client) => client.device))
  }

  async function refreshEnvironment() {
    const net = await sysinfo.network().catch(() => null)
    const ip = net?.ip || null
    let changed = ip !== localAddress
    if (changed && certificate) refreshCertificate(ip)
    localAddress = ip

    // `ufw` is checked through a synchronous systemctl call, so it gets a
    // slow lane of its own rather than riding every republish.
    if (Date.now() - firewallCheckedAt > FIREWALL_RECHECK_MS) {
      firewallCheckedAt = Date.now()
      const next = firewall.check(listenPort, ip)
      if (next.blocked !== firewallState.blocked || next.command !== firewallState.command) changed = true
      firewallState = next
    }
    return changed
  }

  /**
   * A new DHCP lease means the certificate no longer names the address the
   * phone is dialling. Re-minting keeps the private key, so the pin the phone
   * is holding still matches and the swap is invisible to it.
   */
  function refreshCertificate(ip) {
    try {
      const next = tls.ensure()
      if (next.pin === certificate.pin && next.notAfter === certificate.notAfter) return
      certificate = next
      httpServer.setSecureContext({ key: certificate.key, cert: certificate.cert })
      log.info(`TLS certificate reissued for ${ip || 'this desktop'}`)
    } catch (err) {
      log.warn('could not reissue the TLS certificate:', err.message)
    }
  }

  /* ── HTTP ──────────────────────────────────────────────────────────── */

  function authFromRequest(req, url) {
    const token = req.headers['x-oc-token'] || url.searchParams.get('token')
    return findDeviceByToken(typeof token === 'string' ? token : null)
  }

  function handleHttp(req, res) {
    const url = new URL(req.url, `${scheme}://${req.headers.host || 'localhost'}`)

    // Unauthenticated: this is how the phone finds an Omarchy box on the subnet.
    if (req.method === 'GET' && url.pathname === '/api/info') {
      const key = identity().publicKey.toString('hex')
      return json(res, 200, {
        app: 'omarchy-connect',
        protocol: PROTOCOL_VERSION,
        version,
        name: cfg.deviceName,
        theme: readTheme(),
        pairing: Boolean(activePairing()),
        // A desktop holds one phone, so a sweep can tell the difference
        // between "nobody has paired yet" and "this one is taken" without
        // making the user find that out by failing to pair.
        paired: Boolean(pairedDevice()),
        publicKey: key,
        fingerprint: fingerprint(key),
        suite: SUITE,
        encryption: cfg.requireEncryption !== false ? 'required' : 'optional',
        tls: Boolean(certificate),
        certPin: certificate?.pin ?? null,
      })
    }

    // Localhost only: the CLI asks the running daemon for a fresh pairing code.
    if (req.method === 'POST' && url.pathname === '/api/pair-code') {
      if (!isLoopback(req)) return json(res, 403, { error: 'localhost only' })
      const pairing = createPairingCode()
      if (!pairing.ok) {
        return json(res, 409, { error: pairing.error, device: publicDevice(pairing.device) })
      }
      publishState()
      return json(res, 200, { code: pairing.code, expiresAt: pairing.expiresAt })
    }

    // Localhost only: the desktop client drops a paired phone. Going through
    // the daemon rather than editing the config directly is what makes the
    // removal take effect now — the running process holds a cached config and
    // an open socket that both have to be told.
    if (req.method === 'POST' && url.pathname === '/api/unpair') {
      if (!isLoopback(req)) return json(res, 403, { error: 'localhost only' })
      let body = ''
      req.on('data', (c) => {
        body += c
        if (body.length > 4096) req.destroy()
      })
      req.on('end', () => {
        try {
          const { id } = JSON.parse(body || '{}')
          if (!id) return json(res, 400, { error: 'id required' })
          const removed = removeDevice(id)
          if (!removed) return json(res, 404, { error: 'no such device' })
          forgetTelemetry(removed.id)
          for (const client of clients) {
            if (client.device?.id === removed.id) client.ws.close(4003, 'unpaired')
          }
          publishState()
          log.info(`unpaired ${removed.name}`)
          json(res, 200, { ok: true, device: publicDevice(removed) })
        } catch (err) {
          json(res, 400, { error: err.message })
        }
      })
      return undefined
    }

    // Localhost only: `omarchy-connect send <file>` offers a desktop file to phones.
    if (req.method === 'POST' && url.pathname === '/api/offer') {
      if (!isLoopback(req)) return json(res, 403, { error: 'localhost only' })
      let body = ''
      req.on('data', (c) => {
        body += c
        if (body.length > 8192) req.destroy()
      })
      req.on('end', () => {
        try {
          const { path: filePath } = JSON.parse(body || '{}')
          if (!filePath) return json(res, 400, { error: 'path required' })
          const offer = api.pushFile(filePath)
          json(res, 200, { ...offer, recipients: api.connections.length })
        } catch (err) {
          json(res, 400, { error: err.message })
        }
      })
      return undefined
    }

    // Localhost only: the desktop cannot send an SMS, so this asks the phone
    // to and answers with whatever the phone said back.
    if (req.method === 'POST' && url.pathname === '/api/sms') {
      if (!isLoopback(req)) return json(res, 403, { error: 'localhost only' })
      let body = ''
      req.on('data', (c) => {
        body += c
        if (body.length > 8192) req.destroy()
      })
      req.on('end', async () => {
        try {
          const { to, body: message } = JSON.parse(body || '{}')
          if (!api.connections.length) return json(res, 409, { error: 'no phone is connected' })
          const { outcome } = requestSms({ to, body: message })
          await outcome
          publishState()
          json(res, 200, { ok: true, to })
        } catch (err) {
          json(res, 400, { error: err.message })
        }
      })
      return undefined
    }

    /**
     * Answer, reject or place a call. Unlike `/api/sms` this does not require a
     * phone on the socket: when the handset is connected over Bluetooth the
     * daemon acts through the hands-free profile, which needs no app at all.
     */
    if (req.method === 'POST' && url.pathname === '/api/call') {
      if (!isLoopback(req)) return json(res, 403, { error: 'localhost only' })
      let body = ''
      req.on('data', (c) => {
        body += c
        if (body.length > 8192) req.destroy()
      })
      req.on('end', async () => {
        try {
          const { op, id = null, number = null, value = null } = JSON.parse(body || '{}')
          const result = await requestCall({ op, id, number, value })
          publishState()
          json(res, 200, { ok: true, ...result })
        } catch (err) {
          json(res, 400, { error: err.message })
        }
      })
      return undefined
    }

    /**
     * The iPhone side of Bluetooth: opening the window in which a phone will
     * agree to mirror its notifications here. Loopback only, like `/api/call`
     * — this makes the desktop discoverable, and that is not a decision for
     * anything reachable over the network.
     */
    if (req.method === 'POST' && url.pathname === '/api/ios') {
      if (!isLoopback(req)) return json(res, 403, { error: 'localhost only' })
      let body = ''
      req.on('data', (c) => {
        body += c
        if (body.length > 4096) req.destroy()
      })
      req.on('end', () => {
        try {
          const { op = 'status', seconds = null } = JSON.parse(body || '{}')
          if (op === 'pair') {
            const started = ancs.pair(seconds ? { seconds: Math.min(Math.max(seconds, 30), 600) } : {})
            publishState()
            return json(res, 200, { ok: true, ...started, ios: ancs.summary() })
          }
          if (op === 'stop') {
            const stopped = ancs.stopPairing()
            publishState()
            return json(res, 200, { ok: true, stopped, ios: ancs.summary() })
          }
          if (op === 'status') return json(res, 200, { ok: true, ios: ancs.summary() })
          return json(res, 400, { error: `unknown iOS action: ${op}` })
        } catch (err) {
          return json(res, 400, { error: err.message })
        }
      })
      return undefined
    }

    /**
     * Localhost only: a coding agent's own lifecycle hook, reporting in.
     *
     * This must never cost the agent anything. The hook fires and forgets, so
     * the answer is immediate and a payload we cannot make sense of is a 200
     * with an error inside rather than something that could make a hook look
     * like it failed.
     */
    if (req.method === 'POST' && url.pathname === '/api/agent/hook') {
      if (!isLoopback(req)) return json(res, 403, { error: 'localhost only' })
      let body = ''
      req.on('data', (c) => {
        body += c
        if (body.length > 64 * 1024) req.destroy()
      })
      req.on('end', () => {
        try {
          const result = agentHook(JSON.parse(body || '{}'))
          if (result.ok) publishState()
          json(res, 200, result)
        } catch (err) {
          json(res, 200, { ok: false, error: err.message })
        }
      })
      return undefined
    }

    /**
     * Localhost only: the switch the desktop panel flips.
     *
     * Reading an agent is the widest exposure this daemon offers, so the
     * decision stays on the desktop — this endpoint is reachable from
     * loopback and nowhere else, and no paired phone can turn on its own
     * ability to read. The daemon owns the write to the config file as well
     * as the live half, so a running daemon never needs restarting for the
     * change to take effect and the phone keeps its link across it.
     */
    if (req.method === 'POST' && url.pathname === '/api/agent/control') {
      if (!isLoopback(req)) return json(res, 403, { error: 'localhost only' })
      let body = ''
      req.on('data', (c) => {
        body += c
        if (body.length > 4096) req.destroy()
      })
      req.on('end', () => {
        try {
          const { op = 'status' } = JSON.parse(body || '{}')
          if (op !== 'enable' && op !== 'disable' && op !== 'status') {
            return json(res, 400, { error: `unknown agent action: ${op}` })
          }
          const agents = op === 'status' ? agentsSummary() : setAgentsEnabled(op === 'enable')
          publishState()
          json(res, 200, { ok: true, agents })
        } catch (err) {
          json(res, 400, { error: err.message })
        }
      })
      return undefined
    }

    if (req.method === 'POST' && url.pathname === '/api/upload') {
      const device = authFromRequest(req, url)
      if (!device) return json(res, 401, { error: 'unauthorized' })
      return receiveUpload(req, res, url, device)
    }

    if (req.method === 'GET' && url.pathname.startsWith('/api/download/')) {
      const device = authFromRequest(req, url)
      if (!device) return json(res, 401, { error: 'unauthorized' })
      return sendOffer(req, res, url.pathname.slice('/api/download/'.length))
    }

    json(res, 404, { error: 'not found' })
  }

  const httpServer = certificate
    ? https.createServer({ key: certificate.key, cert: certificate.cert }, handleHttp)
    : http.createServer(handleHttp)

  /**
   * A file from the phone, and the one question worth asking about it: is it
   * for the person or for an agent?
   *
   * A picture on its way to a coding agent is not a file anybody meant to
   * keep — it is the subject of the next sentence they are going to type — so
   * it skips the inbox, the desktop notification and the transfer counter and
   * lands in a swept cache directory instead, with its path handed straight
   * back so the phone can name it in `agents.attach`. Everything else is a
   * file transfer and behaves exactly as it always has.
   */
  function receiveUpload(req, res, url, device) {
    const rawName = req.headers['x-oc-filename'] || url.searchParams.get('name') || `upload-${Date.now()}`
    const dest = String(req.headers['x-oc-dest'] || url.searchParams.get('dest') || 'inbox')
    const forAgent = dest === 'agent'
    // The gate is the same switch that grants reading and answering: with
    // agents off there is nothing on this desktop that would ever read it.
    if (forAgent && !agentsEnabled()) return json(res, 403, { error: 'agent control is off' })
    const cap = forAgent ? agentDrops.MAX_DROP : MAX_UPLOAD
    const declared = Number(req.headers['content-length'] || 0)
    if (declared > cap) return json(res, 413, { error: 'file too large' })

    const name = decodeURIComponent(String(rawName))
    const target = forAgent ? agentDrops.pathFor(name) : inboxPathFor(name)
    const out = fs.createWriteStream(target)
    let written = 0
    let aborted = false

    const fail = (status, error) => {
      if (aborted) return
      aborted = true
      out.destroy()
      fs.rm(target, { force: true }, () => {})
      json(res, status, { error })
      req.destroy()
    }

    req.on('data', (chunk) => {
      written += chunk.length
      if (written > cap) fail(413, 'file too large')
    })
    req.on('error', () => fail(400, 'upload failed'))
    out.on('error', (err) => fail(500, err.message))
    req.pipe(out)

    out.on('close', () => {
      if (aborted) return
      if (forAgent) {
        // No notification and no counter: this is scaffolding for a question,
        // and the agent is about to be told where it is.
        return json(res, 200, { ok: true, name: target.split('/').pop(), size: written, path: target })
      }
      announceReceivedFile(target, { open: loadConfig().openFilesOnReceive })
      counters.filesIn += 1
      recordTransfer({ direction: 'in', name: target.split('/').pop(), size: written, peer: device.name })
      publishState()
      bus.emit('event', 'file', { direction: 'in', name: target.split('/').pop(), size: written, from: device.name })
      json(res, 200, { ok: true, name: target.split('/').pop(), size: written })
    })
  }

  function sendOffer(req, res, token) {
    const offer = resolveOffer(token)
    if (!offer) return json(res, 404, { error: 'offer expired or unknown' })
    let stat
    try {
      stat = fs.statSync(offer.path)
    } catch {
      return json(res, 404, { error: 'file is gone' })
    }
    res.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-length': stat.size,
      'content-disposition': `attachment; filename="${offer.name.replace(/"/g, '')}"`,
    })
    fs.createReadStream(offer.path).pipe(res)
  }

  /* ── WebSocket ─────────────────────────────────────────────────────── */

  const wss = new WebSocketServer({ server: httpServer, path: '/ws', maxPayload: MAX_MESSAGE })

  const encryptionRequired = () => loadConfig().requireEncryption !== false

  const send = (client, msg) => {
    const ws = client.ws ?? client
    if (ws.readyState !== ws.OPEN) return
    const payload = JSON.stringify(msg)
    if (client.secure) ws.send(client.secure.encrypt(Buffer.from(payload)), { binary: true })
    else ws.send(payload)
  }

  wss.on('connection', (ws, req) => {
    const peer = req.socket.remoteAddress
    const client = {
      ws,
      device: null,
      events: new Set(),
      alive: true,
      secure: null,
      negotiated: false,
      address: peer,
      since: Date.now(),
    }
    clients.add(client)

    // An unauthenticated socket is a liability: give it 10s to say hello.
    const helloTimer = setTimeout(() => {
      if (!client.device) {
        send(client, { t: 'error', error: 'handshake timeout' })
        ws.close(4001, 'handshake timeout')
      }
    }, 10_000)

    ws.on('pong', () => {
      client.alive = true
    })

    ws.on('message', async (raw, isBinary) => {
      const frame = Buffer.isBuffer(raw) ? raw : Buffer.from(raw)

      // The very first frame decides whether this socket is encrypted. A
      // binary frame is a key exchange; anything else is a legacy plaintext
      // client, which we only tolerate when the config says so.
      if (!client.negotiated) {
        client.negotiated = true
        if (isBinary) {
          try {
            const { reply, channel } = acceptHandshake(frame)
            client.secure = channel
            ws.send(reply, { binary: true })
          } catch (err) {
            log.warn(`key exchange failed from ${peer}: ${err.message}`)
            ws.close(4005, 'key exchange failed')
          }
          return
        }
        if (encryptionRequired()) {
          send(client, { t: 'error', error: 'this desktop requires an encrypted connection' })
          return ws.close(4005, 'encryption required')
        }
        log.warn(`${peer} connected without encryption`)
      }

      let text
      if (client.secure) {
        try {
          text = client.secure.decrypt(frame).toString()
        } catch {
          // A frame that will not authenticate means the stream is no longer
          // trustworthy — there is nothing safe left to do but hang up.
          log.warn(`dropping ${peer}: frame failed authentication`)
          return ws.close(4005, 'decryption failed')
        }
      } else {
        text = frame.toString()
      }

      let msg
      try {
        msg = JSON.parse(text)
      } catch {
        return send(client, { t: 'error', error: 'malformed json' })
      }

      if (msg.t === 'hello') return handleHello(client, msg, peer, helloTimer)
      if (!client.device) return send(client, { t: 'error', error: 'not authenticated' })

      switch (msg.t) {
        case 'ping':
          return send(client, { t: 'pong', at: Date.now() })
        case 'sub': {
          const events = Array.isArray(msg.events) ? msg.events.filter((e) => DEFAULT_EVENTS.includes(e)) : []
          const added = events.filter((e) => !client.events.has(e))
          added.forEach((e) => client.events.add(e))
          bus.subscribe(added)
          return send(client, { t: 'sub.ok', events: [...client.events] })
        }
        case 'unsub': {
          const events = Array.isArray(msg.events) ? msg.events : [...client.events]
          const removed = events.filter((e) => client.events.has(e))
          removed.forEach((e) => client.events.delete(e))
          bus.unsubscribe(removed)
          return send(client, { t: 'sub.ok', events: [...client.events] })
        }
        case 'req':
          return handleRequest(client, msg)
        default:
          return send(client, { t: 'error', error: `unknown message type: ${msg.t}` })
      }
    })

    ws.on('close', () => {
      clearTimeout(helloTimer)
      bus.unsubscribe([...client.events])
      clients.delete(client)
      if (client.device) {
        log.info(`${client.device.name} disconnected`)
        publishState()
        announcePresence()
      }
    })

    ws.on('error', (err) => log.debug('socket error:', err.message))
  })

  function handleHello(client, msg, peer, helloTimer) {
    const { ws } = client
    const info = msg.device || {}
    // What the phone says it is, before any of it is trusted or trimmed —
    // the only place the desktop can see whether a generic name is its own
    // doing or the app's.
    log.debug(`hello from ${peer}: ${JSON.stringify(info)}`)
    if (!client.secure && encryptionRequired()) {
      send(client, { t: 'hello.err', error: 'encryption required' })
      return ws.close(4005, 'encryption required')
    }
    let device = null

    if (msg.token) {
      device = findDeviceByToken(msg.token)
      if (!device) {
        send(client, { t: 'hello.err', error: 'unknown token — pair again' })
        return ws.close(4003, 'unknown token')
      }
      // A phone that was renamed — in its own settings, or by an app update
      // that learned to ask — says so on every hello. Keeping the name from
      // pairing day would leave the panel showing a device nobody owns.
      //
      // A generic name is not a rename, though. An app that cannot ask the
      // platform who it is sends "Android phone" on every single hello, and
      // taking that would undo a better name on every reconnect — the one the
      // network answered with, or the one an older, wiser build of the app
      // gave before it was downgraded.
      const renamed = String(info.name || '').slice(0, 64)
      const model = String(info.model || '').slice(0, 64)
      if (renamed && !isGeneric(renamed) && (renamed !== device.name || model !== device.model)) {
        device = upsertDevice({ ...device, name: renamed, model, nameSource: 'app' })
      }
    } else if (msg.pairCode) {
      // One phone at a time. `consumePairingCode` says the same thing, but a
      // socket that got here with a stale code should be told which phone is
      // in the way rather than left guessing at a generic refusal.
      const held = pairedDevice()
      if (held) {
        send(client, { t: 'hello.err', error: `${held.name} is already paired — unpair it on the desktop first` })
        return ws.close(4003, 'already paired')
      }
      const result = consumePairingCode(msg.pairCode)
      if (!result.ok) {
        log.warn(`pairing rejected from ${peer}: ${result.error}`)
        send(client, { t: 'hello.err', error: result.error })
        return ws.close(4003, 'pairing failed')
      }
      const id = typeof info.id === 'string' && info.id.length <= 64 ? info.id : crypto.randomUUID()
      device = {
        id,
        name: String(info.name || 'phone').slice(0, 64),
        platform: String(info.platform || 'unknown').slice(0, 32),
        model: String(info.model || '').slice(0, 64),
        token: newToken(),
        pairedAt: Date.now(),
        lastSeen: Date.now(),
      }
      upsertDevice(device)
      forgetTelemetry(device.id)
      log.ok(`paired with ${device.name} (${device.platform})`)
      send(client, { t: 'paired', token: device.token, device: publicDevice(device) })
    } else {
      send(client, { t: 'hello.err', error: 'token or pairCode required' })
      return ws.close(4003, 'no credentials')
    }

    clearTimeout(helloTimer)
    client.device = device
    touchDevice(device.id)
    log.info(`${device.name} connected from ${peer}`)
    publishState()
    announcePresence()
    adoptNetworkName(client, peer)

    send(client, {
      t: 'hello.ok',
      protocol: PROTOCOL_VERSION,
      secure: Boolean(client.secure),
      fingerprint: fingerprint(identity().publicKey),
      server: { name: loadConfig().deviceName, version },
      device: publicDevice(device),
      host: hostInfo(),
      capabilities: collectCapabilities(),
      theme: readTheme(),
      events: DEFAULT_EVENTS,
    })
  }

  /**
   * Give the phone the name the network has for it, when the phone itself had
   * none to give. The lookup runs after the hello has been answered — a
   * resolver that takes its time must not keep the app waiting — and the panel
   * is republished if it changes anything.
   *
   * A name that came from here is revisited on every reconnect, because a
   * lease renamed on the router should follow, and because the day the app
   * learns to answer for itself its own name has to be able to win.
   */
  async function adoptNetworkName(client, peer) {
    const device = client.device
    if (!device) return
    if (!isGeneric(device.name) && device.nameSource !== 'network') return

    const name = await nameFromNetwork(peer)
    if (!name || name === device.name) return

    const updated = upsertDevice({ ...device, name, nameSource: 'network' })
    if (client.device?.id === updated.id) client.device = updated
    log.info(`the network calls ${device.name} "${name}"`)
    publishState()
  }

  async function handleRequest(client, msg) {
    const fn = methods.get(msg.method)
    if (!fn) return send(client, { t: 'res', id: msg.id, ok: false, error: `unknown method: ${msg.method}` })
    try {
      const data = await fn(msg.params || {}, { device: client.device })
      send(client, { t: 'res', id: msg.id, ok: true, data: data ?? null })
    } catch (err) {
      log.debug(`${msg.method} failed:`, err.message)
      send(client, { t: 'res', id: msg.id, ok: false, error: err.message || 'request failed' })
    }
  }

  const publicDevice = (d) => ({ id: d.id, name: d.name, platform: d.platform, pairedAt: d.pairedAt })

  /* ── Fan-out ───────────────────────────────────────────────────────── */

  bus.on('device.report', publishState)

  bus.on('event', (event, data) => {
    if (event === 'notification') counters.notifications += 1
    // A mirrored message or a ringing phone changes what the bar panel should
    // be showing, so it is republished the same way a connection is.
    if (event === 'phone' && ['received', 'bluetooth', 'ios'].includes(data?.action)) publishState()
    // An agent that started, finished or got stuck changes what the bar shows.
    // The blocks streaming out of an open chat do not, and there are many.
    if (event === 'agent' && data?.kind !== 'blocks') publishState()
    const message = { t: 'ev', event, data }
    for (const client of clients) {
      if (!client.device || !client.events.has(event)) continue
      send(client, message)
    }
  })

  // Drop sockets that stopped answering — phones sleep and their TCP
  // connections die silently.
  const heartbeat = setInterval(() => {
    for (const client of clients) {
      if (!client.alive) {
        client.ws.terminate()
        continue
      }
      client.alive = false
      try {
        client.ws.ping()
      } catch {
        /* terminated below on the next sweep */
      }
    }
  }, HEARTBEAT_MS)
  heartbeat.unref?.()

  // The desktop's address changes with a new DHCP lease, and a firewall rule
  // can be added while the daemon runs. Neither is worth a republish on its
  // own, so they ride a slow tick and only write when something moved.
  const environmentTimer = setInterval(async () => {
    if (await refreshEnvironment()) publishState()
  }, 30_000)
  environmentTimer.unref?.()

  /* ── Lifecycle ─────────────────────────────────────────────────────── */

  const api = {
    bus,
    port: listenPort,
    scheme,
    get certificate() {
      return certificate
    },
    get connections() {
      return [...clients].filter((c) => c.device).map((c) => publicDevice(c.device))
    },
    /** Push a desktop file to every connected phone as a one-time download. */
    pushFile(filePath) {
      const offer = offerFile(filePath)
      counters.filesOut += 1
      recordTransfer({ direction: 'out', name: offer.name, size: offer.size })
      publishState()
      bus.emit('event', 'file', { direction: 'out', ...offer, at: Date.now() })
      return offer
    },
    /** Republish the status file — used after the CLI mints a pairing code. */
    publishState,
    async start() {
      // The phone plugin routes call control between Bluetooth and the app,
      // and needs to know whether there is an app to route to.
      trackConnections(() => api.connections.length)
      startPlugins(bus)
      await new Promise((resolve, reject) => {
        httpServer.once('error', reject)
        httpServer.listen(listenPort, '0.0.0.0', resolve)
      })
      await refreshEnvironment()
      publishState()
      if (certificate) log.ok(`TLS on — pin ${certificate.pin}`)
      return listenPort
    },
    async stop() {
      clearInterval(heartbeat)
      clearInterval(environmentTimer)
      state.clear()
      stopPlugins()
      for (const client of clients) client.ws.close(1001, 'server shutting down')
      wss.close()
      await new Promise((resolve) => httpServer.close(resolve))
    },
  }

  return api
}
