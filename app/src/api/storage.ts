import * as SecureStore from 'expo-secure-store'

import { DEFAULT_ALERTS, type AlertPrefs } from './alerts'
import { migrateEndpoints, type Endpoint } from '../lib/endpoints'
import type { WakeInfo } from '../lib/wol'

export { MAX_ENDPOINTS, mergeEndpoints, migrateEndpoints } from '../lib/endpoints'
export type { Endpoint, EndpointKind } from '../lib/endpoints'

const KEY = 'omarchy-connect.desktop'
const DEVICE_KEY = 'omarchy-connect.device-id'
const ALERTS_KEY = 'omarchy-connect.agent-alerts'

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
  /**
   * Every address this desktop said it could be reached on, best first.
   *
   * `host`/`port` above stay as the last address that actually worked — they
   * are what a build that predates this reads, and they are the tie-break
   * when two candidates are equally plausible.
   */
  endpoints?: Endpoint[]
}

/**
 * Read leniently, the way the alert preferences are: a record written before
 * a field existed has to come back meaning something sensible, because the
 * alternative is a build that silently forgets the desktop somebody paired.
 */
export async function loadDesktop(): Promise<SavedDesktop | null> {
  try {
    const raw = await SecureStore.getItemAsync(KEY)
    if (!raw) return null
    const saved = JSON.parse(raw) as SavedDesktop
    if (!saved || typeof saved.host !== 'string') return null
    return { ...saved, endpoints: migrateEndpoints(saved) }
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

/**
 * Which of the phone's notifications are wanted.
 *
 * All on unless turned off: a notification nobody sees is an agent sitting
 * idle, a file nobody knew arrived, and a clipboard that never left the
 * desktop — and a default of silence would hide every one of those from
 * everybody who never went looking for the switch.
 *
 * Read leniently on purpose. A build that adds a category has to do something
 * sensible with a preferences blob written before it existed, and "on" is that
 * something.
 */
export async function loadAlertPrefs(): Promise<AlertPrefs> {
  try {
    const raw = await SecureStore.getItemAsync(ALERTS_KEY)
    if (!raw) return { ...DEFAULT_ALERTS }
    const saved = JSON.parse(raw) as Partial<AlertPrefs>
    const next = { ...DEFAULT_ALERTS }
    for (const key of Object.keys(next) as (keyof AlertPrefs)[]) {
      if (typeof saved[key] === 'boolean') next[key] = saved[key] as boolean
    }
    return next
  } catch {
    return { ...DEFAULT_ALERTS }
  }
}

export async function saveAlertPrefs(prefs: AlertPrefs): Promise<void> {
  await SecureStore.setItemAsync(ALERTS_KEY, JSON.stringify(prefs))
}

/* ── how the app looks on this phone ─────────────────────────────────── */

const LOOK_KEY = 'omarchy-connect.look'

/**
 * `aurora` is the theme's own colours as a gradient, `photo` is the picture
 * the desktop is wearing right now. `none` is not offered on Settings — it is
 * what Transparency being off means, and what an older phone may still have
 * saved.
 */
export type Wallpaper = 'aurora' | 'photo' | 'none'

/**
 * The two choices the phone makes for itself: whether cards are glass over a
 * wallpaper or solid, and which wallpaper. Everything else about the look
 * comes from the desktop's theme.
 */
export type LookPrefs = {
  transparency: boolean
  wallpaper: Wallpaper
}

export const DEFAULT_LOOK: LookPrefs = { transparency: true, wallpaper: 'aurora' }

/** Read leniently, like the alert preferences: an older blob still means something. */
export async function loadLook(): Promise<LookPrefs> {
  try {
    const raw = await SecureStore.getItemAsync(LOOK_KEY)
    if (!raw) return { ...DEFAULT_LOOK }
    const saved = JSON.parse(raw) as Partial<LookPrefs>
    return {
      transparency: typeof saved.transparency === 'boolean' ? saved.transparency : DEFAULT_LOOK.transparency,
      // A phone that saved `dots` chose a background that no longer exists;
      // it lands back on the default rather than on nothing at all.
      wallpaper:
        saved.wallpaper === 'aurora' || saved.wallpaper === 'photo' || saved.wallpaper === 'none'
          ? saved.wallpaper
          : DEFAULT_LOOK.wallpaper,
    }
  } catch {
    return { ...DEFAULT_LOOK }
  }
}

export async function saveLook(prefs: LookPrefs): Promise<void> {
  await SecureStore.setItemAsync(LOOK_KEY, JSON.stringify(prefs))
}
