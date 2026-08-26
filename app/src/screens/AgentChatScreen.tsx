import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { Feather } from '@expo/vector-icons'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { useConnection } from '../state/ConnectionContext'
import type { AgentBlock, AgentEvent, AgentSession } from '../api/client'
import { Body, Caps, StatusDot } from '../ui/kit'
import { ago } from '../lib/format'
import { alpha, font, radius, size, space } from '../theme'

/**
 * One agent conversation, read from the desktop.
 *
 * The daemon collapses every tool call into a single line before it leaves the
 * desktop, because a phone screen cannot carry a 400-line tool result and the
 * interesting part of a tool call is that it happened and whether it worked.
 * The full body is one tap away and fetched only then.
 */
export function AgentChatScreen({ session, onBack }: { session: AgentSession; onBack: () => void }) {
  const { call, client, palette } = useConnection()
  const [blocks, setBlocks] = useState<AgentBlock[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Record<number, string>>({})
  const scroller = useRef<ScrollView | null>(null)
  const atBottom = useRef(true)

  /* Open the session, then let the daemon push the rest. */
  useEffect(() => {
    let live = true
    setLoading(true)
    setBlocks([])
    setExpanded({})
    call<{ blocks: AgentBlock[] }>('agents.open', { id: session.id, limit: 120 })
      .then((res) => {
        if (!live) return
        setBlocks(res.blocks || [])
        setError(null)
      })
      .catch((err) => live && setError((err as Error).message))
      .finally(() => live && setLoading(false))

    return () => {
      live = false
      // Closing is what stops the desktop tailing a transcript nobody reads.
      call('agents.close', { id: session.id }).catch(() => {})
    }
  }, [call, session.id])

  useEffect(() => {
    if (!client) return
    return client.on('ev:agent', (data: AgentEvent) => {
      if (data.kind !== 'blocks' || data.id !== session.id) return
      setBlocks((prev) => (data.reset ? data.blocks : [...prev, ...data.blocks]))
    })
  }, [client, session.id])

  /* Follow the conversation, unless the reader has scrolled up to look at something. */
  useEffect(() => {
    if (atBottom.current) requestAnimationFrame(() => scroller.current?.scrollToEnd({ animated: true }))
  }, [blocks])

  const expand = useCallback(
    async (block: AgentBlock) => {
      if (expanded[block.seq] !== undefined) {
        setExpanded(({ [block.seq]: _drop, ...rest }) => rest)
        return
      }
      try {
        const res = await call<{ text: string }>('agents.detail', { id: session.id, seq: block.seq })
        setExpanded((prev) => ({ ...prev, [block.seq]: res.text }))
      } catch (err) {
        setExpanded((prev) => ({ ...prev, [block.seq]: (err as Error).message }))
      }
    },
    [call, expanded, session.id],
  )

  /**
   * A tool call and its result are one thing on screen. They arrive as two
   * blocks because that is how the transcript records them.
   */
  const rows = useMemo(() => {
    const out: { block: AgentBlock; result?: AgentBlock }[] = []
    for (const block of blocks) {
      if (block.kind === 'result') {
        const parent = [...out].reverse().find((r) => r.block.kind === 'tool' && r.block.ref === block.ref && !r.result)
        if (parent) {
          parent.result = block
          continue
        }
      }
      out.push({ block })
    }
    return out
  }, [blocks])

  const stateTone =
    session.state === 'waiting' ? palette.orange : session.state === 'working' ? palette.green : palette.muted

  return (
    <View style={{ flex: 1, backgroundColor: palette.background }}>
      <Header session={session} tone={stateTone} onBack={onBack} />

      <ScrollView
        ref={scroller}
        style={{ flex: 1 }}
        contentContainerStyle={{ padding: space.lg, paddingBottom: space.xl, gap: space.md }}
        onScroll={(e) => {
          const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent
          atBottom.current = contentOffset.y + layoutMeasurement.height >= contentSize.height - 80
        }}
        scrollEventThrottle={120}
      >
        {loading ? <ActivityIndicator color={palette.accent} style={{ marginTop: space.xl }} /> : null}
        {error ? <Body tone={palette.red}>{error}</Body> : null}
        {!loading && !error && !rows.length ? (
          <Body tone={palette.muted} style={{ textAlign: 'center', marginTop: space.xl }}>
            Nothing in this transcript yet
          </Body>
        ) : null}

        {rows.map(({ block, result }) => (
          <Row
            key={block.seq}
            block={block}
            result={result}
            expanded={expanded[block.seq]}
            onExpand={() => expand(block)}
          />
        ))}

        {session.state === 'waiting' && session.prompt ? (
          <View
            style={{
              borderLeftWidth: 2,
              borderLeftColor: palette.orange,
              backgroundColor: alpha(palette.orange, 0.08),
              padding: space.md,
              borderRadius: radius.sm,
            }}
          >
            <Caps tone={palette.orange}>Waiting for you</Caps>
            <Body style={{ marginTop: space.xs }}>{session.prompt}</Body>
          </View>
        ) : null}
      </ScrollView>

      <Composer session={session} />
    </View>
  )
}

function Header({ session, tone, onBack }: { session: AgentSession; tone: string; onBack: () => void }) {
  const { palette } = useConnection()
  const insets = useSafeAreaInsets()
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: space.md,
        paddingTop: insets.top + space.sm,
        paddingBottom: space.md,
        paddingHorizontal: space.lg,
        backgroundColor: palette.dark_background,
        borderBottomWidth: StyleSheet.hairlineWidth * 2,
        borderBottomColor: palette.lighter_background,
      }}
    >
      <Pressable onPress={onBack} hitSlop={12}>
        <Feather name="chevron-left" size={22} color={palette.foreground} />
      </Pressable>
      <View style={{ flex: 1 }}>
        <Text style={{ color: palette.bright_foreground, fontFamily: font.medium, fontSize: size.value }} numberOfLines={1}>
          {session.title}
        </Text>
        <Text style={{ color: palette.muted, fontFamily: font.regular, fontSize: size.label }} numberOfLines={1}>
          {session.agent} · {session.cwd || '—'}
        </Text>
      </View>
      <StatusDot tone={tone} pulse={session.state === 'working'} />
      <Caps tone={tone}>{session.state}</Caps>
    </View>
  )
}

function Row({
  block,
  result,
  expanded,
  onExpand,
}: {
  block: AgentBlock
  result?: AgentBlock
  expanded?: string
  onExpand: () => void
}) {
  const { palette } = useConnection()

  if (block.kind === 'text') {
    const mine = block.role === 'user'
    return (
      <View
        style={{
          alignSelf: mine ? 'flex-end' : 'flex-start',
          maxWidth: '92%',
          backgroundColor: mine ? palette.selection : palette.dark_background,
          borderColor: palette.lighter_background,
          borderWidth: StyleSheet.hairlineWidth * 2,
          borderRadius: radius.md,
          paddingHorizontal: space.md,
          paddingVertical: space.sm,
        }}
      >
        <Text style={{ color: mine ? palette.bright_foreground : palette.light_foreground, fontFamily: font.regular, fontSize: size.body, lineHeight: 20 }}>
          {block.text}
        </Text>
      </View>
    )
  }

  // Thinking stays collapsed on purpose: most of these carry no text at all,
  // only an encrypted signature the desktop refuses to send.
  if (block.kind === 'thinking') {
    return (
      <Pressable onPress={block.text ? onExpand : undefined} style={{ alignSelf: 'flex-start', flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
        <Feather name="more-horizontal" size={14} color={palette.muted} />
        <Text style={{ color: palette.muted, fontFamily: font.regular, fontSize: size.label }}>
          {expanded !== undefined ? expanded : 'thinking'}
        </Text>
      </Pressable>
    )
  }

  if (block.kind === 'tool') {
    const status = result?.status
    const tone = status === 'error' ? palette.red : status === 'interrupted' ? palette.orange : status ? palette.green : palette.muted
    return (
      <View style={{ alignSelf: 'stretch' }}>
        <Pressable
          onPress={onExpand}
          style={({ pressed }) => ({
            flexDirection: 'row',
            alignItems: 'center',
            gap: space.sm,
            backgroundColor: pressed ? palette.selection : palette.darker_background,
            borderColor: palette.lighter_background,
            borderWidth: StyleSheet.hairlineWidth * 2,
            borderRadius: radius.sm,
            paddingHorizontal: space.md,
            paddingVertical: space.sm,
          })}
        >
          <StatusDot tone={tone} />
          <Text style={{ color: palette.foreground, fontFamily: font.medium, fontSize: size.label }}>{block.tool}</Text>
          <Text style={{ flex: 1, color: palette.muted, fontFamily: font.regular, fontSize: size.label }} numberOfLines={1}>
            {block.summary}
          </Text>
          {result?.lines ? (
            <Text style={{ color: palette.muted, fontFamily: font.regular, fontSize: size.micro }}>{result.lines}L</Text>
          ) : null}
        </Pressable>

        {result && expanded === undefined ? (
          <Text
            style={{ color: palette.muted, fontFamily: font.regular, fontSize: size.micro, marginTop: 3, marginLeft: space.md }}
            numberOfLines={1}
          >
            {result.summary}
          </Text>
        ) : null}

        {expanded !== undefined ? (
          <ScrollView
            horizontal
            style={{
              marginTop: space.xs,
              maxHeight: 260,
              backgroundColor: palette.darker_background,
              borderRadius: radius.sm,
              borderColor: palette.lighter_background,
              borderWidth: StyleSheet.hairlineWidth * 2,
            }}
          >
            <ScrollView nestedScrollEnabled style={{ maxHeight: 260 }}>
              <Text selectable style={{ color: palette.light_foreground, fontFamily: font.regular, fontSize: size.micro, padding: space.md }}>
                {expanded}
              </Text>
            </ScrollView>
          </ScrollView>
        ) : null}
      </View>
    )
  }

  // A result with no tool call in the window it was loaded from.
  return (
    <Text style={{ color: palette.muted, fontFamily: font.regular, fontSize: size.label }} numberOfLines={2}>
      {block.summary} · {ago(block.at)}
    </Text>
  )
}

/**
 * The input, and the honest reason it is not one yet. Nothing may push bytes
 * into a terminal somebody else's process owns — that is stage two's problem,
 * and pretending otherwise would just make a send silently do nothing.
 */
function Composer({ session }: { session: AgentSession }) {
  const { palette } = useConnection()
  const insets = useSafeAreaInsets()
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: space.sm,
        paddingHorizontal: space.lg,
        paddingTop: space.md,
        paddingBottom: Math.max(insets.bottom, space.md),
        backgroundColor: palette.dark_background,
        borderTopWidth: StyleSheet.hairlineWidth * 2,
        borderTopColor: palette.lighter_background,
      }}
    >
      <Feather name={session.writable ? 'edit-2' : 'eye'} size={14} color={palette.muted} />
      <Text style={{ flex: 1, color: palette.muted, fontFamily: font.regular, fontSize: size.label }}>
        {session.writable ? 'writable' : 'reading only — answering lands in a later release'}
      </Text>
    </View>
  )
}
