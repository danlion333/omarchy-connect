import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native'
import { Feather } from '@expo/vector-icons'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { useConnection, usePalette } from '../state/ConnectionContext'
import type { AgentBlock, AgentSession, AgentWorker } from '../api/client'
import { Body, Caps, Notice } from '../ui/kit'
import { errorLine } from '../lib/errors'
import { Row, ToolRun, groupBlocks } from './AgentChatScreen'
import { ago } from '../lib/format'
import { font, size, space } from '../theme'

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
 * What it is not is a chat. A worker has no terminal, no `--resume`, and
 * nothing anywhere that would take a message for it, so there is no composer
 * here and no pretence of one — the read-only half of the feature, and read-
 * only by the worker's nature rather than by anybody's policy.
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

  return (
    <View style={{ flex: 1, backgroundColor: palette.background }}>
      <WorkerHeader session={session} worker={status} tone={tone} onBack={onBack} />

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ padding: space.lg, paddingBottom: space.xl, gap: space.md }}
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

        {/* Said rather than implied. A worker's screen looks like a chat and
            has no composer, and the reason is worth one line: there is nothing
            on the desktop that could take a message for it. */}
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
              : 'This worker has finished. Nothing can be typed into one.'}
          </Text>
        ) : null}
      </ScrollView>
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
