import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * How much of the plan is left, asked of the account service directly.
 *
 * A limit is the one number that changes what you do next. An agent that is
 * going to stop in twenty minutes because the five-hour window ran out is
 * worth knowing about *before* you send it off on something long, and from a
 * phone that is the difference between waiting for a result and finding out
 * an hour later that nothing happened. Which is exactly the number this
 * module was worst at: it read `cachedUsageUtilization` out of `~/.claude.json`,
 * a cache the CLI rewrites when it feels like it, so a per-model weekly row
 * arrived days old and had to admit it. A figure that has to apologise for
 * its age is not the figure anyone opened the screen for.
 *
 * So it asks. `api/oauth/usage` answers every window at once — the five-hour
 * session, the seven-day account window, and the scoped rows that are the
 * only place a per-model allowance appears — and it answers them as of now.
 * The credential is the one Claude Code already keeps in
 * `~/.claude/.credentials.json`, read at the moment of the request and never
 * held; the token stays on this desktop, and only the percentages travel.
 * Nothing is asked that the CLI does not ask on its own behalf every session.
 *
 * The old readings stay, demoted to what they always should have been. The
 * config cache still answers when the network does not, and the status line
 * still overlays the two unscoped windows between probes for free. Freshness
 * therefore travels per row, as before — but on a desktop that is online, the
 * rows are simply current, and nothing has an age to print.
 */

const FILE = path.join(os.homedir(), '.claude.json')

/** Where the account service answers, and what it wants to be asked with. */
const ENDPOINT = 'https://api.anthropic.com/api/oauth/usage'
const BETA = 'oauth-2025-04-20'
const PROBE_TIMEOUT_MS = 10_000

/**
 * The floor between probes. A phone pulling to refresh twice must not be two
 * requests, and the periodic probe is far slower than this anyway — this is
 * here to absorb a flurry, not to set the pace.
 */
const PROBE_MIN_MS = 15_000

/** Claude Code's own sign-in, wherever it has been told to keep it. */
const credentialsFile = () =>
  path.join(
    process.env.CLAUDE_CONFIG_DIR ? path.resolve(process.env.CLAUDE_CONFIG_DIR) : path.join(os.homedir(), '.claude'),
    '.credentials.json',
  )

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
function rowsFrom(utilization, asOf) {
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
      asOf,
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
        asOf,
      })
    }
  }

  return rows
}

/**
 * Whether a row still describes the window you are in.
 *
 * A percentage belongs to the window it was measured in, and a snapshot taken
 * before that window turned over is not a small error — it is a number for a
 * week that has ended. The desktop's cache can sit untouched for days, so this
 * happens routinely: a Friday session at 8% still reading "8%, resets now" on
 * a Monday phone, which is the one thing worse than saying nothing.
 */
const current = (row) => !(row.resetsAt && row.resetsAt <= Date.now() && row.asOf < row.resetsAt)

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
 * The numbers as the CLI's own status line just saw them.
 *
 * The cache file above is rewritten when the CLI feels like it — hours can
 * pass — and a phone deciding whether to start something long was reading
 * yesterday's percentage. The status-line bridge hands this module the
 * `rate_limits` block from every status line update, which is as fresh as the
 * account service's answer ever is on this desktop: it moves with every turn
 * of every session. Held in memory only; the file stays the CLI's.
 */
let overlay = null

/** What each status-line window is called, in the cache file's vocabulary. */
const OVERLAY_LABELS = { five_hour: 'session', seven_day: 'week' }

/**
 * Take the `rate_limits` block off a status line update. Returns whether the
 * numbers moved, so the caller knows to announce them.
 */
export function absorb(rateLimits) {
  if (!rateLimits || typeof rateLimits !== 'object') return false
  const rows = []
  for (const [kind, label] of Object.entries(OVERLAY_LABELS)) {
    const window = rateLimits[kind]
    const used = percent(window?.used_percentage)
    if (used === null) continue
    const resets = Number(window?.resets_at)
    rows.push({
      kind,
      label,
      percent: used,
      // The status line speaks unix seconds where the cache file speaks ISO.
      resetsAt: Number.isFinite(resets) && resets > 0 ? resets * 1000 : null,
      severity: used >= 90 ? 'critical' : used >= 75 ? 'warning' : 'normal',
      active: false,
      asOf: Date.now(),
    })
  }
  if (!rows.length) return false
  // The timestamp moves on every update by construction; only the numbers
  // themselves are worth waking a phone for.
  const print = JSON.stringify(rows.map((r) => [r.kind, r.percent, r.resetsAt]))
  const moved = !overlay || overlay.print !== print
  overlay = { at: Date.now(), print, rows }
  return moved
}

/**
 * The cache's answer, with the overlay's fresher numbers written over it.
 *
 * The cache still matters — it is the only one that knows about scoped
 * windows, spend, and whatever an older or newer service adds — so the
 * overlay corrects the rows it has fresher figures for and leaves the rest.
 * New objects throughout: the cached value is shared, and a merge that edits
 * it in place would poison every later read.
 */
function merged(base) {
  if (!overlay || Date.now() - overlay.at > STALE_MS) return base
  const fresh = overlay.rows.map((row) => ({ ...row }))
  if (!base) return { fetchedAt: overlay.at, limits: fresh, spend: null }
  if (overlay.at <= base.fetchedAt) return base
  const rows = base.limits.map((row) => {
    const now = fresh.find((o) => o.label === row.label)
    return now
      ? { ...row, percent: now.percent, resetsAt: now.resetsAt ?? row.resetsAt, severity: now.severity, asOf: now.asOf }
      : { ...row }
  })
  for (const row of fresh) {
    if (!rows.some((seen) => seen.label === row.label)) rows.push(row)
  }
  return { ...base, fetchedAt: overlay.at, limits: rows }
}

/**
 * Sort, drop what the clock has overtaken, and say whether anything left is
 * old — which is a per-row question now that half the rows can be refreshed
 * and half cannot. The status line publishes the two unscoped windows and
 * nothing else, so a per-model weekly row keeps the age of the last cache
 * write however busy the desktop is, and sitting beside a live figure without
 * saying so is exactly how a stale number gets believed.
 */
function finish(value) {
  if (!value) return null
  const now = Date.now()
  const limits = value.limits
    .map((row) => ({ ...row, stale: row.asOf > 0 && now - row.asOf > STALE_MS }))
    .filter(current)
    .sort((a, b) => b.percent - a.percent)
  if (!limits.length) return null
  return { ...value, limits, stale: limits.some((row) => row.stale) }
}

/**
 * What the account service last said, when it has been asked and answered.
 *
 * Held in memory rather than written anywhere: it is a fact about right now,
 * it costs one request to have again, and a copy on disk is one more place a
 * percentage can be read back long after it stopped being true.
 */
let live = null

/** The last answer's shape, for deciding whether this one is news. */
let livePrint = ''

/** Why there is no live answer, in words a phone can show. */
let probeStatus = ''

/** One request at a time, and not more often than the floor above. */
let probing = null
let probedAt = 0

/**
 * The sign-in Claude Code keeps, read fresh each time.
 *
 * Only the CLI can mint one of these, and it rewrites the file when it runs,
 * so a desktop left alone long enough finds the saved token lapsed. Holding a
 * copy would just mean asking with a token we already knew was dead.
 */
function credentials() {
  let login
  try {
    login = JSON.parse(fs.readFileSync(credentialsFile(), 'utf8'))?.claudeAiOauth
  } catch {
    return null
  }
  if (!login || typeof login !== 'object') return null
  const token = String(login.accessToken || '')
  if (!token) return null
  return { token, expiresAt: Number(login.expiresAt) || 0 }
}

/**
 * Ask, and keep the answer.
 *
 * Resolves to whether the numbers moved, so a caller can decide whether the
 * phone is worth waking. A failure is never destructive: the last live answer
 * stands and goes on ageing, the config cache is still under it, and the row
 * that would have been refreshed simply says how old it is — which is the
 * behaviour this module had for everything, and now has only when offline.
 */
export function probe({ force = false } = {}) {
  if (probing) return probing
  if (!force && Date.now() - probedAt < PROBE_MIN_MS) return Promise.resolve(false)
  probing = ask().finally(() => {
    probing = null
  })
  return probing
}

async function ask() {
  const login = credentials()
  if (!login) {
    probeStatus = 'waiting for sign-in'
    return false
  }
  if (login.expiresAt > 0 && login.expiresAt <= Date.now()) {
    probeStatus = 'sign-in expired'
    return false
  }

  probedAt = Date.now()
  let payload
  try {
    const response = await fetch(ENDPOINT, {
      headers: {
        authorization: `Bearer ${login.token}`,
        'anthropic-beta': BETA,
        accept: 'application/json',
      },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    })
    if (!response.ok) {
      // A status is a server that answered, which is a reason to wait rather
      // than to retry: 429 in particular is the service asking us to stop.
      probeStatus = response.status === 429 ? 'rate limited' : `service said ${response.status}`
      return false
    }
    payload = await response.json()
  } catch {
    probeStatus = 'offline'
    return false
  }

  const at = Date.now()
  const rows = rowsFrom(payload, at)
  if (!rows.length) {
    probeStatus = 'no limits reported'
    return false
  }

  const print = JSON.stringify(rows.map((row) => [row.kind, row.label, row.percent]))
  const moved = livePrint !== print
  livePrint = print
  live = { fetchedAt: at, limits: rows, spend: spendFrom(payload) }
  probeStatus = ''
  return moved
}

/**
 * Whichever reading is newest.
 *
 * Normally that is the probe, by minutes to days. It is the config cache on a
 * desktop that cannot reach the service, or has not been asked yet — and the
 * comparison rather than a preference is what makes a probe that has been
 * failing since breakfast lose to a cache the CLI rewrote since.
 */
function newest() {
  const cached = readCache()
  if (!live) return cached
  if (!cached) return live
  return live.fetchedAt >= cached.fetchedAt ? live : cached
}

/**
 * The limits as they stand, or `null` when this desktop has never been told.
 *
 * Synchronous, because it is asked on every session list and must not turn one
 * into a request. The probe runs on its own timer and leaves its answer here.
 */
export function read() {
  const value = finish(merged(newest()))
  if (!value) return null
  return probeStatus ? { ...value, probeStatus } : value
}

function readCache() {
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

  const rows = utilization ? rowsFrom(utilization, fetchedAt) : []
  // Deliberately unjudged: what counts as expired or stale depends on the
  // clock, and this value is memoised against the file's mtime for hours.
  const value = rows.length ? { fetchedAt, limits: rows, spend: spendFrom(utilization) } : null

  cache.at = stat.mtimeMs
  cache.value = value
  return value
}

/** The one number worth a badge: the tightest window, however it is spelled. */
export function worst() {
  const value = read()
  return value?.limits?.[0] ?? null
}
