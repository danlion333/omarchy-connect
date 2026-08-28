import { AppState } from 'react-native'

import type { AgentSession, AgentState } from './client'
import {
  clearAlert,
  clearAlerts,
  clearEveryAlert,
  notifyAgentDone,
  notifyAgentWaiting,
  notifyClipboard,
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
 *     app is on screen, where the share card already shows it.
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

let prefs: AlertPrefs = { ...DEFAULT_ALERTS }

/** The session whose chat is open right now, if any. */
let focused: string | null = null

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

export function setAlertPrefs(next: AlertPrefs) {
  const before = prefs
  prefs = next
  if (before.waiting && !next.waiting) {
    announced.clear()
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
    if (session.id === focused) continue
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
    if (waiting.has(id)) continue
    clearAlert('agent', id)
    announced.delete(id)
  }

  for (const [id, session] of waiting) {
    const prompt = promptOf(session)
    const before = announced.get(id)
    if (before === prompt) continue
    announced.set(id, prompt)
    if (id === focused) continue
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
  if (AppState.currentState === 'active') return
  notifyClipboard(text)
}

function promptOf(session: AgentSession) {
  return (session.prompt || '').trim() || (session.preview || '').trim() || 'waiting for an answer'
}
