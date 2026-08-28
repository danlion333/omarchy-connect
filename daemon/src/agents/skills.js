import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * What this desktop's agent can be *told to do* by name.
 *
 * A phone has no keyboard worth typing `/security-review` on, and the whole
 * point of a slash command is that its name is short and its behaviour is
 * long. So the names are read off disk here and offered as a list: tap one and
 * the composer already holds the command, with the description beside it so
 * the choice is made before the send rather than after.
 *
 * Three kinds share one shape because on the phone they are one list:
 *
 *   - **Skills** are directories with a `SKILL.md` in them, and the file's
 *     front matter is the name and the description. Claude Code reads them
 *     from `~/.claude/skills` and from `<project>/.claude/skills`, and a
 *     project's own skill shadows a user one of the same name.
 *   - **Commands** are bare `.md` files under `commands/`, nested directories
 *     becoming a `dir:name` prefix the same way the CLI spells them.
 *   - **Built-ins** are the handful the CLI itself answers, and they are a
 *     short curated list rather than everything: `/compact` and `/model` are
 *     worth a thumb from the sofa, `/vim` is not.
 *
 * Nothing here executes anything. It reads names, and the phone types one.
 */

const HOME = os.homedir()

/** Enough of a `SKILL.md` to hold its front matter; the body is not our business. */
const HEAD_BYTES = 8 * 1024
/** A description is a subtitle on a phone row, not a paragraph. */
const MAX_DESCRIPTION = 300
/** A directory of skills, at most. Past this something is wrong with the disk. */
const MAX_ENTRIES = 200
/** How deep a `commands/` tree is walked. Two is what the CLI itself allows. */
const MAX_DEPTH = 2

/**
 * The commands the CLI answers itself, and that are worth a tap.
 *
 * Curated rather than complete. The test each one had to pass is whether a
 * person holding a phone, away from the desk, would ever want it: compacting a
 * conversation that has run long, changing the model because the cheap one is
 * struggling, asking what the context is costing. `/vim`, `/theme` and
 * `/terminal-setup` are for someone sitting at the keyboard, so they are not
 * here.
 */
const BUILTIN = [
  { name: 'compact', description: 'Summarise the conversation so far and free the context it was using', args: '[focus]' },
  { name: 'context', description: 'What is in the context window right now, and what it is costing' },
  { name: 'cost', description: 'Tokens and money spent in this session' },
  { name: 'status', description: 'Model, account, limits and what this session is configured with' },
  { name: 'model', description: 'Change the model for this session', args: '[opus|sonnet|haiku]' },
  { name: 'clear', description: 'Throw away the conversation and start fresh in the same directory' },
  { name: 'todos', description: 'The task list this session is working through' },
  { name: 'memory', description: 'Read and edit the memory files this project loads' },
  { name: 'agents', description: 'Background agents running under this CLI' },
  { name: 'export', description: 'Write this conversation out to a file' },
  { name: 'rewind', description: 'Put the code and the conversation back to an earlier turn' },
  { name: 'help', description: 'Everything the CLI answers' },
]

const oneLine = (value, max = MAX_DESCRIPTION) => {
  const text = String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

/** The first few kilobytes of a file, or null if it is not one we can read. */
function head(file) {
  let fd
  try {
    fd = fs.openSync(file, 'r')
    const buf = Buffer.allocUnsafe(HEAD_BYTES)
    const read = fs.readSync(fd, buf, 0, HEAD_BYTES, 0)
    return buf.subarray(0, read).toString('utf8')
  } catch {
    return null
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
  }
}

/**
 * The `key: value` pairs at the top of a markdown file, between two `---`.
 *
 * Not a YAML parser and not pretending to be one: front matter here is flat,
 * and the only shape past `key: value` that appears in practice is a folded
 * block — `description: >` with the text indented under it. Anything more
 * exotic is read as far as it makes sense and no further, because a skill that
 * loses its description is a row with a name on it rather than a crash.
 */
function frontmatter(text) {
  if (!text || !text.startsWith('---')) return {}
  const end = text.indexOf('\n---', 3)
  if (end < 0) return {}
  const fields = {}
  let key = null
  let folded = []
  const commit = () => {
    if (key && folded.length) fields[key] = folded.join(' ').trim()
    folded = []
  }
  for (const line of text.slice(text.indexOf('\n') + 1, end).split('\n')) {
    const match = /^([A-Za-z][\w-]*):\s?(.*)$/.exec(line)
    if (match) {
      commit()
      key = match[1]
      const value = match[2].trim()
      // `>` and `|` say the value is the indented block underneath.
      if (value && value !== '>' && value !== '|' && value !== '>-' && value !== '|-') {
        fields[key] = value.replace(/^["']|["']$/g, '')
        key = null
      }
      continue
    }
    if (key && line.trim()) folded.push(line.trim())
  }
  commit()
  return fields
}

/** One skill directory → the row a phone draws for it, or null if it is not one. */
function readSkill(dir, name, scope) {
  const text = head(path.join(dir, name, 'SKILL.md'))
  if (text === null) return null
  const fields = frontmatter(text)
  return {
    kind: 'skill',
    name: oneLine(fields.name || name, 80),
    description: oneLine(fields.description),
    scope,
  }
}

function readSkillDir(dir, scope) {
  let names = []
  try {
    names = fs.readdirSync(dir).slice(0, MAX_ENTRIES)
  } catch {
    return []
  }
  return names.map((name) => readSkill(dir, name, scope)).filter(Boolean)
}

/**
 * Every `.md` under a commands directory, spelled the way the CLI spells it.
 *
 * A nested directory is a namespace: `commands/git/sync.md` is `/git:sync`.
 * The walk is bounded because a `commands/` symlinked at its own parent would
 * otherwise be a directory tree with no bottom.
 */
function readCommandDir(dir, scope, prefix = '', depth = 0) {
  if (depth > MAX_DEPTH) return []
  let items = []
  try {
    items = fs.readdirSync(dir, { withFileTypes: true }).slice(0, MAX_ENTRIES)
  } catch {
    return []
  }
  const out = []
  for (const item of items) {
    if (item.isDirectory()) {
      out.push(...readCommandDir(path.join(dir, item.name), scope, `${prefix}${item.name}:`, depth + 1))
      continue
    }
    if (!item.name.endsWith('.md')) continue
    const fields = frontmatter(head(path.join(dir, item.name)) || '')
    out.push({
      kind: 'command',
      name: `${prefix}${item.name.slice(0, -3)}`,
      description: oneLine(fields.description || fields.name || ''),
      scope,
      args: fields['argument-hint'] ? oneLine(fields['argument-hint'], 60) : undefined,
    })
  }
  return out
}

/**
 * Skills a plugin brought with it.
 *
 * A marketplace on disk is not the same thing as a plugin in use — this
 * desktop has thirty-nine of them cloned and none of them enabled — so the
 * enabled list is what decides, and a desktop with no such list has no plugin
 * skills rather than all of them.
 */
function pluginSkills() {
  let config
  try {
    config = JSON.parse(fs.readFileSync(path.join(HOME, '.claude.json'), 'utf8'))
  } catch {
    return []
  }
  const enabled = config?.enabledPlugins
  if (!enabled || typeof enabled !== 'object') return []

  const out = []
  for (const [key, on] of Object.entries(enabled)) {
    if (on === false) continue
    // `plugin@marketplace` is how the CLI names one.
    const [plugin, marketplace] = String(key).split('@')
    if (!plugin || !marketplace) continue
    const dir = path.join(HOME, '.claude', 'plugins', 'marketplaces', marketplace, 'plugins', plugin, 'skills')
    for (const skill of readSkillDir(dir, 'plugin')) {
      out.push({ ...skill, name: `${plugin}:${skill.name}` })
    }
  }
  return out
}

/** The directories that answer the question, in the order that shadows correctly. */
const sources = (cwd) => [
  { dir: path.join(HOME, '.claude', 'skills'), scope: 'user', read: readSkillDir },
  { dir: path.join(HOME, '.claude', 'commands'), scope: 'user', read: readCommandDir },
  ...(cwd
    ? [
        { dir: path.join(cwd, '.claude', 'skills'), scope: 'project', read: readSkillDir },
        { dir: path.join(cwd, '.claude', 'commands'), scope: 'project', read: readCommandDir },
      ]
    : []),
]

/**
 * Remembered per directory, because this is asked every time a phone opens the
 * sheet and the answer changes about as often as somebody writes a new skill.
 *
 * The stamp is the mtime of every directory that fed the answer, so a skill
 * added while the daemon runs turns up without a restart — a new file changes
 * the mtime of the directory holding it.
 */
const cache = new Map()
const CACHE_MAX = 32

const stampOf = (dirs) =>
  dirs
    .map((dir) => {
      try {
        return `${dir}:${fs.statSync(dir).mtimeMs}`
      } catch {
        return `${dir}:-`
      }
    })
    .join('|')

/**
 * Everything this desktop could be asked to run by name, for one directory.
 *
 * Project entries come last in the merge and win, which is the shadowing the
 * CLI itself does: a project that ships its own `review` skill means that one.
 */
export function list(cwd = null) {
  const where = sources(cwd)
  const key = cwd || '~'
  const stamp = stampOf([...where.map((s) => s.dir), path.join(HOME, '.claude.json')])
  const hit = cache.get(key)
  if (hit && hit.stamp === stamp) return hit.value

  const byName = new Map()
  for (const entry of pluginSkills()) byName.set(`${entry.kind}:${entry.name}`, entry)
  for (const { dir, scope, read } of where) {
    for (const entry of read(dir, scope)) byName.set(`${entry.kind}:${entry.name}`, entry)
  }

  const value = {
    skills: [...byName.values()].filter((e) => e.kind === 'skill').sort((a, b) => a.name.localeCompare(b.name)),
    commands: [...byName.values()].filter((e) => e.kind === 'command').sort((a, b) => a.name.localeCompare(b.name)),
    builtins: BUILTIN.map((entry) => ({ kind: 'builtin', scope: 'builtin', ...entry })),
  }
  if (cache.size >= CACHE_MAX) cache.clear()
  cache.set(key, { stamp, value })
  return value
}

/**
 * Is this a name we just offered?
 *
 * The phone sends the name back and the daemon types `/name` into a terminal,
 * so the name has to be one of ours rather than whatever arrived — a slash
 * command is a line of text in front of an agent that runs what it is told,
 * and `/../../` is not a skill. Checking against the list we published is a
 * stronger answer than a regex over the characters in it.
 */
export function known(cwd, name) {
  const wanted = String(name || '').trim()
  if (!wanted) return false
  const { skills, commands, builtins } = list(cwd)
  return [...skills, ...commands, ...builtins].some((entry) => entry.name === wanted)
}
