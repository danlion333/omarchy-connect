/**
 * The phone as a headset: both directions at once, and the order they go up in.
 *
 * `audio-input.mjs` and `audio-output.mjs` each prove one direction, and this
 * suite deliberately does not prove either of them again. What it is about is
 * the thing that only exists when they are switched on together, which is an
 * *order*: everything Android will do about a phone hearing its own
 * loudspeaker — one shared audio session, the communication source, an
 * `AcousticEchoCanceler` bound to that session — is fixed at the moment the
 * handset constructs its recorder and its track. So the desktop has to put the
 * phone into the mode before either end opens, and open the microphone before
 * the track, or the duplex comes up in exactly the state that howls, with a
 * green switch and nothing anywhere saying why.
 *
 * That order is invisible on the desktop and it is the whole feature, so the
 * stand-in phone here writes down every instruction it is given in sequence
 * and the checks are about the sequence.
 *
 * The rest is what a person would do to it afterwards, and each of these is an
 * acceptance criterion of the issue that a test can hold:
 *
 *   - the desktop reports what the *handset* said about the echo — a phone
 *     with no canceller is a working duplex that echoes, and the switch says
 *     so rather than answering a bare "on";
 *   - turning off one of the two directions leaves the other one running;
 *   - when the last of them ends, whatever ended it, the phone is told to
 *     leave the mode — a handset left in `MODE_IN_COMMUNICATION` with its
 *     communication device forced to the loudspeaker gets its *own* calls and
 *     music wrong afterwards, which is the one bug here that would be felt
 *     outside this app;
 *   - a socket that dies is the same case with nobody to tell;
 *   - and a desktop with no sound server refuses the switch with a sentence
 *     rather than offering something that can only fail.
 *
 * `pactl` is the stand-in both of the older suites use, with both halves in
 * it, because a headset loads a source and a sink at once. It is not a mock
 * that records arguments: the reader and the writer really hold their ends of
 * the FIFOs open, which is what lets the sound below cross in both directions
 * at the same time rather than in two tests that each pretend the other.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { check, done } from '../../tools/test-harness.mjs'
import { connectPhone } from './phone.mjs'
import { quietBluetooth, localHeaders } from './sandbox.mjs'
import { buildFrame as buildMicFrame, RATE as MIC_RATE, CHUNK_MS as MIC_CHUNK_MS } from '../src/lib/mic.js'
import { SOURCE_NAME } from '../src/lib/pipesource.js'
import { SINK_NAME, RATE as SINK_RATE } from '../src/lib/pipesink.js'

const PORT = Number(process.env.PORT || 8837)
const DEAF_PORT = PORT + 1
const base = `http://127.0.0.1:${PORT}`
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'omarchy-connect-headset-'))
const local = () => localHeaders(path.join(sandbox, 'state'))

/* ── the stand-in sound server, both halves ────────────────────────────── */

const fakeBin = path.join(sandbox, 'bin')
const pulse = path.join(sandbox, 'pulse')
fs.mkdirSync(fakeBin, { recursive: true })
fs.mkdirSync(pulse, { recursive: true })

const modulesFile = path.join(pulse, 'modules')
/** What the phone said, as a program selecting the source would have heard it. */
const capture = path.join(pulse, 'captured.raw')
/** What a program on this desktop is playing, written into the sink's pipe. */
const playing = path.join(pulse, 'playing.raw')
fs.writeFileSync(modulesFile, '')
fs.writeFileSync(playing, '')

fs.writeFileSync(
  path.join(pulse, 'reader.sh'),
  ['#!/bin/bash', 'exec 3< "$1"', 'exec cat <&3 >> "$2"', ''].join('\n'),
  { mode: 0o755 },
)

fs.writeFileSync(
  path.join(pulse, 'writer.sh'),
  [
    '#!/bin/bash',
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
    `modules=${JSON.stringify(modulesFile)}`,
    `capture=${JSON.stringify(capture)}`,
    `playing=${JSON.stringify(playing)}`,
    `pids=${JSON.stringify(path.join(pulse, 'pids'))}`,
    `reader=${JSON.stringify(path.join(pulse, 'reader.sh'))}`,
    `writer=${JSON.stringify(path.join(pulse, 'writer.sh'))}`,
    'case "$1" in',
    '  info)',
    '    if [ -n "$OMARCHY_TEST_NO_PULSE" ]; then echo "Connection failure: Connection refused" >&2; exit 1; fi',
    '    echo "Server String: fake"; exit 0;;',
    '  load-module)',
    '    for a in "$@"; do case "$a" in file=*) f="${a#file=}";; esac; done',
    '    idx=$(( $(wc -l < "$modules") + 900 ))',
    // Which end of the pipe this module holds is the whole difference between
    // the two directions, and a headset loads one of each.
    '    case "$2" in',
    '      module-pipe-source) setsid bash "$reader" "$f" "$capture" >/dev/null 2>&1 & ;;',
    '      module-pipe-sink) setsid bash "$writer" "$f" "$playing" >/dev/null 2>&1 & ;;',
    '    esac',
    '    printf "%s\\t%s\\n" "$idx" "$!" >> "$pids"',
    '    shift 1',
    '    printf "%s\\t%s\\t%s\\n" "$idx" "$*" "loaded" >> "$modules"',
    '    echo "$idx"; exit 0;;',
    '  unload-module)',
    '    pid=$(grep "^$2\t" "$pids" 2>/dev/null | cut -f2)',
    '    [ -n "$pid" ] && kill "$pid" 2>/dev/null',
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
    .filter((line) => /module-pipe-(source|sink)/.test(line))

const loaded = (kind) => modules().filter((line) => line.includes(`module-pipe-${kind}`))
/** Play something on this desktop: the bytes a sink would have written out. */
const play = (pcm) => fs.appendFileSync(playing, pcm)
const captured = () => {
  try {
    return fs.readFileSync(capture)
  } catch {
    return Buffer.alloc(0)
  }
}

/* ── a daemon with both ears ───────────────────────────────────────────── */

quietBluetooth(sandbox, { port: PORT, deviceName: 'headset-test', devices: [] })

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
    for (const line of fs.readFileSync(path.join(pulse, 'pids'), 'utf8').split('\n')) {
      const pid = Number(line.split('\t')[1])
      if (pid) process.kill(pid, 'SIGKILL')
    }
  } catch {
    /* nothing left running */
  }
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

const post = (endpoint, body, at = base, headers = local) =>
  fetch(`${at}${endpoint}`, { method: 'POST', headers: headers(), body: JSON.stringify(body) }).then(async (r) => ({
    status: r.status,
    body: await r.json(),
  }))

const headset = (op) => post('/api/headset', { op })
const mic = (op) => post('/api/mic', { op })
const speaker = (op) => post('/api/speaker', { op })

/**
 * The app's side of a headset: it answers all three instructions and, above
 * all, writes down the order they arrived in.
 *
 * `aec` is what this pretend handset claims about its echo canceller, so the
 * suite can be both kinds of phone — one that has one and one that does not.
 */
async function connect(greeting, { aec = { available: true, enabled: true }, refuse = null } = {}) {
  const info = await (await fetch(`${base}/api/info`)).json()
  const phone = connectPhone(PORT, info.publicKey)
  /** Every `audio` instruction, in order, as `action` (with `on` for a mode). */
  const told = []
  const heard = []
  let micStream = null
  let playStream = null
  let mode = false
  let paired = null

  const hello = await new Promise((resolve, reject) => {
    phone.ready
      .then(() =>
        phone.send({ ...greeting, t: 'hello', device: { id: 'headset', name: 'Headset Phone', platform: 'android' } }),
      )
      .catch(reject)
    phone.on((msg) => {
      if (msg.t === 'paired') paired = msg.token
      if (msg.t === 'hello.ok') resolve(msg)
      if (msg.t === 'hello.err') reject(new Error(msg.error))
      if (msg.t !== 'ev' || msg.event !== 'audio') return
      const data = msg.data || {}
      if (data.action === 'headset') {
        told.push(data.on === false ? 'headset:off' : 'headset:on')
        if (!data.id) return
        if (refuse) {
          return phone.send({
            t: 'req',
            id: 900,
            method: 'audio.wearing',
            params: { id: data.id, ok: false, error: refuse },
          })
        }
        mode = data.on !== false
        return phone.send({
          t: 'req',
          id: 901,
          method: 'audio.wearing',
          params: { id: data.id, ok: true, on: mode, aec },
        })
      }
      if (data.action === 'start') {
        told.push('mic:start')
        micStream = data.stream
        return phone.send({ t: 'req', id: 902, method: 'audio.started', params: { id: data.id, ok: true } })
      }
      if (data.action === 'stop') {
        told.push('mic:stop')
        micStream = null
        return undefined
      }
      if (data.action === 'play') {
        told.push('play:start')
        playStream = data.stream
        return phone.send({ t: 'req', id: 903, method: 'audio.playing', params: { id: data.id, ok: true } })
      }
      if (data.action === 'hush') {
        told.push('play:stop')
        playStream = null
        return undefined
      }
      return undefined
    })
  })

  phone.onChunk((chunk) => heard.push(chunk))

  const subscribed = new Promise((resolve) => phone.on((msg) => msg.t === 'sub.ok' && resolve(msg.events)))
  phone.send({ t: 'sub', events: ['audio'] })
  await subscribed

  return {
    hello,
    phone,
    told,
    heard,
    token: paired,
    mode: () => mode,
    micStream: () => micStream,
    playStream: () => playStream,
    /** One chunk of the room, the way the native recorder sends it. */
    speak: (pcm, seq) => phone.sendBytes(buildMicFrame(micStream, seq, pcm)),
  }
}

async function until(predicate, ms = 4000) {
  const deadline = Date.now() + ms
  for (;;) {
    if (predicate()) return true
    if (Date.now() > deadline) return false
    await wait(25)
  }
}

await waitForDaemon(base)

/* ── what the phone is told it can be ──────────────────────────────────── */

const pair = await (await fetch(`${base}/api/pair-code`, { method: 'POST', headers: local() })).json()
const link = await connect({ pairCode: pair.code })
const token = link.token
const caps = link.hello.capabilities?.audio?.headset
check('a desktop with a sound server offers the phone as a headset', caps?.available === true, JSON.stringify(caps))
check('which is off until somebody asks for it', caps?.on === false, JSON.stringify(caps))

/* ── the order, which is the whole feature ─────────────────────────────── */

const on = await headset('on')
const state = on.body?.audio?.headset
check('the switch answers with a headset that is on', state?.on === true, JSON.stringify(on.body?.audio?.headset))
check(
  'the phone was put into the mode before either end was opened',
  link.told.indexOf('headset:on') === 0 && link.told.indexOf('headset:on') < link.told.indexOf('mic:start'),
  link.told.join(' → '),
)
check(
  'and its microphone was opened before its speaker, which is what the canceller needs',
  link.told.indexOf('mic:start') < link.told.indexOf('play:start'),
  link.told.join(' → '),
)
check('with both directions actually up', state?.listening === true && state?.playing === true, JSON.stringify(state))
check(
  'a source and a sink, one of each',
  loaded('source').length === 1 && loaded('sink').length === 1,
  modules().join(' | '),
)
check(
  'under the names a person picks in their own mixer',
  loaded('source')[0]?.includes(SOURCE_NAME) && loaded('sink')[0]?.includes(SINK_NAME),
  modules().join(' | '),
)
check(
  'and the desktop repeats what the handset said about the echo',
  state?.echoCancellation === true && state?.aec?.enabled === true,
  JSON.stringify(state?.aec),
)

/* ── both directions carrying sound at the same time ───────────────────── */

// A ramp, so a chunk that arrived doubled or out of order is a failure rather
// than something nobody can see.
const chunkSamples = (MIC_RATE * MIC_CHUNK_MS) / 1000
const said = Buffer.alloc(chunkSamples * 2)
for (let i = 0; i < chunkSamples; i += 1) said.writeInt16LE(Math.round(9000 * Math.sin((2 * Math.PI * 300 * i) / MIC_RATE)), i * 2)

const desktopSound = Buffer.alloc(SINK_RATE * 2 * 0.1)
for (let i = 0; i < desktopSound.length / 2; i += 1) {
  desktopSound.writeInt16LE(Math.round(11000 * Math.sin((2 * Math.PI * 440 * i) / SINK_RATE)), i * 2)
}

// Up and down at once, which is the state a call is in and the one no other
// suite has ever put this daemon in.
for (let i = 0; i < 10; i += 1) {
  link.speak(said, i)
  play(desktopSound.subarray(i * (desktopSound.length / 10), (i + 1) * (desktopSound.length / 10)))
  await wait(60)
}

check(
  'what the phone said reaches a program on this desktop',
  await until(() => captured().length > 0, 6000),
  `${captured().length} bytes`,
)
check(
  'while what this desktop played reaches the phone',
  await until(() => link.heard.length > 0, 6000),
  `${link.heard.length} chunks`,
)
check(
  'on the stream the desktop handed out for it',
  link.heard.every((c) => c.stream === link.playStream()),
  JSON.stringify(link.heard.slice(0, 2).map((c) => c.stream)),
)
const both = await headset('status')
check(
  'and the switch says both halves are live at once',
  both.body?.audio?.headset?.listening === true && both.body?.audio?.headset?.playing === true,
  JSON.stringify(both.body?.audio?.headset),
)

/* ── one switch off leaves the other working ───────────────────────────── */

const heardBefore = link.heard.length
await mic('stop')
check('stopping the microphone leaves the phone playing', link.playStream() !== null, String(link.playStream()))
const stillOn = await headset('status')
check(
  'and the headset with it, because half of it is still running',
  stillOn.body?.audio?.headset?.on === true && stillOn.body?.audio?.headset?.listening === false,
  JSON.stringify(stillOn.body?.audio?.headset),
)
play(desktopSound)
check(
  'with this desktop\'s sound still arriving',
  await until(() => link.heard.length > heardBefore, 6000),
  `${link.heard.length - heardBefore} more chunks`,
)

// And now the other way round: the microphone alone, with the speaker off.
await headset('off')
check('switching the headset off tells the phone to leave the mode', link.told.includes('headset:off'), link.told.join(' → '))
const back = await headset('on')
check('and it can be switched on again', back.body?.audio?.headset?.on === true, JSON.stringify(back.body?.audio?.headset))
await speaker('off')
check('switching the speaker off leaves the microphone streaming', link.micStream() !== null, String(link.micStream()))
const micOnly = await headset('status')
check(
  'and the headset on, because the other half is still running',
  micOnly.body?.audio?.headset?.on === true && micOnly.body?.audio?.headset?.playing === false,
  JSON.stringify(micOnly.body?.audio?.headset),
)

/* ── nothing left of either direction ──────────────────────────────────── */

const beforeLast = link.told.filter((t) => t === 'headset:off').length
await mic('stop')
check(
  'the last direction to end takes the mode with it, so the phone is not left in it',
  await until(() => link.told.filter((t) => t === 'headset:off').length > beforeLast, 4000),
  link.told.join(' → '),
)
const gone = await headset('status')
check('and the desktop agrees the headset is off', gone.body?.audio?.headset?.on === false, JSON.stringify(gone.body?.audio?.headset))

/* ── a handset with no echo canceller ──────────────────────────────────── */

link.phone.close()
await until(() => loaded('sink').length === 0, 6000)
const plain = await connect({ token }, { aec: { available: false, enabled: false } })
const honest = await headset('on')
check(
  'a phone with no canceller is still a headset',
  honest.body?.audio?.headset?.on === true,
  JSON.stringify(honest.body?.audio?.headset),
)
check(
  'and the desktop says the echo is not being cancelled rather than claiming it is',
  honest.body?.audio?.headset?.echoCancellation === false &&
    honest.body?.audio?.headset?.aec?.available === false,
  JSON.stringify(honest.body?.audio?.headset),
)

/* ── a socket that dies in the middle of it ────────────────────────────── */

plain.phone.close()
const closed = await until(async () => {
  const now = await headset('status')
  return now.body?.audio?.headset?.on === false
}, 8000)
check('a socket that dies leaves no headset behind on the desktop', closed !== false, String(closed))
const alive = await fetch(`${base}/api/info`).then((r) => r.ok).catch(() => false)
check('while the daemon is still running', alive === true)

/* ── a phone that refuses the mode ─────────────────────────────────────── */

const stubborn = await connect({ token }, { refuse: 'this phone cannot be a headset' })
const refusedByPhone = await headset('on')
check(
  'a handset that refuses the mode is reported beside the devices, not as a crash',
  refusedByPhone.status === 200 && /cannot be a headset/.test(refusedByPhone.body?.audio?.headset?.phone || ''),
  JSON.stringify(refusedByPhone.body?.audio?.headset),
)
check(
  'and the desktop does not claim a headset it has not got',
  refusedByPhone.body?.audio?.headset?.on === false,
  JSON.stringify(refusedByPhone.body?.audio?.headset),
)
stubborn.phone.close()
await speaker('off')

/* ── a desktop with no sound server at all ─────────────────────────────── */

deaf = spawn(process.execPath, [path.join(root, 'bin', 'omarchy-connect.js'), 'start', '--port', String(DEAF_PORT)], {
  env: { ...env, OMARCHY_TEST_NO_PULSE: '1', OMARCHY_CONNECT_STATE: path.join(sandbox, 'deaf-state') },
  stdio: ['ignore', 'ignore', 'inherit'],
})
const deafBase = `http://127.0.0.1:${DEAF_PORT}`
await waitForDaemon(deafBase)
const deafLocal = () => localHeaders(path.join(sandbox, 'deaf-state'))
const refused = await post('/api/headset', { op: 'on' }, deafBase, deafLocal)
check(
  'a desktop with no pipewire-pulse refuses the switch with a sentence',
  refused.status === 400 && /pipewire-pulse/.test(refused.body?.error || ''),
  JSON.stringify(refused.body),
)
deaf.kill('SIGTERM')

done('phone headset checks')
