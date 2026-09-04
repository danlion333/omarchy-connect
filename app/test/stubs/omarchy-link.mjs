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
