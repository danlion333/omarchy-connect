/**
 * The native side of the notification shade, as a list of what was asked of it.
 *
 * Every call lands in `globalThis.__shade` in order, which is what the suite
 * reads: the questions are all of the form "was a card raised, and was it ever
 * taken down again", and those are exactly the calls.
 */
const shade = (globalThis.__shade = [])
const record = (call) => (...args) => shade.push({ call, args })

export const notifyAgentWaiting = record('notifyAgentWaiting')
export const notifyAgentDone = record('notifyAgentDone')
export const notifyFile = record('notifyFile')
export const notifyClipboard = record('notifyClipboard')
export const notifyClipboardImage = record('notifyClipboardImage')
export const clearAlert = record('clearAlert')
export const clearAlerts = record('clearAlerts')
export const clearEveryAlert = record('clearEveryAlert')

/* ── the microphone ─────────────────────────────────────────────────── */

/**
 * The recorder, as a switch and a list of calls.
 *
 * `globalThis.__mic` is what a suite sets to describe the handset it wants —
 * a build with no module, a revoked permission, a phone that refuses to open
 * the input — and what it reads to find out whether the microphone was
 * actually opened or given back.
 */
const mic = (globalThis.__mic = {
  supported: true,
  permission: true,
  /** What `requestMicPermission` will answer, and whether it was asked. */
  grants: true,
  asked: 0,
  running: false,
  starts: 0,
  stops: 0,
  /** Set to a message to make `startMic` throw it. */
  refuse: null,
  listeners: {},
})

export function micSupported() {
  return mic.supported
}

export function hasMicPermission() {
  return mic.permission
}

export async function requestMicPermission() {
  mic.asked += 1
  if (mic.grants) mic.permission = true
  return mic.grants
}

export function startMic() {
  if (mic.refuse) throw new Error(mic.refuse)
  mic.starts += 1
  mic.running = true
}

export function stopMic() {
  if (mic.running) mic.stops += 1
  mic.running = false
}

export function isMicRunning() {
  return mic.running
}

/**
 * The native event emitter, reduced to what the responder subscribes to. A
 * suite fires one with `globalThis.__mic.listeners.onMicStopped({ error })`.
 */
export function linkService() {
  return {
    addListener(name, fn) {
      mic.listeners[name] = fn
      return { remove: () => delete mic.listeners[name] }
    },
  }
}
