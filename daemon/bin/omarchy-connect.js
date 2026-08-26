#!/usr/bin/env node
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import https from 'node:https'
import { fileURLToPath } from 'node:url'

import { createServer } from '../src/server.js'
import { loadConfig, saveConfig, removeDevice } from '../src/lib/config.js'
import { CONFIG_FILE } from '../src/lib/paths.js'
import { createPairingCode, pairingUrl, renderQr } from '../src/pairing.js'
import { identity, fingerprint } from '../src/lib/crypto.js'
import * as firewall from '../src/lib/firewall.js'
import * as state from '../src/lib/state.js'
import * as panel from '../src/lib/panel.js'
import * as tls from '../src/lib/tls.js'
import { run, has } from '../src/lib/exec.js'
import { log } from '../src/lib/log.js'
import * as sys from '../src/lib/sys.js'
import { INBOX } from '../src/plugins/share.js'
import { detected as detectedAgents } from '../src/plugins/agents.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const pkg = JSON.parse(fs.readFileSync(path.join(here, '..', 'package.json'), 'utf8'))

const C = log.colors
const dim = (s) => `${C.dim}${s}${C.reset}`
const bold = (s) => `${C.bold}${s}${C.reset}`

function card(title, rows) {
  const width = 58
  const line = (ch) => ch.repeat(width)
  const out = [dim(`┌${line('─')}┐`)]
  out.push(dim('│ ') + bold(title.padEnd(width - 2)) + dim(' │'))
  out.push(dim(`├${line('─')}┤`))
  for (const [label, value] of rows) {
    const left = String(label).toUpperCase().padEnd(16)
    const room = width - 4 - left.length
    // Long values (a config path, a theme name) must not push the border out
    // of alignment — keep the tail, which is the part that identifies them.
    const text = String(value)
    const right = (text.length > room ? `…${text.slice(-(room - 1))}` : text).padStart(room)
    out.push(dim('│ ') + dim(left) + right + dim(' │'))
  }
  out.push(dim(`└${line('─')}┘`))
  return out.join('\n')
}

async function localAddress() {
  const net = await sys.network()
  return net.ip || '127.0.0.1'
}

/**
 * A request to our own daemon on loopback.
 *
 * `fetch` cannot be handed a certificate authority, and once TLS is on the
 * daemon speaks nothing else — so the CLI talks to it through the http/https
 * modules and verifies the desktop's own certificate. That is a real check,
 * not a disabled one: 127.0.0.1 is one of the names the certificate covers.
 */
function daemonRequest(pathname, { method = 'GET', body = null, port = null, timeout = 5000 } = {}) {
  const stored = state.read()
  const target = port || stored?.port || loadConfig().port
  const secure = stored?.tls?.enabled ?? tls.enabled()
  const payload = body === null ? null : Buffer.from(JSON.stringify(body))

  return new Promise((resolve) => {
    const options = {
      host: '127.0.0.1',
      port: target,
      path: pathname,
      method,
      timeout,
      headers: payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {},
    }
    if (secure) {
      const cert = tls.info()
      if (cert) options.ca = cert.cert
    }
    const req = (secure ? https : http).request(options, (res) => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => {
        text += chunk
      })
      res.on('end', () => {
        let data = null
        try {
          data = JSON.parse(text)
        } catch {
          /* a non-JSON body from our own daemon is a failure either way */
        }
        resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, data })
      })
    })
    // A request that ran out of time and one that never connected both come
    // back with no status; only the first of them means the daemon is there
    // and something behind it is taking too long.
    let expired = false
    req.on('timeout', () => {
      expired = true
      req.destroy(new Error('timeout'))
    })
    req.on('error', () => resolve({ ok: false, status: 0, data: null, timeout: expired }))
    if (payload) req.write(payload)
    req.end()
  })
}

/* ── commands ────────────────────────────────────────────────────────── */

async function cmdStart(args) {
  const cfg = loadConfig()
  const port = Number(args.port) || cfg.port
  const server = createServer({ port, version: pkg.version })
  await server.start()

  const ip = await localAddress()
  console.log(
    card('OMARCHY CONNECT', [
      ['host', cfg.deviceName],
      ['address', `${ip}:${port}`],
      ['devices', String(cfg.devices.length)],
      ['fingerprint', fingerprint(identity().publicKey)],
      ['inbox', INBOX.replace(os.homedir(), '~')],
      ['config', CONFIG_FILE.replace(os.homedir(), '~')],
    ]),
  )

  warnIfFirewalled(port, ip)

  if (cfg.devices.length === 0 || args.pair) {
    console.log()
    await showPairing(port, ip, cfg.deviceName)
  } else {
    console.log(dim('\n  run `omarchy-connect pair` to add another device\n'))
  }

  const shutdown = async () => {
    console.log(dim('\nshutting down…'))
    await server.stop()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

/**
 * A daemon behind a closed port looks identical to a broken one from the
 * phone, so say it out loud rather than letting the user debug a timeout.
 */
function warnIfFirewalled(port, ip) {
  const state = firewall.check(port, ip)
  if (!state.blocked) return
  console.log()
  log.warn(`${state.tool} is running and port ${port} is not open — phones on your network cannot reach this daemon`)
  console.log(dim(`  ${state.command}`))
}

async function showPairing(port, ip, name) {
  const pairing = createPairingCode()
  const key = identity().publicKey.toString('hex')
  const cert = tls.enabled() ? tls.info() : null
  const url = pairingUrl({
    host: ip,
    port,
    code: pairing.code,
    name,
    key,
    tls: Boolean(cert),
    pin: cert?.pin ?? null,
  })
  const qr = await renderQr(url)
  if (qr) console.log(qr)
  console.log(
    card('PAIRING', [
      ['code', pairing.code],
      ['address', `${cert ? 'https' : 'http'}://${ip}:${port}`],
      ['fingerprint', fingerprint(key)],
      ...(cert ? [['tls pin', cert.pin]] : []),
      ['expires', `${Math.round((pairing.expiresAt - Date.now()) / 1000)}s`],
    ]),
  )
  console.log(dim('\n  scan the code in the Omarchy Connect app, or enter the address manually'))
  console.log(dim('  typing it by hand? check the fingerprint matches the one the app shows\n'))
}

async function cmdPair(args) {
  const cfg = loadConfig()
  const ip = await localAddress()
  const res = await daemonRequest('/api/pair-code', { method: 'POST' })
  if (!res.ok) {
    log.error('daemon is not running — start it with `omarchy-connect start`')
    process.exit(1)
  }
  const { code, expiresAt } = res.data
  const key = identity().publicKey.toString('hex')
  const live = state.read()
  const cert = live?.tls?.enabled ? tls.info() : null
  const url = pairingUrl({
    host: ip,
    port: cfg.port,
    code,
    name: cfg.deviceName,
    key,
    tls: Boolean(cert),
    pin: cert?.pin ?? null,
  })
  const qr = await renderQr(url)
  if (qr) console.log(qr)
  console.log(
    card('PAIRING', [
      ['code', code],
      ['address', `${cert ? 'https' : 'http'}://${ip}:${cfg.port}`],
      ['fingerprint', fingerprint(key)],
      ...(cert ? [['tls pin', cert.pin]] : []),
      ['expires', `${Math.round((expiresAt - Date.now()) / 1000)}s`],
    ]),
  )
  if (args?.wait) await waitForPairing(cfg.port, expiresAt)
}

/**
 * Holds the QR on screen until it is used or dies. The desktop client opens
 * this in a floating terminal, and a window that vanishes the instant it
 * appears is not a pairing flow.
 */
async function waitForPairing(port, expiresAt) {
  const before = loadConfig().devices.length
  console.log(dim('\n  waiting for a phone…  (ctrl-c to stop)'))
  while (Date.now() < expiresAt) {
    await new Promise((resolve) => setTimeout(resolve, 1000))
    const { data: info } = await daemonRequest('/api/info', { port })
    if (!info) {
      log.error('daemon went away')
      process.exit(1)
    }
    if (info.pairing) continue
    // The code was consumed. Whether that produced a device is the only
    // difference between a success and five wrong guesses.
    const live = state.read()
    const after = live ? live.devices.length : loadConfig().devices.length
    if (after > before) log.ok('phone paired')
    else log.warn('pairing code was used up without a phone joining')
    return
  }
  log.warn('pairing code expired')
}

function cmdDevices() {
  const cfg = loadConfig()
  if (!cfg.devices.length) {
    console.log(dim('no paired devices — run `omarchy-connect pair`'))
    return
  }
  console.log(
    card(
      'PAIRED DEVICES',
      cfg.devices.map((d) => [
        d.name,
        `${d.platform} · ${d.lastSeen ? new Date(d.lastSeen).toLocaleString() : 'never seen'}`,
      ]),
    ),
  )
}

async function cmdUnpair(args) {
  const target = args._[0]
  if (!target) {
    log.error('usage: omarchy-connect unpair <device-name-or-id>')
    process.exit(1)
  }
  // Ask the daemon first: it holds a cached config and possibly an open
  // socket to the phone, neither of which a config edit here would reach.
  const res = await daemonRequest('/api/unpair', { method: 'POST', body: { id: target } })

  if (res.ok) {
    log.ok(`unpaired ${res.data.device.name}`)
    return
  }
  if (res.status === 404) {
    log.error(`no paired device matching "${target}"`)
    process.exit(1)
  }

  const removed = removeDevice(target)
  if (!removed) {
    log.error(`no paired device matching "${target}"`)
    process.exit(1)
  }
  log.ok(`unpaired ${removed.name}`)
}

async function cmdSend(args) {
  const file = args.pick ? await pickFile() : args._[0]
  if (!file) {
    if (args.pick) return
    log.error('usage: omarchy-connect send <file>   (or --pick to browse)')
    process.exit(1)
  }
  const abs = path.resolve(file)
  if (!fs.existsSync(abs)) {
    log.error(`no such file: ${abs}`)
    process.exit(1)
  }
  const res = await daemonRequest('/api/offer', { method: 'POST', body: { path: abs } })
  if (!res.status) {
    log.error('daemon is not running — start it with `omarchy-connect start`')
    process.exit(1)
  }
  const body = res.data || {}
  if (!res.ok) {
    log.error(body.error || 'could not offer the file')
    process.exit(1)
  }
  console.log(
    card('SENT TO PHONE', [
      ['file', body.name],
      ['size', `${(body.size / 1024).toFixed(1)} KB`],
      ['recipients', String(body.recipients)],
      ['expires', '30 min'],
    ]),
  )
  if (body.recipients === 0) log.warn('no phone is connected right now — it will not see the offer')
}

/**
 * The status file plus a liveness probe. The file alone cannot tell a running
 * daemon from one that was killed with -9, so loopback has the final word on
 * `running` — and heals a stale file for the desktop client at the same time.
 */
async function liveStatus() {
  const cfg = loadConfig()
  const stored = state.read()
  const port = stored?.port || cfg.port
  const { data: info } = await daemonRequest('/api/info', { port, timeout: 1500 })

  if (!info) {
    const snapshot = stored ? { ...stored, running: false, pid: null } : state.baseSnapshot({ version: pkg.version })
    snapshot.at = Date.now()
    snapshot.devices = (snapshot.devices || []).map((d) => ({ ...d, online: false, address: null }))
    if (stored?.running) state.clear()
    return snapshot
  }
  const snapshot = stored || state.baseSnapshot({ version: pkg.version, port })
  return { ...snapshot, running: true, at: Date.now() }
}

/**
 * The desktop client has no file dialog of its own, so browsing happens where
 * Omarchy already puts interactive prompts: gum, in a floating terminal.
 */
async function pickFile() {
  if (!has('gum')) {
    log.error('gum is not installed — pass a path instead: omarchy-connect send <file>')
    return null
  }
  const res = await run('gum', ['file', '--height', '20', os.homedir()], { stdio: 'inherit', timeout: 0 })
  const chosen = res.stdout.trim()
  if (!chosen) {
    console.log(dim('  nothing picked'))
    return null
  }
  return chosen
}

async function cmdStatus(args) {
  const snapshot = await liveStatus()
  if (args?.json) {
    console.log(JSON.stringify(snapshot, null, 2))
    return
  }
  const online = (snapshot.devices || []).filter((d) => d.online).length
  console.log(
    card('STATUS', [
      ['name', snapshot.name],
      ['daemon', snapshot.running ? 'running' : 'stopped'],
      ['address', snapshot.host ? `${snapshot.host}:${snapshot.port}` : `port ${snapshot.port}`],
      ['devices', `${online} online / ${(snapshot.devices || []).length} paired`],
      ['encryption', snapshot.encryption],
      ['transport', snapshot.tls?.enabled ? 'https + wss' : 'http + ws'],
      ['fingerprint', snapshot.fingerprint],
      ['config', CONFIG_FILE.replace(os.homedir(), '~')],
      ['status file', state.STATUS_FILE.replace(os.homedir(), '~')],
      ['version', pkg.version],
    ]),
  )
}

/**
 * The desktop has no radio. Sending an SMS is therefore a request to the
 * phone, and this waits for the phone to say it went out rather than
 * reporting success the moment the request leaves.
 */
async function cmdSms(args) {
  const [to, ...words] = args._
  const body = args.body ? String(args.body) : words.join(' ')
  if (!to || !body) {
    log.error('usage: omarchy-connect sms <number> <message…>')
    process.exit(1)
  }
  const res = await daemonRequest('/api/sms', { method: 'POST', body: { to, body }, timeout: 65_000 })
  if (!res.status) {
    log.error(
      res.timeout
        ? 'the phone did not answer — open the app on the handset and try again'
        : 'daemon is not running — start it with `omarchy-connect start`',
    )
    process.exit(1)
  }
  if (!res.ok) {
    log.error(res.data?.error || 'the message was not sent')
    process.exit(1)
  }
  log.ok(`sent to ${to}`)
}

/**
 * Answer, reject, hang up or place a call.
 *
 * The daemon decides which road it takes. Over Bluetooth this needs nothing on
 * the phone and puts the conversation on the desktop's speakers; over the app
 * it only presses the button, and the audio stays on the handset. `call status`
 * says which one is available before you commit to it.
 */
async function cmdCall(args) {
  const [action = 'status', ...rest] = args._
  const number = rest.join('').trim() || null

  if (action === 'status') {
    const snapshot = await liveStatus()
    const bt = snapshot.phone?.bluetooth || {}
    // The merged field covers a call the app mirrored as well as one the
    // hands-free profile published; `bt.call` is the fallback for a daemon
    // older than that field.
    const live = snapshot.phone?.call || bt.call
    console.log(
      card('CALL CONTROL', [
        ['bluetooth', bt.available === false ? 'unsupported' : bt.connected ? 'connected' : 'not connected'],
        ['handset', bt.device || dim('—')],
        ['audio', bt.connected ? bt.audio || 'idle' : dim('—')],
        ['app', (snapshot.devices || []).some((d) => d.online) ? 'connected' : 'not connected'],
        [
          'in progress',
          live
            ? `${live.name || live.from || 'unknown'} (${live.state}${live.via ? ` · ${live.via}` : ''})`
            : dim('none'),
        ],
      ]),
    )
    if (bt.available === false) {
      console.log(
        dim('\n  PipeWire is not publishing org.pipewire.Telephony — needs PipeWire 1.4+\n'),
      )
    } else if (!bt.connected) {
      console.log(
        dim('\n  pair the phone in Bluetooth settings to answer with audio on this machine\n'),
      )
    }
    return
  }

  if (!['answer', 'reject', 'hangup', 'dial', 'tones', 'audio'].includes(action)) {
    log.error('usage: omarchy-connect call <status|answer|reject|hangup|audio|dial NUMBER|tones DIGITS>')
    process.exit(1)
  }
  if ((action === 'dial' || action === 'tones') && !number) {
    log.error(`usage: omarchy-connect call ${action} <${action === 'dial' ? 'number' : 'digits'}>`)
    process.exit(1)
  }

  const res = await daemonRequest('/api/call', {
    method: 'POST',
    body: { op: action, id: args.id ? String(args.id) : null, number },
    timeout: 65_000,
  })
  if (!res.status) {
    log.error(
      res.timeout
        ? 'the phone did not answer — open the app on the handset and try again'
        : 'daemon is not running — start it with `omarchy-connect start`',
    )
    process.exit(1)
  }
  if (!res.ok) {
    log.error(res.data?.error || `could not ${action} the call`)
    process.exit(1)
  }
  const via = res.data?.via === 'bluetooth' ? 'over Bluetooth' : 'through the app'
  const done = {
    answer: 'answered',
    reject: 'rejected',
    hangup: 'hung up',
    dial: `dialling ${number}`,
    tones: 'sent',
    audio: 'audio link opened',
  }
  log.ok(`${done[action]} ${via}`)
  if (action === 'answer' && res.data?.via !== 'bluetooth') {
    console.log(dim('  the call is on the handset — connect Bluetooth to hear it here'))
  }
}

/**
 * The iPhone bridge: Bluetooth Low Energy, not the app.
 *
 * iOS publishes no messages, no call log and no notification centre to any
 * app, but it publishes all three to an accessory. This is how the desktop
 * asks to be treated as one.
 */
async function cmdIos(args) {
  const [action = 'status'] = args._

  if (action === 'status') {
    const snapshot = await liveStatus()
    const ios = snapshot.phone?.ios || {}
    const bt = snapshot.phone?.bluetooth || {}
    console.log(
      card('IPHONE BRIDGE', [
        ['bluetooth le', ios.available === false ? 'unavailable' : ios.subscribed ? 'mirroring' : 'not mirroring'],
        ['iphone', ios.device || dim('—')],
        ['bonded', ios.paired ? 'yes' : dim('no')],
        ['pairing', ios.pairing ? `open for ${Math.max(0, Math.round((ios.pairing.until - Date.now()) / 1000))}s` : dim('closed')],
        ['calls + audio', bt.connected ? bt.device || 'connected' : dim('not connected')],
      ]),
    )
    if (ios.available === false) {
      console.log(dim('\n  BlueZ is not running — start bluetooth.service\n'))
    } else if (!ios.subscribed) {
      console.log(
        dim(
          '\n  run `omarchy-connect ios pair`, then pick this desktop in the iPhone\n' +
            '  under Settings › Bluetooth and allow it to show notifications\n',
        ),
      )
    } else {
      console.log(dim('\n  messages, calls and app notifications are mirroring from this iPhone\n'))
    }
    return
  }

  if (action !== 'pair' && action !== 'stop') {
    log.error('usage: omarchy-connect ios <status|pair|stop>')
    process.exit(1)
  }

  const res = await daemonRequest('/api/ios', {
    method: 'POST',
    body: { op: action, seconds: args.seconds ? Number(args.seconds) : null },
  })
  if (!res.status) {
    log.error('daemon is not running — start it with `omarchy-connect start`')
    process.exit(1)
  }
  if (!res.ok) {
    log.error(res.data?.error || `could not ${action}`)
    process.exit(1)
  }
  if (action === 'stop') {
    log.ok(res.data?.stopped ? 'pairing window closed' : 'no pairing window was open')
    return
  }
  log.ok(`this desktop is discoverable for ${res.data.seconds}s`)
  console.log(
    dim(
      '\n  on the iPhone: Settings › Bluetooth, tap this desktop, then Pair.\n' +
        '  iOS will ask whether to show notifications on it — say yes; that\n' +
        '  prompt is the whole feature.\n',
    ),
  )
}

/** What the phone has mirrored over: messages and calls, newest first. */
async function cmdPhone(args) {
  const snapshot = await liveStatus()
  const phone = snapshot.phone || { messages: 0, calls: 0, missed: 0, sent: 0, recent: [] }
  const bt = phone.bluetooth || {}
  const ios = phone.ios || {}
  console.log(
    card('PHONE', [
      ['messages', String(phone.messages)],
      ['calls', String(phone.calls)],
      ['missed', String(phone.missed)],
      ['sent', String(phone.sent)],
      ['answered', String(phone.answered ?? 0)],
      ['notifications', String(phone.notifications ?? 0)],
      ['bluetooth', bt.connected ? bt.device || 'connected' : dim('not connected')],
      ['iphone', ios.subscribed ? ios.device || 'mirroring' : dim('not mirroring')],
    ]),
  )
  const items = (phone.recent || []).slice(0, Number(args.limit) || 5)
  if (!items.length) {
    // No longer Android-only: calls also arrive over the hands-free profile,
    // which is the one road an iPhone will travel.
    console.log(
      dim(
        bt.connected || ios.subscribed
          ? '\n  nothing mirrored yet — this will fill up as the phone is used\n'
          : '\n  nothing mirrored yet — an iPhone needs `omarchy-connect ios pair`,\n' +
            '  an Android build mirrors messages and calls through the app\n',
      ),
    )
    return
  }
  console.log()
  for (const item of items) {
    const who = item.name || item.from || 'unknown'
    const when = new Date(item.at).toLocaleTimeString()
    const line = (value) => String(value || '').replace(/\s+/g, ' ').slice(0, 60)
    const what =
      item.kind === 'notification'
        ? line(item.body || item.title)
        : item.kind === 'sms'
          ? line(item.body)
          : item.missed
            ? 'missed call'
            : item.state || 'call'
    const label = item.kind === 'notification' ? item.appName || item.app || 'app' : who
    const road = item.via === 'bluetooth' ? dim(' bt') : item.via === 'ancs' ? dim(' le') : '   '
    console.log(`  ${dim(when)}${road}  ${bold(label.padEnd(18).slice(0, 18))}  ${what}`)
  }
  console.log()
}

async function cmdFirewall() {
  const cfg = loadConfig()
  const ip = await localAddress()
  const state = firewall.check(cfg.port, ip)
  console.log(
    card('FIREWALL', [
      ['tool', state.tool ?? 'none detected'],
      ['port', String(cfg.port)],
      ['reachable', state.blocked ? 'no' : 'yes'],
    ]),
  )
  if (!state.blocked) {
    console.log(dim('\n  nothing to do — phones on your network can reach the daemon\n'))
    return
  }
  console.log(dim('\n  run this to let phones on your network in:\n'))
  console.log(`  ${state.command}`)
  console.log(dim('\n  the rule is scoped to your own subnet, not the whole internet\n'))
}

/**
 * The desktop client: an Omarchy shell plugin that puts this daemon in the
 * bar. It is a plain folder of QML the shell loads on demand, so installing
 * is a copy, a rescan, and an enable — all in user space.
 */
async function cmdPanel(args) {
  const action = args._[0] || 'status'

  if (action === 'status') {
    console.log(
      card('DESKTOP CLIENT', [
        ['plugin', panel.PLUGIN_ID],
        ['source', panel.available() ? panel.SOURCE_DIR.replace(os.homedir(), '~') : 'missing'],
        ['installed', panel.installed() ? panel.TARGET_DIR.replace(os.homedir(), '~') : 'no'],
        ['in the bar', panel.enabled() ? 'yes' : 'no'],
        ['shell', panel.shellRunning() ? 'omarchy-shell found' : 'not found'],
      ]),
    )
    if (!panel.installed()) console.log(dim('\n  omarchy-connect panel install\n'))
    return
  }

  if (action === 'install') {
    // Seed the status file so the freshly-installed panel has a desktop to
    // describe — its name, fingerprint, and paired phones — before the daemon
    // has ever run under it.
    if (!state.read()) state.publish(state.baseSnapshot({ version: pkg.version }))

    const reinstall = panel.installed()
    const files = panel.copyPlugin()
    log.ok(`copied ${files.length} files to ${panel.TARGET_DIR.replace(os.homedir(), '~')}`)

    const checked = await panel.validate()
    if (!checked.ok) {
      log.error(`the shell would reject this plugin: ${checked.error}`)
      process.exit(1)
    }
    if (checked.skipped) log.warn(`skipped manifest validation — ${checked.skipped}`)

    if (await panel.rescan()) log.ok('shell rescanned its plugins')
    else log.warn('could not reach omarchy-shell — restart it to pick the plugin up')

    if (panel.enabled()) {
      log.ok('already in the bar')
    } else {
      const section = typeof args.section === 'string' ? args.section : 'right'
      const result = await panel.enable(section)
      if (result.ok) log.ok(`added to the ${section} of the bar`)
      else log.warn(`could not enable automatically: ${result.error}`)
    }
    // A rescan reloads plugin *code*, but a bar widget that is already mounted
    // keeps its compiled component, so an upgrade does not show until the
    // shell process is replaced. Say so rather than letting the user wonder
    // why their new version looks like the old one.
    if (reinstall) log.warn('run `omarchy-restart-shell` to load the new version — a rescan will not replace a mounted widget')
    console.log(dim('\n  click the phone icon in the bar, or `omarchy-shell omarchy-connect toggle`\n'))
    return
  }

  if (action === 'remove') {
    const result = await panel.disable()
    if (!result.ok) log.warn(`could not remove from the bar: ${result.error}`)
    panel.removeFiles()
    await panel.rescan()
    log.ok('desktop client removed')
    return
  }

  log.error('usage: omarchy-connect panel <status|install|remove> [--section left|center|right]')
  process.exit(1)
}

/**
 * TLS is a two-sided switch: the desktop has to serve it and the phone has to
 * trust it. This command owns the desktop half and hands over what the phone
 * half needs — the pin for a QR, or the certificate itself for an Android
 * build that wants to trust it natively.
 */
async function cmdTls(args) {
  const action = args._[0] || 'status'
  const cfg = loadConfig()
  const live = state.read()
  const restartHint = () => {
    if (live?.running) log.warn('restart the daemon for this to take effect: systemctl --user restart omarchy-connect')
  }

  if (action === 'status') {
    const cert = tls.info()
    console.log(
      card('TLS', [
        ['enabled', cfg.tls === true ? 'yes' : 'no'],
        ['serving', live?.tls?.enabled ? 'https + wss' : 'http + ws'],
        ['certificate', cert ? 'present' : 'none'],
        ...(cert
          ? [
              ['pin', cert.pin],
              ['sha-256', cert.fingerprint],
              ['expires', cert.notAfter],
              ['covers', cert.sans.join(' ')],
            ]
          : []),
      ]),
    )
    if (!cert) console.log(dim('\n  omarchy-connect tls enable   mint a certificate and switch it on\n'))
    return
  }

  if (action === 'enable') {
    const cert = tls.ensure({ force: !tls.info() })
    saveConfig({ ...cfg, tls: true })
    log.ok('TLS on')
    console.log(card('TLS', [['pin', cert.pin], ['expires', cert.notAfter], ['covers', cert.sans.join(' ')]]))
    console.log(dim('\n  phones paired before now have to pair again — the QR carries the pin\n'))
    restartHint()
    return
  }

  if (action === 'disable') {
    saveConfig({ ...cfg, tls: false })
    log.ok('TLS off — the daemon will serve http + ws again')
    restartHint()
    return
  }

  if (action === 'refresh') {
    // Same key, new certificate: this is how a changed address is answered
    // without invalidating what any phone already pinned.
    const cert = tls.ensure({ force: true })
    log.ok(`certificate reissued for ${cert.sans.join(' ')}`)
    console.log(dim(`  pin unchanged: ${cert.pin}`))
    restartHint()
    return
  }

  if (action === 'rotate') {
    const cert = tls.rotate()
    log.ok(`new key and certificate — pin ${cert.pin}`)
    console.log(dim('\n  every paired phone has to pair again\n'))
    restartHint()
    return
  }

  if (action === 'export') {
    const target = args._[1] || path.join(process.cwd(), 'omarchy-connect-desktop.pem')
    const out = tls.exportCertificate(target)
    log.ok(`wrote ${out.path}`)
    console.log(dim(`  pin ${out.pin}`))
    return
  }

  // Android can be told at build time to trust one extra certificate. Dropping
  // it into the app's assets is what lets a real build stream uploads over
  // https natively instead of falling back to encrypting the body in JS.
  if (action === 'trust') {
    const appDir = path.resolve(args._[1] || path.join(here, '..', '..', 'app'))
    if (!fs.existsSync(path.join(appDir, 'app.json'))) {
      log.error(`that does not look like the Expo app: ${appDir}`)
      process.exit(1)
    }
    const out = tls.exportCertificate(path.join(appDir, 'assets', 'desktop-ca.pem'))
    log.ok(`wrote ${out.path.replace(os.homedir(), '~')}`)
    console.log(dim(`  pin ${out.pin}`))
    console.log(dim('\n  rebuild the app for Android to pick it up:  npx expo run:android\n'))
    return
  }

  log.error('usage: omarchy-connect tls <status|enable|disable|refresh|rotate|export [path]|trust [app-dir]>')
  process.exit(1)
}

function cmdConfig(args) {
  const [key, value] = args._
  const cfg = loadConfig()
  if (!key) {
    console.log(JSON.stringify(cfg, (k, v) => (k === 'token' ? '***' : v), 2))
    return
  }
  if (value === undefined) {
    console.log(cfg[key] ?? '')
    return
  }
  if (!(key in cfg) || key === 'devices') {
    log.error(`cannot set "${key}"`)
    process.exit(1)
  }
  const parsed = value === 'true' ? true : value === 'false' ? false : /^\d+$/.test(value) ? Number(value) : value
  cfg[key] = parsed
  saveConfig(cfg)
  log.ok(`${key} = ${parsed}`)
}

/* ── coding agents ───────────────────────────────────────────────────── */

const CLAUDE_SETTINGS = path.join(os.homedir(), '.claude', 'settings.json')
/** The lifecycle events worth a hook: everything the state machine needs. */
const HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'Stop', 'Notification', 'SessionEnd']

const shellQuote = (value) => (/[\s"'$`\\]/.test(value) ? `'${value.replace(/'/g, `'\\''`)}'` : value)

/** How a hook invokes this CLI again, without depending on $PATH. */
const hookCommand = () => [...state.execCommand().map(shellQuote), 'agent', 'hook'].join(' ')

const isOurHook = (entry) =>
  typeof entry?.command === 'string' && entry.command.includes('agent hook') && entry.command.includes('omarchy-connect')

function readClaudeSettings() {
  try {
    return JSON.parse(fs.readFileSync(CLAUDE_SETTINGS, 'utf8'))
  } catch (err) {
    if (err.code === 'ENOENT') return {}
    throw new Error(`${CLAUDE_SETTINGS} is not valid JSON — fix it first`)
  }
}

function hooksInstalled() {
  const hooks = readClaudeSettings().hooks || {}
  return HOOK_EVENTS.every((event) =>
    (hooks[event] || []).some((group) => (group.hooks || []).some(isOurHook)),
  )
}

/**
 * Add — or remove — our hook from Claude Code's settings without disturbing
 * anybody else's. Every write strips our own entries first, so running this
 * twice leaves one hook rather than two.
 */
function writeHooks(install) {
  const settings = readClaudeSettings()
  const hooks = { ...(settings.hooks || {}) }
  const command = hookCommand()

  for (const event of Object.keys(hooks)) {
    const groups = (hooks[event] || [])
      .map((group) => ({ ...group, hooks: (group.hooks || []).filter((h) => !isOurHook(h)) }))
      .filter((group) => group.hooks.length)
    if (groups.length) hooks[event] = groups
    else delete hooks[event]
  }

  if (install) {
    for (const event of HOOK_EVENTS) {
      hooks[event] = [...(hooks[event] || []), { hooks: [{ type: 'command', command, timeout: 5 }] }]
    }
  }

  const next = { ...settings }
  if (Object.keys(hooks).length) next.hooks = hooks
  else delete next.hooks
  fs.mkdirSync(path.dirname(CLAUDE_SETTINGS), { recursive: true })
  fs.writeFileSync(CLAUDE_SETTINGS, JSON.stringify(next, null, 2) + '\n')
  return command
}

/**
 * The bridge between a coding agent's hook and this daemon.
 *
 * Claude Code feeds a hook JSON on stdin and waits for it. That makes every
 * failure mode here the agent's problem, so there is only one rule: be quick
 * and exit 0. A daemon that is not running is a silent no-op, not an error.
 */
async function cmdAgentHook() {
  let raw = ''
  try {
    process.stdin.setEncoding('utf8')
    for await (const chunk of process.stdin) {
      raw += chunk
      if (raw.length > 64 * 1024) break
    }
  } catch {
    /* no stdin is survivable — the environment below still says something */
  }

  let payload = {}
  try {
    payload = JSON.parse(raw || '{}')
  } catch {
    payload = {}
  }

  // The environment is the half the payload cannot carry: the hook was spawned
  // by the agent itself, so its parent is the process we are looking for and
  // its `$TMUX_PANE` is the pane that owns the terminal.
  await daemonRequest('/api/agent/hook', {
    method: 'POST',
    timeout: 1000,
    body: {
      ...payload,
      agent: 'claude',
      ppid: process.ppid,
      pane: process.env.TMUX_PANE || null,
    },
  })
  process.exit(0)
}

async function cmdAgent(args) {
  const action = args._[0] || 'status'

  if (action === 'hook') return cmdAgentHook()

  const cfg = loadConfig()
  const live = state.read()
  const restartHint = () => {
    if (live?.running) log.warn('restart the daemon for this to take effect: systemctl --user restart omarchy-connect')
  }

  if (action === 'enable' || action === 'disable') {
    const on = action === 'enable'
    saveConfig({ ...cfg, agents: { ...(cfg.agents || {}), enabled: on } })
    if (on) {
      log.ok('agent control on')
      console.log(
        dim(
          '\n  a paired phone can now read every coding agent session on this\n' +
            '  desktop — the source it saw, the commands it ran, the output of\n' +
            '  those commands. Pair only phones you own.\n',
        ),
      )
      if (!hooksInstalled()) console.log(dim('  omarchy-connect agent install-hooks   to know when an agent is stuck\n'))
    } else {
      log.ok('agent control off')
    }
    restartHint()
    return
  }

  if (action === 'install-hooks' || action === 'uninstall-hooks') {
    const install = action === 'install-hooks'
    const command = writeHooks(install)
    if (install) {
      log.ok(`hooks installed in ${CLAUDE_SETTINGS.replace(os.homedir(), '~')}`)
      console.log(card('CLAUDE CODE HOOKS', HOOK_EVENTS.map((event) => [event, 'installed'])))
      console.log(dim(`\n  ${command}\n`))
      console.log(dim('  already-running agents pick these up when they next start\n'))
    } else {
      log.ok('hooks removed')
    }
    return
  }

  const agents = live?.agents || { enabled: cfg.agents?.enabled === true, adapters: [], sessions: [], waiting: 0 }

  if (action === 'list') {
    const sessions = agents.sessions || []
    if (!sessions.length) {
      console.log(dim('\n  no coding agent is running on this desktop\n'))
      return
    }
    for (const session of sessions) {
      console.log(
        card(`${session.agent.toUpperCase()} · ${session.title}`, [
          ['state', session.state + (session.state === 'waiting' ? ' ← needs you' : '')],
          ['id', session.id],
          ['directory', session.cwd || '—'],
          ['pid', session.pid ? String(session.pid) : '—'],
          ['found by', session.via],
          ['writable', session.writable || 'no — reading only'],
          ['last activity', session.lastActivity ? new Date(session.lastActivity).toLocaleTimeString() : '—'],
        ]),
      )
      if (session.preview) console.log(dim(`  ${session.preview.slice(0, 56)}\n`))
    }
    return
  }

  if (action !== 'status') {
    log.error('usage: omarchy-connect agent <status|enable|disable|list|install-hooks|uninstall-hooks>')
    process.exit(1)
  }

  console.log(
    card('CODING AGENTS', [
      ['reading', agents.enabled ? 'on' : 'off'],
      ['writing', 'not yet — stage two'],
      // With the daemon down the status file knows nothing about what is
      // installed, so ask the adapters themselves rather than report none.
      ['adapters', ((agents.adapters || []).length ? agents.adapters : detectedAgents()).join(' ') || dim('none detected')],
      ['hooks', hooksInstalled() ? 'installed' : dim('not installed')],
      ['sessions', String((agents.sessions || []).length)],
      ['waiting on you', String(agents.waiting || 0)],
    ]),
  )
  if (!agents.enabled) {
    console.log(dim('\n  omarchy-connect agent enable   let a paired phone read these sessions\n'))
  } else if (!hooksInstalled()) {
    console.log(
      dim(
        '\n  without hooks a session is found by scanning /proc, which cannot\n' +
          '  tell when an agent is waiting for an answer:\n\n' +
          '  omarchy-connect agent install-hooks\n',
      ),
    )
  } else if (!live?.running) {
    console.log(dim('\n  the daemon is not running, so nothing is watching\n'))
  }
}

const SERVICE = `[Unit]
Description=Omarchy Connect daemon
After=graphical-session.target
PartOf=graphical-session.target

[Service]
Type=simple
ExecStart=%NODE% %ENTRY% start
Restart=on-failure
RestartSec=3

[Install]
WantedBy=graphical-session.target
`

function cmdInstallService() {
  const dir = path.join(os.homedir(), '.config', 'systemd', 'user')
  fs.mkdirSync(dir, { recursive: true })
  const target = path.join(dir, 'omarchy-connect.service')
  const entry = path.join(here, 'omarchy-connect.js')
  fs.writeFileSync(target, SERVICE.replace('%NODE%', process.execPath).replace('%ENTRY%', entry))
  log.ok(`wrote ${target.replace(os.homedir(), '~')}`)
  console.log(dim('\n  systemctl --user daemon-reload'))
  console.log(dim('  systemctl --user enable --now omarchy-connect\n'))
}

/* ── entry ───────────────────────────────────────────────────────────── */

function parseArgs(argv) {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg.startsWith('--')) {
      const [key, inline] = arg.slice(2).split('=')
      if (inline !== undefined) out[key] = inline
      else if (argv[i + 1] && !argv[i + 1].startsWith('-')) out[key] = argv[++i]
      else out[key] = true
    } else {
      out._.push(arg)
    }
  }
  return out
}

const USAGE = `${bold('omarchy-connect')} ${dim(`v${pkg.version}`)}

  ${bold('start')} [--port N] [--pair]   run the daemon
  ${bold('pair')} [--wait]               show a pairing QR code
  ${bold('devices')}                     list paired devices
  ${bold('unpair')} <name|id>            forget a device
  ${bold('send')} <file> | --pick        offer a file to connected phones
  ${bold('status')} [--json]             show live daemon status
  ${bold('sms')} <number> <message…>     send an SMS through the paired phone
  ${bold('call')} <status|answer|reject|…>  answer or place a call
  ${bold('ios')} <status|pair|stop>       mirror an iPhone over Bluetooth LE
  ${bold('phone')} [--limit N]           mirrored messages and calls
  ${bold('agent')} <status|enable|list|…>  read this desktop's coding agents
  ${bold('config')} [key] [value]        read or change configuration
  ${bold('firewall')}                    check whether the port is reachable
  ${bold('tls')} <status|enable|…>       serve https + wss with a pinned certificate
  ${bold('panel')} <status|install|remove>  the Omarchy bar client
  ${bold('install-service')}             write a systemd user unit
`

const [, , rawCommand = 'start', ...rest] = process.argv
const args = parseArgs(rest)

const commands = {
  start: cmdStart,
  pair: cmdPair,
  devices: cmdDevices,
  unpair: cmdUnpair,
  send: cmdSend,
  status: cmdStatus,
  sms: cmdSms,
  call: cmdCall,
  ios: cmdIos,
  phone: cmdPhone,
  agent: cmdAgent,
  config: cmdConfig,
  firewall: cmdFirewall,
  tls: cmdTls,
  panel: cmdPanel,
  'install-service': cmdInstallService,
  help: () => console.log(USAGE),
}

const command = commands[rawCommand]
if (!command) {
  console.log(USAGE)
  process.exit(1)
}

try {
  await command(args)
} catch (err) {
  log.error(err)
  process.exit(1)
}
