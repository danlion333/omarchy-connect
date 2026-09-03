/**
 * The events waiting to be told to the desktop, and the rules for waiting.
 *
 * Two stores hold a mirrored message on its way out of the phone: the native
 * `Backlog`, written by a broadcast receiver in a process with no JavaScript
 * in it, and this one, which is what the running app is holding between one
 * `phone.report` and the next. The native one has always been bounded at 200
 * entries; this one was not bounded at all, which meant a phone that stayed
 * connected to a desktop that never took its events grew a list of SMS bodies
 * in memory until something gave.
 *
 * So the same bound lives here, with the same policy — drop the oldest, because
 * an event that has been undelivered the longest is the one whose moment has
 * most thoroughly passed — and the queue is the one place that policy is
 * written down for both halves.
 *
 * Kept apart from `api/phone` so it can be read by a test: everything in that
 * file reaches a native module the moment it is imported, and none of this
 * needs one.
 */

/** The same bound the native `Backlog` keeps. Both must say the same number. */
export const MIRROR_QUEUE_LIMIT = 200

export class MirrorQueue<T> {
  private items: T[] = []
  /** How many events this queue has thrown away for want of room, ever. */
  dropped = 0

  readonly limit: number

  constructor(limit: number = MIRROR_QUEUE_LIMIT) {
    this.limit = limit
  }

  get size(): number {
    return this.items.length
  }

  /** Newest at the back, and the front is what goes when there is no room. */
  add(...events: T[]): void {
    this.items.push(...events)
    this.trim()
  }

  /**
   * The next batch to send, taken out of the queue.
   *
   * Taken rather than copied, so that an event cannot be sent twice by a flush
   * that overlaps itself; `putBack` is how it returns when the send failed.
   */
  take(count: number): T[] {
    return this.items.splice(0, count)
  }

  /**
   * A batch the desktop did not take, returned to the head of the queue.
   *
   * At the head, because these are older than everything still queued and the
   * desktop should see them in the order the phone saw them.
   */
  putBack(events: T[]): void {
    this.items.unshift(...events)
    this.trim()
  }

  /** What is queued, for a caller that wants to look without taking. */
  peek(): readonly T[] {
    return this.items
  }

  private trim(): void {
    if (this.items.length <= this.limit) return
    const over = this.items.length - this.limit
    this.items.splice(0, over)
    this.dropped += over
  }
}

/**
 * Whether the desktop on the other end has said it will take mirrored events.
 *
 * The answer is no for a desktop too old to have `phone.report`, and no for a
 * link the desktop classed as `remote`, where telephony is refused on purpose.
 * Either way the phone must keep what it has where it is: the native backlog
 * survives the process being killed and a JavaScript array does not, so
 * draining one into the other for a desktop that will never take them is how
 * an overnight message disappears for good.
 */
export function mirrorAccepted(hello: unknown): boolean {
  const phone = (hello as { capabilities?: { phone?: { mirror?: unknown } } } | null | undefined)?.capabilities?.phone
  return phone?.mirror === true
}
