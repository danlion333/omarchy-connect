/**
 * Two recorders, one hardware input.
 *
 * The live microphone stream (`api/mic`) belongs to the socket and is opened
 * by the desktop. Dictation (`api/dictate`) belongs to the agent screen and is
 * opened by a thumb. They are the same one microphone on the phone, and until
 * this suite existed neither knew the other was there: a tap on the dictate
 * button opened a second recorder over a live stream, Android handed the input
 * to whichever it liked, and the desktop was left with a PipeWire source that
 * was still in every microphone list on the machine and had silence in it.
 *
 * What is checked here is the *state*, because the state is the whole of the
 * bug. On the handset this was reproduced on the two recorders coexist quite
 * happily — so a suite that only checked "does the stream survive" would have
 * passed against the broken code as well. What could not have passed is the
 * middle case below: an input Android really does take away, which the phone
 * now hands back rather than reporting as the end of the stream.
 *
 * The native recorder is the stub in `test/stubs`, which counts how often the
 * microphone was opened and given back; `expo-audio` is the stub beside it.
 */
import module from 'node:module'

import { check, done } from '../../tools/test-harness.mjs'

module.register('./stubs/loader.mjs', import.meta.url)

const { startMicResponder, NO_MIC } = await import('../src/api/mic.ts')
const dictate = await import('../src/api/dictate.ts')

const mic = () => globalThis.__mic
const audio = () => globalThis.__audio
const reset = () => {
  Object.assign(mic(), { supported: true, permission: true, grants: true, asked: 0, running: false, starts: 0, stops: 0, refuse: null })
  Object.assign(audio(), { granted: true, asked: 0, modes: [] })
}

/** A socket that answers whatever the test says, and remembers what it sent. */
function fakeClient() {
  const handlers = new Map()
  const sent = []
  return {
    calls: sent,
    on(event, fn) {
      handlers.set(event, fn)
      return () => handlers.delete(event)
    },
    emit(event, data) {
      return handlers.get(event)?.(data)
    },
    call(method, params) {
      sent.push({ method, params })
      return Promise.resolve({ ok: true })
    },
    sendBytes() {},
  }
}

/** The responder with a stream already running, the way the desktop leaves it. */
async function streaming() {
  reset()
  dictate.release()
  const client = fakeClient()
  const seen = []
  const handle = startMicResponder(client, (state) => seen.push(state))
  await client.emit('ev:audio', { action: 'start', id: 'a1', stream: 7, chunkMs: 20 })
  return { client, seen, handle, state: () => seen.at(-1) ?? NO_MIC }
}

/** The recorder the composer holds, reduced to the two calls dictation makes. */
const recorder = () => ({ stop: async () => {}, uri: 'file:///dictation.m4a' })

const stopped = (client) => client.calls.filter((c) => c.method === 'audio.stopped')

/* ── a dictation over a live stream the handset can carry ─────────────── */

{
  const { client, state, handle } = await streaming()
  check('the desktop has the microphone before anything is dictated', state().listening === true && mic().starts === 1)

  await dictate.ready()
  check('dictation asked for its own permission', audio().asked === 1)
  check('and the live stream is still open under it', mic().running === true && mic().stops === 0)
  check('and the card still says the desktop is listening', state().listening === true && state().stream === 7)

  const said = await dictate.finish(recorder())
  check('the dictation still hands back its file', said === 'file:///dictation.m4a')
  check('the stream was never stopped or restarted around it', mic().starts === 1 && mic().stops === 0)
  check('and MicState.listening never fell without the desktop saying so', state().listening === true, JSON.stringify(state()))
  check('so the desktop was never told its stream ended', stopped(client).length === 0, JSON.stringify(client.calls))
  handle.stop()
}

/* ── a handset that really does take the input away ───────────────────── */

{
  const { client, state, handle } = await streaming()
  await dictate.ready()
  // Android handing the input to the second recorder: the native module
  // notices its read failed and says the recording ended. Before this issue
  // that call closed the stream one-way, and nothing ever opened it again.
  mic().listeners.onMicStopped({ error: 'the phone stopped recording (code -3)' })

  check('an input taken during a dictation is not the end of the stream', state().listening === true, JSON.stringify(state()))
  check('and the desktop is not told to close its file', stopped(client).length === 0, JSON.stringify(client.calls))
  check('and no error is put on the card for a gap that is about to fill', state().error === null)

  await dictate.finish(recorder())
  check('giving the microphone back opens the input again', mic().starts === 2 && mic().running === true)
  check('and the card comes out of it still listening on the same stream', state().listening === true && state().stream === 7)

  // Having been taken once, this handset is known not to run both at once.
  let refused = null
  try {
    await dictate.ready()
  } catch (err) {
    refused = err.message
  }
  check('the next dictation over a live stream is refused', refused !== null)
  check('and refused in a sentence rather than in silence', /microphone/.test(refused || ''), String(refused))
  check('and the stream it would have cost is still open', mic().running === true && state().listening === true)
  check('and no second recorder was ever prepared for it', audio().asked === 2)
  handle.stop()
}

/* ── the same handset, with nothing listening ─────────────────────────── */

{
  const { client, state, handle } = await streaming()
  await dictate.ready()
  mic().listeners.onMicStopped({ error: 'taken' })
  await dictate.finish(recorder())
  await client.emit('ev:audio', { action: 'stop', stream: 7 })
  check('the desktop can still stop the stream it asked for', state().listening === false && mic().running === false)

  const before = mic().starts
  await dictate.ready()
  check('and dictating with nothing listening is not refused', true)
  await dictate.finish(recorder())
  check('nor does letting go start a microphone nobody asked for', mic().starts === before && mic().running === false)
  handle.stop()
}

/* ── a screen that goes away mid-recording ────────────────────────────── */

{
  const { state, handle } = await streaming()
  await dictate.ready()
  mic().listeners.onMicStopped({ error: 'taken' })
  // The composer unmounts — a tab switch, a back gesture — with the recorder
  // still open and `finish` never called.
  dictate.release()
  check('an abandoned dictation still gives the input back', mic().starts === 2 && mic().running === true)
  check('and the stream it interrupted is listening again', state().listening === true)
  check('releasing twice is not a second borrow', (dictate.release(), mic().starts === 2))
  handle.stop()
}

/* ── the microphone with no socket at all ─────────────────────────────── */

{
  reset()
  dictate.release()
  // No responder running: the app is not connected to anything, and dictation
  // is the only thing that wants the microphone.
  await dictate.ready()
  await dictate.finish(recorder())
  check('dictation works with no live stream to borrow from', mic().starts === 0 && audio().asked === 1)
}

done()
