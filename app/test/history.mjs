/**
 * The clipboard history and the file list, across a restart.
 *
 * `LinkState` held both in memory, so "look at what already arrived" worked
 * until Android reclaimed the process — which is precisely the moment
 * somebody reaches for it. What is checked here is the road that fixes it,
 * end to end minus the phone: the rule for what the file list keeps, the
 * lenient read that a blob from an older or broken build has to survive, the
 * seal that means the list of things its owner copied is not lying in the
 * clear, and then the two functions the app actually calls — `saveHistory`
 * and `loadHistory` — over a file system that keeps its bytes.
 *
 * The phone's own file system and keychain are the stubs beside this file:
 * one is a Map of URIs to bytes, the other a Map of keys to strings, which is
 * a faithful account of the parts of a phone a suite cannot have.
 */
import module from 'node:module'

import { check, done } from '../../tools/test-harness.mjs'

module.register('./stubs/loader.mjs', import.meta.url)

// Imported after the loader, like the other suites that reach into `src`:
// these modules sit on top of ones that only exist on a phone.
const { MAX_CLIPBOARD_EVENTS } = await import('../src/lib/clipboard.ts')
const { MAGIC, MAX_FILE_EVENTS, NONCE_BYTES, openHistory, packHistory, parseHistory, rememberFile, sealHistory } =
  await import('../src/lib/history.ts')

const copy = (text, at = 1) => ({ text, at, source: 'desktop' })
const arrival = (name, at = 1) => ({ direction: 'out', name, size: 10, token: `tok-${name}`, at })

/* ── the file list ──────────────────────────────────────────────────────── */

const one = rememberFile([], arrival('a.png', 10))
check('the first arrival is the whole list', one.length === 1 && one[0].name === 'a.png')

const two = rememberFile(one, arrival('b.png', 20))
check('a newer arrival goes to the head', two[0].name === 'b.png' && two[1].name === 'a.png')
check('the old array is left alone', one.length === 1)

let many = []
for (let i = 0; i < MAX_FILE_EVENTS + 5; i++) many = rememberFile(many, arrival(`f-${i}`, i))
check('the file list stops growing', many.length === MAX_FILE_EVENTS)
check('thirty of them, as the link has always kept', MAX_FILE_EVENTS === 30)
check('the newest survives', many[0].name === `f-${MAX_FILE_EVENTS + 4}`)
check('the oldest is pushed off the end', !many.some((f) => f.name === 'f-0'))

// Unlike the clipboard, a repeat is a second event: the same file sent twice
// is two transfers, each with its own moment.
const twice = rememberFile(rememberFile([], arrival('same.png', 30)), arrival('same.png', 40))
check('the same file sent twice is two rows', twice.length === 2 && twice[0].at === 40)

/* ── reading a blob back ────────────────────────────────────────────────── */

const packed = packHistory({ clipboard: [copy('hello', 5)], files: [arrival('a.png', 6)] })
const read = parseHistory(packed)
check('what was packed comes back', read.clipboard[0].text === 'hello' && read.files[0].name === 'a.png')
check('with the time it was copied', read.clipboard[0].at === 5)

check('nonsense reads as no history', parseHistory('{{{').clipboard.length === 0)
check('nothing at all reads as no history', parseHistory(null).files.length === 0)
check('a blob from another format is dropped', parseHistory(JSON.stringify({ clipboard: [copy('x')] })).clipboard.length === 0)

const junk = parseHistory(
  JSON.stringify({
    version: 1,
    clipboard: [copy('kept', 1), { at: 2 }, null, 'nope', { text: 'no time' }, { at: 3, token: 'tok' }],
    files: [arrival('kept.png'), { direction: 'sideways', name: 'x', size: 1 }, { direction: 'in' }, 7],
  }),
)
check('an entry with neither text nor an offer is dropped', junk.clipboard.length === 2)
check('the good ones are kept, in order', junk.clipboard[0].text === 'kept' && junk.clipboard[1].token === 'tok')
check('a file row with no name or direction is dropped', junk.files.length === 1 && junk.files[0].name === 'kept.png')

// The criterion: the caps hold *after* a restart, not only while the process
// that applied them is alive.
const overflowing = parseHistory(
  JSON.stringify({
    version: 1,
    clipboard: Array.from({ length: 50 }, (_, i) => copy(`c-${i}`, i)),
    files: Array.from({ length: 50 }, (_, i) => arrival(`f-${i}`, i)),
  }),
)
check('an over-long clipboard is trimmed on the way in', overflowing.clipboard.length === MAX_CLIPBOARD_EVENTS)
check('an over-long file list is trimmed on the way in', overflowing.files.length === MAX_FILE_EVENTS)
check('and it is the oldest that is dropped', overflowing.clipboard[0].text === 'c-0' && !overflowing.clipboard.some((c) => c.text === 'c-49'))

/* ── the seal ───────────────────────────────────────────────────────────── */

const key = 'a'.repeat(64)
const other = 'b'.repeat(64)
const history = { clipboard: [copy('a password, probably', 7)], files: [arrival('a.png', 8)] }
const nonce = new Uint8Array(NONCE_BYTES).fill(3)
const blob = sealHistory(key, history, nonce)

check('the blob is tagged', MAGIC.every((byte, i) => blob[i] === byte))
check('and carries the nonce it was sealed under', blob[MAGIC.length + 1] === 3)
const opened = openHistory(key, blob)
check('it opens back into the same history', opened.clipboard[0].text === 'a password, probably')
check('with the files beside it', opened.files[0].name === 'a.png')

// The whole reason for sealing it: what the user copied is not lying on the
// disk in the clear.
const asText = new TextDecoder().decode(blob)
check('the copied text is nowhere in the bytes', !asText.includes('a password, probably'))

check('another key opens nothing', openHistory(other, blob).clipboard.length === 0)
const tampered = new Uint8Array(blob)
tampered[tampered.length - 1] ^= 0xff
check('a tampered blob opens nothing', openHistory(key, tampered).clipboard.length === 0)
check('a truncated file opens nothing', openHistory(key, blob.subarray(0, 8)).clipboard.length === 0)
check('and none of that throws', true)

// A fresh nonce per write, because one key seals this file again on every
// copy: the same history twice must not be the same bytes twice.
const again = sealHistory(key, history, new Uint8Array(NONCE_BYTES).fill(9))
check('a second nonce gives different bytes', new TextDecoder().decode(again) !== asText)
check('which still open into the same history', openHistory(key, again).clipboard[0].text === 'a password, probably')

/* ── through the door the app uses ──────────────────────────────────────── */

const storage = await import('../src/api/storage.ts')
const keychain = globalThis.__keychain
const disk = globalThis.__files

check('nothing saved yet is no history', (await storage.loadHistory()).clipboard.length === 0)

const live = {
  clipboard: [copy('the second copy', 200), copy('the first copy', 100)],
  files: [arrival('shot.png', 150)],
}
await storage.saveHistory(live)

check('a key was made for it, in the keychain', /^[0-9a-f]{64}$/.test(keychain.get('omarchy-connect.history-key') || ''))
check('and it is small enough for the keychain to hold', (keychain.get('omarchy-connect.history-key') || '').length < 2048)

const written = [...disk.keys()].filter((uri) => uri.endsWith('history.och'))
check('the history itself is a file', written.length === 1, written.join(', '))
check('under the documents, not the cache Android may reclaim', written[0].startsWith('/tmp/document'), written[0])
check(
  'and it is sealed there',
  !new TextDecoder().decode(disk.get(written[0])).includes('the second copy'),
)

// The restart: nothing in memory is consulted — `loadHistory` goes back to
// the bytes on the disk, which is all a fresh process has.
const back = await storage.loadHistory()
check('the clipboard comes back, newest first', back.clipboard[0].text === 'the second copy')
check('with the time it was copied', back.clipboard[0].at === 200)
check('and the older copy under it', back.clipboard[1].text === 'the first copy')
check('the received file comes back too', back.files[0].name === 'shot.png' && back.files[0].token === 'tok-shot.png')

// Written again, the way a second copy would.
await storage.saveHistory({ clipboard: [copy('a third copy', 300), ...live.clipboard], files: live.files })
const third = await storage.loadHistory()
check('a later save replaces the file', third.clipboard.length === 3 && third.clipboard[0].text === 'a third copy')

// The caps, over the same road.
await storage.saveHistory({
  clipboard: Array.from({ length: 40 }, (_, i) => copy(`over-${i}`, i)),
  files: Array.from({ length: 40 }, (_, i) => arrival(`over-${i}`, i)),
})
const capped = await storage.loadHistory()
check('a save past the caps comes back capped', capped.clipboard.length === MAX_CLIPBOARD_EVENTS && capped.files.length === MAX_FILE_EVENTS)

/* ── unpairing ──────────────────────────────────────────────────────────── */

await storage.forgetHistory()
check('the key is gone from the keychain', !keychain.has('omarchy-connect.history-key'))
check('the file is gone from the disk', ![...disk.keys()].some((uri) => uri.endsWith('history.och')))
check('and there is no history to load', (await storage.loadHistory()).clipboard.length === 0)

// A phone that pairs again starts a new key, so nothing a copy of the old
// file might have survived on can be read with it.
await storage.saveHistory({ clipboard: [copy('after re-pairing', 400)], files: [] })
const fresh = keychain.get('omarchy-connect.history-key')
check('re-pairing seals under a new key', /^[0-9a-f]{64}$/.test(fresh || ''))
check('and the old blob does not open under it', openHistory(fresh, blob).clipboard.length === 0)

/* ── the wiring in api/link ─────────────────────────────────────────────── */

/*
 * `api/link` cannot be started here — it dials a desktop — so what is held to
 * the claim is its source: the three places the persistence has to be wired
 * into, which is the part a refactor could quietly drop while every check
 * above stayed green. What it actually does with them is looked at on the
 * phone.
 */
const fs = await import('node:fs')
const path = await import('node:path')
const url = await import('node:url')
const root = path.dirname(path.dirname(path.dirname(url.fileURLToPath(import.meta.url))))
const link = fs.readFileSync(path.join(root, 'app/src/api/link.ts'), 'utf8')

check('the link reads the history when it opens', /const history = saved \? await loadHistory\(\)/.test(link))
check('a clipboard event is written down', /clipboard: remember\([\s\S]{0,80}this\.writeHistory\(\)/.test(link))
check('so is a file event', /files: rememberFile\([\s\S]{0,80}this\.writeHistory\(\)/.test(link))
check('nothing is written for a phone that is not paired', /writeHistory\(\) \{\s*if \(!this\.state\.desktop\) return/.test(link))
check('and forgetting the desktop forgets the history', /await forgetHistory\(\)/.test(link))

done()
