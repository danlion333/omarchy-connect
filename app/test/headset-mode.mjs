/**
 * What the phone does when it is asked to be a headset.
 *
 * The thing under test is `startHeadsetResponder`, which opens nothing: the
 * microphone is still opened by `api/mic` and the track by `api/speaker`, on
 * the desktop's own instructions and with the desktop's own stream numbers.
 * All this responder decides is the *state the phone is in* when those two
 * open — one audio session, the communication source, an echo canceller on it,
 * the loudspeaker rather than the earpiece — and every one of those is fixed
 * at the moment `AudioRecord` and `AudioTrack` are constructed, which is why
 * entering the mode is a thing of its own with an answer of its own.
 *
 * Two properties are worth a suite rather than a screenshot:
 *
 *   - **The answer carries facts.** `AcousticEchoCanceler.isAvailable()` is a
 *     per-handset answer and some phones say no. A responder that answered a
 *     bare `ok` on such a phone would leave the desktop promising an echo
 *     canceller that does not exist, and the person would find that out during
 *     a call. So the phone says what it got, and the desktop prints it.
 *   - **The mode is always left.** This is the one piece of state in the app
 *     that is felt in *other* apps: a phone left in `MODE_IN_COMMUNICATION`
 *     with its communication device forced to the speaker gets its own calls
 *     and its own music wrong afterwards, with nothing on screen to explain
 *     it. So it has to be left when the desktop says so, when the socket goes,
 *     when the mode could not be entered in the first place, and when the
 *     responder itself is stopped — four roads, and the stub counts them.
 */
import module from 'node:module'

import { check, done } from '../../tools/test-harness.mjs'

module.register('./stubs/loader.mjs', import.meta.url)

const { startHeadsetResponder, NO_HEADSET } = await import('../src/api/headset.ts')

const native = () => globalThis.__headset
const reset = () => {
  Object.assign(native(), { supported: true, on: false, starts: 0, stops: 0, aecAvailable: true, refuse: null })
}

/** A socket that answers whatever the test says, and remembers what was said. */
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
  }
}

function responder() {
  reset()
  const client = fakeClient()
  const seen = []
  const handle = startHeadsetResponder(client, (state) => seen.push(state))
  return { client, seen, handle, state: () => seen.at(-1) ?? NO_HEADSET }
}

const answer = (client) => client.calls.filter((c) => c.method === 'audio.wearing').at(-1)

/* ── a desktop asking for a headset ────────────────────────────────────── */

{
  const { client, state, handle } = responder()
  await client.emit('ev:audio', { action: 'headset', id: 'h1', on: true })
  check('the phone goes into the mode when the desktop asks', native().on === true && native().starts === 1)
  check('and says so upwards, for a card that wants it', state().on === true, JSON.stringify(state()))
  check(
    'the answer carries what the handset actually got, not a bare ok',
    answer(client)?.params?.ok === true && answer(client)?.params?.aec?.enabled === true,
    JSON.stringify(answer(client)?.params),
  )
  check('with the mode it was asked for named in it', answer(client)?.params?.on === true, JSON.stringify(answer(client)?.params))

  await client.emit('ev:audio', { action: 'headset', id: 'h2', on: false })
  check('and leaves it when the desktop says so', native().on === false && native().stops === 1)
  check('reporting that upwards too', state().on === false, JSON.stringify(state()))
  handle.stop()
}

/* ── a handset with no echo canceller ──────────────────────────────────── */

{
  const { client, state, handle } = responder()
  native().aecAvailable = false
  await client.emit('ev:audio', { action: 'headset', id: 'h3', on: true })
  check('a phone with no canceller still enters the mode', native().on === true && state().on === true)
  check(
    'and says the echo is not being cancelled rather than refusing',
    answer(client)?.params?.ok === true &&
      answer(client)?.params?.aec?.available === false &&
      answer(client)?.params?.aec?.enabled === false,
    JSON.stringify(answer(client)?.params),
  )
  check('which the card can read as well', state().echoCancellation === false, JSON.stringify(state()))
  handle.stop()
}

/* ── a phone that cannot ───────────────────────────────────────────────── */

{
  const { client, state, handle } = responder()
  native().refuse = 'the phone would not go into headset mode'
  await client.emit('ev:audio', { action: 'headset', id: 'h4', on: true })
  check(
    'a refusal travels back as a sentence rather than as silence',
    answer(client)?.params?.ok === false && /headset mode/.test(answer(client)?.params?.error || ''),
    JSON.stringify(answer(client)?.params),
  )
  check('and the phone is not left half in the mode', native().on === false, JSON.stringify(native()))
  check('with the reason on the card', /headset mode/.test(state().error || ''), JSON.stringify(state()))
  handle.stop()
}

{
  const { client, handle } = responder()
  native().supported = false
  await client.emit('ev:audio', { action: 'headset', id: 'h5', on: true })
  check(
    'a build too old for the mode says so instead of timing the desktop out',
    answer(client)?.params?.ok === false && /update the app/.test(answer(client)?.params?.error || ''),
    JSON.stringify(answer(client)?.params),
  )
  handle.stop()
}

/* ── the mode is never left behind ─────────────────────────────────────── */

{
  const { client, state, handle } = responder()
  await client.emit('ev:audio', { action: 'headset', id: 'h6', on: true })
  await client.emit('status', { status: 'reconnecting' })
  check(
    'a socket that goes takes the mode with it, because nobody is left to ask',
    native().on === false && native().stops === 1,
    JSON.stringify(native()),
  )
  check('and the card goes with it', state().on === false, JSON.stringify(state()))
  check('with nothing said to a desktop that cannot hear it', client.calls.filter((c) => c.method === 'audio.wearing').length === 1)
  handle.stop()
  check('and stopping the responder does not leave a second one behind', native().stops === 1, JSON.stringify(native()))
}

{
  const { client, handle } = responder()
  await client.emit('ev:audio', { action: 'headset', id: 'h7', on: true })
  handle.stop()
  check('a responder torn down under a live mode leaves the phone out of it', native().on === false && native().stops === 1)
}

/* ── everything else on the channel is not this ────────────────────────── */

{
  const { client, handle } = responder()
  await client.emit('ev:audio', { action: 'start', id: 'h8', stream: 1 })
  await client.emit('ev:audio', { action: 'play', id: 'h9', stream: 1 })
  await client.emit('ev:audio', { action: 'headset' })
  check(
    'the microphone and the speaker instructions are not the mode',
    native().starts === 0 && client.calls.length === 0,
    JSON.stringify(native()),
  )
  handle.stop()
}

done('headset mode checks')
