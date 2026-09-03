/**
 * Runs every test suite in the repository, and — this is the whole point —
 * does not stop at the first one that fails.
 *
 * `npm test` was a chain of `node test/a.mjs && node test/b.mjs && …`, which
 * for a person at a terminal is fine: you fix the first failure and run it
 * again. For anything trying to form a picture of the repository's health it
 * is close to useless, because `&&` throws away everything after the first
 * broken thing. Fourteen suites and one bug means one suite's worth of news
 * and thirteen unknowns, and no way to tell an unknown from a pass.
 *
 * So this runs all of them, always, and reports on all of them. A run says
 * what is broken, not what broke first.
 *
 * Two kinds of suite, and neither has to know about the other. A suite written
 * against `tools/test-harness` writes its own record to `OMARCHY_TEST_JSON`
 * and gets the full account — every check by name, and the difference between
 * failing and throwing. A suite that predates the harness is read the way a
 * person reads it, off its stdout, whose `  ok  ` and ` FAIL ` prefixes have
 * always been a machine format that nobody had asked to parse yet. Both end up
 * in the same report; the older ones simply cannot say "crashed".
 *
 * Sequentially, on purpose. These suites spawn real daemons that bind real
 * ports, and running them at once would turn a port collision into a flake —
 * the one failure mode that makes an automated reader trust a green run less
 * rather than more.
 *
 * ```
 * node tools/run-tests.mjs                # everything
 * node tools/run-tests.mjs daemon         # one package
 * node tools/run-tests.mjs locate calls   # named suites
 * node tools/run-tests.mjs --list         # what would run, running nothing
 * node tools/run-tests.mjs --report out.json
 * ```
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

/** Where the suites live, and what to call the group in the summary. */
const PACKAGES = [
  { name: 'daemon', dir: path.join(root, 'daemon', 'test') },
  { name: 'app', dir: path.join(root, 'app', 'test') },
]

const argv = process.argv.slice(2)
const reportAt = takeFlag('--report') ?? path.join(root, 'test-report.json')
const filters = argv.filter((a) => !a.startsWith('-'))

/**
 * Every suite, in the order they should run.
 *
 * A file that exports something is a helper — `phone.mjs` is the other half of
 * the encrypted channel, `sandbox.mjs` keeps a test off the machine's real
 * Bluetooth — and running one as a suite would report zero checks and pass.
 * Asking the file whether it exports is what keeps this list correct when
 * somebody adds the next helper without reading this comment.
 */
function discover() {
  const found = []
  for (const pkg of PACKAGES) {
    if (!fs.existsSync(pkg.dir)) continue
    for (const file of fs.readdirSync(pkg.dir).sort()) {
      if (!file.endsWith('.mjs')) continue
      const full = path.join(pkg.dir, file)
      if (/^export /m.test(fs.readFileSync(full, 'utf8'))) continue
      const name = file.replace(/\.mjs$/, '')
      if (filters.length && !filters.includes(name) && !filters.includes(pkg.name)) continue
      found.push({ package: pkg.name, suite: name, file: full })
    }
  }
  return found
}

/**
 * One suite, run to completion.
 *
 * The child's output goes to this process's own stdout as it arrives *and* is
 * kept for parsing, because a run nobody can watch is a poor trade for a run
 * something can read. `spawnSync` with `pipe` gives the second and not the
 * first, so the output is echoed after the fact — the ordering is intact, only
 * the liveness is lost, and these suites are seconds long.
 */
function run(entry) {
  const jsonAt = path.join(os.tmpdir(), `omarchy-test-${process.pid}-${entry.suite}.json`)
  fs.rmSync(jsonAt, { force: true })

  const started = Date.now()
  const child = spawnSync(process.execPath, [entry.file], {
    cwd: path.dirname(path.dirname(entry.file)),
    env: { ...process.env, OMARCHY_TEST_JSON: jsonAt, FORCE_COLOR: '0' },
    encoding: 'utf8',
    timeout: Number(process.env.OMARCHY_TEST_TIMEOUT || 300_000),
    maxBuffer: 32 * 1024 * 1024,
  })

  const stdout = child.stdout || ''
  const stderr = child.stderr || ''
  process.stdout.write(stdout)
  if (stderr.trim()) process.stderr.write(stderr)

  const record = readRecord(jsonAt) || fromOutput(stdout)
  fs.rmSync(jsonAt, { force: true })

  return {
    ...entry,
    ...record,
    durationMs: record.durationMs ?? Date.now() - started,
    exitCode: child.status,
    // A suite Node could not even start, or one the timeout killed, has no
    // checks to report and must not be mistaken for one that passed none.
    ...(child.error || child.signal
      ? { status: 'crashed', error: { name: 'Runner', message: child.error?.message || `killed by ${child.signal}` } }
      : {}),
    ...(child.status !== 0 && record.status === 'passed'
      ? { status: 'crashed', error: { name: 'Runner', message: `exited ${child.status} after passing every check` } }
      : {}),
  }
}

/** The full account, from a suite that uses the harness. */
function readRecord(at) {
  try {
    return JSON.parse(fs.readFileSync(at, 'utf8'))
  } catch {
    return null
  }
}

/**
 * The same account, reconstructed from what a suite printed.
 *
 * `  ok  name — detail` and ` FAIL name — detail` at the start of a line are
 * the format every suite here has always used. The em dash is the separator
 * the suites write; a detail that happens to contain one is split at the first,
 * which is the correct place.
 */
function fromOutput(stdout) {
  const checks = []
  for (const line of stdout.split('\n')) {
    const match = /^(  ok  | FAIL ) (.*)$/.exec(line)
    if (!match) continue
    const [name, detail = ''] = match[2].split(' — ')
    checks.push({ name: name.trim(), ok: match[1] === '  ok  ', detail: detail.trim() })
  }
  const passed = checks.filter((c) => c.ok).length
  return {
    status: checks.length && passed === checks.length ? 'passed' : 'failed',
    total: checks.length,
    passed,
    failed: checks.length - passed,
    error: null,
    checks,
  }
}

/* ── the run ────────────────────────────────────────────────────────────── */

const suites = discover()
if (!suites.length) {
  console.error(filters.length ? `no suites matched ${filters.join(', ')}` : 'no suites found')
  process.exit(1)
}

// Enumerating without running. A person uses this to check a filter caught
// what they meant; anything automating this repository uses it to find out
// what exists before deciding what to spend time on.
if (argv.includes('--list')) {
  for (const entry of suites) console.log(`${entry.package}/${entry.suite}\t${path.relative(root, entry.file)}`)
  process.exit(0)
}

/**
 * Bold, when there is somebody to see it. A CI log and a redirected file are
 * both read later and by something that did not ask for escape codes.
 */
const bold = (text) => (process.stdout.isTTY ? `\x1b[1m${text}\x1b[0m` : text)

const results = []
for (const entry of suites) {
  console.log(`\n${bold(`── ${entry.package}/${entry.suite}`)}`)
  results.push(run(entry))
}

/* ── what happened ──────────────────────────────────────────────────────── */

const totals = results.reduce(
  (sum, r) => ({
    total: sum.total + (r.total || 0),
    passed: sum.passed + (r.passed || 0),
    failed: sum.failed + (r.failed || 0),
  }),
  { total: 0, passed: 0, failed: 0 },
)
const broken = results.filter((r) => r.status !== 'passed')

console.log(`\n${bold('── summary')}`)
for (const r of results) {
  const mark = r.status === 'passed' ? '  ok  ' : r.status === 'crashed' ? ' CRASH' : ' FAIL '
  const detail = r.status === 'crashed' ? ` — ${r.error?.message || 'threw'}` : ''
  console.log(`${mark} ${r.package}/${r.suite}  ${r.passed || 0}/${r.total || 0}${detail}`)
}
console.log(
  `\n${totals.passed}/${totals.total} checks passed across ${results.length} suites` +
    (broken.length ? ` — ${broken.length} suite${broken.length === 1 ? '' : 's'} not passing` : ''),
)

// Named again at the bottom, because the reason to run everything is to read
// this list, and on a long run it is a screen away from where it happened.
if (broken.length) {
  console.log('\nnot passing:')
  for (const r of broken) {
    for (const c of (r.checks || []).filter((c) => !c.ok)) {
      console.log(`  ${r.package}/${r.suite}: ${c.name}${c.detail ? ` — ${c.detail}` : ''}`)
    }
    if (r.status === 'crashed') console.log(`  ${r.package}/${r.suite}: threw — ${r.error?.message || 'no message'}`)
  }
}

const report = {
  startedAt: new Date().toISOString(),
  status: broken.length ? 'failed' : 'passed',
  suites: results.length,
  ...totals,
  results,
}
try {
  fs.writeFileSync(reportAt, `${JSON.stringify(report, null, 2)}\n`)
  console.log(`\nreport: ${path.relative(root, reportAt)}`)
} catch (error) {
  console.error(`could not write ${reportAt}: ${error.message}`)
}

process.exit(broken.length ? 1 : 0)

/** `--report path`, removed from the arguments so it is not read as a filter. */
function takeFlag(flag) {
  const at = argv.indexOf(flag)
  if (at === -1) return null
  const value = argv[at + 1]
  argv.splice(at, 2)
  return value
}
