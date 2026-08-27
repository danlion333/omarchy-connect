import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ActivityIndicator,
  Animated,
  Keyboard,
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
import { Body, Button, Caps, Chip } from '../ui/kit'
import { ago } from '../lib/format'
import { alpha, font, radius, size, space } from '../theme'

/**
 * One agent conversation, read from the desktop.
 *
 * The daemon collapses every tool call into a single line before it leaves the
 * desktop, because a phone screen cannot carry a 400-line tool result and the
 * interesting part of a tool call is that it happened and whether it worked.
 * The full body is one tap away and fetched only then.
 *
 * On screen the hierarchy is deliberate: what the agent *said* is set in plain
 * full-width prose, and everything it *did* is a dim one-line ledger beside it.
 * A phone shows about fifteen lines at a time and the answer has to be in them.
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
  const keyboard = useKeyboardOpen()

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

  /* The keyboard eats half the screen; the tail has to come with it. */
  useEffect(() => {
    if (keyboard) requestAnimationFrame(() => scroller.current?.scrollToEnd({ animated: true }))
  }, [keyboard])

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
    const out: ChatRow[] = []
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

  /**
   * Runs of tool calls become one item.
   *
   * Between two sentences an agent will call six tools and think five times,
   * and drawn one-per-card that is the whole screen. Thinking that carries no
   * text is dropped outright — the desktop sends those blocks because the
   * transcript has them, not because there is anything inside — and the tool
   * calls left over collapse into a single ledger that folds itself once the
   * answer arrives after it.
   */
  const groups = useMemo(() => {
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
  }, [rows])

  const stateTone =
    session.state === 'waiting' ? palette.orange : session.state === 'working' ? palette.green : palette.muted

  return (
    <KeyboardAvoidingView
      // `padding` on both platforms on purpose. Android 15 stopped resizing the
      // window under an edge-to-edge app, so the composer sat behind the
      // keyboard with nothing to push it up; this measures the overlap against
      // the view's own frame and is a no-op on the Androids that still resize.
      behavior="padding"
      style={{ flex: 1, backgroundColor: palette.background }}
    >
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
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
        onScroll={(e) => {
          const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent
          atBottom.current = contentOffset.y + layoutMeasurement.height >= contentSize.height - 80
        }}
        scrollEventThrottle={120}
      >
        {loading ? <ActivityIndicator color={palette.accent} style={{ marginTop: space.xl }} /> : null}
        {error ? <Body tone={palette.red}>{error}</Body> : null}
        {!loading && !error && !groups.length ? (
          <Body tone={palette.muted} style={{ textAlign: 'center', marginTop: space.xl }}>
            Nothing in this transcript yet
          </Body>
        ) : null}

        {groups.map((group, i) =>
          group.kind === 'tools' ? (
            <ToolRun
              key={group.seq}
              rows={group.rows}
              // The run at the end is the one happening now: never fold it.
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

        {session.state === 'working' ? <Working /> : null}

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

      <Composer session={session} keyboard={keyboard} />
    </KeyboardAvoidingView>
  )
}

type ChatRow = { block: AgentBlock; result?: AgentBlock }
type Group =
  | { kind: 'tools'; seq: number; rows: ChatRow[] }
  | { kind: 'row'; seq: number; row: ChatRow }

/** Whether the software keyboard is up, so chrome can get out of its way. */
function useKeyboardOpen(): boolean {
  const [open, setOpen] = useState(false)
  useEffect(() => {
    const ios = Platform.OS === 'ios'
    const show = Keyboard.addListener(ios ? 'keyboardWillShow' : 'keyboardDidShow', () => setOpen(true))
    const hide = Keyboard.addListener(ios ? 'keyboardWillHide' : 'keyboardDidHide', () => setOpen(false))
    return () => {
      show.remove()
      hide.remove()
    }
  }, [])
  return open
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
      <Pulse tone={tone} on={session.state === 'working'} />
      <Caps tone={tone}>{session.state}</Caps>
    </View>
  )
}

/**
 * The status dot, breathing while the agent works.
 *
 * A still dot cannot say whether a session is alive or wedged, and that is the
 * question anyone opening this screen is actually asking.
 */
function Pulse({ tone, on, size: dot = 8 }: { tone: string; on?: boolean; size?: number }) {
  const value = useRef(new Animated.Value(1)).current

  useEffect(() => {
    if (!on) {
      value.setValue(1)
      return
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(value, { toValue: 0.25, duration: 700, useNativeDriver: true }),
        Animated.timing(value, { toValue: 1, duration: 700, useNativeDriver: true }),
      ]),
    )
    loop.start()
    return () => loop.stop()
  }, [on, value])

  return (
    <Animated.View
      style={{ width: dot, height: dot, borderRadius: dot / 2, backgroundColor: tone, opacity: on ? value : 1 }}
    />
  )
}

/** The agent is mid-turn and has not said anything yet. */
function Working() {
  const { palette } = useConnection()
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
      <Pulse tone={palette.green} on size={6} />
      <Text style={{ color: palette.muted, fontFamily: font.regular, fontSize: size.label }}>working</Text>
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

/** How many calls a folded run shows before the fold. */
const RUN_TAIL = 3

/**
 * A run of tool calls, as a ledger rather than a stack of cards.
 *
 * While it is the last thing on screen it is the work in progress and shows in
 * full. Once the agent has answered past it, the run has served its purpose and
 * keeps only its last few lines, with the rest one tap away.
 */
function ToolRun({
  rows,
  live,
  expanded,
  onExpand,
}: {
  rows: ChatRow[]
  live: boolean
  expanded: Record<number, string>
  onExpand: (block: AgentBlock) => void
}) {
  const { palette } = useConnection()
  const [unfolded, setUnfolded] = useState(false)
  const hidden = live || unfolded ? 0 : Math.max(0, rows.length - RUN_TAIL)
  const shown = hidden ? rows.slice(hidden) : rows

  return (
    <View
      style={{
        gap: 1,
        borderLeftWidth: StyleSheet.hairlineWidth * 2,
        borderLeftColor: palette.lighter_background,
        paddingLeft: space.sm,
      }}
    >
      {hidden ? (
        <Pressable onPress={() => setUnfolded(true)} hitSlop={6} style={{ paddingVertical: 3 }}>
          <Text style={{ color: palette.muted, fontFamily: font.regular, fontSize: size.micro }}>
            {hidden} more {hidden === 1 ? 'step' : 'steps'}
          </Text>
        </Pressable>
      ) : null}

      {shown.map(({ block, result }) => (
        <ToolLine
          key={block.seq}
          block={block}
          result={result}
          expanded={expanded[block.seq]}
          onExpand={() => onExpand(block)}
        />
      ))}
    </View>
  )
}

/**
 * One tool call, one line.
 *
 * Name, what it was pointed at, and how it went — anything more is the body,
 * and the body is behind a tap. The status lives in the colour of the dot so
 * that it costs no width at all, and only a failure earns a second line,
 * because a failure is the one result you cannot act on without reading it.
 */
function ToolLine({
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
  const status = result?.status
  const tone =
    status === 'error' ? palette.red : status === 'interrupted' ? palette.orange : status ? palette.green : palette.muted
  const open = expanded !== undefined

  return (
    <View>
      <Pressable
        onPress={onExpand}
        style={({ pressed }) => ({
          flexDirection: 'row',
          alignItems: 'center',
          gap: space.sm,
          paddingVertical: 3,
          paddingHorizontal: space.xs,
          marginLeft: -space.xs,
          borderRadius: radius.sm,
          backgroundColor: pressed || open ? palette.dark_background : 'transparent',
        })}
      >
        <View style={{ width: 5, height: 5, borderRadius: 3, backgroundColor: tone }} />
        <Text style={{ color: palette.light_foreground, fontFamily: font.medium, fontSize: size.label }}>
          {block.tool}
        </Text>
        <Text
          style={{ flex: 1, color: palette.muted, fontFamily: font.regular, fontSize: size.label }}
          numberOfLines={1}
        >
          {block.summary}
        </Text>
        {status === 'error' ? (
          <Text style={{ color: palette.red, fontFamily: font.regular, fontSize: size.micro }}>failed</Text>
        ) : result?.lines ? (
          <Text style={{ color: palette.muted, fontFamily: font.regular, fontSize: size.micro }}>{result.lines}L</Text>
        ) : null}
      </Pressable>

      {status === 'error' && !open ? (
        <Text
          style={{
            color: alpha(palette.red, 0.75),
            fontFamily: font.regular,
            fontSize: size.micro,
            marginLeft: 5 + space.sm,
          }}
          numberOfLines={2}
        >
          {result?.summary}
        </Text>
      ) : null}

      {open ? (
        <ScrollView
          horizontal
          style={{
            marginTop: space.xs,
            marginBottom: space.xs,
            maxHeight: 240,
            backgroundColor: palette.darker_background,
            borderRadius: radius.sm,
            borderColor: palette.lighter_background,
            borderWidth: StyleSheet.hairlineWidth * 2,
          }}
        >
          <ScrollView nestedScrollEnabled style={{ maxHeight: 240 }}>
            <Text
              selectable
              style={{ color: palette.light_foreground, fontFamily: font.regular, fontSize: size.micro, padding: space.md }}
            >
              {expanded}
            </Text>
          </ScrollView>
        </ScrollView>
      ) : null}
    </View>
  )
}

/**
 * Everything that is not a tool call: what was said, and what was thought.
 *
 * What the agent says is set plainly across the full width with no card around
 * it — it is the thing on the screen worth reading, and a border only makes it
 * narrower. Only the person's own messages get a bubble, because on a phone the
 * useful question about a line is whose it is, and one bubble answers it.
 */
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
  const [thought, setThought] = useState(false)

  if (block.kind === 'text') {
    if (block.role === 'user') {
      return (
        <View
          style={{
            alignSelf: 'flex-end',
            maxWidth: '88%',
            backgroundColor: palette.selection,
            borderRadius: radius.md,
            paddingHorizontal: space.md,
            paddingVertical: space.sm,
          }}
        >
          <Text
            style={{ color: palette.bright_foreground, fontFamily: font.regular, fontSize: size.body, lineHeight: 20 }}
          >
            {block.text}
          </Text>
        </View>
      )
    }
    return (
      <Text
        selectable
        style={{ color: palette.foreground, fontFamily: font.regular, fontSize: size.body, lineHeight: 21 }}
      >
        {block.text}
      </Text>
    )
  }

  // Thinking that reached the phone with text in it is worth one dim line, and
  // that line is the thought itself rather than the word "thinking" — a label
  // that stays on screen long after the thinking stopped says nothing about
  // what the agent is doing now, which is what a label like that promises.
  if (block.kind === 'thinking') {
    if (!block.text) return null
    return (
      <Pressable
        onPress={() => setThought((was) => !was)}
        style={{ flexDirection: 'row', alignItems: 'flex-start', gap: space.sm }}
      >
        <Feather name={thought ? 'chevron-down' : 'chevron-right'} size={12} color={palette.muted} style={{ marginTop: 3 }} />
        <Text
          style={{ flex: 1, color: palette.muted, fontFamily: font.regular, fontSize: size.label, lineHeight: 18 }}
          numberOfLines={thought ? undefined : 1}
        >
          {block.text}
        </Text>
      </Pressable>
    )
  }

  if (block.kind === 'tool') {
    return <ToolLine block={block} result={result} expanded={expanded} onExpand={onExpand} />
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
function Composer({ session, keyboard }: { session: AgentSession; keyboard: boolean }) {
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
    // With the keyboard up it is the keyboard, not the gesture bar, below this
    // row — reserving room for both is how the field ends up half a thumb
    // higher than it needs to be on a screen that has none to spare.
    paddingBottom: keyboard ? space.sm : Math.max(insets.bottom, space.md),
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

      {/* Which road in — worth a line while you are reading, worth nothing
          while you are typing and the screen is down to a few lines. */}
      {keyboard ? null : (
        <Text style={{ color: palette.muted, fontFamily: font.regular, fontSize: size.micro, marginTop: space.xs }}>
          {session.writable === 'tmux' ? `tmux ${session.pane}` : 'the desktop types this — focus moves for a moment'}
        </Text>
      )}
    </View>
  )
}
