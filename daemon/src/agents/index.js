import claude from './claude.js'

/**
 * The coding agents this desktop knows how to read.
 *
 * The list lives here rather than in the plugin because two other places ask
 * the same question without wanting the plugin's machinery: the status file,
 * which says whether there is anything to offer a switch for, and the CLI,
 * which answers `agent status` with the daemon stopped.
 */
export const ADAPTERS = [claude]

/** Which of them is actually installed, daemon or no daemon. */
export function detected() {
  return ADAPTERS.filter((a) => a.detect()).map((a) => a.id)
}
