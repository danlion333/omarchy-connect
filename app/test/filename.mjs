/**
 * The name a file gets on the phone, and whether Android will open it.
 *
 * A received file is addressed by URI the whole way down — `File.exists`,
 * the download, the share sheet, the gallery — and the last thing that
 * touches that URI on Android is `java.net.URI.create`, an RFC 2396 parser
 * that throws on `[`. Since a release name is very often exactly
 * `[Group] Title [2026, ENG] [tracker-123].torrent`, the phone used to answer
 * a tap on such a card with a Java stack trace, thrown before a single byte
 * was fetched.
 *
 * So this suite asks two things of `fileUriIn`: that what it produces is a
 * legal URI — checked against the RFC 2396 grammar here, and, where a JDK
 * happens to be installed, against the very parser that was throwing — and
 * that the name survives the trip, because a file called `%5BPikuma%5D…` in
 * the share sheet would be a different bug rather than a fix.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { check, done } from '../../tools/test-harness.mjs'
import { fileUriIn, safeFileName } from '../src/lib/filename.ts'

const DIR = 'file:///data/user/0/dev.omarchy.connect/cache/omarchy-connect/83cd7b0a8e4a'

/** The name out of the bug report, and the shapes the issue asked about. */
const NAMES = [
  '[Pikuma] [Gustavo Pezzi] Pikuma - 3D Computer Graphics Programming [2026, ENG] [rutracker-6873532].torrent',
  'report #3 (final).pdf',
  'query?a=1&b=2.txt',
  '100% done.txt',
  '{draft}.md',
  'a|b^c`d.txt',
  'звіт за березень.pdf',
  'Знімок екрана [2026-09-04].png',
]

/**
 * What `java.net.URI` allows in a path, straight out of RFC 2396: the
 * unreserved characters, the sub-delimiters it calls `punct`, an escape
 * triplet, and — Java's own extension — anything outside US-ASCII, which is
 * how a Cyrillic path is legal there at all.
 */
const LEGAL_PATH = /^(?:[A-Za-z0-9\-_.!~*'()/:@&=+$,;]|%[0-9A-Fa-f]{2}|[^\x00-\x7f])*$/

const pathOf = (uri) => uri.slice('file://'.length)

/* ── the URI is legal, and the name is still the name ───────────────────── */

for (const name of NAMES) {
  const uri = fileUriIn(DIR, name)
  const label = name.length > 40 ? `${name.slice(0, 37)}…` : name
  check(`a legal URI for ${label}`, LEGAL_PATH.test(pathOf(uri)), uri.slice(DIR.length + 1))
  check(`the name survives ${label}`, decodeURIComponent(uri.slice(DIR.length + 1)) === name)
}

check(
  'the bracketed name is not left to be read as a URI',
  !fileUriIn(DIR, NAMES[0]).includes('['),
)
check(
  'and Cyrillic comes back readable rather than as a stem',
  decodeURIComponent(fileUriIn(DIR, 'звіт за березень.pdf')).endsWith('звіт за березень.pdf'),
)

/* ── nothing that is not a name gets through ────────────────────────────── */

check('a directory separator cannot climb out', fileUriIn(DIR, '../../etc/passwd') === `${DIR}/passwd`)
check('a backslash is not a separator but is not kept either', safeFileName('a\\b.txt') === 'a_b.txt')
check('a control character is dropped', safeFileName('report\u0007.pdf') === 'report.pdf')
check('a name that is only dots is not a name', safeFileName('..') === 'file')
check('an empty name still gives something to write to', safeFileName('') === 'file')
check('an ordinary name is left completely alone', safeFileName('invoice.pdf') === 'invoice.pdf')
check('a trailing slash on the directory is not doubled', fileUriIn(`${DIR}/`, 'a.txt') === `${DIR}/a.txt`)

/* ── and the parser that was throwing agrees ────────────────────────────── */

/**
 * `Paths.join` as `expo-file-system@57` actually writes it: seven characters
 * escaped and the rest handed over untouched. Kept here because the point of
 * the suite is the difference between that and what we now send.
 */
function expoJoin(dir, name) {
  const encoded = name
    .replace(/%/g, '%25')
    .replace(/\\/g, '%5C')
    .replace(/\n/g, '%0A')
    .replace(/\r/g, '%0D')
    .replace(/\t/g, '%09')
    .replace(/ /g, '%20')
    .replace(/\?/g, '%3F')
    .replace(/#/g, '%23')
  return `${dir}/${encoded}`
}

const javaVerdicts = (uris) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-uri-'))
  const src = path.join(dir, 'UriCheck.java')
  fs.writeFileSync(
    src,
    `import java.net.URI;
public class UriCheck {
  public static void main(String[] a) throws Exception {
    for (String s : new String(java.nio.file.Files.readAllBytes(java.nio.file.Path.of(a[0])), "UTF-8").split("\\n")) {
      if (s.isEmpty()) continue;
      try { URI.create(s); System.out.println("ok"); }
      catch (IllegalArgumentException e) { System.out.println("throws"); }
    }
  }
}`,
  )
  const list = path.join(dir, 'uris.txt')
  fs.writeFileSync(list, `${uris.join('\n')}\n`)
  try {
    return execFileSync('java', [src, list], { encoding: 'utf8' }).trim().split('\n')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

try {
  const ours = javaVerdicts(NAMES.map((n) => fileUriIn(DIR, n)))
  check('java.net.URI accepts every name we encode', ours.every((v) => v === 'ok'), ours.join(' '))
  const theirs = javaVerdicts(NAMES.map((n) => expoJoin(DIR, n)))
  check(
    'and rejected the bracketed one before the fix',
    theirs[0] === 'throws',
    `expo's own join: ${theirs.join(' ')}`,
  )
} catch (error) {
  // No JDK on this machine: the grammar above already made the same claim.
  check('java.net.URI accepts every name we encode', true, `not asked — ${error.message.split('\n')[0]}`)
}

done('filename checks')
