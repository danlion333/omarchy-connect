/**
 * Turning a name the desktop chose into a URI Android will accept.
 *
 * `expo-file-system` addresses everything by URI. `new File(dir, name)` joins
 * the two through `Paths.join`, which percent-encodes exactly seven things —
 * `%`, `\`, newline, carriage return, tab, space, and then `?` and `#` — and
 * hands the rest to `java.net.URI.create` untouched. That parser is RFC 2396
 * and refuses a path containing `[`, `]`, `{`, `}`, `|`, `^`, `<`, `>` or a
 * backtick, so a perfectly ordinary release name —
 * `[Pikuma] … [rutracker-6873532].torrent` — threw `IllegalArgumentException:
 * Illegal character in path at index 75` on the very first touch of the file,
 * `target.exists`, before a single byte was fetched. Neither the tap nor
 * **Save** on the notification could get past it.
 *
 * So the name is encoded here, in full, and the finished URI is handed to
 * `File` as one string: encoding it ourselves is the only way that survives
 * `Paths.join`, which would turn the `%` of anything half-encoded into `%25`.
 *
 * Encoding is not a rename. The bytes on disk still carry the brackets, the
 * spaces and the Cyrillic, because the platform decodes the escapes again when
 * it opens the path — which is what keeps the share sheet and the gallery
 * showing `[Pikuma] … .torrent` and not `%5BPikuma%5D…`.
 */

/**
 * The name, minus the parts of it that are not really a name.
 *
 * The mirror of `safeInboxName` on the desktop, and it draws the line in the
 * same place: a received file is for the person, so `звіт за березень.pdf`
 * stays exactly that. What cannot survive is what is not filename material at
 * all — control characters, which arrive invisible, and separators, which
 * would let a name from the network climb out of its own offer directory.
 */
export function safeFileName(raw: string): string {
  // eslint-disable-next-line no-control-regex
  const stripped = String(raw ?? '').replace(/[\u0000-\u001f\u007f]/g, '')
  const base = stripped.slice(stripped.lastIndexOf('/') + 1).replace(/\\/g, '_')
  return /^\.*$/.test(base) ? 'file' : base
}

/**
 * `dir` and `name` as one `file://` URI that `java.net.URI` will parse.
 *
 * `encodeURIComponent` is the whole trick: it escapes every character outside
 * the unreserved set, which is a strict subset of what RFC 2396 allows in a
 * path segment, so the result is legal by construction — including for the
 * characters nobody has thought to test yet.
 */
export function fileUriIn(dirUri: string, name: string): string {
  return `${dirUri.replace(/\/+$/, '')}/${encodeURIComponent(safeFileName(name))}`
}
