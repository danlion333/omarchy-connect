import { Directory, File, Paths } from 'expo-file-system'
import * as SecureStore from 'expo-secure-store'

import { DEFAULT_ALERTS, type AlertPrefs } from './alerts'
import { migrateEndpoints, type Endpoint } from '../lib/endpoints'
import { NONCE_BYTES, NO_HISTORY, openHistory, sealHistory, type History } from '../lib/history'
import { randomBytes, toHex } from './crypto'

export { MAX_ENDPOINTS, mergeEndpoints, migrateEndpoints } from '../lib/endpoints'
export type { History } from '../lib/history'
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

/* ── what arrived, kept across a restart ─────────────────────────────── */

/**
 * The clipboard history and the file list, on the disk.
 *
 * Not in the keychain: `expo-secure-store` warns past 2048 bytes and twenty
 * clipboard entries go through that on their own — so what goes in the
 * keychain is a 32-byte key, and the history is a file sealed under it. The
 * reasoning for sealing it at all is in `lib/history`; what is here is only
 * the plumbing.
 *
 * In the *document* directory rather than the cache, because the cache is
 * exactly the thing Android throws away when it wants space back, and the
 * history is what the phone has left when the desktop is unreachable. The
 * downloaded bytes those rows point at do live in the cache and can go — a
 * row whose file has been reclaimed says so on the screen.
 */
const HISTORY_KEY = 'omarchy-connect.history-key'
const HISTORY_DIR = 'omarchy-connect'
const HISTORY_FILE = 'history.och'

/** Read once per launch: the keychain can be slow, and this is on the copy path. */
let historyKeyHex: string | null = null

async function historyKey(create: boolean): Promise<string | null> {
  if (historyKeyHex) return historyKeyHex
  const existing = await SecureStore.getItemAsync(HISTORY_KEY)
  if (existing) return (historyKeyHex = existing)
  if (!create) return null
  const fresh = toHex(randomBytes(32))
  await SecureStore.setItemAsync(HISTORY_KEY, fresh)
  return (historyKeyHex = fresh)
}

function historyFile(): File {
  const dir = new Directory(Paths.document, HISTORY_DIR)
  if (!dir.exists) dir.create({ intermediates: true })
  return new File(dir, HISTORY_FILE)
}

/**
 * What was on the phone when it was last killed.
 *
 * Answers with an empty history for every way this can fail — no key yet, no
 * file yet, a file that will not open — because a launch must not depend on
 * it and an empty Share screen is what the app did before any of this.
 */
export async function loadHistory(): Promise<History> {
  try {
    const key = await historyKey(false)
    if (!key) return { ...NO_HISTORY }
    const file = historyFile()
    if (!file.exists) return { ...NO_HISTORY }
    return openHistory(key, await file.bytes())
  } catch {
    return { ...NO_HISTORY }
  }
}

/**
 * Writes it down, one writer at a time.
 *
 * Serialised through a promise chain because the events that trigger it
 * arrive off a socket and can overlap: two writes racing on one path is how
 * a file ends up half of one history and half of another, and this one is
 * read at a moment — the next launch — when nothing can go back and ask the
 * desktop what it should have said.
 */
let writing: Promise<void> = Promise.resolve()

export function saveHistory(history: History): Promise<void> {
  writing = writing.then(async () => {
    try {
      const key = await historyKey(true)
      if (!key) return
      const file = historyFile()
      // Created first rather than left to `write`: the directory is new on a
      // phone that has never copied anything, and this is the one write whose
      // failure nobody would see until the next launch came back empty.
      if (!file.exists) file.create({ intermediates: true })
      file.write(sealHistory(key, history, randomBytes(NONCE_BYTES)))
    } catch {
      /* a phone that cannot write its history still has a working link */
    }
  })
  return writing
}

/**
 * Unpairing takes the history with it — and takes the key first, which is
 * what makes any copy of the file that outlives the delete unreadable rather
 * than merely deleted.
 */
export async function forgetHistory(): Promise<void> {
  await writing.catch(() => {})
  historyKeyHex = null
  try {
    await SecureStore.deleteItemAsync(HISTORY_KEY)
  } catch {
    /* nothing to lose the key from */
  }
  try {
    const file = historyFile()
    if (file.exists) file.delete()
  } catch {
    /* nothing to delete */
  }
}
