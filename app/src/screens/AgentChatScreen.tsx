import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native'
import { Feather } from '@expo/vector-icons'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { useConnection } from '../state/ConnectionContext'
import type { AgentBlock, AgentEvent, AgentSession } from '../api/client'
import { Body, Button, Caps, Chip, StatusDot } from '../ui/kit'
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
  // The terminal as it actually looks. A permission prompt is drawn on screen
  // and never written to the transcript, so the numbered options this phone is
  // about to answer exist nowhere else.
  const [raw, setRaw] = useState<string | null>(null)
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
      <Header
        session={session}
        tone={stateTone}
        onBack={onBack}
        raw={raw !== null}
        onToggleRaw={session.writable === 'tmux' ? () => setRaw((was) => (was === null ? '' : null)) : undefined}
      />

      {raw !== null ? <RawScreen session={session} /> : null}

      <ScrollView
        ref={scroller}
        style={{ flex: 1, display: raw !== null ? 'none' : 'flex' }}
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

function Header({
  session,
  tone,
  onBack,
  raw,
  onToggleRaw,
}: {
  session: AgentSession
  tone: string
  onBack: () => void
  raw: boolean
  onToggleRaw?: () => void
}) {
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
      {onToggleRaw ? (
        <Pressable onPress={onToggleRaw} hitSlop={10}>
          <Feather name="terminal" size={16} color={raw ? palette.accent : palette.muted} />
        </Pressable>
      ) : null}
      <StatusDot tone={tone} pulse={session.state === 'working'} />
      <Caps tone={tone}>{session.state}</Caps>
    </View>
  )
}

/**
 * The pane, captured and redrawn as a monospace block.
 *
 * Deliberately not dressed up as a chat: this is a terminal, and saying so is
 * more honest than pretending to understand a screen nothing parsed. It is
 * polled rather than pushed — a screen is only interesting while somebody is
 * looking at it, and the transcript covers everything else.
 */
function RawScreen({ session }: { session: AgentSession }) {
  const { call, palette } = useConnection()
  const [screen, setScreen] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    const pull = () =>
      call<{ screen: string }>('agents.screen', { id: session.id, lines: 80 })
        .then((res) => live && (setScreen(res.screen), setError(null)))
        .catch((err) => live && setError((err as Error).message))
    void pull()
    const timer = setInterval(pull, 2500)
    return () => {
      live = false
      clearInterval(timer)
    }
  }, [call, session.id])

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: palette.darker_background }}
      contentContainerStyle={{ padding: space.md }}
    >
      {error ? <Body tone={palette.red}>{error}</Body> : null}
      {screen === null && !error ? <ActivityIndicator color={palette.accent} /> : null}
      {screen !== null ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
          <Text
            selectable
            style={{ color: palette.light_foreground, fontFamily: font.regular, fontSize: size.micro, lineHeight: 15 }}
          >
            {screen}
          </Text>
        </ScrollView>
      ) : null}
    </ScrollView>
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

/** The keys worth a button. Anything longer is typed. */
const QUICK: { key: string; label: string }[] = [
  { key: 'Escape', label: 'Esc' },
  { key: '1', label: '1' },
  { key: '2', label: '2' },
  { key: '3', label: '3' },
  { key: 'Enter', label: '⏎' },
]

/**
 * Answering the agent.
 *
 * The text field is the obvious half; the row of keys above it is the one that
 * matters. An agent that has stopped is almost always sitting on a numbered
 * permission prompt, and the useful answer is a single digit — typing "yes"
 * into a menu that wanted "2" is how a remote answer goes wrong. So the quick
 * row sends real keystrokes and the field sends prose, and the two are not the
 * same button.
 *
 * A session on the `wtype` road says so before its first send rather than
 * after. The compositor typing on the user's behalf steals focus for a moment
 * and interleaves with anyone at the real keyboard — that cannot be fixed, but
 * it can be told to the person deciding whether to press send.
 */
function Composer({ session }: { session: AgentSession }) {
  const { call, palette } = useConnection()
  const insets = useSafeAreaInsets()
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [acknowledged, setAcknowledged] = useState(false)

  const needsWarning = session.writable === 'wtype' && !acknowledged

  const guard = useCallback(
    async (what: () => Promise<unknown>) => {
      setBusy(true)
      setError(null)
      try {
        await what()
      } catch (err) {
        setError((err as Error).message)
      } finally {
        setBusy(false)
      }
    },
    [],
  )

  const send = useCallback(() => {
    const body = text.trim()
    if (!body) return
    // Cleared optimistically: the transcript is the receipt, and a field that
    // keeps the text after a successful send invites sending it twice.
    setText('')
    void guard(async () => {
      try {
        await call('agents.send', { id: session.id, text: body })
      } catch (err) {
        setText(body)
        throw err
      }
    })
  }, [call, guard, session.id, text])

  const press = useCallback(
    (key: string) => void guard(() => call('agents.key', { id: session.id, key })),
    [call, guard, session.id],
  )

  const frame = {
    paddingHorizontal: space.lg,
    paddingTop: space.md,
    paddingBottom: Math.max(insets.bottom, space.md),
    backgroundColor: palette.dark_background,
    borderTopWidth: StyleSheet.hairlineWidth * 2,
    borderTopColor: palette.lighter_background,
  }

  if (!session.writable) {
    return (
      <View style={{ ...frame, flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
        <Feather name="eye" size={14} color={palette.muted} />
        <Text style={{ flex: 1, color: palette.muted, fontFamily: font.regular, fontSize: size.label }}>
          Reading only — nothing on that desktop can reach this terminal
        </Text>
      </View>
    )
  }

  if (needsWarning) {
    return (
      <View style={{ ...frame, gap: space.sm }}>
        <Caps tone={palette.orange}>The desktop will type this itself</Caps>
        <Body tone={palette.muted}>
          This agent is not in tmux, so the desktop focuses its window and types on your behalf. It steals focus for a
          moment, and it will interleave with anyone typing at the keyboard. Start it with{' '}
          <Text style={{ fontFamily: font.medium }}>omarchy-connect agent run</Text> to get a cleaner road.
        </Body>
        <Button label="Type anyway" icon="edit-2" tone={palette.orange} onPress={() => setAcknowledged(true)} />
      </View>
    )
  }

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={0}>
      <View style={frame}>
        {error ? (
          <Body tone={palette.red} style={{ marginBottom: space.sm }}>
            {error}
          </Body>
        ) : null}

        <View style={{ flexDirection: 'row', gap: space.sm, marginBottom: space.sm }}>
          {QUICK.map((quick) => (
            <Chip
              key={quick.key}
              label={quick.label}
              tone={session.state === 'waiting' ? palette.orange : undefined}
              active={session.state === 'waiting'}
              onPress={() => press(quick.key)}
            />
          ))}
          <View style={{ flex: 1 }} />
          <Chip label="stop" tone={palette.red} onPress={() => press('C-c')} />
        </View>

        <View style={{ flexDirection: 'row', gap: space.sm, alignItems: 'flex-end' }}>
          <TextInput
            value={text}
            onChangeText={setText}
            placeholder={session.writable === 'tmux' ? 'answer the agent…' : 'the desktop will type this…'}
            placeholderTextColor={palette.muted}
            autoCapitalize="sentences"
            autoCorrect
            multiline
            // Return adds a newline and the arrow sends, the way every chat
            // app on a phone works — and here it earns its keep twice over,
            // because a multi-line message travels as a bracketed paste and
            // arrives as one message rather than as several half-sent ones.
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

        <Text style={{ color: palette.muted, fontFamily: font.regular, fontSize: size.micro, marginTop: space.xs }}>
          {session.writable === 'tmux' ? `tmux ${session.pane}` : 'the desktop types this — focus moves for a moment'}
        </Text>
      </View>
    </KeyboardAvoidingView>
  )
}
