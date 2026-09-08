/**
 * The card a received file arrives on, and the two gestures that make it a
 * remote control rather than a receipt.
 *
 * Until now `announceReceivedFile` fired one detached `notify-send` and forgot
 * it: clicking the card only made it go away, and the only ways to the file
 * were the panel's Inbox button and `openFilesOnReceive`, which opens every
 * file whether this was the one you wanted or not. The card now holds itself
 * open with `-p -A`, opens the file on a click and puts the file itself —
 * bytes for a picture, `text/uri-list` for everything else — on the clipboard
 * on the other gesture.
 *
 * Three things are worth a suite here, and they are the three that a green
 * build says nothing about. That the actions are really registered and that
 * the phone's filename is still text and not options. That the action that
 * comes back off the card reaches the right file with the right tool. And that
 * a file copied off its own card does not sail back to the phone that sent it
 * — the clipboard watcher fires on our own write like anybody else's, so the
 * copy has to pass through the same gate `claim` opens for text.
 *
 * `notify-send`, `xdg-open`, `wl-copy` and `wl-paste` are stand-ins on PATH,
 * as in `hygiene.mjs` and `clipboard-image.mjs`: a suite must not open a PDF
 * on the machine running it or take the clipboard away from whoever is at the
 * keyboard.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { check, done } from '../../tools/test-harness.mjs'

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'omarchy-connect-file-card-'))
process.on('exit', () => fs.rmSync(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))

const bin = path.join(sandbox, 'bin')
fs.mkdirSync(bin, { recursive: true })

const notifyLog = path.join(sandbox, 'notify-send.argv')
const openLog = path.join(sandbox, 'xdg-open.argv')
const copyLog = path.join(sandbox, 'wl-copy.argv')
const clipFile = path.join(sandbox, 'clipboard')
const typesFile = path.join(sandbox, 'types')
fs.writeFileSync(clipFile, '')
fs.writeFileSync(typesFile, 'text/plain\n')

/**
 * The card, which reports the id first and then whatever `$OC_CLICK` says the
 * person did — which is exactly the shape of a real `notify-send -p -A`: the
 * server's id on one line, the name of the invoked action on the next.
 */
fs.writeFileSync(
  path.join(bin, 'notify-send'),
  [
    '#!/bin/sh',
    `for a in "$@"; do printf '%s\\n' "$a" >> ${JSON.stringify(notifyLog)}; done`,
    `printf '%s\\n' '--END--' >> ${JSON.stringify(notifyLog)}`,
    "printf '77\\n'",
    '[ -n "$OC_CLICK" ] && printf \'%s\\n\' "$OC_CLICK"',
    'exit 0',
    '',
  ].join('\n'),
  { mode: 0o755 },
)
fs.writeFileSync(
  path.join(bin, 'xdg-open'),
  `#!/bin/sh\nprintf '%s\\n' "$1" >> ${JSON.stringify(openLog)}\nexit 0\n`,
  { mode: 0o755 },
)
// The desktop clipboard: the type it was given, the bytes it was handed.
fs.writeFileSync(
  path.join(bin, 'wl-copy'),
  [
    '#!/bin/sh',
    'type=text/plain',
    '[ "$1" = "--type" ] && type="$2"',
    `printf '%s\\n' "$type" > ${JSON.stringify(copyLog)}`,
    `printf '%s\\n' "$type" > ${JSON.stringify(typesFile)}`,
    `cat > ${JSON.stringify(clipFile)}`,
    '',
  ].join('\n'),
  { mode: 0o755 },
)
fs.writeFileSync(
  path.join(bin, 'wl-paste'),
  [
    '#!/bin/sh',
    'case " $* " in',
    '  *" --watch "*)',
    '    shift',
    `    seen=${JSON.stringify(path.join(sandbox, 'clipseen'))}`,
    `    cp ${JSON.stringify(clipFile)} "$seen"`,
    '    while true; do',
    `      if ! cmp -s ${JSON.stringify(clipFile)} "$seen"; then`,
    `        cp ${JSON.stringify(clipFile)} "$seen"`,
    '        "$@"',
    '      fi',
    '      sleep 0.1',
    '    done ;;',
    `  *--list-types*) cat ${JSON.stringify(typesFile)} ;;`,
    `  *) cat ${JSON.stringify(clipFile)} ;;`,
    'esac',
    '',
  ].join('\n'),
  { mode: 0o755 },
)
process.env.PATH = `${bin}:${process.env.PATH}`

const downloads = path.join(sandbox, 'Downloads')
process.env.XDG_DOWNLOAD_DIR = downloads
process.env.XDG_CACHE_HOME = path.join(sandbox, 'cache')

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Wait for something a spawned stand-in writes, rather than racing it. */
async function settled(fn, tries = 60) {
  for (let i = 0; i < tries; i += 1) {
    const value = fn()
    if (value) return value
    await wait(50)
  }
  return null
}

/** The arguments of the last complete `notify-send` run, or null. */
async function lastNotification() {
  const raw = await settled(() => {
    try {
      const text = fs.readFileSync(notifyLog, 'utf8')
      return text.includes('--END--') ? text : null
    } catch {
      return null
    }
  })
  if (!raw) return null
  fs.rmSync(notifyLog, { force: true })
  const runs = raw.split('--END--\n').filter((r) => r.length)
  return runs[runs.length - 1].split('\n').slice(0, -1)
}

const textOf = (argv) => (argv || []).slice((argv || []).indexOf('--') + 1)
const pairs = (argv) => {
  const out = []
  for (let i = 0; i < argv.length - 1; i += 1) if (argv[i] === '-A') out.push(argv[i + 1])
  return out
}

const share = await import('../src/plugins/share.js')

/* ── the card holds itself open, and the phone's name is still text ────── */

const inbox = share.INBOX
fs.mkdirSync(inbox, { recursive: true })
const pdf = path.join(inbox, 'report.pdf')
const png = path.join(inbox, 'photo.png')
fs.writeFileSync(pdf, '%PDF-1.4 a report\n')
const pngBytes = crypto.randomBytes(4096)
fs.writeFileSync(png, pngBytes)

share.announceReceivedFile(path.join(inbox, '--config=x.pdf'))
fs.writeFileSync(path.join(inbox, '--config=x.pdf'), 'x')
let argv = await lastNotification()
check('the card is held open for a click', (argv || []).includes('-p'), JSON.stringify(argv))
check(
  'it registers the click, the open and the copy',
  JSON.stringify(pairs(argv || [])) === JSON.stringify(['default=Open', 'open=Open', 'copy=Copy']),
  JSON.stringify(pairs(argv || [])),
)
check(
  'a received file whose name is a flag is still announced as a name',
  JSON.stringify(textOf(argv)) === JSON.stringify(['File received', '--config=x.pdf']),
  JSON.stringify(argv),
)

// Already opened by `openFilesOnReceive`: offering Open again would invite
// somebody to do the thing that has just been done.
share.announceReceivedFile(pdf, { open: true })
argv = await lastNotification()
check(
  'a file opened on arrival offers only the copy',
  JSON.stringify(pairs(argv || [])) === JSON.stringify(['default=Copy', 'copy=Copy']),
  JSON.stringify(pairs(argv || [])),
)
check(
  'and it really was opened',
  (await settled(() => (fs.existsSync(openLog) ? fs.readFileSync(openLog, 'utf8') : null)))?.trim() === pdf,
)
fs.rmSync(openLog, { force: true })

/* ── the click opens the file that was saved ──────────────────────────── */

process.env.OC_CLICK = 'open'
share.announceReceivedFile(pdf)
await lastNotification()
const opened = await settled(() => (fs.existsSync(openLog) ? fs.readFileSync(openLog, 'utf8') : null))
check('the open action reaches xdg-open with the inbox path', opened?.trim() === pdf, String(opened).trim())

/* ── the copy puts the file itself on the clipboard ───────────────────── */

async function copied(filePath) {
  fs.rmSync(copyLog, { force: true })
  process.env.OC_CLICK = 'copy'
  share.announceReceivedFile(filePath)
  await lastNotification()
  const type = await settled(() => (fs.existsSync(copyLog) ? fs.readFileSync(copyLog, 'utf8').trim() : null))
  return { type, bytes: fs.readFileSync(clipFile) }
}

const pdfClip = await copied(pdf)
check('a document is copied as text/uri-list', pdfClip.type === 'text/uri-list', String(pdfClip.type))
check(
  'and the URL in it is the file, escaped',
  pdfClip.bytes.toString('utf8').trim() === `file://${encodeURI(inbox).replace(/#/g, '%23')}/report.pdf`,
  pdfClip.bytes.toString('utf8').trim(),
)
check(
  'the inbox directory really is the escaped one',
  pdfClip.bytes.toString('utf8').includes('/Omarchy%20Connect/report.pdf'),
  pdfClip.bytes.toString('utf8').trim(),
)

const pngClip = await copied(png)
check('a picture is copied under its own type', pngClip.type === 'image/png', String(pngClip.type))
check(
  'and it is the picture, byte for byte',
  crypto.createHash('sha256').update(pngClip.bytes).digest('hex') ===
    crypto.createHash('sha256').update(pngBytes).digest('hex'),
  `${pngClip.bytes.length} bytes of ${pngBytes.length}`,
)

/* ── and it does not sail back to the phone that sent it ──────────────── */

const clipboard = (await import('../src/plugins/clipboard.js')).default
const published = []
clipboard.start({ emit: (kind, name, data) => published.push({ kind, name, data }) })
// The watcher polls the stand-in clipboard; let it take its bearings from
// what is already there before anything is copied.
await wait(400)

const second = path.join(inbox, 'photo (2).png')
fs.writeFileSync(second, crypto.randomBytes(2048))
await copied(second)
await wait(800)
check(
  'a picture copied off its own card is not republished to the phone',
  published.length === 0,
  JSON.stringify(published.map((p) => p.name)),
)

// A document takes the other road out — `text/uri-list`, recognised on its
// way back by its content rather than by a token — so it needs its own check.
const secondPdf = path.join(inbox, 'report (2).pdf')
fs.writeFileSync(secondPdf, '%PDF-1.4 another report\n')
await copied(secondPdf)
await wait(800)
check(
  'a document copied off its own card is not republished either',
  published.length === 0,
  JSON.stringify(published.map((p) => p.data?.text)),
)

// The same watcher, with somebody else's copy: the silence above has to be the
// gate doing its work, not a watcher that was never running.
fs.writeFileSync(typesFile, 'image/png\n')
fs.writeFileSync(clipFile, crypto.randomBytes(1024))
const outside = await settled(() => (published.length ? published : null))
check(
  'a picture copied by anybody else still is',
  Boolean(outside) && published[0].name === 'clipboard' && published[0].data.mime === 'image/png',
  JSON.stringify(published.map((p) => p.name)),
)
clipboard.stop()

done('received-file card checks')
