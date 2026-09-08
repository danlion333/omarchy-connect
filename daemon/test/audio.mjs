/**
 * The phone's microphone, from the desktop's side of the wire.
 *
 * Nothing in a suite can speak into a microphone, so what is exercised here is
 * everything the desktop is responsible for around one: that the sound is
 * asked for rather than pushed, that raw binary frames climb the same
 * encrypted socket as the JSON without either one confusing the other, that
 * the bytes land in the right order and in a file something can actually play,
 * that a chunk belonging to a stream which has ended is dropped rather than
 * glued onto the next one, and that a socket dying mid-word leaves a finished
 * file rather than a recorder waiting forever.
 *
 * The last check is the one the issue was really about. A microphone produces
 * bytes whether or not anything is reading them — the failure mode a file
 * transfer never has — so the queue in front of the disk has a ceiling, and a
 * consumer that stops reading altogether must cost bounded memory and dropped
 * audio rather than a daemon that grows until it is killed.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Writable } from 'node:stream'

import { check, done } from '../../tools/test-harness.mjs'
import { connectPhone } from './phone.mjs'
import { quietBluetooth, localHeaders } from './sandbox.mjs'
import { Recorder, amplify, buildFrame, parseFrame, isAudioFrame, readGain, wavHeader, DEFAULT_GAIN, MAX_GAIN, RATE, CHUNK_MS } from '../src/lib/mic.js'

const PORT = Number(process.env.PORT || 8817)
const base = `http://127.0.0.1:${PORT}`
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'omarchy-connect-audio-'))
const local = () => localHeaders(path.join(sandbox, 'state'))
const audioDir = path.join(sandbox, '.cache', 'omarchy-connect', 'audio')
const configFile = path.join(sandbox, 'omarchy-connect', 'config.json')

quietBluetooth(sandbox, { port: PORT, deviceName: 'audio-test', devices: [] })

const daemon = spawn(process.execPath, [path.join(root, 'bin', 'omarchy-connect.js'), 'start', '--port', String(PORT)], {
  env: {
    ...process.env,
    HOME: sandbox,
    XDG_CONFIG_HOME: sandbox,
    XDG_CACHE_HOME: path.join(sandbox, '.cache'),
    OMARCHY_CONNECT_STATE: path.join(sandbox, 'state'),
    OMARCHY_CONNECT_LOG: 'warn',
    TMUX_TMPDIR: sandbox,
  },
  stdio: ['ignore', 'ignore', 'inherit'],
})

process.on('exit', () => {
  daemon.kill('SIGTERM')
  fs.rmSync(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitForDaemon() {
  for (let i = 0; i < 40; i += 1) {
    try {
      if ((await fetch(`${base}/api/info`)).ok) return
    } catch {
      await wait(250)
    }
  }
  throw new Error('daemon did not start')
}

/** `omarchy-connect mic <op>`, as the CLI issues it. */
const mic = (op, value) =>
  fetch(`${base}/api/mic`, { method: 'POST', headers: local(), body: JSON.stringify({ op, value }) }).then(async (r) => ({
    status: r.status,
    body: await r.json(),
  }))

/**
 * A phone that answers `audio` instructions the way the app does — and can be
 * told not to, so the suite can watch the desktop time out on a handset that
 * never says whether it could listen.
 */
async function connect({ pairCode = null, token = null, obedient = true } = {}) {
  const info = await (await fetch(`${base}/api/info`)).json()
  const phone = connectPhone(PORT, info.publicKey)
  const pending = new Map()
  const heard = []
  let seq = 0
  let stream = null
  let issued = null

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
          ...(token ? { token } : { pairCode }),
          device: { id: 'audio-test', name: 'Audio Phone', platform: 'android' },
        }),
      )
      .catch(reject)
    phone.on((msg) => {
      if (msg.t === 'paired') issued = msg.token
      if (msg.t === 'hello.ok') resolve(msg)
      if (msg.t === 'hello.err') reject(new Error(msg.error))
      if (msg.t === 'ev' && msg.event === 'audio') {
        heard.push(msg.data)
        if (!obedient) return
        if (msg.data.action === 'start') {
          stream = msg.data.stream
          req('audio.started', { id: msg.data.id, ok: true }).catch(() => {})
        }
        if (msg.data.action === 'stop') stream = null
      }
      if (msg.t === 'res') {
        const waiting = pending.get(msg.id)
        if (!waiting) return
        pending.delete(msg.id)
        msg.ok ? waiting.resolve(msg.data) : waiting.reject(new Error(msg.error))
      }
    })
  })

  // The instruction rides the `audio` channel, so a phone that has not asked
  // for it hears nothing — exactly as the app does on every hello.
  const subscribed = new Promise((resolve) => {
    phone.on((msg) => msg.t === 'sub.ok' && resolve(msg.events))
  })
  phone.send({ t: 'sub', events: ['audio'] })
  await subscribed

  /** `n` chunks of a recognisable tone, at the sequence numbers the app uses. */
  let sent = 0
  const speak = (chunks, { on = null, from = null } = {}) => {
    const bytes = (RATE * 2 * CHUNK_MS) / 1000
    for (let i = 0; i < chunks; i += 1) {
      const pcm = Buffer.alloc(bytes)
      // A ramp rather than silence, so a file that is the right length but the
      // wrong bytes is still a failure.
      for (let at = 0; at < bytes; at += 2) pcm.writeInt16LE(((sent * 977 + at) % 20000) - 10000, at)
      phone.sendBytes(buildFrame(on ?? stream ?? 0, from === null ? sent : from + i, pcm))
      sent += 1
    }
    return chunks * bytes
  }

  return { hello, req, phone, heard, speak, token: () => issued, streamOf: () => stream }
}

await waitForDaemon()

/* ── the codec, held against itself ────────────────────────────────────── */

const sample = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8])
const round = parseFrame(buildFrame(9, 41, sample))
check('a frame carries its stream, its sequence and its samples', round.stream === 9 && round.seq === 41 && round.pcm.equals(sample))
check('JSON is never mistaken for audio', !isAudioFrame(Buffer.from('{"t":"ping"}')))
check(
  'a half sample is refused rather than written a byte out of step',
  (() => {
    try {
      parseFrame(buildFrame(1, 0, Buffer.alloc(3)))
      return false
    } catch (err) {
      return /whole number of samples/.test(err.message)
    }
  })(),
)

/* ── the gain, as arithmetic ───────────────────────────────────────────── */

// The lever this desktop has over a handset that sends what its hardware heard
// and nothing more. It is a plain multiply on purpose: a compressor would move
// the noise floor and the voice by different amounts, and the ratio between
// them is the one thing worth not touching.
const quiet = Buffer.alloc(8)
for (const [at, value] of [[0, 1000], [2, -1000], [4, 16000], [6, -20000]]) quiet.writeInt16LE(value, at)
const loud = amplify(quiet, 2)
check(
  'the desktop gain multiplies every sample',
  loud.readInt16LE(0) === 2000 && loud.readInt16LE(2) === -2000 && loud.readInt16LE(4) === 32000,
  [0, 2, 4].map((i) => loud.readInt16LE(i)).join(','),
)
check('a sample that would overflow saturates rather than wrapping round into a click', loud.readInt16LE(6) === -32768, String(loud.readInt16LE(6)))
check('and the frame the socket handed over is left alone, because two consumers read it', quiet.readInt16LE(0) === 1000)
check('a gain of one is the samples themselves, not a copy of them', amplify(quiet, 1) === quiet)
check('a missing or nonsense gain is the default rather than silence', readGain(undefined) === DEFAULT_GAIN && readGain('loud') === DEFAULT_GAIN && readGain(0) === DEFAULT_GAIN)
check('and an absurd one is capped where a room becomes hiss', readGain(1000) === MAX_GAIN)

/* ── what the phone is told it can do ──────────────────────────────────── */

const pair = await (await fetch(`${base}/api/pair-code`, { method: 'POST', headers: local() })).json()
const phone = await connect({ pairCode: pair.code })
const caps = phone.hello.capabilities?.audio
check('the desktop says it can take a microphone stream', caps?.receive === true, JSON.stringify(caps))
check('and names the one format it takes', caps?.encoding === 's16le' && caps?.rate === 16000 && caps?.channels === 1, JSON.stringify(caps))
check('the audio channel is on the list a phone may subscribe to', (phone.hello.events || []).includes('audio'), JSON.stringify(phone.hello.events))

/* ── a stream, all the way through ─────────────────────────────────────── */

const started = await mic('start')
check('the desktop can ask the phone for its microphone', started.body?.ok === true, JSON.stringify(started.body))
const asked = phone.heard.find((e) => e.action === 'start')
check('and the instruction names the format so the two ends cannot drift', asked?.rate === 16000 && asked?.chunkMs === CHUNK_MS, JSON.stringify(asked))

const spoken = phone.speak(3000 / CHUNK_MS) // three seconds
await wait(300)
const midway = await mic('status')
check('the desktop knows it is listening while it is', midway.body?.audio?.streaming === true, JSON.stringify(midway.body?.audio))

// A JSON request in the middle of a stream: the two kinds of frame share one
// socket and one nonce counter, and a suite that only sent audio would never
// notice if audio had broken the JSON road.
const pong = await phone.req('audio.status')
check('an ordinary request still works mid-stream', pong?.streaming === true, JSON.stringify(pong))

const stopped = await mic('stop')
const file = stopped.body?.audio?.path
check('stopping answers with the recording', typeof file === 'string' && file.startsWith(audioDir), String(file))
check('the phone is told to stop as well', phone.heard.some((e) => e.action === 'stop'), JSON.stringify(phone.heard))

const written = fs.readFileSync(file)
check('every byte spoken reached the disk', written.length === 44 + spoken, `${written.length} for ${spoken} + 44`)
check('the file is a WAV something can play', written.subarray(0, 4).toString() === 'RIFF' && written.subarray(8, 12).toString() === 'WAVE')
check('with the header the samples actually have', written.subarray(0, 44).equals(wavHeader(spoken)))
check('and the desktop counts the seconds it heard', Math.abs(Number(stopped.body?.audio?.seconds) - 3) < 0.05, String(stopped.body?.audio?.seconds))
check('nothing was dropped on a stream the disk kept up with', stopped.body?.audio?.dropped === 0, JSON.stringify(stopped.body?.audio))

/* ── what does not get in ──────────────────────────────────────────────── */

// The phone did not hear the stop yet, or a chunk was in flight when it did.
phone.speak(5, { on: 1 })
await wait(200)
const after = fs.readFileSync(file)
check('a chunk from a stream that has ended is dropped, not appended', after.length === written.length, `${after.length} vs ${written.length}`)

const idle = await mic('stop')
check('stopping when nothing is streaming is refused rather than pretended', idle.status === 400, JSON.stringify(idle.body))

/* ── the gain, all the way onto the disk ───────────────────────────────── */

// The arithmetic above is a unit; this is the road. What matters is that the
// number reaches the bytes on the way in — before the WAV and before anything
// listening live — so that a recording and a program's input picker cannot
// end up at two different volumes.
const untouched = await mic('status')
check('a desktop nobody has touched follows the room rather than pinning a number', untouched.body?.audio?.auto === true, JSON.stringify(untouched.body?.audio))

const turnedUp = await mic('gain', 3)
check('the desktop takes a new gain and answers with it', turnedUp.body?.audio?.gain === 3, JSON.stringify(turnedUp.body?.audio))
// Typing a number is how somebody says they would rather be in charge than be
// followed, so it is also how the follower is turned off. Anything else and
// the number they chose would be quietly overridden a second later.
check('and asking for a number takes the knob off the follower', turnedUp.body?.audio?.auto === false, JSON.stringify(turnedUp.body?.audio))
check('a gain of zero is refused rather than muting the phone', (await mic('gain', 0)).status === 400)
const tooLoud = await mic('gain', 999)
check('and one past the ceiling is refused with a sentence', /tops out/.test(tooLoud.body?.error || ''), JSON.stringify(tooLoud.body))

const loudRun = await mic('start')
check('a stream started after the change reports the gain it is running at', loudRun.body?.audio?.gain === 3, JSON.stringify(loudRun.body?.audio))
const said = Buffer.alloc(8)
for (const [at, value] of [[0, 100], [2, -100], [4, 12000], [6, -12000]]) said.writeInt16LE(value, at)
phone.phone.sendBytes(buildFrame(phone.streamOf(), 0, said))
await wait(200)
const loudStop = await mic('stop')
const onDisk = fs.readFileSync(loudStop.body?.audio?.path).subarray(44)
check(
  'and every sample in the file is what the phone sent, three times louder, saturating rather than wrapping',
  onDisk.equals(amplify(said, 3)),
  [0, 2, 4, 6].map((i) => onDisk.readInt16LE(i)).join(','),
)

const followsAgain = await mic('gain', 'auto')
check('and `auto` hands it back', followsAgain.body?.audio?.auto === true, JSON.stringify(followsAgain.body?.audio))
check('which does not forget the number that was chosen', readGain(JSON.parse(fs.readFileSync(configFile, 'utf8')).audio?.gain) === 3, fs.readFileSync(configFile, 'utf8'))

// Back to untouched samples for the rest of the suite, which counts bytes
// rather than reads them and should not have to care — and pinned, because a
// follower would move them.
await mic('gain', 1)

/* ── the phone offering, rather than being asked ───────────────────────── */

// The half of the road the app's microphone card rides: the same one stream,
// started from the end that is holding the microphone.
const startsBefore = phone.heard.filter((e) => e.action === 'start').length
const offered = await phone.req('audio.offer', { op: 'start' })
check('the phone can offer its own microphone', offered?.streaming === true, JSON.stringify(offered))
check('and is told the file the desktop opened for it', typeof offered?.path === 'string' && offered.path.startsWith(audioDir), String(offered?.path))
check(
  'the instruction still went out on the audio channel, so there is one road in and not two',
  phone.heard.filter((e) => e.action === 'start').length === startsBefore + 1,
  JSON.stringify(phone.heard.map((e) => e.action)),
)

const offeredSound = phone.speak(10)
await wait(200)
const whileOffered = await mic('status')
check('the desktop is listening to a stream it never asked for', whileOffered.body?.audio?.streaming === true, JSON.stringify(whileOffered.body?.audio))

// A second press of the same button, not a different method: one switch, both
// ways, which is what makes the card's state a single boolean.
const takenBack = await phone.req('audio.offer', { op: 'stop' })
check('and a second press stops it', takenBack?.streaming === false, JSON.stringify(takenBack))
check(
  'leaving a finished WAV holding exactly what was spoken into it',
  fs.readFileSync(offered.path).length === 44 + offeredSound,
  `${fs.readFileSync(offered.path).length} for ${offeredSound} + 44`,
)

// `omarchy-connect mic stop` on a stream the phone started, and the other way
// round: neither end owns the stream, so either end can end it.
const offeredAgain = await phone.req('audio.offer', { op: 'start' })
const stoppedFromDesk = await mic('stop')
check(
  'a stream the phone offered is stopped from the desktop like any other',
  stoppedFromDesk.body?.ok === true && stoppedFromDesk.body?.audio?.path === offeredAgain.path,
  JSON.stringify(stoppedFromDesk.body?.audio),
)

const twice = await phone.req('audio.offer', { op: 'start' })
let refused = null
try {
  await phone.req('audio.offer', { op: 'start' })
} catch (err) {
  refused = err.message
}
check('offering a microphone that is already streaming is refused with a sentence', /already streaming/.test(refused || ''), String(refused))
check('offering it again did not disturb the stream that was running', (await mic('status')).body?.audio?.stream === twice.stream, JSON.stringify(twice))
await mic('stop')

let stopRefused = null
try {
  await phone.req('audio.offer', { op: 'stop' })
} catch (err) {
  stopRefused = err.message
}
check('and stopping nothing is refused rather than pretended', /not streaming/.test(stopRefused || ''), String(stopRefused))

/* ── a socket that dies mid-word ───────────────────────────────────────── */

const second = await mic('start')
const live = second.body?.audio?.path
check('a second stream gets a file of its own', live !== file, String(live))
phone.speak(10)
await wait(200)
phone.phone.ws.terminate()

let closed = null
for (let i = 0; i < 20 && !closed; i += 1) {
  await wait(100)
  const state = await mic('status')
  if (state.body?.audio?.streaming === false) closed = i
}
check('a socket dying mid-stream leaves nothing streaming on the desktop', closed !== null, `after ${(closed ?? 20) * 100}ms`)
const orphan = fs.readFileSync(live)
check('and the file it was writing is a finished WAV', orphan.subarray(0, 44).equals(wavHeader(orphan.length - 44)), `${orphan.length} bytes`)

/* ── the phone comes back ──────────────────────────────────────────────── */

const again = await connect({ token: phone.token() })
const third = await mic('start')
check('a reconnected phone starts a clean stream', third.body?.ok === true, JSON.stringify(third.body))
const fresh = third.body?.audio?.path
again.speak(10)
await wait(200)
const ended = await mic('stop')
check(
  'and the new recording holds only what the new socket said',
  fs.readFileSync(fresh).length === 44 + 10 * ((RATE * 2 * CHUNK_MS) / 1000),
  `${fs.readFileSync(fresh).length} bytes`,
)
check('with its own stream number', ended.body?.audio?.path === fresh, JSON.stringify(ended.body?.audio))

/* ── the press that raced the desktop's own question ───────────────────── */

// The race the issue asked about: the desktop's instruction is out and the
// handset has not answered it yet when the person presses the card. What must
// not happen is two streams, or a second instruction to a phone that is
// already opening its microphone.
// The obedient phone goes first: an instruction is fanned out to every socket
// subscribed to the channel, and one that answers would settle the very
// request this check needs left outstanding.
again.phone.ws.terminate()
await wait(300)
const deaf = await connect({ token: phone.token(), obedient: false })
const racing = mic('start')
await wait(150)
let racedError = null
try {
  await deaf.req('audio.offer', { op: 'start' })
} catch (err) {
  racedError = err.message
}
check(
  'a press that arrives while the desktop is still waiting for an answer is refused, not doubled',
  /has already been asked/.test(racedError || ''),
  String(racedError),
)
check(
  'and the phone was told once, not twice',
  deaf.heard.filter((e) => e.action === 'start').length === 1,
  JSON.stringify(deaf.heard.map((e) => e.action)),
)
const timedOut = await racing
check('the outstanding request still times out on its own', timedOut.status === 400 && /did not answer/.test(timedOut.body?.error || ''), JSON.stringify(timedOut.body))
deaf.phone.ws.terminate()

/* ── the slow consumer ─────────────────────────────────────────────────── */

// The ceiling, on its own, with a sink that never drains. What must not happen
// is the queue growing with the recording: five minutes of speech into a
// consumer reading nothing is 9.6 MB, and the whole point is that the daemon
// holds a fixed fraction of it and says how much it threw away.
const stalled = new Writable({ write() { /* never calls back: the reader is gone */ } })
const slow = new Recorder({ file: null, sink: stalled, maxQueueBytes: 32 * 1024 })
const minutes = 5
const chunks = (minutes * 60 * 1000) / CHUNK_MS
for (let i = 0; i < chunks; i += 1) {
  // Each chunk numbered in its own first sample, so the suite can ask which
  // ones survived rather than only how many.
  const chunk = Buffer.alloc(3200)
  chunk.writeUInt32BE(i, 0)
  slow.push(chunk)
}
const spokenBytes = chunks * 3200
check('a stalled consumer costs a fixed amount of memory', slow.queued <= 32 * 1024, `${slow.queued} bytes queued`)
check(
  'and what it holds is the newest sound, not the oldest',
  slow.queue.at(-1).readUInt32BE(0) === chunks - 1 && slow.queue[0].readUInt32BE(0) >= chunks - 12,
  `chunks ${slow.queue[0].readUInt32BE(0)}..${slow.queue.at(-1).readUInt32BE(0)} of ${chunks}`,
)
check(
  'what could not be written is counted rather than silently lost',
  slow.dropped > 0 && slow.dropped >= spokenBytes - 256 * 1024,
  `${slow.dropped} dropped of ${spokenBytes}`,
)

const gappy = new Recorder({ file: null, sink: new Writable({ write(c, e, cb) { cb() } }) })
gappy.push(Buffer.alloc(3200), 0)
gappy.push(Buffer.alloc(3200), 5)
check('a hole the phone left is noticed rather than spliced over', gappy.gaps === 4, String(gappy.gaps))
await gappy.close()

/* ── the recordings are swept ──────────────────────────────────────────── */

check(
  'recordings live in the cache, not somewhere anybody keeps files',
  fs.readdirSync(audioDir).every((name) => name.startsWith('mic-') && name.endsWith('.wav')),
  fs.readdirSync(audioDir).join(', '),
)

done('microphone stream checks')
