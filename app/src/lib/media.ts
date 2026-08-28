/**
 * What a file is, going by its name.
 *
 * The desktop serves every offer as `application/octet-stream` and the offer
 * frame carries no mime type, so the extension is the only thing the phone has
 * to go on when it decides whether a file can be looked at or kept in the
 * gallery. Guessing wrong costs a thumbnail, never a file.
 */
export type MediaKind = 'image' | 'video' | 'file'

const IMAGE = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'heic', 'heif', 'avif'])
const VIDEO = new Set(['mp4', 'mov', 'm4v', '3gp', 'mkv', 'webm', 'avi'])

export function mediaKind(name: string): MediaKind {
  const dot = name.lastIndexOf('.')
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
  if (IMAGE.has(ext)) return 'image'
  if (VIDEO.has(ext)) return 'video'
  return 'file'
}

/** The Feather icon that stands in for a file we cannot draw. */
export function iconFor(kind: MediaKind) {
  return kind === 'image' ? 'image' : kind === 'video' ? 'film' : 'file'
}
