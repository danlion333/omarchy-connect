import fs from 'node:fs'

import { has, spawn } from './exec.js'
import { log } from './log.js'

/**
 * The sound a ringing phone makes on the desktop.
 *
 * A notification card is enough for a message and useless for a call: the
 * whole point of answering from the desktop is that the handset is in another
 * room, and something you have to be looking at the screen to notice does not
 * survive that. So a ringing call gets a ring.
 *
 * It is deliberately the freedesktop sound theme's own `phone-incoming-call`
 * rather than anything shipped here — it is on every machine that has a
 * desktop session, it is the sound the rest of the system already uses for
 * this, and a user who wants their own melody points `ringtone` at a file.
 *
 * The loop is ours rather than the player's. `paplay` has no repeat, and the
 * pause between repeats is what makes a ring a ring instead of a drone, so the
 * child is re-spawned after a gap for as long as the phone is ringing and no
 * longer than the notification beside it lives.
 */

/** The sound theme's own ring. Present wherever a desktop session is. */
const DEFAULT_SOUND = '/usr/share/sounds/freedesktop/stereo/phone-incoming-call.oga'

/**
 * Players, best first.
 *
 * `paplay` and `pw-play` are the two halves of the same PipeWire install and
 * one of them is always there; `canberra-gtk-play` is the fallback for a
 * session that has libcanberra and neither. All three take one file and exit
 * when it ends, which is the whole contract this needs.
 */
const PLAYERS = [
  { bin: 'paplay', args: (file) => [file] },
  { bin: 'pw-play', args: (file) => [file] },
  { bin: 'canberra-gtk-play', args: (file) => ['-f', file] },
]

/** The silence between repeats. A ring is a pattern, not a tone. */
const GAP_MS = 1200
/** Never ring longer than the notification that goes with it. */
const LIMIT_MS = 45_000

export class Ringtone {
  constructor() {
    this.enabled = true
    this.sound = DEFAULT_SOUND
    this.child = null
    this.timer = null
    this.until = 0
    /** A file named in the config that is not there is worth saying once. */
    this.warned = null
  }

  configure({ enabled = true, sound = null } = {}) {
    this.enabled = enabled !== false
    this.sound = this.resolve(sound)
    if (!this.enabled) this.stop()
    return this.summary()
  }

  /** A named file if it exists, the theme's ring otherwise. */
  resolve(sound) {
    const file = sound ? String(sound) : null
    if (!file) return DEFAULT_SOUND
    if (fs.existsSync(file)) return file
    if (this.warned !== file) {
      this.warned = file
      log.warn(`ringtone: ${file} is not there — using the sound theme's ring instead`)
    }
    return DEFAULT_SOUND
  }

  /** The first player on this machine, or null on one with no audio tooling. */
  get player() {
    return PLAYERS.find((p) => has(p.bin)) ?? null
  }

  get ringing() {
    return this.until > 0
  }

  /**
   * Start ringing, or carry on ringing.
   *
   * One ringing phone is announced more than once — anonymous first, named a
   * moment later — and each report lands here. Restarting the melody on the
   * second one would be audible and wrong, so a ring already in progress is
   * left exactly where it is.
   */
  start(limit = LIMIT_MS) {
    if (!this.enabled || this.ringing) return false
    const player = this.player
    if (!player) return false
    if (!fs.existsSync(this.sound)) return false
    this.until = Date.now() + limit
    this.play()
    return true
  }

  play() {
    if (!this.ringing) return
    if (Date.now() >= this.until) return this.stop()
    const player = this.player
    if (!player) return this.stop()
    const child = spawn(player.bin, player.args(this.sound), { stdio: 'ignore' })
    child.on('error', () => {
      if (this.child === child) this.stop()
    })
    child.on('exit', () => {
      if (this.child !== child) return
      this.child = null
      if (!this.ringing) return
      this.timer = setTimeout(() => {
        this.timer = null
        this.play()
      }, GAP_MS)
      this.timer.unref?.()
    })
    child.unref?.()
    this.child = child
  }

  /** Answered, declined, rung out, or the phone itself took the ring over. */
  stop() {
    this.until = 0
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    const child = this.child
    this.child = null
    if (!child) return false
    try {
      child.kill()
    } catch {
      /* already gone */
    }
    return true
  }

  /** One pass, for somebody choosing a file and wanting to hear it. */
  once() {
    const player = this.player
    if (!player) throw new Error('this machine has no way to play a sound — install pipewire-pulse or libcanberra')
    if (!fs.existsSync(this.sound)) throw new Error(`${this.sound} is not there`)
    const child = spawn(player.bin, player.args(this.sound), { stdio: 'ignore' })
    child.unref?.()
    return { ok: true, sound: this.sound, player: player.bin }
  }

  summary() {
    return {
      enabled: this.enabled,
      sound: this.sound,
      custom: this.sound !== DEFAULT_SOUND,
      player: this.player?.bin ?? null,
      ringing: this.ringing,
    }
  }
}

export const ringtone = new Ringtone()
export { DEFAULT_SOUND }
