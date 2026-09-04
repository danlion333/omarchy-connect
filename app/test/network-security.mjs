/**
 * What the Android build is told about cleartext and about whom to trust.
 *
 * `plugins/withDesktopCa.js` writes one file, `network_security_config.xml`,
 * and everything about whether a build can talk to a desktop at all is decided
 * in it. Two things went wrong there at once and neither showed up in a build
 * log: with a certificate present the config permitted cleartext to *every*
 * host and made the desktop's self-signed key an anchor for *every* TLS
 * connection the app makes; with no certificate the file was not written at
 * all, so a release build of a fresh clone inherited the platform default —
 * no cleartext — and could not reach a plain-HTTP daemon to pair with.
 *
 * A gradle build is perfectly happy in both cases, which is why this is a
 * suite rather than something to notice later. It reads both branches of the
 * plugin: the one that has been told which desktop it belongs to, and the one
 * that has not.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { check, done } from '../../tools/test-harness.mjs'
import plugin from '../plugins/withDesktopCa.js'

const { networkSecurityConfig, writeSecurityConfig, subjectNamesOf } = plugin

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omarchy-nsc-'))

/** A certificate shaped like the one `omarchy-connect tls trust` exports. */
function mint(sans) {
  const key = path.join(dir, `k-${Math.random().toString(36).slice(2)}.pem`)
  const cert = `${key}.crt`
  const args = [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2',
    '-keyout', key, '-out', cert, '-subj', '/CN=omarchy-connect',
  ]
  if (sans) args.push('-addext', `subjectAltName=${sans}`)
  execFileSync('openssl', args, { stdio: 'ignore' })
  return fs.readFileSync(cert, 'utf8')
}

const pem = mint('DNS:localhost,DNS:workstation,IP:127.0.0.1,IP:192.168.1.40')

/* ── the names come out of the certificate, not out of a guess ─────── */

const names = subjectNamesOf(pem)
check('every subject name is read back', ['127.0.0.1', '192.168.1.40', 'localhost', 'workstation'].every((n) => names.includes(n)), names.join(' '))

/* ── with a certificate: narrow ────────────────────────────────────── */

const scoped = networkSecurityConfig(pem)
check('base-config forbids cleartext', /<base-config cleartextTrafficPermitted="false">/.test(scoped))
const base = scoped.slice(scoped.indexOf('<base-config'), scoped.indexOf('</base-config>'))
check('the desktop key is not an app-wide anchor', !base.includes('@raw/desktop_ca'), base.trim())
const domain = scoped.slice(scoped.indexOf('<domain-config'), scoped.indexOf('</domain-config>'))
check('the desktop key is an anchor for the desktop', domain.includes('@raw/desktop_ca'))
check('cleartext is permitted to the desktop', /<domain-config cleartextTrafficPermitted="true">/.test(scoped))
check('the system anchors are kept', domain.includes('src="system"'))
for (const name of names) check(`${name} is in the domain-config`, domain.includes(`>${name}<`))

/* ── without a certificate: wide, but present ──────────────────────── */

const plain = networkSecurityConfig(null)
check('a build with no certificate still permits cleartext', /<base-config cleartextTrafficPermitted="true">/.test(plain))
check('and adds no trust anchor of its own', !plain.includes('@raw/desktop_ca'))

/* ── a certificate Android could never verify is a build failure ───── */

let threw = ''
try {
  networkSecurityConfig(mint(null))
} catch (e) {
  threw = String(e.message)
}
check('a certificate with no subjectAltName stops the build', threw.includes('tls trust'), threw)

/* ── both branches actually put the files on disk ──────────────────── */

const withCert = path.join(dir, 'res-with')
const outScoped = writeSecurityConfig(pem, withCert)
check('the config is written', fs.readFileSync(path.join(withCert, 'xml', 'network_security_config.xml'), 'utf8') === scoped)
check('the certificate is written next to it', fs.readFileSync(path.join(withCert, 'raw', 'desktop_ca.pem'), 'utf8') === pem)
check('and the prebuild says which desktop it trusts', outScoped.scoped && outScoped.names.length === 4)

const without = path.join(dir, 'res-without')
writeSecurityConfig(null, without)
check('a config is written with no certificate too', fs.existsSync(path.join(without, 'xml', 'network_security_config.xml')))
check('and no raw certificate is left behind', !fs.existsSync(path.join(without, 'raw', 'desktop_ca.pem')))

fs.rmSync(dir, { recursive: true, force: true })
done()
