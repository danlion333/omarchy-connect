/**
 * What a notification card can be asked to do, on whatever server is running.
 *
 * Two facts about the desktop's notification server live here because more
 * than one plugin needs them and neither is worth asking the bus about twice.
 *
 * The first is whether the server draws buttons at all. Every server on the
 * bus advertises the `actions` capability, including the ones whose entire
 * idea of an action is to run the one named `default` when the card is
 * clicked — Omarchy's own shell among them. Nothing in the spec tells the two
 * apart, so the server is asked who it is and a short list is consulted.
 * Being wrong costs a line of text, never a button.
 *
 * The second is the right mouse button, which does not exist for libnotify.
 * A card swept off the screen invoked no action, so `notify-send` exits having
 * printed nothing and the gesture is lost. The bus does say it:
 * `NotificationClosed` carries a reason, and the reason tells a person's hand
 * apart from the card's own timeout and from our own close. So on a server
 * with no buttons the sweep becomes the card's second gesture — decline, for a
 * ringing call; copy, for a file that just landed.
 */
import { spawn } from 'node:child_process'
import { has } from './exec.js'

/** Servers that advertise `actions` and draw no buttons. */
export const BUTTONLESS = /quickshell/i

let buttons = true

/** Does this desktop's notification server draw buttons for named actions? */
export function drawsButtons() {
  return buttons
}

/**
 * Remember the answer, once somebody has asked the bus for it.
 *
 * Asked exactly once, at startup, by the phone plugin — which is the plugin
 * that cannot afford to wait on D-Bus while a phone is ringing. Everything
 * else reads the cached answer, and a desktop nobody asked about is assumed
 * to draw buttons, which is the harmless way to be wrong.
 */
export function setDrawsButtons(value) {
  buttons = Boolean(value)
}

/**
 * The server's reason for taking a card off the screen, when the reason is a
 * person: 1 is its own timeout running out, 3 is a client asking for it, and 2
 * is somebody sweeping it away by hand.
 */
export const CLOSED_BY_HAND = 2

/**
 * Watch one card until somebody sweeps it away by hand.
 *
 * The id is not known when the watch starts — it arrives on the card's own
 * `notify-send -p` stdout a moment later — so it is handed over with `card()`
 * rather than passed in. Signals that arrive before that name a card this
 * watch is not about, and are ignored.
 *
 * `ActionInvoked` is watched on the same stream and in the same order, because
 * a server closes the card it has just invoked an action on: clicking Open
 * produces exactly the close that sweeping it away does, and only the order of
 * the two signals tells them apart.
 */
export function watchSweep(onSweep) {
  if (!has('gdbus')) return null
  let id = 0
  let acted = false
  let stopped = false
  const child = spawn(
    'gdbus',
    ['monitor', '--session', '--dest', 'org.freedesktop.Notifications', '--object-path', '/org/freedesktop/Notifications'],
    { stdio: ['ignore', 'pipe', 'ignore'] },
  )
  const watch = {
    card(value) {
      id = Number(value) || 0
    },
    stop() {
      if (stopped) return
      stopped = true
      try {
        child.kill()
      } catch {
        /* already gone */
      }
    },
  }
  child.on('error', () => {
    stopped = true
  })
  child.stdout.setEncoding('utf8')
  // A signal is one line, but a chunk is not: the tail of a half-arrived line
  // is kept rather than read as a whole one and thrown away.
  let tail = ''
  child.stdout.on('data', (chunk) => {
    if (stopped) return
    tail += chunk
    const lines = tail.split('\n')
    tail = lines.pop()
    for (const line of lines) {
      const invoked = /ActionInvoked \(uint32 (\d+)/.exec(line)
      if (invoked) {
        if (id && Number(invoked[1]) === id) acted = true
        continue
      }
      const closed = /NotificationClosed \(uint32 (\d+), uint32 (\d+)\)/.exec(line)
      if (!closed) continue
      if (!id || Number(closed[1]) !== id || acted) continue
      if (Number(closed[2]) !== CLOSED_BY_HAND) continue
      watch.stop()
      onSweep()
    }
  })
  // A watch on a card is not a reason for the daemon to stay up.
  child.unref()
  return watch
}
