/**
 * The desktop copied a picture and the phone said nothing.
 *
 * The event for a copied screenshot has arrived on the phone since #18 — it
 * goes into the clipboard history and is drawn on the share card — but the
 * shade never heard about it: the announcement was gated on `data.text` being
 * a string, and a picture's text is `null`. So the one case the feature exists
 * for, "I copied a screenshot on the desktop and put the laptop down", was the
 * one case that was silent.
 *
 * What is checked here is the decision, not the drawing: whether a card is
 * asked for at all, what it is asked to carry, and the three ways it must
 * still go up when the picture itself cannot be had. The bitmap belongs to
 * Kotlin and is looked at on the phone.
 *
 * Like the other alert suites this needs no phone: the two imports that only
 * exist on a device are swapped for `test/stubs`.
 */
import module from 'node:module'

import { check, done } from '../../tools/test-harness.mjs'

module.register('./stubs/loader.mjs', import.meta.url)

const rn = await import('react-native')
const { alertClipboard, alertClipboardImage, setAlertPrefs, DEFAULT_ALERTS } = await import('../src/api/alerts.ts')

const shade = () => globalThis.__shade
const mark = () => shade().length
const since = (at) => shade().slice(at)
const picture = { token: 'tok-screenshot', name: 'screenshot.png', size: 240_000 }

const fetched = (uri = 'file:///cache/omarchy-connect/tok-screensh/screenshot.png') => {
  let calls = 0
  const fetch = async () => {
    calls++
    return uri
  }
  return [fetch, () => calls]
}

setAlertPrefs({ ...DEFAULT_ALERTS })

/* ── the card that was never raised ─────────────────────────────────────── */

let step = mark()
let [fetch, calls] = fetched()
await alertClipboardImage(picture, fetch)
let raised = since(step)
check(
  'a copied picture asks the shade for a card',
  raised.length === 1 && raised[0].call === 'notifyClipboardImage',
  JSON.stringify(raised),
)
check('it carries the offer the Save button will spend', raised[0]?.args[0]?.token === 'tok-screenshot')
check('and the bytes that were fetched for the preview', String(raised[0]?.args[0]?.path || '').endsWith('screenshot.png'))
check('which took exactly one download', calls() === 1)

/* ── no picture is still news ───────────────────────────────────────────── */

step = mark()
await alertClipboardImage(picture, async () => {
  throw new Error('the offer expired')
})
raised = since(step)
check(
  'a preview that cannot be fetched still puts the card up',
  raised.length === 1 && raised[0].call === 'notifyClipboardImage',
  JSON.stringify(raised),
)
check('with nothing to draw', raised[0]?.args[0]?.path === null)

step = mark()
;[fetch, calls] = fetched()
await alertClipboardImage({ ...picture, size: 30 * 1024 * 1024 }, fetch)
raised = since(step)
check('a picture too large to preview is not downloaded', calls() === 0)
check(
  'and its card goes up all the same',
  raised.length === 1 && raised[0].args[0]?.path === null,
  JSON.stringify(raised),
)

/* ── one clipboard, one card ────────────────────────────────────────────── */

step = mark()
await alertClipboardImage(picture, async () => 'file:///a.png')
await alertClipboardImage({ ...picture, token: 'tok-second' }, async () => 'file:///b.png')
alertClipboard('a url copied after the pictures')
raised = since(step)
check(
  'each copy is one call and none of them clears the last',
  raised.length === 3 && !raised.some((entry) => entry.call.startsWith('clear')),
  JSON.stringify(raised.map((entry) => entry.call)),
)
check(
  'text after a picture goes through the same door as ever',
  raised[2].call === 'notifyClipboard' && raised[2].args[0] === 'a url copied after the pictures',
)

/* ── the switch means the switch ────────────────────────────────────────── */

setAlertPrefs({ ...DEFAULT_ALERTS, clipboard: false })
step = mark()
;[fetch, calls] = fetched()
await alertClipboardImage(picture, fetch)
alertClipboard('and text stays quiet too')
check('the clipboard switch silences a picture', since(step).length === 0, JSON.stringify(since(step)))
check('and nothing is downloaded for a card that will not be shown', calls() === 0)

/* ── and nothing while somebody is holding the phone ────────────────────── */

setAlertPrefs({ ...DEFAULT_ALERTS })
rn.AppState.currentState = 'active'
step = mark()
;[fetch, calls] = fetched()
await alertClipboardImage(picture, fetch)
check('the app on screen shows the picture itself, so the shade says nothing', since(step).length === 0)
check('and that too costs no download', calls() === 0)

// The phone goes back in the pocket while the bytes are in flight: the card is
// wanted after all, because by the time it appears nobody is looking.
rn.AppState.currentState = 'background'
step = mark()
await alertClipboardImage(picture, async () => {
  rn.AppState.currentState = 'active'
  return 'file:///late.png'
})
check('a phone picked up during the download gets no card', since(step).length === 0, JSON.stringify(since(step)))
rn.AppState.currentState = 'background'

done()
