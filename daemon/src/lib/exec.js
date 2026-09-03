import { execFile, execFileSync, spawn } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const availability = new Map()

/** Is a binary on PATH? Cached — a tool does not appear mid-session. */
export function has(bin) {
  if (!availability.has(bin)) {
    try {
      execFileSync('which', [bin], { stdio: 'ignore' })
      availability.set(bin, true)
    } catch {
      availability.set(bin, false)
    }
  }
  return availability.get(bin)
}

/** Run a command, never throw: returns { ok, stdout, stderr, code }. */
export async function run(bin, args = [], opts = {}) {
  try {
    const { stdout, stderr } = await execFileAsync(bin, args, {
      timeout: opts.timeout ?? 5000,
      maxBuffer: opts.maxBuffer ?? 4 * 1024 * 1024,
      encoding: 'utf8',
      ...opts,
    })
    return { ok: true, stdout: stdout.trim(), stderr: stderr.trim(), code: 0 }
  } catch (err) {
    return {
      ok: false,
      stdout: (err.stdout || '').toString().trim(),
      stderr: (err.stderr || err.message || '').toString().trim(),
      code: err.code ?? 1,
    }
  }
}

/**
 * Write text to the Wayland clipboard. `wl-copy` forks a background process
 * that owns the selection and inherits stdio, so exec-style helpers hang
 * waiting for EOF — hand it the text on stdin and discard its output instead.
 */
export function wlCopy(text) {
  return new Promise((resolve, reject) => {
    const child = spawn('wl-copy', ['--type', 'text/plain;charset=utf-8'], {
      stdio: ['pipe', 'ignore', 'ignore'],
    })
    child.on('error', reject)
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`wl-copy exited with ${code}`))))
    child.stdin.on('error', reject)
    child.stdin.end(text)
  })
}

/**
 * `notify-send` arguments, with the fence between this daemon's words and the
 * phone's put in explicitly.
 *
 * Almost every card this desktop draws carries text that came off a handset:
 * the body of an SMS, the name of a file somebody shared, the first line of
 * their clipboard, the caller's name out of their address book. Handed to
 * `notify-send` positionally, a text beginning with a dash stops being text —
 * libnotify parses with GLib's option parser, so `-u` inside a message picks
 * an urgency and `--icon` picks an icon, and a person who writes a message
 * beginning with a dash gets a notification that behaves in a way they did
 * not ask for on a desktop they do not own. The summary can also simply
 * disappear into an unknown option, which is a message silently not shown.
 *
 * `--` ends option parsing for good, and everything after it is the summary
 * and the body whatever it looks like. The flags this daemon chose itself
 * stay in front of it, where they are still read.
 */
export function notifyArgs(flags = [], ...texts) {
  return [...flags, '--', ...texts.filter((t) => t !== undefined && t !== null).map(String)]
}

/**
 * Fire and forget — for things like screen lock that outlive the request.
 *
 * `opts` is passed through so a caller can say where the thing should run:
 * starting a coding agent in a directory is the whole point of the call, and a
 * child that inherits the daemon's own working directory would start it in the
 * wrong project.
 */
export function spawnDetached(bin, args = [], opts = {}) {
  const child = spawn(bin, args, { detached: true, stdio: 'ignore', ...opts })
  child.unref()
  return child
}

export { spawn }
