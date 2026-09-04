/**
 * A conversation the app's process did not live through.
 *
 * Android kills a background app whenever it wants the memory, and it does it
 * to phones that are in the middle of a call — then starts the process again a
 * minute later purely to deliver the broadcast saying the call is over. Every
 * field naming that call used to live in a companion object and nothing else,
 * so the process that woke up for the ending minted a *second* token and
 * reported a call it knew nothing about: no number, no name, no direction. The
 * desktop drew a blank second line and counted a second call.
 *
 * The fix is three Kotlin files deep in `omarchy-telephony`, and Kotlin is the
 * one part of this repository with no test runner: there is no JVM harness
 * here, no Robolectric, and standing one up is a larger job than the bug. What
 * a suite *can* hold on to is the shape of the arrangement — that the record
 * is written where a killed process can find it, that it is written durably
 * rather than lazily, that the ending looks on disk and in the phone's own call
 * log before it decides it is looking at an orphan, and that a new call never
 * inherits an old one's caller. Each of those is a line that has been deleted
 * by accident before and would take a real phone call to notice.
 *
 * The behaviour itself is proved where it happens: `am kill` during a live
 * call, and the `ended` that follows read back off the desktop's own history
 * carrying the token the earlier reports carried.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { check, done } from '../../tools/test-harness.mjs'

const root = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))))
const kotlin = path.join(root, 'app/modules/omarchy-telephony/android/src/main/java/expo/modules/omarchytelephony')
const read = (name) => fs.readFileSync(path.join(kotlin, name), 'utf8')

const receiver = read('PhoneStateReceiver.kt')
const live = read('LiveCall.kt')
const last = read('LastCall.kt')
const backlog = read('Backlog.kt')

/** Where in a file something is, so that two things can be put in order. */
const at = (text, needle) => text.indexOf(needle)

/* ── the record outlives the process ────────────────────────────────────── */

const prefsOf = (text) => text.match(/PREFS\s*=\s*"([^"]+)"/)?.[1]
check(
  'the call in hand is held in the same store the backlog survives in',
  prefsOf(live) !== undefined && prefsOf(live) === prefsOf(backlog),
  `${prefsOf(live)} vs ${prefsOf(backlog)}`,
)
check(
  'and written durably, because the kill lands without warning',
  /\.commit\(\)/.test(live) && !/\.apply\(\)/.test(live),
)
check('a record too old to be a live call is refused', /STALE_MS/.test(live) && /call\.hold\.stale/.test(live))

/* ── the ending picks it back up ────────────────────────────────────────── */

check('the ending reads the disk when nothing is in memory', /if \(state != "ringing" && callId == null\) restore\(context\)/.test(receiver))
check(
  'before it decides the call has no beginning',
  at(receiver, 'restore(context)') > 0 && at(receiver, 'restore(context)') < at(receiver, 'call.orphan.ended'),
)
check(
  'and the phone’s own log is asked when the caller is still missing',
  /LastCall\.since\(context, offHookAt\)/.test(receiver) &&
    at(receiver, 'LastCall.since') < at(receiver, 'call.orphan.ended'),
)
check('a log entry is only believed when it belongs to the call that just ended', /GRACE_MS/.test(last) && /call\.log\.miss/.test(last))
check('a refusal to recover says why rather than passing as an orphan', /"reason" to "not-written"/.test(last))

/* ── what is written down, and when ─────────────────────────────────────── */

check('every transition but the ending writes the call down', /} else {\n      remember\(context\)\n    }/.test(receiver))
check('the caller is written down the moment the dialler names them', at(receiver, 'remember(context)') < at(receiver, 'call.identify.skipped'))
check('the ending takes the record away again', /LiveCall\.clear\(context\.applicationContext\)/.test(receiver))
check('a call that begins does not inherit an older one’s record', at(receiver, 'forget(context)') < at(receiver, 'begin("incoming")'))
check('and an abandoned record is worth a word', /call\.hold\.abandoned/.test(receiver))

/* ── nothing that belongs to the user reaches logcat ────────────────────── */

for (const [file, text] of [['PhoneStateReceiver.kt', receiver], ['LiveCall.kt', live], ['LastCall.kt', last]]) {
  const raw = [...text.matchAll(/Trace\.\w+\([^)]*?"(?:from|name|number)" to (?!Trace\.mark|Trace\.len)/g)]
  check(`${file} still marks the caller rather than printing them`, raw.length === 0, raw.map((m) => m[0]).join(' '))
}

done('call-recovery checks')
