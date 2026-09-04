import React, { useCallback, useEffect, useMemo, useState } from 'react'
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native'
import { Feather } from '@expo/vector-icons'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { useConnection, usePalette } from '../state/ConnectionContext'
import type { AgentBlock, AgentSession, AgentWorker } from '../api/client'
import { Body, Caps, Notice } from '../ui/kit'
import { errorLine } from '../lib/errors'
import { Row, ToolRun, groupBlocks, useKeyboardOpen } from './AgentChatScreen'
import { ago } from '../lib/format'
import { font, radius, size, space } from '../theme'

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
  const tone = status.running ? palette.green : palette.muted
  const keyboard = useKeyboardOpen()

  return (
    <KeyboardAvoidingView behavior="padding" style={{ flex: 1, backgroundColor: palette.background }}>
      <WorkerHeader session={session} worker={status} tone={tone} onBack={onBack} />

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ padding: space.lg, paddingBottom: space.xl, gap: space.md }}
        keyboardShouldPersistTaps="handled"
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={palette.muted} />}
      >
        {loading ? <ActivityIndicator color={palette.accent} style={{ marginTop: space.xl }} /> : null}
        <Notice error={error} onDismiss={() => setError(null)} />
        {!loading && !error && !groups.length ? (
          <Body tone={palette.muted} style={{ textAlign: 'center', marginTop: space.xl }}>
            Nothing in this worker's transcript yet
          </Body>
        ) : null}

        {groups.map((group, i) =>
          group.kind === 'tools' ? (
            <ToolRun
              key={group.seq}
              rows={group.rows}
              live={i === groups.length - 1}
              expanded={expanded}
              onExpand={expand}
            />
          ) : (
            <Row
              key={group.seq}
              block={group.row.block}
              result={group.row.result}
              expanded={expanded[group.row.block.seq]}
              onExpand={() => expand(group.row.block)}
            />
          ),
        )}

        {/* Said rather than implied: nothing here is subscribed to the
            worker, so what is on screen is as new as the last pull. */}
        {!loading ? (
          <Text
            style={{
              color: palette.muted,
              fontFamily: font.regular,
              fontSize: size.micro,
              textAlign: 'center',
              marginTop: space.md,
            }}
          >
            {status.running
              ? 'Still working — pull down for what it has said since'
              : 'This worker has finished — a message still reaches it, through the session that spawned it'}
          </Text>
        ) : null}
      </ScrollView>

      <WorkerComposer session={session} worker={status} keyboard={keyboard} />
    </KeyboardAvoidingView>
  )
}

/**
 * The field that answers a worker, and the one sentence under it that says
 * what actually happened to what you typed.
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
      <View style={{ ...frame, flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
        <Feather name="eye" size={14} color={palette.muted} />
        <Text style={{ flex: 1, color: palette.muted, fontFamily: font.regular, fontSize: size.label }}>
          {!canRelay
            ? 'Reading only — that desktop is too old to pass a message to a worker'
            : 'Reading only — a worker is answered through its session, and nothing can type into that one'}
        </Text>
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
        <TextInput
          value={text}
          onChangeText={setText}
          placeholder={`message this worker via ${session.title}…`}
          placeholderTextColor={palette.muted}
          autoCapitalize="sentences"
          autoCorrect
          multiline
          submitBehavior="newline"
          style={{
            flex: 1,
            maxHeight: 120,
            color: palette.light_foreground,
            fontFamily: font.regular,
            fontSize: size.body,
            backgroundColor: palette.darker_background,
            borderColor: palette.lighter_background,
            borderWidth: 1,
            borderRadius: radius.sm,
            paddingHorizontal: space.md,
            paddingVertical: space.md,
          }}
        />
        <Pressable
          onPress={send}
          disabled={busy || !text.trim()}
          style={({ pressed }) => ({
            paddingHorizontal: space.lg,
            paddingVertical: space.md,
            justifyContent: 'center',
            backgroundColor: pressed ? palette.selection : palette.lighter_background,
            borderRadius: radius.sm,
            opacity: busy || !text.trim() ? 0.4 : 1,
          })}
        >
          {busy ? (
            <ActivityIndicator size="small" color={palette.accent} />
          ) : (
            <Feather name="corner-down-left" size={16} color={palette.bright_foreground} />
          )}
        </Pressable>
      </View>
      {keyboard ? null : (
        <Text style={{ color: palette.muted, fontFamily: font.regular, fontSize: size.micro }}>
          {queued
            ? `Queued with ${session.title} — it has to pick this up and continue the worker`
            : 'Goes to the session that spawned this worker, for it to pass on'}
        </Text>
      )}
    </View>
  )
}

/**
 * Whose worker this is, and what it was sent to do.
 *
 * The description is the title because it is the only name a worker has — the
 * caller wrote it, and "Protocol + docs for agents" says more than any id. The
 * session underneath it is what stops a screenful of workers from being
 * indistinguishable once there are several conversations running.
 */
function WorkerHeader({
  session,
  worker,
  tone,
  onBack,
}: {
  session: AgentSession
  worker: AgentWorker
  tone: string
  onBack: () => void
}) {
  const palette = usePalette()
  const insets = useSafeAreaInsets()

  return (
    <View
      style={{
        paddingTop: insets.top + space.sm,
        paddingBottom: space.sm,
        paddingHorizontal: space.lg,
        backgroundColor: palette.dark_background,
        borderBottomWidth: StyleSheet.hairlineWidth * 2,
        borderBottomColor: palette.lighter_background,
        flexDirection: 'row',
        alignItems: 'center',
        gap: space.md,
      }}
    >
      <Pressable onPress={onBack} hitSlop={12}>
        <Feather name="chevron-left" size={22} color={palette.foreground} />
      </Pressable>
      <View style={{ flex: 1 }}>
        <Text
          style={{ color: palette.bright_foreground, fontFamily: font.medium, fontSize: size.value }}
          numberOfLines={1}
        >
          {worker.description || worker.type || worker.id}
        </Text>
        <Text style={{ color: palette.muted, fontFamily: font.regular, fontSize: size.label }} numberOfLines={1}>
          {[worker.type, session.title, ago(worker.updatedAt)].filter(Boolean).join(' · ')}
        </Text>
      </View>
      <Caps tone={tone}>{worker.running ? 'working' : 'done'}</Caps>
    </View>
  )
}
