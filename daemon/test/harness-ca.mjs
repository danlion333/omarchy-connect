/**
 * Whether a fresh worktree gets this desktop's certificate.
 *
 * `omarchy-connect tls trust` writes `app/assets/desktop-ca.pem`, and
 * `app/.gitignore` keeps it out of git deliberately — it is one machine's
 * certificate, not the project's. The consequence is that a worktree cut from
 * master has no such file, and `plugins/withDesktopCa.js` looks for it under
 * the project root it is prebuilding. Missing, it takes the branch that
 * declares no trust anchor and allows cleartext to everything, and the APK
 * built there cannot verify the desktop it dials. Nothing in that failure
 * points at a missing 733-byte file: it reads as a broken network, which is
 * what made #58 and #57 each burn a verification on it.
 *
 * So `common.sh` copies the certificate into every worktree it opens, and this
 * is that copy under test — the shell function itself, run for real, because
 * the bug was never in what the copy does but in it not happening at all.
 * Both outcomes matter: a checkout that has the certificate hands over a
 * byte-identical one, and a checkout that has never run `tls trust` says so
 * and still succeeds, since a desktop without a certificate yet is not a
 * broken harness.
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { check, done } from '../../tools/test-harness.mjs'

const repo = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))))
const common = path.join(repo, '.claude', 'skills', 'issue', 'scripts', 'common.sh')

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omarchy-connect-harness-ca-'))
process.on('exit', () => fs.rmSync(root, { recursive: true, force: true }))

/** A pair of empty checkouts — one standing in for the repository, one for the worktree. */
let serial = 0
const pair = (pem) => {
  const dir = path.join(root, `case${serial++}`)
  fs.mkdirSync(path.join(dir, 'from', 'app', 'assets'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'to'), { recursive: true })
  if (pem !== null) fs.writeFileSync(path.join(dir, 'from', 'app', 'assets', 'desktop-ca.pem'), pem)
  return { from: path.join(dir, 'from'), to: path.join(dir, 'to') }
}

/** Run the copy the way `start.sh` runs it: sourced out of `common.sh`. */
const copy = ({ from, to }) =>
  spawnSync('bash', ['-c', `source ${JSON.stringify(common)}; copy_desktop_ca ${JSON.stringify(from)} ${JSON.stringify(to)}`], {
    encoding: 'utf8',
  })

const CERT = '-----BEGIN CERTIFICATE-----\nnot a real one, but a byte sequence\n-----END CERTIFICATE-----\n'

{
  const dirs = pair(CERT)
  const run = copy(dirs)
  const landed = path.join(dirs.to, 'app', 'assets', 'desktop-ca.pem')
  check('a worktree gets the certificate', run.status === 0 && fs.existsSync(landed), `exit ${run.status}`)
  check(
    'byte for byte the one the desktop trusts',
    fs.existsSync(landed) && fs.readFileSync(landed, 'utf8') === CERT,
    'cmp would be silent',
  )
  check('and says it did', /desktop-ca\.pem/.test(run.stdout), run.stdout.trim())
}

{
  // The nested assets/ directory is the part a plain `cp` would get wrong: a
  // worktree from master has app/assets, but nothing guarantees the path
  // exists in whatever tree the copy is pointed at.
  const dirs = pair(CERT)
  fs.rmSync(path.join(dirs.to, 'app'), { recursive: true, force: true })
  const run = copy(dirs)
  check(
    'into a worktree with no app/assets yet',
    run.status === 0 && fs.existsSync(path.join(dirs.to, 'app', 'assets', 'desktop-ca.pem')),
    `exit ${run.status}`,
  )
}

{
  const dirs = pair(null)
  const run = copy(dirs)
  check('a checkout that never ran tls trust is not an error', run.status === 0, `exit ${run.status}`)
  check('but the run says the certificate is missing', /tls trust/.test(run.stdout), run.stdout.trim())
  check('and nothing is invented in its place', !fs.existsSync(path.join(dirs.to, 'app', 'assets', 'desktop-ca.pem')))
}

{
  // The class gate is the bug: `app/android` is copied only for `harness:apk`,
  // and the certificate must not sit behind that same condition.
  const start = fs.readFileSync(path.join(repo, '.claude', 'skills', 'issue', 'scripts', 'start.sh'), 'utf8')
  const call = start.split('\n').findIndex((line) => /^\s*copy_desktop_ca /.test(line))
  const gated = start
    .split('\n')
    .slice(0, call)
    .join('\n')
    .lastIndexOf('if [ "$class" = apk ]')
  const closed = start.split('\n').slice(0, call).join('\n').lastIndexOf('\nfi')
  check('start.sh copies it', call >= 0)
  check('outside the apk-only branch', call >= 0 && (gated < 0 || closed > gated))
}

done('worktree certificate checks')
