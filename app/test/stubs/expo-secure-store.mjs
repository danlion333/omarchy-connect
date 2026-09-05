/**
 * The keychain, in memory.
 *
 * `api/storage` is the only door to `expo-secure-store`, and everything it
 * stores is a string under a key — so a Map is a faithful stand-in for the
 * part of the phone a test can never have. Kept on `globalThis` so a suite can
 * look at what was written without going back through the module.
 */
const store = (globalThis.__keychain ??= new Map())

export async function getItemAsync(key) {
  return store.has(key) ? store.get(key) : null
}

export async function setItemAsync(key, value) {
  store.set(key, String(value))
}

export async function deleteItemAsync(key) {
  store.delete(key)
}

export const WHEN_UNLOCKED = 'whenUnlocked'
export const AFTER_FIRST_UNLOCK = 'afterFirstUnlock'
