/**
 * The file manager's door into `send`, from the URIs Nautilus writes down to
 * the offer a phone hears.
 *
 * Three things can go wrong on this road and none of them is the offer itself.
 * The selection arrives as `file://` URIs, so a name with a space or a literal
 * percent in it is a decoding problem before it is a file. The item is a file
 * on disk in somebody's home directory, so installing and removing it is a
 * question of what is left behind. And a click with no daemon running has to
 * end in something the user can see, because a context-menu item that exits 1
 * into a closed pipe is a menu item that silently does nothing.
 *
 * So the suite is in three parts: the parser, held against the panel's copy of
 * the same job so the two cannot drift; the installer, run in a sandbox with
 * `XDG_DATA_HOME` pointed away from the real `~/.local/share`; and the whole
 * road end to end — the script Nautilus would run, started with the variable
 * Nautilus would set, against a real daemon with a phone in Node listening for
 * the offers.
 *
 * Nothing here touches the machine's own daemon, its real Nautilus directory
 * or its real notification server.
 */
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

import { check, done } from '../../tools/test-harness.mjs'
import { connectPhone } from './phone.mjs'
import { quietBluetooth, localHeaders } from './sandbox.mjs'

const PORT = Number(process.env.PORT || 8819)
const base = `http://127.0.0.1:${PORT}`
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const repo = path.dirname(root)
const entry = path.join(root, 'bin', 'omarchy-connect.js')

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'omarchy-connect-nautilus-'))
const state = path.join(sandbox, 'state')
const data = path.join(sandbox, 'share')
const local = () => localHeaders(state)
quietBluetooth(sandbox)

/* ── the parser, and the panel's copy of it ───────────────────────────── */

// Only the parser is used in this process; everything that touches the file
// system is exercised through the CLI below, where `XDG_DATA_HOME` can be
// pointed at the sandbox before the module reads it.
const nautilus = await import('../src/lib/nautilus.js')

// `.pragma library` is Quickshell's word for "this file has no QML around it";
// it is also not JavaScript, so it comes off before the file is evaluated.
const qml = fs.readFileSync(path.join(repo, 'shell', 'Model.js'), 'utf8').replace(/^\.pragma .*$/m, '')
const Model = vm.createContext({})
vm.runInContext(qml, Model, { filename: 'shell/Model.js' })

/** What Nautilus writes into the variable: one URI per line. */
const selected = (...uris) => nautilus.uriPaths(uris.join('\n'))

check('a selected file becomes its path', selected('file:///home/me/report.pdf')[0] === '/home/me/report.pdf',
  selected('file:///home/me/report.pdf')[0])
check('an escaped space becomes a space',
  selected('file:///home/me/holiday%20photo.png')[0] === '/home/me/holiday photo.png',
  selected('file:///home/me/holiday%20photo.png')[0])
// The name from the acceptance criteria. Nautilus escapes the percent itself,
// so `holiday%20photo.png` on disk is `holiday%2520photo.png` on the wire, and
// one round of decoding has to give the literal percent back rather than a
// space.
check('a name containing a literal %20 is not decoded into a space',
  selected('file:///home/me/holiday%2520photo.png')[0] === '/home/me/holiday%20photo.png',
  selected('file:///home/me/holiday%2520photo.png')[0])
check('a name in Cyrillic survives the trip',
  selected('file:///home/me/%D0%B7%D0%B2%D1%96%D1%82.pdf')[0] === '/home/me/звіт.pdf',
  selected('file:///home/me/%D0%B7%D0%B2%D1%96%D1%82.pdf')[0])
check('a stray percent costs the escape, not the file',
  selected('file:///home/me/100%.txt').length === 1, JSON.stringify(selected('file:///home/me/100%.txt')))
check('several selected files come back in the order they were selected',
  selected('file:///a.txt', 'file:///b.txt', 'file:///c.txt').join(',') === '/a.txt,/b.txt,/c.txt')
check('the same file twice is sent once', selected('file:///a.txt', 'file:///a.txt').length === 1)
check('a file on somebody else\'s machine is refused',
  selected('file://desktop-2/home/me/report.pdf').length === 0)
check('but localhost is this machine', selected('file://localhost/a.txt')[0] === '/a.txt')
check('a selection of nothing asks for nothing',
  nautilus.uriPaths('').length === 0 && nautilus.uriPaths(undefined).length === 0)
check('and the trailing newline Nautilus leaves is not a file',
  selected('file:///a.txt', '').length === 1)

/**
 * The same inputs through the panel's `dropPaths()`.
 *
 * Two copies of one translation is a licence to drift, and this is the check
 * that catches it: whatever a drag on the bar icon makes of a URI, the menu
 * item has to make of it too.
 */
const sameAsPanel = [
  'file:///home/me/report.pdf',
  'file:///home/me/holiday%20photo.png',
  'file:///home/me/holiday%2520photo.png',
  'file:///home/me/100%.txt',
  'file://desktop-2/home/me/report.pdf',
  'file://localhost/a.txt',
  'https://omarchy.org/',
]
check(
  'the menu item and the bar icon read a URI the same way',
  JSON.stringify(nautilus.uriPaths(sameAsPanel.join('\n'))) === JSON.stringify(Model.dropPaths(sameAsPanel)),
  JSON.stringify(nautilus.uriPaths(sameAsPanel.join('\n'))),
)

/* ── installing and removing, in a sandbox ────────────────────────────── */

const cli = (args, env = {}) =>
  spawnSync(process.execPath, [entry, ...args], {
    env: {
      ...process.env,
      HOME: sandbox,
      XDG_CONFIG_HOME: sandbox,
      XDG_DATA_HOME: data,
      OMARCHY_CONNECT_STATE: state,
      OMARCHY_CONNECT_LOG: 'error',
      PATH: `${sandbox}/bin:${process.env.PATH}`,
      ...env,
    },
    encoding: 'utf8',
  })

const scriptsDir = path.join(data, 'nautilus', 'scripts')
const scriptFile = path.join(scriptsDir, 'Send to phone')

check('nothing is installed to begin with', cli(['nautilus', 'status']).stdout.includes('no'))

const install = cli(['nautilus', 'install'])
check('install exits clean', install.status === 0, install.stderr)
check('and leaves one script where Nautilus reads them', fs.existsSync(scriptFile), scriptFile)
check('the file is executable, or Nautilus will not show it',
  (fs.statSync(scriptFile).mode & 0o111) !== 0, (fs.statSync(scriptFile).mode & 0o777).toString(8))
check('the directory it made is private, like the one Nautilus makes',
  (fs.statSync(scriptsDir).mode & 0o777) === 0o700, (fs.statSync(scriptsDir).mode & 0o777).toString(8))

const body = fs.readFileSync(scriptFile, 'utf8')
const execLine = body.trim().split('\n').pop()
check('the script names this daemon without leaning on $PATH',
  body.includes(entry) && body.includes(process.execPath), execLine)
check('and hands over rather than leaving a shell behind', /^exec /m.test(execLine), execLine)
check('status now says where it is', cli(['nautilus', 'status']).stdout.includes('Send to phone'))
check('installing twice is not an error', cli(['nautilus', 'install']).status === 0)

/**
 * A script of the user's own, beside ours, to prove removal is a scalpel.
 * Nautilus's script directory is shared with whatever else the user put there.
 */
const mine = path.join(scriptsDir, 'my own script')
fs.writeFileSync(mine, '#!/bin/sh\nexit 0\n', { mode: 0o755 })

const removed = cli(['nautilus', 'remove'])
check('remove exits clean', removed.status === 0, removed.stderr)
check('the item is gone', !fs.existsSync(scriptFile))
check("and nothing of this project is left under ~/.local/share/nautilus",
  fs.readdirSync(scriptsDir).join(',') === 'my own script', fs.readdirSync(scriptsDir).join(','))
check("somebody else's script was not swept up with it", fs.existsSync(mine))
check('removing what is not there says so rather than failing',
  cli(['nautilus', 'remove']).status === 0)
fs.rmSync(mine, { force: true })

/* ── a click with no daemon behind it ─────────────────────────────────── */

/**
 * A stand-in for libnotify ahead of the real one, so a test run does not put
 * cards on the tester's desktop — and so the cards can be read back. Every
 * argument on its own line, one run per `--END--`, as in `hygiene.mjs`.
 */
fs.mkdirSync(path.join(sandbox, 'bin'), { recursive: true })
const argvLog = path.join(sandbox, 'notify-send.argv')
fs.writeFileSync(
  path.join(sandbox, 'bin', 'notify-send'),
  `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a" >> ${JSON.stringify(argvLog)}; done\nprintf '%s\\n' '--END--' >> ${JSON.stringify(argvLog)}\nexit 0\n`,
  { mode: 0o755 },
)

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

/** The notifications raised since the last time this was asked. */
async function notifications() {
  let raw = ''
  for (let tries = 0; tries < 40; tries += 1) {
    try {
      raw = fs.readFileSync(argvLog, 'utf8')
    } catch {
      raw = ''
    }
    if (raw.includes('--END--')) break
    await wait(50)
  }
  fs.rmSync(argvLog, { force: true })
  return raw
    .split('--END--\n')
    .filter((r) => r.length)
    .map((r) => r.split('\n').slice(0, -1))
}

/** The menu item, started the way Nautilus starts it: through the script. */
function click(...files) {
  cli(['nautilus', 'install'])
  return spawnSync('/bin/sh', [scriptFile], {
    env: {
      ...process.env,
      HOME: sandbox,
      XDG_CONFIG_HOME: sandbox,
      XDG_DATA_HOME: data,
      OMARCHY_CONNECT_STATE: state,
      OMARCHY_CONNECT_LOG: 'error',
      PATH: `${sandbox}/bin:${process.env.PATH}`,
      NAUTILUS_SCRIPT_SELECTED_URIS: files.map((f) => `file://${encodeURI(f)}`).join('\n'),
    },
    encoding: 'utf8',
  })
}

// A file that really is there, so what fails is the daemon and not the path.
const orphan = path.join(sandbox, 'nobody is listening.txt')
fs.writeFileSync(orphan, 'x')
const silent = click(orphan)
check('a click with no daemon running fails', silent.status !== 0, silent.stdout)
let cards = await notifications()
check('and says so on the desktop rather than in silence',
  cards.some((c) => c.join(' ').includes('Omarchy Connect is not running')), JSON.stringify(cards))

/* ── the daemon, a phone, and two awkward filenames ───────────────────── */

const files = [
  path.join(sandbox, 'holiday%20photo.png'),
  path.join(sandbox, 'звіт 100%.txt'),
]
fs.writeFileSync(files[0], 'not really a png')
fs.writeFileSync(files[1], 'not really a report')

const daemon = spawn(process.execPath, [entry, 'start', '--port', String(PORT)], {
  env: {
    ...process.env,
    HOME: sandbox,
    XDG_CONFIG_HOME: sandbox,
    XDG_DATA_HOME: data,
    OMARCHY_CONNECT_STATE: state,
    OMARCHY_CONNECT_LOG: 'error',
  },
  stdio: ['ignore', 'ignore', 'inherit'],
})
process.on('exit', () => {
  daemon.kill('SIGTERM')
  fs.rmSync(sandbox, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

for (let i = 0; i < 40; i += 1) {
  try {
    if ((await fetch(`${base}/api/info`)).ok) break
  } catch {
    await wait(250)
  }
}

const seen = []
const info = await (await fetch(`${base}/api/info`)).json()
const code = (await (await fetch(`${base}/api/pair-code`, { method: 'POST', headers: local() })).json()).code
const phone = connectPhone(PORT, info.publicKey)
phone.on((m) => seen.push(m))
await phone.ready
phone.send({
  t: 'hello',
  pairCode: code,
  device: { id: 'nautilus-test-device', name: 'Test phone', platform: 'android', model: 'Test' },
})

const until = async (match, count = 1, ms = 8000) => {
  const deadline = Date.now() + ms
  for (;;) {
    const hits = seen.filter(match)
    if (hits.length >= count || Date.now() > deadline) return hits
    await wait(25)
  }
}

const [hello] = await until((m) => m.t === 'hello.ok' || m.t === 'hello.err')
check('the test phone paired', hello?.t === 'hello.ok', hello?.error)
phone.send({ t: 'sub', events: ['file'] })
const [subscribed] = await until((m) => m.t === 'sub.ok')
check('and asked to hear about files', subscribed?.events?.includes('file'), JSON.stringify(subscribed?.events))

// The whole gesture: two files selected in Nautilus, one right-click, one run
// of the script — and the same file twice in the selection, which the phone
// should be offered once.
const clicked = click(files[0], files[1], files[0])
check('a click with two files selected succeeds', clicked.status === 0, clicked.stderr || clicked.stdout)

const offers = await until((m) => m.t === 'ev' && m.event === 'file' && m.data?.direction === 'out', 2)
const names = offers.map((o) => o.data.name)
check('the phone was offered both files', offers.length >= 2, JSON.stringify(names))
check('a literal %20 in the name reached the phone unmangled',
  names.includes('holiday%20photo.png'), JSON.stringify(names))
check('so did a space, a percent and Cyrillic in one name',
  names.includes('звіт 100%.txt'), JSON.stringify(names))
check('each file was offered on its own, with a token of its own',
  new Set(offers.map((o) => o.data.token)).size === offers.length, JSON.stringify(names))
// The same file appeared twice in the selection; the phone should have been
// asked about it once, exactly as a drop of the same file twice is one send.
await wait(500)
const all = seen.filter((m) => m.t === 'ev' && m.event === 'file' && m.data?.direction === 'out')
check('and the duplicate in the selection was folded away',
  all.length === 2, JSON.stringify(all.map((o) => o.data.name)))
check('the daemon is still up after all of it', daemon.exitCode === null, `daemon exit ${daemon.exitCode}`)

cards = await notifications()
check('and the desktop was told, without a terminal to print into',
  cards.some((c) => c.join(' ').includes('Sent to phone')), JSON.stringify(cards))

phone.close()
done('the Nautilus context menu')
