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
 * The interface is deliberately small — `detect`, `transcripts`, `parse` — so
 * a second agent costs a file rather than a redesign. Tailing is not in here:
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

export default {
  id: 'claude',
  label: 'Claude Code',
  binaries: ['claude'],

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

  /** The native session id a transcript path stands for. */
  sessionIdFor(transcript) {
    return path.basename(String(transcript || ''), '.jsonl')
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
          blocks.push({
            role: 'user',
            kind: 'result',
            at,
            ref: part.tool_use_id || null,
            status: interrupted ? 'interrupted' : part.is_error ? 'error' : 'ok',
            summary,
            lines,
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
