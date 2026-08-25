import fs from 'node:fs'
import { execFileSync } from 'node:child_process'
import { has } from './exec.js'

/**
 * Omarchy ships ufw enabled with a DROP input policy, so a freshly installed
 * daemon listens on a port nothing can reach and the phone just times out —
 * with no clue on either side about why. Checking for that at startup turns a
 * baffling failure into one line of advice.
 *
 * Everything here reads state that does not need root: `user.rules` is
 * world-readable and `systemctl is-active` needs no privileges. Nothing is
 * ever changed — opening a port is the user's call, not ours.
 */

const RULES_FILE = '/etc/ufw/user.rules'

function ufwActive() {
  if (!has('ufw')) return false
  try {
    return execFileSync('systemctl', ['is-active', 'ufw'], { encoding: 'utf8', timeout: 3000 }).trim() === 'active'
  } catch {
    // `is-active` exits non-zero for anything but "active", which is an
    // answer, not an error.
    return false
  }
}

function ufwAllows(port) {
  try {
    const rules = fs.readFileSync(RULES_FILE, 'utf8')
    return new RegExp(`--dport ${port}(\\s|$)`, 'm').test(rules)
  } catch {
    // Unreadable rules mean we cannot tell; better to stay quiet than to
    // nag about a port that is in fact open.
    return true
  }
}

/**
 * Reports whether a local firewall is likely to be swallowing connections to
 * `port`, and how to let them through. `subnet` scopes the suggested rule to
 * the network the daemon is actually reachable on.
 */
export function check(port, ip) {
  if (!ufwActive()) return { blocked: false, tool: null, command: null }
  if (ufwAllows(port)) return { blocked: false, tool: 'ufw', command: null }
  const subnet = lanSubnet(ip)
  const from = subnet ? `from ${subnet} ` : ''
  return {
    blocked: true,
    tool: 'ufw',
    command: `sudo ufw allow ${from}to any port ${port} proto tcp comment 'omarchy-connect'`,
  }
}

/** `192.168.1.100` → `192.168.1.0/24`, so the rule stays on the local network. */
export function lanSubnet(ip) {
  if (typeof ip !== 'string') return null
  const parts = ip.split('.')
  if (parts.length !== 4 || parts.some((p) => !/^\d{1,3}$/.test(p))) return null
  return `${parts[0]}.${parts[1]}.${parts[2]}.0/24`
}
