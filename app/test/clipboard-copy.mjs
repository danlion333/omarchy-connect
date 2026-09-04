/**
 * A picture copied on the desktop, put on the phone's own clipboard.
 *
 * The **Copy** on a text card writes the string and is done. A picture is two
 * steps — have the bytes, then hand them to the clipboard — and each of them
 * fails in a way somebody has to be told about, which is what this suite is
 * about: the tap answers with a sentence whichever way it goes, and it does
 * not download the same picture twice to say it.
 *
 * The clipboard write itself is Kotlin (`ImageClip`) and is exercised on the
 * phone; what is decided here is the order, the wording and the fetch.
 */
import { copyPicture } from '../src/lib/copyimage.ts'
import { check, done } from '../../tools/test-harness.mjs'

const picture = { token: 'tok-screenshot', name: 'screenshot.png' }

const uri = 'file:///cache/omarchy-connect/tok-screensh/screenshot.png'

const spy = () => {
  const seen = []
  return [(value) => seen.push(value), seen]
}

/* ── the ordinary tap ───────────────────────────────────────────────────── */

let [copy, copied] = spy()
let downloads = 0
let note = await copyPicture(picture, {
  fetch: async () => {
    downloads++
    return uri
  },
  copy,
})
check('a tap says what happened', note === 'copied to the phone clipboard', note)
check('the bytes on the disk are what goes to the clipboard', copied[0] === uri, JSON.stringify(copied))
check('and they are fetched exactly once', downloads === 1)

/* ── the bytes never arrived ────────────────────────────────────────────── */

let thrown = null
;[copy, copied] = spy()
try {
  await copyPicture(picture, {
    fetch: async () => {
      throw new Error('the offer expired')
    },
    copy,
  })
} catch (error) {
  thrown = error
}
check('a picture that cannot be fetched is a failure, not a silence', thrown instanceof Error)
check('which names the picture', String(thrown?.message).includes('screenshot.png'), String(thrown?.message))
check('and says why', String(thrown?.message).includes('the offer expired'), String(thrown?.message))
check('nothing is put on the clipboard for it', copied.length === 0)

/* ── an empty answer is the same failure ────────────────────────────────── */

thrown = null
;[copy, copied] = spy()
try {
  await copyPicture(picture, { fetch: async () => '', copy })
} catch (error) {
  thrown = error
}
check('a fetch that answers with nothing is caught too', thrown instanceof Error, String(thrown))
check('and still writes nothing', copied.length === 0)

/* ── the phone said no ──────────────────────────────────────────────────── */

thrown = null
try {
  await copyPicture(picture, {
    fetch: async () => uri,
    copy: () => {
      throw new Error('this phone has no clipboard to write to')
    },
  })
} catch (error) {
  thrown = error
}
check('an OEM that refuses the write is reported', thrown instanceof Error)
check(
  'in words that are the phone\'s own',
  String(thrown?.message).includes('this phone has no clipboard to write to'),
  String(thrown?.message),
)

/* ── a throw with nothing in it still reads as something ────────────────── */

thrown = null
try {
  await copyPicture(picture, {
    fetch: async () => uri,
    copy: () => {
      throw new Error('   ')
    },
  })
} catch (error) {
  thrown = error
}
check(
  'a wordless refusal is given words',
  String(thrown?.message).endsWith('the phone refused it'),
  String(thrown?.message),
)

done()
