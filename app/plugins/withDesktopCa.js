const crypto = require('node:crypto')
const fs = require('fs')
const path = require('path')
const { withAndroidManifest, withDangerousMod, AndroidConfig } = require('expo/config-plugins')

/**
 * Writes the app's network security config, and teaches the build to trust
 * one desktop's TLS certificate when there is one to trust.
 *
 * Android's default since targetSdk 28 is that cleartext is forbidden and only
 * the system's certificate authorities are trusted. Both halves of that are
 * wrong for this app, and in opposite directions, so this plugin always emits
 * a `network_security_config.xml` and always names it in the manifest — the
 * two branches below differ in what that file says, never in whether it
 * exists. It used to be written only when a certificate was lying around,
 * which meant a release build of a fresh clone had no config at all and could
 * not even reach a plain-HTTP daemon to pair with: the platform default cut
 * the connection with nothing in the log to act on.
 *
 * **Without `assets/desktop-ca.pem`.** The daemon speaks plain HTTP unless
 * somebody turned TLS on, so cleartext has to be permitted, and there is no
 * way to say *to whom*: the desktop is a DHCP lease, and a network security
 * config can name domains but not subnets. So this branch permits cleartext
 * app-wide and adds no trust anchor of its own. That is the honest cost of
 * shipping a build that has never been told which desktop it belongs to.
 *
 * **With `assets/desktop-ca.pem`.** Now there is a key to trust, so both
 * permissions can be narrowed away from "every host in the world". The base
 * config, which covers every host the app reaches by name, forbids cleartext
 * and trusts only the system anchors. A single `domain-config` is where the
 * desktop's key becomes a trust anchor and where cleartext stays allowed, so
 * that a desktop with TLS off still pairs. Before this the desktop's key sat
 * in the base config, which made a `CA:TRUE` key minted on somebody's laptop
 * an anchor for every TLS connection the app makes — it could sign a
 * certificate for any name on the internet and this app would believe it.
 *
 * **What that `domain-config` may name, and why it is not the certificate's
 * own SANs.** The obvious list — the names read out of `assets/desktop-ca.pem`
 * — is a snapshot taken by `omarchy-connect tls trust` at build time, while
 * the daemon re-mints its certificate over the *same key* whenever the machine
 * gains an address (a new DHCP lease, a tunnel coming up; `tls.js`
 * `staleReason`). The phone dials whichever address the desktop announced,
 * literally, and Android matches `<domain>` against that string — so the first
 * address the desktop acquired after the snapshot fell through to the base
 * config, where the desktop's key is not an anchor, and the handshake died
 * before `hello` with nothing in either log. A Tailscale address is the
 * everyday case: it is exactly the one that appears after somebody has already
 * built their APK, and the tailnet is the one road where the phone has no
 * other way home.
 *
 * So the `domain-config` names every IPv4 literal instead. It can: Android
 * matches a `<domain>` either exactly or, with `includeSubdomains`, as a
 * dot-preceded suffix of the hostname, and every dotted-quad ends in `.` plus
 * a number between 0 and 255 — so 256 numeric entries cover all of IPv4 and
 * nothing else, because no real hostname ends in a numeric label. That is the
 * scope this app actually uses: the desktop is reached by address, everything
 * else it talks to is reached by name. The certificate's own names go in as
 * well, for `localhost` (the address an `adb reverse` tunnel arrives on) and
 * for the desktop's hostname.
 *
 * The key stays a `CA:TRUE` anchor, so this does hand it authority over any
 * host dialled by bare IPv4 — but that set is the desktop, and the phone has
 * pinned which desktop at pairing time anyway. Compared with the base config
 * it cannot touch a single host reached by name.
 *
 * Run `omarchy-connect tls trust` on the desktop to drop its certificate into
 * `assets/desktop-ca.pem`, then rebuild. A changed address no longer needs a
 * rebuild — only a changed *key* does, and the daemon reuses its key on
 * purpose (`tls rotate` is the one command that does not).
 */

const PEM = 'desktop-ca.pem'
const RAW_NAME = 'desktop_ca.pem'
const XML_NAME = 'network_security_config.xml'
const RESOURCE = '@xml/network_security_config'

/**
 * Every last label an IPv4 literal can have. With `includeSubdomains` each one
 * matches the whole of the address space ending in it, so together they are
 * "any dotted-quad" — the closest a network security config comes to saying
 * "the desktop, wherever it turned out to be today".
 */
const LAST_OCTETS = Array.from({ length: 256 }, (_, n) => String(n))

/** Does this name look like an address rather than a hostname? */
const isAddress = (name) => /^\d+(\.\d+)*$/.test(name)

const HEADER = `<?xml version="1.0" encoding="utf-8"?>
<!-- Generated by plugins/withDesktopCa.js — do not edit by hand. -->`

/** Where `omarchy-connect tls trust` puts the certificate, if it ever ran. */
const certificateFor = (config) => path.join(config.modRequest?.projectRoot ?? process.cwd(), 'assets', PEM)

/**
 * Every host the certificate says it is good for, as a network security
 * config can spell them.
 *
 * Android matches a `<domain>` against the hostname the connection was opened
 * with, as a string, so an IPv4 literal out of the SANs works there exactly as
 * a name does — and an address is in fact what the phone dials, since that is
 * what the pairing QR carries. `127.0.0.1` is worth keeping for the same
 * reason it is in the certificate: it is the address an `adb reverse` tunnel
 * arrives on.
 */
function subjectNamesOf(pem) {
  const cert = new crypto.X509Certificate(pem)
  const names = (cert.subjectAltName || '')
    .split(',')
    .map((entry) => entry.trim().replace(/^(DNS|IP Address|IP):/, ''))
    .filter((entry) => entry && /^[A-Za-z0-9.\-_]+$/.test(entry))
  return [...new Set(names)].sort()
}

/**
 * The config file itself. `pem` is the certificate's text, or null when this
 * build has never been told which desktop it belongs to.
 */
function networkSecurityConfig(pem) {
  if (!pem) {
    return `${HEADER}
<network-security-config>
  <!-- No assets/desktop-ca.pem at build time: the desktop is unknown, so
       cleartext cannot be narrowed to it. Run \`omarchy-connect tls trust\`
       and rebuild to trade this for the narrow config. -->
  <base-config cleartextTrafficPermitted="true">
    <trust-anchors>
      <certificates src="system" />
    </trust-anchors>
  </base-config>
</network-security-config>
`
  }
  const names = subjectNamesOf(pem)
  if (!names.length) {
    throw new Error(
      `assets/${PEM} names no hosts (no subjectAltName), so nothing can be scoped to it — ` +
        're-run `omarchy-connect tls trust` on the desktop to write a usable certificate.',
    )
  }
  const domains = [
    // Anything the certificate names that is not already an address: the
    // hostname, and `localhost` for the `adb reverse` tunnel.
    ...names.filter((name) => !isAddress(name)).map((name) => `    <domain includeSubdomains="false">${name}</domain>`),
    ...LAST_OCTETS.map((n) => `    <domain includeSubdomains="true">${n}</domain>`),
  ].join('\n')
  return `${HEADER}
<network-security-config>
  <base-config cleartextTrafficPermitted="false">
    <trust-anchors>
      <certificates src="system" />
    </trust-anchors>
  </base-config>
  <!-- The desktop this build was made for: its self-signed key is an anchor
       here and nowhere else, and cleartext is permitted here because the
       daemon speaks plain HTTP until TLS is switched on. The numeric entries
       are every possible last label of an IPv4 literal, which is how a host
       the certificate copy never heard of — the tailnet address the desktop
       grew after this build — is still trusted. Names the app reaches by
       name are unaffected: they live under the base config above. -->
  <domain-config cleartextTrafficPermitted="true">
${domains}
    <trust-anchors>
      <certificates src="system" />
      <certificates src="@raw/desktop_ca" />
    </trust-anchors>
  </domain-config>
</network-security-config>
`
}

/**
 * What the config we just wrote says about one host, the way Android reads it.
 *
 * Android picks the `domain-config` whose `<domain>` matches the hostname the
 * connection was opened with — exactly, or as a dot-preceded suffix when
 * `includeSubdomains` is set — and falls back to the `base-config` when none
 * does. Re-stating those few rules here is what lets a test ask the question
 * that actually matters ("is the desktop trusted at an address the build never
 * heard of?") instead of matching XML by eye.
 */
function configFor(xml, host) {
  const section = (open, close) => {
    const from = xml.indexOf(open)
    return from === -1 ? null : xml.slice(from, xml.indexOf(close, from))
  }
  const base = section('<base-config', '</base-config>')
  const scoped = section('<domain-config', '</domain-config>')
  const matches =
    scoped &&
    [...scoped.matchAll(/<domain includeSubdomains="(true|false)">([^<]+)<\/domain>/g)].some(
      ([, sub, domain]) => host === domain || (sub === 'true' && host.endsWith(`.${domain}`)),
    )
  const chosen = matches ? scoped : base
  return {
    scoped: Boolean(matches),
    trustsDesktop: chosen.includes('@raw/desktop_ca'),
    cleartext: /cleartextTrafficPermitted="true"/.test(chosen),
  }
}

/**
 * Puts the config, and the certificate it may refer to, into `res/`. Returns
 * what it decided, which is the one line the prebuild prints about all this.
 */
function writeSecurityConfig(pem, resDir) {
  const raw = path.join(resDir, 'raw')
  const xml = path.join(resDir, 'xml')
  fs.mkdirSync(xml, { recursive: true })
  const contents = networkSecurityConfig(pem)
  fs.writeFileSync(path.join(xml, XML_NAME), contents)
  if (pem) {
    fs.mkdirSync(raw, { recursive: true })
    fs.writeFileSync(path.join(raw, RAW_NAME), pem)
  }
  return { scoped: Boolean(pem), names: pem ? subjectNamesOf(pem) : [] }
}

const withCertificateFiles = (config) =>
  withDangerousMod(config, [
    'android',
    (cfg) => {
      const source = certificateFor(cfg)
      const pem = fs.existsSync(source) ? fs.readFileSync(source, 'utf8') : null
      const res = path.join(cfg.modRequest.platformProjectRoot, 'app', 'src', 'main', 'res')
      const out = writeSecurityConfig(pem, res)
      console.log(
        out.scoped
          ? `withDesktopCa: trusting the desktop key (${out.names.join(', ')} and any IPv4 address), cleartext limited to those`
          : `withDesktopCa: no assets/${PEM}, so cleartext stays app-wide (run \`omarchy-connect tls trust\`)`,
      )
      return cfg
    },
  ])

const withManifestEntry = (config) =>
  withAndroidManifest(config, (cfg) => {
    const application = AndroidConfig.Manifest.getMainApplicationOrThrow(cfg.modResults)
    application.$['android:networkSecurityConfig'] = RESOURCE
    return cfg
  })

module.exports = (config) => withManifestEntry(withCertificateFiles(config))
module.exports.networkSecurityConfig = networkSecurityConfig
module.exports.writeSecurityConfig = writeSecurityConfig
module.exports.subjectNamesOf = subjectNamesOf
module.exports.configFor = configFor
