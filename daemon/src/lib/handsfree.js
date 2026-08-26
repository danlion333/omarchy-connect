import { EventEmitter } from 'node:events'

import { has, run, spawn } from './exec.js'
import { log } from './log.js'
import { available as bluezAvailable, connectProfile, disconnectProfile, handsets, pick } from './bluez.js'

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
 * None of that says anything about *getting* the phone onto the profile, and
 * a link that is down publishes nothing at all. So this file also keeps the
 * link up, from `lib/bluez.js`: while the phone is here it holds the profile
 * open, and if a call arrives down another road with the link down anyway, it
 * raises one in the seconds before anybody reaches the keyboard. Measured on
 * an Intel adapter and an Android handset, BlueZ takes about 1.6s to page a
 * bonded phone and PipeWire a further quarter-second to publish the gateway —
 * comfortably inside a ringing phone, and the reason `ensure` is worth
 * waiting on rather than falling straight through to the app.
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

/** What PipeWire is given to publish a gateway once BlueZ says it is connected. */
const PUBLISH_TIMEOUT_MS = 3000
const PUBLISH_POLL_MS = 100
/** What somebody about to answer will wait for a link that is on its way up. */
const RAISE_WAIT_MS = 5000
/** A link raised for one ringing call goes back down this long after it ends. */
const LINGER_MS = 15_000
/** Re-reading BlueZ's whole object tree on every ring would be silly. */
const HANDSETS_TTL_MS = 30_000

const POLICIES = new Set(['presence', 'ring', 'off'])

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
    /**
     * The link, as opposed to what travels over it.
     *
     * `wanted` is the policy's answer to "should this be up right now";
     * `raisedBy` records whether *we* are the reason it is, which is what
     * keeps the daemon from hanging up a link the user made themselves in
     * Bluetooth settings.
     */
    this.link = {
      policy: 'presence',
      address: null,
      /** What BlueZ calls the handset, which is the only place a name exists. */
      handset: null,
      wanted: false,
      raisedBy: null,
      raising: null,
      error: null,
    }
    this.handsets = { at: 0, list: [] }
    this.linger = null
  }

  /** Policy comes from the config file and can change under a running daemon. */
  configure({ autoConnect, address } = {}) {
    this.link.policy = POLICIES.has(autoConnect) ? autoConnect : 'presence'
    this.link.address = address ? String(address).toUpperCase() : null
    if (this.link.policy === 'off') this.cancelLinger()
    this.emit('link', this.link)
    return this.link.policy
  }

  /**
   * The handset to page, cached.
   *
   * The tree it reads changes only when somebody pairs or unpairs something,
   * and both of those are things a person does at a Bluetooth screen — so a
   * ringing phone reads a thirty-second-old answer rather than spending a
   * D-Bus round trip on a question whose answer has not moved since boot.
   */
  async handset({ fresh = false } = {}) {
    const stale = Date.now() - this.handsets.at > HANDSETS_TTL_MS
    if (fresh || stale) {
      this.handsets = { at: Date.now(), list: (await bluezAvailable()) ? await handsets() : [] }
    }
    const chosen = pick(this.handsets.list, this.link.address)
    // PipeWire's gateway carries an address and no name, so the only screen
    // that ever names the handset would otherwise read `D0:49:7C:20:F9:74`.
    // BlueZ knows what its owner called it; keep that as it goes past.
    if (chosen) this.link.handset = { address: chosen.address, name: chosen.name }
    return chosen
  }

  /**
   * Raise the link, or join the raise already under way.
   *
   * Never throws and never runs twice at once: presence and a ringing call
   * both want the same single link, and the second one to ask should wait on
   * the first attempt rather than start a competing page.
   */
  raise(why = 'ring', { force = false } = {}) {
    if (this.connected) return Promise.resolve(true)
    if (this.link.raising) return this.link.raising
    // `off` means the desktop reaches for nothing on its own. It does not mean
    // it refuses to be asked: `force` is what somebody typing `call connect`
    // is, and a policy about automatic behaviour has no vote on that.
    if (!this.state.available) return Promise.resolve(false)
    if (this.link.policy === 'off' && !force) return Promise.resolve(false)
    const attempt = this.attempt(why).finally(() => {
      this.link.raising = null
      // The gateway appearing is announced from `apply`, in the middle of the
      // attempt — which is one announcement too early to say the attempt is
      // over. Anything watching wants both, so say so again on the way out.
      this.emit('link', this.link)
    })
    this.link.raising = attempt
    return attempt
  }

  async attempt(why) {
    const handset = await this.handset().catch(() => null)
    if (!handset) {
      this.link.error = this.handsets.list.length
        ? 'more than one paired handset — name one with `omarchy-connect call handset <address>`'
        : 'no handset is paired over Bluetooth'
      return false
    }
    const res = await connectProfile(handset.path)
    if (!res.ok) {
      this.link.error = res.error
      log.debug(`handsfree: could not raise the link to ${handset.name}: ${res.error}`)
      return false
    }
    /**
     * BlueZ returning is not the same as PipeWire having noticed. The gateway
     * shows up a beat later, and every caller of this cares about the gateway
     * rather than the ACL, so the wait belongs here rather than in each of
     * them.
     */
    const deadline = Date.now() + PUBLISH_TIMEOUT_MS
    while (!this.stopped) {
      await this.refresh().catch(() => {})
      if (this.connected) break
      if (Date.now() >= deadline) break
      await new Promise((resolve) => setTimeout(resolve, PUBLISH_POLL_MS).unref?.())
    }
    if (!this.connected) {
      this.link.error = 'the handset connected but published no hands-free gateway'
      return false
    }
    this.link.error = null
    this.link.raisedBy = why
    log.info(`bluetooth: raised the hands-free link to ${handset.name || handset.address} (${why})`)
    return true
  }

  /**
   * Have a link, if one can be had within `wait`.
   *
   * The bound is the point. A handset in a pocket two rooms away takes BlueZ
   * the better part of ten seconds to give up on, and somebody who has just
   * pressed Answer is not going to spend that staring at a terminal — so the
   * page carries on in the background while the caller gets an honest "not
   * over Bluetooth, then" and takes the other road.
   */
  async ensure({ wait = RAISE_WAIT_MS, why = 'ring', force = false } = {}) {
    if (this.connected) return true
    if (!this.state.available) return false
    if (this.link.policy === 'off' && !force) return false
    const raising = this.raise(why, { force })
    if (wait <= 0) return false
    let timer = null
    const capped = new Promise((resolve) => {
      timer = setTimeout(() => resolve(false), wait)
      timer.unref?.()
    })
    await Promise.race([raising, capped])
    if (timer) clearTimeout(timer)
    return this.connected
  }

  /** Put down a link this daemon raised. One it did not raise is not its to drop. */
  async drop({ force = false } = {}) {
    this.cancelLinger()
    if (!force && !this.link.raisedBy) return false
    const handset = await this.handset().catch(() => null)
    this.link.raisedBy = null
    if (!handset) return false
    const res = await disconnectProfile(handset.path)
    if (!res.ok) log.debug(`handsfree: could not drop the link: ${res.error}`)
    else log.info(`bluetooth: dropped the hands-free link to ${handset.name || handset.address}`)
    await this.refresh().catch(() => {})
    this.emit('link', this.link)
    return res.ok
  }

  /**
   * The phone appeared on the network, or left it.
   *
   * This is the whole of the `presence` policy: hold the profile open for as
   * long as the handset is in the room, so that when it rings the link has
   * been up for hours and there is no race to lose. The alternative — raising
   * it on the ring itself — works, and is what `ring` does, but it spends the
   * first two seconds of every call on a page.
   */
  presence(here) {
    if (this.link.policy !== 'presence') return
    this.link.wanted = Boolean(here)
    if (here) {
      this.cancelLinger()
      this.raise('presence').catch(() => {})
    } else if (this.link.raisedBy === 'presence') {
      // Only the link presence itself put up. One raised for a call has
      // `standDown` to answer to, and one somebody asked for by hand outlives
      // the app that happened to be running at the time.
      this.drop().catch(() => {})
    }
  }

  /**
   * A call ended.
   *
   * A link the desktop raised for that one call has nothing left to do, but it
   * is dropped after a pause rather than the moment the line clears: a call
   * that ends because the other side is calling straight back should not have
   * to page the handset again.
   */
  standDown() {
    if (this.link.raisedBy !== 'ring' || this.link.wanted) return
    if (this.state.calls.length) return
    this.cancelLinger()
    this.linger = setTimeout(() => {
      this.linger = null
      if (!this.state.calls.length && !this.link.wanted) this.drop().catch(() => {})
    }, LINGER_MS)
    this.linger.unref?.()
  }

  cancelLinger() {
    if (this.linger) clearTimeout(this.linger)
    this.linger = null
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
    // A link that went away is no longer ours to put down, however it went.
    if (!now) this.link.raisedBy = null
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

  /**
   * Stopping the daemon does not hang up the phone.
   *
   * A restart in the middle of a conversation is a bad enough moment already;
   * taking the audio with it would be worse, and the link is re-adopted on the
   * way back up because `read` sees whatever is there.
   */
  stop() {
    this.stopped = true
    this.cancelLinger()
    if (this.settle) clearTimeout(this.settle)
    if (this.timer) clearInterval(this.timer)
    this.monitor?.kill()
    this.settle = this.timer = this.monitor = null
    this.removeAllListeners()
  }

  /** The handset's own name, when BlueZ has been asked about that address. */
  named(address) {
    if (!address) return null
    const known = this.link.handset
    return known && known.address === address ? known.name || address : address
  }

  /** What the panel and `status --json` show. */
  summary() {
    const call = this.pick()
    return {
      available: this.state.available,
      connected: this.connected,
      device: this.state.gateway?.name || this.named(this.state.gateway?.address) || null,
      address: this.state.gateway?.address ?? null,
      audio: this.state.gateway?.audio ?? null,
      codec: this.state.gateway?.codec ?? null,
      calls: this.state.calls.length,
      call: call ? { id: call.id, state: call.state, from: call.from, name: call.name } : null,
      link: {
        policy: this.link.policy,
        pinned: this.link.address,
        raisedBy: this.link.raisedBy,
        raising: Boolean(this.link.raising),
        error: this.link.error,
      },
    }
  }
}

export const handsfree = new Handsfree()
