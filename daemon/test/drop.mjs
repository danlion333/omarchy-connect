/**
 * What a file dropped on the bar icon becomes by the time the daemon sees it.
 *
 * The panel's new drop target is three lines of QML around one translation:
 * a drag carries `text/uri-list` and the CLI takes a path, and everything that
 * can go wrong between those two is in that translation. `file:///home/me/
 * holiday%20photo.png` has to come out as a path with a space in it, a URL
 * dragged out of a browser has to come out as nothing at all, and whatever
 * comes out has to be the one argument `send <file>` already accepts.
 *
 * That is why this suite lives beside the daemon rather than beside the QML.
 * QML cannot be run here — there is no bar and no compositor in a test — but
 * `Model.js` is ordinary JavaScript with a `.pragma` line on top, so the half
 * of the panel that does the translating can be loaded into a VM and asked
 * directly. The other half of the check is the half that matters: the paths it
 * produces are handed to the real CLI, against a real daemon, with a phone on
 * the other end that either hears the file offered under its right name or
 * does not. A drop that resolves to a path nobody can open is a bug this suite
 * would rather find than a unit test agreeing with itself.
 *
 * Nothing here touches the machine's own daemon, inbox or Bluetooth: it is all
 * a sandbox, a port of its own, and a phone written in Node.
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

const PORT = Number(process.env.PORT || 8813)
const base = `http://127.0.0.1:${PORT}`
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const repo = path.dirname(root)

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'omarchy-connect-drop-'))
const state = path.join(sandbox, 'state')
const local = () => localHeaders(state)
quietBluetooth(sandbox)

/* ── the panel's half, loaded out of the QML ──────────────────────────── */

// `.pragma library` is Quickshell's word for "this file has no QML around it",
// which is exactly what makes it loadable here; it is also not JavaScript, so
// it comes off before the file is evaluated.
const source = fs.readFileSync(path.join(repo, 'shell', 'Model.js'), 'utf8').replace(/^\.pragma .*$/m, '')
const Model = vm.createContext({})
vm.runInContext(source, Model, { filename: 'shell/Model.js' })

const drops = (...urls) => Model.dropPaths(urls)

check('a dropped file becomes its path', drops('file:///home/me/report.pdf')[0] === '/home/me/report.pdf',
  drops('file:///home/me/report.pdf')[0])
check('and an escaped space becomes a space',
  drops('file:///home/me/holiday%20photo.png')[0] === '/home/me/holiday photo.png',
  drops('file:///home/me/holiday%20photo.png')[0])
check('a name in Cyrillic survives the trip',
  drops('file:///home/me/%D0%B7%D0%B2%D1%96%D1%82.pdf')[0] === '/home/me/звіт.pdf',
  drops('file:///home/me/%D0%B7%D0%B2%D1%96%D1%82.pdf')[0])
// `100%.txt` is the same filename that once killed the upload route: a percent
// that is not the start of an escape throws out of `decodeURIComponent`, and a
// drop of five files should not lose the other four to it.
check('a stray percent costs the escape, not the file',
  drops('file:///home/me/100%.txt').length === 1, JSON.stringify(drops('file:///home/me/100%.txt')))
check('several files come back in the order they were dropped',
  drops('file:///a.txt', 'file:///b.txt', 'file:///c.txt').join(',') === '/a.txt,/b.txt,/c.txt')
check('the same file twice is sent once',
  drops('file:///a.txt', 'file:///a.txt').length === 1)
check('a link dragged out of a browser is not a file',
  drops('https://omarchy.org/', 'file:///a.txt').join(',') === '/a.txt',
  JSON.stringify(drops('https://omarchy.org/', 'file:///a.txt')))
check('neither is a file on somebody else\'s machine',
  drops('file://desktop-2/home/me/report.pdf').length === 0)
check('but localhost is this machine', drops('file://localhost/a.txt')[0] === '/a.txt')
check('an empty drag asks for nothing', drops().length === 0 && drops('', '  ').length === 0)

/* ── and the argv it hands the CLI ─────────────────────────────────────── */

const argvFor = (file) => Model.command({ exec: ['omarchy-connect'] }, ['send', file])
check('the path is one argument, whatever is in it',
  argvFor('/home/me/holiday photo.png').length === 3, JSON.stringify(argvFor('/home/me/holiday photo.png')))
check('and the command is the one the CLI documents',
  argvFor('/tmp/a').slice(0, 2).join(' ') === 'omarchy-connect send')
check('the name shown in the panel is the last segment',
  Model.fileName('/home/me/holiday photo.png') === 'holiday photo.png')

/* ── a daemon, a phone, and the files themselves ──────────────────────── */

const files = [
  path.join(sandbox, 'holiday photo.png'),
  path.join(sandbox, 'звіт 100%.txt'),
]
fs.writeFileSync(files[0], 'not really a png')
fs.writeFileSync(files[1], 'not really a report')

const daemon = spawn(
  process.execPath,
  [path.join(root, 'bin', 'omarchy-connect.js'), 'start', '--port', String(PORT)],
  {
    env: {
      ...process.env,
      HOME: sandbox,
      XDG_CONFIG_HOME: sandbox,
      OMARCHY_CONNECT_STATE: state,
      OMARCHY_CONNECT_LOG: 'error',
    },
    stdio: ['ignore', 'ignore', 'inherit'],
  },
)
process.on('exit', () => {
  daemon.kill('SIGTERM')
  fs.rmSync(sandbox, { recursive: true, force: true })
})

for (let i = 0; i < 40; i += 1) {
  try {
    if ((await fetch(`${base}/api/info`)).ok) break
  } catch {
    await new Promise((r) => setTimeout(r, 250))
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
  device: { id: 'drop-test-device', name: 'Test phone', platform: 'android', model: 'Test' },
})

const until = async (match, count = 1, ms = 8000) => {
  const deadline = Date.now() + ms
  for (;;) {
    const hits = seen.filter(match)
    if (hits.length >= count || Date.now() > deadline) return hits
    await new Promise((r) => setTimeout(r, 25))
  }
}

const [hello] = await until((m) => m.t === 'hello.ok' || m.t === 'hello.err')
check('the test phone paired', hello?.t === 'hello.ok', hello?.error)

// The app subscribes on every connection; a socket that has not asked for
// `file` is told nothing about one, which would make every check below pass
// for the wrong reason.
phone.send({ t: 'sub', events: ['file'] })
const [subscribed] = await until((m) => m.t === 'sub.ok')
check('and asked to hear about files', subscribed?.events?.includes('file'), JSON.stringify(subscribed?.events))

/**
 * One dropped file, sent the way the panel sends it: the argv the panel would
 * have built, spawned as a process, with no shell anywhere in the path.
 */
function send(file) {
  const [, ...args] = argvFor(file)
  return spawnSync(process.execPath, [path.join(root, 'bin', 'omarchy-connect.js'), ...args], {
    env: {
      ...process.env,
      HOME: sandbox,
      XDG_CONFIG_HOME: sandbox,
      OMARCHY_CONNECT_STATE: state,
      OMARCHY_CONNECT_LOG: 'error',
      PATH: `${sandbox}/bin:${process.env.PATH}`,
    },
    encoding: 'utf8',
  })
}

// A stand-in for libnotify ahead of the real one: the CLI raises its own card
// when it has no terminal to print into, which is exactly the case here, and a
// test run should not put two of them on the tester's desktop.
fs.mkdirSync(path.join(sandbox, 'bin'), { recursive: true })
fs.writeFileSync(path.join(sandbox, 'bin', 'notify-send'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })

const dropped = drops(...files.map((f) => `file://${encodeURI(f)}`))
check('the two awkward filenames survive being dragged', dropped.join('|') === files.join('|'), dropped.join('|'))

for (const file of dropped) {
  const run = send(file)
  check(`\`send\` accepts ${path.basename(file)} as dropped`, run.status === 0,
    run.status === 0 ? `exit 0` : (run.stderr || run.stdout || '').trim().split('\n').pop())
}

const offers = await until((m) => m.t === 'ev' && m.event === 'file' && m.data?.direction === 'out', 2)
check('the phone was offered both files', offers.length === 2, `${offers.length} of 2`)
check('each under the name it had on the desktop',
  offers.map((o) => o.data.name).join('|') === files.map((f) => path.basename(f)).join('|'),
  offers.map((o) => o.data.name).join('|'))
check('and in the order they were dropped', offers[0]?.data?.name === path.basename(files[0]))
check('every offer carries a token the phone can redeem', offers.every((o) => typeof o.data.token === 'string' && o.data.token.length > 0))

/* ── and when the drop cannot be honoured ─────────────────────────────── */

// The panel refuses a drop with no phone on the other end before it spawns
// anything, so the case left to the CLI is a path that is gone by the time the
// drop lands. It has to fail, and it has to say why: that sentence is what the
// panel puts in the card it raises instead.
{
  const run = send(path.join(sandbox, 'no-such-file.txt'))
  check('a file that is no longer there is refused', run.status !== 0, `exit ${run.status}`)
  check('and the refusal says what was wrong', /no such file/i.test(String(run.stderr) + String(run.stdout)),
    (run.stderr || run.stdout || '').trim().split('\n').pop())
}

check('the daemon is still up after all of it', daemon.exitCode === null, `daemon exit ${daemon.exitCode}`)

phone.close()
done('drop-to-send checks')
