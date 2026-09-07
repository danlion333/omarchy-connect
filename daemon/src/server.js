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
  findDeviceById,
  touchDevice,
  removeDevice,
  pairedDevice,
  updateConfig,
} from './lib/config.js'
import { readTheme } from './lib/theme.js'
import { host as hostInfo } from './lib/sys.js'
import { isGeneric, nameFromNetwork } from './lib/hostname.js'
import { Bus } from './bus.js'
import { consumePairingCode, activePairing, createPairingCode } from './pairing.js'
import { buildMethodTable, collectCapabilities, startPlugins, stopPlugins } from './plugins/index.js'
import { inboxPathFor, announceReceivedFile, resolveOffer, offerFile, redeemTicket } from './plugins/share.js'
import {
  decryptStream,
  encryptStream,
  encryptedSize,
  wantsEncryption,
  HEADER as ENCRYPTION_HEADER,
  SCHEME as ENCRYPTION_SCHEME,
} from './lib/filecrypt.js'
import { accept as acceptHandshake, identity, fingerprint, SUITE } from './lib/crypto.js'
import { telemetryFor, forget as forgetTelemetry } from './plugins/device.js'
import {
  summary as phoneSummary,
  requestSend as requestSms,
  requestCall,
  requestOtp,
  requestLocate,
  trackConnections,
} from './plugins/phone.js'
import { summary as terminalSummary, setEnabled as setTerminalEnabled } from './plugins/terminal.js'
import {
  summary as agentsSummary,
  hook as agentHook,
  setEnabled as setAgentsEnabled,
  agentsEnabled,
} from './plugins/agents.js'
import {
  requestMic,
  requestInput as requestAudioInput,
  feed as feedAudio,
  hangUp as hangUpAudio,
  summary as audioSummary,
  setGain as setAudioGain,
} from './plugins/audio.js'
import { isAudioFrame } from './lib/mic.js'
import * as agentDrops from './agents/drops.js'
import { handsfree } from './lib/handsfree.js'
import { ancs } from './lib/ancs.js'
import * as state from './lib/state.js'
import * as firewall from './lib/firewall.js'
import * as tls from './lib/tls.js'
import * as sysinfo from './lib/sys.js'
import * as overlay from './lib/overlay.js'
import { createAnnouncer, announcement, ANNOUNCE_PORT } from './lib/announce.js'

export const PROTOCOL_VERSION = 2
const MAX_UPLOAD = 512 * 1024 * 1024
const MAX_MESSAGE = 1 * 1024 * 1024
const HEARTBEAT_MS = 20_000
export const DEFAULT_EVENTS = ['stats', 'clipboard', 'notification', 'theme', 'file', 'phone', 'audio', 'agent', 'terminal', 'endpoints']
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

/**
 * A secret this daemon mints for itself, once, at start.
 *
 * The routes below used to be guarded by the peer address alone, and a peer
 * address says only "something on this machine" — which is every process the
 * user runs, every Flatpak with network access, and, for a `no-cors` POST, a
 * web page in a browser on the same box. Those callers can send an SMS from
 * the paired phone, mint a pairing code or unpair it, so "local" was never the
 * boundary the comments claimed it was.
 *
 * The secret goes into `status.json`, which is already 0600 and is already the
 * file both readers — the CLI and the shell panel, which drives everything
 * through the CLI — open before they talk to the daemon. So nothing that could
 * not read that file can drive the phone, and rotating it on every start costs
 * nothing: both readers read the file again on their next command.
 */
const LOCAL_SECRET = crypto.randomBytes(32).toString('hex')

/** Compared without leaking, through the timing, how much of it was right. */
const secretMatches = (given) => {
  if (typeof given !== 'string' || given.length !== LOCAL_SECRET.length) return false
  return crypto.timingSafeEqual(Buffer.from(given), Buffer.from(LOCAL_SECRET))
}

/**
 * The gate on every route that used to say "localhost only", answering the
 * request itself when it refuses so a caller gets one 403 and no clue about
 * which of the four conditions it tripped.
 *
 * Three things beyond the secret, each aimed at the browser case. A page can
 * be made to POST to loopback without ever reading the answer, but it cannot
 * set a header of our choosing, it cannot send `application/json` on a form
 * post, and it cannot suppress its own `Origin` — so a request that carries an
 * `Origin` at all is a request from a web page and is refused whatever else it
 * is holding.
 */
function localOnly(req, res) {
  if (!isLoopback(req)) return refuseLocal(res)
  if (req.headers.origin !== undefined) return refuseLocal(res)
  const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase()
  if (type !== 'application/json') return refuseLocal(res)
  if (!secretMatches(req.headers['x-oc-local'])) return refuseLocal(res)
  return true
}

const refuseLocal = (res) => {
  json(res, 403, { error: 'localhost only' })
  return false
}

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
  // Where else this desktop can be reached, refreshed on the environment
  // tick. A tunnel can come up long after the daemon did, so this is watched
  // rather than read once at start.
  let overlayState = overlay.known()
  // The subnet's own broadcast address, kept beside the local one because the
  // start-up announcement is aimed at it — see `lib/announce`.
  let localBroadcast = null
  // Alive only across the start-up burst, and torn down with the listener.
  let announcer = null
  // Whether the desktop has managed to say it is up. Not "whether it tried":
  // a daemon that came up before its network did had nothing to announce on.
  let announced = false
  // Set once `start()` is through, so the environment tick can tell "the
  // daemon has not announced itself yet" from "it is announcing itself now".
  let started = false
  let firewallState = { blocked: false, tool: null, command: null, remoteCommand: null }
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
      // The password to this daemon's own local routes. It leaves here for a
      // 0600 file and for nowhere else — nothing that goes to the phone is
      // built from this snapshot.
      localSecret: LOCAL_SECRET,
      host: localAddress,
      pairing: activePairing(),
      firewall: firewallState,
      remote: { enabled: remoteEnabled(), ...overlay.summary(overlayState) },
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
          // How this phone got here, so the panel can say "via tailscale"
          // rather than showing an address nobody recognises.
          via: client ? client.via : null,
          link: client ? client.link : null,
          secure: client ? Boolean(client.secure) : null,
          battery: report?.battery ?? null,
          network: report?.network ?? null,
          reportedAt: report?.at ?? null,
        }
      }),
      transfers: [...transfers],
      counters: { ...counters },
      phone: phoneSummary(),
      // The phone's microphone: whether it is speaking, and whether this
      // desktop is offering it as an input every program can pick. Both are
      // switches with no sign of themselves anywhere else on the screen, and
      // a microphone left on with nothing saying so is the one state a person
      // should not have to remember. `input.available` shells `pactl` once
      // per process and answers from a cache afterwards (`lib/pipesource.js`),
      // so it is safe on a snapshot that is rebuilt on every connection.
      audio: audioSummary(),
      agents: agentsSummary(),
    }
  }

  const publishState = () => state.publish(snapshot())

  /**
   * Whether this desktop answers a phone that is not on its own subnet.
   *
   * Read fresh every time rather than captured at start, because the switch
   * is meant to be flicked on a running daemon.
   */
  const remoteEnabled = () => loadConfig().remote?.enabled === true

  /**
   * Flip the switch on a running daemon.
   *
   * Turning it off is more than a config write: every phone already on a
   * remote socket is holding a link this desktop has just decided it does not
   * want, and every phone anywhere is holding a candidate list with a tunnel
   * address in it. So the sockets go, and the new list is pushed to whoever
   * is left.
   */
  function setRemoteEnabled(on) {
    updateConfig((c) => {
      c.remote = { ...(c.remote || {}), enabled: on === true }
    })
    // The new list first, then the hang-up. In that order the phone about to
    // lose its link learns the tunnel address is gone before it goes, so it
    // stops dialling one this desktop will refuse; the other way round it
    // would retry down the candidate list all the way to the backoff tail.
    announceEndpoints()
    if (!on) {
      for (const client of clients) {
        if (client.via !== 'remote') continue
        send(client, { t: 'error', error: 'remote access was switched off on this desktop' })
        client.ws.close(4006, 'remote access is off')
      }
    }
    return remoteSummary()
  }

  const remoteSummary = () => ({ enabled: remoteEnabled(), ...overlay.summary(overlayState), endpoints: endpoints() })

  /**
   * Every address the phone may dial, best first.
   *
   * The LAN address leads because it is the one that is fast, free and
   * always right when the phone is home. Overlay addresses follow, and the
   * MagicDNS name comes last of all: it is a real endpoint, but only while
   * the tailnet's own DNS is switched on, so it is a fallback for the IP
   * rather than a replacement for it.
   *
   * With remote access off this is the LAN address and nothing else — the
   * phone is never handed a way in that the desktop would refuse.
   */
  function endpoints() {
    const list = []
    if (localAddress) list.push({ host: localAddress, port: listenPort, kind: 'lan' })
    if (remoteEnabled()) list.push(...overlay.toEndpoints(overlayState, listenPort))
    return list
  }

  /**
   * Where the "this desktop is up" packet goes, and on which port.
   *
   * The address is the current subnet's broadcast address — `sysinfo.network()`
   * has already worked it out with `broadcastFor`. The override exists for the
   * suite and for nothing else: a test machine has no subnet it may shout
   * across, and a broadcast is the one thing that cannot be pointed at a
   * loopback listener without saying so. It is read fresh rather than captured
   * so a test can set it per run, in the spirit of `OMARCHY_CONNECT_STATE`.
   */
  function announceTarget() {
    const override = process.env.OMARCHY_ANNOUNCE_TO
    if (override) {
      const at = override.lastIndexOf(':')
      if (at > 0) return { host: override.slice(0, at), port: Number(override.slice(at + 1)) || ANNOUNCE_PORT }
      return { host: override, port: ANNOUNCE_PORT }
    }
    return { host: localBroadcast, port: ANNOUNCE_PORT }
  }

  /**
   * The desktop announcing itself, once, at the moment it comes up.
   *
   * This is the whole of the desktop's half of "come back now": the phone
   * decides what to do about it, and a phone that hears nothing behaves
   * exactly as it did before. Nothing is repeated on the environment tick —
   * a beacon every thirty seconds would be a different feature with a
   * different cost, and the moment worth announcing is this one.
   */
  function announceSelf() {
    const target = announceTarget()
    if (!target.host) {
      log.debug('no subnet to announce on — nothing to broadcast to')
      return
    }
    announced = true
    const key = identity().publicKey.toString('hex')
    announcer?.stop()
    announcer = createAnnouncer({ port: target.port })
    announcer.announce(
      announcement({
        protocol: PROTOCOL_VERSION,
        version,
        name: cfg.deviceName,
        host: localAddress,
        port: listenPort,
        publicKey: key,
        fingerprint: fingerprint(key),
      }),
      target.host,
    )
    log.debug(`announced this desktop on ${target.host}:${target.port}`)
  }

  /** Tell whoever is listening that the set of addresses changed under them. */
  function announceEndpoints() {
    bus.emit('event', 'endpoints', { endpoints: endpoints() })
  }

  /**
   * Whether any paired phone is on the network right now.
   *
   * Only one thing listens for this — the hands-free link, which holds the
   * Bluetooth profile open for as long as the handset is in the room — but it
   * is announced rather than reached for, because a socket lifecycle is the
   * server's business and what anyone does about it is not.
   */
  const announcePresence = () => {
    // A phone on the far end of a tunnel is not in the room, and telling the
    // hands-free link otherwise would raise the Bluetooth profile on a
    // handset five hundred kilometres away under `autoConnect: 'presence'`.
    bus.emit('presence', [...clients].some((client) => client.device && client.via !== 'remote'))
  }

  /**
   * A device that no longer has a socket here at all.
   *
   * Told apart from `presence` on purpose: presence is "is any phone in the
   * room", and this is "*this* phone's connection is gone" — which is what
   * anything holding state on behalf of one device needs, and the telephony
   * plugin holds exactly that in a call it is only mirroring. A phone that
   * reconnected before the old socket finished closing has not gone anywhere,
   * so a device still on another client says nothing.
   *
   * Same shape as `presence`: what a socket lifecycle means to anybody else is
   * their business, and the server announces rather than reaches.
   */
  const announceDeparture = (device) => {
    if (!device?.id) return
    if ([...clients].some((client) => client.device?.id === device.id)) return
    bus.emit('device-gone', device)
  }

  async function refreshEnvironment() {
    const net = await sysinfo.network().catch(() => null)
    const ip = net?.ip || null
    const addressChanged = ip !== localAddress
    let changed = addressChanged
    localAddress = ip
    localBroadcast = net?.broadcast || null

    // A tunnel that comes up after the daemon did changes two things: what
    // the phone should be told it can dial, and what the certificate has to
    // name. `tls.subjectNames` already picks up every non-internal IPv4, so
    // re-minting here is what gets the 100.x address into the SAN — over the
    // same private key, so the pin the phone is holding still matches.
    const before = overlayState
    overlayState = await overlay.detect({ force: true }).catch(() => before)
    const overlayChanged = addressList(before) !== addressList(overlayState)
    if (overlayChanged) changed = true
    if ((addressChanged || overlayChanged) && certificate) refreshCertificate(ip)
    if (overlayChanged) announceEndpoints()

    // `ufw` is checked through a synchronous systemctl call, so it gets a
    // slow lane of its own rather than riding every republish.
    if (Date.now() - firewallCheckedAt > FIREWALL_RECHECK_MS) {
      firewallCheckedAt = Date.now()
      const next = firewall.check(listenPort, ip, overlayState.addresses[0]?.iface ?? null)
      if (
        next.blocked !== firewallState.blocked ||
        next.command !== firewallState.command ||
        next.remoteCommand !== firewallState.remoteCommand
      ) {
        changed = true
      }
      firewallState = next
    }

    // The one case where the announcement is not made by `start()`: the unit
    // is ordered after `graphical-session.target` and after nothing else, so
    // a cold boot can perfectly well run this daemon before NetworkManager
    // has an address on any interface — and a desktop with no subnet has
    // nowhere to announce itself. This is still the start-up announcement,
    // made at the first moment there is a wire to make it on, and it happens
    // once: `announced` is never cleared, so a desktop that changes address
    // later does not shout about it again.
    if (started && !announced) announceSelf()

    return changed
  }

  /** The overlay addresses as one comparable string, for "did this change?". */
  const addressList = (snap) => (snap?.addresses || []).map((entry) => entry.address).join(',') + `|${snap?.dnsName ?? ''}`

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

  /**
   * The file routes are authorised by a ticket and by nothing else.
   *
   * A ticket is minted over the encrypted socket (`share.ticket`), is good for
   * one request in one direction, and expires in two minutes — so the device
   * token, which is the phone's whole identity, never travels on a cleartext
   * HTTP request and never lands in a proxy log or a URL history. There is no
   * fallback to `x-oc-token` or `?token=`: a fallback is the attack, since a
   * sniffer would simply ask for the road that still carries the credential.
   */
  function authFromTicket(req, use) {
    const redeemed = redeemTicket(req.headers['x-oc-ticket'], use)
    if (!redeemed) return null
    const device = findDeviceById(redeemed.deviceId)
    return device ? { device, key: redeemed.key } : null
  }

  /**
   * The same gate the WebSocket hello applies, said in HTTP.
   *
   * With remote access off a phone dialling over the tunnel is refused at
   * `hello` — but the file routes are a second front door, and they used to
   * open for anything holding a credential no matter which interface it
   * arrived on. Decided the way the socket decides it: by the local address
   * the kernel routed the connection in on, never by judging the peer's.
   */
  function remoteRefused(req) {
    const link = overlay.classify(req.socket.localAddress, overlayState)
    return link.via === 'remote' && !remoteEnabled()
  }

  /**
   * Every request goes through here, and nothing that happens inside is
   * allowed to reach the process.
   *
   * `createServer`'s handler is called from the event loop with nobody above
   * it, so a synchronous throw in any route — a bad percent-escape in a
   * filename, a header that will not parse into a URL — is an uncaught
   * exception, and an uncaught exception used to be the end of the daemon.
   * One phone with an awkward filename would take down every other device's
   * socket with it and leave systemd to put the whole thing back three
   * seconds later. A request that goes wrong is worth a 500 and a line in the
   * log; it is not worth the link.
   */
  function handleHttp(req, res) {
    try {
      routeHttp(req, res)
    } catch (err) {
      log.error(`${req.method} ${req.url} threw:`, err)
      // The route may already have started answering — writing a second set
      // of headers would throw again, this time from inside the catch.
      if (!res.headersSent) json(res, 500, { error: 'internal error' })
      else res.destroy()
    }
  }

  function routeHttp(req, res) {
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
      if (!localOnly(req, res)) return undefined
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
      if (!localOnly(req, res)) return undefined
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
      if (!localOnly(req, res)) return undefined
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
      if (!localOnly(req, res)) return undefined
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
      if (!localOnly(req, res)) return undefined
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
     * The Copy button on a mirrored one-time code: whether there is one, and
     * whether it presses itself. Loopback only, like everything else that
     * writes the config — and `test` reads a message the caller supplies
     * rather than one that arrived, so nothing private crosses this route.
     */
    if (req.method === 'POST' && url.pathname === '/api/otp') {
      if (!localOnly(req, res)) return undefined
      let body = ''
      req.on('data', (c) => {
        body += c
        if (body.length > 8192) req.destroy()
      })
      req.on('end', () => {
        try {
          const { op = 'status', value = null } = JSON.parse(body || '{}')
          const result = requestOtp({ op, value })
          publishState()
          return json(res, 200, result)
        } catch (err) {
          return json(res, 400, { error: err.message })
        }
      })
      return undefined
    }

    /**
     * Ring the phone until somebody finds it. Loopback only, and unlike
     * `/api/call` there is no Bluetooth road under this one: hands-free would
     * carry the sound to this desktop, and the whole point is to make a noise
     * where the handset is rather than where the keyboard is.
     */
    /**
     * The desktop asking the phone for its microphone, and asking for it back.
     *
     * Held open the way `/api/locate` is: the answer comes back when the
     * handset has actually started recording, so `omarchy-connect mic` says
     * the phone is listening rather than that a message went into the dark.
     *
     * `op: "input"` is the other half — not a recording at all, but whether
     * this desktop offers the phone as a microphone the whole system can see.
     * `op: "gain"` is neither: it is how loud any of it is, saved and applied
     * to whatever is already running.
     */
    if (req.method === 'POST' && url.pathname === '/api/mic') {
      if (!localOnly(req, res)) return undefined
      let body = ''
      req.on('data', (c) => {
        body += c
        if (body.length > 8192) req.destroy()
      })
      req.on('end', async () => {
        try {
          const { op = 'status', value = null } = JSON.parse(body || '{}')
          if (op === 'status') return json(res, 200, { ok: true, audio: audioSummary() })
          // The desktop's own input is a switch rather than a stream, so it
          // answers with what the switch now is — including a source that is
          // loaded and silent because the handset never woke up.
          if (op === 'input') {
            const input = await requestAudioInput(value ?? 'status')
            return json(res, 200, { ok: true, audio: { ...audioSummary(), input } })
          }
          if (op === 'gain') {
            setAudioGain(value)
            publishState()
            return json(res, 200, { ok: true, audio: audioSummary() })
          }
          const { outcome } = requestMic({ op })
          const result = await outcome
          return json(res, 200, { ok: true, audio: { ...audioSummary(), ...result } })
        } catch (err) {
          return json(res, 400, { error: err.message })
        }
      })
      return undefined
    }

    if (req.method === 'POST' && url.pathname === '/api/locate') {
      if (!localOnly(req, res)) return undefined
      let body = ''
      req.on('data', (c) => {
        body += c
        if (body.length > 8192) req.destroy()
      })
      req.on('end', async () => {
        try {
          const { op = 'start', seconds } = JSON.parse(body || '{}')
          const { outcome } = requestLocate({ op, seconds })
          const result = await outcome
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
      if (!localOnly(req, res)) return undefined
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
      if (!localOnly(req, res)) return undefined
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
     * Localhost only, for the same reason the agent switch is: whether this
     * desktop answers a phone that is not on its own network is a decision
     * that belongs at the keyboard, and no paired phone can make it. Live, so
     * the switch means something on a daemon that is already running.
     */
    if (req.method === 'POST' && url.pathname === '/api/remote/control') {
      if (!localOnly(req, res)) return undefined
      let body = ''
      req.on('data', (c) => {
        body += c
        if (body.length > 4096) req.destroy()
      })
      req.on('end', async () => {
        try {
          const { op = 'status' } = JSON.parse(body || '{}')
          if (op !== 'enable' && op !== 'disable' && op !== 'status') {
            return json(res, 400, { error: `unknown remote action: ${op}` })
          }
          // A status ask is the one moment somebody is looking, so it is
          // worth the syscalls to answer with what is up right now rather
          // than with whatever the last tick saw.
          if (op === 'status') overlayState = await overlay.detect({ force: true }).catch(() => overlayState)
          const remote = op === 'status' ? remoteSummary() : setRemoteEnabled(op === 'enable')
          publishState()
          json(res, 200, { ok: true, remote })
        } catch (err) {
          json(res, 400, { error: err.message })
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
      if (!localOnly(req, res)) return undefined
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

    /**
     * Localhost only: the desktop's switch for the shell the phone types into.
     *
     * Its own endpoint rather than a corner of the agent one, because it is
     * its own decision and the CLI, the panel and the log should all be able
     * to say which of the two was flipped. Everything else about it is the
     * agent switch's shape: loopback only, so no paired phone can grant
     * itself a shell, and the daemon owns both halves so nothing restarts.
     */
    if (req.method === 'POST' && url.pathname === '/api/terminal/control') {
      if (!localOnly(req, res)) return undefined
      let body = ''
      req.on('data', (c) => {
        body += c
        if (body.length > 4096) req.destroy()
      })
      req.on('end', () => {
        try {
          const { op = 'status' } = JSON.parse(body || '{}')
          if (op !== 'enable' && op !== 'disable' && op !== 'status') {
            return json(res, 400, { error: `unknown terminal action: ${op}` })
          }
          const terminal = op === 'status' ? terminalSummary() : setTerminalEnabled(op === 'enable')
          json(res, 200, { ok: true, terminal })
        } catch (err) {
          json(res, 400, { error: err.message })
        }
      })
      return undefined
    }

    if (req.method === 'POST' && url.pathname === '/api/upload') {
      if (remoteRefused(req)) {
        return json(res, 403, { error: 'remote access is off on this desktop — run `omarchy-connect remote on` there' })
      }
      const pass = authFromTicket(req, 'upload')
      if (!pass) return json(res, 401, { error: 'unauthorized' })
      return receiveUpload(req, res, url, pass.device, pass.key)
    }

    if (req.method === 'GET' && url.pathname.startsWith('/api/download/')) {
      if (remoteRefused(req)) {
        return json(res, 403, { error: 'remote access is off on this desktop — run `omarchy-connect remote on` there' })
      }
      const pass = authFromTicket(req, 'download')
      if (!pass) return json(res, 401, { error: 'unauthorized' })
      return sendOffer(req, res, url.pathname.slice('/api/download/'.length), pass.key)
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
  function receiveUpload(req, res, url, device, contentKey) {
    const rawName = req.headers['x-oc-filename'] || url.searchParams.get('name') || `upload-${Date.now()}`
    const dest = String(req.headers['x-oc-dest'] || url.searchParams.get('dest') || 'inbox')
    const forAgent = dest === 'agent'
    // The gate is the same switch that grants reading and answering: with
    // agents off there is nothing on this desktop that would ever read it.
    if (forAgent && !agentsEnabled()) return json(res, 403, { error: 'agent control is off' })
    const cap = forAgent ? agentDrops.MAX_DROP : MAX_UPLOAD
    // A phone that says its body is sealed gets it opened on the way to disk,
    // under the key that came with its ticket. A phone that does not is one
    // paired before this existed, and is still served in the clear rather than
    // broken in silence — it can never be a downgrade, because the ticket it
    // would have to hold to try only ever travelled inside the encrypted
    // socket that the desktop's pinned identity key stands behind.
    const sealed = wantsEncryption(req.headers[ENCRYPTION_HEADER])
    // The declared length is what is on the wire, so on a sealed body it is
    // measured with the frame tags on. Comparing it to the plain cap would
    // refuse a file that fits.
    const declared = Number(req.headers['content-length'] || 0)
    if (declared > (sealed ? encryptedSize(cap) : cap)) return json(res, 413, { error: 'file too large' })

    // The name arrives percent-encoded because a header cannot carry a
    // newline or a Cyrillic letter, but `decodeURIComponent` throws on plenty
    // of names a phone will really send — `100%.txt`, or anything the encoder
    // truncated mid-escape. Refusing the one request is the whole cost;
    // before this it cost the process.
    let name
    try {
      name = decodeURIComponent(String(rawName))
    } catch {
      return json(res, 400, { error: 'filename is not valid percent-encoding' })
    }
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

    let plain = req
    if (sealed) {
      const opener = decryptStream(contentKey)
      // The cap has to be counted on what lands on disk rather than on what
      // arrives, or a sealed file would be measured with its tags on.
      opener.on('error', (err) => fail(400, err.message))
      req.on('error', () => fail(400, 'upload failed'))
      req.pipe(opener)
      plain = opener
    } else {
      req.on('error', () => fail(400, 'upload failed'))
      // A body that stops early is the one failure that used to look exactly
      // like success. Node does not promise an `'error'` on a request whose
      // socket went away mid-body — it closes the message and sets
      // `complete` to false — so `out.on('close')` fired, the file was
      // announced, counted and written into the transfer list, and the phone
      // got `200 {ok:true}` for half a video. `content-length` is the length
      // the phone said it was sending; on the plain road that is also the
      // length that has to land on disk, so anything short of it is a
      // truncated upload and takes the same road as any other bad request.
      // Only the plain road: on a sealed body `declared` is the size with the
      // frame tags on (`encryptedSize`) while `written` counts opened bytes,
      // and `decryptStream` already catches a cut body in `flush()`.
      req.on('close', () => {
        if (!req.complete) fail(400, 'the upload was truncated')
      })
    }

    plain.on('data', (chunk) => {
      written += chunk.length
      if (written > cap) fail(413, 'file too large')
    })
    out.on('error', (err) => fail(500, err.message))
    plain.pipe(out)

    out.on('close', () => {
      if (aborted) return
      // The other half of the same check: the request completed, but fewer
      // bytes reached the disk than the phone declared. A request with no
      // `content-length` at all (chunked) declares nothing, and is left
      // exactly as it was.
      if (!sealed && declared > 0 && written !== declared) return fail(400, 'the upload was truncated')
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

  function sendOffer(req, res, token, contentKey) {
    const offer = resolveOffer(token)
    if (!offer) return json(res, 404, { error: 'offer expired or unknown' })
    let stat
    try {
      stat = fs.statSync(offer.path)
    } catch {
      return json(res, 404, { error: 'file is gone' })
    }
    // The other direction of the same bargain: seal it when the phone asked
    // for a sealed body, send it flat when the phone is too old to ask. The
    // sealed length is arithmetic rather than a guess, so `content-length` is
    // still exact and the phone still gets a progress bar.
    const sealed = wantsEncryption(req.headers[ENCRYPTION_HEADER])
    res.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-length': sealed ? encryptedSize(stat.size) : stat.size,
      'content-disposition': `attachment; filename="${offer.name.replace(/"/g, '')}"`,
      ...(sealed ? { [ENCRYPTION_HEADER]: ENCRYPTION_SCHEME } : {}),
    })
    const body = fs.createReadStream(offer.path)
    if (!sealed) return body.pipe(res)
    const sealer = encryptStream(contentKey)
    sealer.on('error', () => res.destroy())
    return body.pipe(sealer).pipe(res)
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
    // How this socket got here, decided once and never recomputed: the local
    // end of the connection names the interface the kernel routed it in
    // through, so a socket that arrived on the tailnet address arrived over
    // the tailnet. Deliberately not a judgement about the *peer's* address —
    // deciding who is a stranger by IP range is the mistake that has broken
    // this in every project that tried it.
    const link = overlay.classify(req.socket.localAddress, overlayState)
    const client = {
      ws,
      // This socket, told apart from the next one the same handset opens. The
      // microphone stream is fed by binary frames rather than by requests, so
      // something has to say which socket a chunk arrived on — a phone that
      // reconnected mid-stream must not have its new socket's frames folded
      // into the recording the old one was making.
      id: crypto.randomUUID(),
      device: null,
      // Whether this socket ever got its `hello.ok`. Only the frame that says
      // so may set it, which is what lets the handler below tell a socket that
      // finished its handshake from one that died halfway through it.
      greeted: false,
      events: new Set(),
      alive: true,
      secure: null,
      negotiated: false,
      address: peer,
      via: link.via,
      link: link.kind,
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

      let plain
      if (client.secure) {
        try {
          plain = client.secure.decrypt(frame)
        } catch {
          // A frame that will not authenticate means the stream is no longer
          // trustworthy — there is nothing safe left to do but hang up.
          log.warn(`dropping ${peer}: frame failed authentication`)
          return ws.close(4005, 'decryption failed')
        }
      } else {
        plain = frame
      }

      // Sound, rather than a sentence about sound. Ten of these a second climb
      // the same encrypted socket as everything else and are told apart from
      // JSON by their magic (`lib/mic.js`), which is unambiguous because a
      // JSON frame's first byte is always `{`. They are answered with nothing
      // at all: a reply per chunk would double the traffic to say what the
      // next chunk already implies.
      if (isAudioFrame(plain)) {
        if (!client.device) return send(client, { t: 'error', error: 'not authenticated' })
        feedAudio(client.id, plain)
        return undefined
      }

      let msg
      try {
        msg = JSON.parse(plain.toString())
      } catch {
        return send(client, { t: 'error', error: 'malformed json' })
      }

      // One `try` around the whole dispatch, because this handler is `async`:
      // anything thrown below is a rejected promise nobody is waiting on, and
      // `installCrashGuard` turns it into a line in the log and nothing else.
      // For most frames that costs an answer. For `hello` it cost the link —
      // the write that stamps `lastSeen` on the config happens *after* the
      // handshake timer is cleared, so a full disk or an unwritable config
      // left a socket that was authenticated, unwatched and never greeted,
      // kept alive indefinitely by the heartbeat below while the phone sat in
      // `connecting` with nothing to time out.
      try {
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
      } catch (err) {
        log.error(`failed to handle ${msg.t} from ${peer}:`, err)
        // A socket that never got its `hello.ok` is the one that cannot be
        // left alone: it may be holding a device by now, and it is certainly
        // no longer holding its handshake timer. Tell the phone and hang up,
        // so it reconnects rather than waiting on a greeting that will never
        // come. 1011 and not 4003/4005 on purpose — a disk that would not
        // take a write is not a pairing the desktop disowned, and the app
        // reads those two codes as "stop trying".
        if (!client.greeted) {
          client.device = null
          clearTimeout(helloTimer)
          send(client, { t: 'hello.err', error: 'the desktop could not finish the handshake — try again' })
          return ws.close(1011, 'handshake failed')
        }
        return send(client, { t: 'error', error: `could not handle ${msg.t}` })
      }
    })

    ws.on('close', () => {
      clearTimeout(helloTimer)
      // Within the tick, so a socket that died mid-stream leaves a finished
      // file rather than a recorder waiting for bytes that will never come.
      hangUpAudio(client.id)
      bus.unsubscribe([...client.events])
      clients.delete(client)
      if (client.device) {
        log.info(`${client.device.name} disconnected`)
        announceDeparture(client.device)
        publishState()
        announcePresence()
      }
    })

    ws.on('error', (err) => log.debug('socket error:', err.message))
  })

  function handleHello(client, msg, peer, helloTimer) {
    const { ws } = client
    const info = msg.device || {}
    // The gate, said out loud rather than as a timeout. A phone dialling an
    // address it was handed while remote was on deserves to be told why the
    // desktop has stopped answering, and the answer names the command that
    // undoes it.
    if (client.via === 'remote' && !remoteEnabled()) {
      log.warn(`refused a remote connection from ${peer} — remote access is off`)
      send(client, { t: 'hello.err', error: 'remote access is off on this desktop — run `omarchy-connect remote on` there' })
      return ws.close(4006, 'remote access is off')
    }
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
    // `lastSeen` is telemetry: the panel shows it, and nothing at all depends
    // on it. Letting a failed write of it refuse a phone that has already
    // proved who it is would be trading the connection for a timestamp, so
    // this one failure is written down and stepped over. Every other write on
    // the way here — a rename, a pairing — is load-bearing and still throws,
    // into the handler's `catch` above.
    try {
      touchDevice(device.id)
    } catch (err) {
      log.warn(`could not record when ${device.name} was last seen: ${err.message}`)
    }
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
      // Every address this desktop can be dialled on, so a phone that moves
      // off the subnet has somewhere to go without being re-paired. The list
      // is handed over rather than asked for because the moment it is wanted
      // is the moment there is nothing to ask.
      endpoints: endpoints(),
      link: { via: client.via, kind: client.link },
      capabilities: collectCapabilities({ remote: client.via === 'remote' }),
      theme: readTheme(),
      events: DEFAULT_EVENTS,
    })
    // Said only once the frame is out of the door, because this is the flag
    // the handler's `catch` reads to decide whether the socket is worth
    // keeping. A greeting that threw on its way to the wire has not happened.
    client.greeted = true
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
    // Advertising a capability as absent is a courtesy to the app; refusing
    // the call is the part that is actually true. A phone that predates the
    // remote link, or one whose capability list went stale mid-session, still
    // gets the same answer.
    if (client.via === 'remote' && msg.method.startsWith('phone.')) {
      return send(client, { t: 'res', id: msg.id, ok: false, error: 'not available on a remote link' })
    }
    try {
      const data = await fn(msg.params || {}, { device: client.device, via: client.via, session: client.id })
      send(client, { t: 'res', id: msg.id, ok: true, data: data ?? null })
    } catch (err) {
      log.debug(`${msg.method} failed:`, err.message)
      send(client, { t: 'res', id: msg.id, ok: false, error: err.message || 'request failed' })
    }
  }

  const publicDevice = (d) => ({ id: d.id, name: d.name, platform: d.platform, pairedAt: d.pairedAt })

  /* ── Fan-out ───────────────────────────────────────────────────────── */

  bus.on('device.report', publishState)
  // The microphone moved: a stream started or ended, or the desktop's input
  // was loaded or unloaded. None of that goes through the socket bookkeeping
  // above, and the panel's only window on it is the status file.
  bus.on('audio.state', publishState)

  bus.on('event', (event, data) => {
    if (event === 'notification') counters.notifications += 1
    // A mirrored message or a ringing phone changes what the bar panel should
    // be showing, so it is republished the same way a connection is.
    if (event === 'phone' && ['received', 'bluetooth', 'ios', 'located'].includes(data?.action)) publishState()
    // An agent that started, finished or got stuck changes what the bar shows.
    // The blocks streaming out of an open chat do not, and there are many.
    if (event === 'agent' && data?.kind !== 'blocks') publishState()
    const message = { t: 'ev', event, data }
    for (const client of clients) {
      if (!client.device || !client.events.has(event)) continue
      // Nothing telephonic travels down a tunnel. The capability list already
      // tells a remote phone there is no telephony here, but the fan-out is
      // where it is actually true: a `call` instruction the desktop issues
      // must not reach a handset that is nowhere near this room, whatever the
      // app on the other end believes it can do.
      if (event === 'phone' && client.via === 'remote') continue
      // And neither does the microphone. A handset that is not in this room is
      // one whose room the person at this desktop has no business listening to,
      // whatever the pairing says.
      if (event === 'audio' && client.via === 'remote') continue
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
      // Phones this desktop could actually ask something of. A socket that
      // arrived down a tunnel is not one of them: the `phone` channel is never
      // fanned out to it, so counting it would leave `requestSend`,
      // `requestCall` and `requestLocate` waiting out a minute for an answer
      // from a handset that was never told anything.
      trackConnections(() => [...clients].filter((c) => c.device && c.via !== 'remote').length)
      startPlugins(bus)
      // Before the socket is open, not after. `endpoints()` reads whatever
      // `overlayState` holds at the moment a `hello` is answered, and in a
      // fresh process that is `overlay.known()` — an empty snapshot. A phone
      // that dials into the gap between `listen` and the first environment
      // read is greeted with the LAN address and nothing else, and writes
      // that list over the one in its keychain, losing the tunnel address it
      // needs the next time it is away from home. The gap used to be
      // theoretical; since the phone redials on the start-up announcement it
      // is the same second, and this read walks `nmcli`, the tailscaled
      // socket and sysfs before it comes back. Nothing can reach the server
      // until it is listening, so doing this first costs a slower start and
      // closes the window entirely.
      await refreshEnvironment()
      await new Promise((resolve, reject) => {
        httpServer.once('error', reject)
        httpServer.listen(listenPort, '0.0.0.0', resolve)
      })
      publishState()
      // Last, and only after `refreshEnvironment`: the packet carries the
      // address this desktop is on, and that address is what was just read.
      announceSelf()
      started = true
      if (certificate) log.ok(`TLS on — pin ${certificate.pin}`)
      return listenPort
    },
    async stop() {
      clearInterval(heartbeat)
      clearInterval(environmentTimer)
      // Before anything else: a burst still in flight would go on telling the
      // subnet this desktop is up while it is being taken down.
      announcer?.stop()
      announcer = null
      started = false
      state.clear()
      stopPlugins()
      for (const client of clients) client.ws.close(1001, 'server shutting down')
      wss.close()
      await new Promise((resolve) => httpServer.close(resolve))
    },
  }

  return api
}
