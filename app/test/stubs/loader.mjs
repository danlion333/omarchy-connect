/**
 * Points two imports at the stubs beside this file, and leaves everything else
 * alone.
 *
 * `api/alerts` is plain decision-making over plain data — which is why it can
 * be tested here at all — but it lives among imports that only exist on a
 * phone. Rather than refactor the module for the benefit of its test, the two
 * are swapped at resolution time.
 */
import path from 'node:path'

export async function resolve(specifier, context, next) {
  if (specifier === 'react-native') {
    return { url: new URL('./react-native.mjs', import.meta.url).href, shortCircuit: true }
  }
  // The keychain: a phone-only module behind `api/storage`, which anything
  // testing what the app writes down has to go through.
  if (specifier === 'expo-secure-store') {
    return { url: new URL('./expo-secure-store.mjs', import.meta.url).href, shortCircuit: true }
  }
  // Everything else Expo: the battery, the network, the file system, the
  // photo library. `api/link` reaches none of them on the roads a test walks,
  // but it imports things that import them, and on Node they end at a native
  // module that does not exist.
  if (specifier.startsWith('expo-')) {
    return { url: new URL('./expo.mjs', import.meta.url).href, shortCircuit: true }
  }
  if (specifier.endsWith('modules/omarchy-link')) {
    return { url: new URL('./omarchy-link.mjs', import.meta.url).href, shortCircuit: true }
  }
  if (specifier.endsWith('modules/omarchy-telephony')) {
    return { url: new URL('./omarchy-telephony.mjs', import.meta.url).href, shortCircuit: true }
  }
  try {
    return await next(specifier, context)
  } catch (error) {
    // The app is bundled by Metro, which resolves `../lib/format` to the
    // TypeScript file beside it. Node does not, so a relative import with no
    // extension is retried with the one the repository writes.
    if (error?.code !== 'ERR_MODULE_NOT_FOUND' || !specifier.startsWith('.') || path.extname(specifier)) throw error
    return next(`${specifier}.ts`, context)
  }
}
