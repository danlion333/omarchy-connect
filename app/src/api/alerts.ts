import { AppState } from 'react-native'

import type { AgentSession, AgentState } from './client'
import {
  clearAlert,
  clearAlerts,
  clearEveryAlert,
  notifyAgentDone,
  notifyAgentWaiting,
  notifyClipboard,
  notifyClipboardImage,
  notifyFile,
} from '../../modules/omarchy-link'
import { bytes } from '../lib/format'
import { mediaKind } from '../lib/media'

/**
 * When the phone is allowed to say something, and about what.
 *
 * Everything the desktop sends used to arrive silently and wait to be
 * discovered: a badge on a tab, a card further down a screen. That works for
 * somebody already holding the phone with the app open, which is the one
 * moment none of it is news. This module is the other case — the phone in a
 * pocket — and its whole job is deciding what is worth interrupting for.
 *
 * Four categories, each with its own switch and its own volume:
 *
 *   - **A waiting agent** interrupts. It is idle until a person answers, so
 *     the cost of being told late is measured in minutes of nothing happening.
 *   - **A finished agent** does not. And it only counts as news at all when
 *     the work took long enough to have been worth walking away from — every
 *     turn an agent takes ends idle, and saying so each time would be a reason
 *     to switch the feature off.
 *   - **A file** is an ordinary notification with a **Save** on it.
 *   - **The clipboard** is silent, replaces itself, and says nothing while the
 *     app is on screen, where the share card already shows it. A copied
 *     picture is the same card with the picture drawn on it and a **Save**.
 *
 * All of it is a no-op off Android, where there is no service to post from —
 * see `modules/omarchy-link`.
 */

export type AlertCategory = 'waiting' | 'done' | 'files' | 'clipboard'

export type AlertPrefs = Record<AlertCategory, boolean>

export const DEFAULT_ALERTS: AlertPrefs = { waiting: true, done: true, files: true, clipboard: true }

/**
 * How long an agent has to have been working before finishing is worth a
 * notification. Below this it is a turn in a conversation somebody is having;
 * above it, they went and did something else, which is the whole point.
 */
const WORTH_WAITING_FOR = 60_000

/**
 * How long a question has to have been *gone* before its card comes down.
 *
 * The other end of the same idea as `WORTH_WAITING_FOR`, and the answer to
 * the complaint this was built for: cards that "arrive and literally vanish
 * two seconds later". The desktop can stop saying `waiting` for a moment
 * without the question having been answered — the daemon's own tail poll runs
 * every two seconds, and a session with subagents out has other things
 * reporting under its name — and a card taken down inside that moment is a
 * notification nobody could have read, which teaches people to ignore the one
 * channel this whole screen exists for.
 *
 * So a card that is already up survives a gap this long. Two and a half of the
 * desktop's polls: longer than any flap seen on the wire, short enough that a
 * question answered at the keyboard clears off the phone about as fast as you
 * can put it down.
 */
const SETTLE_MS = 5_000

let prefs: AlertPrefs = { ...DEFAULT_ALERTS }

/** The session whose chat is open right now, if any. */
let focused: string | null = null

/**
 * Open on screen, and *being looked at*.
 *
 * A chat screen stays mounted while the phone is in a pocket, so `focused`
 * alone says "this news has already reached its audience" about a phone that
 * is face-down on a table. That is precisely the case a finished-agent
 * notification exists for: you read a little, put the phone away, and the
 * agent worked on. So the suppression only holds while the app is actually
 * in front of somebody.
 */
const reading = (id: string) => focused === id && AppState.currentState === 'active'

/**
 * What each waiting session was last announced as. The value is the prompt, so
 * a reworded question can be told apart from the same one arriving twice.
 */
const announced = new Map<string, string>()

/** The state each session was last seen in, and when it started working. */
const seen = new Map<string, AgentState>()
const workingSince = new Map<string, number>()

/** Sessions with a "finished" card on screen, so it can be taken down again. */
const finished = new Set<string>()

/**
 * Announced sessions that have stopped saying `waiting`, and when they stopped.
 *
 * A card is not taken down the instant the list disagrees with it; it is taken
 * down when the list has disagreed with it for `SETTLE_MS`. See there.
 */
const settling = new Map<string, number>()

/** The last list seen, so the settle can be re-run without one arriving. */
let latest: AgentSession[] = []
let settleTimer: ReturnType<typeof setTimeout> | null = null

/**
 * Come back to the last list once the shortest hold has run out.
 *
 * Nothing else would: the list is pushed, and a desktop whose agent went quiet
 * pushes nothing. Without this the held card would hang on the shade until the
 * next thing happened to that session, which for an agent that finished is
 * never.
 */
function armSettle() {
  if (settleTimer) return
  settleTimer = setTimeout(() => {
    settleTimer = null
    syncAgentAlerts(latest)
  }, SETTLE_MS)
}

/**
 * Coming back to a chat that was left open is reading it again, and whatever
 * the shade raised about that session while the phone was away has been seen
 * by the act of returning to it.
 */
AppState.addEventListener('change', (state) => {
  if (state !== 'active' || !focused) return
  clearAlert('agent', focused)
  clearAlert('done', focused)
  finished.delete(focused)
})

export function setAlertPrefs(next: AlertPrefs) {
  const before = prefs
  prefs = next
  if (before.waiting && !next.waiting) {
    announced.clear()
    settling.clear()
    clearAlerts('agent')
  }
  if (before.done && !next.done) {
    finished.clear()
    clearAlerts('done')
  }
  if (before.files && !next.files) clearAlerts('file')
  if (before.clipboard && !next.clipboard) clearAlerts('clip')
}

export function alertPrefs(): AlertPrefs {
  return prefs
}

/**
 * Called by the chat screen. A session being read is a session whose news has
 * already reached its audience, so its cards go and no new one is raised while
 * it stays open.
 */
export function focusAgent(id: string | null) {
  focused = id
  if (!id) return
  clearAlert('agent', id)
  clearAlert('done', id)
  finished.delete(id)
  settling.delete(id)
  // Remembered as announced rather than forgotten: leaving the chat with the
  // agent still waiting should not fire an alert for a question just read.
  if (!announced.has(id)) announced.set(id, '')
}

/** Everything this module has put on screen, gone. */
export function resetAlerts() {
  announced.clear()
  seen.clear()
  workingSince.clear()
  finished.clear()
  settling.clear()
  latest = []
  if (settleTimer) clearTimeout(settleTimer)
  settleTimer = null
  clearEveryAlert()
}

/**
 * Brings the shade in line with the session list.
 *
 * Driven by the list rather than by individual events on purpose: `agents.list`
 * after a reconnect is as good a source of truth as an `ev:agent` frame, and a
 * question answered on the desktop while the phone was offline has to take its
 * notification with it.
 */
export function syncAgentAlerts(sessions: AgentSession[]) {
  const now = Date.now()
  const present = new Set(sessions.map((s) => s.id))
  latest = sessions

  /* ── an agent that finished ───────────────────────────────────────── */

  for (const session of sessions) {
    const before = seen.get(session.id)
    seen.set(session.id, session.state)

    if (session.state === 'working') {
      // Timed from the first sight of it working rather than from the
      // session's own clock: the phone may have been asleep for most of it,
      // and what is being measured is how long the answer has been wanted.
      if (!workingSince.has(session.id)) workingSince.set(session.id, now)
    }

    // Anything that is not idle takes down a card saying it finished.
    if (session.state !== 'idle' && finished.delete(session.id)) clearAlert('done', session.id)

    if (!prefs.done) continue
    if (before !== 'working' || session.state !== 'idle') continue
    const started = workingSince.get(session.id)
    workingSince.delete(session.id)
    if (started === undefined || now - started < WORTH_WAITING_FOR) continue
    if (reading(session.id)) continue
    finished.add(session.id)
    notifyAgentDone({
      id: session.id,
      agent: session.agent,
      title: session.title,
      // A background agent is the one this notification was really built for —
      // you sent it off and put the phone away — and the sentence it wrote
      // about the work beats the last line of its transcript.
      preview: (session.job?.detail || session.preview || '').trim(),
    })
  }

  for (const id of [...seen.keys()]) {
    if (present.has(id)) continue
    seen.delete(id)
    workingSince.delete(id)
    if (finished.delete(id)) clearAlert('done', id)
  }

  /* ── an agent that stopped to ask ─────────────────────────────────── */

  if (!prefs.waiting) return

  const waiting = new Map(sessions.filter((s) => s.state === 'waiting').map((s) => [s.id, s]))

  for (const id of [...announced.keys()]) {
    if (waiting.has(id)) {
      // Asking again inside the hold is the same question still standing, not
      // a new one: the card stays exactly where it was, and `announced` still
      // holds the prompt, so nothing buzzes a second time for it.
      settling.delete(id)
      continue
    }
    // A session that has left the list altogether cannot be answered from
    // here, so its card goes at once. Everything still on the list gets the
    // hold: it may simply be a desktop that said `working` for a moment.
    if (present.has(id)) {
      const since = settling.get(id) ?? now
      settling.set(id, since)
      if (now - since < SETTLE_MS) {
        armSettle()
        continue
      }
    }
    settling.delete(id)
    clearAlert('agent', id)
    announced.delete(id)
  }

  for (const [id, session] of waiting) {
    const prompt = promptOf(session)
    const before = announced.get(id)
    if (before === prompt) continue
    announced.set(id, prompt)
    if (reading(id)) continue
    notifyAgentWaiting({
      id,
      agent: session.agent,
      title: session.title,
      prompt,
      // A session the desktop cannot type into gets no reply box: a text field
      // that silently goes nowhere is worse than none at all.
      canReply: session.writable !== null,
      // First time is the buzz; a reworded question under an agent already
      // waiting is a correction, and corrections are silent.
      alert: before === undefined,
    })
  }
}

/**
 * A file the desktop is offering this phone.
 *
 * The **Save** button belongs only on something the gallery can hold. For
 * anything else the notification is a tap through to the share screen, where
 * choosing what to do with it is a conversation rather than a button.
 */
export function alertFile(offer: { token: string; name: string; size: number }) {
  if (!prefs.files) return
  const kind = mediaKind(offer.name)
  notifyFile({
    token: offer.token,
    name: offer.name,
    size: bytes(offer.size),
    saveable: kind === 'image' || kind === 'video',
  })
}

export function clearFileAlert(token: string) {
  clearAlert('file', token)
}

/**
 * Whatever the desktop just copied.
 *
 * Silent, and suppressed while the app is on screen: the share card is already
 * showing the same text a scroll away, and a notification for something
 * visible is noise. Off screen it is the opposite — one tap on **Copy** and
 * the text is in this phone's paste buffer without the app being opened.
 */
export function alertClipboard(text: string) {
  if (!prefs.clipboard) return
  if (!text.trim()) return
  if (onScreen()) return
  notifyClipboard(text)
}

/** Whether somebody is looking at the app right now. */
const onScreen = () => AppState.currentState === 'active'

/**
 * How large a copied picture may be before the notification stops trying to
 * draw it.
 *
 * The preview is not free: it is the whole file over the same download road
 * `saveOffer` uses, fetched *before* anything can be shown, and the desktop
 * will carry up to 32 MiB. A screenshot — the thing this feature exists for —
 * is a fraction of this, so the limit only bites on the copy that was never
 * going to be a useful thumbnail anyway, and that one still gets its card.
 */
const PREVIEW_LIMIT = 8 * 1024 * 1024

/**
 * A picture the desktop copied.
 *
 * The same silent, self-replacing card as the text above — same channel, same
 * key — because it is the same clipboard; copying a screenshot and then a URL
 * must leave one line in the shade, not two. What differs is what it can
 * offer: the bytes are a standing file offer rather than something the shade
 * could paste, so the button is **Save**, and the preview has to be fetched
 * before the notification exists at all.
 *
 * `fetchPreview` is passed in rather than done here because the download needs
 * the socket's ticket, which lives with the link. It is allowed to fail or to
 * answer `null`: a card with no picture on it still says the desktop copied
 * something, which is the news, and is far better than silence.
 */
export async function alertClipboardImage(
  picture: { token: string; name: string; size?: number },
  fetchPreview: () => Promise<string | null>,
) {
  if (!prefs.clipboard) return
  if (onScreen()) return
  let path: string | null = null
  try {
    if ((picture.size ?? 0) <= PREVIEW_LIMIT) path = await fetchPreview()
  } catch {
    /* the offer expired, the desktop went away, the disk said no */
  }
  // Checked again on the way out: fetching the bytes takes as long as it
  // takes, and a phone picked up in the meantime is showing the share card
  // with this very picture on it.
  if (!prefs.clipboard) return
  if (onScreen()) return
  notifyClipboardImage({ token: picture.token, name: picture.name, path })
}

function promptOf(session: AgentSession) {
  return (session.prompt || '').trim() || (session.preview || '').trim() || 'waiting for an answer'
}
