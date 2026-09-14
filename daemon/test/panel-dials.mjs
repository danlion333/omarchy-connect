/**
 * The two numbers on the panel's settings card: how loud the phone is here,
 * and what its camera opens with.
 *
 * `audio.mjs` proves the gain reaches the samples and `video-format.mjs`
 * proves the `video` block reaches the handset. This is the third half of both
 * features — whether anybody can *turn* them without opening a config file in
 * an editor. Until now the switches on that card were the only controls on it,
 * and a switch cannot say 1280×720.
 *
 * The panel has exactly one window on the daemon, `status.json`, and exactly
 * one way back, the CLI. So the checks here are on the two ends of that road,
 * the way `audio-panel.mjs` and `terminal-panel.mjs` check theirs:
 *
 *   - `shell/Model.js`, loaded here the way `audio-panel.mjs` loads it, turns
 *     a snapshot into the chips the panel draws, the one that is lit, and the
 *     line underneath — including the two states nobody can reach by clicking:
 *     a gain somebody typed at a terminal, and a daemon that is stopped;
 *   - the write path each chip stands on. `mic gain` already had one, so the
 *     new road is `POST /api/camera { "op": "format" }` — what it keeps, what
 *     it leaves alone, what it refuses, and that a phone asked for a camera
 *     afterwards is asked for *those* numbers;
 *   - and both of them outliving the daemon, because a dial that forgets on
 *     restart is a dial nobody will use twice.
 *
 * The gain check that matters is the one on a *running* stream: the whole
 * argument for putting the level on this card rather than in the app is that
 * somebody turns it while listening to the input that was too quiet, and a
 * value that only took effect on the next `mic start` would make that a game
 * of stop and start.
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
import { amplify, buildFrame, MAX_GAIN, RATE, CHUNK_MS } from '../src/lib/mic.js'
import { MAX_WIDTH, MIN_FPS } from '../src/lib/video.js'

const PORT = Number(process.env.PORT || 8841)
const base = `http://127.0.0.1:${PORT}`
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const repo = path.dirname(root)

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'omarchy-connect-dials-'))
const local = () => localHeaders(path.join(sandbox, 'state'))
const configFile = quietBluetooth(sandbox, {
  port: PORT,
  deviceName: 'dials-test',
  devices: [],
  audio: { auto: true, gain: 4 },
  video: { camera: 'back', width: 1280, height: 720, fps: 15, quality: 70 },
})
const readConfig = () => JSON.parse(fs.readFileSync(configFile, 'utf8'))

/* ── the panel's own arithmetic ────────────────────────────────────────── */

// The same load `audio-panel.mjs` does: the panel's model is plain JavaScript
// behind a QML pragma, so it can be read here rather than guessed at.
const source = fs.readFileSync(path.join(repo, 'shell', 'Model.js'), 'utf8').replace(/^\.pragma .*$/m, '')
const Model = vm.createContext({})
vm.runInContext(source, Model, { filename: 'shell/Model.js' })

const snapshot = (audio, video) => ({ running: true, audio, video })

const following = Model.audio(snapshot({ auto: true, gain: 2.4, input: {}, output: {} }, {}))
check('the panel reads the level out of the status', following.gain === 2.4 && following.auto === true, JSON.stringify(following.gain))
check('and the follower is the lit chip while it is in charge', Model.gainValue(following) === 'auto', Model.gainValue(following))
check(
  'the line says where the follower has arrived, because that is the number somebody is deciding against',
  /following the room/.test(Model.gainText(following, true)) && /2\.4×/.test(Model.gainText(following, true)),
  Model.gainText(following, true),
)

const pinned = Model.audio(snapshot({ auto: false, gain: 8, input: {}, output: {} }, {}))
check('a pinned level lights its own chip', Model.gainValue(pinned) === '8', Model.gainValue(pinned))
check('and the line says the decibels, which is the unit anybody who has touched a mixer thinks in', /\+18\.1 dB/.test(Model.gainText(pinned, true)), Model.gainText(pinned, true))
check('the row stops at the ceiling the daemon enforces', Model.gainOptions(pinned).every((o) => o.value === 'auto' || Number(o.value) <= MAX_GAIN), JSON.stringify(Model.gainOptions(pinned).map((o) => o.value)))

// The state nobody can reach by clicking, and so the one a panel gets wrong:
// a number typed at a terminal has to be *shown* as chosen, or the card is a
// row of dark chips beside a line saying the microphone is at five.
const typed = Model.audio(snapshot({ auto: false, gain: 5, input: {}, output: {} }, {}))
const typedChips = Model.gainOptions(typed).map((o) => o.value)
check('a level typed at a terminal joins the row in its own place', typedChips.indexOf('5') === 4, typedChips.join(','))
check('and it is the lit one', Model.gainValue(typed) === '5', Model.gainValue(typed))

const format = Model.camera(snapshot({}, { camera: 'front', width: 640, height: 480, fps: 30, quality: 70 }))
check('the panel reads the picture out of the status too', format.camera === 'front' && format.width === 640 && format.fps === 30, JSON.stringify(format))
check('and lights the size, the rate and the lens it found', Model.sizeValue(format) === '640x480' && Model.fpsValue(format) === '30' && Model.lensValue(format) === 'front')
check(
  'the line under the three says the picture the next capture will ask for',
  /the next time the camera opens/.test(Model.formatText(format, true)) && /640×480/.test(Model.formatText(format, true)),
  Model.formatText(format, true),
)

const filming = Model.camera({ running: true, video: { streaming: true, camera: 'back', width: 1024, height: 768, fps: 15 } })
check(
  'and while a lens is open it says so, because those numbers are then the handset’s own',
  /filming now/.test(Model.formatText(filming, true)) && /1024×768/.test(Model.formatText(filming, true)),
  Model.formatText(filming, true),
)
const odd = Model.sizeOptions(filming).map((o) => o.value)
check('a size the lens settled on that nobody offered joins the row as well', odd.indexOf('1024x768') === 1, odd.join(','))

/* ── what the card says with nothing running ───────────────────────────── */

// The switches above these dials vanish with the daemon down, because a switch
// whose only outcome is an error is a question rather than a control. The
// values may not vanish with them: they are in the config, they are true, and
// "what is this set to" is most of what the card is opened to read.
const stoppedAudio = Model.audio({ running: false, audio: { auto: false, gain: 8, input: {}, output: {} } })
const stoppedVideo = Model.camera({ running: false, video: { camera: 'front', width: 1920, height: 1080, fps: 24 } })
check(
  'a stopped daemon still says the level that is saved',
  /the daemon is stopped/.test(Model.gainText(stoppedAudio, false)) && /8×/.test(Model.gainText(stoppedAudio, false)),
  Model.gainText(stoppedAudio, false),
)
check(
  'and the picture that is saved',
  /the daemon is stopped/.test(Model.formatText(stoppedVideo, false)) && /1920×1080/.test(Model.formatText(stoppedVideo, false)),
  Model.formatText(stoppedVideo, false),
)
check('with the chips still knowing which ones they are', Model.gainValue(stoppedAudio) === '8' && Model.sizeValue(stoppedVideo) === '1920x1080')

// What the panel runs when a chip is pressed. It is the CLI and nothing else —
// the panel has no socket of its own — so the argv is worth pinning here: a
// typo in it is a dial that lights up and changes nothing.
check('the level chip runs the command that already existed', Model.gainArgs('8').join(' ') === 'mic gain 8' && Model.gainArgs('auto').join(' ') === 'mic gain auto')
check(
  'and the three camera chips run the one this added',
  Model.sizeArgs('1280x720').join(' ') === 'cam format --width 1280 --height 720' &&
    Model.fpsArgs('30').join(' ') === 'cam format --fps 30' &&
    Model.lensArgs('front').join(' ') === 'cam format --camera front',
  [Model.sizeArgs('1280x720').join(' '), Model.fpsArgs('30').join(' '), Model.lensArgs('front').join(' ')].join(' | '),
)

/* ── the daemon behind those commands ──────────────────────────────────── */

const env = {
  ...process.env,
  HOME: sandbox,
  XDG_CONFIG_HOME: sandbox,
  XDG_CACHE_HOME: path.join(sandbox, '.cache'),
  OMARCHY_CONNECT_STATE: path.join(sandbox, 'state'),
  OMARCHY_CONNECT_LOG: 'warn',
  TMUX_TMPDIR: sandbox,
}
const startDaemon = () =>
  spawn(process.execPath, [path.join(root, 'bin', 'omarchy-connect.js'), 'start', '--port', String(PORT)], {
    env,
    stdio: ['ignore', 'ignore', 'inherit'],
  })

let daemon = startDaemon()
process.on('exit', () => {
  daemon.kill('SIGTERM')
  fs.rmSync(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
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

const post = (route, body) =>
  fetch(`${base}${route}`, { method: 'POST', headers: local(), body: JSON.stringify(body) }).then(async (r) => ({
    status: r.status,
    body: await r.json(),
  }))

const camera = (op, value = {}) => post('/api/camera', { op, value })
const mic = (op, value) => post('/api/mic', { op, value })

/** A phone that answers both instructions the way the app does, and remembers. */
async function connect(pairCode) {
  const info = await (await fetch(`${base}/api/info`)).json()
  const phone = connectPhone(PORT, info.publicKey)
  const filmed = []
  let stream = null
  let seq = 0
  let sent = 0

  const hello = await new Promise((resolve, reject) => {
    phone.ready
      .then(() =>
        phone.send({
          t: 'hello',
          pairCode,
          device: { id: 'dials-test', name: 'Dials Phone', platform: 'android' },
        }),
      )
      .catch(reject)
    phone.on((msg) => {
      if (msg.t === 'hello.ok') resolve(msg)
      if (msg.t === 'hello.err') reject(new Error(msg.error))
      if (msg.t === 'ev' && msg.event === 'video' && msg.data.action === 'start') {
        filmed.push(msg.data)
        seq += 1
        phone.send({ t: 'req', id: seq, method: 'video.started', params: { id: msg.data.id, ok: true } })
      }
      if (msg.t === 'ev' && msg.event === 'audio') {
        if (msg.data.action === 'start') {
          stream = msg.data.stream
          seq += 1
          phone.send({ t: 'req', id: seq, method: 'audio.started', params: { id: msg.data.id, ok: true } })
        }
        if (msg.data.action === 'stop') stream = null
      }
    })
  })

  const subscribed = new Promise((resolve) => phone.on((msg) => msg.t === 'sub.ok' && resolve(msg.events)))
  phone.send({ t: 'sub', events: ['audio', 'video'] })
  await subscribed

  /** One chunk of a recognisable ramp, so a file of the right length can still fail. */
  const speak = () => {
    const bytes = (RATE * 2 * CHUNK_MS) / 1000
    const pcm = Buffer.alloc(bytes)
    for (let at = 0; at < bytes; at += 2) pcm.writeInt16LE(((sent * 977 + at) % 8000) - 4000, at)
    phone.sendBytes(buildFrame(stream ?? 0, sent, pcm))
    sent += 1
    return pcm
  }

  return { hello, filmed, speak }
}

await waitForDaemon()
const pair = await (await fetch(`${base}/api/pair-code`, { method: 'POST', headers: local() })).json()
const phone = await connect(pair.code)

/* ── the camera dial's write path ──────────────────────────────────────── */

const set = await camera('format', { width: 640, height: 480, fps: 30, camera: 'front' })
check('the desktop takes a camera format and answers with it', set.status === 200 && set.body?.video?.width === 640 && set.body?.video?.fps === 30, JSON.stringify(set.body?.video))
check(
  'and it is in the config file, which is the only place it can be true tomorrow',
  JSON.stringify(readConfig().video) === JSON.stringify({ camera: 'front', width: 640, height: 480, fps: 30, quality: 70 }),
  JSON.stringify(readConfig().video),
)

// Three dials, one block: a person changing the frame rate has not asked for
// the lens to go back to where it started.
const oneField = await camera('format', { fps: 15 })
check(
  'one dial moves one field and leaves the rest of the block alone',
  oneField.body?.video?.fps === 15 && oneField.body?.video?.camera === 'front' && oneField.body?.video?.width === 640,
  JSON.stringify(oneField.body?.video),
)

const huge = await camera('format', { width: 99999, fps: 0 })
check(
  'a wish past the bounds is clamped by the same reader a capture goes through',
  huge.body?.video?.width === MAX_WIDTH && huge.body?.video?.fps === MIN_FPS,
  JSON.stringify(huge.body?.video),
)

// The one thing the panel cannot send and a terminal can. It is refused with a
// sentence rather than saved as "back", because a lens named out loud and
// wrongly is a typo and not a missing setting.
const typo = await camera('format', { camera: 'periscope' })
check('a lens nobody has is refused with the reason', typo.status === 400 && /back.*front|front.*back/.test(typo.body?.error || ''), JSON.stringify(typo.body))
check('and nothing in the file moved because of it', readConfig().video.camera === 'front', JSON.stringify(readConfig().video))

await camera('format', { width: 1280, height: 720, fps: 24, camera: 'back' })
const status = (await camera('status')).body.video
check('the status moves with the dial, which is the panel’s only window on it', status.width === 1280 && status.fps === 24 && status.camera === 'back', JSON.stringify(status))

// The point of the whole road: a switch that names no format opens the camera
// the dial asked for. `cam device on` is the panel's camera switch.
await camera('start')
check(
  'and a capture that names nothing asks the phone for exactly those numbers',
  phone.filmed.at(-1)?.width === 1280 && phone.filmed.at(-1)?.height === 720 && phone.filmed.at(-1)?.fps === 24 && phone.filmed.at(-1)?.camera === 'back',
  JSON.stringify(phone.filmed.at(-1)),
)
await camera('stop')

/* ── the level dial, on a stream that is already running ───────────────── */

const auto = (await mic('status')).body.audio
check('a desktop nobody has touched is still following the room', auto.auto === true, JSON.stringify({ auto: auto.auto, gain: auto.gain }))

const running = await mic('start')
const streamId = running.body?.audio?.stream
check('the phone is speaking', running.body?.ok === true && typeof streamId === 'number', JSON.stringify(running.body?.audio?.stream))

const turned = await mic('gain', 3)
check('the level can be pinned while it is speaking', turned.body?.audio?.gain === 3 && turned.body?.audio?.auto === false, JSON.stringify(turned.body?.audio))
check(
  'and the stream is the same one it was — nothing stopped and started under the change',
  turned.body?.audio?.stream === streamId && turned.body?.audio?.streaming === true,
  JSON.stringify({ was: streamId, now: turned.body?.audio?.stream }),
)

const said = phone.speak()
await wait(300)
const ended = await mic('stop')
const onDisk = fs.readFileSync(ended.body?.audio?.path).subarray(44)
check(
  'every sample that arrived after the chip was pressed is three times louder',
  onDisk.length >= said.length && onDisk.subarray(onDisk.length - said.length).equals(amplify(said, 3)),
  `${onDisk.length} bytes on disk for ${said.length} in`,
)
check(
  'and the panel would draw the new number, because the status carries it',
  Model.gainValue(Model.audio((await mic('status')).body)) === '3',
  JSON.stringify((await mic('status')).body?.audio?.gain),
)

/* ── and both of them outlive the daemon ───────────────────────────────── */

daemon.kill('SIGTERM')
await new Promise((resolve) => daemon.once('exit', resolve))
daemon = startDaemon()
await waitForDaemon()

const afterRestart = (await camera('status')).body.video
check(
  'the picture chosen on the card is the picture a fresh daemon asks for',
  afterRestart.width === 1280 && afterRestart.height === 720 && afterRestart.fps === 24 && afterRestart.camera === 'back',
  JSON.stringify(afterRestart),
)
const levelAfter = (await mic('status')).body.audio
check('and the level chosen on it is still pinned where it was', levelAfter.gain === 3 && levelAfter.auto === false, JSON.stringify({ gain: levelAfter.gain, auto: levelAfter.auto }))

// The panel never reads any of this from the API: it reads `status.json`, and
// a file written by the daemon that has just come up is the file it will draw.
const published = JSON.parse(fs.readFileSync(path.join(sandbox, 'state', 'status.json'), 'utf8'))
check(
  'and the file the panel actually reads says the same two things',
  Model.gainValue(Model.audio(published)) === '3' && Model.sizeValue(Model.camera(published)) === '1280x720',
  JSON.stringify({ audio: published.audio?.gain, video: published.video?.width }),
)

/* ── and the card is still readable with nothing running ───────────────── */

// The dials go away when the daemon does, which is the switches' own rule, and
// what is left is the words. So the words have to be *true*: a status file
// written on the way out that dropped the level would leave the card saying
// the microphone is at 1x over a config that says three, which is worse than
// saying nothing. `mic status` and `camera status` with the daemon down read
// this same file.
daemon.kill('SIGTERM')
await new Promise((resolve) => daemon.once('exit', resolve))
for (let i = 0; i < 40 && JSON.parse(fs.readFileSync(path.join(sandbox, 'state', 'status.json'), 'utf8')).running; i += 1) {
  await wait(100)
}
const stopped = JSON.parse(fs.readFileSync(path.join(sandbox, 'state', 'status.json'), 'utf8'))
check('the file a stopped daemon leaves behind says the daemon is stopped', stopped.running === false, JSON.stringify(stopped.running))
check(
  'and still says which level was chosen, so the card does not claim 1x over a config that says otherwise',
  Model.gainValue(Model.audio(stopped)) === '3' && Model.gainText(Model.audio(stopped), false).indexOf('3\u00d7') > 0,
  Model.gainText(Model.audio(stopped), false),
)
check(
  'and which picture, as the desktop asked for it rather than as a lens last negotiated it',
  Model.sizeValue(Model.camera(stopped)) === '1280x720' && Model.fpsValue(Model.camera(stopped)) === '24' &&
    Model.lensValue(Model.camera(stopped)) === 'back' && Model.camera(stopped).streaming === false,
  JSON.stringify({ size: Model.sizeValue(Model.camera(stopped)), fps: Model.fpsValue(Model.camera(stopped)) }),
)

done()
