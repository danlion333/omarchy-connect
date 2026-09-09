/**
 * The phone's camera, from the desktop's side of the wire.
 *
 * Nothing in a suite can point a lens at anything, so what is exercised here
 * is everything the desktop is responsible for around one: that the pictures
 * are asked for rather than pushed, that a third kind of frame climbs the same
 * encrypted socket without confusing the two that were already on it, that the
 * bytes land in a file `ffprobe` will read as MJPEG, that a frame belonging to
 * a stream which has ended is dropped rather than appended, that a frame the
 * desktop will not take is refused *without* costing the link, and that a
 * socket dying mid-frame leaves a playable file rather than a capture waiting
 * forever.
 *
 * The refusals are the checks the issue was really about. A JPEG is tens of
 * kilobytes where a chunk of sound is 640 bytes, so the ceiling matters here
 * in a way it never did for audio — and the failure it guards against is
 * specific: one frame of something that is not a picture, written into the
 * middle of an MJPEG file, costs every frame after it. So a frame past the
 * ceiling, a frame with no JPEG marker and a frame for somebody else's stream
 * are all dropped in silence, and the daemon that dropped them is still
 * answering afterwards. That last clause is the whole point of asking twice.
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
import {
  Capture,
  buildFrame,
  parseFrame,
  isVideoFrame,
  readFormat,
  FPS,
  HEIGHT,
  WIDTH,
  MAX_FPS,
  MAX_FRAME_BYTES,
} from '../src/lib/video.js'
import { buildFrame as buildAudioFrame, isAudioFrame } from '../src/lib/mic.js'

const PORT = Number(process.env.PORT || 8823)
const base = `http://127.0.0.1:${PORT}`
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'omarchy-connect-video-'))
const local = () => localHeaders(path.join(sandbox, 'state'))
const videoDir = path.join(sandbox, '.cache', 'omarchy-connect', 'video')

quietBluetooth(sandbox, { port: PORT, deviceName: 'video-test', devices: [] })

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

/** `omarchy-connect camera <op>`, as the CLI issues it. */
const camera = (op, value = {}) =>
  fetch(`${base}/api/camera`, { method: 'POST', headers: local(), body: JSON.stringify({ op, value }) }).then(async (r) => ({
    status: r.status,
    body: await r.json(),
  }))

/**
 * A picture with a JPEG's first two bytes and a recognisable body, so that a
 * file which is the right length and the wrong bytes is still a failure.
 *
 * Not a real JPEG. The desktop only ever appends these, and `ffprobe`'s
 * opinion of a real one is exercised on the phone rather than here — a suite
 * that generated valid JPEG in JavaScript would be testing its own encoder.
 */
function picture(n, size = 3000) {
  const jpeg = Buffer.alloc(size)
  jpeg.writeUInt16BE(0xffd8, 0)
  jpeg.writeUInt32BE(n, 2)
  for (let i = 6; i < size; i += 1) jpeg[i] = (n * 7 + i * 31) % 256
  return jpeg
}

/**
 * A phone that answers `video` instructions the way the app does — and can be
 * told not to, so the suite can watch the desktop time out on a handset that
 * never says whether it could look.
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
          device: { id: 'video-test', name: 'Video Phone', platform: 'android' },
        }),
      )
      .catch(reject)
    phone.on((msg) => {
      if (msg.t === 'paired') issued = msg.token
      if (msg.t === 'hello.ok') resolve(msg)
      if (msg.t === 'hello.err') reject(new Error(msg.error))
      if (msg.t === 'ev' && msg.event === 'video') {
        heard.push(msg.data)
        if (!obedient) return
        if (msg.data.action === 'start') {
          stream = msg.data.stream
          req('video.started', { id: msg.data.id, ok: true }).catch(() => {})
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

  const subscribed = new Promise((resolve) => {
    phone.on((msg) => msg.t === 'sub.ok' && resolve(msg.events))
  })
  phone.send({ t: 'sub', events: ['video'] })
  await subscribed

  /** `n` frames, numbered so the file can be read back frame by frame. */
  let sent = 0
  const film = (frames, { on = null, from = null, size = 3000 } = {}) => {
    let bytes = 0
    for (let i = 0; i < frames; i += 1) {
      const jpeg = picture(sent, size)
      phone.sendBytes(buildFrame(on ?? stream ?? 0, from === null ? sent : from + i, jpeg))
      bytes += jpeg.length
      sent += 1
    }
    return bytes
  }

  return { hello, req, phone, heard, film, token: () => issued, streamOf: () => stream, sentSoFar: () => sent }
}

await waitForDaemon()

/* ── the codec, held against itself ────────────────────────────────────── */

const one = picture(3)
const round = parseFrame(buildFrame(9, 41, one))
check('a frame carries its stream, its sequence and its picture', round.stream === 9 && round.seq === 41 && round.jpeg.equals(one))
check('JSON is never mistaken for video', !isVideoFrame(Buffer.from('{"t":"ping"}')))
check('and neither is a chunk of microphone', !isVideoFrame(buildAudioFrame(1, 0, Buffer.alloc(640))))
check('nor a picture for a chunk of microphone', !isAudioFrame(buildFrame(1, 0, one)))

const refuses = (frame, pattern) => {
  try {
    parseFrame(frame)
    return false
  } catch (err) {
    return pattern.test(err.message)
  }
}
check('a frame past the ceiling is refused whole', refuses(buildFrame(1, 0, picture(0, MAX_FRAME_BYTES + 1)), /too large/))
check('a frame that is not a JPEG is refused rather than written into the middle of a file', refuses(buildFrame(1, 0, Buffer.from([1, 2, 3, 4])), /JPEG marker/))
check('and an empty one is refused too', refuses(buildFrame(1, 0, Buffer.alloc(0)), /no picture/))

/* ── what a request may ask for ────────────────────────────────────────── */

// Clamped rather than refused, on purpose: a phone asked for something its
// camera has never heard of should get the nearest thing it can do, and a
// person typing `--fps 500` wants the fastest available rather than an error.
check('a request nobody filled in is the default', JSON.stringify(readFormat({})) === JSON.stringify({ width: WIDTH, height: HEIGHT, fps: FPS, quality: 70 }), JSON.stringify(readFormat({})))
check('an absurd frame rate is clamped rather than refused', readFormat({ fps: 500 }).fps === MAX_FPS, String(readFormat({ fps: 500 }).fps))
check('and nonsense is the default rather than NaN', readFormat({ width: 'wide', fps: null }).width === WIDTH && readFormat({ fps: null }).fps === FPS)

/* ── what the phone is told it can do ──────────────────────────────────── */

const pair = await (await fetch(`${base}/api/pair-code`, { method: 'POST', headers: local() })).json()
const phone = await connect({ pairCode: pair.code })
const caps = phone.hello.capabilities?.video
check('the desktop says it can take a camera stream', caps?.receive === true, JSON.stringify(caps))
check('and names the one encoding it takes', caps?.encoding === 'jpeg', JSON.stringify(caps))
check('and both lenses it will ask for', Array.isArray(caps?.cameras) && caps.cameras.includes('front') && caps.cameras.includes('back'), JSON.stringify(caps?.cameras))
check('the video channel is on the list a phone may subscribe to', (phone.hello.events || []).includes('video'), JSON.stringify(phone.hello.events))

/* ── a stream, all the way through ─────────────────────────────────────── */

const started = await camera('start', { camera: 'front', fps: 10 })
check('the desktop can ask the phone for its camera', started.body?.ok === true, JSON.stringify(started.body))
const asked = phone.heard.find((e) => e.action === 'start')
check('and the instruction names the lens and the format so the two ends cannot drift', asked?.camera === 'front' && asked?.fps === 10 && asked?.encoding === 'jpeg', JSON.stringify(asked))

const filmed = phone.film(40)
await wait(400)
const midway = await camera('status')
check('the desktop knows it is watching while it is', midway.body?.video?.streaming === true, JSON.stringify(midway.body?.video))
check('and counts the frames it has taken', midway.body?.video?.frames === 40, JSON.stringify(midway.body?.video))

// A JSON request in the middle of a stream: three kinds of frame now share
// one socket and one nonce counter, and a suite that only sent pictures would
// never notice if pictures had broken the JSON road.
const pong = await phone.req('video.status')
check('an ordinary request still works mid-stream', pong?.streaming === true, JSON.stringify(pong))
const stillAudio = await phone.req('audio.status')
check('and so does the microphone road, which shares the socket', stillAudio?.streaming === false, JSON.stringify(stillAudio))

const stopped = await camera('stop')
const file = stopped.body?.video?.path
check('stopping answers with the capture', typeof file === 'string' && file.startsWith(videoDir), String(file))
check('the phone is told to stop as well', phone.heard.some((e) => e.action === 'stop'), JSON.stringify(phone.heard))

const written = fs.readFileSync(file)
check('every byte filmed reached the disk', written.length === filmed, `${written.length} for ${filmed}`)
check('the file begins with a JPEG, which is what makes it an MJPEG stream', written.readUInt16BE(0) === 0xffd8)
check(
  'and holds the pictures the phone sent, in order',
  written.subarray(0, 3000).equals(picture(0)) && written.subarray(3000, 6000).equals(picture(1)),
)
check('nothing was dropped on a stream the disk kept up with', stopped.body?.video?.dropped === 0, JSON.stringify(stopped.body?.video))
check('and no hole was reported on a stream that had none', stopped.body?.video?.gaps === 0, JSON.stringify(stopped.body?.video))
check('the capture reports a frame rate it actually achieved', Number(stopped.body?.video?.fps) > 0, JSON.stringify(stopped.body?.video))

/* ── what does not get in, and what it costs ───────────────────────────── */

// Every one of these is dropped in silence, and after all of them the daemon
// is still answering. Silence is the contract — a `res` per refused frame
// would be a burst of errors at a phone that is already doing the right
// thing — so "still alive" is the only observable, and it is the one that
// matters.
const second = await camera('start')
const live = second.body?.video?.path
check('a second stream gets a file of its own', live !== file, String(live))

phone.film(3)
await wait(200)
const beforeJunk = (await camera('status')).body?.video?.frames

// Somebody else's stream: a frame that was in flight when a run ended, or one
// from a socket the phone has since replaced.
phone.film(5, { on: 999 })
// Not a picture at all.
phone.phone.sendBytes(buildFrame(phone.streamOf(), 900, Buffer.from([0x00, 0x01, 0x02, 0x03])))
// Past the ceiling, but under the socket's own `maxPayload`, so the frame
// reaches the routing rather than closing the connection.
phone.phone.sendBytes(buildFrame(phone.streamOf(), 901, picture(0, MAX_FRAME_BYTES + 1024)))
// Empty.
phone.phone.sendBytes(buildFrame(phone.streamOf(), 902, Buffer.alloc(0)))
await wait(400)

const afterJunk = await camera('status')
check(
  'a frame for a stream that is not the live one is dropped, not appended',
  afterJunk.body?.video?.frames === beforeJunk,
  `${afterJunk.body?.video?.frames} vs ${beforeJunk}`,
)
check('and the daemon is still answering after all of it', afterJunk.body?.video?.streaming === true, JSON.stringify(afterJunk.body?.video))
const stillThere = await phone.req('video.status')
check('on the socket that sent the junk, too', stillThere?.streaming === true, JSON.stringify(stillThere))

const goodAgain = phone.film(2, { from: 903 })
await wait(300)
const recovered = await camera('status')
check(
  'and a good frame after a bad one is taken',
  recovered.body?.video?.frames === beforeJunk + 2,
  `${recovered.body?.video?.frames} vs ${beforeJunk + 2}`,
)
check('with the hole the refused frames left counted rather than papered over', recovered.body?.video?.gaps > 0, JSON.stringify(recovered.body?.video))
void goodAgain

const ended = await camera('stop')
check('the capture ends with the file it was writing', ended.body?.video?.path === live, JSON.stringify(ended.body?.video))
const idle = await camera('stop')
check('stopping when nothing is streaming is refused rather than pretended', idle.status === 400, JSON.stringify(idle.body))

/* ── the phone offering, rather than being asked ───────────────────────── */

const startsBefore = phone.heard.filter((e) => e.action === 'start').length
const offered = await phone.req('video.offer', { op: 'start', camera: 'front' })
check('the phone can offer its own camera', offered?.streaming === true, JSON.stringify(offered))
check('and is told the file the desktop opened for it', typeof offered?.path === 'string' && offered.path.startsWith(videoDir), String(offered?.path))
check(
  'the instruction still went out on the video channel, so there is one road in and not two',
  phone.heard.filter((e) => e.action === 'start').length === startsBefore + 1,
  JSON.stringify(phone.heard.map((e) => e.action)),
)
const offeredBytes = phone.film(6)
await wait(300)
const takenBack = await phone.req('video.offer', { op: 'stop' })
check('and a second press stops it', takenBack?.streaming === false, JSON.stringify(takenBack))
check('leaving a file holding exactly what was filmed into it', fs.readFileSync(offered.path).length === offeredBytes, `${fs.readFileSync(offered.path).length} for ${offeredBytes}`)

let refused = null
try {
  await phone.req('video.offer', { op: 'stop' })
} catch (err) {
  refused = err.message
}
check('stopping nothing is refused rather than pretended', /not streaming/.test(refused || ''), String(refused))

const twice = await phone.req('video.offer', { op: 'start' })
let doubled = null
try {
  await phone.req('video.offer', { op: 'start' })
} catch (err) {
  doubled = err.message
}
check('offering a camera that is already streaming is refused with a sentence', /already streaming/.test(doubled || ''), String(doubled))
check('offering it again did not disturb the stream that was running', (await camera('status')).body?.video?.stream === twice.stream, JSON.stringify(twice))
await camera('stop')

/* ── the switch takes the camera off the phone, whoever started it ─────── */

// The bug this is here for: `camera device off` used to tell the handset to
// stop only when that same switch had started the stream, so a stream the
// phone had offered itself — or one started with `camera start` — went on
// filming after the desktop had taken the camera away. The indicator stayed
// lit and the `CameraDevice` stayed open with nobody watching.
//
// The device itself needs a loopback this machine may not have, and it does
// not need one for this: the switch's `off` is the whole subject, and it is
// the same `off` whether or not there was ever a node to take down.
const raised = await phone.req('video.offer', { op: 'start' })
check('the phone can offer its camera with the desktop switch off', raised?.streaming === true, JSON.stringify(raised))
const stopsBefore = phone.heard.filter((e) => e.action === 'stop').length
const given = await camera('device', 'off')
await wait(200)
check(
  'and the switch tells the handset to stop even though it never started that stream',
  phone.heard.filter((e) => e.action === 'stop').length === stopsBefore + 1,
  JSON.stringify(phone.heard.map((e) => e.action)),
)
check('the desktop is not watching either', given.body?.video?.streaming !== true, JSON.stringify(given.body?.video))
check('and the camera is not published here', given.body?.video?.device?.enabled === false, JSON.stringify(given.body?.video?.device))
const stillAnswering = await camera('device', 'off')
check('turning off a switch that is already off is still an answer rather than a throw', stillAnswering.status === 200, JSON.stringify(stillAnswering.body))

/* ── a socket that dies mid-frame ──────────────────────────────────────── */

const third = await camera('start')
const orphanPath = third.body?.video?.path
phone.film(4)
await wait(300)
phone.phone.ws.terminate()

let closed = null
for (let i = 0; i < 20 && closed === null; i += 1) {
  await wait(100)
  const state = await camera('status')
  if (state.body?.video?.streaming === false) closed = i
}
check('a socket dying mid-stream leaves nothing streaming on the desktop', closed !== null, `after ${(closed ?? 20) * 100}ms`)
const orphan = fs.readFileSync(orphanPath)
check(
  'and the file it was writing is still a stream of whole pictures — MJPEG has no header to patch',
  orphan.length === 4 * 3000 && orphan.readUInt16BE(0) === 0xffd8 && orphan.subarray(9000, 12000).readUInt16BE(0) === 0xffd8,
  `${orphan.length} bytes`,
)

/* ── the phone comes back ──────────────────────────────────────────────── */

const again = await connect({ token: phone.token() })
const fourth = await camera('start')
check('a reconnected phone starts a clean stream', fourth.body?.ok === true, JSON.stringify(fourth.body))
const fresh = fourth.body?.video?.path
again.film(5)
await wait(300)
const freshEnd = await camera('stop')
check('and the new capture holds only what the new socket sent', fs.readFileSync(fresh).length === 5 * 3000, `${fs.readFileSync(fresh).length} bytes`)
check('with its own stream number', freshEnd.body?.video?.path === fresh, JSON.stringify(freshEnd.body?.video))

/* ── the press that raced the desktop's own question ───────────────────── */

again.phone.ws.terminate()
await wait(300)
const deaf = await connect({ token: phone.token(), obedient: false })
const racing = camera('start')
await wait(150)
let racedError = null
try {
  await deaf.req('video.offer', { op: 'start' })
} catch (err) {
  racedError = err.message
}
check('a press that arrives while the desktop is still waiting for an answer is refused, not doubled', /has already been asked/.test(racedError || ''), String(racedError))
check('and the phone was told once, not twice', deaf.heard.filter((e) => e.action === 'start').length === 1, JSON.stringify(deaf.heard.map((e) => e.action)))
const timedOut = await racing
check('the outstanding request still times out on its own', timedOut.status === 400 && /did not answer/.test(timedOut.body?.error || ''), JSON.stringify(timedOut.body))
deaf.phone.ws.terminate()

/* ── the slow consumer ─────────────────────────────────────────────────── */

// The ceiling, on its own, with a sink that never drains. What must not happen
// is the queue growing with the capture: ten minutes of pictures into a
// consumer reading nothing is a couple of hundred megabytes, and the whole
// point is that the daemon holds a fixed fraction of it and says how many
// frames it threw away.
const stalled = new Writable({ write() { /* never calls back: the viewer is gone */ } })
const slow = new Capture({ file: null, sink: stalled, maxQueueBytes: 256 * 1024 })
const many = 2000
for (let i = 0; i < many; i += 1) slow.push(picture(i, 30 * 1024))
check('a stalled consumer costs a fixed amount of memory', slow.queued <= 256 * 1024 + 30 * 1024, `${slow.queued} bytes queued`)
check(
  'and what it holds is the newest pictures, not the oldest',
  slow.queue.at(-1).readUInt32BE(2) === many - 1 && slow.queue[0].readUInt32BE(2) >= many - 12,
  `frames ${slow.queue[0].readUInt32BE(2)}..${slow.queue.at(-1).readUInt32BE(2)} of ${many}`,
)
check('nothing is ever half a picture, because half a JPEG is not half a frame', slow.queue.every((frame) => frame.readUInt16BE(0) === 0xffd8))
check('what could not be written is counted in frames rather than silently lost', slow.dropped > many - 20, `${slow.dropped} dropped of ${many}`)

const gappy = new Capture({ file: null, sink: new Writable({ write(c, e, cb) { cb() } }) })
gappy.push(picture(0), 0)
gappy.push(picture(1), 5)
check('a hole the phone left is noticed rather than spliced over', gappy.gaps === 4, String(gappy.gaps))
check('and the frames that did arrive are still counted', gappy.frames === 2, String(gappy.frames))
await gappy.close()

/* ── the captures are swept ────────────────────────────────────────────── */

check(
  'captures live in the cache, not somewhere anybody keeps files',
  fs.readdirSync(videoDir).every((name) => name.startsWith('cam-') && name.endsWith('.mjpeg')),
  fs.readdirSync(videoDir).join(', '),
)

done('camera stream checks')
