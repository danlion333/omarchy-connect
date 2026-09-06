import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { has, run } from './exec.js'
import { log } from './log.js'
import { OMARCHY_STATE } from './paths.js'

/** The symlink Omarchy repoints every time the wallpaper changes. */
export const BACKGROUND_LINK = path.join(OMARCHY_STATE, 'current', 'background')

/**
 * How wide the phone ever wants it, and how hard to squeeze.
 *
 * A theme background is a 3 MB desktop-sized JPEG; the phone draws it behind
 * glass cards, dimmed, on a screen 1440 px wide at most. Anything larger is
 * bytes over the socket nobody can see — and the reply has to fit the 1 MB
 * frame the server accepts, so the width comes down first and the quality
 * follows it if the result is still too big.
 */
const WIDTH = 1200
const QUALITIES = [72, 58, 44]
const MAX_BYTES = 700 * 1024

/** The current wallpaper's real path, or null when the desktop has none. */
export function backgroundPath() {
  try {
    const real = fs.realpathSync(BACKGROUND_LINK)
    return fs.statSync(real).isFile() ? real : null
  } catch {
    return null
  }
}

/**
 * A name for these exact bytes.
 *
 * Path, size and mtime rather than a hash of the file: the phone only needs
 * to know whether what it cached is still the wallpaper, and hashing 3 MB on
 * every ask would be the expensive way to answer "unchanged".
 */
function identity(file) {
  const st = fs.statSync(file)
  return crypto.createHash('sha256').update(`${file}:${st.size}:${st.mtimeMs}`).digest('hex').slice(0, 16)
}

/**
 * The desktop's wallpaper, small enough to send.
 *
 * `id` is what the phone already holds: the same one comes back as
 * `unchanged` with no bytes, which is the usual answer — a wallpaper changes
 * when a theme does and not otherwise. Without ImageMagick the original goes
 * as it is if it happens to be small enough, and otherwise the phone is told
 * why rather than handed a picture that will not fit through the socket.
 */
export async function readBackground({ id } = {}) {
  const file = backgroundPath()
  if (!file) return { available: false, reason: 'the desktop has no wallpaper set' }

  const current = identity(file)
  const name = path.basename(file)
  if (id && id === current) return { available: true, unchanged: true, id: current, name }

  const scaled = await scale(file)
  if (!scaled) {
    return { available: false, id: current, name, reason: 'the wallpaper is too big to send (install imagemagick)' }
  }
  return {
    available: true,
    unchanged: false,
    id: current,
    name,
    mime: scaled.mime,
    bytes: scaled.data.length,
    data: scaled.data.toString('base64'),
  }
}

/**
 * Down to something a phone can hold, through a temp file: ImageMagick writes
 * pictures, not stdout we could size-limit ourselves.
 */
async function scale(file) {
  const bin = has('magick') ? 'magick' : has('convert') ? 'convert' : null
  if (!bin) {
    const raw = fs.readFileSync(file)
    return raw.length <= MAX_BYTES ? { data: raw, mime: mimeOf(file) } : null
  }

  const out = path.join(os.tmpdir(), `omarchy-connect-bg-${process.pid}.jpg`)
  try {
    for (const quality of QUALITIES) {
      const res = await run(
        bin,
        [file, '-auto-orient', '-resize', `${WIDTH}x${WIDTH * 3}>`, '-strip', '-quality', String(quality), out],
        { timeout: 20000 },
      )
      if (!res.ok) {
        log.debug(`${bin} failed on the wallpaper:`, res.stderr)
        return null
      }
      const data = fs.readFileSync(out)
      if (data.length <= MAX_BYTES || quality === QUALITIES[QUALITIES.length - 1]) {
        return { data, mime: 'image/jpeg' }
      }
    }
    return null
  } catch (err) {
    log.debug('wallpaper scale failed:', err.message)
    return null
  } finally {
    fs.rmSync(out, { force: true })
  }
}

function mimeOf(file) {
  const ext = path.extname(file).toLowerCase()
  if (ext === '.png') return 'image/png'
  if (ext === '.webp') return 'image/webp'
  return 'image/jpeg'
}
