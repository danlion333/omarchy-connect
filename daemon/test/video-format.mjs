/**
 * The picture the desktop asks for, and where that decision lives.
 *
 * `video.mjs` proves the road carries frames. This one is about the numbers
 * that road is opened with, which used to be constants in `lib/video.js` and
 * are now the `video` block of the config — the microphone's `audio` block for
 * pictures. Four things are worth a suite, and all four are about a request
 * nobody typed in full:
 *
 * - the switch nothing passes a format to (`cam device on`, the panel) opens
 *   the camera the config asked for rather than 640×480 forever;
 * - an edit to the file reaches a *running* daemon, because `loadConfig`
 *   re-reads a file that moved and this is the one thing that would make the
 *   setting useless if it were wrong;
 * - a flag on one `camera start` wins for that capture and leaves the file
 *   alone, which is the difference between a preference and an argument;
 * - the status says the format even with nothing streaming, because a person
 *   deciding whether to open the camera is asking about the next capture.
 *
 * What the phone is *told* is the check that matters throughout: the desktop's
 * own status could agree with itself while the instruction on the wire said
 * something else, so every case reads the `ev:video` frame the handset would
 * have received.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { check, done } from '../../tools/test-harness.mjs'
import { connectPhone } from './phone.mjs'
import { quietBluetooth, localHeaders } from './sandbox.mjs'
import { readCamera, readFormat, WIDTH, HEIGHT, FPS, QUALITY, MAX_WIDTH, MIN_HEIGHT, MIN_FPS } from '../src/lib/video.js'

const PORT = Number(process.env.PORT || 8837)
const base = `http://127.0.0.1:${PORT}`
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'omarchy-connect-vfmt-'))
const local = () => localHeaders(path.join(sandbox, 'state'))
const configFile = quietBluetooth(sandbox, {
  port: PORT,
  deviceName: 'format-test',
  devices: [],
  video: { camera: 'front', width: 1280, height: 720, fps: 24, quality: 85 },
})

const readConfig = () => JSON.parse(fs.readFileSync(configFile, 'utf8'))
const writeVideo = (video) => {
  const cfg = readConfig()
  fs.writeFileSync(configFile, JSON.stringify({ ...cfg, video }, null, 2) + '\n', { mode: 0o600 })
}

/* ── the two readers, on their own ─────────────────────────────────────── */

// The seam the config is poured into. What a caller named wins, what it left
// out comes from the block behind it, and only a config with nothing to say
// falls back to the constants.
const cfg = { width: 1280, height: 720, fps: 24, quality: 85 }
check(
  'a request that names nothing is the config',
  JSON.stringify(readFormat({}, cfg)) === JSON.stringify(cfg),
  JSON.stringify(readFormat({}, cfg)),
)
check('a request that names something overrides it', readFormat({ width: 800 }, cfg).width === 800 && readFormat({ width: 800 }, cfg).fps === 24)
check('and an empty config is still the constants', JSON.stringify(readFormat({}, {})) === JSON.stringify({ width: WIDTH, height: HEIGHT, fps: FPS, quality: QUALITY }))
check('a config past the bounds is clamped like any other wish', readFormat({}, { width: 99999 }).width === MAX_WIDTH, String(readFormat({}, { width: 99999 }).width))
check('and nonsense in the file is the constant rather than NaN', readFormat({}, { fps: 'fast', height: null }).fps === FPS && readFormat({}, { height: null }).height === HEIGHT)
check('the lens comes from the config when nobody names one', readCamera(undefined, 'front') === 'front')
check('a named lens still wins', readCamera('back', 'front') === 'back')
check('and a lens nobody recognises anywhere is the back one', readCamera(undefined, 'periscope') === 'back')

/* ── a daemon reading that block ───────────────────────────────────────── */

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

const camera = (op, value = {}) =>
  fetch(`${base}/api/camera`, { method: 'POST', headers: local(), body: JSON.stringify({ op, value }) }).then(async (r) => ({
    status: r.status,
    body: await r.json(),
  }))

/**
 * A phone that opens its camera whenever it is asked, and remembers the ask.
 *
 * `lens` is the sensor: what it answers `video.started` with. `null` is a
 * handset that says nothing but `ok`, which is every build older than this
 * feature, and an object is one whose lens had to settle for something else.
 */
async function connect(pairCode) {
  const info = await (await fetch(`${base}/api/info`)).json()
  const phone = connectPhone(PORT, info.publicKey)
  const asked = []
  let lens = null
  let seq = 0

  const hello = await new Promise((resolve, reject) => {
    phone.ready
      .then(() =>
        phone.send({
          t: 'hello',
          pairCode,
          device: { id: 'format-test', name: 'Format Phone', platform: 'android' },
        }),
      )
      .catch(reject)
    phone.on((msg) => {
      if (msg.t === 'hello.ok') resolve(msg)
      if (msg.t === 'hello.err') reject(new Error(msg.error))
      if (msg.t === 'ev' && msg.event === 'video' && msg.data.action === 'start') {
        asked.push(msg.data)
        seq += 1
        phone.send({ t: 'req', id: seq, method: 'video.started', params: { id: msg.data.id, ok: true, ...(lens || {}) } })
      }
    })
  })

  const subscribed = new Promise((resolve) => phone.on((msg) => msg.t === 'sub.ok' && resolve(msg.events)))
  phone.send({ t: 'sub', events: ['video'] })
  await subscribed
  return { hello, asked, sensor: (size) => (lens = size) }
}

await waitForDaemon()

// Written back into the file it was missing from, so that changing it is
// opening an editor rather than being told a key exists.
const onDisk = readConfig()
check(
  'every default block the file was missing is now in it',
  onDisk.video && onDisk.terminal && onDisk.otp,
  Object.keys(onDisk).join(', '),
)

const pair = await (await fetch(`${base}/api/pair-code`, { method: 'POST', headers: local() })).json()
const phone = await connect(pair.code)

const idle = (await camera('status')).body.video
check(
  'the format is in the status with nothing streaming, the way gain is',
  idle.streaming === false && idle.camera === 'front' && idle.width === 1280 && idle.height === 720 && idle.fps === 24 && idle.quality === 85,
  JSON.stringify(idle),
)

const started = await camera('start')
check('a start that names nothing is answered', started.body?.ok === true, JSON.stringify(started.body))
check(
  'and the instruction the phone received is the config, not the constants',
  phone.asked.at(-1)?.camera === 'front' &&
    phone.asked.at(-1)?.width === 1280 &&
    phone.asked.at(-1)?.height === 720 &&
    phone.asked.at(-1)?.fps === 24 &&
    phone.asked.at(-1)?.quality === 85,
  JSON.stringify(phone.asked.at(-1)),
)
check(
  'the running capture says the same numbers',
  started.body.video.camera === 'front' && started.body.video.width === 1280,
  JSON.stringify(started.body.video),
)
await camera('stop')

/* ── a flag beats the file, for one capture ────────────────────────────── */

const once = await camera('start', { camera: 'back', width: 800, fps: 10 })
check('a start with flags is answered too', once.body?.ok === true, JSON.stringify(once.body))
check(
  'what was typed wins and what was not still comes from the file',
  phone.asked.at(-1)?.camera === 'back' &&
    phone.asked.at(-1)?.width === 800 &&
    phone.asked.at(-1)?.fps === 10 &&
    phone.asked.at(-1)?.height === 720 &&
    phone.asked.at(-1)?.quality === 85,
  JSON.stringify(phone.asked.at(-1)),
)
await camera('stop')
check(
  'and the file is exactly what it was — a flag is an argument, not a preference',
  JSON.stringify(readConfig().video) === JSON.stringify({ camera: 'front', width: 1280, height: 720, fps: 24, quality: 85 }),
  JSON.stringify(readConfig().video),
)
const after = (await camera('status')).body.video
check('so the next capture is still the one the file asked for', after.camera === 'front' && after.width === 1280, JSON.stringify(after))

/* ── an edit reaches a daemon that is already running ──────────────────── */

writeVideo({ camera: 'back', width: 320, height: 240, fps: 5, quality: 40 })
const edited = await camera('start')
check(
  'a config edited under a running daemon is read on the next start',
  phone.asked.at(-1)?.camera === 'back' &&
    phone.asked.at(-1)?.width === 320 &&
    phone.asked.at(-1)?.height === 240 &&
    phone.asked.at(-1)?.fps === 5 &&
    phone.asked.at(-1)?.quality === 40,
  JSON.stringify(phone.asked.at(-1)),
)
check('with no restart anywhere in it', edited.body?.ok === true && daemon.exitCode === null)
await camera('stop')

// A capture is not what publishes the setting: the status has to move too, or
// the panel reading `status.json` would draw yesterday's numbers.
const reread = (await camera('status')).body.video
check('and the status moved with it', reread.width === 320 && reread.fps === 5, JSON.stringify(reread))

/* ── it is the same after the daemon has been and gone ─────────────────── */

// The file is the whole persistence story, so the check that matters is that
// the daemon never wrote over the person's edit on its way past.
check(
  'the edit survives everything the daemon did afterwards',
  JSON.stringify(readConfig().video) === JSON.stringify({ camera: 'back', width: 320, height: 240, fps: 5, quality: 40 }),
  JSON.stringify(readConfig().video),
)

/* ── the phone answers with the size it could actually open ────────────── */

/**
 * The acceptance criterion this suite exists to hold: a handset whose sensor
 * has no such mode starts on the nearest one it does have rather than
 * refusing, and the desktop records *that* rather than its own wish. It
 * matters because everything downstream takes the size as a promise — the
 * `.mjpeg` file is whatever the frames are, and the published camera is told a
 * width once and never checks — so a desktop believing its own request would
 * be a status that disagrees with `ffprobe` and a camera that scales a
 * squashed picture up to a size nothing ever sent.
 */
writeVideo({ camera: 'back', width: 1280, height: 720, fps: 15, quality: 70 })
phone.sensor({ width: 1024, height: 768, fps: 12 })
const clamped = await camera('start')
check('a phone with no such mode still starts', clamped.body?.ok === true, JSON.stringify(clamped.body))
check(
  'and it was asked for the size the desktop wanted',
  phone.asked.at(-1)?.width === 1280 && phone.asked.at(-1)?.height === 720,
  JSON.stringify(phone.asked.at(-1)),
)
check(
  'the capture is the size the phone opened, not the size it was asked for',
  clamped.body.video.width === 1024 && clamped.body.video.height === 768 && clamped.body.video.fps === 12,
  JSON.stringify(clamped.body.video),
)
check(
  'with what was asked for kept beside it, so the difference can be explained',
  clamped.body.video.requested?.width === 1280 && clamped.body.video.requested?.height === 720,
  JSON.stringify(clamped.body.video.requested),
)
const during = (await camera('status')).body.video
check(
  'and the status says the same thing while it is streaming',
  during.width === 1024 && during.height === 768,
  JSON.stringify({ width: during.width, height: during.height }),
)
// The quality was never the phone's to answer, so it comes from the request.
check('a field the phone did not answer is still the one that was asked for', during.quality === 70, String(during.quality))
await camera('stop')
const settled = (await camera('status')).body.video
check(
  'a finished capture leaves the next one asking for the config again',
  settled.width === 1280 && settled.height === 720,
  JSON.stringify({ width: settled.width, height: settled.height }),
)

// An app too old to say anything but `ok` is the case that has to keep
// working, because it is every build shipped before this one.
phone.sensor(null)
const silent = await camera('start')
check(
  'a phone that names no size is taken at the desktop\'s word, as it always was',
  silent.body.video.width === 1280 && silent.body.video.height === 720,
  JSON.stringify(silent.body.video),
)
await camera('stop')

// And nonsense is clamped rather than believed: the bounds in `lib/video.js`
// are about what the rest of the daemon can be handed, and an answer is no
// more trusted than a request.
phone.sensor({ width: 99999, height: 0, fps: -4 })
const silly = await camera('start')
check(
  'an answer past the bounds is clamped like any other number',
  silly.body.video.width === MAX_WIDTH && silly.body.video.height === MIN_HEIGHT && silly.body.video.fps === MIN_FPS,
  JSON.stringify(silly.body.video),
)
await camera('stop')

done('camera format checks')
