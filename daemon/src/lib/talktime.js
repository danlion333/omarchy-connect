import { has, spawn, spawnDetached, notifyArgs } from './exec.js'

/**
 * The card that stays on screen while you are talking.
 *
 * Answering from the desktop leaves you with no phone in your hand, and a
 * conversation with nothing on screen behind it is a conversation with no
 * clock: the handset's own call timer is the thing you gave up when you
 * stopped holding the handset. The panel says "in progress" and says it only
 * while the panel is open, which is not where anybody is looking three minutes
 * into a call.
 *
 * So a call that is picked up keeps a notification up for as long as it lasts,
 * counting. And the one decision left in a conversation is when to leave it, so
 * the card carries that too: a **Hang up** button where the server draws
 * buttons, and where it draws none, the gesture the ringing card already uses
 * — the right mouse button, which reaches this side as the card being closed
 * by hand. Somebody who has just swept a call off their screen has finished
 * with it; leaving the line open and only stopping the clock was the desktop
 * agreeing to be quiet about a call it could have ended.
 *
 * Two habits of the notification server are what make this work at all.
 * `notify-send -p` prints the id the server gave the card, and `-r` rewrites
 * the card with that id in place rather than stacking a second one under it —
 * the same pair a ringing call already uses to turn "unknown number" into a
 * name. So the tick is one short-lived `notify-send` a second, each one
 * replacing the last, and the card the user sees never moves.
 *
 * The ringing card is handed over rather than replaced: the id that was
 * "Incoming call · Ярина" becomes the id that counts, which is why answering
 * looks like one notification changing its mind rather than two notifications
 * taking turns.
 *
 * And a card that lives for the length of a conversation is a card somebody
 * will eventually swipe away, so `-w` holds one process open on it for as long
 * as the server says it is there. A rewrite is not a closure and that process
 * survives it; a swipe is, and the tick stops on the spot. Without that the
 * next second would put the card straight back — a server asked to replace an
 * id it no longer knows raises a fresh card — and the only way out of a
 * notification would be to end the call.
 */

/** A call is measured in seconds, so the card is rewritten every second. */
const TICK_MS = 1000
/** How long the closing card — the one with the total on it — stays up. */
const FAREWELL_MS = 8000

/** `72` → `01:12`, `3782` → `1:03:02`. The handset's own arithmetic. */
export function clock(seconds) {
  const whole = Math.max(0, Math.floor(seconds))
  const s = whole % 60
  const m = Math.floor(whole / 60) % 60
  const h = Math.floor(whole / 3600)
  const pad = (n) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`
}

/** The same span, in the words a line of history uses. */
export function spoken(seconds) {
  const whole = Math.max(0, Math.round(seconds))
  if (whole < 60) return `${whole}s`
  const m = Math.floor(whole / 60)
  const s = whole % 60
  if (m < 60) return s ? `${m}m ${s}s` : `${m}m`
  const h = Math.floor(m / 60)
  return `${h}h ${m % 60}m`
}

export class TalkTime {
  constructor() {
    this.enabled = true
    /** When the call was picked up, or 0 when nobody is talking. */
    this.since = 0
    /** Who is on the other end, for the card's title. */
    this.who = ''
    /** The call this is counting, so one report does not restart another. */
    this.key = ''
    /** The server's id for the card, once it has told us what it is. */
    this.id = 0
    this.timer = null
    /**
     * The `notify-send` holding the card open.
     *
     * `-w` keeps it alive until the server says the notification is gone, and
     * a replacement is not gone — a card rewritten every second is still the
     * same card, and the same process is still waiting on it. So this one
     * process outliving the ticks is what tells the difference between a card
     * being counted on and a card somebody swiped away.
     */
    this.child = null
    /** Swiped away. The call carries on; the desktop stops insisting. */
    this.dismissed = false
    /** Who to tell that the person watching this card is done talking. */
    this.onHangup = null
    /**
     * Whether this notification server draws the buttons it is offered.
     *
     * It decides which gesture ends the call. Where there are buttons, the
     * button does it and a sweep stays a sweep — a server that draws Hang up
     * has said what a card is for. Where there are none, the sweep is the only
     * gesture there is besides the click, and the click is left alone: a card
     * that hangs up when it is touched is a card nobody dares touch.
     */
    this.buttons = true
  }

  /**
   * Who ends the call, and whether this server can draw a button for it.
   *
   * Kept off `configure` on purpose: that one carries the user's switch, which
   * comes and goes with the config file, while this is the wiring the plugin
   * puts in once at startup and never changes.
   */
  answers({ hangup = null, buttons = true } = {}) {
    this.onHangup = typeof hangup === 'function' ? hangup : null
    this.buttons = buttons !== false
  }

  configure({ enabled = true } = {}) {
    this.enabled = enabled !== false
    if (!this.enabled) this.stop({ quiet: true })
    return this.summary()
  }

  get running() {
    return this.since > 0
  }

  get seconds() {
    return this.running ? (Date.now() - this.since) / 1000 : 0
  }

  /**
   * Start counting, and put the first card up.
   *
   * `key` is the call, so the second report of a conversation already in
   * progress — the same call announced down a second road, or a name arriving
   * after the number — leaves the clock where it is instead of setting it back
   * to zero. `replaces` is the ringing card's id, when there was one.
   *
   * `at` is the one thing a second report is allowed to change. The desktop
   * starts counting when it is told a call is up, which on a call the handset
   * placed is a whole ring cycle too early; the handset's own start arrives
   * afterwards, off its notification, and the card has to be able to take it
   * mid-count rather than carry the error to the end of the conversation.
   * Omitted, it means "wherever the clock is now" — only a caller with an
   * answer moves it.
   */
  start({ key = '', who = 'unknown number', replaces = 0, at = 0 } = {}) {
    if (!this.enabled) return false
    const start = Number.isFinite(at) && at > 0 ? at : 0
    if (this.running) {
      // Same conversation: keep the clock, take whatever it has learned since.
      if (!key || !this.key || key === this.key) {
        const moved = start > 0 && start !== this.since
        if (moved) this.since = start
        const renamed = Boolean(who) && who !== this.who
        if (renamed) this.who = who
        if (moved || renamed) this.paint()
        return false
      }
      // A different call entirely — the first one is over whether or not
      // anybody said so.
      this.stop({ quiet: true })
    }
    this.since = start || Date.now()
    this.who = who
    this.key = key
    this.id = replaces || 0
    this.dismissed = false
    if (!has('notify-send')) return false
    this.paint({ first: true })
    this.timer = setInterval(() => this.paint(), TICK_MS)
    this.timer.unref?.()
    return true
  }

  /**
   * One rewrite of the card.
   *
   * The first one asks for three things the rest do not need: the id, which is
   * the `-p`, the news that the card is gone, which is the `-w`, and the way
   * out of the conversation, which is the `-A`. Every tick after it is
   * detached — a card that already has an id and a watcher needs no answer
   * back from the server, and a rewrite keeps the actions the card was raised
   * with.
   */
  paint({ first = false } = {}) {
    if (!this.running || this.dismissed || !has('notify-send')) return
    const flags = [
      '-a', 'Omarchy Connect',
      // Below a message and well below a ringing phone. This card interrupts
      // nobody: whoever is reading it is already in the conversation it is
      // about.
      '-u', 'low',
      // It lives exactly as long as the call does, and is taken down by hand.
      '-t', '0',
    ]
    if (this.id) flags.push('-r', String(this.id))
    // Where no button will be drawn, the gesture is spelled out beside the
    // clock — the same courtesy the ringing card pays, and for the same
    // reason: an undrawn button nobody is told about is not a way out.
    const gesture = !this.buttons && this.onHangup ? ' · right-click to hang up' : ''
    // `who` is a name out of the handset's address book, so the card's text is
    // fenced off from the flags above it.
    const args = notifyArgs(flags, `On call · ${this.who}`, `${clock(this.seconds)}${gesture}`)
    if (!first) {
      spawnDetached('notify-send', args)
      return
    }
    // No `default`: a click is how a card is read, and hanging up on one is
    // how somebody loses a call to a stray mouse. Only the named button, and
    // only where a button will be drawn.
    const hangup = this.buttons && this.onHangup ? ['-A', 'hangup=Hang up'] : []
    const child = spawn('notify-send', ['-p', '-w', ...hangup, ...args], { stdio: ['ignore', 'pipe', 'ignore'] })
    child.on('error', () => {
      if (this.child === child) this.child = null
    })
    child.stdout.setEncoding('utf8')
    let printed = ''
    child.stdout.on('data', (chunk) => {
      printed += chunk
      if (this.child !== child || this.id) return
      const line = printed.split('\n', 1)[0].trim()
      if (/^\d+$/.test(line)) this.id = Number(line)
    })
    /**
     * The card is off the screen and this process was not the one that took it
     * off. Two ways that happens, and they are told apart by whether an action
     * was printed on the way out.
     *
     * The button was pressed: end the call, and let the closing card say how
     * long it was — somebody who pressed Hang up is still reading.
     *
     * Nothing was printed, so the card was closed by hand. On a server that
     * draws buttons that is a sweep and means only "stop showing me this": a
     * rewrite a second later would put the card straight back — servers raise
     * a fresh card for an id they no longer know — which is the whole reason
     * this waits rather than firing and forgetting. On a server that draws
     * none, the same gesture is the right mouse button on the only card there
     * is, and it means the same thing the button does. Either way the clock
     * keeps its own time for the panel; only the insisting stops.
     */
    child.on('exit', () => {
      if (this.child !== child) return
      this.child = null
      const pressed = printed.split('\n').map((line) => line.trim()).includes('hangup')
      const ending = pressed || (!this.buttons && Boolean(this.onHangup))
      // A card somebody swept away stays away — the total is not worth raising
      // a fresh one they did not ask for. A button press is a conversation
      // with the card, and gets its farewell.
      this.dismissed = !pressed
      this.id = 0
      if (this.timer) clearInterval(this.timer)
      this.timer = null
      if (!ending) return
      try {
        Promise.resolve(this.onHangup()).catch(() => {})
      } catch {
        /* the call was already over */
      }
    })
    this.child = child
  }

  /**
   * The call is over.
   *
   * The card does not simply vanish: the last thing it says is how long the
   * conversation was, which is the number somebody reaches for a minute later
   * and would otherwise have to go into the phone to find. `quiet` is for the
   * cases where nobody was really talking — one call displacing another, a
   * timer switched off mid-conversation — and takes the card off outright.
   */
  stop({ quiet = false } = {}) {
    if (!this.running) return null
    const seconds = this.seconds
    const who = this.who
    const id = this.id
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.since = 0
    this.who = ''
    this.key = ''
    this.id = 0
    const swiped = this.dismissed
    this.dismissed = false
    const child = this.child
    this.child = null
    if (child) {
      try {
        child.kill()
      } catch {
        /* already gone */
      }
    }
    if (!has('notify-send')) return { seconds, who }
    // A card somebody swiped away is not owed a farewell: they said what they
    // wanted about being told, and the call ending does not reopen it.
    if (swiped) return { seconds, who }
    if (quiet || seconds < 1) {
      this.close(id)
      return { seconds, who }
    }
    const flags = ['-a', 'Omarchy Connect', '-u', 'low', '-t', String(FAREWELL_MS)]
    if (id) flags.push('-r', String(id))
    const args = notifyArgs(flags, `Call ended · ${who}`, `lasted ${spoken(seconds)}`)
    spawnDetached('notify-send', args)
    return { seconds, who }
  }

  /**
   * Take a card off the screen outright.
   *
   * A card with no timeout outlives the process that raised it, so killing
   * `notify-send` is not enough — the server owns it, and the server is the
   * one that has to be asked.
   */
  close(id) {
    if (!id || !has('gdbus')) return
    spawnDetached('gdbus', [
      'call', '--session',
      '--dest', 'org.freedesktop.Notifications',
      '--object-path', '/org/freedesktop/Notifications',
      '--method', 'org.freedesktop.Notifications.CloseNotification',
      String(id),
    ])
  }

  summary() {
    return {
      enabled: this.enabled,
      running: this.running,
      since: this.since || null,
      seconds: this.running ? Math.floor(this.seconds) : 0,
      who: this.who || null,
    }
  }
}

export const talkTime = new TalkTime()
export { TICK_MS, FAREWELL_MS }
