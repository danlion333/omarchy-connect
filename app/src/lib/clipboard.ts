/**
 * What the phone remembers of the desktop's clipboard.
 *
 * The link used to keep exactly one clipboard event, because that is all the
 * Share screen showed: a card saying what the desktop has copied *now*. But a
 * clipboard is the one thing on a desktop that is overwritten by accident all
 * day long — you copy a URL, then a word out of a sentence, and the URL is
 * gone from both machines. Keeping the last twenty makes the same card useful
 * a few minutes later, which is the whole difference between an indicator and
 * a clipboard manager.
 *
 * Pure and away from the socket for the same reason `reduceAgents` is: the
 * rule for what the history holds is worth reading — and testing — without a
 * daemon at the other end of it.
 */
import type { ClipboardEvent } from '../api/link'

/**
 * How many copies are kept.
 *
 * Twenty, the top of the range the issue allowed, because an entry costs a
 * string the desktop already sent and nothing else, and because the value of
 * a history is entirely in reaching back past the thing you just overwrote.
 */
export const MAX_CLIPBOARD_EVENTS = 20

/**
 * The history with the event at its head, newest first.
 *
 * Text the history already holds is *moved* rather than added again. The
 * daemon's watcher only announces a change, so a repeat here means the user
 * deliberately copied something they had copied before — and two identical
 * rows would be two ways to do one thing, pushing something they cannot get
 * back any more off the end of the buffer.
 *
 * A copied picture carries no text at all, so what identifies it is its offer
 * token — the desktop hands the same token back for the same bytes. Keying on
 * `text` alone would make every picture look like every other picture and let
 * one screenshot evict the last.
 */
const identity = (event: ClipboardEvent) => event.token ?? event.text

export function remember(history: ClipboardEvent[], event: ClipboardEvent): ClipboardEvent[] {
  const key = identity(event)
  return [event, ...history.filter((old) => identity(old) !== key)].slice(0, MAX_CLIPBOARD_EVENTS)
}
