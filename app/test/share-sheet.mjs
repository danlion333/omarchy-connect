/**
 * What the system share sheet hands over, and what becomes of it.
 *
 * The share path is the one place in this app where nobody is watching: the
 * user tapped "Omarchy Connect" inside somebody else's gallery and moved on.
 * That makes "every file went, or somebody was told which one did not" a
 * property worth asserting rather than eyeballing — a multi-share that stops
 * at the first broken attachment looks exactly like one that worked.
 *
 * All of it is arithmetic on plain objects: `deliverShare` is handed three
 * functions and this suite is what stands in for the desktop behind them.
 */
import {
  deliverShare,
  describeShare,
  isEmptyShare,
  isLink,
  shareBlocked,
  shareSummary,
} from '../src/lib/share.ts'
import { check, done } from '../../tools/test-harness.mjs'

/** A desktop that takes everything, and a note of what it was given. */
const desktop = () => {
  const log = { urls: [], texts: [], files: [] }
  return {
    log,
    sinks: {
      openUrl: async (url) => log.urls.push(url),
      copyText: async (text) => log.texts.push(text),
      upload: async (file) => log.files.push(file.name),
    },
  }
}

const file = (name) => ({ uri: `file:///cache/${name}`, name, size: 10 })

/* ── a link goes to the browser, text goes to the clipboard ─────────────── */

check('an http address is a link', isLink('https://example.com/a?b=c'))
check('a sentence with a word in it is not', !isLink('read this: it is good'))
check('a link with something after it is not one either', !isLink('https://a.b see this'))

{
  const { log, sinks } = desktop()
  const out = await deliverShare({ text: 'https://omarchy.org', files: [] }, sinks)
  check('a shared link lands on the desktop clipboard', log.texts[0] === 'https://omarchy.org')
  check('and is opened there as well', log.urls[0] === 'https://omarchy.org')
  check('the summary names it', shareSummary(out) === 'sent the link')
}

{
  const { log, sinks } = desktop()
  await deliverShare({ text: 'a paragraph worth keeping', files: [] }, sinks)
  check('shared text lands on the desktop clipboard', log.texts[0] === 'a paragraph worth keeping')
  check('and is not opened as a link', log.urls.length === 0)
}

/* ── files ──────────────────────────────────────────────────────────────── */

{
  const { log, sinks } = desktop()
  const out = await deliverShare({ files: [file('IMG_1.jpg')] }, sinks)
  check('a shared photo is uploaded', log.files[0] === 'IMG_1.jpg')
  check('and said so', shareSummary(out) === 'sent IMG_1.jpg')
}

/* ── a multi-share loses nothing ────────────────────────────────────────── */

{
  const log = []
  const sinks = {
    openUrl: async () => {},
    copyText: async () => {},
    // The third of five has been deleted out from under the sharing app.
    upload: async (f) => {
      log.push(f.name)
      if (f.name === 'c.jpg') throw new Error('gone')
    },
  }
  const names = ['a.jpg', 'b.jpg', 'c.jpg', 'd.jpg', 'e.jpg']
  const out = await deliverShare({ files: names.map(file) }, sinks)
  check('every file in a multi-share is attempted', log.length === 5)
  check('one failure does not stop the ones after it', log[4] === 'e.jpg')
  check('the four that went are counted', out.sent.length === 4 && !out.sent.includes('c.jpg'))
  check('the one that did not is named', out.failed.length === 1 && out.failed[0].label === 'c.jpg')
  check('and it is named to the user too', shareSummary(out).includes('c.jpg'))
}

{
  // A desktop with no browser willing to answer has still been handed the link.
  const log = []
  const sinks = {
    openUrl: async () => {
      throw new Error('no handler')
    },
    copyText: async (text) => log.push(text),
    upload: async () => {},
  }
  const out = await deliverShare({ text: 'https://omarchy.org', files: [] }, sinks)
  check('a link that will not open is still on the clipboard', log[0] === 'https://omarchy.org')
  check('and counts as delivered', out.sent[0] === 'the link')
  check('with the opening named as the part that failed', out.failed[0].label === 'opening the link')
}

/* ── a caption alongside a picture is not thrown away ───────────────────── */

{
  const { log, sinks } = desktop()
  const out = await deliverShare({ text: 'look at this', files: [file('shot.png')] }, sinks)
  check('the file goes', log.files[0] === 'shot.png')
  check('and the text with it', log.texts[0] === 'look at this')
  check('two items, one line', shareSummary(out) === 'sent 2 items')
}

/* ── an attachment the phone could not read is a failure, not a silence ─── */

{
  const { sinks } = desktop()
  const out = await deliverShare({ files: [file('ok.pdf')], dropped: 2 }, sinks)
  check('unreadable attachments are counted as failures', out.failed.length === 2)
  check('the one that worked still counts as sent', out.sent.length === 1)
  check('and the line says something went missing', shareSummary(out).includes('did not go'))
}

/* ── refusing out loud ──────────────────────────────────────────────────── */

check(
  'an unpaired desktop is a pairing problem',
  shareBlocked({ paired: false, connected: false }) === 'no desktop is paired yet — pair one and share again',
)
check(
  'a paired desktop that is not answering is a different sentence',
  (shareBlocked({ paired: true, connected: false }) || '').includes('not reachable'),
)
check('a connected desktop blocks nothing', shareBlocked({ paired: true, connected: true }) === null)
check(
  'and it promises that nothing went, rather than leaving it open',
  (shareBlocked({ paired: true, connected: false }) || '').includes('nothing was sent'),
)

/* ── the shapes the screen renders ──────────────────────────────────────── */

check('an empty share is recognised', isEmptyShare({ text: '  ', files: [] }))
check('one with a file is not', !isEmptyShare({ files: [file('a.txt')] }))
check('nor is one that only lost things', !isEmptyShare({ files: [], dropped: 1 }))

check('one file is described by name', describeShare({ files: [file('note.pdf')] }) === 'note.pdf')
check('several are counted', describeShare({ files: [file('a'), file('b')] }) === '2 files')
check(
  'a link with files reads as both',
  describeShare({ text: 'https://a.b', files: [file('a'), file('b')] }) === '2 files · a link',
)
check('plain text says so', describeShare({ text: 'hello', files: [] }) === 'some text')

done()
