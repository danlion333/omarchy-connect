import { run, has } from '../lib/exec.js'

const SINK = '@DEFAULT_AUDIO_SINK@'
const SOURCE = '@DEFAULT_AUDIO_SOURCE@'

const clamp01 = (n) => Math.max(0, Math.min(1, n))

async function readVolume(target) {
  if (!has('wpctl')) return null
  const res = await run('wpctl', ['get-volume', target])
  if (!res.ok) return null
  const level = Number(res.stdout.match(/Volume:\s*([\d.]+)/)?.[1] ?? 0)
  return { percent: Math.round(level * 100), muted: /\[MUTED\]/.test(res.stdout) }
}

async function setVolume(target, percent) {
  const level = clamp01(Number(percent) / 100)
  if (!has('wpctl')) throw new Error('wpctl not installed')
  // Cap at 100% so a phone slider can never blow out the speakers.
  const res = await run('wpctl', ['set-volume', '-l', '1.0', target, level.toFixed(2)])
  if (!res.ok) throw new Error(res.stderr || 'wpctl failed')
  return readVolume(target)
}

async function readBrightness() {
  if (!has('brightnessctl')) return null
  const res = await run('brightnessctl', ['-m'])
  if (!res.ok) return null
  const [, , current, percent, max] = res.stdout.split('\n')[0].split(',')
  return {
    percent: Number.parseInt(percent, 10) || 0,
    current: Number(current) || 0,
    max: Number(max) || 0,
  }
}

/** Media keys work through playerctl; wtype replays the raw key as a fallback. */
async function playerAction(action) {
  const map = {
    play: ['play-pause', 'XF86AudioPlay'],
    next: ['next', 'XF86AudioNext'],
    previous: ['previous', 'XF86AudioPrev'],
    stop: ['stop', 'XF86AudioStop'],
  }
  const entry = map[action]
  if (!entry) throw new Error(`unknown player action: ${action}`)
  if (has('playerctl')) {
    const res = await run('playerctl', [entry[0]])
    if (res.ok) return { ok: true, via: 'playerctl' }
  }
  if (has('wtype')) {
    const res = await run('wtype', ['-k', entry[1]])
    if (res.ok) return { ok: true, via: 'wtype' }
    throw new Error(res.stderr || 'wtype failed')
  }
  throw new Error('install playerctl for media control')
}

const PLAYER_FORMAT = '{{artist}}~|~{{title}}~|~{{mpris:length}}~|~{{position}}'

async function playerStatus() {
  if (!has('playerctl')) return { available: false }
  const [status, meta] = await Promise.all([
    run('playerctl', ['status']),
    run('playerctl', ['metadata', '--format', PLAYER_FORMAT]),
  ])
  if (!status.ok) return { available: true, playing: false, status: 'Stopped' }
  const [artist, title, length, position] = (meta.ok ? meta.stdout : '').split('~|~')
  return {
    available: true,
    status: status.stdout,
    playing: status.stdout === 'Playing',
    artist: artist || null,
    title: title || null,
    lengthSec: length ? Math.round(Number(length) / 1e6) : null,
    positionSec: position ? Math.round(Number(position) / 1e6) : null,
  }
}

export default {
  name: 'media',

  capabilities() {
    return {
      volume: has('wpctl'),
      brightness: has('brightnessctl'),
      player: has('playerctl') || has('wtype'),
      osd: has('omarchy-audio-output-volume'),
    }
  },

  methods: {
    async 'media.state'() {
      const [output, input, brightness, player] = await Promise.all([
        readVolume(SINK),
        readVolume(SOURCE),
        readBrightness(),
        playerStatus(),
      ])
      return { output, input, brightness, player }
    },

    async 'volume.set'({ percent }) {
      return { output: await setVolume(SINK, percent) }
    },

    async 'volume.step'({ delta = 5 }) {
      const step = Math.trunc(Number(delta))
      if (!step) throw new Error('delta required')
      // The omarchy wrapper also raises the on-screen display, matching the
      // feedback the user gets from the keyboard keys.
      if (has('omarchy-audio-output-volume')) {
        await run('omarchy-audio-output-volume', [step > 0 ? `+${step}` : String(step)])
      } else {
        const cur = await readVolume(SINK)
        await setVolume(SINK, (cur?.percent ?? 0) + step)
      }
      return { output: await readVolume(SINK) }
    },

    async 'volume.mute'({ target = 'output' } = {}) {
      if (target !== 'output' && target !== 'input') throw new Error('target must be output or input')
      const dev = target === 'input' ? SOURCE : SINK
      if (!has('wpctl')) throw new Error('wpctl not installed')
      const res = await run('wpctl', ['set-mute', dev, 'toggle'])
      if (!res.ok) throw new Error(res.stderr || 'wpctl failed')
      return { [target]: await readVolume(dev) }
    },

    async 'brightness.set'({ percent }) {
      if (!has('brightnessctl')) throw new Error('brightnessctl not installed')
      const value = Math.round(clamp01(Number(percent) / 100) * 100)
      const res = await run('brightnessctl', ['-m', 'set', `${value}%`])
      if (!res.ok) throw new Error(res.stderr || 'brightnessctl failed')
      return { brightness: await readBrightness() }
    },

    async 'brightness.step'({ delta = 5 }) {
      const step = Math.trunc(Number(delta))
      if (has('omarchy-brightness-display')) {
        await run('omarchy-brightness-display', [step > 0 ? `+${step}%` : `${Math.abs(step)}%-`])
      } else if (has('brightnessctl')) {
        await run('brightnessctl', ['-m', 'set', step > 0 ? `${step}%+` : `${Math.abs(step)}%-`])
      } else {
        throw new Error('no brightness backend')
      }
      return { brightness: await readBrightness() }
    },

    'player.play': () => playerAction('play'),
    'player.next': () => playerAction('next'),
    'player.previous': () => playerAction('previous'),
    'player.stop': () => playerAction('stop'),
  },
}
