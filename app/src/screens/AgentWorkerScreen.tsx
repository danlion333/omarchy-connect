import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { ActivityIndicator, KeyboardAvoidingView, RefreshControl, ScrollView, StyleSheet, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { useConnection, usePalette } from '../state/ConnectionContext'
import type { AgentBlock, AgentSession, AgentWorker } from '../api/client'
import { Card, Empty, Hint, IconButton, Label, Notice, Pill, Section, Title } from '../ui/kit'
import { errorLine } from '../lib/errors'
import { Row, ToolRun, useKeyboardOpen } from './AgentChatScreen'
import { PromptBox, SheetBar } from './AgentLaunchScreen'
import { groupBlocks, type Group } from '../lib/transcript'
import { ago } from '../lib/format'
import { space, touch } from '../theme'

/**
 * One worker of a session, and the conversation it had.
 *
 * A session that fanned out used to be a number on a list — "3 subagents" —
 * and under `/loop /issue next` that number is the entire screen, because all
 * the work is in the worker and the session that spawned it is standing still.
 * This is the other side of it: the worker's own transcript, drawn with the
 * same blocks as any chat, because the CLI writes it as the same kind of file
 * one directory down.
 *
 * It can also be answered, which took the long way round. A worker has no
 * terminal — no pane, no pid, no `--resume` — so none of the three roads the
 * desktop writes down reaches it. The one thing that does hold it is the
 * session that spawned it, so the field at the bottom of this screen composes
 * a message *here* and delivers it *there*: `agents.relay` types it into the
 * parent's composer with the worker named, and the parent continues that agent.
 * The screen says so in those words rather than claiming a delivery, because
 * queued with the parent is the whole of what the desktop can promise.
 *
 * It is also not tailed. Nothing on the desktop is subscribed to a worker, so
 * there is no cursor to resume from: the screen asks for a window and a
 * pull-to-refresh asks for a newer one. A worker that is still running is
 * writing every few seconds, and the answer to "what is it doing now" is one
 * pull away rather than one event away.
 */
export function AgentWorkerScreen({
  session,
  worker,
  onBack,
}: {
  session: AgentSession
  worker: AgentWorker
  onBack: () => void
}) {
  const { call, palette } = useConnection()
  const [blocks, setBlocks] = useState<AgentBlock[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [expanded, setExpanded] = useState<Record<number, string>>({})
  // What the desktop last said about the worker itself — its state moves while
  // the screen is open, and the row that opened it is a snapshot.
  const [status, setStatus] = useState<AgentWorker>(worker)

  const load = useCallback(async () => {
    try {
      const res = await call<{ worker: AgentWorker; blocks: AgentBlock[] }>('agents.worker', {
        id: session.id,
        agentId: worker.id,
      })
      setBlocks(res.blocks || [])
      if (res.worker) setStatus(res.worker)
      setError(null)
      // The bodies behind the chips were numbered against the window that has
      // just been replaced; keeping them open would show yesterday's output
      // under today's line.
      setExpanded({})
    } catch (err) {
      setError(err)
    }
  }, [call, session.id, worker.id])

  useEffect(() => {
    let alive = true
    setLoading(true)
    setBlocks([])
    setExpanded({})
    void load().finally(() => alive && setLoading(false))
    return () => {
      alive = false
    }
  }, [load])

  const refresh = useCallback(async () => {
    setRefreshing(true)
    await load()
    setRefreshing(false)
  }, [load])

  /**
   * Expanding a chip out of a worker's window.
   *
   * The desktop holds exactly the window it last handed over, so the `seq` in
   * hand is one it can answer — and `agentId` is what says which transcript
   * the number belongs to, since the session's own blocks are numbered from
   * the same one.
   */
  const expand = useCallback(
    async (block: AgentBlock) => {
      if (expanded[block.seq] !== undefined) {
        setExpanded(({ [block.seq]: _drop, ...rest }) => rest)
        return
      }
      try {
        const res = await call<{ text: string }>('agents.detail', {
          id: session.id,
          seq: block.seq,
          agentId: worker.id,
        })
        setExpanded((prev) => ({ ...prev, [block.seq]: res.text }))
      } catch (err) {
        setExpanded((prev) => ({ ...prev, [block.seq]: errorLine(err, 'the desktop would not send this') }))
      }
    },
    [call, expanded, session.id, worker.id],
  )

  const groups = useMemo(() => groupBlocks(blocks), [blocks])
  const keyboard = useKeyboardOpen()

  // A finished worker's last word is its result — the thing the reader came
  // for — and gets a card of its own so the eye lands on it before the ledger
  // of tools above it. While it is still running the last text is just the
  // most recent thing it said, and is drawn in the flow like the rest.
  const last = groups[groups.length - 1]
  const result =
    !status.running && last && last.kind === 'row' && last.row.block.kind === 'text' && last.row.block.role === 'assistant'
      ? last
      : null
  const flow = result ? groups.slice(0, -1) : groups

  return (
    <KeyboardAvoidingView behavior="padding" style={{ flex: 1, backgroundColor: palette.background }}>
      <WorkerHeader session={session} worker={status} refreshing={refreshing} onRefresh={refresh} onBack={onBack} />

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ padding: space.lg, paddingBottom: space.xl, gap: space.md }}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} tintColor={palette.muted} />}
      >
        {loading ? (
          <Card style={{ marginBottom: 0, alignItems: 'center', gap: space.md, paddingVertical: space.xl }}>
            <ActivityIndicator color={palette.accent} />
            <Hint>Reading the transcript</Hint>
          </Card>
        ) : null}

        <Notice
          error={error}
          action={{ label: 'Try again', icon: 'refresh-cw', onPress: () => void refresh() }}
          onDismiss={() => setError(null)}
          style={{ marginBottom: 0 }}
        />

        {!loading && !error && !groups.length ? (
          status.running ? (
            <Card style={{ marginBottom: 0, alignItems: 'center', gap: space.md, paddingVertical: space.xl }}>
              <ActivityIndicator color={palette.accent} />
              <Hint>Starting…</Hint>
            </Card>
          ) : (
            <Card style={{ marginBottom: 0 }}>
              <Empty icon="inbox" text="Nothing in this transcript" />
            </Card>
          )
        ) : null}

        {flow.map((group, i) => (
          <TranscriptGroup key={group.seq} group={group} live={i === flow.length - 1 && !result} expanded={expanded} onExpand={expand} />
        ))}

        {result ? (
          <Card style={{ marginBottom: 0 }}>
            <Section title="Result" />
            <TranscriptGroup group={result} live={false} expanded={expanded} onExpand={expand} />
          </Card>
        ) : null}

        {/* Said rather than implied: nothing here is subscribed to the
            worker, so what is on screen is as new as the last pull. */}
        {!loading && status.running ? (
          <Hint icon="refresh-cw" style={{ marginTop: space.sm }}>
            Still working · pull down for what it has said since
          </Hint>
        ) : null}
      </ScrollView>

      <WorkerComposer session={session} worker={status} keyboard={keyboard} />
    </KeyboardAvoidingView>
  )
}

/** One item of the transcript, whichever of the two shapes it takes. */
function TranscriptGroup({
  group,
  live,
  expanded,
  onExpand,
}: {
  group: Group
  live: boolean
  expanded: Record<number, string>
  onExpand: (block: AgentBlock) => void
}) {
  if (group.kind === 'tools') {
    return <ToolRun rows={group.rows} live={live} expanded={expanded} onExpand={onExpand} />
  }
  return (
    <Row block={group.row.block} result={group.row.result} expanded={expanded[group.row.block.seq]} onExpand={onExpand} />
  )
}

/**
 * The field that answers a worker, and the one line under it that says what
 * actually happened to what you typed.
 *
 * Everything about this is second-hand and it does not hide it. The message
 * goes to the parent session's composer with the worker's `agentId` in front of
 * it; the parent has to read it and continue that agent. So the receipt is
 * `queued`, never `sent` — the desktop watched the text land in the parent's
 * box and can say nothing at all about whether the worker ever hears it.
 *
 * A parent with no terminal is the one case where there is no road: not a
 * failure to report after the fact, but a field that must not be offered in
 * the first place, because a message accepted into nowhere reads exactly like
 * one that arrived.
 */
function WorkerComposer({
  session,
  worker,
  keyboard,
}: {
  session: AgentSession
  worker: AgentWorker
  keyboard: boolean
}) {
  const { call, hello, palette } = useConnection()
  const insets = useSafeAreaInsets()
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  // The last thing handed over, kept so the line under the field can name it.
  // It is not a transcript entry: the worker's transcript will not carry this
  // message, and the parent's is where it will show up.
  const [queued, setQueued] = useState<string | null>(null)

  const canRelay = (hello?.capabilities?.agents as { relay?: boolean } | undefined)?.relay === true

  const frame = {
    paddingHorizontal: space.lg,
    paddingTop: space.md,
    paddingBottom: keyboard ? space.sm : Math.max(insets.bottom, space.md),
    backgroundColor: palette.dark_background,
    borderTopWidth: StyleSheet.hairlineWidth * 2,
    borderTopColor: palette.lighter_background,
  }

  if (!canRelay || !session.writable) {
    return (
      <View style={frame}>
        <Hint icon="eye">
          {!canRelay
            ? 'Reading only · this desktop cannot pass a message to a worker'
            : 'Reading only · nothing can type into the session that spawned it'}
        </Hint>
      </View>
    )
  }

  const send = () => {
    const body = text.trim()
    if (!body) return
    setText('')
    setBusy(true)
    setError(null)
    void (async () => {
      try {
        await call('agents.relay', { id: session.id, agentId: worker.id, text: body })
        setQueued(body)
      } catch (err) {
        // The only copy of what was typed is the one this field threw away.
        setText(body)
        setError(err)
      } finally {
        setBusy(false)
      }
    })()
  }

  return (
    <View style={{ ...frame, gap: space.sm }}>
      <Notice error={error} onDismiss={() => setError(null)} style={{ marginBottom: 0 }} />
      <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: space.sm }}>
        <PromptBox
          value={text}
          onChange={setText}
          placeholder="Message this worker"
          label="Message this worker"
          minLines={1}
          maxLines={5}
          style={{ flex: 1, minHeight: touch }}
        />
        <IconButton
          icon="corner-down-left"
          label="Send"
          size={touch}
          tone={palette.bright_foreground}
          onPress={send}
          disabled={!text.trim()}
          loading={busy}
        />
      </View>
      {/* The receipt stays up with the keyboard; only the standing hint gets
          out of its way. The moment the queued line is worth reading is the
          moment just after the send, and the keyboard is up for all of it —
          hiding it there left the phone showing a field that had emptied
          itself and nothing at all about where the message went. */}
      {queued ? (
        <Hint icon="check" tone={palette.green}>
          {`Queued with ${session.title} · it passes it on`}
        </Hint>
      ) : keyboard ? null : (
        <Hint icon="corner-up-right">Goes through the session that spawned this worker</Hint>
      )}
    </View>
  )
}

/**
 * Whose worker this is, and what it was sent to do.
 *
 * The description is the title because it is the only name a worker has — the
 * caller wrote it, and "Protocol + docs for agents" says more than any id. It
 * gets a line of its own under the bar rather than a slot in it: a sentence
 * like that beside a back button, a state and a refresh is fifteen characters
 * wide, and a description cut to fifteen characters names nothing. The session
 * underneath it is what stops a screenful of workers from being
 * indistinguishable once there are several conversations running.
 */
function WorkerHeader({
  session,
  worker,
  refreshing,
  onRefresh,
  onBack,
}: {
  session: AgentSession
  worker: AgentWorker
  refreshing: boolean
  onRefresh: () => Promise<void>
  onBack: () => void
}) {
  const palette = usePalette()
  return (
    <SheetBar
      onBack={onBack}
      caps="Worker"
      right={
        <>
          <Pill
            label={worker.running ? 'working' : 'done'}
            tone={worker.running ? palette.green : palette.light_foreground}
            icon={worker.running ? 'loader' : 'check'}
          />
          <IconButton icon="refresh-cw" label="Refresh" loading={refreshing} onPress={() => void onRefresh()} />
        </>
      }
      below={
        <View style={{ gap: 2 }}>
          <Title numberOfLines={2}>{worker.description || worker.type || worker.id}</Title>
          <Label numberOfLines={2}>{[worker.type, session.title, ago(worker.updatedAt)].filter(Boolean).join(' · ')}</Label>
        </View>
      }
    />
  )
}
