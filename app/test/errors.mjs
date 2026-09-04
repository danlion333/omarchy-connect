/**
 * What the user is shown when something throws.
 *
 * The interesting inputs are the ones nobody writes on purpose: a promise that
 * rejects with a string, one that rejects with nothing at all, and a native
 * module that throws a Java exception whose `message` is a whole stack trace.
 * All three used to reach the screen unaltered — the last one as forty lines
 * of `at com.facebook.react…` in red — and the claim of this suite is that all
 * three now come out as one short line, with the original still reachable.
 */
import { FALLBACK, errorLine, problem } from '../src/lib/errors.ts'
import { check, done } from '../../tools/test-harness.mjs'

/** What a native throw actually looks like coming across the bridge. */
const NATIVE = `java.lang.SecurityException: Permission Denial: opening provider com.android.providers.media.MediaDocumentsProvider from ProcessRecord{ab12cd 9123:com.omarchy.connect/u0a221} (pid=9123, uid=10221) requires that you obtain access using ACTION_OPEN_DOCUMENT or similar
\tat android.os.Parcel.createExceptionOrNull(Parcel.java:3057)
\tat android.os.Parcel.createException(Parcel.java:3041)
\tat android.content.ContentResolver.openTypedAssetFileDescriptor(ContentResolver.java:1932)
Caused by: android.os.RemoteException: Remote stack trace:
\tat com.android.server.am.ActivityManagerService.checkContentProviderPermission(ActivityManagerService.java:6842)
\t... 23 more`

/* ── the four shapes the criteria name ──────────────────────────────────── */

check('an Error is its own message', problem(new Error('the desktop refused it')).message === 'the desktop refused it')
check('and has nothing to expand', problem(new Error('the desktop refused it')).detail === null)

check('a thrown string is the string', problem('no answer from that address').message === 'no answer from that address')

check('null says something rather than nothing', problem(null).message === FALLBACK)
check('undefined too', problem(undefined).message === FALLBACK)
check('and neither ever renders the word undefined', !/undefined/.test(`${problem(null).message}${problem(undefined).message}`))

const native = problem(new Error(NATIVE))
check('a native throw keeps only its first line', native.message.startsWith('Permission Denial: opening provider'))
check('with no frame in it', !/\bat\s/.test(native.message))
check('nor a Caused by', !/Caused by/.test(native.message))
check('nor the package path of the exception class', !native.message.includes('java.lang.SecurityException'))
check('short enough for a phone', native.message.length <= 141, `${native.message.length} chars`)
check('and the whole trace is still there underneath', native.detail === NATIVE)

/* ── everything else that has been thrown at a catch here ───────────────── */

check('a bare exception class keeps its simple name', problem(new Error('java.io.FileNotFoundException')).message === 'FileNotFoundException')
check(
  'a qualified message drops the path and keeps the prose',
  problem('android.system.ErrnoException: open failed: EACCES').message === 'open failed: EACCES',
)
check(
  'a frame glued onto the message instead of newlined is still cut off',
  problem('Attempt to invoke a virtual method on a null object reference at com.omarchy.link.Share.read(Share.kt:88)').message ===
    'Attempt to invoke a virtual method on a null object reference',
)
check(
  'a message that is nothing but frames falls back',
  problem('  at Share.read(Share.kt:88)\n  at Share.take(Share.kt:12)').message === FALLBACK,
)
check('an empty Error falls back', problem(new Error('')).message === FALLBACK)
check('an empty string does too', problem('   ').message === FALLBACK)
check('a caller with better words gets to use them', problem(null, 'the desktop did not answer').message === 'the desktop did not answer')
check('but only when the throw had none', problem(new Error('nope'), 'the desktop did not answer').message === 'nope')
check('a thrown object with no message says something', problem({ code: 7 }).message === FALLBACK)
check('a thrown object with an error field speaks it', problem({ error: 'token expired' }).message === 'token expired')
check('a thrown number is not swallowed', problem(404).message === '404')

const long = problem(`x${'y'.repeat(400)}`)
check('a very long line is cut', long.message.length <= 141, `${long.message.length} chars`)
check('and says it was cut', long.message.endsWith('…'))
check('and the full text is kept as detail', long.detail?.length === 401)

const wrapped = problem('could not read the file\nthe picker returned no path')
check('a second line of prose stays out of the line', wrapped.message === 'could not read the file')
check('but is offered as detail', wrapped.detail?.includes('the picker returned no path'))

/* ── the throw from issue #21, as the phone actually reported it ────────── */

const TORRENT = `Exception in HostFunction: java.lang.IllegalArgumentException: Illegal character in path at index 75: file:///data/user/0/dev.omarchy.connect/cache/omarchy-connect/00ba3a40af6a/[Pikuma]%20Pikuma%20-%203D%20[2026,%20ENG]%20[rutracker-6873532].torrent
  at java.net.URI.create(URI.java:848)
  at expo.modules.filesystem.unifiedfile.JavaFile.<init>(JavaFile.kt:22)`

const torrent = problem(TORRENT)
check('the bridge wrapper is peeled off', torrent.message.startsWith('Illegal character in path at index 75'))
check('and the exception class with it', !torrent.message.includes('IllegalArgumentException'))
check('and it fits on a phone', torrent.message.length <= 141, `${torrent.message.length} chars`)
check('with the trace still one tap away', torrent.detail === TORRENT)

check('errorLine is the line on its own', errorLine(new Error(NATIVE)) === native.message)
check('and never returns undefined', typeof errorLine(undefined) === 'string')

done('error normalisation checks')
