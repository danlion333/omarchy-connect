/**
 * What a long conversation costs the phone.
 *
 * The chat screen used to keep every block of a session for as long as it was
 * open, re-pair every tool result against a reversed copy of the whole list on
 * every recompute, and hand React a new object for every row on every draft
 * frame — three separate ways for a transcript to get slower the longer you
 * used it. None of the three is visible from the outside until it is bad, and
 * by then it is a phone that stutters rather than a test that fails.
 *
 * So all three are arithmetic in `src/lib/transcript.ts` and all three are
 * checked here. The cap is a length. The pairing is held against a copy of the
 * quadratic version that used to ship — same answers, and a growth curve that
 * is a line rather than a parabola. And the redraw is checked the way
 * `rerender.mjs` checks the context slices: through identities, by asking the
 * comparators React is given whether a row already on screen changed, rather
 * than by mounting a tree and testing React.
 *
 * No phone and no daemon in this one; Node strips the TypeScript for us.
 */
import { MAX_BLOCKS, capBlocks, groupBlocks, sameMarkdown, sameRow, sameToolRun } from '../src/lib/transcript.ts'
import { check, done } from '../../tools/test-harness.mjs'

/* ── a transcript that looks like one ───────────────────────────────────── */

let seq = 0
const text = (role = 'assistant') => ({ seq: ++seq, role, kind: 'text', at: seq, text: `line ${seq}` })
const thinking = (body) => ({ seq: ++seq, role: 'assistant', kind: 'thinking', at: seq, text: body })
const tool = (ref) => ({ seq: ++seq, role: 'assistant', kind: 'tool', at: seq, tool: 'Read', ref })
const question = (ref) => ({ seq: ++seq, role: 'assistant', kind: 'question', at: seq, ref, questions: [] })
const result = (ref) => ({ seq: ++seq, role: 'system', kind: 'result', at: seq, ref, summary: `done ${ref}` })

/** The shape an agent actually produces: prose, thinking, a run of calls. */
function transcript(n) {
  const blocks = []
  while (blocks.length < n) {
    blocks.push(text('user'), text(), thinking('mm'), thinking(''))
    const ref = `r${blocks.length}`
    blocks.push(tool(ref), result(ref), tool(`${ref}b`), result(`${ref}b`))
  }
  return blocks.slice(0, n)
}

/* ── the version that used to ship, kept as the oracle ──────────────────── */

function groupBlocksQuadratic(blocks) {
  const rows = []
  for (const block of blocks) {
    if (block.kind === 'result') {
      const parent = [...rows]
        .reverse()
        .find((r) => (r.block.kind === 'tool' || r.block.kind === 'question') && r.block.ref === block.ref && !r.result)
      if (parent) {
        parent.result = block
        continue
      }
    }
    rows.push({ block })
  }
  const out = []
  for (const row of rows) {
    if (row.block.kind === 'thinking' && !row.block.text) continue
    if (row.block.kind === 'tool') {
      const last = out[out.length - 1]
      if (last && last.kind === 'tools') {
        last.rows.push(row)
        continue
      }
      out.push({ kind: 'tools', seq: row.block.seq, rows: [row] })
      continue
    }
    out.push({ kind: 'row', seq: row.block.seq, row })
  }
  return out
}

/** Groups compared by what they would draw, not by object identity. */
const shape = (groups) =>
  JSON.stringify(
    groups.map((g) =>
      g.kind === 'tools'
        ? ['tools', g.seq, g.rows.map((r) => [r.block.seq, r.result?.seq ?? null])]
        : ['row', g.seq, [[g.row.block.seq, g.row.result?.seq ?? null]]],
    ),
  )

/* ── the window ─────────────────────────────────────────────────────────── */

{
  // The screen's own arithmetic: what it holds is what the last frame left it
  // plus what arrived, capped. Five thousand blocks in frames of ten, which is
  // an afternoon of one session.
  let held = []
  const all = transcript(5000)
  for (let i = 0; i < all.length; i += 10) held = capBlocks([...held, ...all.slice(i, i + 10)])

  check(`5000 blocks leave at most ${MAX_BLOCKS} on the screen`, held.length <= MAX_BLOCKS, `held ${held.length}`)
  check('the newest block is one of them', held[held.length - 1].seq === all[all.length - 1].seq)
  check(
    'and so is the whole tail below the cap',
    held.slice(-50).every((b, i) => b.seq === all.slice(-50)[i].seq),
  )
  const small = all.slice(0, 40)
  check('a transcript inside the window comes back as the same array', capBlocks(small) === small)
}

{
  // The head is where the orphans come from: cut between a call and its
  // result and the result is left describing nothing, which is the defect #26
  // was about, reached from the other side.
  const blocks = [tool('a'), result('a'), tool('b'), result('b'), text()]
  check('a cut that falls between two pairs keeps both blocks of the last one',
    capBlocks(blocks, 3).map((b) => b.kind).join(',') === 'tool,result,text')
  const orphaned = capBlocks(blocks, 2)
  check('a cut that falls inside a pair drops the widowed result',
    orphaned.map((b) => b.kind).join(',') === 'text', JSON.stringify(orphaned.map((b) => b.kind)))
  check('so nothing is left in the window that draws as an orphan',
    !groupBlocks(orphaned).some((g) => g.kind === 'row' && g.row.block.kind === 'result'))
  const grouped = groupBlocks(capBlocks([tool('c'), result('c'), text(), tool('d')], 3))
  check('a call whose result has not landed yet survives the cut', shape(grouped).includes('tools'))
}

/* ── the pairing ────────────────────────────────────────────────────────── */

{
  const cases = {
    'a plain conversation': transcript(400),
    'a call still waiting for its result': [tool('a'), text(), tool('b')],
    'two calls sharing one ref': [tool('a'), tool('a'), result('a'), result('a')],
    'a result nothing asked for': [text(), result('gone')],
    'a question and its answer': [question('q'), result('q'), text()],
    'refs that are absent or null': [
      { seq: 1, role: 'assistant', kind: 'tool', at: 1, tool: 'Read' },
      { seq: 2, role: 'assistant', kind: 'tool', at: 2, tool: 'Read', ref: null },
      { seq: 3, role: 'system', kind: 'result', at: 3, ref: null, summary: 'x' },
      { seq: 4, role: 'system', kind: 'result', at: 4, summary: 'y' },
    ],
    'empty': [],
  }
  for (const [name, blocks] of Object.entries(cases)) {
    check(`grouping is unchanged for ${name}`, shape(groupBlocks(blocks)) === shape(groupBlocksQuadratic(blocks)))
  }
}

{
  // Ten times the blocks for something like ten times the work. The old
  // pairing copied and walked the whole row list per result, so the same step
  // cost it about a hundred times as much; anything under a small multiple of
  // ten is a line, and the bound is loose enough that a busy laptop cannot
  // fail it by being busy.
  const time = (blocks) => {
    let best = Infinity
    for (let i = 0; i < 5; i++) {
      const t = process.hrtime.bigint()
      groupBlocks(blocks)
      const spent = Number(process.hrtime.bigint() - t) / 1e6
      if (spent < best) best = spent
    }
    return Math.max(best, 0.05)
  }
  const small = transcript(500)
  const large = transcript(5000)
  time(small) // warm the JIT on both shapes before either is measured
  time(large)
  const ratio = time(large) / time(small)
  check(`10× the blocks costs about 10× the grouping, not 100× (×${ratio.toFixed(1)})`, ratio < 30)
  check(
    'and 5000 blocks group in a few milliseconds',
    time(large) < 50,
    `${time(large).toFixed(2)}ms`,
  )
}

/* ── the redraw ─────────────────────────────────────────────────────────── */

{
  // What a frame does to the screen: the blocks it already had, then the same
  // blocks with one more on the end. Every group that was on screen before
  // must come back saying it has not changed — that is the memo skipping it.
  const before = transcript(200)
  const after = [...before, text()]
  const onExpand = () => {}
  const onAnswer = async () => ({ labels: [] })
  const expanded = {}
  const session = { id: 's' }

  const was = groupBlocks(before)
  const now = groupBlocks(after)
  const props = (groups, i) =>
    groups[i].kind === 'tools'
      ? { rows: groups[i].rows, live: i === groups.length - 1, expanded, onExpand }
      : {
          session,
          block: groups[i].row.block,
          result: groups[i].row.result,
          expanded: expanded[groups[i].row.block.seq],
          onExpand,
          onAnswer,
        }

  // The last group before the append is the one the new block may have joined,
  // and the one whose `live` flag moves off it; everything before it is settled
  // history and must be untouched.
  let same = 0
  let moved = 0
  for (let i = 0; i < was.length - 1; i++) {
    const a = props(was, i)
    const b = props(now, i)
    const equal = was[i].kind === 'tools' ? sameToolRun(a, b) : sameRow(a, b)
    equal ? same++ : moved++
  }
  check('appending a block leaves every settled group with the props it had', moved === 0, `${same} unchanged`)
  check('there were enough of them for that to mean something', same > 50, `${same} groups`)

  // A draft frame is not a block at all: it never reaches `blocks`, so the
  // groups it re-renders are the same objects and every comparator agrees.
  const draftAgain = groupBlocks(before)
  let redrawn = 0
  for (let i = 0; i < was.length; i++) {
    const a = props(was, i)
    const b = props(draftAgain, i)
    if (!(was[i].kind === 'tools' ? sameToolRun(a, b) : sameRow(a, b))) redrawn++
  }
  check('a draft frame redraws no row of the transcript at all', redrawn === 0, `${redrawn} would redraw`)

  // And the things a memo must not skip.
  check(
    'a row whose block changed is redrawn',
    !sameRow(props(was, 1), { ...props(was, 1), block: text() }),
  )
  check(
    'a row whose expansion opened is redrawn',
    !sameRow(props(was, 1), { ...props(was, 1), expanded: 'the full output' }),
  )
  const run = was.find((g) => g.kind === 'tools')
  check(
    'a run that gained a call is redrawn',
    !sameToolRun(
      { rows: run.rows, live: false, expanded, onExpand },
      { rows: [...run.rows, { block: tool('new') }], live: false, expanded, onExpand },
    ),
  )
  check(
    'a run whose call finally got its result is redrawn',
    !sameToolRun(
      { rows: [{ block: run.rows[0].block }], live: false, expanded, onExpand },
      { rows: [{ block: run.rows[0].block, result: result('x') }], live: false, expanded, onExpand },
    ),
  )
  check(
    'the run at the end stops being live when it is no longer at the end',
    !sameToolRun({ rows: run.rows, live: true, expanded, onExpand }, { rows: run.rows, live: false, expanded, onExpand }),
  )
}

{
  check('the same markdown is not parsed again', sameMarkdown({ text: '# a' }, { text: '# a' }))
  check('text that changed is', !sameMarkdown({ text: '# a' }, { text: '# b' }))
  check('and so is a change of tone', !sameMarkdown({ text: '# a', tone: '#fff' }, { text: '# a', tone: '#000' }))
}

done('transcript checks')
