import { requireNativeModule, NativeModule } from 'expo'
import { Platform } from 'react-native'

export type LinkStatusText = string

type Events = {
  /** The default network came or went — the moment to re-dial, not to wait. */
  onNetworkChange: () => void
}

declare class OmarchyLink extends NativeModule<Events> {
  isAvailable(): boolean
  isRunning(): boolean
  isEnabled(): boolean
  hasChoice(): boolean
  start(): void
  stop(): void
  setStatus(status: LinkStatusText, desktop: string | null): void
  canPostNotifications(): boolean
  requestNotificationPermissionAsync(): Promise<{ granted: boolean; canAskAgain: boolean }>
  isBatteryOptimized(): boolean
  openBatterySettings(): Promise<void>
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

/** Keeps the ongoing notification honest about what the socket is doing. */
export function setBackgroundLinkStatus(status: string, desktop: string | null): void {
  try {
    linkService()?.setStatus(status, desktop)
  } catch {
    /* the notification is the least important thing in the room */
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
