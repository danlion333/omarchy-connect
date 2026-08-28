import { EventEmitter } from 'node:events'

import { has, run, spawn } from './exec.js'
import { log } from './log.js'
import {
  adapter,
  agent,
  available as bluezAvailable,
  closeToPairing,
  connectProfile,
  devices,
  disconnectProfile,
  handsets,
  matchesName,
  openToPairing,
  pairDevice,
  phoneish,
  trustDevice,
  pick,
} from './bluez.js'

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
 * a link that is down publishes nothing at all. So this file also decides when
 * the link is up, through `lib/bluez.js`. By default that is: for the length
 * of a call and no longer. A ring reported down another road raises one in the
 * seconds before anybody reaches the keyboard, and the line clearing takes it
 * back down — including a link this daemon never raised, because BlueZ pages a
 * bonded handset on its own and a phone left on the hands-free profile is a
 * phone stuck in a voice codec all day. Measured on an Intel adapter and an
 * Android handset, BlueZ takes about 1.6s to page a bonded phone and PipeWire
 * a further quarter-second to publish the gateway — comfortably inside a
 * ringing phone, and the reason `ensure` is worth waiting on rather than
 * falling straight through to the app.
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
/**
 * A link nobody here asked for goes down sooner: there is no call to come
 * back, and the whole reason it is being put down is that it should not have
 * been up in the first place.
 */
const STRAY_MS = 3000
/**
 * How many times a stray link is put back down before the desktop gives in.
 *
 * BlueZ and the handset both reconnect on their own, and a phone determined to
 * hold the hands-free profile open would otherwise be fought over forever.
 * Losing that argument quietly, once, in the log, is better than a disconnect
 * every three seconds for the rest of the session.
 */
const STRAY_LIMIT = 3
/**
 * And how close together those have to be to count as an argument. A handset
 * that reconnects once an hour, every hour, is a phone walking in and out of
 * range rather than one refusing to let go.
 */
const STRAY_WINDOW_MS = 60_000
/** Re-reading BlueZ's whole object tree on every ring would be silly. */
const HANDSETS_TTL_MS = 30_000
/**
 * How long the desktop stays visible and willing while making a bond.
 *
 * Long enough to walk to the phone, unlock it and find the Bluetooth screen;
 * short enough that a window nobody used is shut before it is forgotten about.
 */
const BOND_SECONDS = 60
/** How often the tree is re-read while that window is open. */
const BOND_POLL_MS = 1500
/** How long a handset that refused a pairing is left alone before re-asking. */
const BOND_RETRY_MS = 10_000

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
      policy: 'ring',
      address: null,
      /** What BlueZ calls the handset, which is the only place a name exists. */
      handset: null,
      /** How that handset was arrived at — a pin, the LAN pairing, or a guess. */
      matched: null,
      wanted: false,
      raisedBy: null,
      raising: null,
      error: null,
    }
    this.handsets = { at: 0, list: [], read: false }
    /** The bond being made right now, if one is — see `bond`. */
    this.bonding = null
    this.linger = null
    /**
     * "Is there a call on, as far as anybody knows?"
     *
     * PipeWire's own answer is `state.calls`, and it is not always the whole
     * one: plenty of handsets connect, carry the audio and never publish a
     * call object at all. For those the only evidence is the mirrored entry
     * the app or ANCS reported, which this library has no business reading —
     * so the plugin that does own it replaces this.
     */
    this.busy = () => false
    /**
     * "Which phone is this desktop actually paired with?"
     *
     * The name of the handset the LAN half of this project already knows
     * about, so the Bluetooth half can reach for that one rather than for
     * whichever bonded device happens to be alone on the list. Same shape and
     * same reason as `busy` above: this library has no business reading the
     * pairing registry, so the plugin that owns it supplies the answer.
     */
    this.expect = () => null
    /** Stray links put back down in a row, so a losing argument is visible. */
    this.strays = { count: 0, at: 0 }
  }

  /** Policy comes from the config file and can change under a running daemon. */
  configure({ autoConnect, address } = {}) {
    this.link.policy = POLICIES.has(autoConnect) ? autoConnect : 'ring'
    this.link.address = address ? String(address).toUpperCase() : null
    if (this.link.policy === 'off') this.cancelLinger()
    // A policy that has just become "only during a call" has an opinion about
    // the link that is up right now, and should not wait for the next call to
    // act on it.
    this.strays = { count: 0, at: 0 }
    if (this.link.policy === 'ring') this.standDown()
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
      // Whether BlueZ *answered* is a separate fact from what it said, and the
      // difference decides whether an empty list means "nothing is paired" or
      // "nobody was there to ask".
      const reachable = await bluezAvailable()
      this.handsets = { at: Date.now(), list: reachable ? await handsets() : [], read: reachable }
    }
    const expected = this.expectedName()
    const chosen = pick(this.handsets.list, this.link.address, expected)
    /**
     * How the desktop arrived at this handset, so no screen has to imply that
     * a guess and a match are the same confidence. `pinned` is somebody's own
     * decision, `phone` is the handset joined to the LAN pairing by name, and
     * `guess` is the old heuristic — one candidate, so it wins by default.
     */
    this.link.matched = chosen
      ? this.link.address
        ? 'pinned'
        : matchesName(chosen, expected)
          ? 'phone'
          : 'guess'
      : null
    // PipeWire's gateway carries an address and no name, so the only screen
    // that ever names the handset would otherwise read `D0:49:7C:20:F9:74`.
    // BlueZ knows what its owner called it; keep that as it goes past.
    if (chosen) this.link.handset = { address: chosen.address, name: chosen.name }
    // And a name still being carried for a handset BlueZ no longer lists is a
    // handset somebody unpaired — every screen drawing it would go on naming a
    // phone this desktop has no bond with. An *ambiguous* list is a different
    // answer: the handset is there, the desktop merely will not say which one.
    // So only an outright absence clears the name, and only once BlueZ has
    // actually been heard from.
    else if (
      this.handsets.read &&
      this.link.handset &&
      !this.handsets.list.some((d) => d.address === this.link.handset.address)
    ) {
      this.link.handset = null
    }
    return chosen
  }

  /** The paired phone's name, or nothing when there is no answer to be had. */
  expectedName() {
    try {
      return this.expect() || null
    } catch {
      /* a registry that cannot be read is one more thing to guess without */
      return null
    }
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
    // Whatever the link was scheduled to do, it is wanted now.
    this.cancelLinger()
    const handset = await this.handset().catch(() => null)
    if (!handset) {
      // Which of the two dead ends this is decides what the user does next, so
      // the sentence has to tell them apart: nothing bonded at all is a trip to
      // Bluetooth settings, while several bonded and none recognisable as the
      // paired phone is one command.
      const expected = this.link.handset ? null : this.expectedName()
      this.link.error = !this.handsets.list.length
        ? 'no handset is paired over Bluetooth'
        : expected
          ? `no paired handset is named like ${expected} — name one with \`omarchy-connect call handset <address>\``
          : 'more than one paired handset — name one with `omarchy-connect call handset <address>`'
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
   * Make the bond, rather than wait for somebody to make it elsewhere.
   *
   * Everything else in this file assumes the bond exists. That assumption held
   * while pairing was somebody else's job — you bond a phone at a Bluetooth
   * screen once, and a daemon that pages it afterwards has no business in that
   * conversation. What it left behind was a dead end: a panel row reading "no
   * handset is paired over Bluetooth" with no button under it, which names the
   * problem and says nothing about the fix, while the desktop reading it out
   * already knows which handset it wants — the phone it is paired with over
   * the LAN, by name.
   *
   * Both ends of the bond are opened at once, because either can be the one
   * that moves. The desktop becomes visible and willing, so a handset whose
   * Bluetooth screen is open can pick `pc` out of its own list; and the
   * desktop scans, so a handset that is discoverable gets asked without
   * anybody having to tap anything on it. Whichever happens first ends the
   * window.
   *
   * Asking is only done by name. A discoverable window is a window anybody in
   * range can walk through, and this desktop knows exactly whose phone it is
   * after — so with no LAN pairing to join against, it waits to be chosen
   * rather than choosing, and never offers itself to a stranger's handset.
   */
  bond({ seconds = BOND_SECONDS } = {}) {
    // One window at a time, and a second caller joins the first rather than
    // opening a competing one: two scans and two agents on one adapter is a
    // fight over the same radio.
    if (this.bonding) return this.bonding.promise
    const until = Date.now() + seconds * 1000
    const state = { until, stage: 'opening', handset: null, pin: null, error: null, promise: null }
    state.promise = this.makeBond(state, seconds).finally(() => {
      if (this.bonding === state) this.bonding = null
      this.emit('link', this.link)
    })
    this.bonding = state
    this.emit('link', this.link)
    return state.promise
  }

  async makeBond(state, seconds) {
    if (!(await bluezAvailable())) {
      state.error = 'BlueZ is not running — this desktop has no Bluetooth to pair with'
      return { ok: false, error: state.error }
    }
    // A bond that is already there is the whole point of the exercise; there
    // is nothing to make, and what the caller actually wanted was the link.
    const existing = await this.handset({ fresh: true }).catch(() => null)
    if (existing) {
      state.handset = { address: existing.address, name: existing.name }
      state.stage = 'connecting'
      const up = await this.raise('manual', { force: true })
      return { ok: true, already: true, connected: up, handset: state.handset }
    }

    const path = await adapter()
    if (!path) {
      state.error = 'no Bluetooth adapter — check that the radio is plugged in and unblocked'
      return { ok: false, error: state.error }
    }

    // Without `bluetoothctl` there is nobody here to answer BlueZ's pairing
    // questions, which rules out asking — but not being asked, since the
    // system's own agent answers for a bond the handset initiates. Half a
    // window is worth more than an error message.
    //
    // The notifier exists for one moment: a handset that fell back to legacy
    // PIN pairing. The agent has already answered BlueZ with the code, but
    // the *person* is standing at a phone asking for the same code, and the
    // only way they learn it is a screen — so the pin lands in the bonding
    // state and every screen drawing the window says "type 0000 on the
    // phone". On the ordinary SSP path this never fires and nothing changes.
    const helper = agent({
      notify: (kind, value) => {
        if (kind !== 'pin' || this.bonding !== state) return
        state.pin = value
        this.emit('link', this.link)
      },
    })
    const opened = await openToPairing(path, seconds)
    if (!opened.ok) {
      helper?.stop()
      state.error = opened.error || 'the adapter would not become discoverable'
      return { ok: false, error: state.error }
    }

    try {
      return await this.awaitBond(state, path)
    } finally {
      helper?.stop()
      await closeToPairing(path)
      // Whatever the tree looked like before the window, it has moved.
      await this.handset({ fresh: true }).catch(() => {})
    }
  }

  /**
   * Watch the tree until a handset appears on it bonded, asking the one that
   * matches the paired phone by name if it shows up unbonded first.
   */
  async awaitBond(state, path) {
    const expected = this.expectedName()
    /**
     * When each handset was last asked, not whether. A page can time out for
     * reasons that pass — the phone was mid-scan, the radio hiccuped — and a
     * window that never asks twice turns one bad second into a failed minute.
     * The cooldown keeps the retry from becoming a hammer: BlueZ needs a
     * moment between pages, and so does the phone.
     */
    const asked = new Map()
    state.stage = 'looking'
    this.emit('link', this.link)

    while (!this.stopped && Date.now() < state.until) {
      const tree = await devices().catch(() => [])

      // Bonded, and either the phone we were told to expect or — with nothing
      // to expect — the one handset that just arrived. This is the end.
      const bonded = tree.filter((d) => d.paired && phoneish(d))
      const mine = expected ? bonded.find((d) => matchesName(d, expected)) : bonded.length === 1 ? bonded[0] : null
      if (mine) return this.finishBond(state, mine)

      /**
       * Nothing bonded yet, so ask — but only the handset this desktop is
       * already paired with over the LAN, and only over a public address.
       * A `random` one is the low-energy half of the same phone advertising
       * under a rotating identifier, and bonding with that produces exactly
       * the LE-only bond that cannot carry this profile.
       */
      const candidate = expected
        ? tree.find(
            (d) =>
              !d.paired &&
              d.addressType !== 'random' &&
              matchesName(d, expected) &&
              d.path &&
              (!asked.has(d.path) || Date.now() - asked.get(d.path) > BOND_RETRY_MS),
          )
        : null
      if (candidate) {
        asked.set(candidate.path, Date.now())
        state.stage = 'pairing'
        state.handset = { address: candidate.address, name: candidate.name }
        this.emit('link', this.link)
        log.info(`bluetooth: asking ${candidate.name || candidate.address} to pair`)
        const res = await pairDevice(candidate.path)
        if (res.ok) {
          const fresh = (await devices().catch(() => [])).find((d) => d.path === candidate.path)
          if (fresh?.paired) return this.finishBond(state, fresh)
        } else {
          // Not fatal: the handset may still choose us from its own screen,
          // and the window has time left on it either way.
          state.error = res.error
          state.stage = 'looking'
          log.debug(`bluetooth: ${candidate.name || candidate.address} refused the bond: ${res.error}`)
        }
        this.emit('link', this.link)
      }

      await new Promise((resolve) => setTimeout(resolve, BOND_POLL_MS).unref?.())
    }

    state.error =
      state.error ||
      (expected
        ? `${expected} did not pair — open Bluetooth on the phone while the desktop is visible`
        : 'nothing paired — open Bluetooth on the phone and pick this desktop')
    return { ok: false, error: state.error }
  }

  /** Bonded. Trust it, then raise the link it was made for. */
  async finishBond(state, device) {
    state.handset = { address: device.address, name: device.name }
    state.stage = 'connecting'
    this.emit('link', this.link)
    log.ok(`bluetooth: paired with ${device.name || device.address}`)
    // Trust is what lets the handset reconnect on its own afterwards, and a
    // bond made here that still asked permission on every ring would be a
    // worse bond than the one a settings panel makes.
    const trusted = await trustDevice(device.path)
    if (!trusted.ok) log.warn(`bluetooth: could not trust ${device.name || device.address}: ${trusted.error}`)
    await this.handset({ fresh: true }).catch(() => {})
    // `force`, because a desktop whose policy is `off` has just been asked for
    // this bond by hand, and a bond with nothing on the other end of it is a
    // poor way to end the one thing the user pressed.
    const up = await this.raise('manual', { force: true })
    /**
     * And put it back down, on purpose. The raise was a *verification* — it
     * proves the bond carries the profile and it makes the handset read this
     * desktop's SDP while both ends are warm — but the workflow this bond
     * exists for is: paired, disconnected, and raised for the length of a
     * call. A handset left on the profile is a handset stuck in a voice
     * codec, which is the exact behaviour `standDown` spends its life
     * undoing. So unless a call began inside the window, the link is parked:
     * bond kept, trust kept, profile down until a ring wants it.
     */
    let parked = false
    // `this.connected` cannot answer "did it park" here: PipeWire withdraws
    // the gateway a beat after BlueZ drops the profile, so the honest answer
    // is whether the drop itself was taken, not what the mirror shows yet.
    if (up && !this.inUse()) parked = (await this.drop({ force: true }).catch(() => false)) === true
    return { ok: true, connected: up, parked, handset: state.handset, trusted: trusted.ok }
  }

  /** Shut the window early — the user changed their mind, or the daemon is going. */
  stopBonding() {
    if (!this.bonding) return false
    // The loop reads this on its next pass and falls out of the window; the
    // cleanup it is already wrapped in does the rest.
    this.bonding.until = 0
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
   * Every reason the link is doing something right now.
   *
   * A call PipeWire published, audio actually flowing — which is what a
   * conversation looks like on a handset that publishes no calls — or a call
   * the desktop heard about down one of the other roads.
   */
  inUse() {
    if (this.state.calls.length) return true
    if (this.state.gateway?.audio === 'active') return true
    try {
      return this.busy() === true
    } catch {
      return false
    }
  }

  /**
   * The link has nothing under it. Should it still be up?
   *
   * Two roads lead here. A call ended, and the link raised for that one call
   * has nothing left to do — it is dropped after a pause rather than the
   * moment the line clears, because a call that ends with the other side
   * ringing straight back should not have to page the handset again.
   *
   * And, under `ring`, a link nobody here asked for turned up idle. BlueZ
   * pages a bonded handset the moment it is in range and the phone does the
   * same from its side, which is how a desktop that wants a microphone for
   * the length of a call ends up wearing the hands-free profile all day —
   * holding the handset in narrowband and the desktop's own output in
   * whatever a headset profile does to it. Under that policy the link exists
   * while a call does and not otherwise, so this puts it back down.
   *
   * A link somebody asked for by hand is nobody's business but theirs, and
   * one presence is holding open has `presence` to answer to.
   */
  standDown() {
    if (this.link.wanted || !this.connected) return
    if (this.inUse()) return
    /**
     * A raise still in flight owns the link, whatever `raisedBy` says yet.
     *
     * `attempt` cannot record itself as the owner until it knows it succeeded,
     * and it only knows that once PipeWire publishes the gateway — but the
     * refresh that *sees* the gateway appear is the same refresh that calls
     * this, one statement before the owner is written down. Without this line
     * the desktop reads its own half-finished page as a link somebody else
     * raised, schedules the three-second stray drop, and puts down the link it
     * asked for a moment ago: up at :01, gone at :04, on every single raise.
     */
    if (this.link.raising) return
    const mine = this.link.raisedBy
    if (mine && mine !== 'ring') return
    if (!mine && this.link.policy !== 'ring') return
    // Far enough from the last one that this is a handset coming back rather
    // than a handset arguing.
    if (Date.now() - this.strays.at > STRAY_WINDOW_MS) this.strays = { count: 0, at: 0 }
    if (!mine && this.strays.count >= STRAY_LIMIT) return
    // A bedtime already set is not moved: the timers differ only in how long
    // they wait, and restarting one on every D-Bus signal would mean a link
    // that is always three seconds from going down and never goes.
    if (this.linger) return
    this.linger = setTimeout(() => {
      this.linger = null
      // The wait is the point: a call can start inside it, and a link with
      // something under it is not put down whatever this timer was for.
      if (this.link.wanted || this.inUse()) return
      const stray = !this.link.raisedBy
      if (stray) {
        this.strays = { count: this.strays.count + 1, at: Date.now() }
        if (this.strays.count >= STRAY_LIMIT) {
          log.info('bluetooth: the handset keeps raising the hands-free link — leaving it where it is')
        }
      }
      this.drop({ force: stray }).catch(() => {})
    }, mine === 'ring' ? LINGER_MS : STRAY_MS)
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

    // A call under the link is the one reason it is certainly wanted; without
    // one it may have a bedtime, and this is the only place that sees every
    // link — including the one BlueZ raised on its own before this daemon was
    // even started.
    if (next.gateway && this.inUse()) {
      this.cancelLinger()
      this.strays = { count: 0, at: 0 }
    } else if (next.gateway) {
      this.standDown()
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
    // A daemon going away must not leave the machine discoverable behind it.
    this.stopBonding()
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
        /**
         * The handset this desktop would page, whether or not the link is up.
         *
         * `device` above is the gateway's, and the gateway exists only while
         * the profile is connected — so every screen that names the handset
         * was blank in exactly the state somebody is reading it to understand:
         * the link down, and a line underneath saying something about a
         * handset it would not name.
         */
        handset: this.link.handset,
        /** 'pinned' | 'phone' | 'guess' — see `handset`. */
        matched: this.link.matched,
        raisedBy: this.link.raisedBy,
        raising: Boolean(this.link.raising),
        standingDown: Boolean(this.linger),
        /**
         * The bond being made right now. `null` is the ordinary state and the
         * one every screen was written for; while this is set, the desktop is
         * discoverable and something is expected to happen on the phone.
         */
        bonding: this.bonding
          ? {
              until: this.bonding.until,
              /** 'opening' | 'looking' | 'pairing' | 'connecting' */
              stage: this.bonding.stage,
              handset: this.bonding.handset,
              /**
               * Set only when the handset fell back to legacy PIN pairing —
               * the code the agent already gave BlueZ, which the person at
               * the phone now has to type into the dialog asking for it.
               */
              pin: this.bonding.pin,
              error: this.bonding.error,
            }
          : null,
        error: this.link.error,
      },
    }
  }
}

export const handsfree = new Handsfree()
