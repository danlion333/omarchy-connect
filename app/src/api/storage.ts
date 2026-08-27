import * as SecureStore from 'expo-secure-store'

import type { WakeInfo } from '../lib/wol'

const KEY = 'omarchy-connect.desktop'
const DEVICE_KEY = 'omarchy-connect.device-id'

export type SavedDesktop = {
  host: string
  port: number
  token: string
  name: string
  pairedAt: number
  /** The desktop's X25519 identity key, pinned at pairing time. */
  publicKey: string
  /** Whether this desktop serves https + wss. Absent on desktops paired before TLS existed. */
  tls?: boolean
  /** Its certificate pin, pinned at the same moment as the identity key. */
  certPin?: string | null
  /**
   * What it would take to wake this desktop, as it described itself at the
   * last `hello`. Kept here rather than asked for because the moment it is
   * wanted is the moment there is nothing to ask.
   */
  wake?: WakeInfo | null
}

export async function loadDesktop(): Promise<SavedDesktop | null> {
  try {
    const raw = await SecureStore.getItemAsync(KEY)
    return raw ? (JSON.parse(raw) as SavedDesktop) : null
  } catch {
    return null
  }
}

export async function saveDesktop(desktop: SavedDesktop): Promise<void> {
  await SecureStore.setItemAsync(KEY, JSON.stringify(desktop))
}

export async function forgetDesktop(): Promise<void> {
  await SecureStore.deleteItemAsync(KEY)
}

/** A stable per-install id, so re-pairing replaces the entry instead of adding one. */
export async function deviceId(): Promise<string> {
  const existing = await SecureStore.getItemAsync(DEVICE_KEY)
  if (existing) return existing
  const id = `phone-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`
  await SecureStore.setItemAsync(DEVICE_KEY, id)
  return id
}
