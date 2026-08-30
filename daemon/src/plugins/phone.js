import crypto from 'node:crypto'
import fs from 'node:fs'

import { has, run, spawn, spawnDetached } from '../lib/exec.js'
import { log } from '../lib/log.js'
import { handsfree, isRinging, isLive } from '../lib/handsfree.js'
import { ringtone } from '../lib/ringtone.js'
import { talkTime } from '../lib/talktime.js'
import { ancs } from '../lib/ancs.js'
import { loadConfig, pairedDevice, saveConfig } from '../lib/config.js'

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
 * Which makes *whether* a gateway is connected the question the whole ranking
 * turns on, and the answer used to be "whatever the user last did in Bluetooth
 * settings". It is not any more: the link belongs to the call. `anticipate`
 * starts the page the moment a ring is reported down a road that carries no
 * audio, which buys the seconds it takes back from the ones between the ring
 * and somebody reaching the keyboard; and when the call is over the link goes
 * back down, so the handset is not held in a hands-free codec for the rest of
 * the day by a desktop that wanted a microphone for four minutes.
 *
 * The same iPhone usually arrives down two of these at once, announcing one
 * call as a number over hands-free and as a name over ANCS. `record` folds
 * those together rather than showing the call twice — see `twin`.
 */

const HISTORY = 50
const PENDING_TTL = 60 * 1000
/** How often a request the phone never answered is checked for expiry. */
const SWEEP_MS = 5000
/** Two roads to the same phone means the same call can arrive twice. */
const DEDUPE_MS = 6000
/** Long enough to reach the desk, short enough that voicemail wins after. */
const RING_TIMEOUT_MS = 45_000

/** Newest first. Lives in memory: the phone is the real archive. */
const history = []
const pending = new Map()
let bus = null
/** Runs `sweep` on its own, so a request nobody follows still ends. */
let janitor = null
/** The `notify-send` process holding the Answer/Decline buttons, if any. */
let ringer = null
/** The server's id for that notification, so it can be replaced or closed. */
let ringingId = 0
/** A rewrite asked for before the notification it rewrites had an id yet. */
let queuedRing = null
/** The call a remote control should act on, from whichever road saw it. */
let live = null
/**
 * When the conversation actually started — the moment somebody picked up, not
 * the moment the phone rang.
 *
 * It is kept here rather than on the entry because the panel reads a call the
 * hands-free profile published, which is a different object from the entry the
 * history holds; one desktop is only ever in one conversation, so one clock is
 * enough for both. Zero means nobody is talking.
 */
let activeSince = 0

/**
 * Notification servers that advertise `actions` and draw no buttons.
 *
 * Every server on the bus claims the `actions` capability, including the ones
 * whose entire idea of an action is to run the one named `default` when the
 * notification is clicked — Omarchy's own shell among them. Nothing in the
 * spec tells the two apart, so the server is asked who it is and this short
 * list is consulted. Being wrong costs a line of text, never a button.
 */
const BUTTONLESS = /quickshell/i
let drawsButtons = true

/**
 * The server's reason for taking a card off the screen, when the reason is a
 * person: 1 is its own timeout running out, 3 is a client asking for it, and 2
 * is somebody sweeping it away by hand.
 */
const CLOSED_BY_HAND = 2

/** The `gdbus monitor` reading what becomes of the ringing card, if any. */
let cardWatch = null
/** The card whose own action has already fired, so its close means nothing. */
let cardActed = 0

/** Ask once, at startup, so `ring` never waits on D-Bus while a phone rings. */
async function readNotificationServer() {
  if (!has('gdbus')) return
  const res = await run(
    'gdbus',
    [
      'call', '--session',
      '--dest', 'org.freedesktop.Notifications',
      '--object-path', '/org/freedesktop/Notifications',
      '--method', 'org.freedesktop.Notifications.GetServerInformation',
    ],
    { timeout: 4000 },
  )
  if (!res.ok) return
  drawsButtons = !BUTTONLESS.test(res.stdout)
  if (!drawsButtons) {
    log.info('notifications: this server draws no buttons — a ringing call answers on click')
  }
  // The talking card's way out depends on the same answer: a button where one
  // will be drawn, the right mouse button where none will be.
  wireHangUp()
}

const counters = { messages: 0, calls: 0, missed: 0, sent: 0, answered: 0, rejected: 0, notifications: 0 }
/** ANCS notification ids for calls still on screen, so we can act on them. */
const ringingUids = new Map()

const text = (value, max) => (typeof value === 'string' ? value.slice(0, max) : null)

/**
 * Android lays a phone number out before it shows it, wrapping it in invisible
 * direction marks so a leading `+` still reads correctly beside right-to-left
 * script. Those marks are for a phone's screen, not for this one, and a number
 * still carrying them does not compare equal to the same number arriving over
 * Bluetooth — which is what decides whether one ringing phone is one entry.
 */
const INVISIBLE = /[\u00ad\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g
const person = (value, max) => {
  if (typeof value !== 'string') return null
  const clean = value.replace(INVISIBLE, '').trim()
  return clean ? clean.slice(0, max) : null
}

/** A caller ID made of nothing but dialling characters is a number, not a name. */
const NUMBERISH = /^[+()\-.\s\d*#]+$/
const isNumber = (value) => typeof value === 'string' && NUMBERISH.test(value) && /\d/.test(value)

/**
 * Time out the requests the phone never answered.
 *
 * This is on a timer rather than only at the head of the next request: the
 * next request may never come, and until one does the promise stays unsettled
 * — which the caller sees as an HTTP request that hangs forever rather than as
 * a phone that did not reply.
 */
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

/**
 * Watch what becomes of the ringing card, so the right mouse button means
 * something.
 *
 * A server that draws no buttons leaves the ringing card with one gesture that
 * answers — the click — and one that makes it go away, which on every server
 * worth the name is the right button. libnotify carries the first to us and
 * not the second: a card swept off the screen invoked no action, so
 * `notify-send` exits having printed nothing, and the phone goes on ringing in
 * a room where somebody has just said no to it.
 *
 * The bus does say it. `NotificationClosed` carries a reason, and the reason
 * tells a person's hand apart from the card's own timeout and from our close.
 * So the right button becomes Decline: the card is gone either way, and a
 * ringing phone somebody has just swept off their screen is not one they are
 * about to pick up.
 *
 * The click has to be told apart from the sweep, because a server closes the
 * card it has just invoked an action on — answering produces the same close
 * declining does. `ActionInvoked` arrives first and on this same stream, which
 * is why the decision is made here rather than off the back of `notify-send`
 * exiting: one stream, in order, with no race between two of them.
 */
function watchCard() {
  if (cardWatch || !has('gdbus')) return
  cardActed = 0
  const child = spawn(
    'gdbus',
    [
      'monitor', '--session',
      '--dest', 'org.freedesktop.Notifications',
      '--object-path', '/org/freedesktop/Notifications',
    ],
    { stdio: ['ignore', 'pipe', 'ignore'] },
  )
  child.on('error', () => {
    if (cardWatch === child) cardWatch = null
  })
  child.on('exit', () => {
    if (cardWatch === child) cardWatch = null
  })
  child.stdout.setEncoding('utf8')
  // A signal is one line, but a chunk is not: the tail of a half-arrived line
  // is kept rather than read as a whole one and thrown away.
  let tail = ''
  child.stdout.on('data', (chunk) => {
    if (cardWatch !== child) return
    tail += chunk
    const lines = tail.split('\n')
    tail = lines.pop()
    for (const line of lines) readCardSignal(line)
  })
  // A watch on a card is not a reason for the daemon to stay up.
  child.unref()
  cardWatch = child
}

/** Put the watch down: the card is nobody's business once the ring is over. */
function unwatchCard() {
  const child = cardWatch
  cardWatch = null
  cardActed = 0
  if (!child) return
  try {
    child.kill()
  } catch {
    /* already gone */
  }
}

/** One line of `gdbus monitor`, which is at most one thing about our card. */
function readCardSignal(line) {
  const acted = /ActionInvoked \(uint32 (\d+)/.exec(line)
  if (acted) {
    // Answering closes the card as well. Remembering which card acted is what
    // keeps the close that follows from declining the call just answered.
    if (Number(acted[1]) === ringingId) cardActed = ringingId
    return
  }
  const closed = /NotificationClosed \(uint32 (\d+), uint32 (\d+)\)/.exec(line)
  if (!closed) return
  const id = Number(closed[1])
  if (!ringingId || id !== ringingId || id === cardActed) return
  if (Number(closed[2]) !== CLOSED_BY_HAND) return
  log.info('the ringing card was closed by hand — declining the call')
  silence()
  requestCall({ op: 'reject' }).catch((err) => log.warn(`could not reject the call: ${err.message}`))
}

/**
 * Leave the conversation, from the card that is counting it.
 *
 * The ringing card's two gestures end at the moment somebody picks up, and
 * until now the card that replaced it had none: the only way out of a call
 * answered from the desktop was to pick the handset up after all. It is the
 * same request the panel's own button makes, and it goes down whichever road
 * the call came in on.
 */
function hangUp() {
  log.info('hanging up from the call card')
  return requestCall({ op: 'hangup' }).catch((err) => log.warn(`could not hang up the call: ${err.message}`))
}

/** Hand the talk timer its way out, once we know what this server draws. */
function wireHangUp() {
  talkTime.answers({ hangup: hangUp, buttons: drawsButtons })
}

/**
 * Take down the ringing notification — answered, rejected, or gone quiet.
 *
 * Killing `notify-send` is not enough. By the time it is waiting for a click
 * the notification belongs to the server, and it stays on screen until its own
 * timeout however the client dies. So the id is kept and the server is told to
 * close it. `close` is false for the one caller that wants the opposite: `ring`
 * replacing its own notification in place, which needs that id still valid.
 */
function silence(close = true) {
  const child = ringer
  ringer = null
  // `close` false is `ring` rewriting its own card in place — the phone is
  // still ringing, and the melody carries on from where it is rather than
  // starting over on the beat the caller's name arrives.
  if (close) {
    queuedRing = null
    ringtone.stop()
    unwatchCard()
  }
  if (child) {
    try {
      child.kill()
    } catch {
      /* already gone */
    }
  }
  if (!close || !ringingId) return
  const id = ringingId
  ringingId = 0
  if (!has('gdbus')) return
  spawnDetached('gdbus', [
    'call', '--session',
    '--dest', 'org.freedesktop.Notifications',
    '--object-path', '/org/freedesktop/Notifications',
    '--method', 'org.freedesktop.Notifications.CloseNotification',
    String(id),
  ])
}

/**
 * The ringing card, handed over to the call it turned into.
 *
 * Picking up does not close the notification and raise another underneath it:
 * the id is kept, so the talk timer rewrites that same card in place and the
 * screen shows one call all the way through. Everything else the ring owned —
 * the melody, the `notify-send` waiting for a click, a rewrite queued behind
 * an id that is no longer coming — is put down here, because only the card
 * itself survives the answer.
 */
function handOver() {
  const id = ringingId
  ringtone.stop()
  // The card lives on as the talk timer's, and closing that one is somebody
  // clearing their screen mid-conversation, not hanging up.
  unwatchCard()
  queuedRing = null
  silence(false)
  ringingId = 0
  return id
}

/** Raise a rewrite that was waiting on an id, now that one will never come. */
function flushQueuedRing() {
  const queued = queuedRing
  queuedRing = null
  if (queued) ring(queued.entry, queued.actionable)
}

/**
 * A ringing phone is the one desktop notification that is useless a minute
 * late, and the only one worth putting buttons on. `notify-send -A` waits for
 * the click and prints the action's name, so the notification itself becomes
 * the remote control — no panel, no terminal, no reaching for the handset.
 */
function ring(entry, actionable) {
  if (!has('notify-send')) return
  // The id of the notification already on screen arrives on the previous
  // `notify-send`'s stdout, a moment after it was spawned. A second report
  // landing inside that moment — two ringing events drained from the phone's
  // backlog in one batch is exactly that — would have nothing to rewrite and
  // would stack a second card beside the first, leaving the anonymous one on
  // screen next to the named one. So it waits for the id rather than racing it.
  if (ringer && !ringingId) {
    queuedRing = { entry, actionable }
    return
  }
  // One ringing phone is one notification, even though it is announced twice:
  // the call arrives anonymous and is named a moment later, and the second
  // report must rewrite the first rather than stack beside it. `-r` is what
  // makes that a rewrite; closing and re-raising would flash and re-alert.
  const replaces = ringingId
  silence(false)
  const title = 'Incoming call'
  // Only where there are no buttons to press. A server that draws Answer and
  // Decline has said what a card is for, and closing one there is somebody
  // clearing their screen rather than turning a caller away.
  if (actionable && !drawsButtons) watchCard()
  // A server with no buttons still has two gestures, and both are worth
  // spelling out — otherwise the notification looks like a readout of a phone
  // you have to walk over to.
  const gestures = cardWatch ? 'click to answer, right-click to decline' : 'click to answer'
  const body = actionable && !drawsButtons ? `${caller(entry)} · ${gestures}` : caller(entry)
  const common = ['-a', 'Omarchy Connect', '-u', 'critical']
  if (replaces) common.push('-r', String(replaces))
  if (!actionable) {
    // Detached, so its stdout is gone and a first notification's id is unknown
    // — a replacement of one we already have an id for still works.
    spawnDetached('notify-send', [...common, title, body])
    ringingId = replaces
    return
  }
  const child = spawn(
    'notify-send',
    [
      ...common,
      '-p',
      '-t', String(RING_TIMEOUT_MS),
      // `default` is the action a notification invokes when it is clicked
      // rather than one it draws a button for, and it is the only one some
      // servers implement at all. Registering it alongside the named pair is
      // what makes one notification work on both kinds: buttons where there
      // are buttons, click-to-answer where there are not.
      '-A', 'default=Answer',
      '-A', 'answer=Answer',
      '-A', 'reject=Decline',
      title,
      body,
    ],
    { stdio: ['ignore', 'pipe', 'ignore'] },
  )
  child.on('error', () => {
    if (ringer !== child) return
    ringer = null
    flushQueuedRing()
  })
  child.stdout.setEncoding('utf8')
  let chosen = ''
  child.stdout.on('data', (chunk) => {
    chosen += chunk
    // `-p` prints the id as soon as the server accepts the notification; the
    // clicked action, if there is one, follows on a later line.
    if (ringer !== child) return
    const first = chosen.split('\n', 1)[0].trim()
    if (!/^\d+$/.test(first) || ringingId) return
    ringingId = Number(first)
    // Whatever was waiting on this id can now rewrite the card rather than
    // stack a second one beside it.
    flushQueuedRing()
  })
  child.on('exit', () => {
    // Killed by `silence`, which already owns the id and has moved on.
    if (ringer !== child) return
    ringer = null
    ringingId = 0
    // A notification that went away without ever reporting an id leaves a
    // rewrite waiting on something that is not coming; it raises its own card.
    flushQueuedRing()
    const action = chosen
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line === 'default' || line === 'answer' || line === 'reject')
    if (!action) return
    const op = action === 'reject' ? 'reject' : 'answer'
    requestCall({ op }).catch((err) => log.warn(`could not ${op} the call: ${err.message}`))
  })
  ringer = child
}

function notify(entry) {
  // The sound comes first and does not depend on libnotify: a machine with no
  // `notify-send` can still be in another room from the handset, and that is
  // the whole case for a ringing desktop.
  if (entry.kind === 'call' && entry.state === 'ringing') ringtone.start(RING_TIMEOUT_MS)
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
    ring(entry, canAct())
    return
  }
  if (entry.state === 'active') {
    // The card that was ringing becomes the card that counts — or comes off
    // the screen, if nothing is going to count on it.
    const inherited = handOver()
    const took = talkTime.start({
      key: entry.call || entry.id,
      who: from,
      replaces: inherited,
      at: activeSince || Date.now(),
    })
    if (inherited && !took) talkTime.close(inherited)
    return
  }
  silence()
  if (entry.state === 'ended') talkTime.stop()
  if (entry.missed) {
    spawnDetached('notify-send', ['-a', 'Omarchy Connect', '-u', 'critical', 'Missed call', from])
  }
}

/**
 * Whether two reports could be about the same person. Anonymous counts as
 * compatible on purpose: a modern Android puts the number in none of its call
 * broadcasts, so most reports have nothing to compare, and refusing to match
 * them would put every call on the desktop two or three times over.
 */
const sameParty = (a, b) =>
  (!a.from || !b.from || a.from === b.from) && (!a.name || !b.name || a.name === b.name)

/**
 * The line in the history this report belongs to, if it belongs to one.
 *
 * Two different questions wear the same coat here. One is a call announced
 * twice at once — hands-free and the app both saw the phone ring — and that is
 * settled by timing. The other is the *same* call reported again as it moves
 * from ringing to answered to over, which is minutes apart, and which used to
 * fill the panel with three lines about one conversation.
 *
 * Three answers, in the order they can be trusted:
 *
 *   1. The token the phone stamps on every report of one call. Exact, however
 *      far apart the reports land, and it needs no guess about the caller.
 *   2. The call already up on this desktop, moving on. Timing cannot decide
 *      this one — a phone rings for half a minute before anybody answers it,
 *      a long way outside the window two simultaneous reports share.
 *   3. Timing, for the roads that carry no token: hands-free knows `+380…`
 *      while ANCS knows `Тарас`, so those two have nothing in common but the
 *      moment they arrived. A second genuinely different call within six
 *      seconds, on the same handset, in the same state, does not happen.
 */
function twin(entry) {
  if (entry.kind !== 'call') return null
  if (entry.call) {
    const stamped = history.find((old) => old.kind === 'call' && old.call === entry.call)
    if (stamped) return stamped
  }
  // Only for a report that carries no token of its own: one that does and
  // matched nothing above is a new call, whoever it is with.
  if (
    !entry.call &&
    live &&
    live.state !== 'ended' &&
    entry.state !== 'ringing' &&
    history.includes(live) &&
    sameParty(live, entry)
  ) {
    return live
  }
  const cutoff = entry.receivedAt - DEDUPE_MS
  return (
    history.find(
      (old) =>
        old.kind === 'call' &&
        old.receivedAt >= cutoff &&
        old.state === entry.state &&
        // A line stamped with a different call is a different call, whatever
        // the clock says. A line with no stamp at all is the road that cannot
        // give one — hands-free — reporting the ring the app also just saw.
        (!old.call || !entry.call || old.call === entry.call) &&
        (!old.from || !entry.from || old.from === entry.from),
    ) ?? null
  )
}

/**
 * Let the second report fill in what the first one could not know. Nothing
 * already recorded is overwritten: the first road to arrive keeps its `via`,
 * which is what makes "it came in over Bluetooth" a stable statement.
 *
 * Returns whether what the user would be shown has changed, which is the one
 * thing worth telling them a second time: "unknown number" becoming a number
 * is worth a replacement, and so is that number becoming a name. And whether
 * the call moved on, which is what takes the ringing card back off the screen.
 */
function enrich(existing, incoming) {
  const before = caller(existing)
  const wasState = existing.state
  if (!existing.from && incoming.from) existing.from = incoming.from
  // A dialler that has not looked the caller up yet puts the number where the
  // name goes, and older builds of the app forwarded that verbatim. A real
  // name landing afterwards is the correction, not a second opinion — and the
  // number it displaces is worth moving rather than dropping.
  if (incoming.name && (!existing.name || (isNumber(existing.name) && !isNumber(incoming.name)))) {
    if (isNumber(existing.name) && !existing.from) existing.from = existing.name
    existing.name = incoming.name
  }
  if (!existing.from && isNumber(incoming.name)) existing.from = incoming.name
  if (existing.ancs == null && incoming.ancs != null) existing.ancs = incoming.ancs
  if (!existing.missed && incoming.missed) {
    existing.missed = true
    counters.missed += 1
  }
  // Ringing, answered, over: one conversation walking through its states. The
  // line follows it instead of a second line being written underneath.
  if (incoming.state && incoming.state !== existing.state) existing.state = incoming.state
  // `record` calls a call incoming when nobody said otherwise, so only a road
  // that actually knows better is allowed to overrule what is already there.
  if (incoming.direction && incoming.direction !== 'incoming' && existing.direction === 'incoming') {
    existing.direction = incoming.direction
  }
  if (!existing.call && incoming.call) existing.call = incoming.call
  if (existing.seconds == null && Number.isFinite(incoming.seconds)) existing.seconds = incoming.seconds
  existing.receivedAt = Date.now()
  return { entry: existing, named: caller(existing) !== before, advanced: existing.state !== wasState }
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
    from: person(raw.from, 32),
    name: person(raw.name, 64),
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
    entry.call = text(raw.call, 64)
    const already = twin(entry)
    if (already) {
      const { entry: merged, named, advanced } = enrich(already, entry)
      return { entry: merged, fresh: false, named, advanced }
    }
    // Once per conversation, wherever in its life the desktop caught it. It
    // used to skip anything that arrived `active` or `ended` to avoid counting
    // a call three times — which meant an outgoing call, which never rings and
    // so never arrives any other way, was never counted at all.
    counters.calls += 1
    if (entry.missed) counters.missed += 1
  }
  history.unshift(entry)
  history.length = Math.min(history.length, HISTORY)
  return { entry, fresh: true }
}

/**
 * A call, reported down a road that cannot carry it.
 *
 * The app and ANCS both say "this phone is ringing" without being able to put
 * the conversation on the desktop's speakers — but the desktop can go and get
 * a link that will, and the ringing is the signal to start. The page runs
 * unwatched: nothing here waits for it, and by the time anybody presses Answer
 * `requestCall` either finds a gateway or gives up on one honestly.
 *
 * A call arriving over Bluetooth is its own proof that the link is up, so it
 * asks for nothing.
 */
function anticipate(entry) {
  if (entry.state === 'ringing' && entry.via !== 'bluetooth' && !handsfree.connected) {
    handsfree.raise('ring').catch(() => {})
    return
  }
  // Whatever raised it, a link with no calls left under it may have a bedtime.
  if (entry.state === 'ended') handsfree.standDown()
}

/** Store it, announce it if it is news, and tell the panel either way. */
function ingest(raw, device = null) {
  const { entry, fresh, named, advanced } = record(raw, device)
  if (entry.kind === 'call') {
    remember(entry)
    anticipate(entry)
  }
  // A phone that is still ringing is announced again once its caller becomes
  // known: `ring` rewrites the notification already on screen, so "unknown
  // number" turns into a name in place rather than gaining a twin beside it.
  // A call that moves on is news too, even though its line was already there —
  // it is what takes the ringing card down and stops the ringtone.
  if (fresh || advanced || (named && entry.state === 'ringing')) notify(entry)
  bus?.emit('event', 'phone', { action: 'received', entry })
  return { entry, fresh }
}

export function recent(limit = 10) {
  return history.slice(0, Math.min(Math.max(Number(limit) || 10, 1), HISTORY))
}

export function summary() {
  return {
    ...counters,
    recent: recent(5),
    call: liveCall(),
    bluetooth: handsfree.summary(),
    ios: ancs.summary(),
    ringtone: ringtone.summary(),
    timer: talkTime.summary(),
  }
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
 * Whether a button on this desktop would reach the phone at all.
 *
 * Any one of the three roads is enough, and it need not be the road the call
 * arrived down: a call the app mirrored is answered over Bluetooth when
 * Bluetooth is what is connected, which is how the audio ends up here.
 */
const canAct = () => handsfree.connected || ancs.connected || appCanAct()

/**
 * The call a remote control should act on, from whichever road saw it.
 *
 * Hands-free wins when it published a call object, because that one knows
 * about audio. But PipeWire only publishes those for handsets that report call
 * state over the profile, and plenty connect, carry sound and say nothing —
 * for those the mirrored entry is the only evidence a phone is ringing, and
 * falling back to it is what keeps the panel's buttons on screen.
 */
export function liveCall() {
  const call = handsfree.connected ? handsfree.pick() : null
  if (call && (isRinging(call) || isLive(call))) {
    return {
      id: call.id,
      state: isRinging(call) ? 'ringing' : 'active',
      from: call.from ?? null,
      name: call.name ?? null,
      via: 'bluetooth',
      audio: handsfree.state.gateway?.audio ?? null,
      // When the talking started, so a panel two rooms away can count without
      // asking again. A ringing call has not started yet and says null.
      startedAt: isLive(call) ? activeSince || null : null,
    }
  }
  if (!live) return null
  // A phone that rang and was never reported again: voicemail has it by now,
  // and offering to answer it would be a lie.
  if (live.state === 'ringing' && Date.now() - live.receivedAt > RING_TIMEOUT_MS) {
    live = null
    return null
  }
  return {
    id: live.id,
    state: live.state,
    from: live.from,
    name: live.name,
    via: live.via,
    audio: null,
    startedAt: live.state === 'active' ? activeSince || null : null,
  }
}

/** One handset, one conversation: `ended` takes down whatever was offered. */
function remember(entry) {
  if (entry.state === 'ringing' || entry.state === 'active') live = entry
  else if (entry.state === 'ended') live = null
  // The clock starts on the first report that says somebody picked up, and a
  // second report of the same conversation must not set it back to zero. Only
  // the call being over stops it — a report that says nothing about the state
  // is not evidence that the talking finished.
  if (entry.state === 'active') activeSince = activeSince || Date.now()
  else if (entry.state === 'ended') activeSince = 0
}

/**
 * The paired handsets, for a caller that has to explain a choice it could not
 * make. Never throws: an unreachable BlueZ is an empty list, not an error on
 * top of whatever the user was actually asking about.
 */
async function handsets() {
  try {
    await handsfree.handset({ fresh: true })
    return handsfree.handsets.list.map((d) => ({ address: d.address, name: d.name, connected: d.connected }))
  } catch {
    return []
  }
}

/**
 * Answer, reject, hang up, dial — and the link all of that rides on. One verb,
 * whichever road is open.
 *
 * Bluetooth wins when it is there — it is the only one of the two that brings
 * the audio, and it works whether or not the app is running. Dialling and DTMF
 * are Bluetooth-only: placing a call from the desktop is not much use if you
 * then have to pick the phone up to speak into it.
 */
export async function requestCall({ op, id = null, number = null, value = null } = {}) {
  const action = String(op || '').toLowerCase()
  const VERBS = ['answer', 'reject', 'hangup', 'dial', 'tones', 'audio', 'connect', 'disconnect', 'bond', 'auto', 'handset', 'ringtone', 'timer']
  if (!VERBS.includes(action)) throw new Error(`unknown call action: ${op}`)

  /**
   * When the link is held open, and to which handset.
   *
   * Both are written through the daemon rather than into the file behind its
   * back, because a policy the running process has not heard about is a
   * setting that appears to have done nothing.
   */
  if (action === 'auto' || action === 'handset') {
    const cfg = loadConfig()
    const settings = { autoConnect: 'ring', address: null, ...(cfg.handsfree || {}) }

    if (action === 'auto') {
      const policy = String(value || '').toLowerCase()
      if (!['presence', 'ring', 'off'].includes(policy)) {
        throw new Error('the link policy is one of presence, ring or off')
      }
      settings.autoConnect = policy
    } else {
      const address = !value || value === 'auto' ? null : String(value).toUpperCase()
      if (address && !/^([0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(address)) {
        throw new Error('a handset is named by its Bluetooth address, or "auto" to let the desktop guess')
      }
      settings.address = address
    }

    cfg.handsfree = settings
    saveConfig(cfg)
    handsfree.configure(settings)
    // A policy just switched off should not leave behind the link it was
    // holding open; one just switched on should not wait for the next
    // reconnect before it acts.
    if (settings.autoConnect === 'off') await handsfree.drop().catch(() => {})
    else if (settings.autoConnect === 'presence' && appCanAct()) handsfree.presence(true)

    return { ok: true, via: 'bluetooth', bluetooth: handsfree.summary(), handsets: await handsets() }
  }

  /**
   * What a ringing phone sounds like here.
   *
   * `on` and `off` are the switch, `test` plays one pass for somebody choosing
   * between files, and anything else is taken as the path to the file — with
   * `default` handing the choice back to the desktop's sound theme.
   */
  if (action === 'ringtone') {
    const word = String(value || '').toLowerCase()
    if (word === 'test') return { ok: true, ...ringtone.once(), ringtone: ringtone.summary() }

    const cfg = loadConfig()
    const settings = { enabled: true, sound: null, ...(cfg.ringtone || {}) }
    if (word === 'on' || word === 'off') settings.enabled = word === 'on'
    else if (word === 'default') settings.sound = null
    else if (value) {
      const file = String(value)
      if (!fs.existsSync(file)) throw new Error(`${file} is not there`)
      settings.sound = file
      settings.enabled = true
    } else {
      throw new Error('the ringtone is on, off, test, default, or the path to a sound file')
    }

    cfg.ringtone = settings
    saveConfig(cfg)
    ringtone.configure(settings)
    return { ok: true, ringtone: ringtone.summary() }
  }

  /**
   * Whether a call in progress keeps a card on screen, counting.
   *
   * Switching it off mid-conversation takes the card down there and then
   * rather than at the end of the call: somebody who has just said they do not
   * want it on screen is not asking to look at it for another four minutes.
   */
  if (action === 'timer') {
    const word = String(value || '').toLowerCase()
    if (word !== 'on' && word !== 'off') throw new Error('the call timer is on or off')
    const cfg = loadConfig()
    cfg.callTimer = { ...(cfg.callTimer || {}), enabled: word === 'on' }
    saveConfig(cfg)
    talkTime.configure(cfg.callTimer)
    // Switched on with a call already up, it starts counting from now rather
    // than pretending it saw the beginning.
    if (cfg.callTimer.enabled && live?.state === 'active') {
      talkTime.start({ key: live.call || live.id, who: caller(live), at: activeSince || Date.now() })
    }
    return { ok: true, timer: talkTime.summary() }
  }

  /**
   * The bond under the link, rather than the link itself.
   *
   * `connect` needs a handset this desktop is already bonded to; this is what
   * to do when there is not one. It opens a window in which the desktop is
   * visible and looking, and comes back when a bond is made or the window
   * shuts — which is a slow answer by design, because the thing it is waiting
   * for is somebody picking their phone up.
   *
   * `bond stop` shuts the window early, for a user who changed their mind
   * rather than one who finished.
   */
  if (action === 'bond') {
    if (String(value || '').toLowerCase() === 'stop') {
      const stopped = handsfree.stopBonding()
      return { ok: true, via: 'bluetooth', stopped, bluetooth: handsfree.summary() }
    }
    const res = await handsfree.bond()
    if (!res.ok) throw new Error(res.error || 'nothing paired')
    return {
      ok: true,
      via: 'bluetooth',
      already: Boolean(res.already),
      connected: Boolean(res.connected),
      /** The link was raised to prove the bond, then put back down on purpose. */
      parked: Boolean(res.parked),
      handset: res.handset || null,
      bluetooth: handsfree.summary(),
      handsets: await handsets(),
    }
  }

  // The link itself, rather than anything travelling over it. `connect` waits
  // on the page in full: somebody who typed it is asking for exactly that.
  if (action === 'connect') {
    const up = await handsfree.ensure({ wait: 20_000, why: 'manual', force: true })
    if (!up) throw new Error(handsfree.summary().link.error || 'could not reach the handset')
    return { ok: true, via: 'bluetooth', bluetooth: handsfree.summary() }
  }
  if (action === 'disconnect') {
    await handsfree.drop({ force: true })
    return { ok: true, via: 'bluetooth', bluetooth: handsfree.summary() }
  }

  /**
   * Three of these are worth waiting on a link for and three are not.
   *
   * Answering, dialling and moving the audio all exist to put a conversation
   * on this machine's speakers, and taking the app's road instead quietly
   * fails at the only thing they were for — so they will spend a few seconds
   * on a page first. Rejecting and hanging up move no audio and are wanted
   * *now*; making somebody watch a progress-free pause before a call stops
   * ringing would be a poor trade for a road that works either way.
   */
  if (!handsfree.connected && (action === 'answer' || action === 'dial' || action === 'audio')) {
    await handsfree.ensure({ why: 'ring' }).catch(() => {})
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
  // Answering keeps the card and hands it to the timer; declining takes it off.
  const inherited = action === 'answer' ? handOver() : 0
  if (action === 'reject') silence()
  // The phone will say so itself a moment later, but the panel is looking at
  // the button that was just pressed and must not still be offering to answer
  // a call that is already up.
  if (action === 'answer' && live?.state === 'ringing') {
    live.state = 'active'
    // And the clock starts on the button, not on the phone getting round to
    // saying so — a handset that never reports `active` would otherwise be a
    // conversation the desktop never timed.
    activeSince = activeSince || Date.now()
    const took = talkTime.start({
      key: live.call || live.id,
      who: caller(live),
      replaces: inherited,
      at: activeSince,
    })
    if (inherited && !took) talkTime.close(inherited)
  }
  if (action === 'reject' || action === 'hangup') {
    live = null
    activeSince = 0
    talkTime.stop()
  }
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

  /**
   * Nothing telephonic survives a remote link.
   *
   * Not a matter of taste: the Bluetooth hands-free profile is a radio link
   * to a handset in this room, the ringing card is a call somebody here can
   * pick up, and mirroring a text message to a desktop the phone cannot see
   * is carrying private mail down a tunnel for nobody to read. The app gates
   * every telephony surface it has on `can('phone', …)`, so saying no here
   * takes the ring screen, the call controls and the hands-free panel off it
   * without a single special case on that side.
   */
  capabilities(ctx = {}) {
    if (ctx.remote) {
      return { mirror: false, send: false, history: 0, answer: false, bluetooth: false, ios: false, remote: true }
    }
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

    // On the default answer for now — a server that draws buttons — so a call
    // answered before D-Bus replies still has a way out of it.
    wireHangUp()
    readNotificationServer().catch(() => {
      /* a server that will not say who it is keeps the default answer */
    })

    janitor = setInterval(sweep, SWEEP_MS)
    janitor.unref?.()

    handsfree.on('call', (call, previous) => {
      ingest(fromHandsfree(call, previous))
    })
    // The link's own bookkeeping — whether a page is under way, whether this
    // desktop is the reason the profile is up — is what the panel's call card
    // and `call status` read, and it moves without the gateway moving.
    handsfree.on('link', () => {
      bus?.emit('event', 'phone', { action: 'bluetooth', bluetooth: handsfree.summary() })
    })
    handsfree.on('gateway', (gateway) => {
      // The link going away mid-conversation ends the conversation as far as
      // this desktop is concerned: no audio, no call, and nothing left worth
      // counting on screen.
      if (!gateway) {
        silence()
        if (talkTime.running) {
          activeSince = 0
          talkTime.stop()
        }
      }
      // The audio link opening, on the other hand, is not the phone taking the
      // ring over.
      //
      // A handset that sends its own ringing tone does it down this transport,
      // and deferring to it was the first instinct here — two ringtones at once
      // is worse than either. But the transport going `active` says only that
      // SCO is up, not that anybody can hear it: whether that stream reaches
      // the speakers is WirePlumber's routing decision, and on a desktop that
      // has not made the gateway its input it reaches nothing at all. Standing
      // down on that signal traded a ring for silence — one pass of our own
      // file, then a phone ringing in another room with nothing to show for it.
      //
      // So the ring is ours for as long as the phone is ringing, and it stops
      // where every other end of a call stops it: `silence`, on answered,
      // rejected, ended, or rung out.
      log.info(gateway ? `bluetooth: ${gateway.name || gateway.address} connected` : 'bluetooth: phone disconnected')
      bus?.emit('event', 'phone', { action: 'bluetooth', bluetooth: handsfree.summary() })
    })

    /**
     * What the link's own bedtime consults. `liveCall` is the desktop's whole
     * belief about a call in progress — the hands-free profile's view of it
     * when there is one, and the app's or the iPhone's when the handset
     * carries audio without ever saying a call exists. Without this a link
     * raised for a silent handset would be put down mid-conversation.
     */
    handsfree.busy = () => Boolean(liveCall())

    /**
     * Which handset the Bluetooth half should be reaching for.
     *
     * The two halves of this project pair separately — one over the LAN with a
     * QR code, one in Bluetooth settings — and nothing used to join them, so
     * the Bluetooth half looked at a list of bonded devices and could only ask
     * "is there exactly one that could be a phone?". On a laptop that has ever
     * been in a car, that question has no answer.
     *
     * It does not have to be asked. By the time any of this matters the
     * desktop has already been told which phone is *its* phone, by the phone
     * itself, during the pairing everybody does first — so the name goes to
     * `pick`, and the ambiguity stops being one.
     */
    handsfree.expect = () => pairedDevice()?.name ?? null

    handsfree.configure(loadConfig().handsfree)
    ringtone.configure(loadConfig().ringtone)
    talkTime.configure(loadConfig().callTimer)
    /**
     * The phone appearing on the network is what tells the link to go up, and
     * the socket closing is what tells it to come down again. Neither is
     * telephony — but this is the plugin that owns the hands-free client, so
     * this is where the server's announcement is heard.
     */
    bus.on('presence', (here) => handsfree.presence(here))

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
    talkTime.stop({ quiet: true })
    live = null
    activeSince = 0
    if (janitor) clearInterval(janitor)
    janitor = null
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
        call: liveCall(),
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
