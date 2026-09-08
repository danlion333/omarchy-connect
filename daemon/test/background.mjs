/**
 * The desktop's wallpaper on its way to the phone.
 *
 * What matters here is not the picture but the traffic around it: the phone
 * caches the bytes and asks again on every connect, so the answer to "still
 * this one?" has to be cheap and it has to be right. A wallpaper that changed
 * must come back with a different id and the bytes to go with it, and one that
 * did not must come back with neither.
 *
 * The Omarchy state directory is stood in for by a sandbox — `paths.js` reads
 * XDG_STATE_HOME once at import, so it is set before anything is imported —
 * and the wallpaper itself is a real, if very small, PNG.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { check, done } from '../../tools/test-harness.mjs'

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'omarchy-connect-background-'))
process.on('exit', () => fs.rmSync(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
process.env.XDG_STATE_HOME = sandbox

const current = path.join(sandbox, 'omarchy', 'current')
fs.mkdirSync(current, { recursive: true })

// A 1×1 PNG. Small enough that a desktop without ImageMagick sends it as it
// is, and a valid picture for one that has it.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)
const first = path.join(current, 'one.png')
const second = path.join(current, 'two.png')
fs.writeFileSync(first, PNG)
fs.writeFileSync(second, PNG)

const link = path.join(current, 'background')
const point = (target) => {
  fs.rmSync(link, { force: true })
  fs.symlinkSync(target, link)
}

const { backgroundPath, readBackground } = await import('../src/lib/background.js')

/* ── nothing to send ────────────────────────────────────────────────────── */

check('a desktop with no wallpaper has no path to one', backgroundPath() === null)
const missing = await readBackground({})
check('and says so rather than answering with an empty picture', missing.available === false, JSON.stringify(missing))

/* ── the first ask ──────────────────────────────────────────────────────── */

point(first)
const full = await readBackground({})
check('a wallpaper that is set comes back with bytes', full.available === true && typeof full.data === 'string' && full.data.length > 0)
check('and with the name it has on the desktop', full.name === 'one.png', String(full.name))
check('and with an id to cache it under', typeof full.id === 'string' && full.id.length > 0, String(full.id))
check('small enough for the socket to carry in one frame', full.bytes < 1024 * 1024, `${full.bytes} bytes`)

/* ── every ask after that ───────────────────────────────────────────────── */

const held = await readBackground({ id: full.id })
check('the phone holding the current id is told so', held.unchanged === true, JSON.stringify(held))
check('and is sent no bytes at all', held.data === undefined)
check('the id it should keep caching under comes back anyway', held.id === full.id)

/* ── the desktop changed theme ──────────────────────────────────────────── */

point(second)
const changed = await readBackground({ id: full.id })
check('a different wallpaper is not mistaken for the held one', changed.unchanged === false, JSON.stringify({ ...changed, data: undefined }))
check('it has an id of its own', changed.id !== full.id, `${full.id} → ${changed.id}`)
check('and the bytes to go with it', typeof changed.data === 'string' && changed.data.length > 0)

// Same file, touched: the id is what these bytes are, not what they are called.
const stale = fs.statSync(second)
fs.utimesSync(second, stale.atime, new Date(stale.mtime.getTime() + 60_000))
const touched = await readBackground({ id: changed.id })
check('a wallpaper rewritten in place is sent again', touched.unchanged === false, String(touched.id))

done('wallpaper checks')
