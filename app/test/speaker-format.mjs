/**
 * Which track this phone opens, and what it tells the desktop it opened.
 *
 * `speakerframe.mjs` next door checks the rule on its own — `readPlayFormat`
 * is a dozen lines and every input it can be given is checked there. This
 * suite is about the two things that only exist once the rule is wired to a
 * socket and a track, and both of them are silent when they are wrong:
 *
 *   - **The answer must describe the track, not the request.** The desktop
 *     sends whatever `audio.playing` names. A phone that asked for 48 kHz
 *     stereo, was refused a track by Android, opened the baseline instead and
 *     still answered "48 kHz stereo" would be sent six times the bytes it can
 *     play, through a track that would render them as noise at three times
 *     the speed — and every counter on both ends would say the link was
 *     healthy.
 *   - **A desktop that never heard of the offer must be answered as it always
 *     was.** That is not a hypothetical: the daemon on the machine and the
 *     app on the phone are updated separately and days apart, and the whole
 *     shape of this negotiation exists so that either order works.
 *
 * The native player is the stub in `test/stubs`, which records the format it
 * was asked for and can be told to refuse anything but the baseline — which
 * is exactly what a handset whose `AudioTrack.getMinBufferSize` says no looks
 * like from here.
 */
import module from 'node:module'

import { check, done } from '../../tools/test-harness.mjs'

module.register('./stubs/loader.mjs', import.meta.url)

const { startSpeakerResponder } = await import('../src/api/speaker.ts')

const speaker = () => globalThis.__speaker

const reset = () =>
  Object.assign(speaker(), {
    supported: true,
    running: false,
    starts: 0,
    stops: 0,
    last: null,
    written: [],
    refuse: null,
    onlyBaseline: false,
  })

/** A socket that hands the responder one instruction and keeps what came back. */
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

/** One `play` instruction, answered. Returns what the phone did and said. */
async function play(instruction) {
  reset()
  const client = fakeClient()
  const seen = []
  const handle = startSpeakerResponder(client, (state) => seen.push(state))
  await client.emit('ev:audio', { action: 'play', id: 'p1', stream: 3, chunkMs: 20, ...instruction })
  const answer = client.calls.find((c) => c.method === 'audio.playing')?.params
  return { answer, opened: speaker().last, starts: speaker().starts, state: seen.at(-1), handle }
}

/* ── a desktop that offers the better format ───────────────────────────── */

const offered = await play({ rate: 16000, channels: 1, offer: { rate: 48000, channels: 2 } })
check(
  'an offered format is what the track is opened at',
  offered.opened?.rate === 48000 && offered.opened?.channels === 2,
  JSON.stringify(offered.opened),
)
check(
  'and what the desktop is told to send',
  offered.answer?.ok === true && offered.answer?.rate === 48000 && offered.answer?.channels === 2,
  JSON.stringify(offered.answer),
)
check('with one track opened and not two', offered.starts === 1, String(offered.starts))
check(
  'and the card can say what is playing',
  offered.state?.playing === true && offered.state?.format?.rate === 48000,
  JSON.stringify(offered.state),
)
offered.handle.stop()

/* ── a desktop too old to offer anything ───────────────────────────────── */

const old = await play({ rate: 16000, channels: 1 })
check(
  'an instruction with no offer opens the baseline',
  old.opened?.rate === 16000 && old.opened?.channels === 1,
  JSON.stringify(old.opened),
)
check(
  'and is answered without asking the desktop for anything new',
  old.answer?.ok === true && old.answer?.rate === 16000 && old.answer?.channels === 1,
  JSON.stringify(old.answer),
)
old.handle.stop()

// The oldest shape there is: the `play` this road shipped with carried a rate
// and a chunk length and nothing else. It must still play.
const ancient = await play({ rate: undefined, channels: undefined })
check(
  'and so does one with no format fields at all',
  ancient.opened?.rate === 16000 && ancient.opened?.channels === 1 && ancient.answer?.ok === true,
  JSON.stringify({ opened: ancient.opened, answer: ancient.answer }),
)
ancient.handle.stop()

/* ── a handset Android will not give the offered track ─────────────────── */

const reluctant = await (async () => {
  reset()
  speaker().onlyBaseline = true
  const client = fakeClient()
  const handle = startSpeakerResponder(client)
  await client.emit('ev:audio', {
    action: 'play',
    id: 'p2',
    stream: 4,
    chunkMs: 20,
    rate: 16000,
    channels: 1,
    offer: { rate: 48000, channels: 2 },
  })
  return { answer: client.calls.find((c) => c.method === 'audio.playing')?.params, opened: speaker().last, handle }
})()
check(
  'a phone refused the offered track falls back to the baseline',
  reluctant.opened?.rate === 16000 && reluctant.opened?.channels === 1,
  JSON.stringify(reluctant.opened),
)
check(
  'and says so, rather than reporting the format it asked for',
  reluctant.answer?.ok === true && reluctant.answer?.rate === 16000 && reluctant.answer?.channels === 1,
  JSON.stringify(reluctant.answer),
)
reluctant.handle.stop()

/* ── and one that cannot play at all still says why ────────────────────── */

const broken = await (async () => {
  reset()
  speaker().refuse = 'this handset has no output'
  const client = fakeClient()
  const handle = startSpeakerResponder(client)
  await client.emit('ev:audio', {
    action: 'play',
    id: 'p3',
    stream: 5,
    chunkMs: 20,
    offer: { rate: 48000, channels: 2 },
  })
  return { answer: client.calls.find((c) => c.method === 'audio.playing')?.params, handle }
})()
check(
  'a phone that cannot open any track refuses with a sentence',
  broken.answer?.ok === false && /no output/.test(broken.answer?.error || ''),
  JSON.stringify(broken.answer),
)
broken.handle.stop()

done('speaker format checks')
