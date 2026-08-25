import net from 'node:net'
import fs from 'node:fs'
import path from 'node:path'
import { has, run } from './exec.js'
import { log } from './log.js'

/**
 * Talks to Hyprland over its control socket instead of spawning `hyprctl`.
 *
 * That matters for the touchpad: a phone streams pointer deltas tens of times
 * a second, and a process launch per delta would cost more than the movement
 * itself. Over the socket a move round-trips in about a tenth of a millisecond.
 *
 * Hyprland 0.56 replaced the flat dispatcher names (`workspace 3`) with a Lua
 * API (`hl.dsp.focus{workspace="3"}`), so which one to speak is decided once,
 * by asking, rather than by guessing from a version number.
 */

let cachedSocket = null
let luaApi = null

function socketPath() {
  if (cachedSocket && fs.existsSync(cachedSocket)) return cachedSocket
  const runtime = process.env.XDG_RUNTIME_DIR
  if (!runtime) return null
  const dir = path.join(runtime, 'hypr')
  const signature = process.env.HYPRLAND_INSTANCE_SIGNATURE
  const candidates = signature ? [signature] : safeReaddir(dir)
  for (const candidate of candidates) {
    const socket = path.join(dir, candidate, '.socket.sock')
    if (fs.existsSync(socket)) {
      cachedSocket = socket
      return socket
    }
  }
  return null
}

function safeReaddir(dir) {
  try {
    // Newest instance first: a leftover directory from a previous session
    // would otherwise shadow the running compositor.
    return fs
      .readdirSync(dir)
      .map((name) => ({ name, at: fs.statSync(path.join(dir, name)).mtimeMs }))
      .sort((a, b) => b.at - a.at)
      .map((entry) => entry.name)
  } catch {
    return []
  }
}

export function available() {
  return Boolean(socketPath()) || has('hyprctl')
}

/** One request, one reply — Hyprland closes the socket after answering. */
export function request(command) {
  const socket = socketPath()
  if (!socket) return hyprctlFallback(command)
  return new Promise((resolve, reject) => {
    const client = net.connect(socket, () => client.write(command))
    let out = ''
    client.setTimeout(4000, () => {
      client.destroy()
      reject(new Error('hyprland did not answer'))
    })
    client.on('data', (chunk) => (out += chunk))
    client.on('end', () => resolve(out))
    client.on('error', reject)
  })
}

async function hyprctlFallback(command) {
  if (!has('hyprctl')) throw new Error('hyprland is not running')
  const json = command.startsWith('j/')
  const rest = json ? command.slice(2) : command
  const args = rest.split(' ')
  const res = await run('hyprctl', json ? [...args, '-j'] : args)
  if (!res.ok) throw new Error(res.stderr || 'hyprctl failed')
  return res.stdout
}

export async function json(command) {
  const raw = await request(`j/${command}`)
  try {
    return JSON.parse(raw)
  } catch {
    throw new Error(`hyprland returned unreadable json for ${command}`)
  }
}

/** True when this Hyprland speaks the Lua dispatcher API (0.56 and newer). */
export async function hasLuaApi() {
  if (luaApi !== null) return luaApi
  try {
    const reply = await request('dispatch hl.dsp.no_op()')
    luaApi = reply.trim().startsWith('ok')
  } catch {
    luaApi = false
  }
  log.debug(`hyprland dispatcher API: ${luaApi ? 'lua' : 'legacy'}`)
  return luaApi
}

/**
 * Issues a dispatch, written both ways: `lua` for 0.56+, `legacy` for older
 * releases. Callers give both spellings because only they know the mapping.
 */
export async function dispatch(lua, legacy) {
  const useLua = await hasLuaApi()
  const command = useLua ? lua : legacy
  if (!command) throw new Error('this version of Hyprland does not support that action')
  const reply = (await request(`dispatch ${command}`)).trim()
  if (reply && !reply.startsWith('ok')) throw new Error(reply.split('\n')[0])
  return reply
}

export function resetProbe() {
  luaApi = null
  cachedSocket = null
}
