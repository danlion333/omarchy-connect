/**
 * The channel itself, asked whether it gives back what it was given.
 *
 * Every other suite here tests a feature: what happens when a call comes in,
 * what the desktop does when a phone asks to be found. This one tests the
 * ground all of them stand on — the encrypted frame, the counter that numbers
 * it, the JSON inside it and the dispatch on the other side. None of that has
 * a feature of its own, so nothing has been asking it anything.
 *
 * It is written as round trips on purpose, because a round trip is the one
 * shape of test that cannot quietly agree with a bug. An assertion about what
 * the daemon returns is only ever as good as this suite's opinion of what it
 * should return — and an opinion written after the fact tends to be a
 * transcript of the behaviour rather than a judgement on it. "What comes back
 * is what went out" needs no opinion. Either the bytes match or they do not,
 * and the suite does not get a vote.
 *
 * This project is unusually well placed to be tested that way. Both ends are
 * here: the daemon is the thing under test and `phone.mjs` is a second,
 * independent implementation of the same protocol written against Node's own
 * crypto. Two implementations agreeing is evidence. One implementation
 * agreeing with itself is a tautology, and most of what an automated reader
 * would otherwise be handed is exactly that.
 *
 * What is deliberately not here: anything with a side effect. Every exchange
 * below is a ping, a subscription, or a call to a method that does not exist —
 * chosen so this can be run in a loop, on a schedule, by something with no
 * judgement, without touching the machine it runs on.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { check, done } from '../../tools/test-harness.mjs'
import { connectPhone } from './phone.mjs'
import { quietBluetooth, localHeaders } from './sandbox.mjs'

const PORT = Number(process.env.PORT || 8806)
const base = `http://127.0.0.1:${PORT}`
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'omarchy-connect-roundtrip-'))

// The local HTTP routes are gated on the secret the daemon publishes in its
// own status file, so every post below reads it the way the CLI does.
const local = () => localHeaders(path.join(sandbox, 'state'))
quietBluetooth(sandbox)

const daemon = spawn(
  process.execPath,
  [path.join(root, 'bin', 'omarchy-connect.js'), 'start', '--port', String(PORT)],
  {
    env: {
      ...process.env,
      XDG_CONFIG_HOME: sandbox,
      OMARCHY_CONNECT_STATE: path.join(sandbox, 'state'),
      OMARCHY_CONNECT_LOG: 'error',
    },
    stdio: ['ignore', 'ignore', 'inherit'],
  },
)
process.on('exit', () => {
  daemon.kill('SIGTERM')
  fs.rmSync(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

for (let i = 0; i < 40; i += 1) {
  try {
    if ((await fetch(`${base}/api/info`)).ok) break
  } catch {
    await new Promise((r) => setTimeout(r, 250))
  }
}

/**
 * Everything a socket has said, and a way to wait for the part you care about.
 *
 * Polling rather than a queue of one-shot listeners, because several of the
 * checks below are about messages arriving *together* — twenty-five answers to
 * twenty-five questions — and counting a list is a much more direct way to ask
 * that than composing promises.
 */
function inbox(phone) {
  const seen = []
  phone.on((msg) => seen.push(msg))
  return {
    seen,
    async until(match, count = 1, ms = 8000) {
      const deadline = Date.now() + ms
      for (;;) {
        const hits = seen.filter(match)
        if (hits.length >= count) return hits
        if (Date.now() > deadline) return hits
        await new Promise((r) => setTimeout(r, 25))
      }
    },
  }
}

const info = await (await fetch(`${base}/api/info`)).json()

/* ── the gate ───────────────────────────────────────────────────────────── */

// A socket that has not said who it is gets one answer to everything. Checked
// first because every other check below is only meaningful on the far side of
// it: if this were open, nothing further would be evidence of anything.
{
  const stranger = connectPhone(PORT, info.publicKey)
  const heard = inbox(stranger)
  await stranger.ready
  stranger.send({ t: 'ping' })
  const [refusal] = await heard.until((m) => m.t === 'error', 1, 4000)
  check('a socket that has not said hello is refused', refusal?.error === 'not authenticated', refusal?.error)
  check('and is refused before it is answered', !heard.seen.some((m) => m.t === 'pong'))
  stranger.close()
}

/* ── a phone that has ───────────────────────────────────────────────────── */

const code = (await (await fetch(`${base}/api/pair-code`, { method: 'POST', headers: local() })).json()).code
const phone = connectPhone(PORT, info.publicKey)
const heard = inbox(phone)

await phone.ready
phone.send({
  t: 'hello',
  pairCode: code,
  device: { id: 'roundtrip-test-device', name: 'Test phone', platform: 'android', model: 'Test' },
})
const [hello] = await heard.until((m) => m.t === 'hello.ok' || m.t === 'hello.err')
check('the test phone paired', hello?.t === 'hello.ok' && hello.protocol === 2, hello?.error || String(hello?.protocol))

/* ── what goes in comes out ─────────────────────────────────────────────── */

/**
 * The daemon names an unknown message type back at whoever sent it, which
 * makes that reply the one honest echo in the protocol: the string travels
 * out through JSON, a ChaCha20 frame and a counter, and comes back the same
 * way. Anything the round trip mangles shows up here and nowhere else.
 */
async function echoes(label, text) {
  // Counted rather than "the most recent one": each call leaves a refusal
  // behind, so a check that reached for the last error in the list could pass
  // on the previous call's answer while this one was still in flight. The
  // index is which refusal this call is responsible for.
  const before = heard.seen.filter((m) => m.t === 'error').length
  phone.send({ t: text })
  const hits = await heard.until((m) => m.t === 'error', before + 1, 6000)
  const got = hits[before]?.error?.replace(/^unknown message type: /, '')
  check(
    `${label} survives the round trip`,
    got === text,
    got === text ? `${text.length} chars` : `got ${got === undefined ? 'nothing' : `${got.length} chars`} of ${text.length}`,
  )
}

await echoes('plain ascii', 'not-a-real-message-type')
// The app is used in a language with accents and by people who type emoji, and
// every one of those is multi-byte on the wire where the length in characters
// and the length in bytes stop agreeing.
await echoes('accents and emoji', 'типу-повідомлення-🙂-ünïcødé')
// A frame big enough not to be a single small write. The counter is per frame,
// so a message that arrives split or joined is a message that decrypts to
// nothing at all.
await echoes('four kilobytes', `big-${'x'.repeat(4000)}`)
// The characters that would end the string early if anything on the way built
// this by concatenation rather than by encoding it.
await echoes('quotes and newlines', 'a"b\\c\nd\te')

/* ── one question, one answer ───────────────────────────────────────────── */

// The nonce is a counter, so a frame counted twice or not at all does not
// arrive corrupted — it fails to decrypt and the socket dies. Twenty-five
// answers to twenty-five questions is the cheapest way to say that never
// happened.
{
  const before = heard.seen.filter((m) => m.t === 'pong').length
  const asked = 25
  for (let i = 0; i < asked; i += 1) phone.send({ t: 'ping' })
  const pongs = await heard.until((m) => m.t === 'pong', before + asked, 8000)
  check(`${asked} pings are answered ${asked} times`, pongs.length - before === asked, `${pongs.length - before}`)
  check('every answer is stamped', pongs.slice(before).every((p) => Number.isFinite(p.at)))
}

/* ── every request keeps its own name ───────────────────────────────────── */

// Requests carry an id because answers may arrive in any order, and an id that
// came back on the wrong answer would put a file's bytes in a message's place.
// A method that does not exist is used on purpose: it exercises the whole
// request path and changes nothing on the machine.
{
  const ids = Array.from({ length: 12 }, (_, i) => `rt-${i}-${Math.random().toString(36).slice(2, 8)}`)
  const before = heard.seen.filter((m) => m.t === 'res').length
  for (const id of ids) phone.send({ t: 'req', id, method: `no.such.method.${id}` })

  const all = await heard.until((m) => m.t === 'res', before + ids.length, 8000)
  const mine = all.slice(before)
  check('every request is answered exactly once', mine.length === ids.length, `${mine.length} of ${ids.length}`)
  check('no answer arrives under an id nobody asked for', mine.every((r) => ids.includes(r.id)))
  check('no id is answered twice', new Set(mine.map((r) => r.id)).size === mine.length)
  // The pairing itself: an answer must name the method its own id was sent
  // with, not merely some method that was asked for around the same time.
  check(
    'each answer belongs to the request that asked it',
    mine.every((r) => r.error === `unknown method: no.such.method.${r.id}`),
    mine.find((r) => r.error !== `unknown method: no.such.method.${r.id}`)?.error,
  )
  check('and an unknown method is a refusal rather than a silence', mine.every((r) => r.ok === false))
}

/* ── what a subscription is ─────────────────────────────────────────────── */

// A set, not a list: the app resubscribes on every reconnect, and a phone that
// accumulated a duplicate would be sent every event twice.
{
  // Indexed for the same reason `echoes` is: three subscriptions in a row all
  // answer with `sub.ok`, and the answer this call is waiting for is the one
  // at its own position, not whichever arrived most recently.
  const ask = async (message) => {
    const before = heard.seen.filter((m) => m.t === 'sub.ok').length
    phone.send(message)
    const hits = await heard.until((m) => m.t === 'sub.ok', before + 1, 6000)
    return hits[before]
  }

  const doubled = await ask({ t: 'sub', events: ['stats', 'stats', 'clipboard'] })
  check(
    'subscribing twice to one event subscribes once',
    doubled?.events?.filter((e) => e === 'stats').length === 1,
    JSON.stringify(doubled?.events),
  )

  const bogus = await ask({ t: 'sub', events: ['definitely-not-an-event'] })
  check(
    'an event the desktop does not publish is not accepted',
    !bogus?.events?.includes('definitely-not-an-event'),
    JSON.stringify(bogus?.events),
  )
  check('and refusing it does not drop what was already held', bogus?.events?.includes('stats'))

  const dropped = await ask({ t: 'unsub', events: ['stats'] })
  check('unsubscribing removes exactly what was named', !dropped?.events?.includes('stats'), JSON.stringify(dropped?.events))
  check('and leaves the rest alone', dropped?.events?.includes('clipboard'))
}

/* ── still there ────────────────────────────────────────────────────────── */

// The last word. Every check above pushed frames through a counter that both
// ends increment independently; if either had lost count, the next frame would
// not decrypt and this would time out rather than fail. Asking one more
// question at the end is what turns all of the above from "the answers looked
// right" into "the channel was still the same channel when it finished".
{
  const before = heard.seen.filter((m) => m.t === 'pong').length
  phone.send({ t: 'ping' })
  const pongs = await heard.until((m) => m.t === 'pong', before + 1, 6000)
  check('the channel is still open after all of it', pongs.length > before)
  check('and nothing arrived that could not be decrypted', daemon.exitCode === null, `daemon exit ${daemon.exitCode}`)
}

phone.close()
done('round-trip checks')
