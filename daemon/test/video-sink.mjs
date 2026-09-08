/**
 * The phone as a camera this whole desktop can see.
 *
 * `video.mjs` covers the pictures arriving; this is what happens to them next.
 * The thing being tested publishes a PipeWire node or writes into a kernel
 * loopback device, and neither of those can be done for real inside a suite:
 * a node would appear in the camera list of the machine running the tests, and
 * a `/dev/video` device needs a `modprobe` and therefore root. So `ffmpeg` and
 * `gst-launch-1.0` are stand-ins on PATH — and, as in `audio-input.mjs`, they
 * are not mocks that record arguments and nothing else. Each one does the one
 * thing the real tool does that matters here: it reads its stdin and copies it
 * somewhere the suite can read. That is what lets these checks be about the
 * bytes that came out of the far end of the chain rather than about the fact
 * that a process was started.
 *
 * The `/sys` tree is a stand-in for the same reason, through
 * `OMARCHY_CONNECT_V4L2_CLASS`. The v4l2 road is the one most programs on a
 * real desktop actually use, and it is also the one that cannot exist on a
 * machine where nobody has run `modprobe`. Testing only the road this laptop
 * happens to have would leave the other one to be discovered by whoever
 * followed the README.
 *
 * The checks that are really about the issue: a desktop with the tools offers
 * the camera and one without says why not; the node is published with the
 * properties that make a browser treat it as a camera; the frames the phone
 * sent come out of the far end unchanged; a loopback device is preferred over
 * the node and written into by device path; turning it on twice starts one
 * chain and not two; a phone that goes quiet leaves the picture frozen rather
 * than the camera gone; turning it off leaves nothing running; a daemon killed
 * with `-9` leaves an orphan that the next daemon kills before publishing
 * anything of its own; and a desktop with no `v4l2loopback` gets a working
 * PipeWire camera and a sentence saying what to install for the other half.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { check, done } from '../../tools/test-harness.mjs'
import { connectPhone } from './phone.mjs'
import { quietBluetooth, localHeaders } from './sandbox.mjs'
import { buildFrame } from '../src/lib/video.js'
import { CARD_LABEL, DESCRIPTION, KEEPALIVE_MS, MARK, NODE_NAME } from '../src/lib/videosink.js'

const PORT = Number(process.env.PORT || 8829)
const SECOND_PORT = PORT + 1
const BLIND_PORT = PORT + 2
const base = `http://127.0.0.1:${PORT}`
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'omarchy-connect-video-sink-'))
const local = () => localHeaders(path.join(sandbox, 'state'))

/* ── the stand-in tools ────────────────────────────────────────────────── */

const fakeBin = path.join(sandbox, 'bin')
const spool = path.join(sandbox, 'spool')
fs.mkdirSync(fakeBin, { recursive: true })
fs.mkdirSync(spool, { recursive: true })

const ffmpegLog = path.join(spool, 'ffmpeg.args')
const gstLog = path.join(spool, 'gst.args')
const markLog = path.join(spool, 'marks')
/** What a PipeWire consumer would have seen: the far end of the whole chain. */
const node = path.join(spool, 'node.raw')
/** What a `/dev/video` consumer would have seen. */
const device = path.join(spool, 'device.raw')
for (const file of [ffmpegLog, gstLog, markLog, node, device]) fs.writeFileSync(file, '')

/**
 * `ffmpeg`, reduced to the two shapes this daemon asks it for.
 *
 * With `-f v4l2` it is the whole chain and writes where the device would be;
 * otherwise it is the decoder in the middle and passes its stdin along to the
 * publisher. It does not decode anything, which is the point — a suite that
 * decoded JPEG would be testing `ffmpeg`, and what is in question here is
 * whether the daemon's own bytes reach the far end in order and entire.
 */
fs.writeFileSync(
  path.join(fakeBin, 'ffmpeg'),
  [
    '#!/bin/bash',
    `printf '%s\\n' "$*" >> ${JSON.stringify(ffmpegLog)}`,
    // The mark is what `reap()` finds in /proc; recording it here is how the
    // suite knows the children really carry it rather than that the constant
    // exists.
    `printf 'ffmpeg %s %s\\n' "$$" "$${MARK}" >> ${JSON.stringify(markLog)}`,
    'out=""',
    'prev=""',
    'for a in "$@"; do',
    '  if [ "$prev" = "-f" ] && [ "$a" = "v4l2" ]; then out="device"; fi',
    '  prev="$a"',
    'done',
    `if [ "$out" = "device" ]; then exec cat >> ${JSON.stringify(device)}; fi`,
    'exec cat',
    '',
  ].join('\n'),
  { mode: 0o755 },
)

fs.writeFileSync(
  path.join(fakeBin, 'gst-launch-1.0'),
  [
    '#!/bin/bash',
    `printf '%s\\n' "$*" >> ${JSON.stringify(gstLog)}`,
    `printf 'gst %s %s\\n' "$$" "$${MARK}" >> ${JSON.stringify(markLog)}`,
    `exec cat >> ${JSON.stringify(node)}`,
    '',
  ].join('\n'),
  { mode: 0o755 },
)

/** The probe: every element the pipeline names is here unless told otherwise. */
fs.writeFileSync(
  path.join(fakeBin, 'gst-inspect-1.0'),
  ['#!/bin/bash', 'if [ -n "$OMARCHY_TEST_NO_GST" ]; then exit 1; fi', 'exit 0', ''].join('\n'),
  { mode: 0o755 },
)

/** The module is not installed, which is the state this desk is really in. */
fs.writeFileSync(
  path.join(fakeBin, 'modinfo'),
  ['#!/bin/bash', 'if [ -n "$OMARCHY_TEST_MODULE" ]; then exit 0; fi', 'exit 1', ''].join('\n'),
  { mode: 0o755 },
)

const args = (file) => fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)

/* ── a /sys tree with one invented camera in it ────────────────────────── */

/**
 * Shaped like the real one, symlink for symlink, because the daemon's test for
 * "is this a loopback" is whether the device's entry resolves into
 * `/devices/virtual` — the same test that tells `v4l2loopback` apart from the
 * webcam plugged into this machine.
 */
const sys = path.join(sandbox, 'sys')
const sysClass = path.join(sys, 'class', 'video4linux')
const virtualDev = path.join(sys, 'devices', 'virtual', 'video4linux', 'video9')
fs.mkdirSync(sysClass, { recursive: true })
fs.mkdirSync(virtualDev, { recursive: true })
fs.writeFileSync(path.join(virtualDev, 'name'), `${CARD_LABEL}\n`)
fs.symlinkSync(virtualDev, path.join(sysClass, 'video9'))

/** And a real camera beside it, so "the first video device" is not the answer. */
const realDev = path.join(sys, 'devices', 'pci0000:00', 'video4linux', 'video0')
fs.mkdirSync(realDev, { recursive: true })
fs.writeFileSync(path.join(realDev, 'name'), 'Some Webcam\n')
fs.symlinkSync(realDev, path.join(sysClass, 'video0'))

/** An empty one, for the desktop that has no loopback at all. */
const emptySys = path.join(sandbox, 'sys-empty', 'class', 'video4linux')
fs.mkdirSync(emptySys, { recursive: true })

/* ── a daemon that can see all of it ───────────────────────────────────── */

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

function environment(port, extra = {}) {
  quietBluetooth(sandbox, { port, deviceName: `video-sink-${port}`, devices: [] })
  return {
    ...process.env,
    PATH: `${fakeBin}:${process.env.PATH}`,
    HOME: sandbox,
    XDG_CONFIG_HOME: sandbox,
    XDG_CACHE_HOME: path.join(sandbox, '.cache'),
    XDG_RUNTIME_DIR: path.join(sandbox, 'run'),
    OMARCHY_CONNECT_STATE: path.join(sandbox, 'state'),
    OMARCHY_CONNECT_LOG: 'warn',
    OMARCHY_CONNECT_V4L2_CLASS: emptySys,
    TMUX_TMPDIR: sandbox,
    ...extra,
  }
}

const running = new Set()
function boot(port, extra = {}) {
  const child = spawn(
    process.execPath,
    [path.join(root, 'bin', 'omarchy-connect.js'), 'start', '--port', String(port)],
    { env: environment(port, extra), stdio: ['ignore', 'ignore', 'inherit'] },
  )
  running.add(child)
  return child
}

let daemon = boot(PORT)

process.on('exit', () => {
  for (const child of running) child.kill('SIGKILL')
  // The stand-ins are `cat`, and a `cat` whose parent died keeps reading: the
  // suite has to clear its own orphans or it leaves the very thing it is
  // testing the daemon for.
  for (const pid of marked()) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      /* gone */
    }
  }
  fs.rmSync(sandbox, { recursive: true, force: true })
})

/** Every process on this machine still carrying the sink's mark. */
function marked() {
  const found = []
  for (const name of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue
    try {
      if (fs.readFileSync(`/proc/${name}/environ`, 'utf8').includes(`${MARK}=${NODE_NAME}`)) found.push(Number(name))
    } catch {
      /* not ours */
    }
  }
  return found
}

async function waitForDaemon(at) {
  for (let i = 0; i < 60; i += 1) {
    try {
      if ((await fetch(`${at}/api/info`)).ok) return
    } catch {
      await wait(250)
    }
  }
  throw new Error(`daemon on ${at} did not start`)
}

const cam = (body, at = base) =>
  fetch(`${at}/api/camera`, { method: 'POST', headers: local(), body: JSON.stringify(body) }).then(async (r) => ({
    status: r.status,
    body: await r.json(),
  }))

/** A picture with a JPEG's marker and a body that is recognisable byte for byte. */
function picture(n, size = 2048) {
  const jpeg = Buffer.alloc(size)
  jpeg.writeUInt16BE(0xffd8, 0)
  jpeg.writeUInt32BE(n, 2)
  for (let i = 6; i < size; i += 1) jpeg[i] = (n * 13 + i * 7) % 256
  return jpeg
}

/** The app's side: answers a `video` instruction and can film into it. */
async function connect(port, pairCode) {
  const info = await (await fetch(`http://127.0.0.1:${port}/api/info`)).json()
  const phone = connectPhone(port, info.publicKey)
  let stream = null
  let seq = 0

  const hello = await new Promise((resolve, reject) => {
    phone.ready
      .then(() =>
        phone.send({ t: 'hello', pairCode, device: { id: 'video-sink', name: 'Sink Phone', platform: 'android' } }),
      )
      .catch(reject)
    phone.on((msg) => {
      if (msg.t === 'hello.ok') resolve(msg)
      if (msg.t === 'hello.err') reject(new Error(msg.error))
      if (msg.t === 'ev' && msg.event === 'video') {
        if (msg.data.action === 'start') {
          stream = msg.data.stream
          phone.send({ t: 'req', id: 800 + stream, method: 'video.started', params: { id: msg.data.id, ok: true } })
        }
        if (msg.data.action === 'stop') stream = null
      }
    })
  })

  const subscribed = new Promise((resolve) => phone.on((msg) => msg.t === 'sub.ok' && resolve(msg.events)))
  phone.send({ t: 'sub', events: ['video'] })
  await subscribed

  const film = (count, size = 2048) => {
    const sent = []
    for (let i = 0; i < count; i += 1) {
      const jpeg = picture(seq, size)
      phone.sendBytes(buildFrame(stream ?? 0, seq, jpeg))
      sent.push(jpeg)
      seq += 1
    }
    return Buffer.concat(sent)
  }

  return { hello, phone, film }
}

await waitForDaemon(base)

/* ── what the phone is told ────────────────────────────────────────────── */

const pair = await (await fetch(`${base}/api/pair-code`, { method: 'POST', headers: local() })).json()
const phone = await connect(PORT, pair.code)
const caps = phone.hello.capabilities?.video?.device
check('a desktop with ffmpeg and pipewire offers the phone as a camera', caps?.available === true, JSON.stringify(caps))
check('and names what a person will see in their picker', caps?.description === DESCRIPTION, JSON.stringify(caps))
check('which is off until somebody asks for it', caps?.enabled === false, JSON.stringify(caps))
check(
  'a desktop with no v4l2loopback says so, and says what to install',
  caps?.module === 'missing' && /pacman -S v4l2loopback-dkms/.test(caps?.hint || ''),
  JSON.stringify({ module: caps?.module, hint: caps?.hint }),
)
check(
  'and offers the PipeWire road anyway rather than nothing at all',
  Array.isArray(caps?.modes) && caps.modes.includes('pipewire') && !caps.modes.includes('v4l2'),
  JSON.stringify(caps?.modes),
)

/* ── switching it on ───────────────────────────────────────────────────── */

const on = await cam({ op: 'device', value: 'on' })
const state = on.body?.video?.device
check('the switch answers with a published camera', state?.enabled === true, JSON.stringify(on.body?.video?.device))
check('on the road this desktop actually has', state?.mode === 'pipewire', JSON.stringify(state))
check('turning it on also asks the handset to film', state?.streaming === true, JSON.stringify(state))
check('exactly one chain was started for it', args(ffmpegLog).length === 1 && args(gstLog).length === 1, `${args(ffmpegLog).length} ffmpeg, ${args(gstLog).length} gst`)
check(
  'the node is declared as a camera rather than as some video going past',
  /media\.class=Video\/Source/.test(args(gstLog)[0]) &&
    /media\.role=Camera/.test(args(gstLog)[0]) &&
    /mode=provide/.test(args(gstLog)[0]),
  args(gstLog)[0],
)
check(
  'under a name a person can find, and one a program can match on',
  new RegExp(`node\\.name=${NODE_NAME}`).test(args(gstLog)[0]) &&
    args(gstLog)[0].includes(`node.description=${DESCRIPTION}`),
  args(gstLog)[0],
)
check(
  'and the raw frames are given a size, because a pipe carries bytes and a node carries pictures',
  /rawvideoparse/.test(args(gstLog)[0]) && /width=640/.test(args(gstLog)[0]) && /height=480/.test(args(gstLog)[0]),
  args(gstLog)[0],
)
check(
  'the decoder is told the pictures are MJPEG and the output is raw',
  /-f mjpeg/.test(args(ffmpegLog)[0]) && /-f rawvideo/.test(args(ffmpegLog)[0]) && /scale=640:480/.test(args(ffmpegLog)[0]),
  args(ffmpegLog)[0],
)
check(
  'and every child carries the mark that lets a later daemon recognise it',
  fs.readFileSync(markLog, 'utf8').split('\n').filter(Boolean).every((line) => line.endsWith(NODE_NAME)),
  fs.readFileSync(markLog, 'utf8').trim(),
)

/* ── the pictures come out of the other end ────────────────────────────── */

const filmed = phone.film(12)
await wait(600)
const seen = fs.readFileSync(node)
check(
  'every picture the phone sent came out of the far end of the chain, in order and unchanged',
  seen.length >= filmed.length && seen.subarray(0, filmed.length).equals(filmed),
  `${seen.length} bytes out for ${filmed.length} in`,
)

/* ── on top of itself ──────────────────────────────────────────────────── */

const again = await cam({ op: 'device', value: 'on' })
check('turning it on again is not a second camera', args(gstLog).length === 1, `${args(gstLog).length} chains`)
check('and says so rather than failing', again.body?.video?.device?.enabled === true, JSON.stringify(again.body?.video?.device))

/* ── a phone that goes quiet ───────────────────────────────────────────── */

// The failure this guards against is not a crash. It is a camera that simply
// stops producing, which every program on the desktop answers differently and
// most of them answer badly. The last picture again, once a second, is a
// frozen frame — which is the thing a person in a call already knows how to
// read.
const before = fs.statSync(node).size
await wait(KEEPALIVE_MS * 2 + 400)
const after = fs.statSync(node).size
const idle = (await cam({ op: 'device', value: 'status' })).body?.video?.device
check(
  'a camera nobody is filming into keeps sending its last picture',
  after > before && idle?.repeated >= 1,
  `${after - before} bytes while quiet, repeated ${idle?.repeated}`,
)
check(
  'and counts those apart from the pictures the phone really sent',
  idle?.frames === 12,
  JSON.stringify({ frames: idle?.frames, repeated: idle?.repeated }),
)

/* ── switching it off ──────────────────────────────────────────────────── */

const off = await cam({ op: 'device', value: 'off' })
await wait(300)
check('switching it off answers with a switch that is off', off.body?.video?.device?.enabled === false, JSON.stringify(off.body?.video?.device))
check('and leaves nothing of ours running', marked().length === 0, marked().join(', '))
const stopped = fs.statSync(node).size
await wait(KEEPALIVE_MS + 300)
check('so nothing is still being written where a camera used to be', fs.statSync(node).size === stopped, `${fs.statSync(node).size} vs ${stopped}`)

/* ── a daemon killed hard leaves an orphan; the next one clears it ─────── */

await cam({ op: 'device', value: 'on' })
await wait(300)
const orphaned = marked()
check('the camera can be switched on again after being off', orphaned.length > 0, orphaned.join(', '))
daemon.kill('SIGKILL')
running.delete(daemon)
await wait(900)
// The ordinary outcome, and a happy one: the chain is fed through a pipe whose
// only writer was the daemon, so the far end reads EOF and ends by itself.
check(
  'a daemon killed with -9 usually takes its camera with it anyway, because the pipe closed',
  marked().length === 0,
  marked().join(', '),
)

// "Usually" is not "always" — a child wedged on something else keeps the node
// in every picker on the machine forever — so the sweep on the way up is
// planted with an orphan that will not go quietly and asked to prove itself.
const stubborn = spawn('sleep', ['300'], {
  env: { ...process.env, [MARK]: NODE_NAME },
  detached: true,
  stdio: 'ignore',
})
stubborn.unref()
await wait(200)
check('a camera process that does not notice is still there', marked().includes(stubborn.pid), String(stubborn.pid))

const second = boot(SECOND_PORT)
daemon = second
await waitForDaemon(`http://127.0.0.1:${SECOND_PORT}`)
await wait(400)
check(
  'and the next daemon clears it on the way up, before publishing anything of its own',
  marked().length === 0,
  marked().join(', '),
)

/* ── a desktop that has the module loaded ──────────────────────────────── */

// Everything above is the road this machine has. This is the other one, and it
// is the one Zoom and Chromium can actually see, so it does not get to be
// untested just because loading a kernel module needs root.
const third = boot(BLIND_PORT, { OMARCHY_CONNECT_V4L2_CLASS: sysClass, OMARCHY_TEST_MODULE: '1' })
const thirdBase = `http://127.0.0.1:${BLIND_PORT}`
await waitForDaemon(thirdBase)
const thirdPair = await (await fetch(`${thirdBase}/api/pair-code`, { method: 'POST', headers: local() })).json()
const thirdPhone = await connect(BLIND_PORT, thirdPair.code)
const loopCaps = thirdPhone.hello.capabilities?.video?.device
check(
  'a desktop with a loopback device says the module is loaded and names the device',
  loopCaps?.module === 'loaded' && loopCaps?.device === '/dev/video9',
  JSON.stringify({ module: loopCaps?.module, device: loopCaps?.device, hint: loopCaps?.hint }),
)
check(
  'and picks it out by the label the README told somebody to use, not by being first',
  loopCaps?.deviceLabel === CARD_LABEL,
  JSON.stringify(loopCaps?.devices),
)

const beforeDevice = args(ffmpegLog).length
const loopOn = await cam({ op: 'device', value: 'on' }, thirdBase)
check(
  'and writing into it is preferred over the node, because more programs can see it',
  loopOn.body?.video?.device?.mode === 'v4l2' && loopOn.body?.video?.device?.device === '/dev/video9',
  JSON.stringify(loopOn.body?.video?.device),
)
const loopArgs = args(ffmpegLog)[beforeDevice] || ''
check('with one process and no node beside it', /-f v4l2 \/dev\/video9$/.test(loopArgs), loopArgs)

const intoDevice = thirdPhone.film(8)
await wait(600)
const atDevice = fs.readFileSync(device)
check(
  'and the pictures reach the device the same way they reached the node',
  atDevice.length >= intoDevice.length && atDevice.subarray(0, intoDevice.length).equals(intoDevice),
  `${atDevice.length} bytes out for ${intoDevice.length} in`,
)

third.kill('SIGTERM')
running.delete(third)
await new Promise((resolve) => {
  third.on('exit', resolve)
  setTimeout(resolve, 8000)
})
await wait(400)
check('a daemon told to stop takes its camera with it', marked().length === 0, marked().join(', '))

/* ── a desktop that cannot do this at all ──────────────────────────────── */

// `ffmpeg` really is on this desk, so the desktop with nothing is the one
// whose GStreamer cannot publish: the stand-in probe says no, and with no
// loopback device either there is no road left.
const noGst = boot(PORT + 4, { OMARCHY_TEST_NO_GST: '1', OMARCHY_CONNECT_V4L2_CLASS: emptySys })
const noGstBase = `http://127.0.0.1:${PORT + 4}`
await waitForDaemon(noGstBase)
const refusedInfo = await (await fetch(`${noGstBase}/api/camera`, {
  method: 'POST',
  headers: local(),
  body: JSON.stringify({ op: 'device', value: 'status' }),
})).json()
check(
  'a desktop that can publish neither kind of camera does not offer the feature',
  refusedInfo?.video?.device?.available === false,
  JSON.stringify(refusedInfo?.video?.device),
)
const beforeRefusal = args(ffmpegLog).length
const refused = await cam({ op: 'device', value: 'on' }, noGstBase)
check(
  'and refuses the switch with a sentence rather than a crash',
  refused.status === 400 && /v4l2loopback|camera/.test(refused.body?.error || ''),
  JSON.stringify(refused.body),
)
check('having started nothing', args(ffmpegLog).length === beforeRefusal, `${args(ffmpegLog).length} vs ${beforeRefusal}`)

noGst.kill('SIGKILL')

done('phone-as-desktop-camera checks')
