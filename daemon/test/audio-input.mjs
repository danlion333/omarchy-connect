/**
 * The phone as an input this whole desktop can see.
 *
 * `audio.mjs` covers the sound arriving; this is what happens to it next. The
 * thing being tested is a `module-pipe-source` in somebody else's process, so
 * `pactl` here is a stand-in — loading the real module would leave a device in
 * the picker of the machine running the suite, and unloading it on a failure
 * would be a cleanup nobody can rely on.
 *
 * The stand-in is not a mock that only records arguments, though. On
 * `load-module` it does the one thing the real module does that matters: it
 * opens the FIFO for reading and copies it to a file. That is what lets the
 * suite assert on the bytes that came out of the far end of the pipe rather
 * than on the fact that a write was attempted — the difference between "the
 * daemon called `pactl`" and "sound reached a program that was not this one".
 *
 * The checks that are really about the issue: the source appears with the
 * right name and format; the samples the phone spoke come out of the pipe as
 * the interpolator meant them (`resample.mjs` is where the interpolator itself
 * is held to account); turning it on twice loads one module and not two; turning it off
 * unloads it and deletes the pipe; a daemon killed with the input on leaves no
 * orphan behind; a phone that vanishes mid-stream leaves the source loaded and
 * silent rather than broken; the default input is never touched; and a desktop
 * whose `pactl` cannot reach a sound server says it cannot do this at all.
 *
 * The stand-in reader is gated on a file so that the suite can also have the
 * case a person actually meets: the switch is on, the phone is already
 * speaking, and only then does somebody open Zoom and press record. What that
 * program must hear first is the last thing said, not the first — the pipe is
 * a delay, not a reserve.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { check, done } from '../../tools/test-harness.mjs'
import { connectPhone } from './phone.mjs'
import { quietBluetooth, localHeaders } from './sandbox.mjs'
import { amplify, buildFrame, RATE, CHUNK_MS } from '../src/lib/mic.js'
import { SOURCE_NAME, SOURCE_DESCRIPTION, RATE as SOURCE_RATE, ringMs } from '../src/lib/pipesource.js'
import { Upsampler } from '../src/lib/resample.js'

/**
 * The daemon writes the phone's chunks into the pipe at the module's rate,
 * not the phone's — that is how the latency came down (see `pipesource.js`).
 * So what the far end must hold is the interpolated sound, and the suite
 * grows the same interpolator the daemon does, fresh for every `on`, to say
 * what that is byte for byte.
 */
const FACTOR = SOURCE_RATE / RATE
const upsampled = () => new Upsampler({ factor: FACTOR })

const PORT = Number(process.env.PORT || 8823)
const DEAF_PORT = PORT + 1
const base = `http://127.0.0.1:${PORT}`
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'omarchy-connect-audio-input-'))
const local = () => localHeaders(path.join(sandbox, 'state'))

/* ── the stand-in sound server ─────────────────────────────────────────── */

const fakeBin = path.join(sandbox, 'bin')
const pulse = path.join(sandbox, 'pulse')
fs.mkdirSync(fakeBin, { recursive: true })
fs.mkdirSync(pulse, { recursive: true })

const modulesFile = path.join(pulse, 'modules')
const argsLog = path.join(pulse, 'pactl.log')
const capture = path.join(pulse, 'captured.raw')
fs.writeFileSync(modulesFile, '')

/**
 * When the stand-in starts *reading*, as opposed to when it opens the pipe.
 *
 * The two are different events and the difference is the whole of this issue.
 * The reader holds the read end from the moment the module is loaded, because
 * without it the daemon cannot open the write end at all; it starts draining
 * only once this file exists, which is the moment a program on the desktop
 * picks the source and presses record. Everything but the late-reader check
 * runs with it already there, which is the old behaviour exactly.
 */
const gate = path.join(pulse, 'reading')
fs.writeFileSync(gate, '')

fs.writeFileSync(
  path.join(pulse, 'reader.sh'),
  [
    '#!/bin/bash',
    // Holding the read end open is what makes a full pipe come back as EAGAIN
    // rather than the write end refusing to open at all.
    'exec 3< "$1"',
    'while [ ! -f "$2" ]; do sleep 0.02; done',
    'exec cat <&3 >> "$3"',
    '',
  ].join('\n'),
  { mode: 0o755 },
)

/**
 * `pactl`, reduced to the four verbs this daemon speaks to it — and to the one
 * behaviour that is not bookkeeping: a reader on the other end of the pipe.
 *
 * Without that reader nothing here would prove anything, because a FIFO with
 * no reader refuses to be opened for writing at all. With it, the file the
 * suite reads at the end holds exactly the bytes PipeWire would have handed to
 * whatever program had selected the source.
 */
fs.writeFileSync(
  path.join(fakeBin, 'pactl'),
  [
    '#!/bin/bash',
    `printf '%s\\n' "$*" >> ${JSON.stringify(argsLog)}`,
    `modules=${JSON.stringify(modulesFile)}`,
    `capture=${JSON.stringify(capture)}`,
    `pidfile=${JSON.stringify(path.join(pulse, 'reader.pid'))}`,
    `gate=${JSON.stringify(gate)}`,
    `reader=${JSON.stringify(path.join(pulse, 'reader.sh'))}`,
    'case "$1" in',
    '  info)',
    // The desktop that has the binary and no server: the whole capability
    // hangs off this exit code.
    '    if [ -n "$OMARCHY_TEST_NO_PULSE" ]; then echo "Connection failure: Connection refused" >&2; exit 1; fi',
    '    echo "Server String: fake"; exit 0;;',
    '  load-module)',
    '    for a in "$@"; do case "$a" in file=*) f="${a#file=}";; esac; done',
    '    idx=$(( $(wc -l < "$modules") + 700 ))',
    // The real module holds the read end open for as long as it is loaded —
    // and, like the real one, does not necessarily read from it.
    '    setsid bash "$reader" "$f" "$gate" "$capture" >/dev/null 2>&1 &',
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
    '  list)',
    '    if [ "$2" = "modules" ]; then cat "$modules"; fi',
    '    exit 0;;',
    'esac',
    'exit 0',
    '',
  ].join('\n'),
  { mode: 0o755 },
)

const modules = () =>
  fs
    .readFileSync(modulesFile, 'utf8')
    .split('\n')
    .filter((line) => line.includes('module-pipe-source'))

/* ── a daemon that can see it ──────────────────────────────────────────── */

quietBluetooth(sandbox, { port: PORT, deviceName: 'audio-input-test', devices: [] })

const runtime = path.join(sandbox, 'run')
fs.mkdirSync(runtime, { recursive: true })

const env = {
  ...process.env,
  PATH: `${fakeBin}:${process.env.PATH}`,
  HOME: sandbox,
  XDG_CONFIG_HOME: sandbox,
  XDG_CACHE_HOME: path.join(sandbox, '.cache'),
  XDG_RUNTIME_DIR: runtime,
  OMARCHY_CONNECT_STATE: path.join(sandbox, 'state'),
  OMARCHY_CONNECT_LOG: 'warn',
  TMUX_TMPDIR: sandbox,
}

const daemon = spawn(process.execPath, [path.join(root, 'bin', 'omarchy-connect.js'), 'start', '--port', String(PORT)], {
  env,
  stdio: ['ignore', 'ignore', 'inherit'],
})

let deaf = null
process.on('exit', () => {
  daemon.kill('SIGKILL')
  deaf?.kill('SIGKILL')
  fs.rmSync(sandbox, { recursive: true, force: true })
})

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitForDaemon(at) {
  for (let i = 0; i < 60; i += 1) {
    try {
      if ((await fetch(`${at}/api/info`)).ok) return
    } catch {
      await wait(250)
    }
  }
  throw new Error('daemon did not start')
}

const mic = (body, at = base) =>
  fetch(`${at}/api/mic`, { method: 'POST', headers: local(), body: JSON.stringify(body) }).then(async (r) => ({
    status: r.status,
    body: await r.json(),
  }))

/** The app's side: answers an `audio` instruction and can speak into it. */
async function connect(pairCode) {
  const info = await (await fetch(`${base}/api/info`)).json()
  const phone = connectPhone(PORT, info.publicKey)
  let stream = null
  let sent = 0

  const hello = await new Promise((resolve, reject) => {
    phone.ready
      .then(() =>
        phone.send({ t: 'hello', pairCode, device: { id: 'audio-input', name: 'Input Phone', platform: 'android' } }),
      )
      .catch(reject)
    phone.on((msg) => {
      if (msg.t === 'hello.ok') resolve(msg)
      if (msg.t === 'hello.err') reject(new Error(msg.error))
      if (msg.t === 'ev' && msg.event === 'audio') {
        if (msg.data.action === 'start') {
          stream = msg.data.stream
          phone.send({ t: 'req', id: 900 + stream, method: 'audio.started', params: { id: msg.data.id, ok: true } })
        }
        if (msg.data.action === 'stop') stream = null
      }
    })
  })

  const subscribed = new Promise((resolve) => phone.on((msg) => msg.t === 'sub.ok' && resolve(msg.events)))
  phone.send({ t: 'sub', events: ['audio'] })
  await subscribed

  /** Chunks of a ramp, so a pipe that delivered the wrong bytes is a failure. */
  const speak = (chunks) => {
    const bytes = (RATE * 2 * CHUNK_MS) / 1000
    const spoken = []
    for (let i = 0; i < chunks; i += 1) {
      const pcm = Buffer.alloc(bytes)
      for (let at = 0; at < bytes; at += 2) pcm.writeInt16LE(((sent * 977 + at) % 20000) - 10000, at)
      phone.sendBytes(buildFrame(stream ?? 0, sent, pcm))
      spoken.push(pcm)
      sent += 1
    }
    return Buffer.concat(spoken)
  }

  return { hello, phone, speak }
}

await waitForDaemon(base)

/* ── what the phone is told ────────────────────────────────────────────── */

const pair = await (await fetch(`${base}/api/pair-code`, { method: 'POST', headers: local() })).json()
const phone = await connect(pair.code)
const caps = phone.hello.capabilities?.audio?.input
check('a desktop with a sound server offers the phone as an input', caps?.available === true, JSON.stringify(caps))
check(
  'and names what a person will see in their picker',
  caps?.description === SOURCE_DESCRIPTION && caps?.name === SOURCE_NAME,
  JSON.stringify(caps),
)
check('which is off until somebody asks for it', caps?.enabled === false, JSON.stringify(caps))

/* ── switching it on ───────────────────────────────────────────────────── */

const on = await mic({ op: 'input', value: 'on' })
const input = on.body?.audio?.input
check('the switch answers with a loaded source', input?.enabled === true, JSON.stringify(on.body))
check('exactly one module is loaded for it', modules().length === 1, modules().join(' | '))
check(
  'declared at a multiple of the phone\'s rate, mono, under a name a person can find',
  /source_name=omarchy_connect_phone/.test(modules()[0]) &&
    /format=s16le/.test(modules()[0]) &&
    new RegExp(`rate=${SOURCE_RATE}\\b`).test(modules()[0]) &&
    /channels=1/.test(modules()[0]),
  modules()[0],
)
check(
  'a multiple that keeps PipeWire\'s ring under a tenth of a second',
  Number.isInteger(FACTOR) && FACTOR >= 1 && ringMs(SOURCE_RATE) <= 100,
  `${SOURCE_RATE} Hz is ${FACTOR}x, ring ${ringMs(SOURCE_RATE)} ms`,
)
check(
  'with a description that survives being parsed twice',
  /node\.description='Omarchy Connect \(phone\)'/.test(modules()[0]),
  modules()[0],
)
check(
  'and told to keep reading while nothing is listening',
  /node\.always-process=true/.test(modules()[0]),
  modules()[0],
)
check('and the switch says what the road costs', input?.rate === SOURCE_RATE && input?.ringMs === ringMs(SOURCE_RATE), JSON.stringify(input))
check(
  'and how the chunks are landing against it',
  Number.isInteger(input?.gapMaxMs) && Number.isInteger(input?.late) && input.late === 0,
  JSON.stringify({ gapMaxMs: input?.gapMaxMs, late: input?.late }),
)
check('and the pipe it reads exists', typeof input?.file === 'string' && fs.existsSync(input.file), String(input?.file))
check('turning it on also asks the handset to speak', input?.streaming === true, JSON.stringify(input))

/* ── the sound comes out of the other end ──────────────────────────────── */

// A gain of two, chosen here rather than left at the default, so that what
// comes out of the pipe is a number this file computed rather than a number
// this file copied from the daemon's own constant. It goes on the samples
// before they are interpolated, which is the order the daemon uses: the gain
// is the phone's level, the interpolation is the pipe's rate.
const GAIN = 2
const louder = await mic({ op: 'gain', value: GAIN })
check('the desktop can be told how loud the phone is', louder.body?.audio?.gain === GAIN, JSON.stringify(louder.body?.audio))

/** What the far end must hold for `n` chunks: the gain, then the pipe's rate. */
const willHear = (n) => expect.process(amplify(phone.speak(n), GAIN))

let expect = upsampled()
const spoken = willHear(20)
await wait(600)
const heard = fs.readFileSync(capture)
check(
  'everything the phone spoke came out of the pipe, interpolated, with the desktop gain on it and otherwise unchanged',
  heard.length >= spoken.length && heard.subarray(0, spoken.length).equals(spoken),
  `${heard.length} bytes out for ${spoken.length} in`,
)
check(
  'and the source itself is still the format it was declared as — the gain is on the samples, not on the device',
  /format=s16le/.test(modules()[0]) &&
    new RegExp(`rate=${SOURCE_RATE}\\b`).test(modules()[0]) &&
    /channels=1/.test(modules()[0]),
  modules()[0],
)

/* ── on top of itself ──────────────────────────────────────────────────── */

const again = await mic({ op: 'input', value: 'on' })
check('turning it on again is not a second device', modules().length === 1, modules().join(' | '))
check('and says so rather than failing', again.body?.audio?.input?.enabled === true, JSON.stringify(again.body))

/* ── the pipe is a delay, not a reserve ────────────────────────────────── */

// The order a person actually does this in: flip the switch, let the handset
// talk into a source nobody has selected yet, and only then open the program
// and press record. What that program hears first decides whether the phone is
// a microphone or a two-second echo of one.
await mic({ op: 'input', value: 'off' })
fs.rmSync(gate, { force: true })
const relit = await mic({ op: 'input', value: 'on' })
check('the switch comes back on with nothing yet reading the pipe', relit.body?.audio?.input?.enabled === true, JSON.stringify(relit.body?.audio?.input))

expect = upsampled()
const chunkBytes = (SOURCE_RATE * 2 * CHUNK_MS) / 1000
const from = fs.statSync(capture).size
// Forty chunks: well over twice what the pipe holds at the module's rate.
const said = willHear(40)
await wait(500)

const waiting = (await mic({ op: 'input', value: 'status' })).body?.audio?.input
check(
  'sound spoken into a source nobody selected is counted rather than kept',
  waiting?.dropped > 0 && waiting?.stalled === true,
  JSON.stringify({ dropped: waiting?.dropped, flushed: waiting?.flushed, stalled: waiting?.stalled }),
)
check(
  'and most of it was taken back out of the pipe rather than left standing in it',
  waiting?.flushed >= said.length - 4 * chunkBytes,
  `${waiting?.flushed} flushed of ${said.length} spoken`,
)

fs.writeFileSync(gate, '')
await wait(600)
const late = fs.readFileSync(capture).subarray(from)
check(
  'a program that presses record late hears the last thing said',
  late.length >= chunkBytes && late.subarray(0, chunkBytes).equals(said.subarray(said.length - chunkBytes)),
  `${late.length} bytes waiting for it`,
)
check(
  'and not four seconds of what it missed',
  late.length <= 2 * chunkBytes && !late.subarray(0, chunkBytes).equals(said.subarray(0, chunkBytes)),
  `${late.length} bytes, ${Math.round((late.length / chunkBytes) * CHUNK_MS)}ms in front of it`,
)

// A reader that is keeping up gets everything: the emptying stops the moment
// the far end proves it is collecting.
const running = fs.statSync(capture).size
const more = willHear(5)
await wait(500)
const heardLive = fs.readFileSync(capture).subarray(running)
check(
  'and once it is reading, nothing is thrown away in front of it any more',
  heardLive.length >= more.length && heardLive.subarray(0, more.length).equals(more),
  `${heardLive.length} bytes out for ${more.length} in`,
)

/* ── nothing is taken over ─────────────────────────────────────────────── */

const spoke = fs.readFileSync(argsLog, 'utf8')
check(
  'the default input is never changed behind anybody',
  !/set-default-source|set-default-sink/.test(spoke),
  spoke.split('\n').filter(Boolean).slice(0, 6).join(' / '),
)

/* ── a phone that vanishes mid-word ────────────────────────────────────── */

phone.speak(5)
await wait(150)
phone.phone.ws.terminate()
await wait(800)
const orphaned = await mic({ op: 'input', value: 'status' })
check(
  'a handset that drops leaves the input loaded rather than broken',
  orphaned.body?.audio?.input?.enabled === true && modules().length === 1,
  JSON.stringify(orphaned.body?.audio?.input),
)
check('and nothing is streaming into it any more', orphaned.body?.audio?.streaming === false, JSON.stringify(orphaned.body?.audio))
const afterDrop = fs.readFileSync(capture).length
await wait(400)
check(
  'a source nobody is speaking into stays silent instead of repeating itself',
  fs.readFileSync(capture).length === afterDrop,
  `${fs.readFileSync(capture).length} vs ${afterDrop}`,
)

/* ── switching it off ──────────────────────────────────────────────────── */

const fifo = input.file
const off = await mic({ op: 'input', value: 'off' })
check('switching it off answers with a switch that is off', off.body?.audio?.input?.enabled === false, JSON.stringify(off.body))
check('the module is unloaded', modules().length === 0, modules().join(' | '))
check('and the pipe is gone from the runtime directory', !fs.existsSync(fifo), fifo)
check('nothing is left running behind it', !fs.readFileSync(path.join(pulse, 'reader.pid'), 'utf8').trim())

/* ── a daemon that stops ───────────────────────────────────────────────── */

await mic({ op: 'input', value: 'on' })
check('the input can be switched on again after being off', modules().length === 1, modules().join(' | '))
daemon.kill('SIGTERM')
await new Promise((resolve) => {
  daemon.on('exit', resolve)
  setTimeout(resolve, 8000)
})
await wait(300)
check('a daemon told to stop takes its source with it', modules().length === 0, modules().join(' | '))

/* ── a desktop with no sound server ────────────────────────────────────── */

quietBluetooth(sandbox, { port: DEAF_PORT, deviceName: 'audio-input-deaf', devices: [] })
deaf = spawn(process.execPath, [path.join(root, 'bin', 'omarchy-connect.js'), 'start', '--port', String(DEAF_PORT)], {
  env: { ...env, OMARCHY_TEST_NO_PULSE: '1', OMARCHY_CONNECT_STATE: path.join(sandbox, 'state') },
  stdio: ['ignore', 'ignore', 'inherit'],
})
const deafBase = `http://127.0.0.1:${DEAF_PORT}`
await waitForDaemon(deafBase)

const deafInfo = await (await fetch(`${deafBase}/api/info`)).json()
const deafPhone = connectPhone(DEAF_PORT, deafInfo.publicKey)
const deafPair = await (
  await fetch(`${deafBase}/api/pair-code`, { method: 'POST', headers: local() })
).json()
const deafHello = await new Promise((resolve, reject) => {
  deafPhone.ready
    .then(() =>
      deafPhone.send({
        t: 'hello',
        pairCode: deafPair.code,
        device: { id: 'audio-input-deaf', name: 'Deaf Phone', platform: 'android' },
      }),
    )
    .catch(reject)
  deafPhone.on((msg) => {
    if (msg.t === 'hello.ok') resolve(msg)
    if (msg.t === 'hello.err') reject(new Error(msg.error))
  })
})
const deafCaps = deafHello.capabilities?.audio?.input
check(
  'a desktop whose pactl cannot reach a server does not offer the feature',
  deafCaps?.available === false,
  JSON.stringify(deafCaps),
)
const refused = await mic({ op: 'input', value: 'on' }, deafBase)
check('and refuses the switch with a sentence rather than a crash', refused.status === 400 && /pipewire-pulse/.test(refused.body?.error || ''), JSON.stringify(refused.body))
check('having loaded nothing', modules().length === 0, modules().join(' | '))

done('phone-as-desktop-input checks')
