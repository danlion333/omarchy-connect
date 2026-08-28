/**
 * Which files the phone will draw, and which it will offer to the gallery.
 *
 * The desktop never says what it is sending — every offer crosses as
 * `application/octet-stream` — so this table is the whole decision, and it is
 * worth checking here rather than by pushing a `.HEIC` from a sofa.
 */
import { iconFor, mediaKind } from '../src/lib/media.ts'

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`)
}

check('a screenshot is a picture', mediaKind('Screenshot 2026-08-28.png') === 'image')
check('so is a photo out of a camera', mediaKind('DSC_0042.JPG') === 'image')
check('and one the case of which nobody agreed on', mediaKind('holiday.HeIc') === 'image')
check('a recording is a video', mediaKind('clip.mp4') === 'video')
check('a document is neither', mediaKind('invoice.pdf') === 'file')
check('nor is an archive that ends in an image name', mediaKind('png') === 'file')
check('a dotfile is not its own extension', mediaKind('.gitignore') === 'file')
check('a name with dots keeps the last one', mediaKind('trip.2026.08.28.jpeg') === 'image')
check('a name with no extension at all', mediaKind('Makefile') === 'file')

check('pictures draw a picture', iconFor('image') === 'image')
check('videos draw film', iconFor('video') === 'film')
check('everything else draws a page', iconFor('file') === 'file')

const passed = results.filter((r) => r.ok).length
console.log(`\n${passed}/${results.length} media checks passed`)
process.exit(passed === results.length ? 0 : 1)
