/**
 * The markdown parser, on the shapes an agent actually writes.
 *
 * No phone and no daemon in this one: the parser is plain functions over
 * strings, so the cases that used to be found by scrolling a transcript on a
 * sofa are found here instead. Node strips the TypeScript types for us.
 */
import { parseMarkdown, parseSpans, spansToText } from '../src/lib/markdown.ts'

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`)
}

const kinds = (blocks) => blocks.map((b) => b.kind).join(',')

/* ── blocks ──────────────────────────────────────────────────────────── */

{
  const blocks = parseMarkdown('# Title\n\nsome prose\n\n## Second')
  check('headings and prose split into blocks', kinds(blocks) === 'heading,paragraph,heading', kinds(blocks))
  check('heading level is the hash count', blocks[0].level === 1 && blocks[2].level === 2)
  check('heading text loses its hashes', spansToText(blocks[0].spans) === 'Title')
}

{
  const blocks = parseMarkdown('one\ntwo\n\nthree')
  check('a blank line ends a paragraph', blocks.length === 2, kinds(blocks))
  check('a soft break stays a break', spansToText(blocks[0].spans) === 'one\ntwo')
}

{
  const blocks = parseMarkdown('before\n\n```sh\nls -la | grep **not bold**\n```\n\nafter')
  check('a fence becomes one code block', kinds(blocks) === 'paragraph,code,paragraph', kinds(blocks))
  check('the language is kept', blocks[1].lang === 'sh')
  check('code is left exactly as written', blocks[1].text === 'ls -la | grep **not bold**', blocks[1].text)
}

{
  const blocks = parseMarkdown('```\nstill typing…')
  check('an unclosed fence is still code', kinds(blocks) === 'code' && blocks[0].text === 'still typing…')
}

{
  const blocks = parseMarkdown('> quoted\n> and on\n\nout')
  check('a quote gathers its lines', kinds(blocks) === 'quote,paragraph', kinds(blocks))
  check('a quote holds blocks', spansToText(blocks[0].blocks[0].spans) === 'quoted\nand on')
}

{
  const blocks = parseMarkdown('a\n\n---\n\nb')
  check('three dashes are a rule', kinds(blocks) === 'paragraph,rule,paragraph', kinds(blocks))
}

/* ── lists ───────────────────────────────────────────────────────────── */

{
  const [list] = parseMarkdown('- one\n- two\n- three')
  check('a bullet list keeps its items', list.kind === 'list' && list.items.length === 3, kinds([list]))
  check('items are unordered and unchecked', !list.ordered && list.items[0].checked === null)
  check('item text survives', spansToText(list.items[1].blocks[0].spans) === 'two')
}

{
  const [list] = parseMarkdown('3. third\n4. fourth')
  check('an ordered list starts where it says', list.ordered && list.start === 3, String(list.start))
}

{
  const [list] = parseMarkdown('- outer\n  - inner\n  - inner two\n- next')
  check('a nested list nests', list.items[0].blocks.length === 2 && list.items[0].blocks[1].kind === 'list')
  check('the outer list keeps its own items', list.items.length === 2, String(list.items.length))
}

{
  const [list] = parseMarkdown('- [x] done\n- [ ] not done')
  check('task boxes are read', list.items[0].checked === true && list.items[1].checked === false)
  check('the box is not left in the text', spansToText(list.items[0].blocks[0].spans) === 'done')
}

{
  const [list] = parseMarkdown('- item\n\n  its second paragraph\n\n- next')
  check('a loose item keeps its paragraphs', list.items[0].blocks.length === 2, kinds(list.items[0].blocks))
  check('the list is still one list', list.items.length === 2, String(list.items.length))
}

{
  const [list] = parseMarkdown('- run this:\n\n  ```sh\n  npm test\n  ```')
  const code = list.items[0].blocks[1]
  check('an indented fence inside an item is code', code?.kind === 'code' && code.text === 'npm test', code?.text)
}

/* ── tables ──────────────────────────────────────────────────────────── */

{
  const [table] = parseMarkdown('| file | state |\n| --- | ---: |\n| a.ts | ok |\n| b.ts | failed |')
  check('a table parses', table.kind === 'table' && table.rows.length === 2, kinds([table]))
  check('the header is read', spansToText(table.head[1]) === 'state')
  check('alignment is read off the dashes', table.align[1] === 'right', table.align.join(','))
  check('cells keep their text', spansToText(table.rows[1][0]) === 'b.ts')
}

{
  const blocks = parseMarkdown('a | b in prose\n\nnext')
  check('a pipe in prose is not a table', kinds(blocks) === 'paragraph,paragraph', kinds(blocks))
}

/* ── spans ───────────────────────────────────────────────────────────── */

const spanKinds = (src) => parseSpans(src).map((s) => s.kind).join(',')

check('bold is bold', spanKinds('a **b** c') === 'text,strong,text', spanKinds('a **b** c'))
check('italic is italic', spanKinds('a *b* c') === 'text,em,text', spanKinds('a *b* c'))
check('strikethrough is read', spanKinds('a ~~b~~') === 'text,strike', spanKinds('a ~~b~~'))
check('code wins over what is inside it', spanKinds('`a **b**`') === 'code', spanKinds('`a **b**`'))
check('a code span drops its backticks', parseSpans('`ls -la`')[0].text === 'ls -la')

check(
  'snake_case is left alone',
  spanKinds('some_variable_name here') === 'text',
  spanKinds('some_variable_name here'),
)
check('underscores around a word still italicise', spanKinds('an _emphatic_ word') === 'text,em,text')
check('__bold__ is bold', spanKinds('__loud__') === 'strong')

{
  const [span] = parseSpans('[the docs](https://example.com/x)')
  check('a link keeps href and label', span.kind === 'link' && span.href === 'https://example.com/x')
  check('link labels are text', spansToText([span]) === 'the docs')
}

{
  const spans = parseSpans('see https://example.com/a, then stop')
  const link = spans.find((s) => s.kind === 'link')
  check('a bare url becomes a link', Boolean(link) && link.href === 'https://example.com/a', link?.href)
}

{
  const [span] = parseSpans('![shot](/tmp/a.png)')
  check('an image falls back to its own caption', span.kind === 'link' && spansToText([span]) === 'shot')
}

check('an escaped star is a star', spansToText(parseSpans('2 \\* 3')) === '2 * 3', spansToText(parseSpans('2 \\* 3')))
check('a lone star is a star', spanKinds('a * b') === 'text', spanKinds('a * b'))
check('nesting works', spansToText(parseSpans('**bold with `code`**')) === 'bold with code')

/* ── the shapes that must not hang or throw ──────────────────────────── */

for (const nasty of ['', '   ', '*', '**', '```', '- ', '|', '#', '> ', '[](', '~~~', '1.', '`']) {
  let ok = true
  try {
    parseMarkdown(nasty)
  } catch (err) {
    ok = false
    check(`survives ${JSON.stringify(nasty)}`, false, err.message)
  }
  if (ok) check(`survives ${JSON.stringify(nasty)}`, true)
}

{
  const big = Array.from({ length: 400 }, (_, i) => `- item ${i} with **bold** and \`code\``).join('\n')
  const started = Date.now()
  const [list] = parseMarkdown(big)
  const took = Date.now() - started
  check('a long list parses whole and fast', list.items.length === 400 && took < 500, `${took}ms`)
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
