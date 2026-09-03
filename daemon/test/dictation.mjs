/**
 * Dictating from the phone, from the desktop's side of it.
 *
 * Nothing in a test can speak into a microphone, and the transcription itself
 * belongs to `voxtype` rather than to this project — so what is exercised here
 * is everything the desktop is responsible for around it: that a recording
 * takes the road a screenshot takes and no other, that the words come back out
 * of whatever else the transcriber printed on its way there, that the sound is
 * gone from the disk afterwards whether or not it worked, and that a phone
 * naming a file it did not hand over gets a refusal rather than a reading of
 * it.
 *
 * `voxtype` and `ffmpeg` are stand-ins on PATH. Running the real ones would
 * tie the suite to a 1.6 GB model and a GPU, and would prove something about
 * whisper rather than about this daemon.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { connectPhone } from './phone.mjs'
import { quietBluetooth, localHeaders } from './sandbox.mjs'

const PORT = Number(process.env.PORT || 8809)
const base = `http://127.0.0.1:${PORT}`
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'omarchy-connect-dictation-'))

// The local HTTP routes are gated on the secret the daemon publishes in its
// own status file, so every post below reads it the way the CLI does.
const local = () => localHeaders(path.join(sandbox, 'state'))
const drops = path.join(sandbox, '.cache', 'omarchy-connect', 'agent')

/** What the stand-in transcriber claims to have heard. */
const HEARD = 'чому тут off by one у handshake'

const fakeBin = path.join(sandbox, 'bin')
fs.mkdirSync(fakeBin, { recursive: true })

/**
 * ffmpeg, reduced to the one thing this daemon needs from it: a file at the
 * path it was told to write. The arguments are recorded so the suite can
 * assert on the shape of the call — 16 kHz mono is not decoration, it is what
 * whisper reads, and a resample quietly dropped would only show up as worse
 * transcripts months later.
 */
const ffmpegLog = path.join(sandbox, 'ffmpeg.log')
fs.writeFileSync(
  path.join(fakeBin, 'ffmpeg'),
  [
    '#!/bin/bash',
    `printf '%s\\n' "$*" >> ${JSON.stringify(ffmpegLog)}`,
    'for last; do :; done',
    // The real one refuses an empty file, and the daemon's handling of that
    // refusal is one of the things under test.
    'while [ $# -gt 0 ]; do if [ "$1" = "-i" ]; then input="$2"; fi; shift; done',
    'if [ ! -s "$input" ]; then echo "Invalid data found when processing input" >&2; exit 1; fi',
    'printf "RIFFfake" > "$last"',
    '',
  ].join('\n'),
  { mode: 0o755 },
)

/**
 * voxtype, printing what the real one prints: a short preamble about the file
 * it opened, a blank line, and then the words. The preamble is the whole
 * reason the daemon parses rather than trims.
 */
fs.writeFileSync(
  path.join(fakeBin, 'voxtype'),
  [
    '#!/bin/bash',
    'for last; do :; done',
    'if [ ! -s "$last" ]; then echo "no such file" >&2; exit 1; fi',
    'echo "Loading audio file: \\"$last\\""',
    'echo "Audio format: 16000 Hz, 1 channel(s), Int"',
    'echo "Processing 48000 samples (3.00s)..."',
    'echo ""',
    `echo ${JSON.stringify(HEARD)}`,
    '',
  ].join('\n'),
  { mode: 0o755 },
)

quietBluetooth(sandbox)

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`)
}

const configDir = path.join(sandbox, 'omarchy-connect')
fs.mkdirSync(configDir, { recursive: true, mode: 0o700 })
fs.writeFileSync(
  path.join(configDir, 'config.json'),
  JSON.stringify({
    version: 1,
    port: PORT,
    deviceName: 'dictation-test',
    agents: { enabled: false, spawn: false },
    handsfree: { autoConnect: 'off', address: null },
    devices: [],
  }),
)

const daemon = spawn(
  process.execPath,
  [path.join(root, 'bin', 'omarchy-connect.js'), 'start', '--port', String(PORT)],
  {
    env: {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH}`,
      HOME: sandbox,
      XDG_CONFIG_HOME: sandbox,
      XDG_CACHE_HOME: path.join(sandbox, '.cache'),
      OMARCHY_CONNECT_STATE: path.join(sandbox, 'state'),
      OMARCHY_CONNECT_LOG: 'warn',
      TMUX_TMPDIR: sandbox,
    },
    stdio: ['ignore', 'ignore', 'inherit'],
  },
)

process.on('exit', () => {
  daemon.kill('SIGTERM')
  fs.rmSync(sandbox, { recursive: true, force: true })
})

async function waitForDaemon() {
  for (let i = 0; i < 40; i += 1) {
    try {
      if ((await fetch(`${base}/api/info`)).ok) return
    } catch {
      await new Promise((r) => setTimeout(r, 250))
    }
  }
  throw new Error('daemon did not start')
}

const control = (op) =>
  fetch(`${base}/api/agent/control`, {
    method: 'POST',
    headers: local(),
    body: JSON.stringify({ op }),
  }).then((r) => r.json())

/** A paired phone that can both call methods and push bytes at the upload door. */
async function connect() {
  const info = await (await fetch(`${base}/api/info`)).json()
  const pair = await (await fetch(`${base}/api/pair-code`, { method: 'POST', headers: local() })).json()
  const phone = connectPhone(PORT, info.publicKey)
  const pending = new Map()
  let seq = 0

  const req = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++seq
      pending.set(id, { resolve, reject })
      phone.send({ t: 'req', id, method, params })
      setTimeout(() => pending.has(id) && (pending.delete(id), reject(new Error(`${method} timed out`))), 8000)
    })

  const hello = await new Promise((resolve, reject) => {
    phone.ready
      .then(() =>
        phone.send({
          t: 'hello',
          pairCode: pair.code,
          device: { id: 'dictation-test', name: 'Dictation Phone', platform: 'android' },
        }),
      )
      .catch(reject)
    phone.on((msg) => {
      if (msg.t === 'hello.ok') resolve(msg)
      if (msg.t === 'hello.err') reject(new Error(msg.error))
      if (msg.t === 'res') {
        const waiting = pending.get(msg.id)
        if (!waiting) return
        pending.delete(msg.id)
        msg.ok ? waiting.resolve(msg.data) : waiting.reject(new Error(msg.error))
      }
    })
  })

  // The upload road is authorised by a one-use ticket asked for over the
  // encrypted socket, never by the device token, so every recording here
  // starts by asking for one the way the app does.
  const record = async (name = 'dictation.m4a') => {
    const { ticket } = await req('share.ticket', { use: 'upload' })
    return fetch(`${base}/api/upload`, {
      method: 'POST',
      headers: { 'x-oc-ticket': ticket, 'x-oc-filename': name, 'x-oc-dest': 'agent' },
      body: 'not really aac, but bytes',
    }).then((r) => r.json())
  }

  return { hello, req, record }
}

await waitForDaemon()
const { hello, req, record } = await connect()

/* ── what the phone is told it can do ──────────────────────────────────── */

check(
  'the desktop says it can transcribe',
  hello.capabilities?.dictation?.available === true,
  JSON.stringify(hello.capabilities?.dictation),
)
check(
  'and how much audio it will read in one go',
  Number(hello.capabilities?.dictation?.maxSeconds) > 0,
  String(hello.capabilities?.dictation?.maxSeconds),
)

/* ── the gate ──────────────────────────────────────────────────────────── */

// The bytes reach the desktop as an agent drop, and that door is shut while
// agent control is off. A transcriber that answered anyway would be a way of
// asking a switched-off desktop to run a model for you.
const shut = await req('dictation.transcribe', { path: path.join(drops, 'anything.m4a') }).then(
  () => 'answered',
  (err) => err.message,
)
check('dictation is refused while agent control is off', String(shut).includes('agent enable'), String(shut))

await control('enable')

/* ── a recording, all the way through ──────────────────────────────────── */

const dropped = await record()
check('a recording lands in the drop directory', typeof dropped.path === 'string' && dropped.path.startsWith(drops), dropped.path)

const said = await req('dictation.transcribe', { path: dropped.path })
check('the words come back', said.text === HEARD, JSON.stringify(said.text))
check('and nothing else the transcriber printed does', !String(said.text).includes('Loading audio file'))

const call = fs.readFileSync(ffmpegLog, 'utf8')
check('the sound is resampled to what whisper reads', call.includes('-ar 16000') && call.includes('-ac 1'), call.trim())
check('and clamped to the length the desktop published', call.includes('-t '), call.trim())

/* ── nothing is kept ───────────────────────────────────────────────────── */

check('the recording is gone from the desktop', !fs.existsSync(dropped.path))
check(
  'the 16 kHz copy goes with it',
  !fs.readdirSync(os.tmpdir()).some((name) => name.startsWith('omarchy-connect-dictation-') && name.endsWith('.wav')),
)

const twice = await req('dictation.transcribe', { path: dropped.path }).then(() => 'answered', (err) => err.message)
check('a second reading of the same recording finds nothing', twice !== 'answered', String(twice))

/* ── and nothing else is read ──────────────────────────────────────────── */

const secret = path.join(sandbox, 'id_ed25519')
fs.writeFileSync(secret, 'PRIVATE KEY')
const refused = await req('dictation.transcribe', { path: secret }).then(() => 'answered', (err) => err.message)
check('a file the phone did not hand over is refused', String(refused).includes('not one this phone handed over'), String(refused))
check('and is still there afterwards', fs.existsSync(secret))

const traversal = await req('dictation.transcribe', { path: path.join(drops, '..', '..', '..', 'id_ed25519') }).then(
  () => 'answered',
  (err) => err.message,
)
check('so is one reached by walking out of the drop directory', traversal !== 'answered', String(traversal))

/* ── a recording the transcriber cannot read ───────────────────────────── */

const empty = await record('silence.m4a')
fs.writeFileSync(empty.path, '')
const broken = await req('dictation.transcribe', { path: empty.path }).then(() => 'answered', (err) => err.message)
check('a recording that cannot be read says so', broken !== 'answered', String(broken))
check('and is cleared up all the same', !fs.existsSync(empty.path))

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
