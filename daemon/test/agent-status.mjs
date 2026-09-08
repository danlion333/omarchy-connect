// The status line: what a session is running as, what the plan has left, what
// the desktop can be told to do by name, and what is working with no terminal.
//
// None of it is asked of an agent — every figure is read off a file the CLI
// keeps for its own purposes — so the whole of this test is a fake `HOME` with
// those files in it, and the assertion is that we read them the way the CLI
// wrote them.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'omarchy-connect-status-'))
// Before any import: these modules resolve `os.homedir()` once, at load.
process.env.HOME = sandbox

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`)
}

const write = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
}

const CWD = path.join(sandbox, 'Projects', 'example')
const SLUG = CWD.replace(/[^a-zA-Z0-9]/g, '-')
const projects = path.join(sandbox, '.claude', 'projects', SLUG)
const line = (obj) => JSON.stringify(obj) + '\n'

/* ── the fixtures ──────────────────────────────────────────────────────── */

// A skill the whole machine has, and a project one that shadows a user one of
// the same name — which is how the CLI itself resolves them.
write(
  path.join(sandbox, '.claude', 'skills', 'diagnose-crash', 'SKILL.md'),
  '---\nname: diagnose-crash\ndescription: >\n  Work out why a program dumped core.\n  Reads the backtrace.\n---\n\nbody\n',
)
write(path.join(sandbox, '.claude', 'skills', 'review', 'SKILL.md'), '---\nname: review\ndescription: the machine one\n---\n')
write(path.join(CWD, '.claude', 'skills', 'review', 'SKILL.md'), '---\nname: review\ndescription: the project one\n---\n')
write(
  path.join(CWD, '.claude', 'commands', 'git', 'sync.md'),
  '---\ndescription: rebase and push\nargument-hint: [branch]\n---\n\nrun it\n',
)

// The account service's answer, parked where the CLI parks it.
write(
  path.join(sandbox, '.claude.json'),
  JSON.stringify({
    cachedUsageUtilization: {
      fetchedAtMs: Date.now(),
      utilization: {
        five_hour: { utilization: 8, resets_at: new Date(Date.now() + 3_600_000).toISOString() },
        limits: [
          { kind: 'session', group: 'session', percent: 8, severity: 'normal', resets_at: new Date(Date.now() + 3_600_000).toISOString(), is_active: false },
          { kind: 'weekly_all', group: 'weekly', percent: 73, severity: 'normal', resets_at: new Date(Date.now() + 86_400_000).toISOString(), is_active: true },
          { kind: 'weekly_scoped', group: 'weekly', percent: 70, severity: 'normal', resets_at: null, scope: { model: { display_name: 'Fable' } }, is_active: false },
          // A bucket nobody has a name for must not reach a phone as a row
          // nobody can read.
          { kind: 'juniper_tide', group: 'juniper', percent: 99, severity: 'critical', resets_at: null, is_active: false },
        ],
        spend: { enabled: false, used: { amount_minor: 252, exponent: 2, currency: 'USD' } },
      },
    },
  }),
)

// A background agent, mid-thought.
const JOB = 'abc12345'
const BG_SESSION = 'bbbbbbbb-2222-3333-4444-555555555555'
const RESUMED = 'cccccccc-2222-3333-4444-555555555555'
write(
  path.join(sandbox, '.claude', 'jobs', JOB, 'state.json'),
  JSON.stringify({
    state: 'working',
    detail: 'reading the router',
    tokens: 200116,
    name: 'Health endpoint',
    intent: 'add a health endpoint',
    sessionId: BG_SESSION,
    resumeSessionId: RESUMED,
    cwd: CWD,
    createdAt: new Date(Date.now() - 600_000).toISOString(),
    updatedAt: new Date().toISOString(),
  }),
)
write(
  path.join(sandbox, '.claude', 'jobs', JOB, 'timeline.jsonl'),
  [
    line({ at: new Date(Date.now() - 500_000).toISOString(), state: 'working', detail: 'starting' }),
    // The same sentence twice is one step; a job checks in more often than it
    // changes its mind.
    line({ at: new Date(Date.now() - 400_000).toISOString(), state: 'working', detail: 'reading the router' }),
    line({ at: new Date(Date.now() - 300_000).toISOString(), state: 'working', detail: 'reading the router' }),
  ].join(''),
)
// A stale job is history, not status.
write(
  path.join(sandbox, '.claude', 'jobs', 'old00000', 'state.json'),
  JSON.stringify({ state: 'done', sessionId: 'dddddddd-2222-3333-4444-555555555555', updatedAt: new Date(Date.now() - 3 * 86_400_000).toISOString() }),
)

// The list a session is working through, where the CLI keeps it.
const TASK_SESSION = '11111111-2222-3333-4444-555555555555'
const taskDir = path.join(sandbox, '.claude', 'tasks', TASK_SESSION)
write(path.join(taskDir, '1.json'), JSON.stringify({ id: '1', subject: 'Read the router', description: 'find it', activeForm: 'Reading the router', status: 'completed', blockedBy: [] }))
write(path.join(taskDir, '2.json'), JSON.stringify({ id: '2', subject: 'Add the endpoint', description: 'write it', activeForm: 'Adding the endpoint', status: 'in_progress', blockedBy: ['1'] }))
// Numbered, so ten must sort after nine rather than beside one.
write(path.join(taskDir, '10.json'), JSON.stringify({ id: '10', subject: 'Write a test', description: 'prove it', status: 'pending', blockedBy: [] }))
write(path.join(taskDir, 'notes.txt'), 'not a task')

const at = '2026-08-25T19:24:33.475Z'
const usage = (cacheRead) => ({
  input_tokens: 2,
  cache_creation_input_tokens: 600,
  cache_read_input_tokens: cacheRead,
  output_tokens: 1800,
})

// A conversation with turns in it: model, mode, branch, and a title the CLI
// wrote for it.
const SESSION = '11111111-2222-3333-4444-555555555555'
write(
  path.join(projects, `${SESSION}.jsonl`),
  [
    line({ type: 'mode', mode: 'plan' }),
    line({ type: 'ai-title', aiTitle: 'Health endpoint for the router' }),
    line({ type: 'user', timestamp: at, cwd: CWD, gitBranch: 'master', version: '2.1.241', message: { role: 'user', content: 'add one' } }),
    // A short continuation after a long turn: the meter must read the long one.
    line({ type: 'assistant', timestamp: at, cwd: CWD, gitBranch: 'master', version: '2.1.241', effort: 'high', message: { role: 'assistant', model: 'claude-opus-5', usage: usage(149_000), content: [{ type: 'text', text: 'done' }] } }),
    line({ type: 'assistant', timestamp: at, cwd: CWD, gitBranch: 'master', version: '2.1.241', message: { role: 'assistant', model: 'claude-opus-5', usage: usage(10), content: [{ type: 'text', text: 'and again' }] } }),
  ].join(''),
)

// A brand-new session: the CLI seeds it with the last title this project had,
// and it has said nothing at all yet.
const FRESH = '22222222-2222-3333-4444-555555555555'
write(
  path.join(projects, `${FRESH}.jsonl`),
  [line({ type: 'ai-title', aiTitle: 'Health endpoint for the router' }), line({ type: 'agent-name', agentName: 'Health endpoint for the router' })].join(''),
)

// A conversation past the small window, which is the only thing that says it
// was not on one.
const HUGE = '33333333-2222-3333-4444-555555555555'
write(
  path.join(projects, `${HUGE}.jsonl`),
  [
    line({ type: 'user', timestamp: at, cwd: CWD, message: { role: 'user', content: 'go' } }),
    line({ type: 'assistant', timestamp: at, cwd: CWD, message: { role: 'assistant', model: 'claude-opus-5', usage: usage(420_000), content: [{ type: 'text', text: 'ok' }] } }),
  ].join(''),
)

/* ── skills ────────────────────────────────────────────────────────────── */

const skills = await import('../src/agents/skills.js')
const listed = skills.list(CWD)

check('a skill is read off its own front matter', listed.skills.some((s) => s.name === 'diagnose-crash'))
check(
  'a folded description arrives as one line',
  listed.skills.find((s) => s.name === 'diagnose-crash')?.description === 'Work out why a program dumped core. Reads the backtrace.',
  listed.skills.find((s) => s.name === 'diagnose-crash')?.description,
)
const review = listed.skills.filter((s) => s.name === 'review')
check('a project skill shadows the user one it shares a name with', review.length === 1 && review[0].scope === 'project', review[0]?.description)
check('a nested command keeps the namespace the CLI spells it with', listed.commands.some((c) => c.name === 'git:sync'))
check('an argument hint travels with it', listed.commands.find((c) => c.name === 'git:sync')?.args === '[branch]')
check('the built-ins are offered too', listed.builtins.some((b) => b.name === 'compact'))
check('a name we published is known', skills.known(CWD, 'diagnose-crash') && skills.known(CWD, 'compact'))
check('one we did not is refused', !skills.known(CWD, 'rm -rf /') && !skills.known(CWD, '../../etc/passwd'))
check('a marketplace on disk is not an installed plugin', !listed.skills.some((s) => s.scope === 'plugin'))

/* ── limits ────────────────────────────────────────────────────────────── */

const limits = await import('../src/agents/limits.js')
const usageNow = limits.read()

check('the tightest window comes first', usageNow?.limits?.[0]?.percent === 73, String(usageNow?.limits?.[0]?.percent))
check('a scoped weekly says which model it is about', usageNow?.limits?.some((l) => l.label === 'week · Fable'))
check('the one being spent against is marked', usageNow?.limits?.find((l) => l.kind === 'weekly_all')?.active === true)
check('a bucket with no name for it is not shown', !usageNow?.limits?.some((l) => l.kind === 'juniper_tide'))
check('extra usage that is switched off is not a row', usageNow?.spend === null)
check('a fresh answer is not stale', usageNow?.stale === false)
check('the worst window is the one a badge would use', limits.worst()?.percent === 73)

// A desktop nobody has opened for days: the CLI never rewrote its cache, so
// every figure in it belongs to a week that has since turned over.
const daysAgo = Date.now() - 3 * 86_400_000
write(
  path.join(sandbox, '.claude.json'),
  JSON.stringify({
    cachedUsageUtilization: {
      fetchedAtMs: daysAgo,
      utilization: {
        limits: [
          // Its window ended two days ago — the percentage is a fact about a
          // week nobody is in any more.
          { kind: 'session', group: 'session', percent: 8, severity: 'normal', resets_at: new Date(daysAgo + 3_600_000).toISOString(), is_active: false },
          { kind: 'weekly_all', group: 'weekly', percent: 73, severity: 'normal', resets_at: new Date(Date.now() + 18 * 3_600_000).toISOString(), is_active: true },
          { kind: 'weekly_scoped', group: 'weekly', percent: 70, severity: 'normal', resets_at: new Date(Date.now() + 18 * 3_600_000).toISOString(), scope: { model: { display_name: 'Fable' } }, is_active: false },
        ],
      },
    },
  }),
)

const usageOld = limits.read()
check('a window that has already turned over is not shown at all', !usageOld?.limits?.some((l) => l.kind === 'session'))
check('the rows that survive say they are old', usageOld?.limits?.every((l) => l.stale === true))
check('and carry when they were measured', usageOld?.limits?.[0]?.asOf === daysAgo, String(usageOld?.limits?.[0]?.asOf))

// One status line update from a session starting up — the only realtime
// source there is, and it knows about the account-wide windows only.
limits.absorb({
  five_hour: { used_percentage: 1, resets_at: Math.round((Date.now() + 4 * 3_600_000) / 1000) },
  seven_day: { used_percentage: 96, resets_at: Math.round((Date.now() + 18 * 3_600_000) / 1000) },
})
const usageLive = limits.read()
const row = (label) => usageLive?.limits?.find((l) => l.label === label)

check('a status line refreshes the account-wide week', row('week')?.percent === 96, String(row('week')?.percent))
check('and brings the session window back with it', row('session')?.percent === 1, String(row('session')?.percent))
check('the refreshed rows are no longer old', row('week')?.stale === false && row('session')?.stale === false)
check('but a per-model row it cannot refresh still says it is', row('week · Fable')?.stale === true)
check('so the card as a whole is still flagged', usageLive?.stale === true)

// ── the probe ──────────────────────────────────────────────────────────
//
// Everything above is the fallback road: a cache the CLI rewrites when it
// feels like it, corrected where the status line can. What the phone should
// normally be looking at is the account service's own answer, which knows
// every window at once and knows it as of now. The service is faked here —
// the assertion is that we ask the way the credential says to, and that a
// live answer beats a cache days older than it.

write(
  path.join(sandbox, '.claude', '.credentials.json'),
  JSON.stringify({ claudeAiOauth: { accessToken: 'oauth-abc', expiresAt: Date.now() + 3_600_000, rateLimitTier: 'max_5x' } }),
)

let asked = null
const answer = {
  five_hour: { utilization: 4, resets_at: new Date(Date.now() + 2 * 3_600_000).toISOString() },
  seven_day: { utilization: 91, resets_at: new Date(Date.now() + 18 * 3_600_000).toISOString() },
  limits: [
    { kind: 'session', group: 'session', percent: 4, resets_at: new Date(Date.now() + 2 * 3_600_000).toISOString(), scope: null, is_active: false },
    { kind: 'weekly_all', group: 'weekly', percent: 91, resets_at: new Date(Date.now() + 18 * 3_600_000).toISOString(), scope: null, is_active: true },
    { kind: 'weekly_scoped', group: 'weekly', percent: 89, resets_at: new Date(Date.now() + 18 * 3_600_000).toISOString(), scope: { model: { display_name: 'Fable' } }, is_active: false },
  ],
}
globalThis.fetch = async (url, init) => {
  asked = { url: String(url), headers: init?.headers || {} }
  return { ok: true, status: 200, json: async () => answer }
}

const moved = await limits.probe({ force: true })
const probed = limits.read()
const live = (label) => probed?.limits?.find((l) => l.label === label)

check('the account service is the one asked', asked?.url === 'https://api.anthropic.com/api/oauth/usage', asked?.url)
check("with Claude Code's own sign-in", asked?.headers.authorization === 'Bearer oauth-abc', asked?.headers.authorization)
check('and the beta header it wants', asked?.headers['anthropic-beta'] === 'oauth-2025-04-20')
check('a first answer is news', moved === true)
check('the live week replaces the cached one', live('week')?.percent === 91, String(live('week')?.percent))
check('and the per-model row is live too, not three days old', live('week · Fable')?.percent === 89, String(live('week · Fable')?.percent))
check('so nothing on the card has an age to print', probed?.stale === false && probed.limits.every((l) => l.stale === false))
check('and no row apologises for a source', !probed?.probeStatus)

// The same numbers again are not worth waking a phone for.
check('an unchanged answer is not news', (await limits.probe({ force: true })) === false)

// A service that answers with a status is a service asking us to wait, and
// the last live answer is still the best thing on the desktop.
globalThis.fetch = async () => ({ ok: false, status: 429, json: async () => ({}) })
await limits.probe({ force: true })
const after = limits.read()
check('a rate-limited probe keeps the last live numbers', after?.limits?.find((l) => l.label === 'week')?.percent === 91)
check('and says why there is nothing newer', after?.probeStatus === 'rate limited', after?.probeStatus)

// No sign-in at all: back to the cache, honestly labelled.
fs.rmSync(path.join(sandbox, '.claude', '.credentials.json'))
globalThis.fetch = async () => {
  throw new Error('should not be asked without a credential')
}
await limits.probe({ force: true })
check('a desktop with no sign-in says so rather than guessing', limits.read()?.probeStatus === 'waiting for sign-in')

/* ── background agents ─────────────────────────────────────────────────── */

const jobs = await import('../src/agents/jobs.js')
const running = jobs.list()

check('a background agent is listed', running.length === 1 && running[0].id === JOB, String(running.length))
check('with the sentence it wrote about itself', running[0]?.detail === 'reading the router')
check('and what it was sent off to do', running[0]?.intent === 'add a health endpoint')
check('a job nobody has touched in days is history', !running.some((j) => j.id === 'old00000'))

const one = jobs.detail(JOB)
check('its timeline collapses a sentence it repeated', one?.steps?.length === 2, JSON.stringify(one?.steps?.map((s) => s.detail)))
check('a job id is not a path', jobs.detail('../../etc') === null)

const bySession = jobs.bySession()
check('a job is found by the session it started as', bySession.get(BG_SESSION)?.id === JOB)
check('and by the one it resumed, which is the file it writes', bySession.get(RESUMED)?.id === JOB)

/* ── vitals ────────────────────────────────────────────────────────────── */

const claude = (await import('../src/agents/claude.js')).default
const vitals = claude.vitals(path.join(projects, `${SESSION}.jsonl`), CWD)

check('the model is the one on the last turn', vitals?.model === 'claude-opus-5', String(vitals?.model))
check('the effort with it', vitals?.effort === 'high')
check('the permission mode comes off the mode line', vitals?.mode === 'plan')
check('the branch and the CLI version travel on every entry', vitals?.branch === 'master' && vitals?.version === '2.1.241')
check('the CLI\'s own title for the conversation is used', vitals?.title === 'Health endpoint for the router')
check(
  'the context counts the cache, which is nearly all of it',
  vitals?.context?.tokens === 149_000 + 600 + 2 + 1800,
  String(vitals?.context?.tokens),
)
check('a short continuation does not read as an empty conversation', (vitals?.context?.percent ?? 0) >= 70, `${vitals?.context?.percent}%`)
check('a 200k window is assumed until something says otherwise', vitals?.context?.window === 200_000, String(vitals?.context?.window))

const fresh = claude.vitals(path.join(projects, `${FRESH}.jsonl`), CWD)
check('a session with no turn in it does not wear the last one\'s title', fresh?.title === null, String(fresh?.title))

const huge = claude.vitals(path.join(projects, `${HUGE}.jsonl`), CWD)
check('a conversation past 200k is self-evidently not on a 200k window', huge?.context?.window === 1_000_000, String(huge?.context?.window))

// The settings file is the other thing that knows, and it knows sooner.
write(path.join(sandbox, '.claude', 'settings.json'), JSON.stringify({ model: 'opus[1m]' }))
const long = claude.vitals(path.join(projects, `${HUGE}.jsonl`) + '', CWD)
check('and a configured long window is believed before the arithmetic', long?.context?.window === 1_000_000)

/* ── the list it is working through ────────────────────────────────────── */

const tasks = await import('../src/agents/tasks.js')
const todo = tasks.read(TASK_SESSION)

check('the task list is read in the order it was written', todo?.tasks.map((t) => t.id).join(' ') === '1 2 10', todo?.tasks.map((t) => t.id).join(' '))
check('anything that is not a task is not one', todo?.total === 3, String(todo?.total))
check('what is behind it is counted', todo?.done === 1, String(todo?.done))
check('and what it is on right now is named', todo?.active?.id === '2')
check('and what it would pick up next, for the moment between two', todo?.next?.id === '10', String(todo?.next?.id))
check(
  'the sentence is the one the CLI puts in its own spinner',
  tasks.summary(TASK_SESSION)?.active === 'Adding the endpoint',
  String(tasks.summary(TASK_SESSION)?.active),
)
check('a task with no spinner sentence falls back to its subject', todo?.tasks.find((t) => t.id === '10')?.activeForm === 'Write a test')
check('a session that keeps no list gets no panel', tasks.read('99999999-0000-0000-0000-000000000000') === null)
check('a session id is not a path', tasks.read('../../projects') === null)

/* ── the conversations on disk ─────────────────────────────────────────── */

const recent = claude.recent(10)
check('every conversation this desktop has had is found', recent.length === 3, String(recent.length))
check('newest first', recent[0].mtime >= recent[recent.length - 1].mtime)
check(
  'a session that started and said nothing has nothing to resume',
  claude.vitals(path.join(projects, `${FRESH}.jsonl`), CWD)?.context === null,
)
check(
  'the working directory is read off the file, not off the slug',
  claude.vitals(recent[0].path)?.cwd === CWD,
  String(claude.vitals(recent[0].path)?.cwd),
)

/* ── done ──────────────────────────────────────────────────────────────── */

fs.rmSync(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length) process.exit(1)
