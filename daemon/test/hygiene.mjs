/**
 * Where a string from the phone stops being a string, and where a stranger's
 * request stops being consent.
 *
 * Three places in this daemon read something arriving from outside as wider
 * than it is, and they are the same bug wearing three coats. A prompt typed on
 * a handset becomes the CLI's options. A text message becomes `notify-send`'s
 * options. A pairing question from whatever device is in the room becomes the
 * answer to the question the user actually asked. None of them needs a hostile
 * neighbour to go wrong — a message that starts with a dash is an ordinary
 * message — but each of them is a way for somebody else to choose something on
 * this desktop, which is what makes them worth a suite rather than a comment.
 *
 * Nothing here touches the machine's real radio or its real notification
 * server: `bluetoothctl` and `notify-send` are stand-ins on PATH that write
 * down what they were handed and exit.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { check, done } from '../../tools/test-harness.mjs'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'omarchy-connect-hygiene-'))

/**
 * Stand-ins ahead of the real tools, and the recording they leave behind.
 *
 * Every argument on its own line, so a body containing a newline is still one
 * argument to whoever reads the file back — `printf '%s\0'` would be tidier
 * and is unreadable in a failure message. No text under test has a newline.
 */
const bin = path.join(sandbox, 'bin')
fs.mkdirSync(bin, { recursive: true })
const argvLog = path.join(sandbox, 'notify-send.argv')
fs.writeFileSync(
  path.join(bin, 'notify-send'),
  `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a" >> ${JSON.stringify(argvLog)}; done\nprintf '%s\\n' '--END--' >> ${JSON.stringify(argvLog)}\nexit 0\n`,
  { mode: 0o755 },
)
fs.writeFileSync(path.join(bin, 'wl-copy'), '#!/bin/sh\ncat > /dev/null\nexit 0\n', { mode: 0o755 })
process.env.PATH = `${bin}:${process.env.PATH}`

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * The arguments of the notification raised since the last call, or null.
 *
 * Most of these cards are fired and forgotten — `spawnDetached` returns long
 * before the shell it started has written anything — so this waits for a
 * complete run to appear rather than reading whatever is on disk this
 * millisecond and calling an empty file a failure.
 */
async function lastNotification() {
  let raw = ''
  for (let tries = 0; tries < 40; tries += 1) {
    try {
      raw = fs.readFileSync(argvLog, 'utf8')
    } catch {
      raw = ''
    }
    if (raw.includes('--END--')) break
    await wait(50)
  }
  if (!raw.includes('--END--')) return null
  fs.rmSync(argvLog, { force: true })
  const runs = raw.split('--END--\n').filter((r) => r.length)
  const last = runs[runs.length - 1]
  if (!last) return null
  return last.split('\n').slice(0, -1)
}

/** Where the text starts, and everything the option parser is allowed to see. */
const fenced = (argv) => (argv || []).indexOf('--')
const textOf = (argv) => (argv || []).slice(fenced(argv) + 1)

/* ── the fence itself ─────────────────────────────────────────────────── */

const { notifyArgs } = await import('../src/lib/exec.js')

check(
  'a summary that looks like a flag lands after the fence',
  JSON.stringify(notifyArgs(['-a', 'Omarchy Connect'], '-u critical')) ===
    JSON.stringify(['-a', 'Omarchy Connect', '--', '-u critical']),
  JSON.stringify(notifyArgs(['-a', 'Omarchy Connect'], '-u critical')),
)
check(
  "the daemon's own flags stay in front of it, where they are read",
  notifyArgs(['-u', 'low', '-t', '0'], 'x', 'y').slice(0, 4).join(' ') === '-u low -t 0',
)
check(
  'a body that was never given does not become an empty argument',
  JSON.stringify(notifyArgs(['-a', 'x'], 'summary', null)) === JSON.stringify(['-a', 'x', '--', 'summary']),
  JSON.stringify(notifyArgs(['-a', 'x'], 'summary', null)),
)

/* ── the paths a phone's text really takes ────────────────────────────── */

const notifications = (await import('../src/plugins/notifications.js')).default
await notifications.methods['notifications.send']({ summary: '--icon=/tmp/evil.png', body: '-u critical' })
let argv = await lastNotification()
check('a notification from the phone reaches notify-send fenced', fenced(argv) >= 0, JSON.stringify(argv))
check(
  'its summary and body are text, not options',
  JSON.stringify(textOf(argv)) === JSON.stringify(['--icon=/tmp/evil.png', '-u critical']),
  JSON.stringify(argv),
)
check(
  'the urgency the phone asked for is still an urgency',
  ((await notifications.methods['notifications.send']({ summary: 'hi', urgency: 'critical' })),
  (await lastNotification())?.slice(0, 4).join(' ') === '-a Omarchy Connect -u critical'),
)

process.env.XDG_DOWNLOAD_DIR = path.join(sandbox, 'Downloads')
const share = await import('../src/plugins/share.js')
share.announceReceivedFile(path.join(sandbox, '--config=x.pdf'))
argv = await lastNotification()
check(
  'a received file whose name is a flag is announced as a name',
  JSON.stringify(textOf(argv)) === JSON.stringify(['File received', '--config=x.pdf']),
  JSON.stringify(argv),
)

await share.default.methods['share.text']({ text: '-e drop the last window', action: 'clipboard' })
argv = await lastNotification()
check(
  'so is a clipboard that begins with a dash',
  JSON.stringify(textOf(argv)) === JSON.stringify(['Copied from phone', '-e drop the last window']),
  JSON.stringify(argv),
)

const { TalkTime } = await import('../src/lib/talktime.js')
const card = new TalkTime()
card.start({ who: '-u critical' })
argv = await lastNotification()
check(
  'a caller whose address-book name is a flag gets a call card, not an option',
  textOf(argv)[0] === 'On call · -u critical',
  JSON.stringify(argv),
)
card.stop({ quiet: true })

/**
 * And the cards no test can raise from here — the ringing call, the OTP, the
 * CLI's "sent to phone" — by reading the source rather than the desktop.
 *
 * A scan is a poor test and a good fence. It cannot say the arguments are
 * right; it can say that nobody has added a thirteenth call site that builds
 * its own array, which is exactly how the first twelve came to be wrong.
 */
const sources = []
for (const dir of [path.join(root, 'src'), path.join(root, 'bin')]) {
  const walk = (at) => {
    for (const entry of fs.readdirSync(at, { withFileTypes: true })) {
      const full = path.join(at, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name.endsWith('.js')) sources.push(full)
    }
  }
  walk(dir)
}
const raisers = sources.filter((f) => /\((?:'|")notify-send(?:'|"),/.test(fs.readFileSync(f, 'utf8')))
const unfenced = raisers.filter((f) => !fs.readFileSync(f, 'utf8').includes('notifyArgs'))
check('every file that raises a notification builds its arguments through notifyArgs',
  raisers.length > 0 && unfenced.length === 0, unfenced.map((f) => path.basename(f)).join(', '))

/* ── the prompt a phone sends an agent off with ───────────────────────── */

const { agentCommand } = await import('../src/plugins/agents.js')

check(
  'a background prompt beginning with a dash is a prompt',
  JSON.stringify(agentCommand({ args: [], prompt: '-p tell me about this repo', background: true })) ===
    JSON.stringify(['--bg', '--', '-p tell me about this repo']),
  JSON.stringify(agentCommand({ args: [], prompt: '-p tell me about this repo', background: true })),
)
check(
  "the daemon's own flags are still flags on that road",
  JSON.stringify(agentCommand({ args: ['--resume', 'abc'], prompt: '--help', background: true })) ===
    JSON.stringify(['--resume', 'abc', '--bg', '--', '--help']),
)
check(
  'the road that already fenced its prompt has not changed',
  JSON.stringify(agentCommand({ args: ['--name', 'from the phone'], prompt: '-x' })) ===
    JSON.stringify(['--name', 'from the phone', '--', '-x']),
)
check(
  'an interactive start with nothing to say opens no empty prompt',
  JSON.stringify(agentCommand({ args: ['--resume', 'abc'] })) === JSON.stringify(['--resume', 'abc']),
)

/* ── whose pairing question it is ─────────────────────────────────────── */

const { requestIsExpected, agent } = await import('../src/lib/bluez.js')

const phone = { address: 'AA:BB:CC:DD:EE:FF', name: 'Pixel 8', paired: false, connected: true }
const stranger = { address: '11:22:33:44:55:66', name: 'iPhone', paired: false, connected: true }
const bonded = { address: '99:99:99:99:99:99', name: 'Pixel 8', paired: true, connected: true }

check('the handset the window was opened for is confirmed',
  requestIsExpected([phone], { expected: 'Pixel 8' }) === true)
check('a device this desktop paged itself is confirmed by address',
  requestIsExpected([{ ...phone, name: null }], { expected: 'Pixel 8', address: 'AA:BB:CC:DD:EE:FF' }) === true)
check('somebody else asking during the window is not',
  requestIsExpected([stranger], { expected: 'Pixel 8' }) === false)
check('nor is a stranger standing beside the right phone',
  requestIsExpected([phone, stranger], { expected: 'Pixel 8' }) === false)
check('a question with nothing mid-pairing behind it is not confirmed',
  requestIsExpected([bonded], { expected: 'Pixel 8' }) === false)
check('and a desktop with no phone to expect confirms nothing here',
  requestIsExpected([phone], { expected: null }) === false)

/**
 * The agent end of the same question, against a `bluetoothctl` that asks one.
 *
 * The stand-in prints the prompt BlueZ's own agent prints — no newline, no
 * name for the device — and writes back whatever it is told, which is the
 * whole of what this daemon gets to see.
 */
const btLog = path.join(sandbox, 'bluetoothctl.in')
fs.writeFileSync(
  path.join(bin, 'bluetoothctl'),
  `#!/bin/sh\nprintf 'Confirm passkey 123456 (yes/no): '\nwhile IFS= read -r line; do printf '%s\\n' "$line" >> ${JSON.stringify(btLog)}; done\n`,
  { mode: 0o755 },
)

const answered = async (confirm) => {
  fs.rmSync(btLog, { force: true })
  const helper = agent({ confirm })
  await wait(700)
  helper?.stop()
  const lines = fs.existsSync(btLog) ? fs.readFileSync(btLog, 'utf8').trim().split('\n') : []
  return lines.filter((l) => l === 'yes' || l === 'no')
}

check('a question the caller owns is answered yes', (await answered(() => true)).includes('yes'))
const declined = await answered(() => false)
check('a question the caller disowns is answered no, not left hanging',
  declined.includes('no') && !declined.includes('yes'), JSON.stringify(declined))
const threw = await answered(() => {
  throw new Error('the tree could not be read')
})
check('and a caller that could not tell does not become a yes',
  !threw.includes('yes'), JSON.stringify(threw))

/**
 * Retried, because the last stand-in above is a shell sitting in `read` and
 * `helper.stop()` only asks it to go. On a quiet machine it is gone before
 * this line; inside a full suite run it is not, and a stub that writes one
 * more line into the sandbox between the unlink and the rmdir turns a passing
 * suite into `ENOTEMPTY` — a crash, in the runner's report, of a suite whose
 * every check had already passed.
 */
fs.rmSync(sandbox, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
done('argument and consent hygiene checks')
