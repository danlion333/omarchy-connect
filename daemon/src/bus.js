import { EventEmitter } from 'node:events'

/**
 * Fan-out hub between plugins and connected phones. Plugins emit
 * `('event', name, data)`; the server decides who wants it. Subscriber counts
 * let expensive producers (the stats tick) stay idle while nobody is looking.
 */
export class Bus extends EventEmitter {
  constructor() {
    super()
    this.setMaxListeners(50)
    this.counts = new Map()
  }

  subscribe(events) {
    for (const e of events) this.counts.set(e, (this.counts.get(e) || 0) + 1)
  }

  unsubscribe(events) {
    for (const e of events) {
      const next = (this.counts.get(e) || 0) - 1
      if (next > 0) this.counts.set(e, next)
      else this.counts.delete(e)
    }
  }

  hasSubscribers(event) {
    return (this.counts.get(event) || 0) > 0
  }
}
