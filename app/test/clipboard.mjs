/**
 * The clipboard history.
 *
 * The phone used to keep one clipboard event and overwrite it, which made the
 * Share screen a light saying what the desktop had copied a moment ago and
 * nothing more. What replaces it is a small ring buffer, and everything worth
 * checking about it is arithmetic on plain objects: the newest copy is first,
 * an old one falls off the end, and copying the same text twice moves the one
 * entry rather than spending a second slot on it.
 */
import { MAX_CLIPBOARD_EVENTS, remember } from '../src/lib/clipboard.ts'
import { statusSlice } from '../src/lib/state.ts'
import { check, done } from '../../tools/test-harness.mjs'

const event = (text, at = 1) => ({ text, at, source: 'desktop' })

/* ── newest first ───────────────────────────────────────────────────────── */

const one = remember([], event('first', 10))
check('the first copy is the whole history', one.length === 1 && one[0].text === 'first')

const two = remember(one, event('second', 20))
check('a newer copy goes to the head', two[0].text === 'second')
check('and the older one is still there', two[1].text === 'first')
check('the old array is left alone', one.length === 1)

/* ── the buffer has an end ──────────────────────────────────────────────── */

let history = []
for (let i = 0; i < MAX_CLIPBOARD_EVENTS + 5; i++) history = remember(history, event(`copy-${i}`, i))
check('the history stops growing', history.length === MAX_CLIPBOARD_EVENTS)
check('between ten and twenty entries, as the issue asked', MAX_CLIPBOARD_EVENTS >= 10 && MAX_CLIPBOARD_EVENTS <= 20)
check('the newest copy survives', history[0].text === `copy-${MAX_CLIPBOARD_EVENTS + 4}`)
check('the oldest is pushed off the end', !history.some((e) => e.text === 'copy-0'))

/* ── a repeat is a move, not a second row ───────────────────────────────── */

const again = remember(two, event('first', 30))
check('copying something already held adds no row', again.length === 2)
check('it moves to the head instead', again[0].text === 'first')
check('with the time it was copied again', again[0].at === 30)
check('and the other entry is kept', again[1].text === 'second')

/* ── the screen reads it off the status slice ───────────────────────────── */

const state = {
  ready: true,
  status: 'connected',
  error: null,
  desktop: null,
  hello: null,
  clipboard: two,
  files: [],
  latencyMs: null,
  relocating: false,
  waking: false,
  client: null,
}
check('the slice carries the history by identity', statusSlice(state).clipboard === two)

/* ── each entry still carries its own age ───────────────────────────────── */

check('every entry knows when it was copied', two.every((e) => typeof e.at === 'number'))

done()
