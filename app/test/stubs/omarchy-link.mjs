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

/* ── the camera ─────────────────────────────────────────────────────── */

/**
 * The capture, as a switch and a list of calls — the microphone's stub with a
 * lens on it. `globalThis.__camera` is what a suite sets to describe the
 * handset it wants and reads to find out whether a lens was actually opened.
 */
const camera = (globalThis.__camera = {
  supported: true,
  permission: true,
  grants: true,
  asked: 0,
  running: false,
  starts: 0,
  stops: 0,
  /** The request the last `startCamera` was given. */
  last: null,
  /** Set to a message to make `startCamera` throw it. */
  refuse: null,
})

export function cameraSupported() {
  return camera.supported
}

export function hasCameraPermission() {
  return camera.permission
}

export async function requestCameraPermission() {
  camera.asked += 1
  if (camera.grants) camera.permission = true
  return camera.grants
}

export function startCamera(request) {
  if (camera.refuse) throw new Error(camera.refuse)
  camera.starts += 1
  camera.running = true
  camera.last = request
}

export function stopCamera() {
  if (camera.running) camera.stops += 1
  camera.running = false
}

export function isCameraRunning() {
  return camera.running
}

/**
 * The native event emitter, reduced to what the responders subscribe to. A
 * suite fires one with `globalThis.__mic.listeners.onMicStopped({ error })`,
 * and the camera's frames arrive through the same table.
 */
export function linkService() {
  return {
    addListener(name, fn) {
      mic.listeners[name] = fn
      return { remove: () => delete mic.listeners[name] }
    },
  }
}

/* ── the foreground service ─────────────────────────────────────────── */

/**
 * The half of the native module that keeps the socket alive when the app is
 * not on screen. `api/link` imports all of it at module scope, so it has to
 * exist for the module to load at all; none of it does anything a test can
 * see, and `globalThis.__background` is there for one that wants to look.
 */
const background = (globalThis.__background = {
  chosen: false,
  enabled: false,
  started: 0,
  stopped: 0,
  status: null,
  outbox: [],
})

export function backgroundLinkChosen() {
  return background.chosen
}

export function backgroundLinkEnabled() {
  return background.enabled
}

export async function startBackgroundLink() {
  background.started += 1
}

export async function stopBackgroundLink() {
  background.stopped += 1
}

export function setBackgroundLinkStatus(status) {
  background.status = status
}

export async function drainOutbox() {
  const queued = background.outbox
  background.outbox = []
  return queued
}

export async function networkFacts() {
  return { ssid: null, wifi: true, metered: false }
}

export const noteAgentAlert = record('noteAgentAlert')
export const noteFileAlert = record('noteFileAlert')

/* ── the rest of the native surface ─────────────────────────────────── */

/**
 * Finding the phone, and putting a picture on its clipboard. Both are native
 * on a device and neither is reachable from a test; they are here so that
 * every module that imports the native side can be loaded on Node.
 */
export function locateSupported() {
  return false
}

export const startLocating = record('startLocating')
export const stopLocating = record('stopLocating')
export const copyPictureToClipboard = record('copyPictureToClipboard')
