/**
 * The config file has more than one writer, and this is the suite that says so.
 *
 * A daemon holds it for days; the CLI and the panel write it from processes
 * that live for a second. While the daemon cached its first read forever and
 * wrote its whole remembered object back, that was two silent bugs at once:
 * `omarchy-connect tls enable` was undone by the daemon's next write, and
 * `omarchy-connect agent spawn on` never reached the running daemon at all.
 *
 * So there are two halves here. The first drives the module the way two
 * processes drive it, in real child processes rather than by faking a second
 * one — a config module is exactly the thing whose bug lives in process
 * boundaries. The second starts a real daemon, pairs a phone with it, and
 * writes with the real CLI, because that is the sequence the user reported.
 */
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { check, done } from '../../tools/test-harness.mjs'
import { connectPhone } from './phone.mjs'
import { quietBluetooth, localHeaders } from './sandbox.mjs'

const PORT = Number(process.env.PORT || 8816)
const base = `http://127.0.0.1:${PORT}`
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const entry = path.join(root, 'bin', 'omarchy-connect.js')
const module = path.join(root, 'src', 'lib', 'config.js')

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'omarchy-connect-config-'))
const stateDir = path.join(sandbox, 'state')
const configFile = path.join(sandbox, 'omarchy-connect', 'config.json')
const env = { ...process.env, HOME: sandbox, XDG_CONFIG_HOME: sandbox, OMARCHY_CONNECT_STATE: stateDir, OMARCHY_CONNECT_LOG: 'error' }

quietBluetooth(sandbox)

const readConfig = () => JSON.parse(fs.readFileSync(configFile, 'utf8'))
const settle = (ms = 250) => new Promise((r) => setTimeout(r, ms))

/**
 * A short program run against the real module in a process of its own, whose
 * last line of stdout is read back as JSON. `config` is the module, `file` the
 * path it writes, `out` what the check wants to look at.
 */
function inProcess(body) {
  const code = `
    import * as config from ${JSON.stringify(module)}
    import fs from 'node:fs'
    const file = ${JSON.stringify(configFile)}
    const read = () => JSON.parse(fs.readFileSync(file, 'utf8'))
    const write = (obj) => fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\\n')
    // Every one of these starts from the same known file, so that a check
    // passing is never a check inheriting the state the last one left.
    write({ ...read(), tls: false, agents: { enabled: false, spawn: false }, devices: [] })
    const out = {}
    ${body}
    console.log('\\u0001' + JSON.stringify(out))
  `
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', code], { env, encoding: 'utf8' })
  const line = (run.stdout || '').split('\n').find((l) => l.startsWith(''))
  if (!line) throw new Error(`child said nothing readable: ${run.stdout}\n${run.stderr}`)
  return JSON.parse(line.slice(1))
}

/* ── one process, two writers ─────────────────────────────────────────── */

// The bug in one line: read the config, let somebody else write the file,
// read again. Before this change the second read answered from memory and the
// process went to its grave believing the file it had never looked at twice.
const seen = inProcess(`
  out.first = config.loadConfig().tls
  write({ ...read(), tls: true })
  out.second = config.loadConfig().tls
`)
check('a read after somebody else has written sees the new value', seen.second === true, `${seen.first} then ${seen.second}`)

// And the other half. This process read the config before the other one
// changed `tls`, so its own copy still says false — and it is now writing an
// unrelated field. What lands on disk has to be its field and the other
// process's, not its stale idea of both.
const merged = inProcess(`
  const cfg = config.loadConfig()
  write({ ...read(), tls: true })
  config.saveConfig({ ...cfg, agents: { ...cfg.agents, spawn: true } })
  out.disk = read()
`)
check('a write keeps the field another process changed after the read', merged.disk.tls === true, JSON.stringify(merged.disk.tls))
check('and it still writes the field it was asked to write', merged.disk.agents?.spawn === true, JSON.stringify(merged.disk.agents))

// Two fields inside the same object, one per process, is the case a shallow
// merge gets wrong.
const nested = inProcess(`
  const cfg = config.loadConfig()
  write({ ...read(), agents: { enabled: true, spawn: false } })
  config.saveConfig({ ...cfg, agents: { ...cfg.agents, spawn: true } })
  out.agents = read().agents
`)
check('two writers inside one object keep a field each', nested.agents?.enabled === true && nested.agents?.spawn === true, JSON.stringify(nested.agents))

// A device unpaired by one process must not come back because another process
// still had it in memory. Arrays are replaced whole rather than merged, and
// removal is a change like any other.
const unpaired = inProcess(`
  write({ ...read(), devices: [{ id: 'ghost', name: 'Ghost' }] })
  const cfg = config.loadConfig()
  write({ ...read(), devices: [] })
  config.saveConfig({ ...cfg, tls: true })
  out.devices = read().devices
`)
check('a phone unpaired elsewhere does not come back on the next write', unpaired.devices.length === 0, JSON.stringify(unpaired.devices))

// Reading is not writing. A process that only read the config must leave the
// file alone, or every reader becomes a writer that clobbers whoever wrote
// last — and the mtime everybody else watches would never sit still.
const untouched = inProcess(`
  write({ ...read(), tls: true })
  const before = fs.statSync(file)
  config.loadConfig()
  config.saveConfig()
  const after = fs.statSync(file)
  out.same = before.ino === after.ino && before.mtimeMs === after.mtimeMs
  out.tls = read().tls
`)
check('a save that changed nothing writes nothing', untouched.same === true)
check('and nothing was lost by leaving it alone', untouched.tls === true)

// The one write that is allowed to be whole: there is nothing on disk to merge
// with, so the defaults are the file.
const fresh = inProcess(`
  fs.rmSync(file)
  config.loadConfig()
  out.exists = fs.existsSync(file)
  out.port = read().port
`)
check('a missing config is written fresh', fresh.exists === true && fresh.port === 8765, String(fresh.port))

/* ── a real daemon, the real CLI, a real phone ────────────────────────── */

const daemon = spawn(process.execPath, [entry, 'start', '--port', String(PORT)], { env, stdio: ['ignore', 'ignore', 'inherit'] })
process.on('exit', () => {
  daemon.kill('SIGTERM')
  fs.rmSync(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

for (let i = 0; i < 40; i += 1) {
  try {
    if ((await fetch(`${base}/api/info`)).ok) break
  } catch {
    await settle()
  }
}

const local = () => localHeaders(stateDir)
const cli = (...args) => spawnSync(process.execPath, [entry, ...args], { env, encoding: 'utf8' })

/**
 * A phone that pairs, says hello, can be asked a question and can be hung up.
 * The reconnect below is a second one of these on the same token, which is
 * what the app does when it comes back onto the network.
 */
const paired = { token: null }
async function dial(pairCode = null) {
  const info = await (await fetch(`${base}/api/info`)).json()
  const phone = connectPhone(PORT, info.publicKey)
  const pending = new Map()
  let seq = 0
  const req = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++seq
      pending.set(id, { resolve, reject })
      phone.send({ t: 'req', id, method, params })
      setTimeout(() => pending.has(id) && (pending.delete(id), reject(new Error(`${method} timed out`))), 8000)
    })
  const hello = await new Promise((resolve, reject) => {
    phone.ready
      .then(() =>
        phone.send({
          t: 'hello',
          ...(pairCode ? { pairCode } : { token: paired.token }),
          device: { id: 'config-test', name: 'Config Phone', platform: 'android' },
        }),
      )
      .catch(reject)
    phone.on((msg) => {
      if (msg.t === 'paired') paired.token = msg.token
      if (msg.t === 'hello.ok') resolve(msg)
      if (msg.t === 'hello.err') reject(new Error(msg.error))
      if (msg.t === 'res') {
        const p = pending.get(msg.id)
        if (!p) return
        pending.delete(msg.id)
        msg.ok ? p.resolve(msg.data) : p.reject(new Error(msg.error))
      }
    })
    phone.ws.on('error', reject)
    setTimeout(() => reject(new Error('hello timed out')), 8000)
  })
  return { hello, req, close: () => phone.ws.close() }
}

const code = await (await fetch(`${base}/api/pair-code`, { method: 'POST', headers: local() })).json()
const first = await dial(code.code)
check('a phone pairs with the daemon', first.hello.protocol >= 1, `protocol ${first.hello.protocol}`)
check('and the daemon wrote it down', readConfig().devices?.length === 1, JSON.stringify(readConfig().devices?.map((d) => d.id)))
first.close()
await settle()

// The reported bug, in the order it was reported: TLS on from the CLI while
// the daemon is up, then the phone comes back — which is the daemon's own
// write, and used to be the write that put `tls: false` back over it.
const enable = cli('tls', 'enable')
check('the CLI turns TLS on', enable.status === 0, (enable.stderr || '').trim())
check('and the file says so', readConfig().tls === true)

const link = await dial()
check('the phone reconnects on its token', link.hello.protocol >= 1, `protocol ${link.hello.protocol}`)
await settle(500)
check('TLS is still on after the phone came back', readConfig().tls === true, JSON.stringify(readConfig().tls))
check('and the daemon still knows the phone', readConfig().devices?.length === 1)

/* ── a switch the running daemon has to hear ──────────────────────────── */

// `agent spawn on` is a plain file write with no endpoint behind it, so the
// only thing that can make a running daemon honour it is the daemon reading
// the file again — which it now does on the request that asks the question.
// The link below is the one that paired before the switch was touched: it is
// not reconnected, and the daemon is not restarted.
const before = await link.req('agents.capabilities')
check('the phone is told spawning is off', before.spawn === false, String(before.spawn))
const spawnOn = cli('agent', 'spawn', 'on')
check('the CLI turns spawning on', spawnOn.status === 0, (spawnOn.stderr || '').trim())
const after = await link.req('agents.capabilities')
check('the running daemon honours it with no restart and no reconnect', after.spawn === true, String(after.spawn))
const spawnOff = cli('agent', 'spawn', 'off')
check('and off again just as live', spawnOff.status === 0 && (await link.req('agents.capabilities')).spawn === false)

// The daemon's own writes have to survive the same way round: the switch the
// CLI wrote a moment ago must still be there after the daemon writes.
check('the CLI switch is still on disk after the daemon has written', readConfig().devices?.length === 1 && readConfig().tls === true)
check('the CLI turns TLS off again', cli('tls', 'disable').status === 0)
check('and that write lands too', readConfig().tls === false)
link.close()

done('config checks')
