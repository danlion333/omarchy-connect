import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * How much of the plan is left, read from the CLI's own cache.
 *
 * Claude Code asks the account service what a session has used and writes the
 * answer into `~/.claude.json` under `cachedUsageUtilization`. That file is
 * the only place on this desktop the number exists, and reading it is the
 * whole of this module: nothing here talks to a network, holds a credential,
 * or asks a question the CLI has not already asked on its own behalf.
 *
 * Which matters because a limit is the one number that changes what you do
 * next. An agent that is going to stop in twenty minutes because the five-hour
 * window ran out is worth knowing about *before* you send it off on something
 * long, and from a phone that is the difference between waiting for a result
 * and finding out an hour later that nothing happened.
 *
 * The cache is refreshed by the CLI, not by us, so a desktop whose CLI has not
 * run today reports numbers with a date on them. The freshness travels with
 * the answer rather than being hidden — a stale limit presented as current is
 * worse than one that says how old it is.
 */

const FILE = path.join(os.homedir(), '.claude.json')

/** Past this the number is history rather than status. */
const STALE_MS = 6 * 60 * 60 * 1000

/**
 * What each window is called on a phone screen.
 *
 * The service's own names are internal — `weekly_all`, `weekly_scoped` — and
 * several of the keys beside them are colour words for limits this account
 * does not have. Only the ones with a name here are shown, which is also what
 * keeps a new experimental bucket from appearing on the phone as a row nobody
 * can read.
 */
const LABELS = {
  session: 'session',
  five_hour: 'session',
  weekly_all: 'week',
  weekly_scoped: 'week',
  seven_day: 'week',
  weekly_opus: 'week · Opus',
  monthly_all: 'month',
}

const cache = { at: 0, value: null }

const percent = (value) => {
  const n = Number(value)
  return Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : null
}

const resetAt = (value) => {
  const at = Date.parse(String(value || ''))
  return Number.isFinite(at) ? at : null
}

/**
 * One row per limit that actually applies, worst first.
 *
 * The service sends a `limits` array with a label, a percentage and a reset
 * time on each entry, and separately a handful of older top-level windows
 * saying the same thing. The array is preferred where it exists — it is the
 * one that knows about scopes, so it can say *which* model's weekly allowance
 * is the one at seventy percent — and the old fields are the fallback for a
 * CLI too old to have written it.
 */
function rowsFrom(utilization) {
  const rows = []
  const seen = new Set()

  for (const limit of Array.isArray(utilization?.limits) ? utilization.limits : []) {
    const label = LABELS[limit?.kind] || LABELS[limit?.group]
    if (!label) continue
    const used = percent(limit.percent)
    if (used === null) continue
    // A scoped weekly limit is the same window seen through one model, and the
    // model's name is the only thing that tells the two rows apart.
    const scope = limit.scope?.model?.display_name || limit.scope?.surface || null
    const name = scope ? `${label} · ${scope}` : label
    if (seen.has(name)) continue
    seen.add(name)
    rows.push({
      kind: String(limit.kind || limit.group || 'limit'),
      label: name,
      percent: used,
      resetsAt: resetAt(limit.resets_at),
      severity: String(limit.severity || 'normal'),
      // Which window the CLI says you are actually spending against now.
      active: limit.is_active === true,
    })
  }

  if (!rows.length) {
    for (const key of ['five_hour', 'seven_day']) {
      const window = utilization?.[key]
      const used = percent(window?.utilization)
      if (used === null) continue
      rows.push({
        kind: key,
        label: LABELS[key],
        percent: used,
        resetsAt: resetAt(window.resets_at),
        severity: used >= 90 ? 'critical' : used >= 75 ? 'warning' : 'normal',
        active: false,
      })
    }
  }

  return rows.sort((a, b) => b.percent - a.percent)
}

/** Extra usage, when the account has any and it is switched on. */
function spendFrom(utilization) {
  const spend = utilization?.spend
  if (!spend || spend.enabled !== true) return null
  const money = (amount) =>
    amount && Number.isFinite(Number(amount.amount_minor))
      ? Number(amount.amount_minor) / 10 ** (Number(amount.exponent) || 2)
      : null
  const used = money(spend.used)
  const limit = money(spend.limit)
  if (used === null && limit === null) return null
  return { used, limit, currency: spend.used?.currency || spend.limit?.currency || 'USD', percent: percent(spend.percent) }
}

/**
 * The limits as they stand, or `null` when this desktop has never been told.
 *
 * Cached against the file's mtime: this is asked on every session list, and
 * the file behind it is rewritten by the CLI a few times an hour.
 */
export function read() {
  let stat
  try {
    stat = fs.statSync(FILE)
  } catch {
    return null
  }
  if (cache.at === stat.mtimeMs) return cache.value

  let utilization = null
  let fetchedAt = 0
  try {
    const config = JSON.parse(fs.readFileSync(FILE, 'utf8'))
    utilization = config?.cachedUsageUtilization?.utilization || null
    fetchedAt = Number(config?.cachedUsageUtilization?.fetchedAtMs) || 0
  } catch {
    // A half-written config is a config we do not have. Next mtime, next try.
    cache.at = 0
    cache.value = null
    return null
  }

  const rows = utilization ? rowsFrom(utilization) : []
  const value = rows.length
    ? {
        fetchedAt,
        stale: fetchedAt > 0 && Date.now() - fetchedAt > STALE_MS,
        limits: rows,
        spend: spendFrom(utilization),
      }
    : null

  cache.at = stat.mtimeMs
  cache.value = value
  return value
}

/** The one number worth a badge: the tightest window, however it is spelled. */
export function worst() {
  const value = read()
  return value?.limits?.[0] ?? null
}
