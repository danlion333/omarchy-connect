/**
 * The transcript, as arithmetic.
 *
 * A chat screen holds a conversation that only ever grows, and everything it
 * does with that conversation it does again on every frame the desktop sends —
 * and the desktop sends a frame of the sentence the agent is typing about
 * twice a second. So the two expensive things a long session does live here
 * rather than inside the screen: how much of the transcript is kept, and how
 * the kept part is arranged into rows. Both are plain functions over plain
 * objects, which is what lets `app/test/transcript.mjs` hold them to a bound
 * instead of a sofa and a stopwatch.
 *
 * The third expense — React drawing every row again because a draft landed —
 * is answered from here too, by the `same*` comparators the screen hands to
 * `React.memo`. A prop comparison is not something a suite can watch happening
 * inside React, but it is exactly the arithmetic React would do, so the suite
 * does it instead: append a block, group again, and ask each comparator
 * whether the rows already on screen changed. `app/test/rerender.mjs` makes
 * the same argument about context slices.
 */
import type { AgentBlock, AgentSession } from '../api/client'

/**
 * How many blocks a screen keeps.
 *
 * The desktop opens a session with a window of 120 and pushes from there, so
 * this is not the size of what arrives — it is the ceiling on what a session
 * left open all afternoon can grow into. Four hundred is a few screens'
 * worth of scrollback past anything anyone reaches back for, and it is the
 * same shape of answer as `MAX_CLIPBOARD_EVENTS` and `MAX_FILE_EVENTS`: a ring
 * with the newest end kept, because the newest end is the one being read.
 */
export const MAX_BLOCKS = 400

/** What ties a result to the call it answers, as the desktop spells it. */
type Ref = AgentBlock['ref']

export type ChatRow = { block: AgentBlock; result?: AgentBlock }
export type Group =
  | { kind: 'tools'; seq: number; rows: ChatRow[] }
  | { kind: 'row'; seq: number; row: ChatRow }

/**
 * The tail of the transcript, at most `max` blocks long.
 *
 * Trimming the head is not a slice, because a tool call and its result are two
 * blocks and one thing on screen: cut between them and `groupBlocks` finds a
 * `result` whose `tool` is gone and draws it as a bare summary line with no
 * idea what it was the result of — the orphan of issue #26, arrived by a
 * different road. So a result whose parent did not survive the cut is dropped
 * with it. Nothing else is touched, and a transcript that is still inside the
 * window comes back as the very same array, so a screen that has not lost
 * anything re-renders nothing.
 */
export function capBlocks(blocks: AgentBlock[], max: number = MAX_BLOCKS): AgentBlock[] {
  if (blocks.length <= max) return blocks
  const tail = blocks.slice(blocks.length - max)
  // A parent always precedes its result, so anything still unclaimed by the
  // time a result is read was cut off the head.
  // `ref` is compared as it arrives — a missing one and a null one are two
  // different refs, exactly as they are to the pairing below.
  const open = new Set<Ref>()
  const kept: AgentBlock[] = []
  for (const block of tail) {
    if (block.kind === 'tool' || block.kind === 'question') {
      open.add(block.ref)
      kept.push(block)
      continue
    }
    if (block.kind === 'result') {
      if (!open.has(block.ref)) continue
      open.delete(block.ref)
    }
    kept.push(block)
  }
  return kept
}

/**
 * A window of blocks, arranged the way a conversation is read.
 *
 * Two passes, and both are about the same thing: a transcript records what
 * happened and a screen has to show what it meant. First a tool call and its
 * result are put back together — they arrive as two blocks because that is how
 * the file has them, and they are one thing on screen. Then runs of tool calls
 * become one item, because between two sentences an agent will call six tools
 * and think five times, and drawn one card each that is the whole screen.
 * Thinking that carries no text is dropped outright: the desktop sends those
 * blocks because the transcript has them, not because there is anything
 * inside.
 *
 * The pairing goes through `pending` rather than a backwards scan of the rows
 * built so far. The scan was the honest reading of "the most recent unanswered
 * call with this ref", and it copied the whole list to do it — on a transcript
 * of a few hundred blocks that is a copy and a walk per tool result, which is
 * quadratic in the length of a conversation that only grows, recomputed on
 * every draft frame. A stack per `ref` answers the identical question by
 * looking only at the calls that are actually still open.
 */
export function groupBlocks(blocks: AgentBlock[]): Group[] {
  const rows: ChatRow[] = []
  /** Calls still waiting for their result, newest last, by `ref`. */
  const pending = new Map<Ref, ChatRow[]>()
  for (const block of blocks) {
    if (block.kind === 'result') {
      const waiting = pending.get(block.ref)
      const parent = waiting?.pop()
      if (parent) {
        parent.result = block
        if (waiting && !waiting.length) pending.delete(block.ref)
        continue
      }
    }
    const row: ChatRow = { block }
    if (block.kind === 'tool' || block.kind === 'question') {
      const waiting = pending.get(block.ref)
      if (waiting) waiting.push(row)
      else pending.set(block.ref, [row])
    }
    rows.push(row)
  }

  const out: Group[] = []
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

/* ── what a redraw is allowed to cost ───────────────────────────────────── */

export type RowProps = {
  session?: AgentSession | null
  block: AgentBlock
  result?: AgentBlock
  expanded?: string
  onExpand: (block: AgentBlock) => void
  onAnswer?: (seq: number, question: number, choices: number[]) => Promise<{ labels: string[] }>
}

export type ToolRunProps = {
  rows: ChatRow[]
  live: boolean
  expanded: Record<number, string>
  onExpand: (block: AgentBlock) => void
}

/** A row is the same row when every block it draws is the same object. */
export function sameRow(a: RowProps, b: RowProps): boolean {
  return (
    a.block === b.block &&
    a.result === b.result &&
    a.expanded === b.expanded &&
    a.session === b.session &&
    a.onExpand === b.onExpand &&
    a.onAnswer === b.onAnswer
  )
}

/**
 * A run is the same run when it holds the same calls in the same order.
 *
 * `rows` is rebuilt by `groupBlocks` on every recompute, so identity of the
 * array says nothing; identity of the blocks inside it says everything, and
 * there are three of them in a typical run.
 */
export function sameToolRun(a: ToolRunProps, b: ToolRunProps): boolean {
  if (a.live !== b.live || a.expanded !== b.expanded || a.onExpand !== b.onExpand) return false
  if (a.rows === b.rows) return true
  if (a.rows.length !== b.rows.length) return false
  return a.rows.every((row, i) => row.block === b.rows[i].block && row.result === b.rows[i].result)
}

/** Markdown is text and a colour; nothing else reaches it. */
export function sameMarkdown(a: { text: string; tone?: string }, b: { text: string; tone?: string }): boolean {
  return a.text === b.text && a.tone === b.tone
}
