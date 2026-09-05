#!/usr/bin/env node
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import https from 'node:https'
import { fileURLToPath } from 'node:url'

import { createServer } from '../src/server.js'
import { loadConfig, saveConfig, removeDevice, pairedDevice } from '../src/lib/config.js'
import { CONFIG_FILE } from '../src/lib/paths.js'
import { createPairingCode, pairingUrl, renderQr } from '../src/pairing.js'
import { identity, fingerprint } from '../src/lib/crypto.js'
import * as firewall from '../src/lib/firewall.js'
import * as wol from '../src/lib/wol.js'
import * as state from '../src/lib/state.js'
import * as panel from '../src/lib/panel.js'
import * as tls from '../src/lib/tls.js'
import { run, has, spawn, spawnDetached, notifyArgs } from '../src/lib/exec.js'
import { log } from '../src/lib/log.js'
import { installCrashGuard } from '../src/lib/guard.js'
import * as sys from '../src/lib/sys.js'
import * as overlay from '../src/lib/overlay.js'
import { INBOX } from '../src/plugins/share.js'
import { detected as detectedAgents } from '../src/agents/index.js'
import * as agentHooks from '../src/agents/hooks.js'
import * as agentTmux from '../src/agents/tmux.js'
import * as agentStatusline from '../src/agents/statusline.js'
import * as agentWriter from '../src/agents/writer.js'
import * as agentLimits from '../src/agents/limits.js'

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
    // The two spaces inside the borders are already spent by the padding
    // above, so a row is the label plus whatever is left of the width — take
    // any more and the right border walks off the one the title row drew.
    const room = width - 2 - left.length
    // Long values (a config path, a theme name) must not push the border out
    // of alignment — keep the tail, which is the part that identifies them.
    const text = String(value)
    const right = (text.length > room ? `…${text.slice(-(room - 1))}` : text).padStart(room)
    out.push(dim('│ ') + dim(left) + right + dim(' │'))
  }
  out.push(dim(`└${line('─')}┘`))
  return out.join('\n')
}

const ANSI = /\u001b\[[0-9;]*m/g
const visibleWidth = (text) => text.replace(ANSI, '').length

/**
 * The pairing QR and its card, laid out for the window they landed in.
 *
 * Stacked they run to nearly forty lines and the floating pairing window
 * holds about thirty-six, so the terminal scrolls — and what it scrolls away
 * is the top of the QR, the one thing on this screen that has to survive
 * whole. When the window is too short for the stack but wide enough to take
 * them side by side, the card moves next to the code instead of under it.
 */
function pairingScreen(qr, rows) {
  const cardLines = card('PAIRING', rows).split('\n')
  if (!qr) return cardLines.join('\n')
  const qrLines = qr.replace(/\n+$/, '').split('\n')
  const stacked = `${qrLines.join('\n')}\n\n${cardLines.join('\n')}`
  const term = process.stdout
  if (!term.isTTY) return stacked
  const qrWidth = Math.max(...qrLines.map(visibleWidth))
  const cardWidth = visibleWidth(cardLines[0])
  // Five lines of slack: the notes the callers print underneath, and the
  // prompt the shell draws again once the command is done.
  const fitsStacked = term.rows >= qrLines.length + cardLines.length + 5
  if (fitsStacked || term.columns < qrWidth + 2 + cardWidth) return stacked
  const out = []
  for (let i = 0; i < Math.max(qrLines.length, cardLines.length); i += 1) {
    const left = qrLines[i] ?? ' '.repeat(qrWidth)
    out.push(`${left}  ${cardLines[i] ?? ''}`.trimEnd())
  }
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
      // Three of these are what the daemon's local routes ask for, and they
      // are cheap enough to send on every request rather than to remember
      // which route wants them. `x-oc-local` is the secret out of the status
      // file this process has just read — the file is 0600, so holding it is
      // the same act as being the user; a header of our own naming and a JSON
      // content type are what a web page cannot forge on a `no-cors` POST.
      headers: {
        'content-type': 'application/json',
        ...(payload ? { 'content-length': payload.length } : {}),
        ...(stored?.localSecret ? { 'x-oc-local': stored.localSecret } : {}),
      },
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
  // Only `start` arms it. A one-shot command that throws should exit with a
  // stack, the way any CLI does; it is the daemon that has other people's
  // sockets to lose.
  installCrashGuard({ label: 'daemon' })
  const cfg = loadConfig()
  const port = Number(args.port) || cfg.port
  const server = createServer({ port, version: pkg.version })
  await server.start()

  const ip = await localAddress()
  console.log(
    card('OMARCHY CONNECT', [
      ['host', cfg.deviceName],
      ['address', `${ip}:${port}`],
      ['phone', cfg.devices[0] ? cfg.devices[0].name : dim('none paired')],
      ['fingerprint', fingerprint(identity().publicKey)],
      ['inbox', INBOX.replace(os.homedir(), '~')],
      ['config', CONFIG_FILE.replace(os.homedir(), '~')],
    ]),
  )

  warnIfFirewalled(port, ip)

  const held = pairedDevice()
  if (!held) {
    console.log()
    await showPairing(port, ip, cfg.deviceName)
  } else if (args.pair) {
    console.log()
    log.warn(`${held.name} is already paired — a desktop holds one phone at a time`)
    console.log(dim(`  omarchy-connect unpair   to pair a different phone\n`))
  } else {
    console.log(dim('\n  run `omarchy-connect unpair` to pair a different phone\n'))
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
  if (!pairing.ok) {
    log.warn(pairing.error)
    return
  }
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
  console.log(
    pairingScreen(qr, [
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
  if (res.status === 409) {
    // A desktop holds one phone. Say which one, and say the way out.
    log.error(res.data?.error || 'a phone is already paired')
    console.log(dim(`\n  omarchy-connect unpair   forget it and pair another\n`))
    process.exit(1)
  }
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
  // The QR always carries the LAN address, because that is the one somebody
  // scanning a screen in this room is on. The remote address is printed
  // beside it for the other case — a phone that will never be on this network
  // can be typed into the app's manual pane, which has never cared what an
  // address looks like.
  const found = cfg.remote?.enabled === true ? await overlay.detect({ force: true }) : null
  const remote = found?.addresses[0] || null
  console.log(
    pairingScreen(qr, [
      ['code', code],
      ['address', `${cert ? 'https' : 'http'}://${ip}:${cfg.port}`],
      ...(remote ? [['remote', `${remote.address}:${cfg.port} (${remote.kind})`]] : []),
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
  console.log(dim('\n  waiting for the phone…  (ctrl-c to stop)'))
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
  const device = pairedDevice()
  if (!device) {
    console.log(dim('no phone paired — run `omarchy-connect pair`'))
    return
  }
  console.log(
    card('PAIRED PHONE', [
      ['name', device.name],
      ['platform', device.model ? `${device.platform} · ${device.model}` : device.platform],
      ['paired', device.pairedAt ? new Date(device.pairedAt).toLocaleString() : 'unknown'],
      ['last seen', device.lastSeen ? new Date(device.lastSeen).toLocaleString() : 'never'],
    ]),
  )
  console.log(dim('\n  a desktop pairs one phone at a time — `omarchy-connect unpair` to swap it\n'))
}

async function cmdUnpair(args) {
  // With one phone there is nothing to disambiguate, so the name is optional:
  // `omarchy-connect unpair` on its own drops whoever is paired.
  const target = args._[0] || pairedDevice()?.id
  if (!target) {
    log.error('no phone paired — nothing to unpair')
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
  // The desktop client runs this with no terminal attached, so the card above
  // lands nowhere. Say it again where it can be seen.
  if (!process.stdout.isTTY && has('notify-send')) {
    const missed = body.recipients === 0 ? ' — no phone is connected' : ''
    spawnDetached('notify-send', notifyArgs(['-a', 'Omarchy Connect'], 'Sent to phone', `${body.name}${missed}`))
  }
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
 * The desktop client has no file dialog of its own, so browsing happens in the
 * dialog everything else on this desktop opens: the file chooser behind the
 * XDG desktop portal, the one a browser opens to upload something. What talks
 * to the portal is `filechooser.py`, and its own header says why that has to
 * be a program holding a connection rather than a pair of `gdbus` calls.
 *
 * A terminal file browser was the older answer and a worse one — it hid
 * dotfiles unless asked twice, printed the size of a directory's own inode
 * beside every folder, and asked people to walk a home directory by arrow key.
 * Nothing falls back to it now: a session with no display to draw a dialog on
 * has `send <path>`, which needs neither a dialog nor a terminal.
 */
async function pickFile() {
  if (!process.env.WAYLAND_DISPLAY && !process.env.DISPLAY) {
    log.error('no display for a file dialog — pass a path instead: omarchy-connect send <file>')
    return null
  }
  if (!has('python3')) {
    log.error('python3 is missing — pass a path instead: omarchy-connect send <file>')
    return null
  }
  // No timeout: the dialog is open for exactly as long as somebody is looking
  // at it, and `run` would otherwise take it away after five seconds.
  const chooser = path.join(here, '..', 'src', 'lib', 'filechooser.py')
  const res = await run('python3', [chooser, 'Send to phone', 'Send'], { timeout: 0 })
  if (res.ok && res.stdout) return res.stdout
  // 1 is a dialog that was closed rather than answered. Anything else is a
  // dialog that never opened, and it has already said why.
  if (res.code === 1) console.log(dim('  nothing picked'))
  else log.error(res.stderr.split('\n')[0] || 'the file dialog would not open')
  return null
}

async function cmdStatus(args) {
  const snapshot = await liveStatus()
  if (args?.json) {
    console.log(JSON.stringify(snapshot, null, 2))
    return
  }
  const device = (snapshot.devices || [])[0] || null
  console.log(
    card('STATUS', [
      ['name', snapshot.name],
      ['daemon', snapshot.running ? 'running' : 'stopped'],
      ['address', snapshot.host ? `${snapshot.host}:${snapshot.port}` : `port ${snapshot.port}`],
      ['phone', device ? `${device.name} · ${device.online ? 'online' : 'offline'}` : 'none paired'],
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
 * Make the phone say where it is.
 *
 * The desktop end of the oldest question in the house. The daemon holds the
 * request open until the handset answers, so a success here means the phone is
 * audibly ringing somewhere rather than that a message went into the dark —
 * which matters, because the person about to go looking is about to leave this
 * room on the strength of it.
 *
 * `locate stop` is the same instruction backwards, for the phone found before
 * the minute is up by somebody who is not holding it.
 */
async function cmdLocate(args) {
  const [action = 'start'] = args._
  const op = action === 'stop' || action === 'hush' ? 'stop' : action === 'start' || action === 'ring' ? 'start' : null
  if (!op) {
    log.error('usage: omarchy-connect locate [stop]')
    process.exit(1)
  }
  const seconds = Number(args.seconds) || undefined
  const res = await daemonRequest('/api/locate', { method: 'POST', body: { op, seconds }, timeout: 65_000 })
  if (!res.status) {
    log.error(
      res.timeout
        ? 'the phone did not answer — it may be off, asleep or off this network'
        : 'daemon is not running — start it with `omarchy-connect start`',
    )
    process.exit(1)
  }
  if (!res.ok) {
    log.error(res.data?.error || 'the phone could not be reached')
    process.exit(1)
  }
  if (op === 'stop') {
    log.ok('the phone has stopped ringing')
    return
  }
  const until = res.data?.locate?.until
  const left = until ? Math.max(0, Math.round((until - Date.now()) / 1000)) : 0
  log.ok(`the phone is ringing${left ? ` for ${left}s` : ''} — the button on its screen stops it, or run \`omarchy-connect locate stop\``)
}

/**
 * Listen to the phone's microphone from here.
 *
 * `mic` asks and holds the terminal until the handset answers, so a success
 * means it is recording rather than that an instruction went into the dark.
 * The sound lands as a WAV in `~/.cache/omarchy-connect/audio/`, which is a
 * cache and not a keepsake — it is swept, and the path is printed because the
 * one thing anybody does with it next is play it.
 *
 * `mic stop` is what ends it. So is closing the app, losing the network or
 * half an hour going by; all four leave a finished file rather than a
 * truncated one.
 *
 * `mic input on` is the other thing entirely, and the one most people want:
 * it puts the phone in this desktop's list of microphones, so Zoom, OBS or
 * anything else with an input picker can select it. It also asks the handset
 * to start speaking, because a source with nothing in it is a curiosity. The
 * default input is left exactly where it was — this appears in the list, it
 * does not take anybody's place.
 *
 * `mic gain 6` is the volume knob. The handset sends what its hardware heard
 * with no automatic gain on it, on purpose, and how loud that turns out to be
 * is a property of the phone and the room; the desktop multiplies on the way
 * in, ahead of both the recording and the input in Zoom's list. It takes
 * effect on a stream that is already running, because the only way anybody
 * picks this number is by listening.
 */
async function cmdMic(args) {
  const [action = 'status', ...rest] = args._
  if (action === 'input') return cmdMicInput(rest)
  if (action === 'gain') return cmdMicGain(rest)
  const op = ['start', 'on', 'listen'].includes(action)
    ? 'start'
    : ['stop', 'off'].includes(action)
      ? 'stop'
      : action === 'status'
        ? 'status'
        : null
  if (!op) {
    log.error('usage: omarchy-connect mic <start|stop|status|gain N|input on|input off>')
    process.exit(1)
  }
  const res = await daemonRequest('/api/mic', { method: 'POST', body: { op }, timeout: 30_000 })
  if (!res.status) {
    log.error(
      res.timeout
        ? 'the phone did not answer — it may be off, asleep or off this network'
        : 'daemon is not running — start it with `omarchy-connect start`',
    )
    process.exit(1)
  }
  if (!res.ok) {
    log.error(res.data?.error || 'the phone could not be reached')
    process.exit(1)
  }
  const audio = res.data?.audio || {}
  if (op === 'status') {
    if (!audio.streaming) return log.info(`the phone is not streaming its microphone (gain ${audio.gain}x)`)
    return log.ok(`listening at ${audio.gain}x — ${audio.seconds}s so far into ${audio.path}`)
  }
  if (op === 'start') {
    return log.ok(
      `the phone is listening — ${audio.rate} Hz mono into ${audio.path}\n` +
        '  stop it with `omarchy-connect mic stop`',
    )
  }
  const lost = audio.dropped ? `, ${audio.dropped} bytes dropped to keep up` : ''
  log.ok(`the phone has stopped — ${audio.seconds}s in ${audio.path}${lost}`)
}

/**
 * How loud the phone is here.
 *
 * With no number it reports; with one it saves it and applies it. Printed as
 * decibels beside the multiplier because that is the unit anybody comparing
 * this with another microphone already thinks in.
 */
async function cmdMicGain(rest) {
  const [word] = rest
  const body = word === undefined ? { op: 'status' } : { op: 'gain', value: Number(word) }
  if (word !== undefined && !Number.isFinite(body.value)) {
    log.error('usage: omarchy-connect mic gain [N]   — 1 is the phone untouched, 4 the default')
    process.exit(1)
  }
  const res = await daemonRequest('/api/mic', { method: 'POST', body, timeout: 10_000 })
  if (!res.status) {
    log.error('daemon is not running — start it with `omarchy-connect start`')
    process.exit(1)
  }
  if (!res.ok) {
    log.error(res.data?.error || 'the gain could not be changed')
    process.exit(1)
  }
  const gain = res.data?.audio?.gain ?? 1
  const dB = (20 * Math.log10(gain)).toFixed(1)
  log.ok(`the phone's microphone is ${gain}x (+${dB} dB) on this desktop`)
}

/**
 * The phone as this desktop's microphone.
 *
 * Prints what any other program would see, because that is the only thing
 * worth confirming: the name in the picker. A desktop with no pipewire-pulse
 * says so plainly rather than offering a switch that cannot work.
 */
async function cmdMicInput(rest) {
  const [word = 'status'] = rest
  const value = ['on', 'start', 'enable'].includes(word)
    ? 'on'
    : ['off', 'stop', 'disable'].includes(word)
      ? 'off'
      : word === 'status'
        ? 'status'
        : null
  if (!value) {
    log.error('usage: omarchy-connect mic input <on|off|status>')
    process.exit(1)
  }
  const res = await daemonRequest('/api/mic', { method: 'POST', body: { op: 'input', value }, timeout: 30_000 })
  if (!res.status) {
    log.error('daemon is not running — start it with `omarchy-connect start`')
    process.exit(1)
  }
  if (!res.ok) {
    log.error(res.data?.error || 'the input could not be switched')
    process.exit(1)
  }
  const input = res.data?.audio?.input || {}
  if (!input.available) {
    log.warn('this desktop has no pipewire-pulse, so the phone cannot be offered as an input')
    return
  }
  if (!input.enabled) {
    return log.info(
      value === 'status'
        ? 'the phone is not an input on this desktop — `omarchy-connect mic input on`'
        : 'the phone is no longer an input on this desktop',
    )
  }
  log.ok(`"${input.description}" is an input on this desktop — pick it in any app's microphone list`)
  if (input.phone) log.warn(`the handset is not speaking yet: ${input.phone}\n  wake it and run \`omarchy-connect mic start\``)
  else if (input.streaming === false && value === 'status') log.info('nothing is streaming into it — `omarchy-connect mic start`')
}

/**
 * Answer, reject, hang up or place a call.
 *
 * The daemon decides which road it takes. Over Bluetooth this needs nothing on
 * the phone and puts the conversation on the desktop's speakers; over the app
 * it only presses the button, and the audio stays on the handset. `call status`
 * says which one is available before you commit to it.
 *
 * The link that road needs is normally not something to think about — it
 * follows the phone onto the network and is up before anything rings. `auto`
 * is where that is turned down or off, and `connect` is the hand crank for the
 * times it matters more than the policy does.
 */
async function cmdCall(args) {
  const [action = 'status', ...rest] = args._
  const number = rest.join('').trim() || null
  const value = rest.join(' ').trim() || null

  /** A pairing window in flight, in the tense somebody watching it reads in. */
  const bondingLine = (window) => {
    const left = Math.max(0, Math.round((window.until - Date.now()) / 1000))
    const who = window.handset?.name || window.handset?.address || null
    // The phone asked for a code: legacy pairing, and the agent has already
    // answered BlueZ with this pin — the person just has to type the same one.
    if (window.pin) return `the phone is asking for a code — type ${window.pin}`
    if (window.stage === 'pairing') return `asking ${who || 'the handset'} to pair…`
    if (window.stage === 'connecting') return `paired with ${who || 'the handset'} — raising the link…`
    return `visible for ${left}s — open Bluetooth on the phone and pick this desktop`
  }

  /** What a ringing phone will sound like, if anything. */
  const ringtoneLine = (tone) => {
    if (!tone) return dim('—')
    if (!tone.enabled) return dim('off')
    if (!tone.player) return dim('no player on this machine')
    return tone.custom ? tone.sound.replace(/^.*\//, '') : 'the sound theme'
  }

  /** Whether a call in progress keeps a card on screen, and what it says. */
  const timerLine = (timer) => {
    if (!timer) return dim('—')
    if (!timer.enabled) return dim('off')
    return timer.running ? `counting · ${Math.floor(timer.seconds / 60)}m ${timer.seconds % 60}s` : 'on the screen while a call lasts'
  }

  /** How the link's own row reads, which is a policy and a state at once. */
  const linkLine = (link, connected) => {
    if (!link) return dim('—')
    if (link.policy === 'off') return connected ? 'up · by hand' : dim('off · by hand')
    const policy = link.policy === 'presence' ? 'follows the phone' : 'only during a call'
    if (link.raising) return `connecting · ${policy}`
    if (connected) {
      const how = link.raisedBy ? policy : 'raised elsewhere'
      return link.standingDown ? `up · ${how} · going down` : `up · ${how}`
    }
    return dim(policy)
  }

  /**
   * The handset row: which one, and on whose authority.
   *
   * The gateway's name while the link is up, and the one the desktop would
   * page while it is down — the row is about the handset, not about whether
   * the profile happens to be connected right now. The suffix is there because
   * "the desktop picked this because it was the only thing on the list" and
   * "this is the phone you paired with" are very different promises, and only
   * one of them survives buying a pair of earbuds.
   */
  const handsetLine = (bt) => {
    const link = bt.link || {}
    const name = bt.device || link.handset?.name || link.handset?.address || link.pinned
    if (!name) return dim('—')
    if (link.matched === 'pinned') return `${name} ${dim('· pinned')}`
    if (link.matched === 'phone') return `${name} ${dim('· your paired phone')}`
    if (link.matched === 'guess') return `${name} ${dim('· the only one paired')}`
    return name
  }

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
        ['link', linkLine(bt.link, bt.connected)],
        // The gateway's name while the link is up, and the one the desktop
        // would page while it is down — the row is about the handset, not
        // about whether the profile happens to be connected right now.
        ['handset', handsetLine(bt)],
        ['audio', bt.connected ? bt.audio || 'idle' : dim('—')],
        ['ringtone', ringtoneLine(snapshot.phone?.ringtone)],
        ['timer', timerLine(snapshot.phone?.timer)],
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
      // The honest order: what went wrong last time if anything did, then the
      // one thing that has to be true before any of this can work at all.
      const window = bt.link?.bonding
      console.log(
        dim(
          window
            ? `\n  ${bondingLine(window)}\n`
            : // Nothing bonded is the one error with a command behind it, and
              // saying the error without the command is how the panel row that
              // started all this managed to be a dead end.
              !bt.link?.handset
              ? `\n  ${bt.link?.error || 'no handset is paired over Bluetooth'}\n` +
                '  pair one from here — `omarchy-connect call bond`\n'
              : bt.link?.error
                ? `\n  ${bt.link.error}\n`
                : bt.link?.policy === 'off'
                  ? '\n  the link is yours to raise — `omarchy-connect call connect`\n'
                  : '\n  the bond is made; the link comes up on the next ring\n',
        ),
      )
    }
    return
  }

  if (action === 'ringtone') {
    if (!value) {
      log.error('usage: omarchy-connect call ringtone <on|off|test|default|FILE>')
      process.exit(1)
    }
    const res = await daemonRequest('/api/call', { method: 'POST', body: { op: action, value }, timeout: 10_000 })
    if (!res.status) {
      log.error('daemon is not running — start it with `omarchy-connect start`')
      process.exit(1)
    }
    if (!res.ok) {
      log.error(res.data?.error || 'could not set the ringtone')
      process.exit(1)
    }
    const tone = res.data?.ringtone || {}
    log.ok(
      value.toLowerCase() === 'test'
        ? `playing ${tone.sound}`
        : tone.enabled
          ? `a ringing phone plays ${tone.custom ? tone.sound : "the desktop's own ring"}`
          : 'a ringing phone stays quiet',
    )
    if (tone.enabled && !tone.player) {
      console.log(dim('  nothing on this machine can play it — install pipewire-pulse or libcanberra'))
    }
    return
  }

  if (action === 'timer') {
    if (!value) {
      log.error('usage: omarchy-connect call timer <on|off>')
      process.exit(1)
    }
    const res = await daemonRequest('/api/call', { method: 'POST', body: { op: action, value }, timeout: 10_000 })
    if (!res.status) {
      log.error('daemon is not running — start it with `omarchy-connect start`')
      process.exit(1)
    }
    if (!res.ok) {
      log.error(res.data?.error || 'could not set the call timer')
      process.exit(1)
    }
    log.ok(
      res.data?.timer?.enabled
        ? 'a call in progress keeps a card on screen, counting'
        : 'a call in progress leaves the screen alone',
    )
    return
  }

  if (action === 'auto' || action === 'handset') {
    if (!value) {
      log.error(
        action === 'auto'
          ? 'usage: omarchy-connect call auto <presence|ring|off>'
          : 'usage: omarchy-connect call handset <address|auto>',
      )
      process.exit(1)
    }
    const res = await daemonRequest('/api/call', { method: 'POST', body: { op: action, value }, timeout: 30_000 })
    if (!res.status) {
      log.error('daemon is not running — start it with `omarchy-connect start`')
      process.exit(1)
    }
    if (!res.ok) {
      log.error(res.data?.error || `could not set the ${action}`)
      // Naming a handset is impossible without knowing what there is to name.
      for (const h of res.data?.handsets || []) console.log(dim(`  ${h.address}  ${h.name || ''}`))
      process.exit(1)
    }
    const link = res.data?.bluetooth?.link || {}
    log.ok(
      action === 'auto'
        ? `the link ${link.policy === 'off' ? 'is now yours to raise' : link.policy === 'presence' ? 'now follows the phone' : 'now exists only while a call does'}`
        : link.pinned
          ? `handset pinned to ${link.pinned}`
          : 'handset back to whichever one is paired',
    )
    for (const h of res.data?.handsets || []) {
      console.log(dim(`  ${h.address}  ${h.name || ''}${h.connected ? ' · connected' : ''}`))
    }
    return
  }

  /**
   * Make the bond this desktop has none of.
   *
   * `connect` is the hand crank for a link; this is the hand crank for the
   * bond underneath it, and the difference matters to somebody reading an
   * error: a desktop that has never been bonded to the phone has nothing to
   * connect *to*, and no amount of pressing connect will change that.
   *
   * Slow on purpose. The window is a minute long because what it is waiting
   * for is a person picking their phone up, and cutting that short to keep a
   * terminal responsive would fail at the only thing it is for.
   */
  if (action === 'bond') {
    const stopping = value === 'stop'
    if (!stopping) {
      console.log(
        dim('\n  this desktop is visible for a minute — open Bluetooth on the phone and pick it,\n' +
          '  or leave that screen open and the desktop will ask\n'),
      )
    }
    const res = await daemonRequest('/api/call', {
      method: 'POST',
      body: { op: 'bond', value: stopping ? 'stop' : null },
      // Longer than the window itself: the answer worth having is the one
      // that comes back after the window shuts, not a timeout on top of it.
      timeout: stopping ? 10_000 : 120_000,
    })
    if (!res.status) {
      log.error(
        res.timeout
          ? 'the daemon did not answer — check `omarchy-connect status`'
          : 'daemon is not running — start it with `omarchy-connect start`',
      )
      process.exit(1)
    }
    if (!res.ok) {
      log.error(res.data?.error || 'nothing paired')
      process.exit(1)
    }
    if (stopping) {
      log.ok(res.data?.stopped ? 'the pairing window is shut' : 'no pairing window was open')
      return
    }
    const handset = res.data?.handset
    const name = handset?.name || handset?.address || 'the handset'
    if (res.data?.already) log.ok(`${name} was already paired`)
    else log.ok(`paired with ${name}`)
    console.log(
      dim(
        res.data?.parked
          ? '\n  the link was raised, verified and put back down — it comes up by itself\n' +
            '  when the phone rings, and drops again after the call\n'
          : res.data?.connected
            ? '\n  the hands-free link is up — calls can be answered on this machine\n'
            : '\n  the bond is made; the link comes up on the next ring — or now, with\n' +
              '  `omarchy-connect call connect`\n',
      ),
    )
    return
  }

  if (!['answer', 'reject', 'hangup', 'dial', 'tones', 'audio', 'connect', 'disconnect'].includes(action)) {
    log.error(
      'usage: omarchy-connect call <status|answer|reject|hangup|audio|connect|disconnect|bond|dial NUMBER|tones DIGITS|auto POLICY|handset ADDRESS|ringtone on|off|test|FILE|timer on|off>',
    )
    process.exit(1)
  }
  if ((action === 'dial' || action === 'tones') && !number) {
    log.error(`usage: omarchy-connect call ${action} <${action === 'dial' ? 'number' : 'digits'}>`)
    process.exit(1)
  }

  const res = await daemonRequest('/api/call', {
    method: 'POST',
    body: { op: action, id: args.id ? String(args.id) : null, number },
    // Paging a handset that is asleep is the slowest thing here, and BlueZ
    // gives up on its own well inside this.
    timeout: action === 'connect' ? 30_000 : 65_000,
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
    connect: 'hands-free link up',
    disconnect: 'hands-free link down',
  }
  if (action === 'connect' || action === 'disconnect') {
    log.ok(done[action])
    return
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

/** What becomes of a one-time code that arrives in a mirrored message. */
function otpLine(state) {
  if (!state) return dim('—')
  if (!state.enabled) return dim('off')
  if (!state.clipboard) return dim('no wl-copy on this machine')
  const seen = `${state.seen} seen · ${state.copied} copied`
  return state.autoCopy ? `straight onto the clipboard · ${seen}` : `a Copy button on the card · ${seen}`
}

/**
 * The Copy button on a mirrored one-time code.
 *
 * `test` is the command that matters here. The phrase list this reads with is
 * long, written in a couple of dozen scripts, and borrowed — so the way to
 * find out whether it knows your bank is to hand it one of your bank's
 * messages and look, rather than to wait for the next real one and miss it.
 */
async function cmdOtp(args) {
  const [word = 'status', ...rest] = args._
  const action = String(word).toLowerCase()

  const body =
    action === 'test'
      ? { op: 'test', value: rest.join(' ') }
      : action === 'auto'
        ? { op: 'auto', value: rest[0] }
        : action === 'on' || action === 'off'
          ? { op: 'copy', value: action }
          : action === 'status'
            ? { op: 'status' }
            : null

  if (!body) {
    log.error('usage: omarchy-connect otp <status|on|off|auto on|auto off|test MESSAGE…>')
    process.exit(1)
  }
  if (body.op === 'test' && !body.value) {
    log.error('usage: omarchy-connect otp test <message…>')
    process.exit(1)
  }
  if (body.op === 'auto' && !body.value) {
    log.error('usage: omarchy-connect otp auto <on|off>')
    process.exit(1)
  }

  const res = await daemonRequest('/api/otp', { method: 'POST', body, timeout: 10_000 })
  if (!res.status) {
    log.error('daemon is not running — start it with `omarchy-connect start`')
    process.exit(1)
  }
  if (!res.ok) {
    log.error(res.data?.error || 'could not read that')
    process.exit(1)
  }

  const state = res.data?.otp || {}
  if (body.op === 'test') {
    if (res.data.code) log.ok(`the code in that message is ${bold(res.data.code)}`)
    // A `no` is worth explaining: half the time it is the message and half the
    // time it is the list, and only the person holding the message can tell.
    else log.error(`no code found — ${res.data.why}`)
    return
  }

  log.ok(
    !state.enabled
      ? 'a code in a message is left where it is'
      : state.autoCopy
        ? 'a code in a message goes straight onto the clipboard'
        : 'a code in a message gets a Copy button on its notification',
  )
  if (state.enabled && !state.clipboard) {
    console.log(dim('  nothing on this machine can write the clipboard — install wl-clipboard'))
  }
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
      ['codes', otpLine(phone.otp)],
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
 * Wake-on-LAN is the one feature that is used when this daemon is not running,
 * so there is nothing to check at the moment it matters — only now. This says
 * what the phone was handed, and whether the card would act on it.
 */
async function cmdWake() {
  const net = await sys.network()
  const wake = await wol.check(net)

  console.log(
    card('WAKE ON LAN', [
      ['interface', wake.interface ? `${wake.interface} (${wake.type})` : 'none up'],
      ['mac', wake.mac ?? '—'],
      ['broadcast', wake.broadcast ? `${wake.broadcast}:${wake.port}` : '—'],
      ['armed', wake.armed === null ? 'cannot tell' : wake.armed ? 'yes' : 'no'],
    ]),
  )

  if (!wake.supported) {
    console.log(dim('\n  nothing here can be woken — no interface is up\n'))
    return
  }
  if (wake.note) console.log(dim(`\n  ${wake.note}`))
  if (wake.armed === true) {
    console.log(dim('\n  the paired phone can wake this desktop from sleep\n'))
    return
  }
  if (wake.armed === null) {
    console.log(
      dim(
        '\n  this card exposes no wakeup flag, so whether it would answer a magic\n' +
          '  packet is something only trying it will tell you\n',
      ),
    )
    return
  }
  console.log(dim('\n  run this to let a magic packet wake this desktop:\n'))
  console.log(`  ${wake.command}`)
  console.log(
    dim(
      '\n  it takes effect the next time the link comes up — right away with\n' +
        '  `nmcli connection up` on that profile — and it survives a reboot.\n\n' +
        '  the other half is in the BIOS, usually "Wake on LAN" or "Power on by\n' +
        '  PCI-E", and no command here can read or set it\n',
    ),
  )
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
    console.log(dim('\n  a phone paired before now has to pair again — the QR carries the pin\n'))
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
    console.log(dim('\n  the paired phone has to pair again\n'))
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

/**
 * When a usage window turns over, short enough to sit in a card.
 *
 * A limit that resets in forty minutes and one that resets on Tuesday are
 * different news, and the full date says so far less clearly than the gap
 * does — so today is an hour and anything else is a weekday.
 */
function resetWord(at) {
  const date = new Date(at)
  const hours = (at - Date.now()) / 3_600_000
  if (hours < 0) return 'now'
  const time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  if (hours < 12 && date.getDate() === new Date().getDate()) return time
  return `${date.toLocaleDateString([], { weekday: 'short' })} ${time}`
}

/** How old a figure is, for the rows the status line cannot refresh. */
function ageWord(at) {
  const hours = (Date.now() - at) / 3_600_000
  if (hours < 1) return null
  if (hours < 48) return `${Math.round(hours)}h old`
  return `${Math.round(hours / 24)}d old`
}

// The hooks themselves — where they live, what they say, how they are written
// — belong beside the adapter they serve: the panel reports whether they are
// installed, and the daemon publishes that in the status file.
const { SETTINGS_FILE: CLAUDE_SETTINGS, EVENTS: HOOK_EVENTS, installed: hooksInstalled, write: writeHooks } = agentHooks

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

/**
 * The bridge between Claude Code's status line and this daemon.
 *
 * The CLI hands the configured command JSON on stdin and prints whatever
 * comes back on stdout, on every update — which makes this the freshest
 * source of the account's rate limits and the session's context figures that
 * exists on the desktop. The line printed is for the person at the terminal;
 * the POST is for the phone. Printing comes first: the CLI is waiting on
 * stdout, and a daemon that is down must never cost the terminal its line.
 */
async function cmdAgentStatusline() {
  let raw = ''
  try {
    process.stdin.setEncoding('utf8')
    for await (const chunk of process.stdin) {
      raw += chunk
      if (raw.length > 128 * 1024) break
    }
  } catch {
    /* no stdin still prints an empty-handed line below */
  }

  let payload = {}
  try {
    payload = JSON.parse(raw || '{}')
  } catch {
    payload = {}
  }

  const pct = (value) => (Number.isFinite(Number(value)) ? `${Math.round(Number(value))}%` : null)
  const parts = []
  const model = payload.model?.display_name
  if (model) parts.push(String(model))
  const ctx = pct(payload.context_window?.used_percentage)
  if (ctx) parts.push(`ctx ${ctx}`)
  const session = pct(payload.rate_limits?.five_hour?.used_percentage)
  if (session) parts.push(`5h ${session}`)
  const week = pct(payload.rate_limits?.seven_day?.used_percentage)
  if (week) parts.push(`wk ${week}`)
  process.stdout.write(parts.join(' · '))

  await daemonRequest('/api/agent/hook', {
    method: 'POST',
    timeout: 1000,
    body: {
      hook_event_name: 'StatusLine',
      agent: 'claude',
      session_id: payload.session_id || null,
      transcript_path: payload.transcript_path || null,
      rate_limits: payload.rate_limits || null,
      context_window: payload.context_window || null,
      exceeds_200k_tokens: payload.exceeds_200k_tokens === true,
    },
  })
  process.exit(0)
}

/**
 * Start an agent in a pane the phone can type into.
 *
 * Everything else about the desktop stays as it was: tmux attaches in this
 * very terminal, so what the person at the keyboard sees is the agent, drawn
 * where they asked for it. What they get for free is a pty that belongs to
 * tmux rather than to the terminal emulator — which is the whole difference
 * between a session a phone can answer and one it can only watch.
 *
 * Two cases need no wrapper at all and say so rather than nesting a second
 * multiplexer inside the first: already inside tmux, and no tmux installed.
 */
async function cmdAgentRun(args) {
  // `--` is where the agent's own flags begin, and they must not be parsed as
  // ours — `claude --resume` is a perfectly ordinary thing to want.
  const separator = process.argv.indexOf('--')
  const command = separator >= 0 ? process.argv.slice(separator + 1) : args._.slice(1)
  if (!command.length) {
    log.error('usage: omarchy-connect agent run -- claude [args…]')
    process.exit(1)
  }

  const inherit = { stdio: 'inherit' }
  const wait = (child) =>
    new Promise((resolve) => {
      child.on('error', (err) => {
        log.error(err.message)
        resolve(1)
      })
      child.on('exit', (code, signal) => resolve(signal ? 1 : (code ?? 0)))
    })

  if (process.env.TMUX) {
    console.log(dim('  already inside tmux — this pane is writable as it is\n'))
    process.exit(await wait(spawn(command[0], command.slice(1), inherit)))
  }

  // herdr owns its panes' ptys exactly as tmux owns its own, and it tells
  // everything it starts which pane it is in — so a terminal here needs no
  // wrapper either, and nesting a multiplexer inside one would be worse than
  // doing nothing.
  if (process.env.HERDR_ENV === '1') {
    console.log(dim('  already inside a herdr pane — this one is writable as it is\n'))
    process.exit(await wait(spawn(command[0], command.slice(1), inherit)))
  }

  if (!agentTmux.available()) {
    log.warn('tmux is not installed — starting the agent anyway, but a phone will only be able to read it')
    console.log(dim('  pacman -S tmux   to make sessions started this way answerable'))
    console.log(dim('  or run this from a herdr pane, which a phone can answer just as well\n'))
    process.exit(await wait(spawn(command[0], command.slice(1), inherit)))
  }

  const name = await agentTmux.freeSessionName()
  console.log(dim(`\n  tmux session ${name} — a phone can answer this one\n`))
  // `--` again, this time so tmux hands the rest to the agent verbatim.
  process.exit(await wait(spawn('tmux', ['new-session', '-s', name, '--', ...command], inherit)))
}

/**
 * The switch that lets a phone in from off this network, and the one screen
 * that says whether there is anything for it to come in over.
 *
 * A tunnel that is up is not the same as a tunnel that works: an expired node
 * key leaves the interface exactly where it was and takes the machine off the
 * tailnet anyway, and a firewall scoped to the local subnet drops a peer that
 * is not on it. Both are silent from the phone's end — it simply stops
 * answering — so both are said here.
 */
async function cmdRemote(args) {
  const action = String(args._[0] || 'status').toLowerCase()
  const cfg = loadConfig()

  if (action === 'on' || action === 'enable' || action === 'off' || action === 'disable') {
    const on = action === 'on' || action === 'enable'
    const res = await daemonRequest('/api/remote/control', { method: 'POST', body: { op: on ? 'enable' : 'disable' } })
    // As with agent control: no daemon, or one older than this endpoint, is
    // not a failure — the config is what the next start reads, so write it.
    const applied = res.ok === true
    if (!applied && res.status && res.status !== 404) {
      log.error(res.data?.error || `could not turn remote access ${on ? 'on' : 'off'}`)
      process.exit(1)
    }
    if (!applied) saveConfig({ ...cfg, remote: { ...(cfg.remote || {}), enabled: on } })

    if (on) {
      log.ok('remote access on')
      const found = await overlay.detect({ force: true })
      if (found.addresses.length === 0) {
        console.log(
          dim(
            '\n  nothing to reach this desktop over yet. Bring up a tunnel it can\n' +
              '  share with the phone — tailscale up is the short road — and the\n' +
              '  address will be handed over on the phone\'s next connection.\n',
          ),
        )
      } else {
        console.log(
          dim(
            '\n  the phone can now reach this desktop from anywhere the tunnel\n' +
              '  reaches. Calls and messages stay here: telephony is switched off\n' +
              '  on a remote link, whichever way the phone asks.\n',
          ),
        )
      }
    } else {
      log.ok('remote access off')
      console.log(dim('\n  back to this network only — any remote phone has been hung up on\n'))
    }
    if (!applied && (state.read()?.running || res.status)) {
      log.warn('the running daemon did not take it — restart it: systemctl --user restart omarchy-connect')
    }
    return
  }

  if (action !== 'status') {
    log.error(`unknown remote action: ${action}`)
    console.log(dim('\n  omarchy-connect remote [status|on|off]\n'))
    process.exit(1)
  }

  const found = await overlay.detect({ force: true })
  const first = found.addresses[0] || null
  const enabled = cfg.remote?.enabled === true
  console.log(
    card('REMOTE ACCESS', [
      ['state', enabled ? 'on' : 'off'],
      ['over', first ? `${first.kind}${first.iface ? ` (${first.iface})` : ''}` : 'no tunnel up'],
      ['address', first ? `${first.address}:${cfg.port}` : '—'],
      ['name', found.dnsName ?? '—'],
    ]),
  )

  if (found.addresses.length > 1) {
    console.log(dim('\n  also reachable at:'))
    for (const entry of found.addresses.slice(1)) console.log(dim(`    ${entry.address}  ${entry.kind}`))
    console.log('')
  }

  if (!enabled) {
    console.log(dim('\n  omarchy-connect remote on   to let the phone in from off this network\n'))
    return
  }
  if (!first) {
    console.log(dim('\n  remote access is on, but there is no tunnel for it to use yet\n'))
    return
  }

  // Two weeks is enough notice to re-authenticate without it being nagging;
  // a key that has already gone is the loudest line on the screen, because
  // from the phone the symptom is an address that simply stops answering.
  if (found.keyExpiry) {
    const days = Math.round((found.keyExpiry - Date.now()) / 86_400_000)
    if (days <= 0) log.error(`the node key expired ${Math.abs(days)} day(s) ago — run: tailscale up`)
    else if (days <= 14) log.warn(`the node key expires in ${days} day(s) — run: tailscale up --force-reauth`)
  }

  const fw = firewall.check(cfg.port, await localAddress(), first.iface)
  if (fw.blocked && fw.remoteCommand) {
    console.log(dim('\n  ufw is dropping this port. The local rule is not enough — a phone on\n'))
    console.log(dim('  the tunnel is not on your subnet — so allow the tunnel itself in:\n'))
    console.log(`  ${fw.remoteCommand}`)
    console.log('')
  } else {
    console.log(dim('\n  the phone can reach this desktop from anywhere the tunnel reaches\n'))
  }
}

async function cmdAgent(args) {
  const action = args._[0] || 'status'

  if (action === 'hook') return cmdAgentHook()
  if (action === 'statusline') return cmdAgentStatusline()
  if (action === 'run') return cmdAgentRun(args)

  const cfg = loadConfig()
  const live = state.read()
  if (action === 'enable' || action === 'disable') {
    const on = action === 'enable'
    // A running daemon owns this: it writes the config itself and starts or
    // stops the watching in the same breath, so nothing has to be restarted
    // and the phone keeps its link. The panel's switch comes down this road.
    const res = await daemonRequest('/api/agent/control', { method: 'POST', body: { op: action } })
    // Two ways the live half is simply absent, and neither is a failure: no
    // daemon at all, and a daemon from before this endpoint existed, which
    // answers 404. In both the config is the whole switch — it is what the
    // next start reads — so it is written here instead.
    const applied = res.ok === true
    if (!applied && res.status && res.status !== 404) {
      log.error(res.data?.error || `could not turn agent control ${on ? 'on' : 'off'}`)
      process.exit(1)
    }
    if (!applied) saveConfig({ ...cfg, agents: { ...(cfg.agents || {}), enabled: on } })
    if (on) {
      log.ok('agent control on')
      console.log(
        dim(
          '\n  a paired phone can now read every coding agent session on this\n' +
            '  desktop — the source it saw, the commands it ran, the output of\n' +
            '  those commands — and type into the ones it can reach, which the\n' +
            '  agent will act on. That is a shell. Pair only phones you own.\n',
        ),
      )
      if (!hooksInstalled()) console.log(dim('  omarchy-connect agent install-hooks   to know when an agent is stuck\n'))
      if (!agentWriter.best()) {
        console.log(dim('  nothing here can type into a terminal — install tmux for that\n'))
      }
    } else {
      log.ok('agent control off')
    }
    if (!applied && (live?.running || res.status)) {
      // Either the status file claims a daemon that is not answering, or the
      // one answering is older than this endpoint. Same sentence either way:
      // what is on disk is right, what is running is not.
      log.warn('the running daemon did not take it — restart it: systemctl --user restart omarchy-connect')
    }
    return
  }

  if (action === 'spawn') {
    const word = String(args._[1] || '').toLowerCase()
    if (word !== 'on' && word !== 'off') {
      // Its own switch rather than a corner of `enable`, because it is its own
      // sentence: reading an agent and answering the one already open are
      // things somebody at this desktop started. This starts a process that
      // was not there before.
      console.log(
        card('STARTING AGENTS FROM A PHONE', [
          ['state', cfg.agents?.spawn === true ? 'on' : 'off'],
          ['needs', agentTmux.available() ? 'tmux — present' : 'tmux — not installed'],
        ]),
      )
      console.log(
        dim(
          '\n  omarchy-connect agent spawn on    let the phone start a new agent,\n' +
            '                                    or pick up a finished conversation\n\n' +
            '  a new agent runs in a detached tmux session the phone can type\n' +
            '  into from the first second, or — with `--bg` behind it — with no\n' +
            '  terminal at all, which is the one worth starting on your way out\n' +
            '  the door.\n',
        ),
      )
      return
    }
    const on = word === 'on'
    saveConfig({ ...cfg, agents: { ...(cfg.agents || {}), spawn: on } })
    log.ok(`starting agents from a phone: ${on ? 'on' : 'off'}`)
    if (on && !cfg.agents?.enabled) log.warn('agent control itself is still off — `omarchy-connect agent enable`')
    if (on && !agentTmux.available()) log.warn('without tmux only background agents can be started')
    if (live?.running) console.log(dim('\n  the running daemon picks this up on its next request\n'))
    return
  }

  if (action === 'install-hooks' || action === 'uninstall-hooks') {
    const install = action === 'install-hooks'
    const command = writeHooks(install)
    // The status line rides along: it is the only realtime source for what the
    // account is spending, and installing it apart from the hooks would be a
    // second command nobody would learn about. One that the user configured
    // themselves is not touched, and the refusal is said out loud.
    const statusline = agentStatusline.write(install)
    if (install) {
      log.ok(`hooks installed in ${CLAUDE_SETTINGS.replace(os.homedir(), '~')}`)
      console.log(card('CLAUDE CODE HOOKS', HOOK_EVENTS.map((event) => [event, 'installed'])))
      console.log(dim(`\n  ${command}\n`))
      if (statusline === null) {
        log.warn('status line left alone — you have your own configured, so usage stays on the CLI\'s cache')
      } else {
        console.log(dim('  status line installed too — it feeds the phone realtime usage\n'))
      }
      console.log(dim('  already-running agents pick these up when they next start\n'))
    } else {
      log.ok(statusline === null ? 'hooks removed (the status line was not ours to remove)' : 'hooks and status line removed')
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
          ['writable', session.writable || 'no — not in a terminal we can reach'],
          ['pane', session.pane || '—'],
          ['last activity', session.lastActivity ? new Date(session.lastActivity).toLocaleTimeString() : '—'],
        ]),
      )
      if (session.preview) console.log(dim(`  ${session.preview.slice(0, 56)}\n`))
    }
    return
  }

  if (action !== 'status') {
    log.error('usage: omarchy-connect agent <status|enable|disable|spawn|list|run|install-hooks|uninstall-hooks>')
    process.exit(1)
  }

  console.log(
    card('CODING AGENTS', [
      ['reading', agents.enabled ? 'on' : 'off'],
      // Reading and writing arrive together, so what this reports is not a
      // second switch but whether the desktop has any road into a terminal.
      ['writing', agents.enabled ? agentWriter.best() || 'no road — install tmux' : 'off'],
      // With the daemon down the status file knows nothing about what is
      // installed, so ask the adapters themselves rather than report none.
      ['adapters', ((agents.adapters || []).length ? agents.adapters : detectedAgents()).join(' ') || dim('none detected')],
      ['hooks', hooksInstalled() ? 'installed' : dim('not installed')],
      // The realtime half of the usage card below: without it the numbers come
      // from a cache the CLI refreshes when it feels like it.
      ['status line', agentStatusline.installed() ? 'installed' : dim(agentStatusline.available() ? 'not installed' : 'yours — left alone')],
      ['start from phone', cfg.agents?.spawn === true ? 'on' : 'off'],
      ['sessions', String((agents.sessions || []).length)],
      ['in background', String(agents.jobs || 0)],
      ['waiting on you', String(agents.waiting || 0)],
    ]),
  )

  // What the plan has left. The phone draws the same rows in its status line,
  // and a desktop that says something different from the phone in your hand is
  // a desktop nobody trusts — so when the daemon has an answer it is the one
  // printed, and only a terminal that could not reach it asks on its own.
  let usage = agents.limits
  if (!usage) {
    await agentLimits.probe({ force: true })
    usage = agentLimits.read()
  }
  if (usage?.limits?.length) {
    console.log(
      card(
        'USAGE',
        // No dim inside the value: the card measures a row by its length, and
        // an escape sequence counts as characters that are never drawn.
        usage.limits.map((limit) => [
          limit.label + (limit.active ? ' ←' : ''),
          // Age beats reset time when there is one: a figure from before the
          // weekend says more about itself than the day it turns over does.
          `${limit.percent}%${
            (limit.stale && limit.asOf ? `   ${ageWord(limit.asOf)}` : '') ||
            (limit.resetsAt ? `   resets ${resetWord(limit.resetsAt)}` : '')
          }`,
        ]),
      ),
    )
    if (usage.stale) {
      // Only the two unscoped windows ride the status line, so on a busy
      // desktop the stale rows are the per-model ones and the note has to say
      // *which* rows it is about rather than disown the whole card.
      const old = usage.limits.filter((limit) => limit.stale).map((limit) => limit.label)
      const all = old.length === usage.limits.length
      console.log(dim(`\n  ${all ? 'these are' : `${old.join(', ')} — `}from the CLI's cache; a session here refreshes it\n`))
    }
  }
  if (!agents.enabled) {
    console.log(
      dim(
        '\n  omarchy-connect agent enable   let a paired phone read these sessions\n\n' +
          '  the same switch is on the desktop panel, under Settings\n',
      ),
    )
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
  ${bold('devices')}                     show the paired phone
  ${bold('unpair')} [name|id]            forget the paired phone
  ${bold('send')} <file> | --pick        offer a file to connected phones
  ${bold('status')} [--json]             show live daemon status
  ${bold('sms')} <number> <message…>     send an SMS through the paired phone
  ${bold('call')} <status|answer|reject|…>  answer or place a call
  ${bold('call')} bond [stop]                pair a handset over Bluetooth from here
  ${bold('call')} auto <presence|ring|off>  when to hold the Bluetooth link open
  ${bold('call')} ringtone <on|off|FILE>     what a ringing phone sounds like here
  ${bold('call')} timer <on|off>             count the conversation on screen
  ${bold('otp')} <on|off|auto|test …>     copy a one-time code out of an SMS
  ${bold('ios')} <status|pair|stop>       mirror an iPhone over Bluetooth LE
  ${bold('phone')} [--limit N]           mirrored messages and calls
  ${bold('locate')} [stop]               ring the phone until somebody finds it
  ${bold('mic')} <start|stop|status>     stream the phone's microphone to this desktop
  ${bold('mic input')} <on|off|status>  offer the phone as an input every app can pick
  ${bold('mic gain')} [N]                how much louder the desktop makes it
  ${bold('agent')} <status|enable|spawn|run|…>  read and answer this desktop's coding agents
  ${bold('config')} [key] [value]        read or change configuration
  ${bold('remote')} <status|on|off>      let the phone in from off this network
  ${bold('firewall')}                    check whether the port is reachable
  ${bold('wake')}                        whether a phone could wake this desktop
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
  otp: cmdOtp,
  ios: cmdIos,
  phone: cmdPhone,
  locate: cmdLocate,
  mic: cmdMic,
  agent: cmdAgent,
  remote: cmdRemote,
  config: cmdConfig,
  firewall: cmdFirewall,
  wake: cmdWake,
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
