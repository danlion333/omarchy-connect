/**
 * The camera's hot path, byte for byte.
 *
 * One frame leaves the phone fifteen times a second, and until this suite
 * existed it left as a base64 string: the native module encoded it, the bridge
 * carried a third more bytes than there were, and `api/video` handed it to
 * `atob` and then walked the result one `charCodeAt` at a time — in Hermes, on
 * the thread the interface is drawn on. Nothing was wrong with the picture
 * that arrived, which is exactly why it survived so long; what was wrong was
 * how much of the app's own JavaScript thread went into producing it.
 *
 * So what is asserted here is not "a frame arrives" — `test/videoframe.mjs`
 * already holds the format against the daemon's parser — but *what shape it
 * travels in*. Two checks carry that, and they fail for different reasons:
 *
 *   - The bytes the native module handed over are the bytes on the wire, with
 *     every value above 127 and every zero intact. A payload that had gone
 *     through a string would come back mangled, and one that had gone through
 *     `atob` on a `Uint8Array` would throw.
 *   - `globalThis.atob` is never called at all. It is replaced here with
 *     something that counts and refuses, so a reimplementation that quietly
 *     puts the decode back fails rather than passes slowly.
 *
 * The native side of the same change — a Kotlin `ByteArray` in the event
 * payload rather than `Base64.encodeToString` — cannot be reached from here.
 * `Camera.kt` is proved on the handset, by the frame rate the desktop reports.
 */
import module from 'node:module'

import { check, done } from '../../tools/test-harness.mjs'
import { HEADER_BYTES } from '../src/lib/videoframe.ts'
import { parseFrame } from '../../daemon/src/lib/video.js'

module.register('./stubs/loader.mjs', import.meta.url)

const { startVideoResponder } = await import('../src/api/video.ts')

/** Every call to the one decoder Hermes has, whoever makes it. */
let decodes = 0
globalThis.atob = () => {
  decodes += 1
  throw new Error('atob is not on this road any more')
}

/** A socket that remembers what was written to it, and answers yes. */
function fakeClient() {
  const handlers = new Map()
  return {
    bytes: [],
    calls: [],
    on(event, fn) {
      handlers.set(event, fn)
      return () => handlers.delete(event)
    },
    emit(event, data) {
      return handlers.get(event)?.(data)
    },
    call(method, params) {
      this.calls.push({ method, params })
      return Promise.resolve({ ok: true })
    },
    sendBytes(frame) {
      this.bytes.push(frame)
    },
  }
}

/**
 * A picture only in the ways this road cares about: the SOI marker the desktop
 * insists on, then every byte value there is, so a payload that went through a
 * string somewhere comes back different rather than merely shorter.
 */
const jpeg = new Uint8Array(1024)
jpeg[0] = 0xff
jpeg[1] = 0xd8
for (let i = 2; i < jpeg.length; i += 1) jpeg[i] = i % 256

const client = fakeClient()
const handle = startVideoResponder(client)
const fire = (payload) => globalThis.__mic.listeners.onCameraFrame?.(payload)

/* ── a frame with nowhere to go is not sent ────────────────────────────── */

fire({ jpeg, seq: 0 })
check('a frame that arrives before the desktop asked is dropped', client.bytes.length === 0)

/* ── the desktop asks, and the pictures go out whole ───────────────────── */

await client.emit('ev:video', { action: 'start', id: 'v1', stream: 9, camera: 'back' })
check('the lens was opened for the stream the desktop handed out', globalThis.__camera.starts === 1)

fire({ jpeg, seq: 0 })
fire({ jpeg, seq: 1 })
check('both pictures reached the socket', client.bytes.length === 2, String(client.bytes.length))

const sent = client.bytes[0]
check('and what was written is bytes rather than a string', sent instanceof Uint8Array, typeof sent)
check('with the whole picture behind the header', sent.length === HEADER_BYTES + jpeg.length, String(sent.length))

// The daemon's own parser, because "the bytes survived" is its question and
// not this file's opinion of it.
const read = parseFrame(Buffer.from(sent))
check('the desktop reads back the stream it asked for', read.stream === 9, String(read.stream))
check('and the number the phone gave the frame', read.seq === 0, String(read.seq))
check('and every byte of the picture unchanged', Buffer.from(jpeg).equals(read.jpeg), `${read.jpeg.length} bytes`)
check('including the ones above 127 a string would have mangled', read.jpeg[0xff] === 0xff && read.jpeg[128] === 128)

/* ── and nothing on the way was base64 ─────────────────────────────────── */

check('the frame never went near a base64 decoder', decodes === 0, `${decodes} calls to atob`)
// The source itself, because a decode moved one function along would still
// leave `decodes` at zero here while costing exactly as much on the phone.
const source = await import('node:fs').then((fs) =>
  fs.readFileSync(new URL('../src/api/video.ts', import.meta.url), 'utf8'),
)
const hot = source.slice(source.indexOf("addListener('onCameraFrame'"))
check('and there is no base64 left on the hot path', !/\batob\b|charCodeAt/.test(hot))

handle.stop()
done()
