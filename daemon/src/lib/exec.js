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

/** Fire and forget — for things like screen lock that outlive the request. */
export function spawnDetached(bin, args = []) {
  const child = spawn(bin, args, { detached: true, stdio: 'ignore' })
  child.unref()
  return child
}

export { spawn }
