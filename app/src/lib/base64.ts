const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const INDEX = new Uint8Array(128)
for (let i = 0; i < ALPHABET.length; i += 1) INDEX[ALPHABET.charCodeAt(i)] = i

/**
 * base64 → bytes, by hand.
 *
 * `atob` is present in this runtime and would do, but it decodes to a string
 * of char codes that then has to be walked into a `Uint8Array` anyway — so the
 * loop exists either way, and doing it here costs one function and depends on
 * nothing. Two callers want it: a picture off the clipboard, and the
 * desktop's wallpaper.
 */
export function bytesFromBase64(base64: string): Uint8Array {
  const clean = base64.replace(/[^A-Za-z0-9+/]/g, '')
  const bytes = new Uint8Array(Math.floor((clean.length * 3) / 4))
  let out = 0
  for (let i = 0; i < clean.length; i += 4) {
    const a = INDEX[clean.charCodeAt(i)]
    const b = INDEX[clean.charCodeAt(i + 1)]
    const c = INDEX[clean.charCodeAt(i + 2)]
    const d = INDEX[clean.charCodeAt(i + 3)]
    bytes[out++] = (a << 2) | (b >> 4)
    if (i + 2 < clean.length) bytes[out++] = ((b & 15) << 4) | (c >> 2)
    if (i + 3 < clean.length) bytes[out++] = ((c & 3) << 6) | d
  }
  return bytes.subarray(0, out)
}
