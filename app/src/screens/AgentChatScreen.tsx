import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ActivityIndicator,
  Animated,
  Image,
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
import { useAudioRecorder } from 'expo-audio'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { useConnection, usePalette } from '../state/ConnectionContext'
import { focusAgent } from '../api/alerts'
import type { AgentBlock, AgentEvent, AgentQuestion, AgentSession, AgentTasks, AgentWorker } from '../api/client'
import * as attach from '../api/attach'
import type { Attachment, Picked } from '../api/attach'
import * as dictate from '../api/dictate'
import { Body, Button, Caps, Chip, Meter, Notice } from '../ui/kit'
import { errorLine } from '../lib/errors'
import { StatusLine, inPane } from '../ui/agentkit'
import { AgentSkillsSheet } from './AgentSkillsSheet'
import { Markdown } from '../ui/markdown'
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
export function AgentChatScreen({
  session,
  onBack,
  onWorker,
}: {
  session: AgentSession
  onBack: () => void
  /**
   * Open one of this session's workers. Handed in rather than rendered here:
   * the worker screen draws itself out of this file's own pieces, and a chat
   * that reached for it would be two screens importing each other.
   */
  onWorker?: (worker: AgentWorker) => void
}) {
  const { call, client, palette } = useConnection()
  const [blocks, setBlocks] = useState<AgentBlock[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<unknown>(null)
  const [expanded, setExpanded] = useState<Record<number, string>>({})
  // The terminal as it actually looks. A permission prompt is drawn on screen
  // and never written to the transcript, so the numbered options this phone is
  // about to answer exist nowhere else.
  const [raw, setRaw] = useState<string | null>(null)
  /**
   * The skills sheet, and the draft it writes into.
   *
   * The draft is held here rather than in the composer because two things now
   * write to it: the person typing, and a command picked off the sheet that
   * needs an argument. A composer that owned its own text could be filled only
   * by the keyboard.
   */
  const [skills, setSkills] = useState(false)
  const [draft, setDraft] = useState('')

  /**
   * What the agent is saying right now, before the transcript has it.
   *
   * Held apart from `blocks` on purpose: this is not a block and must never be
   * mistaken for one. It carries no `seq`, nothing can be expanded out of it,
   * and it is thrown away rather than reconciled the moment the real thing
   * arrives underneath it.
   */
  const [live, setLive] = useState('')
  const scroller = useRef<ScrollView | null>(null)
  const atBottom = useRef(true)
  const keyboard = useKeyboardOpen()

  /*
   * Reading a session is being told about it, so the shade stops saying this
   * one is waiting — and stays quiet about it for as long as the chat is open.
   */
  useEffect(() => {
    focusAgent(session.id)
    return () => focusAgent(null)
  }, [session.id])

  /**
   * How far the desktop had got, last time it said anything.
   *
   * Kept in a ref rather than in state because nothing on screen is drawn from
   * it: it exists so that a re-open after a reconnect can ask for the blocks
   * this screen missed instead of the whole window again.
   */
  const cursor = useRef<number | null>(null)
  /**
   * Which run of the desktop's numbering that cursor was dealt from.
   *
   * Block numbers restart at one, and a daemon that was restarted while the
   * phone was away deals the same numbers out again — so the number alone is
   * not enough to resume from. This is handed straight back, and a desktop
   * that does not recognise it answers with the window instead.
   */
  const epoch = useRef<string | null>(null)

  /* Open the session, then let the daemon push the rest. */
  useEffect(() => {
    let live = true
    setLoading(true)
    setBlocks([])
    setExpanded({})
    setLive('')
    cursor.current = null
    epoch.current = null
    call<{ blocks: AgentBlock[]; cursor?: number; epoch?: string }>('agents.open', { id: session.id, limit: 120 })
      .then((res) => {
        if (!live) return
        setBlocks(res.blocks || [])
        if (typeof res.cursor === 'number') cursor.current = res.cursor
        epoch.current = res.epoch ?? null
        setError(null)
      })
      .catch((err) => live && setError(err))
      .finally(() => live && setLoading(false))

    return () => {
      live = false
      cursor.current = null
      epoch.current = null
      // Closing is what stops the desktop tailing a transcript nobody reads.
      call('agents.close', { id: session.id }).catch(() => {})
    }
  }, [call, session.id])

  /**
   * Come back after a reconnect.
   *
   * The desktop drops every open session the moment the event bus loses its
   * subscribers, which a dropped socket does — so a link that comes back comes
   * back with nothing being tailed, and this screen would sit there silently
   * showing a conversation that has moved on. Nothing said so: no error, no
   * empty state, just a chat that stopped. So every `hello` re-opens the
   * session, and does it from the cursor: the desktop answers with the blocks
   * that arrived while the phone was away, and only falls back to the whole
   * window when it cannot honour the cursor (`resumed: false`) — a session
   * that reloaded under us, or a gap the ring has already dropped.
   */
  useEffect(() => {
    if (!client) return
    return client.on('hello', () => {
      call<{ blocks: AgentBlock[]; cursor?: number; epoch?: string; resumed?: boolean }>('agents.open', {
        id: session.id,
        limit: 120,
        since: cursor.current,
        epoch: epoch.current,
      })
        .then((res) => {
          if (typeof res.cursor === 'number') cursor.current = res.cursor
          epoch.current = res.epoch ?? null
          const fresh = res.blocks || []
          // A daemon too old to know about `since` answers without `resumed`
          // and with the whole window, which is the behaviour this replaces —
          // treating that as a resume would double every block on screen.
          if (res.resumed) {
            if (fresh.length) setBlocks((prev) => [...prev, ...fresh])
          } else {
            setBlocks(fresh)
            setLive('')
          }
          setError(null)
        })
        .catch((err) => setError(err))
    })
  }, [call, client, session.id])

  useEffect(() => {
    if (!client) return
    return client.on('ev:agent', (data: AgentEvent) => {
      if (data.kind !== 'draft' && data.kind !== 'blocks') return
      if (data.id !== session.id) return
      if (data.kind === 'draft') {
        setLive((prev) => (data.append !== undefined ? prev + data.append : data.text || ''))
        return
      }
      // The record arriving is the end of the guess about it. The desktop says
      // so as well, and either message is enough — whichever lands first wins,
      // and the words are on screen once either way.
      setLive('')
      if (typeof data.cursor === 'number') cursor.current = data.cursor
      setBlocks((prev) => (data.reset ? data.blocks : [...prev, ...data.blocks]))
    })
  }, [client, session.id])

  /* Follow the conversation, unless the reader has scrolled up to look at something. */
  useEffect(() => {
    if (atBottom.current) requestAnimationFrame(() => scroller.current?.scrollToEnd({ animated: true }))
  }, [blocks, live])

  /* The keyboard eats half the screen; the tail has to come with it. */
  useEffect(() => {
    if (keyboard) requestAnimationFrame(() => scroller.current?.scrollToEnd({ animated: true }))
  }, [keyboard])

  const expand = useCallback(
    async (block: AgentBlock) => {
      // A chip that started a worker opens the worker. The desktop matched the
      // two by id before this screen ever saw either of them.
      const fanned = block.ref ? session.workers?.find((w) => w.ref === block.ref) : undefined
      if (fanned && onWorker) {
        onWorker(fanned)
        return
      }
      if (expanded[block.seq] !== undefined) {
        setExpanded(({ [block.seq]: _drop, ...rest }) => rest)
        return
      }
      try {
        const res = await call<{ text: string }>('agents.detail', { id: session.id, seq: block.seq })
        setExpanded((prev) => ({ ...prev, [block.seq]: res.text }))
      } catch (err) {
        // The expander holds text rather than a thrown value; a failed
        // detail must not arrive as a stack trace pretending to be output.
        setExpanded((prev) => ({ ...prev, [block.seq]: errorLine(err, 'the desktop would not send this') }))
      }
    },
    [call, expanded, onWorker, session.id, session.workers],
  )

  /**
   * Picking an answer off a numbered list.
   *
   * The option's position is the keystroke that chooses it — the terminal
   * draws the same list in the same order — so the desktop is told which
   * option on which block rather than which digit, and validates that against
   * what it actually asked. A stale screen then gets a refusal instead of
   * answering some later question by accident.
   */
  const answer = useCallback(
    (seq: number, question: number, choices: number[]) =>
      call<{ labels: string[] }>('agents.answer', { id: session.id, seq, question, choices }),
    [call, session.id],
  )

  const groups = useMemo(() => groupBlocks(blocks), [blocks])

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
        onToggleRaw={inPane(session) ? () => setRaw((was) => (was === null ? '' : null)) : undefined}
        onStatus={() => setSkills(true)}
      />

      {/* Pinned rather than scrolled past: this is status, not conversation.
          It is also the only thing on the screen that answers "is it nearly
          done", which is the question that brought anyone here. */}
      <TaskStrip session={session} />

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
        <Notice error={error} onDismiss={() => setError(null)} />
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
              session={session}
              block={group.row.block}
              result={group.row.result}
              expanded={expanded[group.row.block.seq]}
              onExpand={() => expand(group.row.block)}
              onAnswer={answer}
            />
          ),
        )}

        {live ? <LiveText text={live} /> : null}

        {session.state === 'working' ? <Working /> : null}

        {session.state === 'waiting' && session.prompt && !groups.some((g) => g.kind === 'row' && g.row.block.kind === 'question' && !g.row.result) ? (
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

      <Composer
        session={session}
        keyboard={keyboard}
        text={draft}
        onChangeText={setDraft}
        onSkills={() => setSkills(true)}
      />

      {/* Over everything, including the composer: choosing a command is the
          whole interaction while it is open, and half a chat behind it is
          just somewhere to tap by accident. */}
      {skills ? (
        <AgentSkillsSheet session={session} onCompose={setDraft} onClose={() => setSkills(false)} />
      ) : null}
    </KeyboardAvoidingView>
  )
}

export type ChatRow = { block: AgentBlock; result?: AgentBlock }
export type Group =
  | { kind: 'tools'; seq: number; rows: ChatRow[] }
  | { kind: 'row'; seq: number; row: ChatRow }

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
 * Out here rather than in the chat screen because a worker's transcript is the
 * same kind of file and is read the same way — the only difference between the
 * two screens is that one of them can be typed into.
 */
export function groupBlocks(blocks: AgentBlock[]): Group[] {
  const rows: ChatRow[] = []
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

/**
 * The list the agent is working through, folded to one line.
 *
 * An agent at work produces a great deal of traffic and very little news — it
 * ran `grep`, then read a file, then ran `grep` again — and none of it answers
 * the question somebody on a sofa is actually asking, which is whether the
 * thing they asked for is nearly done. The task list does: a handful of
 * sentences the agent wrote about the *work* rather than about the tools, and
 * a count of how many are behind it.
 *
 * Folded by default because one line is usually the whole answer. The count
 * and the sentence are already on the session frame, so the strip draws
 * immediately and the full list is fetched only if somebody opens it.
 */
function TaskStrip({ session }: { session: AgentSession }) {
  const { call, palette } = useConnection()
  const [open, setOpen] = useState(false)
  const [list, setList] = useState<AgentTasks | null>(null)
  const summary = session.tasks

  /* Re-read whenever the count moves, so an open strip keeps up. */
  useEffect(() => {
    if (!open) return
    let live = true
    call<AgentTasks>('agents.tasks', { id: session.id })
      .then((res) => live && setList(res))
      .catch(() => live && setList(null))
    return () => {
      live = false
    }
  }, [call, open, session.id, summary?.done, summary?.total, summary?.active])

  if (!summary?.total) return null
  const fraction = summary.total ? summary.done / summary.total : 0
  // Between two tasks an agent has not stopped, and a strip that says
  // "nothing in progress" in that moment reads as though it had.
  const line =
    summary.active ||
    (summary.next ? `next: ${summary.next}` : summary.done === summary.total ? 'all done' : 'nothing in progress')

  return (
    <View
      style={{
        paddingHorizontal: space.lg,
        paddingVertical: space.sm,
        backgroundColor: palette.darker_background,
        borderBottomWidth: StyleSheet.hairlineWidth * 2,
        borderBottomColor: palette.lighter_background,
      }}
    >
      <Pressable
        onPress={() => setOpen((was) => !was)}
        style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: space.sm, opacity: pressed ? 0.6 : 1 })}
      >
        <Feather name={open ? 'chevron-down' : 'chevron-right'} size={12} color={palette.muted} />
        <Text
          style={{ flex: 1, color: palette.light_foreground, fontFamily: font.regular, fontSize: size.label }}
          numberOfLines={1}
        >
          {line}
        </Text>
        <Text style={{ color: palette.muted, fontFamily: font.medium, fontSize: size.micro }}>
          {summary.done}/{summary.total}
        </Text>
        <View style={{ width: 44 }}>
          <Meter fraction={fraction} tone={fraction === 1 ? palette.green : palette.accent} height={3} />
        </View>
      </Pressable>

      {open ? (
        // A long plan must not push the conversation off the screen: the strip
        // is a header, and a header that takes half the display is a screen.
        <ScrollView nestedScrollEnabled style={{ maxHeight: 200, marginTop: space.sm }} contentContainerStyle={{ gap: 3 }}>
          {(list?.tasks || []).map((task) => (
            <View key={task.id} style={{ flexDirection: 'row', alignItems: 'flex-start', gap: space.sm }}>
              <Feather
                name={
                  task.status === 'completed' ? 'check-square' : task.status === 'in_progress' ? 'play' : 'square'
                }
                size={12}
                color={
                  task.status === 'completed'
                    ? palette.green
                    : task.status === 'in_progress'
                      ? palette.accent
                      : palette.muted
                }
                style={{ marginTop: 3 }}
              />
              <Text
                style={{
                  flex: 1,
                  color: task.status === 'completed' ? palette.muted : palette.light_foreground,
                  fontFamily: task.status === 'in_progress' ? font.medium : font.regular,
                  fontSize: size.micro,
                  lineHeight: 16,
                  textDecorationLine: task.status === 'completed' ? 'line-through' : 'none',
                }}
                numberOfLines={2}
              >
                {task.subject}
              </Text>
            </View>
          ))}
          {list === null ? <ActivityIndicator size="small" color={palette.accent} /> : null}
        </ScrollView>
      ) : null}
    </View>
  )
}

/**
 * Who this is, what it is running as, and how it is doing.
 *
 * Two rows rather than one because they answer different questions and only
 * one of them changes. The top row is identity — whose conversation, in what
 * directory, and whether it is moving. The bottom is the desktop's own status
 * line: model, context meter, permission mode, branch. On the desktop that
 * line is glanced at; here it is what tells you whether to send the agent off
 * on something long or compact it first, which is a decision you can only make
 * before you type.
 *
 * The status line is a button because the thing you do about a full context is
 * a slash command, and the sheet holding those is one tap from where the
 * number that prompted it is drawn.
 */
function Header({
  session,
  tone,
  onBack,
  raw,
  onToggleRaw,
  onStatus,
}: {
  session: AgentSession
  tone: string
  onBack: () => void
  raw: boolean
  onToggleRaw?: () => void
  onStatus?: () => void
}) {
  const palette = usePalette()
  const insets = useSafeAreaInsets()
  const vitals = session.vitals ?? null

  return (
    <View
      style={{
        paddingTop: insets.top + space.sm,
        paddingBottom: space.sm,
        paddingHorizontal: space.lg,
        backgroundColor: palette.dark_background,
        borderBottomWidth: StyleSheet.hairlineWidth * 2,
        borderBottomColor: palette.lighter_background,
        gap: space.sm,
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
        <Pressable onPress={onBack} hitSlop={12}>
          <Feather name="chevron-left" size={22} color={palette.foreground} />
        </Pressable>
        <View style={{ flex: 1 }}>
          <Text
            style={{ color: palette.bright_foreground, fontFamily: font.medium, fontSize: size.value }}
            numberOfLines={1}
          >
            {session.title}
          </Text>
          <Text style={{ color: palette.muted, fontFamily: font.regular, fontSize: size.label }} numberOfLines={1}>
            {session.job ? `background · ${session.job.detail || session.job.state}` : `${session.agent} · ${session.cwd || '—'}`}
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

      {vitals ? (
        <Pressable
          onPress={onStatus}
          disabled={!onStatus}
          hitSlop={6}
          style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
        >
          <StatusLine vitals={vitals} />
        </Pressable>
      ) : null}
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
/**
 * The answer as it is being typed, one poll behind the desktop's own screen.
 *
 * Deliberately plainer than the block that replaces it. The terminal has
 * already spent the markdown — the bold is bold, the asterisks are gone — so
 * running it back through the renderer would only invent structure that is not
 * there. It is set in the same body type as the real thing so the swap is not
 * a jolt, and dimmed a shade, because a draft that looked exactly like the
 * record would be a phone quietly claiming the file says something it does not
 * say yet.
 */
function LiveText({ text }: { text: string }) {
  const palette = usePalette()
  return (
    <Text
      style={{
        color: alpha(palette.foreground, 0.75),
        fontFamily: font.regular,
        fontSize: size.body,
        lineHeight: 20,
      }}
    >
      {text}
    </Text>
  )
}

function Working() {
  const palette = usePalette()
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
  const [error, setError] = useState<unknown>(null)

  useEffect(() => {
    let live = true
    const pull = () =>
      call<{ screen: string }>('agents.screen', { id: session.id, lines: 80 })
        .then((res) => live && (setScreen(res.screen), setError(null)))
        .catch((err) => live && setError(err))
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
      <Notice error={error} />
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
export function ToolRun({
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
  const palette = usePalette()
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
  const palette = usePalette()
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
export function Row({
  session,
  block,
  result,
  expanded,
  onExpand,
  onAnswer,
}: {
  // Absent when what is being drawn is a worker's transcript rather than a
  // session's. Nothing on this screen can be typed into then, which for every
  // block but a question changes nothing at all.
  session?: AgentSession | null
  block: AgentBlock
  result?: AgentBlock
  expanded?: string
  onExpand: () => void
  onAnswer?: (seq: number, question: number, choices: number[]) => Promise<{ labels: string[] }>
}) {
  const palette = usePalette()
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
    // Markdown only on the agent's side. What the person typed is shown back
    // exactly as they typed it — a message full of asterisks was probably
    // about asterisks, and a record that quietly reformats itself is worse
    // than one that is plain.
    return <Markdown text={block.text || ''} />
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

  if (block.kind === 'question') {
    return <QuestionCard session={session ?? null} block={block} result={result} onAnswer={onAnswer} />
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

/**
 * A multiple-choice question, with the options tappable.
 *
 * This is the one tool call that arrives whole rather than collapsed, and the
 * reason is the difference between watching an agent be stuck and getting it
 * unstuck. Everywhere else on this screen a phone reads; here it decides.
 *
 * The number beside each option is not decoration — it is the keystroke the
 * desktop is going to press, drawn where the terminal draws it, so what the
 * person taps and what the agent receives are visibly the same thing.
 *
 * Once answered the card stops being a control and becomes a record: the
 * options fall away and what was picked stays. The answer is read off the
 * transcript rather than remembered locally, so a question answered at the
 * keyboard settles here too, with nothing having to tell the phone.
 */
function QuestionCard({
  session,
  block,
  result,
  onAnswer,
}: {
  session: AgentSession | null
  block: AgentBlock
  result?: AgentBlock
  onAnswer?: (seq: number, question: number, choices: number[]) => Promise<{ labels: string[] }>
}) {
  const palette = usePalette()
  const questions = block.questions || []
  const answered = result?.answers
  const tone = answered ? palette.muted : palette.orange

  return (
    <View
      style={{
        borderLeftWidth: 2,
        borderLeftColor: tone,
        backgroundColor: answered ? 'transparent' : alpha(palette.orange, 0.07),
        borderRadius: radius.sm,
        paddingVertical: space.md,
        paddingHorizontal: space.md,
        gap: space.lg,
      }}
    >
      {questions.map((question, i) => (
        <Question
          key={`${block.seq}:${i}`}
          session={session}
          question={question}
          picked={pickedFrom(answered?.[question.question], question)}
          onAnswer={(choices) =>
            onAnswer
              ? onAnswer(block.seq, i, choices)
              : Promise.reject(new Error('nothing here can be answered'))
          }
        />
      ))}
    </View>
  )
}

/**
 * The answer map holds one label, or several when the question took several.
 *
 * Several arrive comma-joined, and a label may perfectly well contain a comma
 * of its own — so the whole string is checked against the options before it is
 * split, and a label that stands on its own is left alone.
 */
function pickedFrom(answer: unknown, question: AgentQuestion): string[] | null {
  if (Array.isArray(answer)) return answer.map(String)
  if (typeof answer !== 'string' || !answer) return null
  if (question.options.some((option) => option.label === answer)) return [answer]
  return answer.split(/\s*,\s*/).filter(Boolean)
}

function Question({
  session,
  question,
  picked,
  onAnswer,
}: {
  session: AgentSession | null
  question: AgentQuestion
  picked: string[] | null
  onAnswer: (choices: number[]) => Promise<{ labels: string[] }>
}) {
  const palette = usePalette()
  // Only ever set on a multi-select: a single-choice list submits on the tap,
  // so there is no moment between choosing and having chosen.
  const [checked, setChecked] = useState<number[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  // What this phone just sent, until the transcript catches up and says the
  // same thing. Without it the list stays live for the second or two the agent
  // takes to write the answer down, and a second tap is a stray digit typed
  // into whatever the terminal moved on to.
  const [sent, setSent] = useState<string[] | null>(null)

  const settled = picked ?? sent
  const answerable = Boolean(session?.writable) && !settled

  const submit = useCallback(
    async (choices: number[]) => {
      setBusy(true)
      setError(null)
      try {
        const { labels } = await onAnswer(choices)
        setChecked([])
        setSent(labels)
      } catch (err) {
        setError(err)
      } finally {
        setBusy(false)
      }
    },
    [onAnswer],
  )

  const tap = useCallback(
    (n: number) => {
      if (!answerable || busy) return
      if (!question.multiSelect) return void submit([n])
      setChecked((was) => (was.includes(n) ? was.filter((x) => x !== n) : [...was, n]))
    },
    [answerable, busy, question.multiSelect, submit],
  )

  return (
    <View style={{ gap: space.sm }}>
      {question.header ? <Caps tone={settled ? palette.muted : palette.orange}>{question.header}</Caps> : null}
      <Text
        style={{ color: palette.bright_foreground, fontFamily: font.regular, fontSize: size.body, lineHeight: 20 }}
      >
        {question.question}
      </Text>

      {settled ? (
        <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: space.sm }}>
          <Feather name="check" size={13} color={picked ? palette.green : palette.muted} style={{ marginTop: 3 }} />
          <Text style={{ flex: 1, color: palette.light_foreground, fontFamily: font.medium, fontSize: size.label }}>
            {settled.join(' · ')}
          </Text>
        </View>
      ) : (
        <View style={{ gap: 1 }}>
          {question.options.map((option, i) => (
            <Option
              key={option.label}
              n={i + 1}
              option={option}
              checked={checked.includes(i + 1)}
              enabled={answerable && !busy}
              onPress={() => tap(i + 1)}
            />
          ))}
        </View>
      )}

      {question.multiSelect && !settled ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
          <Text style={{ flex: 1, color: palette.muted, fontFamily: font.regular, fontSize: size.micro }}>
            pick as many as apply
          </Text>
          <Button
            label={checked.length ? `Send ${checked.length}` : 'Send'}
            icon="check"
            tone={palette.orange}
            disabled={!answerable || !checked.length}
            loading={busy}
            onPress={() => submit([...checked].sort((a, b) => a - b))}
          />
        </View>
      ) : null}

      {!session?.writable && !settled ? (
        <Text style={{ color: palette.muted, fontFamily: font.regular, fontSize: size.micro }}>
          Reading only — this one has to be answered at the desktop
        </Text>
      ) : null}
      <Notice error={error} style={{ marginBottom: 0 }} />
    </View>
  )
}

/**
 * One option: its number, its label, and what it means.
 *
 * The description is the half that decides the question and the half a phone
 * has no room for, so it is kept — two lines of it — rather than folded away
 * behind a tap nobody would take while deciding.
 */
function Option({
  n,
  option,
  checked,
  enabled,
  onPress,
}: {
  n: number
  option: { label: string; description?: string }
  checked: boolean
  enabled: boolean
  onPress: () => void
}) {
  const palette = usePalette()
  return (
    <Pressable
      onPress={onPress}
      disabled={!enabled}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: space.sm,
        paddingVertical: space.sm,
        paddingHorizontal: space.sm,
        borderRadius: radius.sm,
        borderWidth: StyleSheet.hairlineWidth * 2,
        borderColor: checked ? palette.orange : 'transparent',
        backgroundColor: checked || pressed ? palette.selection : palette.darker_background,
        opacity: enabled ? 1 : 0.6,
      })}
    >
      <Text
        style={{
          color: checked ? palette.orange : palette.muted,
          fontFamily: font.medium,
          fontSize: size.label,
          minWidth: 12,
          marginTop: 1,
        }}
      >
        {n}
      </Text>
      <View style={{ flex: 1 }}>
        <Text style={{ color: palette.bright_foreground, fontFamily: font.medium, fontSize: size.label }}>
          {option.label}
        </Text>
        {option.description ? (
          <Text
            style={{ color: palette.muted, fontFamily: font.regular, fontSize: size.micro, lineHeight: 15, marginTop: 2 }}
            numberOfLines={2}
          >
            {option.description}
          </Text>
        ) : null}
      </View>
    </Pressable>
  )
}

/** Pictures per message — the desktop refuses more, so the phone does not offer it. */
const MAX_SHOTS = 6

/**
 * A picture waiting to be sent, and how far across it has got.
 *
 * The thumbnail is the whole status display: dimmed while the bytes are still
 * crossing, outlined in red if they never did. A picture that failed is left in
 * place rather than dropped, because the person chose it and losing it silently
 * is worse than a message that goes without it.
 */
function Thumbnail({ shot, onRemove }: { shot: Attachment; onRemove: () => void }) {
  const palette = usePalette()
  const settling = !shot.path && !shot.error
  return (
    <Pressable onPress={onRemove} style={{ width: 56, height: 56 }}>
      <Image
        source={{ uri: shot.uri }}
        style={{
          width: 56,
          height: 56,
          borderRadius: radius.sm,
          borderWidth: StyleSheet.hairlineWidth * 2,
          borderColor: shot.error ? palette.red : palette.lighter_background,
          opacity: settling ? 0.4 : 1,
        }}
      />
      {settling ? (
        <View style={[StyleSheet.absoluteFill, { alignItems: 'center', justifyContent: 'center' }]}>
          <ActivityIndicator size="small" color={palette.accent} />
        </View>
      ) : (
        <View
          style={{
            position: 'absolute',
            top: -4,
            right: -4,
            width: 16,
            height: 16,
            borderRadius: 8,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: shot.error ? palette.red : palette.dark_background,
          }}
        >
          <Feather name="x" size={10} color={palette.bright_foreground} />
        </View>
      )}
    </Pressable>
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
 *
 * The paperclip is the third thing it does, and the one that changes what can
 * be asked from a sofa. "Why does this look wrong" is a question about a
 * picture, and until the picture can cross, the answer is to get up. The
 * screenshot goes to the desktop and the agent is handed its path — a terminal
 * carries text and nothing else, so the path *is* how an image is passed, not
 * a workaround for not being able to pass one.
 */
function Composer({
  session,
  keyboard,
  text,
  onChangeText,
  onSkills,
}: {
  session: AgentSession
  keyboard: boolean
  text: string
  onChangeText: (value: string) => void
  onSkills: () => void
}) {
  const { call, client, hello, palette } = useConnection()
  const insets = useSafeAreaInsets()
  const setText = onChangeText
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [acknowledged, setAcknowledged] = useState(false)
  const [shots, setShots] = useState<Attachment[]>([])
  const [sources, setSources] = useState(false)
  /**
   * Dictation, in the two states it is visible in: holding the microphone
   * open, and waiting for the desktop to say what it heard. They are separate
   * because only the first one can be cancelled — once the sound is across,
   * the transcription is a second and a half and there is nothing to abandon.
   */
  const recorder = useAudioRecorder(dictate.RECORDING)
  const [listening, setListening] = useState(false)
  const [hearing, setHearing] = useState(false)
  const [held, setHeld] = useState(0)

  const needsWarning = session.writable === 'wtype' && !acknowledged
  const canAttach = (hello?.capabilities?.agents as { attach?: boolean } | undefined)?.attach === true
  const ready = shots.filter((shot) => shot.path)
  const settling = shots.some((shot) => !shot.path && !shot.error)
  const canCommand = (hello?.capabilities?.agents as { commands?: boolean } | undefined)?.commands === true
  const speech = hello?.capabilities?.dictation as { available?: boolean; maxSeconds?: number } | undefined
  const canDictate = speech?.available === true
  const maxHold = speech?.maxSeconds ?? 300
  const crowded = canCommand && (session.vitals?.context?.percent ?? 0) >= 66

  const guard = useCallback(
    async (what: () => Promise<unknown>) => {
      setBusy(true)
      setError(null)
      try {
        await what()
      } catch (err) {
        setError(err)
      } finally {
        setBusy(false)
      }
    },
    [],
  )

  const send = useCallback(() => {
    const body = text.trim()
    const paths = ready.map((shot) => shot.path as string)
    if (!body && !paths.length) return
    // Cleared optimistically: the transcript is the receipt, and a field that
    // keeps the text after a successful send invites sending it twice.
    setText('')
    setShots([])
    void guard(async () => {
      try {
        const result = paths.length
          ? await call<{ submitted?: boolean }>('agents.attach', { id: session.id, paths, text: body })
          : await call<{ submitted?: boolean }>('agents.send', { id: session.id, text: body })
        // The desktop typed it and watched it stay in the agent's composer.
        // Optimism ends here: a message that was not asked is worse than an
        // error, because the row goes on saying the agent is working and the
        // text this field threw away is the only copy there was.
        if (result?.submitted === false) throw new Error('typed, but the agent did not take it — it is still in the composer on the desktop')
      } catch (err) {
        setText(body)
        setShots(ready)
        throw err
      }
    })
  }, [call, guard, ready, session.id, text])

  /**
   * Pick a picture, and push it across while the caption is still being typed.
   *
   * Uploading on pick rather than on send is what keeps the send instant: by
   * the time anyone has finished writing "why is this off by one" the bytes are
   * already on the desktop and all that is left to type is a path. A picture
   * that failed to cross says so on its own thumbnail and does not block the
   * message it came with.
   */
  const add = useCallback(
    async (pick: () => Promise<Picked | null>) => {
      setSources(false)
      setError(null)
      if (!client) return
      let picked: Picked | null = null
      try {
        picked = await pick()
      } catch (err) {
        setError(err)
        return
      }
      if (!picked) return
      const key = `${picked.name}:${Date.now()}`
      const shot: Attachment = { key, uri: picked.uri, name: picked.name }
      setShots((prev) => (prev.length >= MAX_SHOTS ? prev : [...prev, shot]))
      try {
        const path = await attach.upload(client, picked)
        setShots((prev) => prev.map((s) => (s.key === key ? { ...s, path } : s)))
      } catch (err) {
        setShots((prev) => prev.map((s) => (s.key === key ? { ...s, error: errorLine(err, 'the upload failed') } : s)))
      }
    },
    [client],
  )

  /**
   * Hold the microphone open until the next tap.
   *
   * A press-and-hold button would be the phone habit, but the thing being
   * dictated here is a paragraph about a bug rather than "on my way" — a
   * thumb that has to stay down for forty seconds cannot scroll back up the
   * transcript to check what the agent actually asked.
   */
  const listen = useCallback(async () => {
    setError(null)
    try {
      await dictate.ready()
      await recorder.prepareToRecordAsync(dictate.RECORDING)
      recorder.record()
      setHeld(0)
      setListening(true)
    } catch (err) {
      setError(err)
    }
  }, [recorder])

  /**
   * Stop, and either send the sound off to be read or drop it on the floor.
   *
   * The text lands in the field rather than in the conversation. Whisper gets
   * a name wrong every so often, and the repair for that is a cursor — a
   * dictation that sent itself would make the only fix "say it all again".
   * What is already typed is kept: dictating is another way of writing into
   * this field, not a replacement for what it holds.
   */
  const heard = useCallback(
    async (keep: boolean) => {
      setListening(false)
      let uri: string | null = null
      try {
        uri = await dictate.finish(recorder)
      } catch (err) {
        setError(err)
        return
      }
      if (!keep || !uri || !client) return
      setHearing(true)
      try {
        const said = await dictate.transcribe(client, call, uri)
        if (said) setText(text.trim() ? `${text.trim()} ${said}` : said)
        else setError('the desktop heard nothing in that')
      } catch (err) {
        setError(err)
      } finally {
        setHearing(false)
      }
    },
    [call, client, recorder, setText, text],
  )

  /**
   * The counter, and the stop the desktop would otherwise have to enforce.
   *
   * `voxtype` publishes how much audio it will read in one go; a recording
   * left running past that would be truncated on the desktop with nothing on
   * this screen having said so. Ending it here means the last thing said made
   * it in.
   */
  useEffect(() => {
    if (!listening) return undefined
    const timer = setInterval(() => {
      setHeld((was) => {
        const now = was + 1
        if (now >= maxHold) void heard(true)
        return now
      })
    }, 1000)
    return () => clearInterval(timer)
  }, [heard, listening, maxHold])

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
    // A background conversation that has stopped can still be answered — not
    // by typing into a terminal it never had, but by sending it back out with
    // the reply as its prompt. `--resume` picks the conversation up whole, so
    // to the person on the phone this is simply the chat continuing; the gate
    // is the same spawn switch that starting any agent from a phone is behind.
    const canSpawn = (hello?.capabilities?.agents as { spawn?: boolean } | undefined)?.spawn === true
    if (session.job && session.job.live === false && canSpawn) {
      const continueInBackground = () => {
        const body = text.trim()
        if (!body) return
        setText('')
        void guard(async () => {
          try {
            await call('agents.spawn', {
              resume: session.id.slice(session.agent.length + 1),
              background: true,
              prompt: body,
            })
          } catch (err) {
            setText(body)
            throw err
          }
        })
      }
      return (
        <View style={{ ...frame, gap: space.sm }}>
          <Notice error={error} onDismiss={() => setError(null)} style={{ marginBottom: 0 }} />
          <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: space.sm }}>
            <TextInput
              value={text}
              onChangeText={setText}
              placeholder="continue in the background…"
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
              onPress={continueInBackground}
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
              this agent finished — your reply resumes it as a new background run
            </Text>
          )}
        </View>
      )
    }
    return (
      <View style={{ ...frame, flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
        <Feather name="eye" size={14} color={palette.muted} />
        <Text style={{ flex: 1, color: palette.muted, fontFamily: font.regular, fontSize: size.label }}>
          {/* Two different reasons wear the same silence, and blaming the
              desktop for the wrong one sends people hunting for a tmux that
              would not have helped. A background agent has no terminal to be
              reached: it was started detached, and answering it is not
              something this desktop can do on your behalf. */}
          {session.job
            ? session.job.live === false
              ? 'Reading only — this background agent finished, and starting one from the phone is off'
              : 'Reading only — this agent is mid-run in the background, with no terminal to type into'
            : 'Reading only — nothing on that desktop can reach this terminal'}
        </Text>
      </View>
    )
  }

  if (needsWarning) {
    return (
      <View style={{ ...frame, gap: space.sm }}>
        <Caps tone={palette.orange}>The desktop will type this itself</Caps>
        <Body tone={palette.muted}>
          This agent is in no multiplexer's pane, so the desktop focuses its window and types on your behalf. It steals
          focus for a moment, and it will interleave with anyone typing at the keyboard. Start it with{' '}
          <Text style={{ fontFamily: font.medium }}>omarchy-connect agent run</Text> to get a cleaner road.
        </Body>
        <Button label="Type anyway" icon="edit-2" tone={palette.orange} onPress={() => setAcknowledged(true)} />
      </View>
    )
  }

  return (
    <View style={frame}>
      <Notice error={error} onDismiss={() => setError(null)} style={{ marginBottom: space.sm }} />

      {/* Where a picture comes from, only while one is being chosen. Three
          sources rather than one because a screenshot is in a different place
          depending on how it got there — and the clipboard, which is where it
          is a second after being cropped, is the one no picker can reach. */}
      {sources ? (
        <View style={{ flexDirection: 'row', gap: space.sm, marginBottom: space.sm }}>
          <Chip label="Photos" onPress={() => void add(attach.fromLibrary)} />
          <Chip label="Files" onPress={() => void add(attach.fromFiles)} />
          <Chip label="Paste" onPress={() => void add(attach.fromClipboard)} />
          <View style={{ flex: 1 }} />
          <Chip label="✕" onPress={() => setSources(false)} />
        </View>
      ) : null}

      {shots.length ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ gap: space.sm, paddingBottom: space.sm }}
          keyboardShouldPersistTaps="handled"
        >
          {shots.map((shot) => (
            <Thumbnail key={shot.key} shot={shot} onRemove={() => setShots((prev) => prev.filter((s) => s.key !== shot.key))} />
          ))}
        </ScrollView>
      ) : null}

      {/* The keys scroll and `stop` does not. Seven chips do not fit across a
          phone, and the one that must always be reachable is the one that
          interrupts — a row that pushed it off the edge would hide it exactly
          when it was wanted. */}
      <View style={{ flexDirection: 'row', gap: space.sm, marginBottom: space.sm, alignItems: 'center' }}>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ gap: space.sm }}
          style={{ flex: 1 }}
        >
          {QUICK.map((quick) => (
            <Chip
              key={quick.key}
              label={quick.label}
              tone={session.state === 'waiting' ? palette.orange : undefined}
              active={session.state === 'waiting'}
              onPress={() => press(quick.key)}
            />
          ))}
          {/* Compacting is the one command that earns a permanent button, and
              only once it is the thing you would want. A conversation past two
              thirds of its window is about to start losing the beginning of
              itself, and on a phone that is news you would otherwise never
              get — nothing else on this screen is going to mention it. */}
          {crowded ? (
            <Chip
              label="compact"
              tone={palette.orange}
              active
              onPress={() => void guard(() => call('agents.command', { id: session.id, name: 'compact' }))}
            />
          ) : null}
        </ScrollView>
        <Chip label="stop" tone={palette.red} onPress={() => press('C-c')} />
      </View>

      <View style={{ flexDirection: 'row', gap: space.sm, alignItems: 'flex-end' }}>
        {/* Everything the agent answers to by name. The reason it sits beside
            the field rather than in a menu somewhere: a slash command is the
            one part of a coding agent already shaped for a device with no
            keyboard, and it should cost one tap to reach. */}
        {canCommand ? (
          <Pressable
            onPress={onSkills}
            hitSlop={8}
            style={({ pressed }) => ({
              paddingHorizontal: space.md,
              paddingVertical: space.md,
              justifyContent: 'center',
              backgroundColor: pressed ? palette.selection : palette.darker_background,
              borderColor: palette.lighter_background,
              borderWidth: 1,
              borderRadius: radius.sm,
            })}
          >
            <Feather name="command" size={16} color={palette.muted} />
          </Pressable>
        ) : null}
        {canAttach ? (
          <Pressable
            onPress={() => setSources((was) => !was)}
            disabled={shots.length >= MAX_SHOTS}
            hitSlop={8}
            style={({ pressed }) => ({
              paddingHorizontal: space.md,
              paddingVertical: space.md,
              justifyContent: 'center',
              backgroundColor: pressed || sources ? palette.selection : palette.darker_background,
              borderColor: palette.lighter_background,
              borderWidth: 1,
              borderRadius: radius.sm,
              opacity: shots.length >= MAX_SHOTS ? 0.4 : 1,
            })}
          >
            <Feather name="paperclip" size={16} color={sources ? palette.accent : palette.muted} />
          </Pressable>
        ) : null}
        {/* Speak instead of typing, with the desktop doing the listening —
            its Whisper model knows what hyprctl and cherry-pick are, and the
            recording never leaves the two machines that already talk to each
            other. Tap to open the microphone, tap again to send the sound
            across; hold to throw the take away. */}
        {canDictate ? (
          <Pressable
            onPress={() => void (listening ? heard(true) : listen())}
            onLongPress={() => void (listening ? heard(false) : null)}
            disabled={hearing}
            hitSlop={8}
            style={({ pressed }) => ({
              paddingHorizontal: space.md,
              paddingVertical: space.md,
              justifyContent: 'center',
              alignItems: 'center',
              minWidth: 44,
              backgroundColor: pressed || listening ? palette.selection : palette.darker_background,
              borderColor: listening ? palette.red : palette.lighter_background,
              borderWidth: 1,
              borderRadius: radius.sm,
              opacity: hearing ? 0.6 : 1,
            })}
          >
            {hearing ? (
              <ActivityIndicator size="small" color={palette.accent} />
            ) : listening ? (
              /* The count is the only honest reassurance a microphone can
                 give: nothing else on screen proves it is still open. */
              <Text style={{ color: palette.red, fontFamily: font.medium, fontSize: size.micro }}>
                {`${Math.floor(held / 60)}:${String(held % 60).padStart(2, '0')}`}
              </Text>
            ) : (
              <Feather name="mic" size={16} color={palette.muted} />
            )}
          </Pressable>
        ) : null}
        <TextInput
          value={text}
          onChangeText={setText}
          placeholder={inPane(session) ? 'answer the agent…' : 'the desktop will type this…'}
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
          disabled={busy || settling || (!text.trim() && !ready.length)}
          style={({ pressed }) => ({
            paddingHorizontal: space.lg,
            paddingVertical: space.md,
            justifyContent: 'center',
            backgroundColor: pressed ? palette.selection : palette.lighter_background,
            borderRadius: radius.sm,
            opacity: busy || settling || (!text.trim() && !ready.length) ? 0.4 : 1,
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
          {listening
            ? 'listening — tap to transcribe on the desktop, hold to discard'
            : hearing
              ? 'the desktop is reading it back'
              : shots.length
                ? 'the desktop keeps the picture and hands the agent its path'
                : inPane(session)
                  ? `${session.writable} ${session.pane}`
                  : 'the desktop types this — focus moves for a moment'}
        </Text>
      )}
    </View>
  )
}
