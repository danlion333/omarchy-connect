/**
 * The last line between a bug and a dead daemon.
 *
 * Node's default for an uncaught exception is to print a stack and exit, and
 * for a long-running process that is almost never the right answer. This
 * daemon holds the only link a phone has to the desktop: a WebSocket per
 * device, a pairing in progress, a file half-received. Killing all of that
 * because one HTTP route threw on one bad filename is the wrong trade — the
 * request deserved to fail, the process did not.
 *
 * So a thrown error nobody caught becomes what it should have been in the
 * first place: a line in the log, loud, with its stack, and the process
 * carries on. `handleHttp` already catches the ones it can see; this is for
 * the ones nobody thought of, and for anything thrown from a timer or a
 * stream callback where there is no `try` above it at all.
 *
 * The honest caveat, said here rather than discovered later: a process that
 * survives an exception it did not expect may be holding state it half
 * finished writing. That is a worse position than a clean restart in theory,
 * and a much better one in practice, because the alternative is that every
 * connected device is dropped and everything anybody was doing is lost. When
 * the state really is unrecoverable, the next thing to touch it throws too,
 * and that also lands here — with a log line saying so, instead of silence.
 */
import { log } from './log.js'

let installed = false

export function installCrashGuard({ label = 'daemon' } = {}) {
  if (installed) return false
  installed = true

  process.on('uncaughtException', (err, origin) => {
    log.error(`uncaught exception in the ${label} (${origin}) — the process is staying up:`, err)
  })

  process.on('unhandledRejection', (reason) => {
    const err = reason instanceof Error ? reason : new Error(String(reason))
    log.error(`unhandled rejection in the ${label} — the process is staying up:`, err)
  })

  return true
}
