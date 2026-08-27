/**
 * Markdown, in the amount an agent actually writes.
 *
 * An agent answering on a phone writes headings, bullets, tables and fenced
 * code — and almost nothing else. So this is a parser for that dialect rather
 * than for CommonMark: no HTML, no reference links, no footnotes, none of the
 * corners a spec has to cover and a transcript never reaches. It is a couple
 * of hundred lines instead of a dependency, and it stays honest about what it
 * does not handle by leaving unrecognised punctuation as the text it was.
 *
 * Parsing lives here, apart from the drawing, because a parser is the half
 * that can be tested without a phone in the room — see `test/markdown.mjs`.
 */

export type Align = 'left' | 'center' | 'right'

export type Span =
  | { kind: 'text'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'strong'; spans: Span[] }
  | { kind: 'em'; spans: Span[] }
  | { kind: 'strike'; spans: Span[] }
  | { kind: 'link'; href: string; spans: Span[] }

/** `checked` is null on an ordinary bullet and a boolean on a task list. */
export type ListItem = { checked: boolean | null; blocks: Block[] }

export type Block =
  | { kind: 'paragraph'; spans: Span[] }
  | { kind: 'heading'; level: number; spans: Span[] }
  | { kind: 'code'; lang: string; text: string }
  | { kind: 'quote'; blocks: Block[] }
  | { kind: 'list'; ordered: boolean; start: number; items: ListItem[] }
  | { kind: 'rule' }
  | { kind: 'table'; head: Span[][]; rows: Span[][][]; align: Align[] }

/* ── blocks ──────────────────────────────────────────────────────────── */

const FENCE = /^(\s{0,3})(```|~~~)\s*([^\s`]*)/
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/
const RULE = /^\s{0,3}([-*_])[ \t]*(?:\1[ \t]*){2,}$/
const QUOTE = /^\s{0,3}>[ \t]?(.*)$/
const BULLET = /^(\s*)([-*+])([ \t]+)(.*)$/
const ORDERED = /^(\s*)(\d{1,9})([.)])([ \t]+)(.*)$/
const TASK = /^\[([ xX])\][ \t]+(.*)$/

export function parseMarkdown(src: string): Block[] {
  return parseBlocks(String(src ?? '').replace(/\r\n?/g, '\n').split('\n'))
}

function parseBlocks(lines: string[]): Block[] {
  const out: Block[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]

    if (!line.trim()) {
      i += 1
      continue
    }

    const fence = FENCE.exec(line)
    if (fence) {
      const [, indent, marker, lang] = fence
      const body: string[] = []
      i += 1
      while (i < lines.length && !closesFence(lines[i], marker)) {
        body.push(lines[i])
        i += 1
      }
      // An unclosed fence is a message still being written, not a mistake:
      // everything after it is code until the agent says otherwise.
      if (i < lines.length) i += 1
      out.push({ kind: 'code', lang, text: body.map((l) => strip(l, indent.length)).join('\n') })
      continue
    }

    const heading = HEADING.exec(line)
    if (heading) {
      out.push({ kind: 'heading', level: heading[1].length, spans: parseSpans(heading[2]) })
      i += 1
      continue
    }

    if (RULE.test(line)) {
      out.push({ kind: 'rule' })
      i += 1
      continue
    }

    if (QUOTE.test(line)) {
      const body: string[] = []
      while (i < lines.length) {
        const quoted = QUOTE.exec(lines[i])
        if (quoted) {
          body.push(quoted[1])
          i += 1
          continue
        }
        // A quote runs on across a line that forgot its marker, the way it
        // does everywhere else, but stops at a blank one.
        if (!lines[i].trim() || startsBlock(lines[i])) break
        body.push(lines[i])
        i += 1
      }
      out.push({ kind: 'quote', blocks: parseBlocks(body) })
      continue
    }

    if (opensTable(lines, i)) {
      const head = splitRow(line).map(parseSpans)
      const align = splitRow(lines[i + 1]).map(alignOf)
      i += 2
      const rows: Span[][][] = []
      while (i < lines.length && lines[i].trim() && lines[i].includes('|') && !startsBlock(lines[i])) {
        rows.push(splitRow(lines[i]).map(parseSpans))
        i += 1
      }
      out.push({ kind: 'table', head, rows, align })
      continue
    }

    if (BULLET.test(line) || ORDERED.test(line)) {
      const [list, next] = parseList(lines, i)
      out.push(list)
      i = next
      continue
    }

    const paragraph: string[] = []
    while (i < lines.length && lines[i].trim() && !startsBlock(lines[i]) && !opensTable(lines, i)) {
      paragraph.push(lines[i].replace(/\s+$/, ''))
      i += 1
    }
    // Soft line breaks are kept rather than folded into spaces. An agent
    // laying out three short lines meant three lines, and a phone reflows
    // them anyway the moment they are too long for the width.
    out.push({ kind: 'paragraph', spans: parseSpans(paragraph.join('\n')) })
  }

  return out
}

const closesFence = (line: string, marker: string) => {
  const trimmed = line.trim()
  return trimmed.startsWith(marker) && trimmed.replace(marker[0] === '`' ? /`/g : /~/g, '') === ''
}

const strip = (line: string, indent: number) => {
  let cut = 0
  while (cut < indent && (line[cut] === ' ' || line[cut] === '\t')) cut += 1
  return line.slice(cut)
}

const startsBlock = (line: string) =>
  FENCE.test(line) || HEADING.test(line) || RULE.test(line) || QUOTE.test(line) || BULLET.test(line) || ORDERED.test(line)

/**
 * A list, and everything that belongs to its items.
 *
 * The rule that does the work is the content column: whatever sits under the
 * first character after the marker belongs to that item, however many
 * paragraphs, code blocks or deeper lists it turns out to be. That is what
 * makes a nested list nested rather than a sibling with odd spacing.
 */
function parseList(lines: string[], from: number): [Block, number] {
  const first = (BULLET.exec(lines[from]) || ORDERED.exec(lines[from])) as RegExpExecArray
  const ordered = !BULLET.test(lines[from])
  const base = first[1].length
  const start = ordered ? Number(first[2]) : 1

  const items: ListItem[] = []
  let body: string[] = []
  let column = 0
  let i = from

  const close = () => {
    if (!items.length) return
    const raw = body
    const task = TASK.exec(raw[0] ?? '')
    if (task) raw[0] = task[2]
    items[items.length - 1] = {
      checked: task ? task[1].toLowerCase() === 'x' : null,
      blocks: parseBlocks(raw),
    }
    body = []
  }

  while (i < lines.length) {
    const line = lines[i]
    const marker = BULLET.exec(line) || ORDERED.exec(line)

    if (marker && marker[1].length <= base + 1 && Boolean(BULLET.exec(line)) !== ordered) {
      close()
      items.push({ checked: null, blocks: [] })
      body = [marker[marker.length - 1]]
      column = marker[1].length + marker[2].length + marker[3].length
      i += 1
      continue
    }

    if (!line.trim()) {
      // A blank line ends the list unless something indented follows it — a
      // list with paragraphs in it is still one list.
      const after = lines[i + 1]
      if (after === undefined || !after.trim()) break
      if (indentOf(after) < column && !BULLET.test(after) && !ORDERED.test(after)) break
      body.push('')
      i += 1
      continue
    }

    if (indentOf(line) >= column) {
      body.push(strip(line, column))
      i += 1
      continue
    }

    // An unindented line that could not start a block of its own is the rest
    // of the sentence the item was in the middle of.
    if (!startsBlock(line) && body.length && body[body.length - 1].trim()) {
      body.push(line.trim())
      i += 1
      continue
    }

    break
  }

  close()
  return [{ kind: 'list', ordered, start, items }, i]
}

const indentOf = (line: string) => (/^\s*/.exec(line) as RegExpExecArray)[0].length

/* ── tables ──────────────────────────────────────────────────────────── */

/** A table is only a table once the row of dashes under its header says so. */
const opensTable = (lines: string[], i: number) =>
  lines[i].includes('|') && i + 1 < lines.length && isDelimiter(lines[i + 1])

const isDelimiter = (line: string) => {
  const cells = splitRow(line)
  return cells.length > 0 && line.includes('-') && cells.every((cell) => /^:?-+:?$/.test(cell.trim()))
}

const alignOf = (cell: string): Align => {
  const trimmed = cell.trim()
  const left = trimmed.startsWith(':')
  const right = trimmed.endsWith(':')
  return left && right ? 'center' : right ? 'right' : 'left'
}

/** Splits on the pipes that divide cells, leaving the escaped ones alone. */
function splitRow(line: string): string[] {
  const cells: string[] = []
  let cell = ''
  let i = 0
  const trimmed = line.trim()
  const body = trimmed.replace(/^\|/, '').replace(/\|$/, '')
  while (i < body.length) {
    if (body[i] === '\\' && body[i + 1] === '|') {
      cell += '|'
      i += 2
      continue
    }
    if (body[i] === '|') {
      cells.push(cell.trim())
      cell = ''
      i += 1
      continue
    }
    cell += body[i]
    i += 1
  }
  cells.push(cell.trim())
  return cells
}

/* ── spans ───────────────────────────────────────────────────────────── */

const PUNCT = /[\\`*_{}[\]()#+\-.!~|>]/
const wordish = (ch: string | undefined) => Boolean(ch) && /[\w]/.test(ch as string)

/**
 * Inline markup, scanned left to right.
 *
 * Order matters more than cleverness here: a code span wins over everything
 * inside it, which is the only reason `**` in a shell snippet survives the
 * trip. Underscores are held to a word boundary on both ends, because
 * `some_variable_name` is far more common in an agent's prose than an
 * underscore-italicised word, and getting that backwards mangles identifiers.
 */
export function parseSpans(src: string): Span[] {
  const out: Span[] = []
  let buf = ''
  let i = 0

  const flush = () => {
    if (buf) out.push({ kind: 'text', text: buf })
    buf = ''
  }
  const take = (span: Span, length: number) => {
    flush()
    out.push(span)
    i += length
  }

  while (i < src.length) {
    const ch = src[i]
    const rest = src.slice(i)
    let m: RegExpExecArray | null

    if (ch === '\\' && PUNCT.test(src[i + 1] ?? '')) {
      buf += src[i + 1]
      i += 2
      continue
    }

    if (ch === '`' && (m = /^(`+)([\s\S]*?[^`])\1(?!`)/.exec(rest))) {
      take({ kind: 'code', text: m[2].trim() }, m[0].length)
      continue
    }

    if ((ch === '[' || ch === '!') && (m = /^!?\[([^\]]*)\]\([ \t]*<?([^)\s>]*)>?(?:[ \t]+"[^"]*")?[ \t]*\)/.exec(rest))) {
      // A picture cannot be fetched from here — the desktop is the only thing
      // that can see that path — so an image becomes its own caption.
      const href = m[2]
      take(
        href ? { kind: 'link', href, spans: parseSpans(m[1]) } : { kind: 'text', text: m[1] },
        m[0].length,
      )
      continue
    }

    if (ch === '<' && (m = /^<((?:https?|mailto):[^>\s]+)>/.exec(rest))) {
      take({ kind: 'link', href: m[1], spans: [{ kind: 'text', text: m[1] }] }, m[0].length)
      continue
    }

    if (ch === '*' && (m = /^\*\*(?=[^\s*])([\s\S]*?[^\s*])\*\*/.exec(rest))) {
      take({ kind: 'strong', spans: parseSpans(m[1]) }, m[0].length)
      continue
    }

    if (ch === '_' && !wordish(src[i - 1]) && (m = /^__(?=\S)([\s\S]*?\S)__/.exec(rest)) && !wordish(src[i + m[0].length])) {
      take({ kind: 'strong', spans: parseSpans(m[1]) }, m[0].length)
      continue
    }

    if (ch === '~' && (m = /^~~(?=\S)([\s\S]*?\S)~~/.exec(rest))) {
      take({ kind: 'strike', spans: parseSpans(m[1]) }, m[0].length)
      continue
    }

    if (ch === '*' && (m = /^\*(?=[^\s*])([\s\S]*?[^\s*])\*(?!\*)/.exec(rest))) {
      take({ kind: 'em', spans: parseSpans(m[1]) }, m[0].length)
      continue
    }

    if (ch === '_' && !wordish(src[i - 1]) && (m = /^_(?=\S)([\s\S]*?\S)_(?!_)/.exec(rest)) && !wordish(src[i + m[0].length])) {
      take({ kind: 'em', spans: parseSpans(m[1]) }, m[0].length)
      continue
    }

    if ((ch === 'h' || ch === 'w') && (m = /^(https?:\/\/|www\.)[^\s<>"'`)\]]+/.exec(rest))) {
      // Trailing punctuation belongs to the sentence, not to the address.
      const href = m[0].replace(/[.,;:!?]+$/, '')
      take({ kind: 'link', href: href.startsWith('w') ? `https://${href}` : href, spans: [{ kind: 'text', text: href }] }, href.length)
      continue
    }

    buf += ch
    i += 1
  }

  flush()
  return out
}

/** The text a span tree carries, with the markup taken back out. */
export function spansToText(spans: Span[]): string {
  return spans
    .map((span) => (span.kind === 'text' || span.kind === 'code' ? span.text : spansToText(span.spans)))
    .join('')
}
