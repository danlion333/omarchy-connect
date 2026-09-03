/**
 * The half of a test suite that is not about the thing being tested.
 *
 * Every suite in this repository grew its own copy of the same five lines — an
 * array, a `check` that pushes to it and prints, a tail that counts what
 * failed and picks an exit code. That was fine while the only reader was a
 * person watching the run. It stops being fine the moment something automated
 * wants to know what happened, because the only channel out of those five
 * lines is prose on stdout and a single bit of exit code.
 *
 * What is added here is a second channel, not a different one. The words on
 * the terminal are byte for byte what they always were — that format is good,
 * and a person reading a failing run should not have to learn a new one. Set
 * `OMARCHY_TEST_JSON` to a path and the same run also writes down what it did
 * in a form something can read back:
 *
 * ```json
 * { "suite": "roundtrip", "status": "failed", "passed": 11, "failed": 1,
 *   "checks": [ { "name": "...", "ok": false, "detail": "..." } ] }
 * ```
 *
 * Three states, not two. A suite that ran and failed a check and a suite that
 * threw on its fourth line are both "not passing" to an exit code, and they
 * are completely different bugs — the first found something, the second found
 * nothing and never got the chance. `crashed` is its own status, and it
 * carries the checks that did run before the throw, which is usually where the
 * answer is.
 *
 * Suites written against this import `check` and `done`. Suites that have not
 * been moved over are not broken by it and do not need to be: `tools/run-tests`
 * reads their stdout instead, and gets everything but the crash distinction.
 */
import fs from 'node:fs'
import path from 'node:path'

const started = Date.now()
const checks = []

/** The name this suite goes by in a report, taken from its own filename. */
const suite = path.basename(process.argv[1] || 'unknown').replace(/\.mjs$/, '')

/**
 * One assertion, said out loud.
 *
 * The signature and the printed line are the ones every existing suite already
 * uses, so moving a suite over is deleting its local copy and adding an
 * import — never rewriting what it checks or how it reads.
 */
export function check(name, ok, detail = '') {
  checks.push({ name, ok: Boolean(ok), detail: String(detail ?? '') })
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`)
}

/**
 * The end of a run: the summary line, the machine-readable record, the exit
 * code. `label` is what the suite calls its checks in that last line, the way
 * `locate` calls them "find-my-phone checks".
 */
export function done(label = `${suite} checks`) {
  const failed = checks.filter((c) => !c.ok)
  console.log(`\n${checks.length - failed.length}/${checks.length} ${label} passed`)
  write(failed.length ? 'failed' : 'passed', null)
  process.exit(failed.length ? 1 : 0)
}

/**
 * A suite that threw is a suite whose remaining checks never ran, and saying
 * so is worth more than the stack alone — the stack says where it stopped, and
 * the record says what it had established up to there.
 *
 * Registered rather than left to the default handler so that the JSON is
 * written even on the paths nobody planned for. Node prints the error itself
 * on the way out, so this does not reprint it.
 */
function crashed(error) {
  write('crashed', error)
  console.error(`\n${checks.filter((c) => c.ok).length}/${checks.length} ${suite} checks passed before it threw`)
  console.error(error?.stack || String(error))
  process.exit(1)
}

process.on('uncaughtException', crashed)
process.on('unhandledRejection', crashed)

/**
 * Writes the record, if anybody asked for one.
 *
 * Failing to write it must never change the outcome of the run: a report is
 * for whoever reads the run afterwards, and a suite that passed and could not
 * say so in JSON still passed.
 */
function write(status, error) {
  const target = process.env.OMARCHY_TEST_JSON
  if (!target) return
  const passed = checks.filter((c) => c.ok).length
  const record = {
    suite,
    file: process.argv[1] || null,
    status,
    total: checks.length,
    passed,
    failed: checks.length - passed,
    durationMs: Date.now() - started,
    error: error ? { name: error.name || 'Error', message: String(error.message || error) } : null,
    checks,
  }
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, `${JSON.stringify(record, null, 2)}\n`)
  } catch {
    /* a report nobody can write is not worth failing a passing run over */
  }
}
