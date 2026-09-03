/**
 * The one-time code inside a mirrored message, and the button that takes it.
 *
 * Two halves, tested apart because they fail apart. The extractor is a pure
 * function over text and is exercised directly against messages in eight
 * languages — that is the half that decides whether the feature works for
 * anybody outside the English-speaking web. The wiring is exercised against a
 * real daemon with stand-ins for libnotify and the clipboard on PATH, because
 * the parts that go wrong there — the card offering no button, the code never
 * reaching the clipboard, the copy sailing back to the phone it came from —
 * are all side effects that only a running daemon produces.
 *
 * The echo is the subtle one and has its own check. The clipboard plugin
 * watches for changes and publishes them to the phone as "the desktop copied
 * something"; a code copied off a mirrored SMS that went back down that wire
 * would put the phone's own message into the phone's own clipboard, which is
 * both useless and a private thing making a round trip for no reason.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { quietBluetooth, localHeaders } from './sandbox.mjs'
import { connectPhone } from './phone.mjs'
import { extractCode, explain } from '../src/lib/otp.js'

const PORT = Number(process.env.PORT || 8799)
const base = `http://127.0.0.1:${PORT}`
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'omarchy-connect-otp-'))

// The local HTTP routes are gated on the secret the daemon publishes in its
// own status file, so every post below reads it the way the CLI does.
const local = () => localHeaders(path.join(sandbox, 'state'))

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`)
}

/* ── the extractor, on its own ───────────────────────────────────────── */

/**
 * Real messages, or as close as a test can get without publishing somebody's.
 *
 * The list is deliberately not all English. The whole argument for borrowing
 * otphelper's phrase list rather than writing a regex over "code is" was that
 * a desktop in Kyiv receives its bank's SMS in Ukrainian, and a feature that
 * only reads English is a feature for the half of the user's messages that
 * were not worth automating anyway.
 */
const MESSAGES = [
  ['English, plain', 'Your verification code is 123456', '123456'],
  ['English, prefixed', 'G-847291 is your Google verification code.', '847291'],
  ['English, hyphenated', 'Your Amazon OTP is 923-841. Do not share it.', '923841'],
  ['English, spelled out', 'Use 12 34 56 as your one-time password', '123456'],
  ['Ukrainian', 'Ваш код підтвердження: 5821', '5821'],
  ['Russian', 'Код для входа: 908371. Никому не сообщайте.', '908371'],
  ['German, code first', '445566 ist Ihr Einmalkennwort für die Anmeldung', '445566'],
  ['Turkish', 'Doğrulama kodunuz: 483920', '483920'],
  ['Chinese', '【淘宝】验证码 738291，请勿泄露', '738291'],
  ['Persian, Persian digits', '۴۵۶۷۸۹ کد تایید شماست', '456789'],
  ['Spanish', 'Tu código de verificación es 553311', '553311'],
]

for (const [name, message, expected] of MESSAGES) {
  const got = extractCode(message)
  check(`reads a code in ${name}`, got === expected, got === expected ? got : `got ${got}, wanted ${expected}`)
}

/**
 * The messages that must produce nothing.
 *
 * A false positive is worse than a miss here: the button quietly replaces
 * whatever was on the clipboard, and a coupon code or a tracking number
 * landing there is a paste into a bank form that nobody looks at twice.
 */
const NOT_CODES = [
  ['a discount', 'Get 20% off with discount code SPRING2024'],
  ['a message from a person', 'Hey, are we still on for 8pm?'],
  ['a tracking number', 'Your order 12345 has shipped, track it at example.com/track'],
  ['a sum of money', 'Your account was debited 45000 USD today'],
  ['an ordinary word after the trigger', 'Sorry, that code looks invalid'],
]

for (const [name, message] of NOT_CODES) {
  const got = extractCode(message)
  check(`finds no code in ${name}`, got === null, got === null ? '' : `got ${got}`)
}

check('a code is digits, however the sender wrote them', extractCode('کد شما ۱۲۳۴ است') === '1234')
check('an absurdly long run is not a code', extractCode('Your code is 12345678901234') === null)
/**
 * The body of an SMS is written by whoever knows the number, and this runs on
 * the daemon's only thread.
 *
 * The matcher steps over the prose between the trigger word and the code with
 * `\s*` in front of a run that can itself match whitespace, and two ways of
 * consuming the same blank is what catastrophic backtracking is made of: a
 * message of nothing but spaces used to stall the whole daemon for five
 * seconds — call control and the socket with it. The message is flattened
 * before the matcher sees it, and this is the check that says so.
 */
const nasty = [
  'код: ' + ' '.repeat(1500) + '1',
  'code ' + '1, '.repeat(600),
  'code '.repeat(330),
  'code ' + '1-'.repeat(950),
].map((s) => s.slice(0, 2000))
const worst = Math.max(
  ...nasty.map((s) => {
    const at = process.hrtime.bigint()
    extractCode(s)
    return Number(process.hrtime.bigint() - at) / 1e6
  }),
)
check('a hostile message cannot stall the daemon', worst < 250, `${worst.toFixed(1)}ms on the worst of four`)
check('and flattening it changes no answer', extractCode('Your code is\n\n   445566\n') === '445566')

check(
  'a refusal says why, for the person holding the message',
  explain('Get 20% off with code SPRING').why?.includes('advert') === true,
  explain('Get 20% off with code SPRING').why,
)

/* ── the wiring, against a running daemon ────────────────────────────── */

const fakeBin = path.join(sandbox, 'bin')
fs.mkdirSync(fakeBin, { recursive: true })

/**
 * A stand-in for libnotify, as in `calls.mjs`: a log of what the desktop was
 * asked to show, and — because a card with actions is a card that waits — a
 * click, delivered by dropping a flag on disk.
 *
 * `-p` prints the id the real one prints, which is what lets the card that
 * offered the code be rewritten into the card that says it was taken.
 */
const notifyLog = path.join(sandbox, 'notify.log')
const clickFlag = path.join(sandbox, 'click')
fs.writeFileSync(
  path.join(fakeBin, 'notify-send'),
  [
    '#!/bin/sh',
    `printf '%s\\n' "$*" >> ${JSON.stringify(notifyLog)}`,
    "case \" $* \" in *\" -p \"*) printf '4242\\n' ;; esac",
    'case " $* " in',
    '  *" -A "*)',
    '    i=0',
    '    while [ $i -lt 300 ]; do',
    `      if [ -f ${JSON.stringify(clickFlag)} ]; then`,
    `        rm -f ${JSON.stringify(clickFlag)}`,
    "        printf 'copy\\n'",
    '        exit 0',
    '      fi',
    '      i=$((i+1))',
    '      sleep 0.05',
    '    done',
    '    exit 0 ;;',
    'esac',
    '',
  ].join('\n'),
  { mode: 0o755 },
)

/** Buttonless, like the shell this project actually ships against. */
fs.writeFileSync(
  path.join(fakeBin, 'gdbus'),
  [
    '#!/bin/sh',
    'case " $* " in',
    '  *" monitor "*) exec sleep 3600 ;;',
    '  *GetServerInformation*) printf "(\'quickshell\', \'quickshell\', \'\', \'1.2\')\\n" ;;',
    'esac',
    '',
  ].join('\n'),
  { mode: 0o755 },
)

/**
 * A stand-in for the Wayland clipboard: one file, and a watcher that notices
 * when it changes.
 *
 * The watcher half is what makes the echo check possible. The real
 * `wl-paste --watch` runs a command on every change no matter who made it,
 * which is exactly the behaviour that would send a copied code back to the
 * phone — so the stand-in reproduces it rather than staying quiet.
 */
const clipFile = path.join(sandbox, 'clipboard')
fs.writeFileSync(clipFile, '')
fs.writeFileSync(
  path.join(fakeBin, 'wl-copy'),
  ['#!/bin/sh', `cat > ${JSON.stringify(clipFile)}`, ''].join('\n'),
  { mode: 0o755 },
)
fs.writeFileSync(
  path.join(fakeBin, 'wl-paste'),
  [
    '#!/bin/sh',
    'case " $* " in',
    '  *" --watch "*)',
    '    shift',
    // Content rather than mtime: `test -nt` compares whole seconds here, and
    // a copy made in the same second as the last one would go unnoticed.
    `    seen=${JSON.stringify(path.join(sandbox, 'clipseen'))}`,
    `    cp ${JSON.stringify(clipFile)} "$seen"`,
    '    while true; do',
    `      if ! cmp -s ${JSON.stringify(clipFile)} "$seen"; then`,
    `        cp ${JSON.stringify(clipFile)} "$seen"`,
    '        "$@"',
    '      fi',
    '      sleep 0.1',
    '    done ;;',
    '  *--list-types*) printf \'text/plain\\n\' ;;',
    `  *) cat ${JSON.stringify(clipFile)} ;;`,
    'esac',
    '',
  ].join('\n'),
  { mode: 0o755 },
)

quietBluetooth(sandbox)

const daemon = spawn(
  process.execPath,
  [path.join(root, 'bin', 'omarchy-connect.js'), 'start', '--port', String(PORT)],
  {
    env: {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH}`,
      XDG_CONFIG_HOME: sandbox,
      OMARCHY_CONNECT_STATE: path.join(sandbox, 'state'),
      OMARCHY_CONNECT_LOG: 'error',
    },
    stdio: ['ignore', 'ignore', 'inherit'],
  },
)
process.on('exit', () => {
  daemon.kill('SIGTERM')
  fs.rmSync(sandbox, { recursive: true, force: true })
})

for (let i = 0; i < 40; i += 1) {
  try {
    if ((await fetch(`${base}/api/info`)).ok) break
  } catch {
    await new Promise((r) => setTimeout(r, 250))
  }
}

const post = async (pathname, body) => {
  const res = await fetch(`${base}${pathname}`, {
    method: 'POST',
    headers: local(),
    body: JSON.stringify(body),
  })
  return { status: res.status, data: await res.json() }
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const notifications = () => (fs.existsSync(notifyLog) ? fs.readFileSync(notifyLog, 'utf8') : '')

/* ── a phone on the socket, mirroring messages ───────────────────────── */

const info = await (await fetch(`${base}/api/info`)).json()
const pair = await (await fetch(`${base}/api/pair-code`, { method: 'POST', headers: local() })).json()
const phone = connectPhone(PORT, info.publicKey)
const clipboardEvents = []
let nextId = 1
const pendingReq = new Map()
phone.on((msg) => {
  if (msg.t === 'res' && pendingReq.has(msg.id)) {
    const { resolve, reject } = pendingReq.get(msg.id)
    pendingReq.delete(msg.id)
    msg.error ? reject(new Error(msg.error)) : resolve(msg.data)
  }
  if (msg.t === 'ev' && msg.event === 'clipboard') clipboardEvents.push(msg.data)
})
const req = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = String(nextId++)
    pendingReq.set(id, { resolve, reject })
    phone.send({ t: 'req', id, method, params })
    setTimeout(() => reject(new Error(`${method} timed out`)), 8000)
  })

await phone.ready
await new Promise((resolve, reject) => {
  phone.on((msg) => {
    if (msg.t === 'hello.ok') resolve(msg)
    if (msg.t === 'hello.err') reject(new Error(msg.error))
  })
  phone.send({ t: 'hello', pairCode: pair.code, device: { id: 'otp-test', name: 'OTP Phone', platform: 'android' } })
  setTimeout(() => reject(new Error('no hello')), 8000)
})
await req('clipboard.get').catch(() => null)
phone.send({ t: 'sub', events: ['clipboard'] })
await wait(300)

// A watcher that notices nothing would make the echo check below pass for the
// wrong reason, so it is proved live first: somebody else's hand on the
// clipboard does reach the phone, and only ours is meant to be silent.
fs.writeFileSync(clipFile, 'somebody else copied this')
await wait(700)
check('an ordinary copy on this desktop reaches the phone', clipboardEvents.length > 0, `${clipboardEvents.length} events`)
clipboardEvents.length = 0

/* ── the button ──────────────────────────────────────────────────────── */

await req('phone.report', {
  events: [{ kind: 'sms', at: Date.now(), from: '+15550001111', name: 'Bank', body: 'Your verification code is 445566' }],
})
await wait(400)
const offered = notifications()
check('a message with a code raises a card with an action', offered.includes('-A copy=Copy 445566'), offered.trim().split('\n').pop())
check(
  'and a buttonless server is told the click is what copies',
  offered.includes('click to copy 445566'),
)

fs.writeFileSync(clickFlag, '')
await wait(700)
check('clicking it puts the code on the clipboard', fs.readFileSync(clipFile, 'utf8') === '445566', JSON.stringify(fs.readFileSync(clipFile, 'utf8')))
check('and the card that offered it says so, in place', notifications().includes('-r 4242') && notifications().includes('445566 copied'))

// The clipboard watcher polls every 100ms in the stand-in and the daemon
// debounces nothing, so a second is a generous window for an echo to arrive.
await wait(1000)
check('the code does not sail back to the phone that sent it', clipboardEvents.length === 0, `${clipboardEvents.length} clipboard events`)

/* ── a message with nothing to take ──────────────────────────────────── */

const before = notifications().length
await req('phone.report', {
  events: [{ kind: 'sms', at: Date.now(), from: '+15550002222', name: 'Mum', body: 'dinner at eight' }],
})
await wait(400)
const ordinary = notifications().slice(before)
check('an ordinary message gets an ordinary card', ordinary.includes('dinner at eight') && !ordinary.includes('-A '))

/* ── the switches ────────────────────────────────────────────────────── */

const status = await post('/api/otp', { op: 'status' })
check('the feature is on out of the box', status.data.otp?.enabled === true && status.data.otp?.autoCopy === false)

const tested = await post('/api/otp', { op: 'test', value: 'Ваш код підтвердження: 5821' })
check('a message can be tried without waiting for a real one', tested.data.code === '5821', tested.data.code)

const auto = await post('/api/otp', { op: 'auto', value: 'on' })
check('auto-copy can be switched on', auto.data.otp?.autoCopy === true)

const cleared = notifications().length
await req('phone.report', {
  events: [{ kind: 'sms', at: Date.now(), from: '+15550003333', name: 'Bank', body: 'Код для входа: 908371' }],
})
await wait(700)
const auto1 = notifications().slice(cleared)
check('with auto-copy on, the code is taken without being asked', fs.readFileSync(clipFile, 'utf8') === '908371')
check('and the card says where it went rather than offering a button', auto1.includes('is on the clipboard') && !auto1.includes('-A '))

const off = await post('/api/otp', { op: 'copy', value: 'off' })
check('switching the feature off stands auto-copy down with it', off.data.otp?.enabled === false && off.data.otp?.autoCopy === false)

const quiet = notifications().length
await req('phone.report', {
  events: [{ kind: 'sms', at: Date.now(), from: '+15550004444', name: 'Bank', body: 'Your verification code is 777888' }],
})
await wait(400)
const afterOff = notifications().slice(quiet)
check('and then a code is left where it is', afterOff.includes('777888') && !afterOff.includes('-A '))
check('the clipboard is untouched by a message arriving with it off', fs.readFileSync(clipFile, 'utf8') === '908371')

const bad = await post('/api/otp', { op: 'nonsense', value: 'on' })
check('an unknown action is refused rather than guessed at', bad.status === 400, bad.data?.error)

const written = JSON.parse(fs.readFileSync(path.join(sandbox, 'omarchy-connect', 'config.json'), 'utf8'))
check('the setting is written down, not only remembered', written.otp?.enabled === false, JSON.stringify(written.otp))

phone.close()

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} one-time-code checks passed`)
process.exit(failed.length ? 1 : 0)
