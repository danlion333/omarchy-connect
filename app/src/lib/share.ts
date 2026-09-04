/**
 * What to do with something another app handed us.
 *
 * Android's share sheet delivers an `ACTION_SEND` — a link from a browser, a
 * photo from the gallery, a PDF from a mail client — and `ACTION_SEND_MULTIPLE`
 * for a selection of them. By the time it reaches here the native side has
 * already copied every stream into this app's cache, so a payload is nothing
 * but strings: a piece of text, and a list of files sitting on disk.
 *
 * The rules of what happens next are the whole of this file, deliberately kept
 * away from the screen that renders them. Sharing is the one path in the app
 * where the user is not watching — they tapped "Omarchy Connect" in somebody
 * else's app and expect it to have worked — so "did every file actually go"
 * has to be answerable by a test rather than by a person with a phone.
 */

/** One file the sharing app handed over, already copied into our own cache. */
import { errorLine } from './errors.ts'

export type SharedFile = { uri: string; name: string; size?: number }

/**
 * A share as it arrives.
 *
 * `dropped` is the count of streams the native side was handed and could not
 * read — a revoked permission, a provider that died mid-copy. It is carried
 * all the way to the user rather than swallowed, because a share sheet that
 * loses one of five photos in silence is worse than one that refuses.
 */
export type SharePayload = { text?: string | null; files: SharedFile[]; dropped?: number }

/** What one item's delivery came to. */
export type ShareFailure = { label: string; error: string }

export type ShareOutcome = {
  /** What went, named the way the user would name it. */
  sent: string[]
  failed: ShareFailure[]
}

/** The three things a delivery needs, so a test can stand in for all of them. */
export type ShareSinks = {
  /** `system.openUrl` on the desktop. */
  openUrl: (url: string) => Promise<unknown>
  /** `share.text` with `action: clipboard`. */
  copyText: (text: string) => Promise<unknown>
  /** A POST to `/api/upload`. */
  upload: (file: SharedFile) => Promise<unknown>
}

/** A link is opened on the desktop; anything else is text to be pasted. */
export const isLink = (text: string) => /^https?:\/\/\S+$/i.test(text.trim())

/** Whether there is anything in this payload at all. */
export const isEmptyShare = (payload: SharePayload) =>
  !payload.files.length && !(payload.text || '').trim() && !payload.dropped

/**
 * Why a share cannot go right now, or `null` when it can.
 *
 * Two different problems wearing the same face: no desktop has ever been
 * paired, and a paired desktop that is not answering. The first is a setup
 * step, the second is a wait, and telling somebody the wrong one of those
 * sends them to the wrong screen.
 */
export function shareBlocked(state: { paired: boolean; connected: boolean }): string | null {
  if (!state.paired) return 'no desktop is paired yet — pair one and share again'
  if (!state.connected) return 'the desktop is not reachable — nothing was sent'
  return null
}

/**
 * Hand the payload over, item by item, and come back with what happened.
 *
 * Every item is attempted even after one of them throws. That is the entire
 * point on the multi-share path: five photos where the third has been deleted
 * out from under the picker should deliver four and name the one that failed,
 * not stop at the third and leave two files nobody knows were lost.
 *
 * Text arriving alongside files is sent as well rather than discarded. Some
 * apps attach a caption to a picture, and dropping it would be exactly the
 * silent loss this is written to avoid; it shows up in the summary either way.
 *
 * A link does both things: it lands on the desktop clipboard like any other
 * text, and then it is opened. The clipboard is the delivery — it is what is
 * still there in ten minutes, whatever the browser did with the tab — so a
 * desktop with nothing willing to open a URL has still received the link.
 */
export async function deliverShare(payload: SharePayload, sinks: ShareSinks): Promise<ShareOutcome> {
  const sent: string[] = []
  const failed: ShareFailure[] = []

  for (const file of payload.files) {
    try {
      await sinks.upload(file)
      sent.push(file.name)
    } catch (err) {
      failed.push({ label: file.name, error: errorLine(err, 'upload failed') })
    }
  }

  const text = (payload.text || '').trim()
  if (text) {
    const link = isLink(text)
    try {
      await sinks.copyText(text)
      sent.push(link ? 'the link' : 'the text')
    } catch (err) {
      failed.push({ label: link ? 'the link' : 'the text', error: errorLine(err, 'send failed') })
    }
    if (link) {
      try {
        await sinks.openUrl(text)
      } catch (err) {
        failed.push({ label: 'opening the link', error: errorLine(err, 'the desktop would not open it') })
      }
    }
  }

  // Streams the native side never managed to read are failures too — they were
  // in the share and they did not arrive.
  for (let i = 0; i < (payload.dropped || 0); i += 1) {
    failed.push({ label: 'one attachment', error: 'the sharing app would not hand it over' })
  }

  return { sent, failed }
}

/** How the delivery reads on the Share screen, in one line. */
export function shareSummary(outcome: ShareOutcome): string {
  const { sent, failed } = outcome
  const went = sent.length === 1 ? `sent ${sent[0]}` : sent.length ? `sent ${sent.length} items` : ''
  if (!failed.length) return went || 'nothing to send'
  const lost = failed.map((entry) => entry.label).join(', ')
  return went ? `${went} — ${lost} did not go` : `${lost} did not go: ${failed[0].error}`
}

/**
 * What arrived, in the words the card above it uses.
 *
 * Named for the person looking at a phone that has just been handed something
 * by another app: "3 files" and "a link" are what they shared a second ago,
 * and recognising it is how they know the right thing is about to be sent.
 */
export function describeShare(payload: SharePayload): string {
  const parts: string[] = []
  if (payload.files.length === 1) parts.push(payload.files[0].name)
  else if (payload.files.length) parts.push(`${payload.files.length} files`)
  const text = (payload.text || '').trim()
  if (text) parts.push(isLink(text) ? 'a link' : 'some text')
  if (payload.dropped) parts.push(`${payload.dropped} unreadable`)
  return parts.join(' · ') || 'nothing'
}
