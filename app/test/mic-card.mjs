/**
 * What the microphone card is allowed to say.
 *
 * The card is one boolean and one sentence, and both of them are lies that
 * would be very hard to notice on a phone: a card reading "off" over a live
 * microphone, or one that reports nothing at all when a press could not go
 * through. Neither shows up in a screenshot of a working case, so the state
 * machine behind the card is checked here rather than by pressing it.
 *
 * The thing under test is `startMicResponder`, which is deliberately not a
 * component: it belongs to the socket, so a stream survives the screen that
 * started it being unmounted twice over — a tab switch, the phone going in a
 * pocket, the app coming back an hour later. Every check below is written
 * against the state it *reports*, because that is the only thing the card can
 * draw.
 *
 * The native recorder is the stub in `test/stubs`, which is a switch and a
 * count of how often the microphone was opened and given back — the one fact
 * no amount of correct-looking state can substitute for.
 */
import module from 'node:module'

import { check, done } from '../../tools/test-harness.mjs'

module.register('./stubs/loader.mjs', import.meta.url)

const { startMicResponder, NO_MIC } = await import('../src/api/mic.ts')

const mic = () => globalThis.__mic
const reset = () => {
  Object.assign(mic(), { supported: true, permission: true, grants: true, asked: 0, running: false, starts: 0, stops: 0, refuse: null })
}

/** A socket that answers whatever the test says, whenever the test says it. */
function fakeClient() {
  const handlers = new Map()
  const sent = []
  let answer = () => Promise.resolve({})
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
      return answer(method, params)
    },
    sendBytes() {},
    answers(fn) {
      answer = fn
    },
  }
}

/** The responder, plus everything it has ever reported. */
function responder() {
  reset()
  const client = fakeClient()
  const seen = []
  const handle = startMicResponder(client, (state) => seen.push(state))
  return { client, seen, handle, state: () => seen.at(-1) ?? NO_MIC }
}

const wait = () => new Promise((r) => setTimeout(r, 0))

/* ── the desktop asking, with a card open ──────────────────────────────── */

{
  const { client, state, handle } = responder()
  client.answers(() => Promise.resolve({ ok: true }))
  await client.emit('ev:audio', { action: 'start', id: 'a1', stream: 3, chunkMs: 100 })
  check('a desktop that asks for the microphone lights the card', state().listening === true, JSON.stringify(state()))
  check('and the card names the stream the desktop handed out', state().stream === 3, JSON.stringify(state()))
  check('and the microphone was actually opened', mic().starts === 1 && mic().running === true)

  await client.emit('ev:audio', { action: 'stop', stream: 3 })
  check('and the card goes out when the desktop stops', state().listening === false, JSON.stringify(state()))
  check('with the microphone given back', mic().running === false && mic().stops === 1)
  handle.stop()
}

/* ── the phone offering ────────────────────────────────────────────────── */

{
  const { client, state, handle } = responder()
  // The desktop's answer is held open until the instruction has been obeyed,
  // exactly as the daemon holds it: the press is not finished until the
  // recorder is actually running.
  client.answers(async (method) => {
    if (method === 'audio.offer') {
      await client.emit('ev:audio', { action: 'start', id: 'b1', stream: 9, chunkMs: 100 })
      return { streaming: true, stream: 9, path: '/home/dan/.cache/omarchy-connect/audio/mic-b1.wav' }
    }
    return { ok: true }
  })

  const pressing = handle.offer()
  check('a press says so before the desktop has answered', state().busy === true, JSON.stringify(state()))
  await pressing
  check('a press starts the stream', state().listening === true, JSON.stringify(state()))
  check('and the card is told where the desktop is writing it', state().path?.endsWith('mic-b1.wav') === true, JSON.stringify(state()))
  check('and it is the desktop that asked, so there is still one road into the recorder', mic().starts === 1)
  check('the press is over', state().busy === false, JSON.stringify(state()))

  // Nothing at all happens between the press and the next press: this is the
  // tab switch, the pocket, the hour. The state is the responder's, not a
  // screen's, so a card mounted now reads exactly what one mounted then read.
  check('and a screen that comes back to it still finds a live microphone', state().listening === true && state().stream === 9)

  client.answers(async (method) => {
    if (method === 'audio.offer') {
      await client.emit('ev:audio', { action: 'stop', stream: 9 })
      return { streaming: false }
    }
    return { ok: true }
  })
  await handle.offer()
  check('a second press takes the microphone back', state().listening === false, JSON.stringify(state()))
  check('and the recorder was closed once, by the one road', mic().stops >= 1 && mic().running === false)
  handle.stop()
}

/* ── every refusal is a sentence ───────────────────────────────────────── */

{
  const { client, state, handle } = responder()
  mic().permission = false
  mic().grants = false
  client.answers(() => Promise.resolve({ streaming: true }))
  await handle.offer()
  check('a permission the user would not grant is a sentence, not a shrug', /not granted/.test(state().error || ''), String(state().error))
  check('and the desktop was never told to ask', client.calls.length === 0, JSON.stringify(client.calls))
  check('the card is still off', state().listening === false && state().busy === false)
  handle.stop()
}

{
  const { client, state, handle } = responder()
  mic().supported = false
  await handle.offer()
  check('a build that cannot record says so', /cannot stream/.test(state().error || ''), String(state().error))
  handle.stop()
}

{
  const { client, state, handle } = responder()
  client.answers(() => Promise.reject(new Error('unknown method: audio.offer')))
  await handle.offer()
  check(
    'a desktop too old for this is translated into something a person can act on',
    /too old/.test(state().error || '') && /update/.test(state().error || ''),
    String(state().error),
  )
  handle.stop()
}

{
  const { client, state, handle } = responder()
  client.answers(() => Promise.reject(new Error('the phone is already streaming its microphone')))
  await handle.offer()
  check("the desktop's own refusal is shown as the desktop wrote it", state().error === 'the phone is already streaming its microphone', String(state().error))
  handle.stop()
}

/* ── the microphone taken away underneath ──────────────────────────────── */

{
  const { client, state, handle } = responder()
  client.answers(() => Promise.resolve({ ok: true }))
  await client.emit('ev:audio', { action: 'start', id: 'c1', stream: 4, chunkMs: 100 })
  client.calls.length = 0
  mic().listeners.onMicStopped({ error: 'another app took the microphone' })
  await wait()
  check('an input another app took is a sentence on the card', /another app/.test(state().error || ''), String(state().error))
  check('and the card goes out with it', state().listening === false, JSON.stringify(state()))
  check('and the desktop is told rather than left waiting', client.calls[0]?.method === 'audio.stopped', JSON.stringify(client.calls))
  handle.stop()
}

/* ── a socket that went away ───────────────────────────────────────────── */

{
  const { client, state, handle } = responder()
  client.answers(() => Promise.resolve({ ok: true }))
  await client.emit('ev:audio', { action: 'start', id: 'd1', stream: 5, chunkMs: 100 })
  client.emit('status', { status: 'reconnecting' })
  check('a link that dropped takes the card down with it', state().listening === false, JSON.stringify(state()))
  check('and the microphone with it', mic().running === false)
  check('and says nothing about a desktop it is no longer talking to', state().error === null, String(state().error))
  handle.stop()
}

/* ── what the card knows before anything happens ───────────────────────── */

{
  const { client, state, handle } = responder()
  client.answers((method) =>
    method === 'audio.status'
      ? Promise.resolve({ streaming: true, stream: 12, path: '/tmp/mic-e1.wav' })
      : Promise.resolve({ ok: true }),
  )
  client.emit('hello', { capabilities: { audio: { receive: true, offer: true } } })
  await wait()
  check(
    'an app that started under a live stream asks the desktop rather than guessing',
    state().listening === true && state().stream === 12,
    JSON.stringify(state()),
  )
  handle.stop()
}

{
  const { client, state, handle } = responder()
  client.answers(() => Promise.resolve({ streaming: false }))
  client.emit('hello', { capabilities: {} })
  await wait()
  check('a desktop with no microphone road at all is not asked', client.calls.length === 0, JSON.stringify(client.calls))
  check('and the card has nothing to say', state().listening === false)
  handle.stop()
}

done('microphone card checks')
