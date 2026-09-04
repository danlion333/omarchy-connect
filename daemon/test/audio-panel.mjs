/**
 * The microphone, as the bar panel sees it.
 *
 * `audio.mjs` covers the sound arriving and `audio-input.mjs` covers it
 * becoming a source; this is the third half of the same feature — whether
 * anybody can *tell*. Until now the only sign that a phone was listening was
 * a line the person had typed themselves, and a microphone left on with
 * nothing on screen saying so is the one state a desktop must never keep to
 * itself.
 *
 * The panel has exactly one window on the daemon, `status.json`, and one way
 * back, the CLI. So the checks here are on the two ends of that:
 *
 *   - the snapshot carries `audio` at all — while the daemon runs, while it
 *     is stopped, and in `status --json`, which is what the panel's own liveness
 *     probe reads;
 *   - it is republished *when the state moves*, because a row that appears a
 *     minute after the phone started speaking is not a status row;
 *   - and `shell/Model.js`, loaded here the way `drop.mjs` loads it, turns
 *     that snapshot into the words and the visibility rules the panel draws.
 *
 * `pactl` is the same stand-in `audio-input.mjs` uses, for the same reason:
 * loading a real module would leave a device in the picker of the machine
 * running the suite.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

import { check, done } from '../../tools/test-harness.mjs'
import { connectPhone } from './phone.mjs'
import { quietBluetooth, localHeaders } from './sandbox.mjs'
import { SOURCE_NAME, SOURCE_DESCRIPTION } from '../src/lib/pipesource.js'

const PORT = Number(process.env.PORT || 8829)
const base = `http://127.0.0.1:${PORT}`
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const repo = path.dirname(root)

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'omarchy-connect-audio-panel-'))
const stateDir = path.join(sandbox, 'state')
const local = () => localHeaders(stateDir)

/* ── the stand-in sound server ─────────────────────────────────────────── */

const fakeBin = path.join(sandbox, 'bin')
const pulse = path.join(sandbox, 'pulse')
fs.mkdirSync(fakeBin, { recursive: true })
fs.mkdirSync(pulse, { recursive: true })
const modulesFile = path.join(pulse, 'modules')
fs.writeFileSync(modulesFile, '')

fs.writeFileSync(
  path.join(fakeBin, 'pactl'),
  [
    '#!/bin/bash',
    `modules=${JSON.stringify(modulesFile)}`,
    `pidfile=${JSON.stringify(path.join(pulse, 'reader.pid'))}`,
    'case "$1" in',
    '  info) echo "Server String: fake"; exit 0;;',
    '  load-module)',
    '    for a in "$@"; do case "$a" in file=*) f="${a#file=}";; esac; done',
    '    idx=$(( $(wc -l < "$modules") + 700 ))',
    // The real module holds the read end open; without a reader here the
    // daemon's non-blocking open of the write end has nothing to talk to.
    '    setsid cat "$f" > /dev/null 2>/dev/null &',
    '    echo $! > "$pidfile"',
    '    shift 1',
    '    printf "%s\\t%s\\t%s\\n" "$idx" "$*" "loaded" >> "$modules"',
    '    echo "$idx"; exit 0;;',
    '  unload-module)',
    '    [ -s "$pidfile" ] && kill "$(cat "$pidfile")" 2>/dev/null',
    '    : > "$pidfile"',
    '    grep -v "^$2\t" "$modules" > "$modules.new" || true',
    '    mv "$modules.new" "$modules"',
    '    exit 0;;',
    '  list) if [ "$2" = "modules" ]; then cat "$modules"; fi; exit 0;;',
    'esac',
    'exit 0',
    '',
  ].join('\n'),
  { mode: 0o755 },
)

/* ── the panel's half, loaded out of the QML ───────────────────────────── */

const source = fs.readFileSync(path.join(repo, 'shell', 'Model.js'), 'utf8').replace(/^\.pragma .*$/m, '')
const Model = vm.createContext({})
vm.runInContext(source, Model, { filename: 'shell/Model.js' })

/* ── the stopped daemon ────────────────────────────────────────────────── */

// The panel draws this desktop while the daemon is down, so the shape has to
// be there with the daemon down — the same promise `agents` and
// `phone.bluetooth` already make.
const cli = (args, env = {}) =>
  spawn(process.execPath, [path.join(root, 'bin', 'omarchy-connect.js'), ...args], {
    env: { ...baseEnv, ...env },
    stdio: ['ignore', 'pipe', 'ignore'],
  })

const readCli = (args, env = {}) =>
  new Promise((resolve) => {
    const child = cli(args, env)
    let out = ''
    child.stdout.on('data', (c) => {
      out += c
    })
    child.on('exit', () => resolve(out))
  })

quietBluetooth(sandbox, { port: PORT, deviceName: 'audio-panel-test', devices: [] })

const runtime = path.join(sandbox, 'run')
fs.mkdirSync(runtime, { recursive: true })

const baseEnv = {
  ...process.env,
  PATH: `${fakeBin}:${process.env.PATH}`,
  HOME: sandbox,
  XDG_CONFIG_HOME: sandbox,
  XDG_CACHE_HOME: path.join(sandbox, '.cache'),
  XDG_RUNTIME_DIR: runtime,
  OMARCHY_CONNECT_STATE: stateDir,
  OMARCHY_CONNECT_LOG: 'warn',
  TMUX_TMPDIR: sandbox,
}

const stopped = JSON.parse((await readCli(['status', '--json'])) || '{}')
check('a stopped daemon still publishes the microphone key', !!stopped.audio, JSON.stringify(stopped.audio ?? null))
check(
  'saying nothing is streaming and nothing is offered',
  stopped.audio?.streaming === false && stopped.audio?.input?.enabled === false,
  JSON.stringify(stopped.audio),
)
check(
  'and not claiming a sound server nothing is there to ask',
  stopped.audio?.input?.available === false && stopped.audio?.input?.name === SOURCE_NAME,
  JSON.stringify(stopped.audio?.input),
)
check(
  'so the panel offers no switch it could not carry out',
  Model.micShown(Model.audio(stopped)) === false,
  Model.micText(Model.audio(stopped), false),
)

/* ── a daemon that can hear ────────────────────────────────────────────── */

const daemon = spawn(process.execPath, [path.join(root, 'bin', 'omarchy-connect.js'), 'start', '--port', String(PORT)], {
  env: baseEnv,
  stdio: ['ignore', 'ignore', 'inherit'],
})

process.on('exit', () => {
  daemon.kill('SIGKILL')
  fs.rmSync(sandbox, { recursive: true, force: true })
})

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitForDaemon() {
  for (let i = 0; i < 60; i += 1) {
    try {
      if ((await fetch(`${base}/api/info`)).ok) return
    } catch {
      await wait(250)
    }
  }
  throw new Error('daemon did not start')
}

const mic = (body) =>
  fetch(`${base}/api/mic`, { method: 'POST', headers: local(), body: JSON.stringify(body) }).then(async (r) => ({
    status: r.status,
    body: await r.json(),
  }))

/** The status file, as the panel's FileView would read it. */
const published = () => {
  try {
    return JSON.parse(fs.readFileSync(path.join(stateDir, 'status.json'), 'utf8'))
  } catch {
    return null
  }
}

/**
 * Wait for the *file* to say something, not for a timer to go off.
 *
 * The point of the check that uses this is that the daemon republishes when
 * the microphone moves, so the window is short on purpose: a snapshot that
 * only refreshes on the next connection would run this out.
 */
async function until(predicate, ms = 4000) {
  const deadline = Date.now() + ms
  for (;;) {
    const snapshot = published()
    if (snapshot && predicate(snapshot)) return snapshot
    if (Date.now() > deadline) return snapshot
    await wait(50)
  }
}

/** The app's side: answers the instruction and then speaks. */
async function connect(pairCode) {
  const info = await (await fetch(`${base}/api/info`)).json()
  const phone = connectPhone(PORT, info.publicKey)
  const hello = await new Promise((resolve, reject) => {
    phone.ready
      .then(() =>
        phone.send({ t: 'hello', pairCode, device: { id: 'audio-panel', name: 'Panel Phone', platform: 'android' } }),
      )
      .catch(reject)
    phone.on((msg) => {
      if (msg.t === 'hello.ok') resolve(msg)
      if (msg.t === 'hello.err') reject(new Error(msg.error))
      if (msg.t === 'ev' && msg.event === 'audio' && msg.data.action === 'start') {
        phone.send({ t: 'req', id: 901, method: 'audio.started', params: { id: msg.data.id, ok: true } })
      }
    })
  })
  const subscribed = new Promise((resolve) => phone.on((msg) => msg.t === 'sub.ok' && resolve(msg.events)))
  phone.send({ t: 'sub', events: ['audio'] })
  await subscribed
  return { hello, phone }
}

await waitForDaemon()
const pair = await (await fetch(`${base}/api/pair-code`, { method: 'POST', headers: local() })).json()
const link = await connect(pair.code)

const idle = await until((s) => s.running === true)
check(
  'a running daemon publishes the microphone key too',
  idle?.audio?.streaming === false && idle?.audio?.input?.enabled === false,
  JSON.stringify(idle?.audio ?? null),
)
check(
  'and this desktop can offer the phone, so the panel draws the switch',
  idle?.audio?.input?.available === true && Model.micShown(Model.audio(idle)) === true,
  JSON.stringify(idle?.audio?.input),
)
check(
  'which reads as off until somebody flips it',
  Model.micText(Model.audio(idle), true) === `off · no phone in this machine's microphone list`,
  Model.micText(Model.audio(idle), true),
)

/* ── the switch the panel presses ──────────────────────────────────────── */

// The panel runs `mic input on` and reads the answer out of the file, so both
// ends of that round trip are what is checked.
const on = await mic({ op: 'input', value: 'on' })
check('the input switches on', on.body?.audio?.input?.enabled === true, JSON.stringify(on.body?.audio?.input))

const loaded = await until((s) => s.audio?.input?.enabled === true)
check(
  'and the status file says so without waiting for the panel to ask again',
  loaded?.audio?.input?.enabled === true,
  JSON.stringify(loaded?.audio?.input ?? null),
)
check(
  'named the way a person will see it in their picker',
  loaded?.audio?.input?.description === SOURCE_DESCRIPTION,
  JSON.stringify(loaded?.audio?.input?.description),
)

// Turning the input on also asks the handset to speak, so by here the stream
// is what the panel has to show a row for.
const speaking = await until((s) => s.audio?.streaming === true)
check(
  'a phone that is speaking shows up in the snapshot',
  speaking?.audio?.streaming === true && typeof speaking?.audio?.path === 'string',
  JSON.stringify({ streaming: speaking?.audio?.streaming, path: speaking?.audio?.path }),
)
const detail = Model.micDetail(Model.audio(speaking), Date.now())
check(
  'and the panel has a row with the duration and the file in it',
  detail !== '' && /\.wav$/.test(detail),
  detail,
)
check(
  'while the switch says the phone is speaking rather than merely loaded',
  /the phone is speaking/.test(Model.micText(Model.audio(speaking), true)),
  Model.micText(Model.audio(speaking), true),
)

/* ── and when the sound stops ──────────────────────────────────────────── */

await mic({ op: 'stop' })
const quiet = await until((s) => s.audio?.streaming === false)
check(
  'the stream ending is republished, so the row goes away on its own',
  quiet?.audio?.streaming === false,
  JSON.stringify(quiet?.audio ?? null),
)
check('and the panel draws no row for it', Model.micDetail(Model.audio(quiet), Date.now()) === '', 'empty')
check(
  'while the source stays loaded, because nobody asked for it to go',
  quiet?.audio?.input?.enabled === true,
  JSON.stringify(quiet?.audio?.input),
)

await mic({ op: 'input', value: 'off' })
const unloaded = await until((s) => s.audio?.input?.enabled === false)
check(
  'switching the input off is published too',
  unloaded?.audio?.input?.enabled === false,
  JSON.stringify(unloaded?.audio?.input ?? null),
)

/* ── the desktop that cannot do this at all ────────────────────────────── */

// Nothing here needs a daemon: it is the panel's rule about a snapshot whose
// `available` is false, which is what a machine with no pipewire-pulse
// publishes.
const deaf = { running: true, audio: { streaming: false, input: { available: false, enabled: false } } }
check(
  'a desktop with no pipewire-pulse is offered no switch',
  Model.micShown(Model.audio(deaf)) === false,
  Model.micText(Model.audio(deaf), true),
)
check(
  'and is told why rather than left with a control that fails',
  Model.micText(Model.audio(deaf), true) === 'this desktop has no pipewire-pulse',
  Model.micText(Model.audio(deaf), true),
)
// The one case where a switch has to be drawn anyway: a source is loaded and
// the only way back out is through it.
const stranded = { running: true, audio: { streaming: false, input: { available: false, enabled: true } } }
check(
  'but a loaded source keeps its off switch',
  Model.micShown(Model.audio(stranded)) === true,
  JSON.stringify(stranded.audio.input),
)

link.phone.close?.()
daemon.kill('SIGTERM')

// The daemon on its way out marks itself down, and the panel must not be left
// looking at a phone that is still speaking into a daemon that is gone.
const down = await until((s) => s.running === false, 6000)
check(
  'a stopped daemon leaves nothing streaming behind it',
  down?.audio?.streaming === false && down?.audio?.input?.enabled === false,
  JSON.stringify(down?.audio ?? null),
)

done('microphone panel checks')
