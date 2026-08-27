import { has, spawn, spawnDetached } from './exec.js'

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
 * counting. It is a readout and nothing more — the ringing card is the one
 * worth putting buttons on, and by the time this one appears the decision it
 * would offer has already been made.
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
   */
  start({ key = '', who = 'unknown number', replaces = 0, at = Date.now() } = {}) {
    if (!this.enabled) return false
    if (this.running) {
      // Same conversation: keep the clock, take whatever it has learned since.
      if (!key || !this.key || key === this.key) {
        if (who && who !== this.who) {
          this.who = who
          this.paint()
        }
        return false
      }
      // A different call entirely — the first one is over whether or not
      // anybody said so.
      this.stop({ quiet: true })
    }
    this.since = Number.isFinite(at) ? at : Date.now()
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
   * The first one asks for two things the rest do not need: the id, which is
   * the `-p`, and the news that the card is gone, which is the `-w`. Every
   * tick after it is detached — a card that already has an id and a watcher
   * needs no answer back from the server.
   */
  paint({ first = false } = {}) {
    if (!this.running || this.dismissed || !has('notify-send')) return
    const args = [
      '-a', 'Omarchy Connect',
      // Below a message and well below a ringing phone. This card interrupts
      // nobody: whoever is reading it is already in the conversation it is
      // about.
      '-u', 'low',
      // It lives exactly as long as the call does, and is taken down by hand.
      '-t', '0',
    ]
    if (this.id) args.push('-r', String(this.id))
    args.push(`On call · ${this.who}`, clock(this.seconds))
    if (!first) {
      spawnDetached('notify-send', args)
      return
    }
    const child = spawn('notify-send', ['-p', '-w', ...args], { stdio: ['ignore', 'pipe', 'ignore'] })
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
     * off, so somebody swiped it away. A rewrite a second later would put it
     * straight back — servers raise a fresh card for an id they no longer know
     * — which is the whole reason this waits rather than firing and forgetting.
     * The clock keeps its own time for the panel; only the insisting stops.
     */
    child.on('exit', () => {
      if (this.child !== child) return
      this.child = null
      this.dismissed = true
      this.id = 0
      if (this.timer) clearInterval(this.timer)
      this.timer = null
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
    const args = ['-a', 'Omarchy Connect', '-u', 'low', '-t', String(FAREWELL_MS)]
    if (id) args.push('-r', String(id))
    args.push(`Call ended · ${who}`, `lasted ${spoken(seconds)}`)
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
