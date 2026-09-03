import { requireNativeModule, NativeModule } from 'expo'
import { Platform } from 'react-native'

import type { NetworkFacts } from '../../src/lib/retry'
import type { SharePayload } from '../../src/lib/share'

export type LinkStatusText = string

type Events = {
  /**
   * The default network came, went, or changed shape.
   *
   * Carries what the phone is now attached to, because the answer decides
   * whether re-dialling could work at all — see `lib/retry`. The payload is
   * the same shape `networkFacts()` returns.
   */
  onNetworkChange: (facts: NetworkFacts) => void
  /** A notification button asked for something the app has to finish. */
  onOutbox: () => void
  /** The reconnect button on the ongoing notification. */
  onLinkReconnect: () => void
  /**
   * Somebody picked the phone up and stopped it shouting.
   *
   * The desktop asked the question, so the desktop is told the answer — see
   * `api/locate`. It arrives with no payload because there is nothing to say
   * beyond "found".
   */
  onLocateFound: () => void
  /**
   * Another app shared something to this one while it was already running.
   *
   * Carries nothing: the share itself is fetched with `takeShareIntent`,
   * because reading it copies every attachment out of the sharing app and
   * that is not work to do on the way past an event.
   */
  onShareIntent: () => void
}

/**
 * One thing asked for from the shade, waiting for a socket to do it with.
 *
 * `reply` — `id` is an agent session, `text` the answer typed into it.
 * `save` — `id` is an offer token, `text` the file's name.
 */
export type OutboxEntry = { kind: 'reply' | 'save'; id: string; text: string }

/** The namespaces a notification can belong to. Mirrors `Shade` in Kotlin. */
export type AlertKind = 'agent' | 'done' | 'file' | 'clip'

declare class OmarchyLink extends NativeModule<Events> {
  isAvailable(): boolean
  networkFacts(): NetworkFacts
  isRunning(): boolean
  isEnabled(): boolean
  hasChoice(): boolean
  start(): void
  stop(): void
  setStatus(status: LinkStatusText, desktop: string | null, connected: boolean, waiting: boolean): void
  notifyAgentWaiting(
    id: string,
    agent: string,
    title: string,
    prompt: string,
    canReply: boolean,
    alert: boolean,
  ): void
  notifyAgentDone(id: string, agent: string, title: string, preview: string): void
  notifyFile(token: string, name: string, size: string, saveable: boolean): void
  notifyClipboard(text: string): void
  clearAlert(kind: AlertKind, key: string): void
  clearAlerts(kind: AlertKind): void
  clearEveryAlert(): void
  noteAgentAlert(id: string, note: string): void
  noteFileAlert(token: string, name: string, note: string): void
  drainOutbox(): Promise<OutboxEntry[]>
  canPostNotifications(): boolean
  requestNotificationPermissionAsync(): Promise<{ granted: boolean; canAskAgain: boolean }>
  locate(seconds: number): void
  hush(): void
  isLocating(): boolean
  isBatteryOptimized(): boolean
  openBatterySettings(): Promise<void>
  sendDatagram(payload: string, host: string, port: number): Promise<number>
  takeShareIntent(): Promise<SharePayload | null>
}

/**
 * Android only, and only in a real build.
 *
 * Keeping a socket alive with the app closed means a foreground service, and a
 * foreground service means a native module — Expo Go has neither. iOS does not
 * offer the equivalent at any price: an app there gets a few seconds after
 * backgrounding and then the socket is taken away, which is the honest reason
 * this module has no iOS half.
 */
let cached: OmarchyLink | null | undefined

export function linkService(): OmarchyLink | null {
  if (cached !== undefined) return cached
  if (Platform.OS !== 'android') {
    cached = null
    return cached
  }
  try {
    cached = requireNativeModule<OmarchyLink>('OmarchyLink')
  } catch {
    cached = null
  }
  return cached
}

export const backgroundLinkSupported = () => linkService() !== null

/* ── the system share sheet ──────────────────────────────────────────── */

/**
 * The share this app was opened with, taken rather than read.
 *
 * `null` on every platform without the native module, and on every launch
 * that was not a share. Taking it spends it: asking twice does not deliver
 * the same photo twice, which matters because the activity is `singleTask`
 * and its launching intent outlives the share by the whole session.
 */
export async function takeSharedIntent(): Promise<SharePayload | null> {
  try {
    return (await linkService()?.takeShareIntent()) ?? null
  } catch {
    return null
  }
}

/** Fires when a share arrives at an app that is already open. */
export function onSharedIntent(handler: () => void): () => void {
  const native = linkService()
  if (!native) return () => {}
  try {
    const subscription = native.addListener('onShareIntent', handler)
    return () => subscription.remove()
  } catch {
    return () => {}
  }
}

/** Whether the link is wanted while the app is closed. */
export function backgroundLinkEnabled(): boolean {
  try {
    return linkService()?.isEnabled() ?? false
  } catch {
    return false
  }
}

/**
 * Whether the switch has ever been touched. A phone paired before the
 * background link existed has made no choice, and the app reads that as "on":
 * being offline the moment the screen turns off is the bug, not the setting.
 */
export function backgroundLinkChosen(): boolean {
  try {
    return linkService()?.hasChoice() ?? true
  } catch {
    return true
  }
}

export function backgroundLinkRunning(): boolean {
  try {
    return linkService()?.isRunning() ?? false
  } catch {
    return false
  }
}

export function startBackgroundLink(): void {
  try {
    linkService()?.start()
  } catch {
    /* a service we cannot start is not worth crashing the app over */
  }
}

export function stopBackgroundLink(): void {
  try {
    linkService()?.stop()
  } catch {
    /* same */
  }
}

/**
 * What the phone is attached to, or `null` where nothing can say.
 *
 * `null` is not "offline" — it is "unknown", and `lib/retry` reads it as
 * permission to try anyway. Anywhere without this native module (iOS, Expo Go)
 * that is the permanent answer, and the retry behaviour is what it always was.
 */
export function networkFacts(): NetworkFacts | null {
  try {
    return linkService()?.networkFacts() ?? null
  } catch {
    return null
  }
}

/**
 * Keeps the ongoing notification honest about what the socket is doing.
 *
 * `waiting` is not the opposite of `connected`: it says the phone has stopped
 * dialling on purpose, because on this network it could not succeed. The
 * notification words itself differently for the two, since "the phone keeps
 * trying" is a promise and one of these states is not keeping it.
 */
export function setBackgroundLinkStatus(
  status: string,
  desktop: string | null,
  connected: boolean,
  waiting: boolean,
): void {
  try {
    linkService()?.setStatus(status, desktop, connected, waiting)
  } catch {
    /* the notification is the least important thing in the room */
  }
}

/* ── what the phone is allowed to say ───────────────────────────────────── */

/**
 * The one notification in this app allowed to interrupt.
 *
 * `alert` is false when an agent that was already waiting merely reworded its
 * question: the shade is corrected, the phone stays quiet. `canReply` decides
 * whether the notification carries a text box — a desktop that cannot type
 * into that session should not be offering one.
 */
export function notifyAgentWaiting(input: {
  id: string
  agent: string
  title: string
  prompt: string
  canReply: boolean
  alert: boolean
}): void {
  try {
    linkService()?.notifyAgentWaiting(
      input.id,
      input.agent,
      input.title,
      input.prompt,
      input.canReply,
      input.alert,
    )
  } catch {
    /* a notification that will not post is not worth a crash */
  }
}

/** An agent finished something that had been running long enough to matter. */
export function notifyAgentDone(input: { id: string; agent: string; title: string; preview: string }): void {
  try {
    linkService()?.notifyAgentDone(input.id, input.agent, input.title, input.preview)
  } catch {
    /* same */
  }
}

/**
 * A file the desktop is offering. `saveable` is what draws the **Save**
 * button, and it belongs only on something the gallery can actually hold —
 * "save" for an arbitrary file means choosing where, and that is a screen.
 */
export function notifyFile(input: { token: string; name: string; size: string; saveable: boolean }): void {
  try {
    linkService()?.notifyFile(input.token, input.name, input.size, input.saveable)
  } catch {
    /* same */
  }
}

/** Whatever the desktop last copied, as one silent self-replacing line. */
export function notifyClipboard(text: string): void {
  try {
    linkService()?.notifyClipboard(text)
  } catch {
    /* same */
  }
}

export function clearAlert(kind: AlertKind, key: string): void {
  try {
    linkService()?.clearAlert(kind, key)
  } catch {
    /* same */
  }
}

export function clearAlerts(kind: AlertKind): void {
  try {
    linkService()?.clearAlerts(kind)
  } catch {
    /* same */
  }
}

export function clearEveryAlert(): void {
  try {
    linkService()?.clearEveryAlert()
  } catch {
    /* same */
  }
}

/** Replaces an alert with a word about what became of what it asked for. */
export function noteAgentAlert(id: string, note: string): void {
  try {
    linkService()?.noteAgentAlert(id, note)
  } catch {
    /* same */
  }
}

export function noteFileAlert(token: string, name: string, note: string): void {
  try {
    linkService()?.noteFileAlert(token, name, note)
  } catch {
    /* same */
  }
}

/**
 * Work asked for from a notification while there was nothing running to do it
 * — after a reboot, or once Android tore the runtime down under the service.
 */
export async function drainOutbox(): Promise<OutboxEntry[]> {
  try {
    return (await linkService()?.drainOutbox()) ?? []
  } catch {
    return []
  }
}

/* ── finding this phone ─────────────────────────────────────────────────── */

/**
 * Whether this build can be found at all.
 *
 * The noise is an alarm played by the native module, so the answer is no in
 * Expo Go and on iOS — and no in an installed build older than the feature,
 * whose module is present but has never heard of `locate`. That last case is
 * why the function itself is checked rather than only the module.
 */
export function locateSupported(): boolean {
  const native = linkService()
  return typeof (native as unknown as { locate?: unknown } | null)?.locate === 'function'
}

/** Start shouting for `seconds`, or reset the clock on a search under way. */
export function startLocating(seconds: number): void {
  const native = linkService()
  if (!native) throw new Error('this build cannot ring itself')
  native.locate(seconds)
}

/** Stop, for any reason that is not the button on the phone itself. */
export function stopLocating(): void {
  try {
    linkService()?.hush()
  } catch {
    /* a noise we cannot stop from here still stops on its own clock */
  }
}

export function isLocating(): boolean {
  try {
    return linkService()?.isLocating() ?? false
  } catch {
    return false
  }
}

export function canPostNotifications(): boolean {
  try {
    return linkService()?.canPostNotifications() ?? false
  } catch {
    return false
  }
}

export async function requestNotificationPermission(): Promise<boolean> {
  const native = linkService()
  if (!native) return false
  try {
    return (await native.requestNotificationPermissionAsync()).granted
  } catch {
    return false
  }
}

/**
 * Whether Android is still free to put this app to sleep. A foreground service
 * survives Doze, but several manufacturers run their own killer on top of it,
 * and this is the one switch that answers to an app.
 */
export function isBatteryOptimized(): boolean {
  try {
    return linkService()?.isBatteryOptimized() ?? false
  } catch {
    return false
  }
}

export async function openBatterySettings(): Promise<void> {
  try {
    await linkService()?.openBatterySettings()
  } catch {
    /* a settings screen we cannot open is not worth crashing over */
  }
}

/**
 * Whether this build can put a UDP datagram on the network at all.
 *
 * There is no socket of that kind in the React Native runtime, so the answer
 * is no everywhere but an Android build carrying this module — which is the
 * honest reason waking a desktop is Android-only. The function check is for
 * the other case: an installed build older than the feature, whose module is
 * present but has never heard of it.
 */
export function datagramsSupported(): boolean {
  const native = linkService()
  return typeof (native as unknown as { sendDatagram?: unknown } | null)?.sendDatagram === 'function'
}

/** One datagram, usually at a broadcast address. Answers with its size. */
export async function sendDatagram(payload: string, host: string, port: number): Promise<number> {
  const native = linkService()
  if (!native) throw new Error('this build cannot send a UDP packet')
  return native.sendDatagram(payload, host, port)
}
