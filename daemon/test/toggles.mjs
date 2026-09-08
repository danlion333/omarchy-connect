/**
 * The desktop's switches and its terminal, from the phone's side.
 *
 * These three methods are thin — they run one of Omarchy's own scripts and
 * report what it said — so what is worth testing is exactly the thin part:
 * that a name the phone did not get from the whitelist never reaches a shell,
 * that a switch this machine cannot answer for comes back `null` instead of
 * a guessed `false`, and that a flip is awaited long enough to report where
 * the switch actually landed rather than where it was before.
 *
 * The scripts are stood in for by shell stubs on a private PATH, and they keep
 * their state the way the real ones do: `omarchy-toggle-idle` in a flag file,
 * `omarchy-toggle-nightlight` in a value it prints back as JSON. `omarchy-shell`
 * is deliberately *not* installed here, which is how the do-not-disturb switch
 * gets to be the missing one.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { check, done } from '../../tools/test-harness.mjs'

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'omarchy-connect-toggles-'))
process.on('exit', () => fs.rmSync(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))

const bin = path.join(sandbox, 'bin')
fs.mkdirSync(bin, { recursive: true })
// The stubs get the real PATH back for their own `rm`/`touch`/`sleep`; the
// daemon under test does not (see the PATH note below).
const stub = (name, body) => {
  fs.writeFileSync(path.join(bin, name), `#!/bin/bash\nexport PATH=/usr/bin:/bin\n${body}\n`, { mode: 0o755 })
}

const awakeFlag = path.join(sandbox, 'stay-awake')
const warmFlag = path.join(sandbox, 'warm')
const launchLog = path.join(sandbox, 'launched.log')

stub(
  'omarchy-toggle-idle',
  `state() { [[ -f ${JSON.stringify(awakeFlag)} ]]; }
case "\${1:-toggle}" in
  status) if state; then echo '{"enabled":true,"class":"enabled"}'; else echo '{"enabled":false,"class":"disabled"}'; fi ;;
  toggle) if state; then rm -f ${JSON.stringify(awakeFlag)}; else touch ${JSON.stringify(awakeFlag)}; fi ;;
esac`,
)

stub(
  'omarchy-toggle-nightlight',
  `if [[ \${1:-} == --status ]]; then
  if [[ -f ${JSON.stringify(warmFlag)} ]]; then echo '{"enabled":true,"temperature":4000}'; else echo '{"enabled":false,"temperature":6500}'; fi
  exit 0
fi
# The real script loops for up to two seconds before the state settles.
sleep 0.4
if [[ -f ${JSON.stringify(warmFlag)} ]]; then rm -f ${JSON.stringify(warmFlag)}; else touch ${JSON.stringify(warmFlag)}; fi`,
)

stub('omarchy-launch-terminal', `printf 'terminal\\n' >> ${JSON.stringify(launchLog)}`)
stub(
  'omarchy-launch-floating-terminal-with-presentation',
  `printf 'floating %s\\n' "$*" >> ${JSON.stringify(launchLog)}`,
)

// `has()` caches on first use and reads PATH through `which`, so the private
// PATH has to be in place before the plugin is ever imported — and it has to
// be the *whole* PATH, not a prefix of the machine's. Omarchy's own scripts
// are installed in `/usr/bin` on a real desktop, and a suite that reached one
// would flip the do-not-disturb of the machine it is running on rather than
// test anything. So the stubs are alone on it, with `which` borrowed in
// because `has()` needs it to answer at all.
fs.symlinkSync('/usr/bin/which', path.join(bin, 'which'))
process.env.PATH = bin
const desktop = (await import('../src/plugins/desktop.js')).default
const call = (method, params) => desktop.methods[method].call(desktop.methods, params)

/* ── reading ────────────────────────────────────────────────────────────── */

const first = await call('system.toggles')
check('every switch is answered in one call', Object.keys(first).sort().join(',') === 'idle,nightlight,silencing', JSON.stringify(first))
check('a flag file that is not there reads as off', first.idle?.on === false, JSON.stringify(first.idle))
check('nightlight reads its own status JSON', first.nightlight?.on === false, JSON.stringify(first.nightlight))
check('a switch with no script behind it is null, not false', first.silencing === null, JSON.stringify(first.silencing))

const caps = desktop.capabilities()
check('one installed script is enough to offer the tiles', caps.toggles === true, JSON.stringify(caps.toggles))
check('the terminal is offered because its launcher is installed', caps.launch === true, JSON.stringify(caps.launch))

/* ── flipping ───────────────────────────────────────────────────────────── */

const on = await call('system.toggle', { name: 'idle' })
check('a flip answers with the switch it moved', on.name === 'idle', JSON.stringify(on))
check('and with where it landed, not where it was', on.on === true, JSON.stringify(on))
check('the flip is visible to the next read', (await call('system.toggles')).idle?.on === true)

const off = await call('system.toggle', { name: 'idle' })
check('flipping again puts it back', off.on === false, JSON.stringify(off))
check('the desktop is left as it was found', fs.existsSync(awakeFlag) === false)

// The real nightlight script spends up to two seconds resending the
// temperature; a reply that did not wait would carry the old state.
const warm = await call('system.toggle', { name: 'nightlight' })
check('a slow script is waited for rather than reported stale', warm.on === true, JSON.stringify(warm))
await call('system.toggle', { name: 'nightlight' })

/* ── the whitelist ──────────────────────────────────────────────────────── */

const refused = async (method, params) => {
  try {
    await call(method, params)
    return null
  } catch (err) {
    return err.message
  }
}

// A switch that reads as null cannot be flipped either, and says which script
// is missing rather than failing silently or pretending it moved.
const blind = await refused('system.toggle', { name: 'silencing' })
check('flipping a switch with no script behind it names the missing one', /omarchy-shell not installed/.test(blind || ''), String(blind))

check('an unknown switch name is refused', /unknown toggle/.test(await refused('system.toggle', { name: 'wifi' }) || ''), String(await refused('system.toggle', { name: 'wifi' })))
check('and a name that is a command is not run', /unknown toggle/.test(await refused('system.toggle', { name: 'idle; rm -rf /' }) || ''))
check('a prototype key is not a switch', /unknown toggle/.test(await refused('system.toggle', { name: 'constructor' }) || ''))
check('a missing name is refused too', /unknown toggle/.test(await refused('system.toggle', {}) || ''))

/* ── launching ──────────────────────────────────────────────────────────── */

const term = await call('system.launch', { app: 'terminal' })
check('the terminal reports which app it started', term.ok === true && term.app === 'terminal', JSON.stringify(term))
await call('system.launch', { app: 'floating-terminal' })
for (let i = 0; i < 40 && !/floating/.test(read(launchLog)); i += 1) await new Promise((r) => setTimeout(r, 50))
check('the terminal launcher was actually run', /^terminal$/m.test(read(launchLog)), read(launchLog).trim())
// The presentation wrapper wraps its argument in a bash -c string, so an
// empty command is a syntax error rather than a window.
check('the floating terminal is given a command to run', /^floating bash$/m.test(read(launchLog)), read(launchLog).trim())

check('an unknown app is refused', /unknown app/.test(await refused('system.launch', { app: 'browser' }) || ''))
check('and so is a prototype key', /unknown app/.test(await refused('system.launch', { app: '__proto__' }) || ''))

function read(file) {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}

done('desktop toggle and launch checks')
