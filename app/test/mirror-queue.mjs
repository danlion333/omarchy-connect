/**
 * What the phone is holding on the desktop's behalf, and what it refuses to
 * let go of.
 *
 * A mirrored SMS is on a two-stage journey out of the phone: SharedPreferences
 * written by a broadcast receiver, then a JavaScript queue in the running app,
 * then the socket. Two of the three stages used to be able to lose it — the
 * queue was unbounded, so a desktop that never took an event let it grow
 * without end, and a `phone.report` the desktop refused threw the batch away.
 * Meanwhile the drain out of native storage happened on every `hello`,
 * including one from a desktop that had just said it does not do telephony,
 * which moved a night's messages out of the only place that survives the
 * process being killed.
 *
 * All three are decisions over plain data, so all three are tested here rather
 * than on a phone: `api/phone` reaches a native module the moment it is
 * imported, `lib/mirror-queue` does not.
 *
 * The manifest half of the same issue — Android's automatic cloud backup — is
 * checked against `app.json` at the bottom, because the generated native
 * project is not in the repository and the config is what regenerates it.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { MirrorQueue, MIRROR_QUEUE_LIMIT, mirrorAccepted } from '../src/lib/mirror-queue.ts'
import { check, done } from '../../tools/test-harness.mjs'

const appRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const event = (n) => ({ kind: 'sms', at: n, from: '+100', name: null, body: `m${n}` })

/* ── the bound ──────────────────────────────────────────────────────────── */

check(
  'the queue is bounded where the native backlog is bounded',
  MIRROR_QUEUE_LIMIT === 200,
  String(MIRROR_QUEUE_LIMIT),
)

{
  const queue = new MirrorQueue()
  for (let i = 0; i < MIRROR_QUEUE_LIMIT + 25; i += 1) queue.add(event(i))
  check('a flood does not grow the queue past the bound', queue.size === MIRROR_QUEUE_LIMIT, String(queue.size))
  check('the oldest are the ones dropped', queue.peek()[0].body === 'm25', queue.peek()[0].body)
  check('the newest is still there', queue.peek()[queue.size - 1].body === `m${MIRROR_QUEUE_LIMIT + 24}`)
  check('and it says how many it threw away', queue.dropped === 25, String(queue.dropped))
}

/* ── taking and giving back ─────────────────────────────────────────────── */

{
  const queue = new MirrorQueue()
  queue.add(event(1), event(2), event(3))
  const batch = queue.take(2)
  check('a batch comes out oldest first', batch.map((e) => e.body).join(',') === 'm1,m2')
  check('and is gone from the queue while it is in flight', queue.size === 1)

  // The desktop was not there to take it: the events come back, and come back
  // in front of what arrived while the call was out.
  queue.putBack(batch)
  check('a failed send loses nothing', queue.size === 3, String(queue.size))
  check(
    'and the returned events go back in front of the newer ones',
    queue.peek().map((e) => e.body).join(',') === 'm1,m2,m3',
    queue.peek().map((e) => e.body).join(','),
  )
}

{
  // Put-back is the one path that can push the queue over its bound, since the
  // events left while the batch was away. It must trim like any other.
  const queue = new MirrorQueue(4)
  queue.add(event(1), event(2))
  const batch = queue.take(2)
  queue.add(event(3), event(4), event(5), event(6))
  queue.putBack(batch)
  check('a put-back onto a full queue still respects the bound', queue.size === 4, String(queue.size))
  check(
    'and drops the oldest, not the newest',
    queue.peek().map((e) => e.body).join(',') === 'm3,m4,m5,m6',
    queue.peek().map((e) => e.body).join(','),
  )
}

{
  const queue = new MirrorQueue()
  check('taking from an empty queue is nothing, not a throw', queue.take(50).length === 0)
}

/* ── who is allowed to be told ──────────────────────────────────────────── */

check('a desktop that mirrors is one to hand the backlog to', mirrorAccepted({ capabilities: { phone: { mirror: true } } }))
check('a remote link is not', !mirrorAccepted({ capabilities: { phone: { mirror: false } } }))
check('nor is a daemon too old to have the capability', !mirrorAccepted({ capabilities: { phone: {} } }))
check('nor one with no phone plugin at all', !mirrorAccepted({ capabilities: {} }))
check('and no hello yet is not a yes', !mirrorAccepted(null) && !mirrorAccepted(undefined))
check('a truthy near-miss is not a yes either', !mirrorAccepted({ capabilities: { phone: { mirror: 'yes' } } }))

/* ── the backlog stays off the cloud ────────────────────────────────────── */

{
  const config = JSON.parse(fs.readFileSync(path.join(appRoot, 'app.json'), 'utf8'))
  check(
    'the android build turns off automatic cloud backup',
    config.expo.android.allowBackup === false,
    String(config.expo.android.allowBackup),
  )
}

done()
