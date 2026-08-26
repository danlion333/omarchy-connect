// The desktop naming a phone the phone could not name itself: what counts as a
// generic label, what a hostname looks like once it is fit to show, and what
// the resolver is allowed to be asked.
import { isGeneric, prettyHostname, nameFromNetwork } from '../src/lib/hostname.js'

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`)
}

/* ── which names are nobody's ───────────────────────────────────────────── */

check('the app\'s Android fallback is generic', isGeneric('Android phone'))
check('so is its iOS one', isGeneric('iPhone'))
check('case and padding do not save it', isGeneric('  ANDROID PHONE '))
check('an empty name is generic too', isGeneric('') && isGeneric(null))
check('a real name is not', !isGeneric('OnePlus 9 Pro 5G') && !isGeneric("Оксанин Pixel"))

/* ── hostnames worth showing ────────────────────────────────────────────── */

check('a DHCP hostname reads as a name', prettyHostname('OnePlus-9-Pro-5G') === 'OnePlus 9 Pro 5G',
  prettyHostname('OnePlus-9-Pro-5G'))
check('the search domain is dropped', prettyHostname('Pixel-8.lan') === 'Pixel 8', prettyHostname('Pixel-8.lan'))
check('underscores are separators as well', prettyHostname('Galaxy_S23') === 'Galaxy S23')
check("Android's own mDNS name is not a name", prettyHostname('Android_T9UWKJ01.local') === null)
check('nor is the older android-<hex>', prettyHostname('android-3f2ac91b') === null)
check('an address echoed back is refused', prettyHostname('192.168.1.25') === null)
check('a serial is refused', prettyHostname('a1b2c3d4e5f6') === null)
check('and so is a hostname that is itself generic', prettyHostname('phone') === null)

/* ── what the resolver is asked ─────────────────────────────────────────── */

const asked = []
const reverse = async (ip) => {
  asked.push(ip)
  return ['OnePlus-9-Pro-5G']
}

check('the phone gets the network\'s name', (await nameFromNetwork('192.168.1.25', { reverse })) === 'OnePlus 9 Pro 5G')
check('an IPv4-mapped address is unwrapped first', asked.includes('192.168.1.25') &&
  (await nameFromNetwork('::ffff:192.168.1.25', { reverse })) === 'OnePlus 9 Pro 5G')
check('loopback is never asked about', (await nameFromNetwork('127.0.0.1', { reverse })) === null &&
  !asked.includes('127.0.0.1'))
check('a resolver with no answer is not an error',
  (await nameFromNetwork('192.168.1.25', { reverse: async () => { throw new Error('ENOTFOUND') } })) === null)
check('nor is one that never answers',
  (await nameFromNetwork('192.168.1.25', { reverse: () => new Promise(() => {}), timeout: 50 })) === null)
check('junk from the resolver is stepped over',
  (await nameFromNetwork('192.168.1.25', { reverse: async () => ['android-3f2ac91b', 'Pixel-8'] })) === 'Pixel 8')

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} hostname checks passed`)
process.exit(failed.length ? 1 : 0)
