import crypto from 'node:crypto'

import { has, spawn, spawnDetached } from '../lib/exec.js'
import { log } from '../lib/log.js'
import { handsfree, isRinging, isLive } from '../lib/handsfree.js'
import { ancs } from '../lib/ancs.js'

/**
 * The phone's own telephony, mirrored onto the desktop.
 *
 * Android will hand an app its incoming messages and call state; iOS will not,
 * at any price. So this plugin is written to be fed rather than to poll —
 * whatever the phone can see, it reports, and the desktop raises a
 * notification and keeps a short history for the bar panel.
 *
 * Replying goes the other way: the desktop cannot send an SMS, only the phone
 * can. `phone.send` therefore does not send anything — it hands the phone an
 * instruction and waits for it to say what happened.
 *
 * Three roads lead to the same phone, and the differences matter:
 *
 *   - **Hands-free Bluetooth**, via `lib/handsfree.js`. The phone treats the
 *     desktop as a car stereo. Nothing is installed on the phone, no
 *     permission is granted, iPhones are included — and the audio comes with
 *     it, which is the whole point of answering a call from a computer. What
 *     it knows about a call is the number, never the contact.
 *   - **ANCS over Bluetooth LE**, via `lib/ancs.js`. The phone treats the
 *     desktop as a smartwatch and hands it every notification it raises: the
 *     app, the title, the body. That is where an iPhone's messages come from,
 *     and it is the only road that knows the caller by name. It presses
 *     buttons but moves no audio.
 *   - **The app**, over the LAN. Android's `TelecomManager` will accept or
 *     reject on our behalf, and only Android can be asked to *send* a message.
 *     No audio: the conversation stays on the handset.
 *
 * `requestCall` prefers hands-free whenever a gateway is connected, because a
 * call you can answer but not hear is a worse outcome than one you walk over
 * to; then ANCS, which at least needs no app; then the app.
 *
 * The same iPhone usually arrives down two of these at once, announcing one
 * call as a number over hands-free and as a name over ANCS. `record` folds
 * those together rather than showing the call twice — see `twin`.
 */

const HISTORY = 50
const PENDING_TTL = 60 * 1000
/** Two roads to the same phone means the same call can arrive twice. */
const DEDUPE_MS = 6000
/** Long enough to reach the desk, short enough that voicemail wins after. */
const RING_TIMEOUT_MS = 45_000

/** Newest first. Lives in memory: the phone is the real archive. */
const history = []
const pending = new Map()
let bus = null
/** The `notify-send` process holding the Answer/Decline buttons, if any. */
let ringer = null

const counters = { messages: 0, calls: 0, missed: 0, sent: 0, answered: 0, rejected: 0, notifications: 0 }
/** ANCS notification ids for calls still on screen, so we can act on them. */
const ringingUids = new Map()

const text = (value, max) => (typeof value === 'string' ? value.slice(0, max) : null)

function sweep() {
  const now = Date.now()
  for (const [id, entry] of pending) {
    if (entry.expiresAt < now) {
      entry.reject(new Error('the phone did not answer'))
      pending.delete(id)
    }
  }
}

/** Who the event is from, in the form a human wants to read it. */
const caller = (entry) => entry.name || entry.from || 'unknown number'

/** Take down the ringing notification — answered, rejected, or gone quiet. */
function silence() {
  if (!ringer) return
  const child = ringer
  ringer = null
  try {
    child.kill()
  } catch {
    /* already gone */
  }
}

/**
 * A ringing phone is the one desktop notification that is useless a minute
 * late, and the only one worth putting buttons on. `notify-send -A` waits for
 * the click and prints the action's name, so the notification itself becomes
 * the remote control — no panel, no terminal, no reaching for the handset.
 */
function ring(entry, actionable) {
  if (!has('notify-send')) return
  silence()
  const title = 'Incoming call'
  const body = caller(entry)
  if (!actionable) {
    spawnDetached('notify-send', ['-a', 'Omarchy Connect', '-u', 'critical', title, body])
    return
  }
  const child = spawn(
    'notify-send',
    [
      '-a', 'Omarchy Connect',
      '-u', 'critical',
      '-t', String(RING_TIMEOUT_MS),
      '-A', 'answer=Answer',
      '-A', 'reject=Decline',
      title,
      body,
    ],
    { stdio: ['ignore', 'pipe', 'ignore'] },
  )
  child.on('error', () => {
    if (ringer === child) ringer = null
  })
  child.stdout.setEncoding('utf8')
  let chosen = ''
  child.stdout.on('data', (chunk) => {
    chosen += chunk
  })
  child.on('exit', () => {
    if (ringer === child) ringer = null
    const action = chosen.trim()
    if (action !== 'answer' && action !== 'reject') return
    requestCall({ op: action === 'answer' ? 'answer' : 'reject' }).catch((err) =>
      log.warn(`could not ${action} the call: ${err.message}`),
    )
  })
  ringer = child
}

function notify(entry) {
  if (!has('notify-send')) return
  const from = caller(entry)
  if (entry.kind === 'notification') {
    // The phone already decided this was worth interrupting someone over, so
    // it is repeated at the urgency the phone gave it and no higher.
    const head = [entry.appName || entry.app, entry.title].filter(Boolean).join(' · ')
    spawnDetached('notify-send', ['-a', 'Omarchy Connect', head || 'Phone', entry.body || ''])
    return
  }
  if (entry.kind === 'sms') {
    spawnDetached('notify-send', ['-a', 'Omarchy Connect', `SMS · ${from}`, entry.body || ''])
    return
  }
  if (entry.state === 'ringing') {
    // Buttons only when something on this machine can actually act on them.
    ring(entry, entry.via !== 'app' || Boolean(bus))
    return
  }
  silence()
  if (entry.missed) {
    spawnDetached('notify-send', ['-a', 'Omarchy Connect', '-u', 'critical', 'Missed call', from])
  }
}

/**
 * One ringing phone, announced more than once.
 *
 * With hands-free and the app both live it is the same number twice. With an
 * iPhone it is worse than that: hands-free knows `+380…` and ANCS knows
 * `Тарас`, so the two reports have nothing in common but their timing — which
 * is why a call already in the history counts as the same call when it shares
 * a state and either a number or a road it has not been seen on yet.
 *
 * A second genuinely different call within six seconds, on the same handset,
 * in the same state, is not a thing that happens.
 */
function twin(entry) {
  if (entry.kind !== 'call') return null
  const cutoff = entry.receivedAt - DEDUPE_MS
  return (
    history.find(
      (old) =>
        old.kind === 'call' &&
        old.receivedAt >= cutoff &&
        old.state === entry.state &&
        (!old.from || !entry.from || old.from === entry.from),
    ) ?? null
  )
}

/**
 * Let the second report fill in what the first one could not know. Nothing
 * already recorded is overwritten: the first road to arrive keeps its `via`,
 * which is what makes "it came in over Bluetooth" a stable statement.
 */
function enrich(existing, incoming) {
  if (!existing.from && incoming.from) existing.from = incoming.from
  if (!existing.name && incoming.name) existing.name = incoming.name
  if (existing.ancs == null && incoming.ancs != null) existing.ancs = incoming.ancs
  if (!existing.missed && incoming.missed) {
    existing.missed = true
    counters.missed += 1
  }
  existing.receivedAt = Date.now()
  return existing
}

const KINDS = new Set(['call', 'sms', 'notification'])
const ROADS = new Set(['bluetooth', 'ancs', 'app'])

/**
 * Store one event and say whether it is news.
 *
 * `fresh` is false for a call we had already heard about down another road:
 * the entry it returns is the original, now filled in, so a caller can
 * republish it without raising a second notification for one ringing phone.
 */
function record(raw, device) {
  const kind = KINDS.has(raw.kind) ? raw.kind : 'sms'
  const entry = {
    id: crypto.randomUUID(),
    kind,
    at: Number.isFinite(raw.at) ? raw.at : Date.now(),
    receivedAt: Date.now(),
    from: text(raw.from, 32),
    name: text(raw.name, 64),
    via: ROADS.has(raw.via) ? raw.via : 'app',
    device: device?.name ?? null,
  }
  if (kind === 'notification') {
    entry.app = text(raw.app, 128)
    entry.appName = text(raw.appName, 64)
    entry.title = text(raw.title, 128) ?? ''
    entry.body = text(raw.body, 2000) ?? ''
    counters.notifications += 1
  } else if (kind === 'sms') {
    entry.body = text(raw.body, 2000) ?? ''
    counters.messages += 1
  } else {
    entry.state = ['ringing', 'active', 'ended'].includes(raw.state) ? raw.state : null
    entry.direction = ['incoming', 'outgoing', 'missed'].includes(raw.direction) ? raw.direction : 'incoming'
    entry.missed = raw.missed === true
    entry.seconds = Number.isFinite(raw.seconds) ? raw.seconds : null
    entry.ancs = Number.isFinite(raw.ancs) ? raw.ancs : null
    const already = twin(entry)
    if (already) return { entry: enrich(already, entry), fresh: false }
    // `active` and `ended` are transitions, not events worth counting twice.
    if (entry.state !== 'active' && entry.state !== 'ended') counters.calls += 1
    if (entry.missed) counters.missed += 1
  }
  history.unshift(entry)
  history.length = Math.min(history.length, HISTORY)
  return { entry, fresh: true }
}

/** Store it, announce it if it is news, and tell the panel either way. */
function ingest(raw, device = null) {
  const { entry, fresh } = record(raw, device)
  if (fresh) notify(entry)
  bus?.emit('event', 'phone', { action: 'received', entry })
  return { entry, fresh }
}

export function recent(limit = 10) {
  return history.slice(0, Math.min(Math.max(Number(limit) || 10, 1), HISTORY))
}

export function summary() {
  return { ...counters, recent: recent(5), bluetooth: handsfree.summary(), ios: ancs.summary() }
}

/**
 * Asks the paired phone to send an SMS. Resolves when the phone confirms, so
 * `omarchy-connect sms` can tell the user it actually went out rather than
 * that it was asked for.
 */
export function requestSend({ to, body }) {
  if (!bus) throw new Error('daemon is not running')
  const number = text(to, 32)
  const message = text(body, 2000)
  if (!number) throw new Error('a number is required')
  if (!message) throw new Error('a message is required')

  sweep()
  const id = crypto.randomUUID()
  const outcome = new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, expiresAt: Date.now() + PENDING_TTL })
  })
  bus.emit('event', 'phone', { action: 'send', id, to: number, body: message })
  return { id, outcome }
}

/**
 * How many phones are on the socket right now. The server owns that number;
 * this plugin only needs to know whether asking the app is worth trying, and
 * the ringing notification's buttons call in here with no request context.
 */
let connectedDevices = () => 0
export function trackConnections(fn) {
  connectedDevices = fn
}
const appCanAct = () => Boolean(bus) && connectedDevices() > 0

/**
 * Answer, reject, hang up, dial. One verb, whichever road is open.
 *
 * Bluetooth wins when it is there — it is the only one of the two that brings
 * the audio, and it works whether or not the app is running. Dialling and DTMF
 * are Bluetooth-only: placing a call from the desktop is not much use if you
 * then have to pick the phone up to speak into it.
 */
export async function requestCall({ op, id = null, number = null } = {}) {
  const action = String(op || '').toLowerCase()
  if (!['answer', 'reject', 'hangup', 'dial', 'tones', 'audio'].includes(action)) {
    throw new Error(`unknown call action: ${op}`)
  }

  if (handsfree.connected) {
    if (action === 'dial') return finish(await handsfree.dial(number), action)
    if (action === 'tones') return handsfree.tones(number)
    if (action === 'audio') return handsfree.activateAudio()
    const call = handsfree.pick(id)
    if (call) {
      if (action === 'answer') return finish(await handsfree.answer(id), action)
      return finish(await handsfree.hangup(id), action)
    }
  }

  /**
   * An iPhone's own notification carries the same two buttons the lock screen
   * does, so this works with nothing installed — but it presses a button and
   * nothing more. The conversation stays on the handset, which is why it sits
   * behind hands-free rather than beside it.
   */
  if ((action === 'answer' || action === 'reject' || action === 'hangup') && ancs.connected) {
    const uid = liveUid()
    if (uid != null) {
      const result = await ancs.act(uid, action === 'answer' ? 'positive' : 'negative')
      // The uid deliberately stays on the books. The phone takes its own
      // notification down a moment later, and that is the event that records
      // the call as ended — dropping the uid here would leave the history
      // showing a call that rings forever.
      return finish({ ...result, audio: 'handset' }, action)
    }
  }

  if (action === 'dial' || action === 'tones' || action === 'audio') {
    throw new Error(
      action === 'audio'
        ? 'moving call audio here needs the phone connected over Bluetooth'
        : 'dialling needs the phone connected over Bluetooth',
    )
  }
  if (!appCanAct()) {
    throw new Error('no phone is connected — pair one over Bluetooth or open the app')
  }

  sweep()
  const requestId = crypto.randomUUID()
  const outcome = new Promise((resolve, reject) => {
    pending.set(requestId, { resolve, reject, expiresAt: Date.now() + PENDING_TTL })
  })
  bus.emit('event', 'phone', { action: 'call', id: requestId, op: action, call: id })
  const result = await outcome
  return finish({ ...result, via: 'app' }, action)
}

function finish(result, action) {
  if (action === 'answer') counters.answered += 1
  if (action === 'reject') counters.rejected += 1
  if (action === 'answer' || action === 'reject') silence()
  return result
}

/** The newest iPhone call notification still on screen. */
function liveUid() {
  let newest = null
  for (const [uid, call] of ringingUids) {
    if (!newest || call.at > newest.at) newest = { uid, at: call.at }
  }
  return newest?.uid ?? null
}

/**
 * Fold an iPhone notification into the same history the app feeds.
 *
 * Four shapes come out of one stream, and the category is the only thing the
 * protocol gives us to tell them apart. Messages are recorded as `sms` on
 * purpose even when they came from WhatsApp: what the desktop does with them —
 * show who wrote and what they said — is the same either way, and inventing a
 * fourth kind for the panel to learn would buy nothing.
 */
function fromAncs(n) {
  const who = n.title || null
  if (n.category === 'incomingCall') {
    return { kind: 'call', via: 'ancs', state: 'ringing', direction: 'incoming', name: who, ancs: n.uid }
  }
  if (n.category === 'missedCall') {
    return { kind: 'call', via: 'ancs', state: 'ended', direction: 'missed', missed: true, name: who, at: n.at }
  }
  if (n.messaging) {
    return {
      kind: 'sms',
      via: 'ancs',
      at: n.at,
      name: who,
      // In a group the subtitle is the conversation and the title is the
      // person, so both belong in the line the desktop shows.
      body: [n.subtitle, n.message].filter(Boolean).join(' — '),
    }
  }
  return {
    kind: 'notification',
    via: 'ancs',
    at: n.at,
    app: n.app,
    appName: n.appName,
    title: [n.title, n.subtitle].filter(Boolean).join(' · '),
    body: n.message,
  }
}

/** Fold a Bluetooth call object into the same history the app feeds. */
function fromHandsfree(call, previous) {
  const state = isRinging(call) ? 'ringing' : isLive(call) ? 'active' : 'ended'
  // A call that was ringing and is now gone was never picked up.
  const missed = state === 'ended' && Boolean(previous) && isRinging(previous)
  return {
    kind: 'call',
    via: 'bluetooth',
    state,
    direction: missed ? 'missed' : call.state === 'dialing' || call.state === 'alerting' ? 'outgoing' : 'incoming',
    missed,
    from: call.from,
    name: call.name,
  }
}

export default {
  name: 'phone',

  capabilities() {
    return {
      mirror: true,
      send: true,
      history: HISTORY,
      // The app only needs to know whether the desktop will ever ask it to
      // answer something; whether Bluetooth is up is the desktop's business.
      answer: true,
      bluetooth: handsfree.state.available,
      // What an iPhone's own notifications are reaching us through. The app
      // cannot supply any of this and does not have to try.
      ios: ancs.state.subscribed,
    }
  },

  start(eventBus) {
    bus = eventBus

    handsfree.on('call', (call, previous) => {
      ingest(fromHandsfree(call, previous))
    })
    handsfree.on('gateway', (gateway) => {
      if (!gateway) silence()
      log.info(gateway ? `bluetooth: ${gateway.name || gateway.address} connected` : 'bluetooth: phone disconnected')
      bus?.emit('event', 'phone', { action: 'bluetooth', bluetooth: handsfree.summary() })
    })

    handsfree
      .start()
      .then((ready) => {
        log.info(ready ? 'bluetooth call control ready' : 'bluetooth call control unavailable')
        // Probing the session bus takes a moment, and the status file has
        // already been written by the time it finishes. Say so explicitly:
        // `apply` stays quiet when nothing moved, so without this the panel
        // would show Bluetooth as unsupported until the first call arrived.
        bus?.emit('event', 'phone', { action: 'bluetooth', bluetooth: handsfree.summary() })
      })
      .catch((err) => log.warn(`bluetooth call control failed to start: ${err.message}`))

    /**
     * The iPhone half. Everything an iPhone will ever tell this desktop about
     * its messages, its calls and its apps arrives here, because iOS publishes
     * none of it to the app and all of it to an accessory.
     */
    ancs.on('notification', (n) => {
      const raw = fromAncs(n)
      if (raw.state === 'ringing' && n.uid != null) ringingUids.set(n.uid, { at: Date.now(), name: raw.name })
      ingest(raw)
    })
    ancs.on('removed', (head) => {
      // A call notification going away is the call ending, and that is all it
      // is: whether someone picked up on the handset or let it ring out, ANCS
      // says the same eight bytes. iOS raises a separate missed-call
      // notification for the second case, which `twin` folds into this entry a
      // moment later — so the honest thing to record here is just "ended".
      const call = ringingUids.get(head.uid)
      if (!call) return
      ringingUids.delete(head.uid)
      ingest({ kind: 'call', via: 'ancs', state: 'ended', direction: 'incoming', name: call.name, ancs: head.uid })
    })
    ancs.on('device', (device, subscribed) => {
      if (!subscribed) ringingUids.clear()
      log.info(
        subscribed
          ? `ancs: ${device?.name || device?.address} is mirroring its notifications`
          : 'ancs: no iPhone is mirroring notifications',
      )
      bus?.emit('event', 'phone', { action: 'ios', ios: ancs.summary() })
    })

    ancs
      .start()
      .then((ready) => {
        log.info(ready ? 'iphone notification mirroring ready' : 'iphone notification mirroring unavailable')
        // Same reason as above: the first read finishes after the status file
        // has already been written, and a quiet state change publishes nothing.
        bus?.emit('event', 'phone', { action: 'ios', ios: ancs.summary() })
      })
      .catch((err) => log.warn(`iphone notification mirroring failed to start: ${err.message}`))
  },

  stop() {
    silence()
    handsfree.stop()
    ancs.stop()
    ringingUids.clear()
    for (const [, entry] of pending) entry.reject(new Error('daemon stopped'))
    pending.clear()
    bus = null
  },

  methods: {
    /**
     * A batch rather than one call per message: the phone drains whatever
     * arrived while it was closed in a single request when it reconnects.
     */
    'phone.report'({ events } = {}, ctx = {}) {
      if (!Array.isArray(events)) throw new Error('events must be an array')
      const stored = events.slice(0, 100).map((raw) => ingest(raw || {}, ctx.device))
      const fresh = stored.filter((r) => r.fresh).length
      if (fresh) log.info(`phone reported ${fresh} telephony event(s)`)
      return { ok: true, stored: fresh }
    },

    'phone.history'({ limit = 20 } = {}) {
      return {
        items: recent(limit),
        counters: { ...counters },
        bluetooth: handsfree.summary(),
        ios: ancs.summary(),
      }
    },

    /** The phone's answer to a `send` instruction the desktop issued. */
    'phone.sent'({ id, ok, error } = {}) {
      const entry = pending.get(id)
      if (!entry) return { ok: false, error: 'nothing was waiting for that' }
      pending.delete(id)
      if (ok) {
        counters.sent += 1
        entry.resolve({ ok: true })
      } else {
        entry.reject(new Error(error || 'the phone could not send it'))
      }
      return { ok: true }
    },

    /** The phone's answer to a `call` instruction the desktop issued. */
    'phone.acted'({ id, ok, error } = {}) {
      const entry = pending.get(id)
      if (!entry) return { ok: false, error: 'nothing was waiting for that' }
      pending.delete(id)
      if (ok) entry.resolve({ ok: true })
      else entry.reject(new Error(error || 'the phone could not do that'))
      return { ok: true }
    },
  },
}
