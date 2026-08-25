import { EventEmitter } from 'node:events'

import { has, run, spawn } from './exec.js'
import { log } from './log.js'

/**
 * The desktop as a Bluetooth hands-free unit.
 *
 * Everything else in this project goes over the LAN, because that is the only
 * road the phone's own operating system leaves open. Call audio is the one
 * exception: Android has refused non-system apps `AudioSource.VOICE_CALL`
 * since Android 10, so no amount of work on our side would let the app carry a
 * conversation. Bluetooth can, and always could — the Hands-Free Profile was
 * designed for exactly this, and a car stereo is not a privileged application.
 *
 * PipeWire 1.4 grew a D-Bus surface for the hands-free side of that profile,
 * shaped deliberately like oFono's. When a phone is connected in the `hfp_hf`
 * role, WirePlumber publishes an audio gateway and one object per live call,
 * and answering is a method call rather than a permission negotiation.
 *
 * Two consequences worth stating plainly:
 *
 *   - This path needs no app on the phone at all. An iPhone will not tell our
 *     app about a call, but it will happily tell a hands-free unit, so the
 *     Bluetooth half of this feature works on iOS where the LAN half cannot.
 *   - It carries the audio. Answering here means the conversation comes out of
 *     the desktop's speakers and goes back through its microphone.
 *
 * We drive it with `busctl` rather than a D-Bus library: this daemon ships one
 * dependency on purpose, `busctl` is part of systemd and therefore already on
 * every machine that can run Omarchy, and `--json=short` is a stable, parseable
 * contract.
 */

const BUS = 'org.pipewire.Telephony'
const ROOT = '/org/pipewire/Telephony'
const OBJECT_MANAGER = 'org.freedesktop.DBus.ObjectManager'
const GATEWAY = 'org.pipewire.Telephony.AudioGateway1'
const TRANSPORT = 'org.pipewire.Telephony.AudioGatewayTransport1'
const CALL_MANAGER = 'org.ofono.VoiceCallManager'
const CALL = 'org.ofono.VoiceCall'

/** Signals arrive in bursts — one settle window turns a burst into one re-read. */
const SETTLE_MS = 150
/** Only used when `gdbus` is missing and we have to fall back to asking. */
const POLL_MS = 4000

const RINGING = new Set(['incoming', 'waiting'])
const LIVE = new Set(['active', 'held', 'dialing', 'alerting'])

/** `busctl --json=short` wraps every value as { type, data }. */
const unwrap = (value) => (value && typeof value === 'object' && 'data' in value ? value.data : value)

function properties(dict) {
  const out = {}
  for (const [key, value] of Object.entries(dict || {})) out[key] = unwrap(value)
  return out
}

async function busctl(args, { timeout = 4000 } = {}) {
  return run('busctl', ['--user', ...args], { timeout })
}

/** Is the phone ringing, or is a conversation in progress? */
export const isRinging = (call) => RINGING.has(call?.state)
export const isLive = (call) => LIVE.has(call?.state)

export class Handsfree extends EventEmitter {
  constructor() {
    super()
    this.state = { available: false, gateway: null, calls: [] }
    this.monitor = null
    this.timer = null
    this.settle = null
    this.stopped = true
  }

  /**
   * Whether the machine can do this at all. A missing `busctl` or a WirePlumber
   * too old to publish the name are the same answer to the caller: no.
   */
  async probe() {
    if (!has('busctl')) return false
    const res = await busctl([
      '--json=short',
      'call',
      'org.freedesktop.DBus',
      '/org/freedesktop/DBus',
      'org.freedesktop.DBus',
      'NameHasOwner',
      's',
      BUS,
    ])
    if (!res.ok) return false
    try {
      return JSON.parse(res.stdout)?.data?.[0] === true
    } catch {
      return false
    }
  }

  /** Everything WirePlumber currently knows, flattened into our own shape. */
  async read() {
    const res = await busctl(['--json=short', 'call', BUS, ROOT, OBJECT_MANAGER, 'GetManagedObjects'], {
      timeout: 6000,
    })
    if (!res.ok) return { available: false, gateway: null, calls: [] }

    let objects
    try {
      objects = JSON.parse(res.stdout)?.data?.[0] ?? {}
    } catch {
      return { available: true, gateway: null, calls: [] }
    }

    let gateway = null
    const calls = []
    for (const [path, interfaces] of Object.entries(objects)) {
      if (interfaces[GATEWAY]) {
        const props = properties(interfaces[GATEWAY])
        const transport = properties(interfaces[TRANSPORT])
        gateway = {
          path,
          address: props.Address ?? null,
          name: props.Name ?? null,
          speakerVolume: Number.isFinite(props.SpeakerVolume) ? props.SpeakerVolume : null,
          microphoneVolume: Number.isFinite(props.MicrophoneVolume) ? props.MicrophoneVolume : null,
          // "active" is the one that means audio is actually flowing to the
          // desktop's speakers; the profile stays connected while idle.
          audio: transport.State ?? 'idle',
          codec: transport.Codec ?? null,
        }
      }
      if (interfaces[CALL]) {
        const props = properties(interfaces[CALL])
        calls.push({
          path,
          id: path.slice(path.lastIndexOf('/') + 1),
          state: props.State ?? 'unknown',
          from: props.LineIdentification || null,
          name: props.Name || null,
          line: props.IncomingLine || null,
          multiparty: props.Multiparty === true,
        })
      }
    }
    calls.sort((a, b) => a.path.localeCompare(b.path))
    return { available: true, gateway, calls }
  }

  /** The call an unqualified `answer` or `reject` should act on. */
  pick(id = null) {
    const calls = this.state.calls
    if (id) return calls.find((c) => c.id === id || c.path === id) ?? null
    return calls.find(isRinging) ?? calls.find(isLive) ?? calls[0] ?? null
  }

  get connected() {
    return Boolean(this.state.gateway)
  }

  async answer(id = null) {
    const call = this.pick(id)
    if (!call) throw new Error('no call is ringing over Bluetooth')
    // A second call while one is up cannot simply be answered: the profile
    // makes you say what happens to the first one.
    if (!isRinging(call)) throw new Error(`that call is already ${call.state}`)
    const busy = this.state.calls.some((c) => c !== call && isLive(c))
    const res = busy
      ? await busctl(['call', BUS, this.state.gateway.path, CALL_MANAGER, 'HoldAndAnswer'])
      : await busctl(['call', BUS, call.path, CALL, 'Answer'])
    if (!res.ok) throw new Error(res.stderr || 'the phone refused to answer')
    await this.refresh()
    return { ok: true, via: 'bluetooth', call: call.id }
  }

  async hangup(id = null) {
    const call = this.pick(id)
    if (!call) throw new Error('no call is in progress over Bluetooth')
    const res = await busctl(['call', BUS, call.path, CALL, 'Hangup'])
    if (!res.ok) throw new Error(res.stderr || 'the phone refused to hang up')
    await this.refresh()
    return { ok: true, via: 'bluetooth', call: call.id }
  }

  async hangupAll() {
    if (!this.connected) throw new Error('no phone is connected over Bluetooth')
    const res = await busctl(['call', BUS, this.state.gateway.path, CALL_MANAGER, 'HangupAll'])
    if (!res.ok) throw new Error(res.stderr || 'the phone refused to hang up')
    await this.refresh()
    return { ok: true, via: 'bluetooth' }
  }

  async dial(number) {
    if (!this.connected) throw new Error('no phone is connected over Bluetooth')
    const to = String(number || '').trim()
    if (!to) throw new Error('a number is required')
    const path = this.state.gateway.path
    // PipeWire's Dial takes the number alone; oFono's classic signature also
    // carries a caller-id flag. Try ours, then theirs, so this keeps working if
    // the backend behind the name is ever the real oFono.
    let res = await busctl(['call', BUS, path, CALL_MANAGER, 'Dial', 's', to])
    if (!res.ok) res = await busctl(['call', BUS, path, CALL_MANAGER, 'Dial', 'ss', to, 'default'])
    if (!res.ok) throw new Error(res.stderr || 'the phone refused to dial')
    await this.refresh()
    return { ok: true, via: 'bluetooth', to }
  }

  /** DTMF, for the phone trees nobody escapes. */
  async tones(digits) {
    if (!this.connected) throw new Error('no phone is connected over Bluetooth')
    const value = String(digits || '').replace(/[^0-9*#abcdABCD]/g, '')
    if (!value) throw new Error('nothing to send')
    const res = await busctl(['call', BUS, this.state.gateway.path, CALL_MANAGER, 'SendTones', 's', value])
    if (!res.ok) throw new Error(res.stderr || 'the phone refused the tones')
    return { ok: true, via: 'bluetooth', digits: value }
  }

  /**
   * Force the audio link up.
   *
   * Normally answering is enough: the phone opens the SCO channel itself and
   * the conversation appears on the desktop's speakers. Some handsets only do
   * that for a device they consider a car kit, and leave a laptop connected but
   * silent. `Activate` asks for the channel explicitly, which is the escape
   * hatch for exactly that case — hence a separate verb rather than something
   * `answer` does behind the user's back on every call.
   */
  async activateAudio() {
    if (!this.connected) throw new Error('no phone is connected over Bluetooth')
    const res = await busctl(['call', BUS, this.state.gateway.path, TRANSPORT, 'Activate'])
    if (!res.ok) throw new Error(res.stderr || 'the phone would not open the audio link')
    await this.refresh()
    return { ok: true, via: 'bluetooth', audio: this.state.gateway?.audio ?? null }
  }

  async refresh() {
    const next = await this.read()
    this.apply(next)
    return this.state
  }

  /** Diff against what we last saw, and say only what changed. */
  apply(next) {
    const previous = this.state
    this.state = next

    const was = previous.gateway?.path ?? null
    const now = next.gateway?.path ?? null
    if (was !== now || previous.gateway?.audio !== next.gateway?.audio) {
      this.emit('gateway', next.gateway, previous.gateway)
    }

    const before = new Map(previous.calls.map((c) => [c.path, c]))
    for (const call of next.calls) {
      const old = before.get(call.path)
      before.delete(call.path)
      if (!old) this.emit('call', call, null)
      else if (old.state !== call.state) this.emit('call', call, old)
    }
    for (const gone of before.values()) {
      this.emit('call', { ...gone, state: 'disconnected' }, gone)
    }
  }

  /** Coalesce a burst of D-Bus traffic into a single re-read. */
  bump() {
    if (this.settle || this.stopped) return
    this.settle = setTimeout(() => {
      this.settle = null
      this.refresh().catch((err) => log.debug(`handsfree refresh failed: ${err.message}`))
    }, SETTLE_MS)
  }

  /**
   * We watch rather than poll, but we deliberately do not parse the signals.
   * Their payloads are nested variants and the set of them is the backend's
   * business; treating any traffic on the name as "something moved, go look"
   * is both shorter and harder to break.
   */
  watch() {
    if (!has('gdbus')) {
      this.timer = setInterval(() => this.bump(), POLL_MS)
      this.timer.unref?.()
      log.debug('handsfree: gdbus missing, polling instead')
      return
    }
    const child = spawn('gdbus', ['monitor', '--session', '--dest', BUS], {
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    child.on('error', () => {
      this.monitor = null
      if (this.stopped) return
      this.timer = setInterval(() => this.bump(), POLL_MS)
      this.timer.unref?.()
    })
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', () => this.bump())
    child.on('exit', () => {
      this.monitor = null
      // WirePlumber restarting takes the monitor with it; come back for it.
      if (!this.stopped) setTimeout(() => this.start().catch(() => {}), 2000).unref?.()
    })
    child.unref()
    this.monitor = child
  }

  async start() {
    this.stopped = false
    if (!(await this.probe())) {
      this.state = { available: false, gateway: null, calls: [] }
      return false
    }
    await this.refresh()
    if (!this.monitor && !this.timer) this.watch()
    return true
  }

  stop() {
    this.stopped = true
    if (this.settle) clearTimeout(this.settle)
    if (this.timer) clearInterval(this.timer)
    this.monitor?.kill()
    this.settle = this.timer = this.monitor = null
    this.removeAllListeners()
  }

  /** What the panel and `status --json` show. */
  summary() {
    const call = this.pick()
    return {
      available: this.state.available,
      connected: this.connected,
      device: this.state.gateway?.name || this.state.gateway?.address || null,
      address: this.state.gateway?.address ?? null,
      audio: this.state.gateway?.audio ?? null,
      codec: this.state.gateway?.codec ?? null,
      calls: this.state.calls.length,
      call: call ? { id: call.id, state: call.state, from: call.from, name: call.name } : null,
    }
  }
}

export const handsfree = new Handsfree()
