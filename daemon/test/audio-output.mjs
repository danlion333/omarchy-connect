/**
 * The phone as an output this whole desktop can pick.
 *
 * `audio-input.mjs` is this suite's mirror and the stand-in is built the same
 * way, for the same reason: the thing being tested is a `module-pipe-sink` in
 * somebody else's process, and loading the real module would leave a device in
 * the picker of the machine running the suite, with an unload on failure that
 * nobody can rely on.
 *
 * The stand-in is not a mock that records arguments, though. On `load-module`
 * it does the one thing the real module does that matters *in this direction*:
 * it opens the FIFO for writing and pushes PCM into it, exactly as a sink node
 * fed by a program on the desktop would. That is what lets the checks below be
 * about the bytes that came out of the far end of the socket rather than about
 * the fact that a `pactl` was called — the difference between "the daemon
 * loaded a sink" and "sound this desktop played reached the phone".
 *
 * What is really being asked here:
 *
 *   - the sink appears with the right name and format, exactly one of it, and
 *     goes away again — including when the daemon is killed with it on;
 *   - the desktop's sound reaches the handset as frames it can read, at the
 *     wire's rate, with the samples the desktop put in;
 *   - silence is not sent, because a loaded sink writes zeroes for as long as
 *     nothing is playing and a phone's track plays that silence for free;
 *   - a frame for a stream that has ended, or one with half a sample in it, is
 *     refused rather than glued onto the sound;
 *   - the socket dying mid-playback leaves the daemon alive and takes the sink
 *     down, so this desktop's sound goes back to its own speakers rather than
 *     into a pipe with nobody at the end of it;
 *   - and a desktop whose `pactl` cannot reach a sound server says so instead
 *     of offering a switch that can only fail.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { check, done } from '../../tools/test-harness.mjs'
import { connectPhone } from './phone.mjs'
import { quietBluetooth, localHeaders } from './sandbox.mjs'
import { RATE as WIRE_RATE, buildFrame, parseFrame, chunkBytes } from '../src/lib/speaker.js'
import { SINK_NAME, SINK_DESCRIPTION, RATE as SINK_RATE, ringMs, isSilent } from '../src/lib/pipesink.js'
import { Downsampler } from '../src/lib/resample.js'

const PORT = Number(process.env.PORT || 8831)
const DEAF_PORT = PORT + 1
const base = `http://127.0.0.1:${PORT}`
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'omarchy-connect-audio-output-'))
const local = () => localHeaders(path.join(sandbox, 'state'))

/* ── the stand-in sound server ─────────────────────────────────────────── */

const fakeBin = path.join(sandbox, 'bin')
const pulse = path.join(sandbox, 'pulse')
fs.mkdirSync(fakeBin, { recursive: true })
fs.mkdirSync(pulse, { recursive: true })

const modulesFile = path.join(pulse, 'modules')
const argsLog = path.join(pulse, 'pactl.log')
/** What a program on this desktop is "playing" — written into the pipe as-is. */
const playing = path.join(pulse, 'playing.raw')
fs.writeFileSync(modulesFile, '')
fs.writeFileSync(playing, '')

/**
 * The writer, which is what a `pipe-sink` is from this daemon's side.
 *
 * It holds the write end open for as long as the module is loaded — that is
 * what makes an empty pipe read as `EAGAIN` rather than as end-of-file, which
 * is the difference the daemon uses to decide whether the sink is still
 * there — and it copies whatever the suite has put in `playing.raw` into it,
 * once, the way a program that played a sound would.
 */
fs.writeFileSync(
  path.join(pulse, 'writer.sh'),
  [
    '#!/bin/bash',
    // Held for the life of the module, exactly as the real one holds it.
    'exec 3> "$1"',
    'last=0',
    'while true; do',
    '  size=$(stat -c %s "$2" 2>/dev/null || echo 0)',
    '  if [ "$size" -gt "$last" ]; then',
    '    tail -c +$((last + 1)) "$2" >&3',
    '    last=$size',
    '  fi',
    '  sleep 0.05',
    'done',
    '',
  ].join('\n'),
  { mode: 0o755 },
)

fs.writeFileSync(
  path.join(fakeBin, 'pactl'),
  [
    '#!/bin/bash',
    `printf '%s\\n' "$*" >> ${JSON.stringify(argsLog)}`,
    `modules=${JSON.stringify(modulesFile)}`,
    `playing=${JSON.stringify(playing)}`,
    `pidfile=${JSON.stringify(path.join(pulse, 'writer.pid'))}`,
    `writer=${JSON.stringify(path.join(pulse, 'writer.sh'))}`,
    'case "$1" in',
    '  info)',
    '    if [ -n "$OMARCHY_TEST_NO_PULSE" ]; then echo "Connection failure: Connection refused" >&2; exit 1; fi',
    '    echo "Server String: fake"; exit 0;;',
    '  load-module)',
    '    for a in "$@"; do case "$a" in file=*) f="${a#file=}";; esac; done',
    '    idx=$(( $(wc -l < "$modules") + 800 ))',
    '    setsid bash "$writer" "$f" "$playing" >/dev/null 2>&1 &',
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
    .filter((line) => line.includes('module-pipe-sink'))

/** Play something on this desktop: the bytes a sink would have written out. */
const play = (pcm) => fs.appendFileSync(playing, pcm)

/* ── a daemon that can be heard ────────────────────────────────────────── */

quietBluetooth(sandbox, { port: PORT, deviceName: 'audio-output-test', devices: [] })

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
  try {
    const pid = Number(fs.readFileSync(path.join(pulse, 'writer.pid'), 'utf8').trim())
    if (pid) process.kill(pid, 'SIGKILL')
  } catch {
    /* nothing left running */
  }
  fs.rmSync(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
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

const speaker = (body, at = base) =>
  fetch(`${at}/api/speaker`, { method: 'POST', headers: local(), body: JSON.stringify(body) }).then(async (r) => ({
    status: r.status,
    body: await r.json(),
  }))

/** The app's side: answers a `play` instruction and collects what arrives. */
async function connect(greeting) {
  const info = await (await fetch(`${base}/api/info`)).json()
  const phone = connectPhone(PORT, info.publicKey)
  const heard = []
  let stream = null
  let hushes = 0

  let paired = null
  const hello = await new Promise((resolve, reject) => {
    phone.ready
      .then(() =>
        phone.send({ ...greeting, t: 'hello', device: { id: 'audio-output', name: 'Output Phone', platform: 'android' } }),
      )
      .catch(reject)
    phone.on((msg) => {
      // The token is handed out once, with the pairing. A second socket for
      // the same handset greets with it rather than with a code, exactly as
      // the app does after its first run.
      if (msg.t === 'paired') paired = msg.token
      if (msg.t === 'hello.ok') resolve(msg)
      if (msg.t === 'hello.err') reject(new Error(msg.error))
      if (msg.t === 'ev' && msg.event === 'audio') {
        if (msg.data.action === 'play') {
          stream = msg.data.stream
          phone.send({ t: 'req', id: 800 + stream, method: 'audio.playing', params: { id: msg.data.id, ok: true } })
        }
        if (msg.data.action === 'hush') {
          hushes += 1
          stream = null
        }
      }
    })
  })

  phone.onChunk((chunk) => heard.push(chunk))

  const subscribed = new Promise((resolve) => phone.on((msg) => msg.t === 'sub.ok' && resolve(msg.events)))
  phone.send({ t: 'sub', events: ['audio'] })
  await subscribed

  return { hello, phone, heard, token: paired, hushes: () => hushes, stream: () => stream }
}

/** Wait for a condition the daemon reaches on its own timer, or give up. */
async function until(predicate, ms = 4000) {
  const deadline = Date.now() + ms
  for (;;) {
    if (predicate()) return true
    if (Date.now() > deadline) return false
    await wait(25)
  }
}

await waitForDaemon(base)

/* ── what the phone is told ────────────────────────────────────────────── */

const pair = await (await fetch(`${base}/api/pair-code`, { method: 'POST', headers: local() })).json()
const link = await connect({ pairCode: pair.code })
/** What a reconnect greets with — a pairing is not handed out twice. */
const token = link.token
const caps = link.hello.capabilities?.audio?.output
check('a desktop with a sound server offers the phone as an output', caps?.available === true, JSON.stringify(caps))
check(
  'under the name a person will read in their picker',
  caps?.name === SINK_NAME && caps?.description === SINK_DESCRIPTION,
  JSON.stringify(caps),
)
check('which is off until somebody asks for it', caps?.enabled === false, JSON.stringify(caps))
check(
  'and the format it will send is the wire\'s own',
  link.hello.capabilities?.audio?.play?.rate === WIRE_RATE &&
    link.hello.capabilities?.audio?.play?.channels === 1,
  JSON.stringify(link.hello.capabilities?.audio?.play),
)

/* ── the switch ────────────────────────────────────────────────────────── */

const on = await speaker({ op: 'on' })
const output = on.body?.audio?.output
check('the switch answers with a loaded sink', output?.enabled === true, JSON.stringify(on.body))
check('exactly one module is loaded for it', modules().length === 1, modules().join(' | '))
check(
  'as a pipe-sink under this desktop\'s own name',
  /module-pipe-sink/.test(modules()[0] || '') && new RegExp(`sink_name=${SINK_NAME}`).test(modules()[0] || ''),
  modules()[0],
)
check(
  'in the format the wire multiplies up from',
  /format=s16le/.test(modules()[0] || '') && new RegExp(`rate=${SINK_RATE}`).test(modules()[0] || '') && /channels=1/.test(modules()[0] || ''),
  modules()[0],
)
check(
  'described the way it will appear in an output picker',
  modules()[0]?.includes(`node.description='${SINK_DESCRIPTION}'`),
  modules()[0],
)
check('and the switch says what the road costs', output?.rate === SINK_RATE && output?.ringMs === ringMs(SINK_RATE), JSON.stringify(output))
const fifo = output?.file
check('the pipe it reads exists', typeof fifo === 'string' && fs.existsSync(fifo), String(fifo))
check('turning it on also asks the handset to play', output?.playing === true, JSON.stringify(output))

/* ── sound that this desktop plays ─────────────────────────────────────── */

// A ramp rather than noise, so a chunk that arrived shifted, doubled or in the
// wrong order is a failure rather than something nobody can see.
const seconds = 0.25
const samples = Math.round(SINK_RATE * seconds)
const source = Buffer.alloc(samples * 2)
for (let i = 0; i < samples; i += 1) source.writeInt16LE(Math.round(12000 * Math.sin((2 * Math.PI * 440 * i) / SINK_RATE)), i * 2)
// In fifths of what it is, with a pause between them, because that is what a
// sink does: it writes at real time. Handing the daemon a quarter of a second
// in one go would be a backlog rather than playback, and the daemon would
// rightly drop the front of it (`MAX_BACKLOG_MS`) — which is a different
// property, and the one the `dropped` counter is for.
for (let at = 0; at < source.length; at += Math.round(source.length / 5)) {
  play(source.subarray(at, at + Math.round(source.length / 5)))
  await wait(120)
}

const wanted = Math.floor((samples / (SINK_RATE / WIRE_RATE)) / (chunkBytes() / 2)) - 2
const arrived = await until(() => link.heard.length >= wanted, 8000)
check(`the desktop's sound reaches the phone (${link.heard.length} chunks)`, arrived, `wanted ${wanted}`)
check(
  'as frames the phone can read, numbered from zero and in order',
  link.heard.every((c, i) => c.seq === i && c.stream === link.stream()),
  JSON.stringify(link.heard.slice(0, 3).map((c) => ({ stream: c.stream, seq: c.seq }))),
)
check(
  'each carrying one chunk of the agreed length',
  link.heard.every((c) => c.pcm.length === chunkBytes()),
  String(link.heard[0]?.pcm.length),
)

// What the phone got is what the desktop played, taken down to the wire's rate
// by the very interpolator's mirror the daemon used. Held sample for sample
// rather than approximately: the decimator is deterministic, so anything else
// means the two ends disagree about the arithmetic.
const expected = new Downsampler({ factor: SINK_RATE / WIRE_RATE }).process(source)
const got = Buffer.concat(link.heard.map((c) => Buffer.from(c.pcm)))
check(
  'and the samples are the ones this desktop played, at the wire\'s rate',
  got.length > 0 && expected.subarray(0, got.length).equals(got),
  `${got.length} of ${expected.length} bytes`,
)

/* ── and the silence it does not ───────────────────────────────────────── */

await wait(400) // whatever was still in the pipe from the sound above
const before = link.heard.length
play(Buffer.alloc(SINK_RATE * 2 * 0.2)) // a fifth of a second of pure silence
await wait(700)
check(
  'no chunk of silence is carried across the link',
  link.heard.every((c) => !isSilent(c.pcm)),
  `${link.heard.filter((c) => isSilent(c.pcm)).length} silent chunks`,
)
// One chunk may still arrive at the seam, and it is not silence: it is the
// tail of the sound above with zeroes behind it, which is exactly what a
// twenty-millisecond chunk of the moment a track stopped contains.
check('and nothing beyond the seam between the sound and the silence', link.heard.length - before <= 1, `${link.heard.length - before} chunks`)
check('which is what makes it free', isSilent(Buffer.alloc(64)) && !isSilent(source.subarray(0, 64)))

const status = await speaker({ op: 'status' })
check(
  'and the switch counts it as silence rather than as loss',
  (status.body?.audio?.output?.silent || 0) > 0,
  JSON.stringify({ silent: status.body?.audio?.output?.silent, chunks: status.body?.audio?.output?.chunks }),
)

/* ── frames that must not be played ────────────────────────────────────── */

// The phone's own parser is what refuses these, and it is held to that here
// because the desktop is the only end that can build a malformed one on
// purpose. A chunk of a run that has ended and half a sample are the two the
// issue names.
let refusedOdd = null
try {
  parseFrame(buildFrame(1, 0, Buffer.alloc(641)))
} catch (err) {
  refusedOdd = err.message
}
check('a frame with half a sample in it is refused', /whole number of samples/.test(refusedOdd || ''), String(refusedOdd))
check(
  'and a frame of a stream nobody is playing is recognisable as one',
  parseFrame(buildFrame(99, 0, Buffer.alloc(640))).stream === 99,
)

/* ── on again, and off by hand ─────────────────────────────────────────── */

const twice = await speaker({ op: 'on' })
check('turning it on again is not a second device', modules().length === 1, modules().join(' | '))
check('and says so rather than failing', twice.body?.audio?.output?.enabled === true, JSON.stringify(twice.body))

const off = await speaker({ op: 'off' })
check('switching it off answers with a switch that is off', off.body?.audio?.output?.enabled === false, JSON.stringify(off.body))
check('the module is unloaded', modules().length === 0, modules().join(' | '))
check('the pipe is gone from the runtime directory', !fs.existsSync(fifo), fifo)
check('and the handset was told to stop playing', await until(() => link.hushes() > 0, 2000), String(link.hushes()))

const again = await speaker({ op: 'on' })
check('the switch can be turned on again afterwards', again.body?.audio?.output?.enabled === true, JSON.stringify(again.body?.audio?.output))
check('with one module and not two', modules().length === 1, modules().join(' | '))

/* ── the socket that dies mid-playback ─────────────────────────────────── */

link.phone.close()
const unloaded = await until(() => modules().length === 0, 6000)
check('a socket that dies mid-playback takes the sink with it', unloaded, modules().join(' | '))
check('and the pipe with it', !fs.existsSync(fifo), String(fifo))

// The whole point of the check above is what it leaves behind: a daemon.
const alive = await fetch(`${base}/api/info`).then((r) => r.ok).catch(() => false)
check('while the daemon is still running', alive === true)

const after = await speaker({ op: 'status' })
check(
  'and says the phone is no longer playing',
  after.body?.audio?.output?.enabled === false && after.body?.audio?.output?.playing === false,
  JSON.stringify(after.body?.audio?.output),
)

/* ── a daemon that is killed with it on ────────────────────────────────── */

const relit = await connect({ token })
const back = await speaker({ op: 'on' })
check('a reconnected phone can be offered the sink again', back.body?.audio?.output?.playing === true, JSON.stringify(back.body?.audio?.output))
check('with one module and not two', modules().length === 1, modules().join(' | '))
daemon.kill('SIGTERM')
const reaped = await until(() => modules().length === 0, 8000)
check('a daemon told to stop takes its sink with it', reaped, modules().join(' | '))
relit.phone.close()

/* ── a desktop with no sound server at all ─────────────────────────────── */

// The same daemon code with a `pactl` that cannot reach a server: the switch
// must refuse with a sentence rather than load anything or crash.
fs.writeFileSync(modulesFile, '')
deaf = spawn(process.execPath, [path.join(root, 'bin', 'omarchy-connect.js'), 'start', '--port', String(DEAF_PORT)], {
  env: { ...env, OMARCHY_TEST_NO_PULSE: '1', OMARCHY_CONNECT_STATE: path.join(sandbox, 'deaf-state') },
  stdio: ['ignore', 'ignore', 'inherit'],
})
const deafBase = `http://127.0.0.1:${DEAF_PORT}`
await waitForDaemon(deafBase)
const deafLocal = () => localHeaders(path.join(sandbox, 'deaf-state'))
const refused = await fetch(`${deafBase}/api/speaker`, {
  method: 'POST',
  headers: deafLocal(),
  body: JSON.stringify({ op: 'on' }),
}).then(async (r) => ({ status: r.status, body: await r.json() }))
check(
  'a desktop with no pipewire-pulse refuses the switch with a sentence',
  refused.status === 400 && /pipewire-pulse/.test(refused.body?.error || ''),
  JSON.stringify(refused.body),
)
check('having loaded nothing', modules().length === 0, modules().join(' | '))
deaf.kill('SIGTERM')

done('phone speaker checks')
