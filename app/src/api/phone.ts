import { telephony, type TelephonyEvent } from '../../modules/omarchy-telephony'
import { MirrorQueue, mirrorAccepted } from '../lib/mirror-queue'
import type { ConnectClient } from './client'

/**
 * Mirrors the phone's SMS and call activity onto the desktop.
 *
 * Android only, and only in a real build — Expo Go cannot hold the
 * permissions, and iOS never lets an app near either. `telephony()` is null in
 * both cases and everything here turns into a no-op, so the rest of the app
 * does not have to know which build it is running in.
 *
 * Two sources feed the same pipe: live broadcasts while the app is running,
 * and the backlog the native receiver wrote down while it was not. Draining
 * the backlog is the first thing that happens on connect, which is what makes
 * a message that landed overnight show up on the desktop in the morning.
 */

const BATCH = 50

export type PhonePermission = {
  granted: boolean
  canAskAgain: boolean
}

export const phoneMirrorSupported = () => telephony() !== null

export async function phonePermission(): Promise<PhonePermission> {
  const native = telephony()
  if (!native) return { granted: false, canAskAgain: false }
  const result = await native.getPermissionsAsync()
  return { granted: result.granted, canAskAgain: result.canAskAgain }
}

export async function requestPhonePermission(): Promise<PhonePermission> {
  const native = telephony()
  if (!native) return { granted: false, canAskAgain: false }
  const result = await native.requestPermissionsAsync()
  return { granted: result.granted, canAskAgain: result.canAskAgain }
}

/** Sending costs money, so it is asked for separately and only when used. */
export async function requestSendPermission(): Promise<boolean> {
  const native = telephony()
  if (!native) return false
  const result = await native.requestSendPermissionAsync()
  return result.granted
}

/**
 * Answering someone's call from another room is not a passive act, so it is
 * its own permission and its own decision — mirroring does not imply it.
 */
export async function requestCallPermission(): Promise<boolean> {
  const native = telephony()
  if (!native) return false
  const result = await native.requestCallPermissionAsync()
  return result.granted
}

export const canAnswerCalls = () => {
  const native = telephony()
  if (!native) return false
  try {
    return native.canAnswerCalls()
  } catch {
    return false
  }
}

/**
 * Whether the desktop will learn who is calling, not just that someone is.
 *
 * Android stopped putting the number in the call broadcast for anything
 * targeting API 29 or higher, and the call log is only written once the call is
 * over — so without this the desktop shows "unknown" while the phone rings.
 */
export const canReadCallNotifications = () => {
  const native = telephony()
  if (!native) return false
  try {
    return native.canReadCallNotifications()
  } catch {
    return false
  }
}

/**
 * Whether a number can be turned into a name. Separate from the above on
 * purpose: with notification access but no contacts, every call arrives as a
 * bare number, which from the desktop is indistinguishable from a caller ID
 * that does not work at all.
 */
export const canReadContacts = () => {
  const native = telephony()
  if (!native) return false
  try {
    return native.canReadContacts()
  } catch {
    return false
  }
}

/** Notification access has no dialog — only a settings screen to open. */
export async function openNotificationAccess(): Promise<void> {
  const native = telephony()
  if (!native) return
  try {
    await native.openNotificationAccess()
  } catch {
    /* a settings screen we cannot open is not worth crashing the app over */
  }
}

export function startPhoneMirror(client: ConnectClient): () => void {
  const native = telephony()
  if (!native) return () => {}

  let stopped = false
  const queue = new MirrorQueue<TelephonyEvent>()
  let flushing = false
  // A desktop that answered `unknown method` will answer it again, so the
  // events stay queued and nothing is sent until the next `hello` says the
  // other end has changed its mind.
  let refused = false

  const flush = async () => {
    if (flushing || stopped || !queue.size) return
    if (client.status !== 'connected') return
    // A desktop running an older daemon has no `phone.report` to call, and a
    // remote link is refused telephony on purpose. Holding the events back
    // rather than sending them is what stops the queue from growing forever
    // against a method that will never exist.
    if (refused || !mirrorAccepted(client.hello)) return
    flushing = true
    // Taken out of the queue in one go, and put back if the desktop was not
    // there to take them — a dropped socket must not lose a message, and
    // neither must a desktop that turns out not to speak this at all.
    const batch = queue.take(BATCH)
    try {
      await client.call('phone.report', { events: batch })
    } catch (err) {
      // A refused method will be refused again; anything else is the socket
      // having a bad moment and is worth another try. Either way the events go
      // back where they came from.
      queue.putBack(batch)
      if (/unknown method/i.test((err as Error).message)) refused = true
    } finally {
      flushing = false
    }
  }

  const push = (event: TelephonyEvent) => {
    queue.add(event)
    // A ringing phone is the least forgiving thing this app carries: the
    // desktop is useful for the twenty seconds the call lasts and useless
    // after. If the socket died while the phone was asleep, waiting out the
    // backoff would spend all twenty of them, so the arrival of an event is
    // itself the reason to re-dial now.
    if (client.status !== 'connected') client.reconnectNow()
    flush()
  }

  const subscriptions = [
    native.addListener('onMessage', push),
    native.addListener('onCall', push),
    // Reconnecting is the moment to catch up: both with what the queue could
    // not deliver and with what arrived while the app was closed.
    client.on('hello', async () => {
      refused = false
      // The backlog only leaves its native storage once the desktop has said
      // it will take it. `drainBacklog` empties SharedPreferences, so draining
      // it for a desktop that refuses telephony — an old daemon, or a remote
      // link — would move an overnight message into a JavaScript array that
      // the next process death throws away.
      if (!mirrorAccepted(client.hello)) return
      try {
        const backlog = await native.drainBacklog()
        if (backlog.length) queue.add(...backlog)
      } catch {
        /* a backlog we cannot read is not worth failing the connection over */
      }
      flush()
    }),
    /**
     * The desktop asking the phone to send one. The desktop has no radio, so
     * this is the only direction an outgoing message can travel.
     */
    client.on('ev:phone', async (data: any) => {
      if (!data?.id) return
      if (data.action === 'send') {
        try {
          await native.sendMessage(String(data.to), String(data.body))
          await client.call('phone.sent', { id: data.id, ok: true })
        } catch (err) {
          await client
            .call('phone.sent', { id: data.id, ok: false, error: (err as Error).message })
            .catch(() => {})
        }
        return
      }
      /**
       * Answer or reject, asked for from the desktop. The daemon only comes
       * here when the handset is not on Bluetooth — over Bluetooth it acts
       * through the hands-free profile instead, which also moves the audio.
       */
      if (data.action === 'call') {
        try {
          if (data.op === 'answer') await native.answerCall()
          else await native.rejectCall()
          await client.call('phone.acted', { id: data.id, ok: true })
        } catch (err) {
          await client
            .call('phone.acted', { id: data.id, ok: false, error: (err as Error).message })
            .catch(() => {})
        }
      }
    }),
  ]

  const timer = setInterval(flush, 15_000)

  return () => {
    stopped = true
    clearInterval(timer)
    for (const remove of subscriptions) {
      // Native subscriptions and client listeners are removed differently.
      if (typeof remove === 'function') remove()
      else (remove as { remove(): void }).remove()
    }
  }
}
