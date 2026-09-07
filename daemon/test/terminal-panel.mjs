/**
 * The desktop shell, as the bar panel sees it.
 *
 * `terminal.mjs` covers the feature itself — bytes into a real tmux, the
 * screen back out, the gate in front of both. This is the other half of the
 * same switch: whether the desktop can say, on the panel, that a phone may
 * type here, and flip it from there.
 *
 * The panel has exactly one window on the daemon (`status.json`) and exactly
 * one way back (the CLI), so the checks are on the two ends of that road:
 *
 *   - the snapshot carries `terminal` while the daemon runs, while it is
 *     stopped, and in `status --json`, which is what the panel reads to draw
 *     a desktop whose daemon is down. The switch is a decision in the config,
 *     so a stopped daemon still knows the answer — the same promise `agents`
 *     already makes;
 *   - it is republished *when the switch moves*, because a toggle whose state
 *     catches up a minute later is not a switch;
 *   - and `shell/Model.js`, loaded here the way `audio-panel.mjs` loads it,
 *     turns that snapshot into the words and the visibility rule the panel
 *     draws — including for a status file written before any of this existed.
 *
 * tmux is not required to run this. The interesting half is the switch, which
 * is a config write and a snapshot, and it must read honestly on a machine
 * with no multiplexer too — that is exactly the case where the panel is
 * supposed to draw nothing.
 */
import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

import { check, done } from '../../tools/test-harness.mjs'
import { quietBluetooth, localHeaders } from './sandbox.mjs'

const PORT = Number(process.env.PORT || 8831)
const base = `http://127.0.0.1:${PORT}`
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const repo = path.dirname(root)

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'omarchy-connect-terminal-panel-'))
const stateDir = path.join(sandbox, 'state')
const local = () => localHeaders(stateDir)

const hasTmux = (() => {
  try {
    execFileSync('which', ['tmux'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

/* ── the panel's half, loaded out of the QML ───────────────────────────── */

const source = fs.readFileSync(path.join(repo, 'shell', 'Model.js'), 'utf8').replace(/^\.pragma .*$/m, '')
const Model = vm.createContext({})
vm.runInContext(source, Model, { filename: 'shell/Model.js' })

/* ── the environment ───────────────────────────────────────────────────── */

quietBluetooth(sandbox, { port: PORT, deviceName: 'terminal-panel-test', devices: [] })

const runtime = path.join(sandbox, 'run')
fs.mkdirSync(runtime, { recursive: true })

// The suite is very likely being run from inside somebody's own tmux, and
// `TMUX` in the environment would point the daemon at their server — where it
// would then make a session called `oc-term`. `terminal.mjs` takes the same
// precaution for the same reason.
const cleanEnv = { ...process.env }
for (const key of ['TMUX', 'TMUX_PANE', 'HERDR_SOCKET_PATH']) delete cleanEnv[key]

const baseEnv = {
  ...cleanEnv,
  HOME: sandbox,
  XDG_CONFIG_HOME: sandbox,
  XDG_CACHE_HOME: path.join(sandbox, '.cache'),
  XDG_RUNTIME_DIR: runtime,
  OMARCHY_CONNECT_STATE: stateDir,
  OMARCHY_CONNECT_LOG: 'warn',
  TMUX_TMPDIR: sandbox,
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

const readCli = (args) =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(root, 'bin', 'omarchy-connect.js'), ...args], {
      env: baseEnv,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    let out = ''
    child.stdout.on('data', (c) => {
      out += c
    })
    child.on('exit', (code) => resolve({ out, code }))
  })

/* ── a status file from before any of this existed ─────────────────────── */

// The panel will be looking at exactly this file for the second between an
// upgrade and the daemon's next start, and an undefined here would take the
// whole card down with it.
const old = Model.terminal({ v: 3, running: true, agents: { enabled: true } })
check('a status file with no terminal key reads as off', old.enabled === false && old.available === false, JSON.stringify(old))
check('and the panel draws no switch for it', Model.terminalShown(old) === false, Model.terminalText(old, true))

/* ── the stopped daemon ────────────────────────────────────────────────── */

const stopped = JSON.parse((await readCli(['status', '--json'])).out || '{}')
check('a stopped daemon still publishes the shell switch', !!stopped.terminal, JSON.stringify(stopped.terminal ?? null))
check(
  'saying the shell is off, because that is what the config says',
  stopped.terminal?.enabled === false,
  JSON.stringify(stopped.terminal),
)
check(
  'and answering, with the daemon down, whether this desktop could hold one',
  stopped.terminal?.available === hasTmux && stopped.terminal?.session === 'oc-term',
  JSON.stringify(stopped.terminal),
)
check(
  'so the panel offers the switch exactly where tmux is',
  Model.terminalShown(Model.terminal(stopped)) === hasTmux,
  Model.terminalText(Model.terminal(stopped), false),
)

/* ── the switch, from the CLI, with no daemon running ──────────────────── */

// The panel's own line is `omarchy-connect terminal on`, and a person may well
// press it while the daemon is stopped. The config is what the next start
// reads, so the snapshot has to move even here.
const offlineOn = await readCli(['terminal', 'on'])
check('terminal on works with the daemon down', offlineOn.code === 0, offlineOn.out.trim().split('\n')[0] || '')
const afterOffline = JSON.parse((await readCli(['status', '--json'])).out || '{}')
check(
  'and the panel would show it on the moment it read the file again',
  afterOffline.terminal?.enabled === true && Model.terminal(afterOffline).enabled === true,
  JSON.stringify(afterOffline.terminal),
)
check(
  'with a line that says nothing is listening while the daemon is stopped',
  /daemon is stopped/.test(Model.terminalText(Model.terminal(afterOffline), false)),
  Model.terminalText(Model.terminal(afterOffline), false),
)
await readCli(['terminal', 'off'])

/* ── the running daemon ────────────────────────────────────────────────── */

const daemon = spawn(process.execPath, [path.join(root, 'bin', 'omarchy-connect.js'), 'start', '--port', String(PORT)], {
  env: baseEnv,
  stdio: ['ignore', 'ignore', 'inherit'],
})

process.on('exit', () => {
  daemon.kill('SIGKILL')
  try {
    execFileSync('tmux', ['kill-server'], { env: baseEnv, stdio: 'ignore' })
  } catch {
    /* there may be no server to kill, which is the tidy case */
  }
  fs.rmSync(sandbox, { recursive: true, force: true })
})

async function waitForDaemon() {
  for (let i = 0; i < 60; i += 1) {
    try {
      if ((await fetch(`${base}/api/info`)).ok) return
    } catch {
      await wait(250)
    }
  }
  throw new Error('daemon did not start')
}

/** The status file, as the panel's FileView would read it. */
const published = () => {
  try {
    return JSON.parse(fs.readFileSync(path.join(stateDir, 'status.json'), 'utf8'))
  } catch {
    return null
  }
}

/**
 * Wait for the *file* to say something, rather than for a timer to go off.
 * The window is short on purpose: a snapshot that only refreshes on the next
 * connection would run this out, which is the bug this check exists for.
 */
async function until(predicate, ms = 4000) {
  const deadline = Date.now() + ms
  for (;;) {
    const snapshot = published()
    if (snapshot && predicate(snapshot)) return snapshot
    if (Date.now() > deadline) return snapshot
    await wait(50)
  }
}

const control = (op) =>
  fetch(`${base}/api/terminal/control`, { method: 'POST', headers: local(), body: JSON.stringify({ op }) }).then(
    async (r) => ({ status: r.status, body: await r.json() }),
  )

await waitForDaemon()

const idle = await until((s) => s.running === true)
check(
  'a running daemon publishes the shell switch too',
  idle?.terminal?.enabled === false && idle?.terminal?.session === 'oc-term',
  JSON.stringify(idle?.terminal ?? null),
)
check(
  'which reads as off until somebody flips it',
  Model.terminalText(Model.terminal(idle), true) === (hasTmux ? 'off · the phone cannot type here' : 'off · no tmux here to hold a shell'),
  Model.terminalText(Model.terminal(idle), true),
)

/* ── the switch the panel presses ──────────────────────────────────────── */

const on = await control('enable')
check('the shell switches on', on.body?.terminal?.enabled === true, JSON.stringify(on.body?.terminal))

const opened = await until((s) => s.terminal?.enabled === true)
check(
  'and the status file says so without waiting for the panel to ask again',
  opened?.terminal?.enabled === true,
  JSON.stringify(opened?.terminal ?? null),
)
if (hasTmux) {
  check(
    'with a line naming the session the phone types into',
    Model.terminalText(Model.terminal(opened), true) === 'on · the phone can type into "oc-term"',
    Model.terminalText(Model.terminal(opened), true),
  )
}
check(
  'and the switch stays reachable, so what opened the shell can close it',
  Model.terminalShown(Model.terminal(opened)) === true,
  JSON.stringify(Model.terminal(opened)),
)

// The panel reads its state out of the file, so the CLI and the panel must not
// be able to disagree — this is the same round trip a person makes when they
// type the command at the desk with the panel open.
const shown = await readCli(['terminal', 'status'])
check('and the CLI agrees the shell is on', /STATE[\s\S]*?on/i.test(shown.out), shown.out.trim().split('\n').slice(0, 3).join(' / '))

/* ── and off again ─────────────────────────────────────────────────────── */

const off = await control('disable')
check('the shell switches off', off.body?.terminal?.enabled === false, JSON.stringify(off.body?.terminal))
const closed = await until((s) => s.terminal?.enabled === false)
check(
  'and the panel sees that without asking either',
  closed?.terminal?.enabled === false,
  JSON.stringify(closed?.terminal ?? null),
)

done('desktop shell panel checks')
