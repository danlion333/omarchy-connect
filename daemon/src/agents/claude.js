import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * Claude Code, read from the transcript it keeps for itself.
 *
 * Everything the agent says and does is already on disk as one JSON object per
 * line under `~/.claude/projects/<slug-of-cwd>/<session-id>.jsonl`, so nothing
 * has to be scraped off a terminal to read a conversation. The adapter's whole
 * job is knowing where those files are and turning a line of Claude's own
 * bookkeeping into the agent-neutral block the phone renders.
 *
 * The interface is deliberately small — `detect`, `transcripts`, `parse`, and
 * `question` for the one thing the transcript is too late about — so a second
 * agent costs a file rather than a redesign. Tailing is not in here:
 * every agent that writes JSONL is tailed the same way, and that lives in the
 * plugin.
 */

const HOME = os.homedir()

export const PROJECTS_DIR = path.join(HOME, '.claude', 'projects')

/** How Claude Code names a project directory: every non-alphanumeric is a dash. */
export const slugFor = (cwd) => String(cwd || '').replace(/[^a-zA-Z0-9]/g, '-')

const MAX_SUMMARY = 160
const MAX_TEXT = 4000
const MAX_FULL = 32 * 1024

/** Types that are Claude talking to itself about its own state, not to us. */
const SKIP_TYPES = new Set([
  'mode',
  'permission-mode',
  'file-history-snapshot',
  'file-history-delta',
  'bridge-session',
  'atis-latch',
  'ai-title',
  'last-prompt',
  'queue-operation',
  'attachment',
  'summary',
])

const oneLine = (value, max = MAX_SUMMARY) => {
  const text = String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

const clamp = (text, max) => {
  const value = String(text ?? '')
  return value.length > max ? `${value.slice(0, max)}\n… truncated` : value
}

/**
 * The one line that says what a tool call was actually about. A phone screen
 * has room for the command, not for its arguments object, and "Bash" alone
 * tells the person on the sofa nothing they can act on.
 */
const TOOL_SUMMARY = {
  Bash: (i) => i.command,
  BashOutput: (i) => i.bash_id,
  Read: (i) => i.file_path,
  Write: (i) => i.file_path,
  Edit: (i) => i.file_path,
  NotebookEdit: (i) => i.notebook_path,
  Glob: (i) => i.pattern,
  Grep: (i) => [i.pattern, i.path].filter(Boolean).join('  '),
  Task: (i) => i.description,
  Agent: (i) => i.description,
  Skill: (i) => [i.skill, i.args].filter(Boolean).join(' '),
  WebFetch: (i) => i.url,
  WebSearch: (i) => i.query,
  TodoWrite: (i) => `${(i.todos || []).length} items`,
  AskUserQuestion: (i) => i.questions?.[0]?.question,
  SendMessage: (i) => `→ ${i.to}`,
  Artifact: (i) => i.file_path || i.url || i.action,
}

const GENERIC_KEYS = ['command', 'file_path', 'path', 'pattern', 'query', 'url', 'description', 'prompt', 'text']

function summariseInput(name, input) {
  const raw = input && typeof input === 'object' ? input : {}
  const specific = TOOL_SUMMARY[name]?.(raw)
  if (specific) return oneLine(specific)
  for (const key of GENERIC_KEYS) {
    if (typeof raw[key] === 'string' && raw[key]) return oneLine(raw[key])
  }
  const keys = Object.keys(raw)
  return keys.length ? oneLine(keys.join(', ')) : ''
}

/**
 * What a tool answered, in one line. `content` is usually a string; when a tool
 * returned an image it is an array of parts, and saying so is more use than
 * rendering a base64 blob nobody can read on a phone.
 */
function summariseResult(content) {
  if (Array.isArray(content)) {
    const kinds = content.map((part) => (part && typeof part === 'object' ? part.type : typeof part))
    const text = content
      .filter((part) => part?.type === 'text')
      .map((part) => part.text)
      .join('\n')
    return {
      summary: text ? oneLine(text) : oneLine(kinds.join(', ')),
      full: text || `[${kinds.join(', ')}]`,
      lines: text ? text.split('\n').length : content.length,
    }
  }
  const text = typeof content === 'string' ? content : JSON.stringify(content ?? '')
  const lines = text ? text.split('\n') : []
  return { summary: oneLine(lines[0] || ''), full: text, lines: lines.length }
}

/** The one tool call that is a question rather than a thing an agent did. */
const QUESTION_TOOL = 'AskUserQuestion'

/** How many options a numbered prompt can offer before a digit stops answering it. */
const MAX_OPTIONS = 9
/** AskUserQuestion asks at most four things at a time; so does the phone. */
const MAX_QUESTIONS = 4

/**
 * A multiple-choice question, carried through whole rather than flattened.
 *
 * Every other tool call is collapsed into one line on its way to the phone,
 * because the interesting part of a tool call is that it happened. This one is
 * the exception: what makes `AskUserQuestion` worth putting on a phone at all
 * is the options, and an agent blocked on a question the phone can *see* but
 * not *answer* is the same agent blocked. So the shape survives the trip.
 *
 * The options are numbered here rather than on the phone, because the number
 * is the answer: the terminal draws the same list and takes the digit for it.
 */
function questionsFrom(input) {
  const raw = Array.isArray(input?.questions) ? input.questions : []
  return raw.slice(0, MAX_QUESTIONS).flatMap((question) => {
    const text = oneLine(question?.question, 400)
    const options = (Array.isArray(question?.options) ? question.options : [])
      .slice(0, MAX_OPTIONS)
      .map((option) => ({
        label: oneLine(option?.label, 120),
        description: oneLine(option?.description, 300),
      }))
      .filter((option) => option.label)
    if (!text || options.length < 2) return []
    return [{
      header: oneLine(question?.header, 40),
      question: text,
      multiSelect: question?.multiSelect === true,
      options,
    }]
  })
}

/**
 * The question as a block, from the tool input alone.
 *
 * Two roads arrive here with the same argument: the transcript, once the turn
 * is written down, and the `PreToolUse` hook, which fires while the agent is
 * still standing at the prompt. `null` means this was not a question, which is
 * the answer for every other tool.
 */
function questionBlock(input) {
  const questions = questionsFrom(input)
  if (!questions.length) return null
  return {
    role: 'assistant',
    kind: 'question',
    tool: 'AskUserQuestion',
    questions,
    summary: oneLine(questions[0].question),
    full: clamp(JSON.stringify(input ?? {}, null, 2), MAX_FULL),
  }
}

/**
 * A user turn arrives wrapped in whatever the CLI injected around it — a
 * slash command, a caveat about local commands, a system reminder. The person
 * on the phone wants the sentence that was typed, so unwrap it and drop the
 * rest.
 */
function userText(raw) {
  let text = String(raw ?? '')
  const command = text.match(/<command-name>([^<]*)<\/command-name>/)
  const args = text.match(/<command-args>([^<]*)<\/command-args>/)
  if (command) return oneLine([command[1], args?.[1]].filter(Boolean).join(' ').trim(), 200)
  text = text
    .replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>/g, '')
    .replace(/<local-command-stdout>[\s\S]*?<\/local-command-stdout>/g, '')
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<command-message>[\s\S]*?<\/command-message>/g, '')
    .trim()
  return text
}

const stamp = (entry) => {
  const at = Date.parse(entry.timestamp || '')
  return Number.isFinite(at) ? at : Date.now()
}

/** Enough of the end of a transcript to find the last turn in it. */
const TAIL_BYTES = 8 * 1024

/**
 * The last few entries of a transcript, newest first, without reading the file.
 *
 * Transcripts run to megabytes and this is asked on every scan, so it reads the
 * end and nothing else. The first line of that window is very likely half a
 * line and is dropped rather than parsed.
 */
function* tailEntries(file, bytes = TAIL_BYTES) {
  let fd
  let text
  try {
    const stat = fs.statSync(file)
    const start = stat.size > bytes ? stat.size - bytes : 0
    fd = fs.openSync(file, 'r')
    const buf = Buffer.allocUnsafe(stat.size - start)
    const read = fs.readSync(fd, buf, 0, buf.length, start)
    text = buf.subarray(0, read).toString('utf8')
    if (start > 0) text = text.slice(text.indexOf('\n') + 1)
  } catch {
    return
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
  }
  const lines = text.split('\n')
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim()
    if (!line) continue
    try {
      yield JSON.parse(line)
    } catch {
      // A half-written line at the very end, or the truncated first one.
    }
  }
}

/**
 * Words that are a command rather than a conversation.
 *
 * `claude` with no command starts a session; `claude doctor` runs a checkup and
 * `claude daemon` supervises background work. Both wear the same `comm` and the
 * same argv[0], and the scan cannot tell them apart by looking at `/proc`
 * alone — which is how a desktop ends up listing its own supervisor as an
 * agent, bound to whatever conversation happened to be newest in the directory
 * it was started from.
 *
 * A blacklist rather than a whitelist, and it is exact rather than defensive:
 * if a word is on this list the CLI runs a command and never a session, so a
 * prompt can never be mistaken for one. The hidden helpers are here beside the
 * documented commands because `/proc` does not care which are in `--help`.
 */
const COMMANDS = new Set([
  'agents',
  'auth',
  'auto-mode',
  'bg-pty-host',
  'bg-spare',
  'config',
  'daemon',
  'doctor',
  'gateway',
  'import',
  'install',
  'mcp',
  'migrate-installer',
  'plugin',
  'plugins',
  'project',
  'setup-token',
  'ultrareview',
  'update',
  'upgrade',
])


/* ── what a session is spending ────────────────────────────────────────── */

/**
 * Enough of the end of a transcript to hold a whole assistant turn.
 *
 * `TAIL_BYTES` is sized for "find the last line"; the usage figures live on
 * the assistant entry, and an assistant entry carrying a long answer and a
 * tool call is comfortably past eight kilobytes. This window is what the
 * status line is read from, and it is read at most once per write.
 */
const VITALS_BYTES = 256 * 1024

/**
 * How much a model can hold, which is not a property of the model alone.
 *
 * Opus and Sonnet are 200k by default and a million with the long-context
 * variant switched on, and the transcript records neither — `message.model` is
 * `claude-opus-5` either way. Two things do know: the settings file, where the
 * variant is spelled `opus[1m]`, and arithmetic, because a session already
 * holding 400k tokens is self-evidently not on a 200k window.
 *
 * Being wrong in the safe direction matters here: a meter that says 90% when
 * the truth is 18% is a person compacting a conversation that did not need it.
 */
const SMALL_WINDOW = 200_000
const LARGE_WINDOW = 1_000_000

const SETTINGS = [
  path.join(HOME, '.claude', 'settings.json'),
  path.join(HOME, '.claude', 'settings.local.json'),
]

const settingsCache = { at: '', long: false }

/** Does this desktop's configured model ask for the long window? */
function longContextConfigured(cwd) {
  const files = [
    ...SETTINGS,
    ...(cwd ? [path.join(cwd, '.claude', 'settings.json'), path.join(cwd, '.claude', 'settings.local.json')] : []),
  ]
  const stamp = files
    .map((file) => {
      try {
        return String(fs.statSync(file).mtimeMs)
      } catch {
        return '-'
      }
    })
    .join('|')
  if (settingsCache.at === stamp) return settingsCache.long
  let long = false
  for (const file of files) {
    try {
      const model = JSON.parse(fs.readFileSync(file, 'utf8'))?.model
      if (typeof model === 'string' && /\[1m\]/i.test(model)) long = true
    } catch {
      // No settings file, or one being rewritten. Neither is an answer.
    }
  }
  settingsCache.at = stamp
  settingsCache.long = long
  return long
}

/**
 * Everything on one `usage` record that counts against the window.
 *
 * Cache reads are the bulk of it and are the easiest to leave out by accident:
 * a meter built on `input_tokens` alone reads two tokens where the truth is
 * two hundred thousand, because almost the whole conversation arrives from the
 * cache on every turn.
 */
const contextOf = (usage) =>
  (Number(usage?.input_tokens) || 0) +
  (Number(usage?.cache_creation_input_tokens) || 0) +
  (Number(usage?.cache_read_input_tokens) || 0) +
  (Number(usage?.output_tokens) || 0)

const vitalsCache = new Map()
const VITALS_CACHE_MAX = 64

/**
 * The status line for one session: what it is running as, and how full it is.
 *
 * Every field is read off the transcript's own tail rather than asked of
 * anything — the model on the last assistant turn, the permission mode on the
 * last `mode` line, the branch and the CLI version that every entry carries,
 * and the title the CLI generated for the conversation once it had one. That
 * is the whole reason this can exist: a phone showing a desktop session's
 * status line needs no cooperation from the session at all.
 */
export function vitals(file, cwd = null) {
  let stat
  try {
    stat = fs.statSync(file)
  } catch {
    return null
  }
  const hit = vitalsCache.get(file)
  if (hit && hit.at === stat.mtimeMs) return hit.value

  let model = null
  let effort = null
  let tokens = 0
  let mode = null
  let branch = null
  let version = null
  let title = null
  let turnAt = 0
  let cwd_ = null

  for (const entry of tailEntries(file, VITALS_BYTES)) {
    if (entry.type === 'assistant' && entry.message?.usage) {
      // The largest turn in the window is the honest figure: a short
      // continuation reports only its own few tokens, and the meter would
      // read empty for a conversation that is nearly full.
      const used = contextOf(entry.message.usage)
      if (used > tokens) tokens = used
      if (!model) {
        model = String(entry.message.model || '') || null
        turnAt = Date.parse(entry.timestamp || '') || turnAt
      }
    }
    if (!mode && entry.type === 'mode' && entry.mode) mode = String(entry.mode)
    // The name the CLI gave the conversation. A session started with `--name`
    // says so in `agent-name`; one the CLI titled itself says it in
    // `ai-title`, and the explicit name wins because somebody chose it.
    if (entry.type === 'agent-name' && entry.agentName) title = oneLine(entry.agentName, 80)
    if (!title && entry.type === 'ai-title' && entry.aiTitle) title = oneLine(entry.aiTitle, 80)
    // Read like the branch rather than like the model: the newest turn is not
    // guaranteed to carry it, and the last one that did is still the answer.
    if (!effort && entry.effort) effort = String(entry.effort)
    if (!branch && entry.gitBranch) branch = String(entry.gitBranch)
    if (!version && entry.version) version = String(entry.version)
    // Where the conversation was had. A transcript's own directory name is a
    // slug with every separator flattened to a dash, so it cannot be turned
    // back into a path; the entries carry the real one.
    if (!cwd_ && entry.cwd) cwd_ = String(entry.cwd)
  }

  const window = tokens > SMALL_WINDOW || longContextConfigured(cwd) ? LARGE_WINDOW : SMALL_WINDOW
  const value = {
    model,
    effort,
    mode,
    branch,
    version,
    // A conversation with nothing in it has a title all the same: the CLI
    // seeds a new session with the last one this project had, and generates
    // its own only once there is something to name. Handing that on would put
    // yesterday's sentence over an empty session, so the title waits for a
    // turn — and until then the directory's name is the honest label.
    title: tokens ? title : null,
    cwd: cwd_ || cwd || null,
    turnAt: turnAt || null,
    context: tokens ? { tokens, window, percent: Math.min(100, Math.round((tokens / window) * 100)) } : null,
  }

  if (vitalsCache.size >= VITALS_CACHE_MAX) vitalsCache.clear()
  vitalsCache.set(file, { at: stat.mtimeMs, value })
  return value
}

export default {
  id: 'claude',
  label: 'Claude Code',
  binaries: ['claude'],

  /**
   * Is this argv a session someone is having, or the CLI doing a job?
   *
   * Commander stops at the first bare word: everything before it is a flag,
   * and the word itself is either a command or the prompt. Flags that take a
   * value would put that value in the same position, but no command name is
   * also a flag's argument in this CLI, so reading the first bare word is
   * enough — and being wrong about it costs a session that is listed rather
   * than one that is missed.
   */
  isSession(argv) {
    const args = Array.isArray(argv) ? argv : []
    // A helper announces itself in its own process title: argv[0] is not a
    // path but the words `claude bg-pty-host`, which is the only place that
    // subcommand appears — the flags after it spell it differently. The
    // scan's argv[0] check happens to reject these too, and "happens to" is
    // not a reason to leave the adapter unable to recognise its own helpers.
    const title = String(args[0] || '').split(/\s+/).slice(1)
    for (const word of title) {
      if (COMMANDS.has(word)) return false
    }
    for (const arg of args.slice(1)) {
      if (!arg || arg.startsWith('-')) continue
      return !COMMANDS.has(arg)
    }
    return true
  },

  detect() {
    try {
      return fs.statSync(PROJECTS_DIR).isDirectory()
    } catch {
      return false
    }
  },

  /** Where this agent keeps the conversations it had in `cwd`. */
  transcriptDir(cwd) {
    return path.join(PROJECTS_DIR, slugFor(cwd))
  },

  /**
   * Every transcript this desktop has, newest first, whatever directory it was
   * had in.
   *
   * What the phone's "recent conversations" list is built from. A project
   * directory's name is a slug — every separator flattened to a dash — so it
   * cannot be turned back into a path, which is why the working directory is
   * read off the file itself rather than off the name of the folder holding
   * it. Bounded by count because this is a history nothing prunes: a desktop
   * that has run agents all year has thousands of these.
   */
  recent(limit = 40) {
    let dirs = []
    try {
      dirs = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true }).filter((d) => d.isDirectory())
    } catch {
      return []
    }
    const found = []
    for (const dir of dirs) {
      const full = path.join(PROJECTS_DIR, dir.name)
      let names = []
      try {
        names = fs.readdirSync(full).filter((name) => name.endsWith('.jsonl'))
      } catch {
        continue
      }
      for (const name of names) {
        try {
          const file = path.join(full, name)
          const stat = fs.statSync(file)
          // A file with nothing in it at all is not a conversation. Anything
          // past that is judged on what is *in* it rather than on how big it
          // is — a byte count is a guess, and `agents.history` already reads
          // each of these to fill in its row.
          if (!stat.size) continue
          found.push({ path: file, id: name.slice(0, -'.jsonl'.length), mtime: stat.mtimeMs, size: stat.size })
        } catch {
          // Vanished mid-walk.
        }
      }
    }
    return found.sort((a, b) => b.mtime - a.mtime).slice(0, Math.max(1, limit))
  },

  /** Every transcript for a working directory, newest first. */
  transcripts(cwd) {
    let names = []
    const dir = this.transcriptDir(cwd)
    try {
      names = fs.readdirSync(dir).filter((name) => name.endsWith('.jsonl'))
    } catch {
      return []
    }
    return names
      .map((name) => {
        try {
          const file = path.join(dir, name)
          const stat = fs.statSync(file)
          return { path: file, id: name.slice(0, -'.jsonl'.length), mtime: stat.mtimeMs, size: stat.size }
        } catch {
          return null
        }
      })
      .filter(Boolean)
      .sort((a, b) => b.mtime - a.mtime)
  },

  /**
   * A question the agent is about to ask, from a tool call it has not made yet.
   *
   * Claude Code holds the whole assistant turn back until the tool it contains
   * has returned, so a question the agent is *blocked on* is in no file: the
   * transcript grows the tool call and its answer together, after the fact.
   * The hook is the only road to it while it is still worth answering, and
   * this is the adapter's half of that road — the plugin knows a question when
   * it sees one without knowing what any agent calls its question tool.
   */
  question(tool, input) {
    return String(tool || '') === QUESTION_TOOL ? questionBlock(input) : null
  },

  /**
   * The status line for a session, read off its transcript. Optional on an
   * adapter: an agent that records none of this is a session with no meter
   * beside it, rather than one this daemon refuses to list.
   */
  vitals(file, cwd) {
    return vitals(file, cwd)
  },

  /** The native session id a transcript path stands for. */
  sessionIdFor(transcript) {
    return path.basename(String(transcript || ''), '.jsonl')
  },

  /**
   * Was this conversation had in the background, or at a keyboard?
   *
   * The scan matches a process to a transcript by working directory, and a
   * working directory is not unique: a background job and the session that
   * launched it sit in the same project, and the transcript relocates between
   * project directories a beat *after* the agent moves, so for that beat the
   * two are indistinguishable by directory alone. That beat was enough to show
   * a background agent's conversation under the interactive session's pid.
   *
   * Claude Code stamps every real turn with `sessionKind`, and a background
   * session says `bg` where a session at a terminal says nothing at all. That
   * lines up exactly with the one thing `/proc` already knows for free —
   * whether the process has a controlling terminal — so the two can be asked
   * to agree.
   *
   * `null` means the file has not said yet, and an unknown answer constrains
   * nothing: a transcript too young to have a turn in it is still a candidate.
   */
  background(file) {
    for (const entry of tailEntries(file)) {
      // `entrypoint` marks the entries that describe a turn; the bookkeeping
      // lines around them carry neither field and say nothing either way.
      if (!entry.entrypoint) continue
      return entry.sessionKind === 'bg'
    }
    return null
  },

  /**
   * One line of the transcript → zero or more blocks the phone can draw.
   *
   * Zero is the common answer. Most of a transcript is bookkeeping, sidechain
   * traffic from subagents, or a thinking block that carries nothing but an
   * encrypted signature — a 62-line file becomes about 25 blocks.
   */
  parse(line) {
    let entry
    try {
      entry = JSON.parse(line)
    } catch {
      return []
    }
    if (!entry || typeof entry !== 'object') return []
    if (SKIP_TYPES.has(entry.type)) return []
    // Subagent traffic belongs under the tool call that started it, not
    // interleaved into the conversation the person is reading.
    if (entry.isSidechain) return []

    const at = stamp(entry)
    const message = entry.message

    if (entry.type === 'user' && message && typeof message === 'object') {
      const content = message.content
      if (typeof content === 'string') {
        if (entry.isMeta) return []
        const text = userText(content)
        return text ? [{ role: 'user', kind: 'text', at, text: clamp(text, MAX_TEXT) }] : []
      }
      const blocks = []
      for (const part of Array.isArray(content) ? content : []) {
        if (part?.type === 'tool_result') {
          const { summary, full, lines } = summariseResult(part.content)
          const interrupted = entry.toolUseResult?.interrupted === true
          // What was picked, when the tool that ran was a question. This is the
          // only place the answer is written down: the terminal drew the list
          // and took the keystroke, and neither left a trace anywhere else.
          const answers = entry.toolUseResult?.answers
          blocks.push({
            role: 'user',
            kind: 'result',
            at,
            ref: part.tool_use_id || null,
            status: interrupted ? 'interrupted' : part.is_error ? 'error' : 'ok',
            summary,
            lines,
            answers: answers && typeof answers === 'object' ? answers : undefined,
            full: clamp(full, MAX_FULL),
          })
        } else if (part?.type === 'text' && !entry.isMeta) {
          const text = userText(part.text)
          if (text) blocks.push({ role: 'user', kind: 'text', at, text: clamp(text, MAX_TEXT) })
        }
      }
      return blocks
    }

    if (entry.type === 'assistant' && message && typeof message === 'object') {
      const blocks = []
      for (const part of Array.isArray(message.content) ? message.content : []) {
        if (part?.type === 'text') {
          if (part.text?.trim()) blocks.push({ role: 'assistant', kind: 'text', at, text: clamp(part.text, MAX_TEXT) })
        } else if (part?.type === 'thinking') {
          // The `signature` beside it is encrypted and meaningless to a reader;
          // never put it on screen. An empty `thinking` is the normal case.
          const text = typeof part.thinking === 'string' ? part.thinking.trim() : ''
          blocks.push({ role: 'assistant', kind: 'thinking', at, text: clamp(text, MAX_TEXT) })
        } else if (part?.type === 'tool_use') {
          const question = part.name === QUESTION_TOOL ? questionBlock(part.input) : null
          if (question) {
            blocks.push({ ...question, at, ref: part.id || null })
            continue
          }
          blocks.push({
            role: 'assistant',
            kind: 'tool',
            at,
            ref: part.id || null,
            tool: String(part.name || 'tool'),
            summary: summariseInput(part.name, part.input),
            full: clamp(JSON.stringify(part.input ?? {}, null, 2), MAX_FULL),
          })
        }
      }
      return blocks
    }

    return []
  },
}
