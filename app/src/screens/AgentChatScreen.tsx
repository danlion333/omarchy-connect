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
import {
  Body,
  Button,
  Caps,
  Chip,
  Empty,
  Hint,
  IconButton,
  Label,
  Meter,
  Mono,
  Notice,
  Title,
  type IconName,
} from '../ui/kit'
import { errorLine } from '../lib/errors'
import { StatusLine, inPane } from '../ui/agentkit'
import { AgentSkillsSheet } from './AgentSkillsSheet'
import { Markdown } from '../ui/markdown'
import { ago, clock } from '../lib/format'
import {
  capBlocks,
  groupBlocks,
  sameRow,
  sameToolRun,
  type ChatRow,
  type Group,
} from '../lib/transcript'
import { MAX_FONT_SCALE, alpha, font, line, radius, size, space, touch } from '../theme'

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
  const { call, client, palette, hello, status, error: linkError, reconnect } = useConnection()
  const [blocks, setBlocks] = useState<AgentBlock[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<unknown>(null)
  /** Bumped by the retry on a failed open; nothing else reads it. */
  const [attempt, setAttempt] = useState(0)
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
        setBlocks(capBlocks(res.blocks || []))
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
  }, [call, session.id, attempt])

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
            if (fresh.length) setBlocks((prev) => capBlocks([...prev, ...fresh]))
          } else {
            setBlocks(capBlocks(fresh))
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
      setBlocks((prev) => capBlocks(data.reset ? data.blocks : [...prev, ...data.blocks]))
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

  /**
   * The keys and commands the top of the screen sends — an interrupt, a
   * compact, an answer to a prompt the transcript never saw. One guard for all
   * of them, so the button that was pressed is the one that spins and the
   * failure lands under the header rather than inside the composer that had
   * nothing to do with it.
   */
  const [acting, setActing] = useState<string | null>(null)
  const [actError, setActError] = useState<unknown>(null)
  const act = useCallback(async (name: string, what: () => Promise<unknown>) => {
    setActing(name)
    setActError(null)
    try {
      await what()
    } catch (err) {
      setActError(err)
    } finally {
      setActing(null)
    }
  }, [])
  const press = useCallback(
    (key: string) => void act(key, () => call('agents.key', { id: session.id, key })),
    [act, call, session.id],
  )
  // Compacting is the one command that earns a permanent button, and only
  // once it is the thing you would want. A conversation past two thirds of
  // its window is about to start losing the beginning of itself, and on a
  // phone that is news you would otherwise never get — nothing else on this
  // screen is going to mention it.
  const canCommand = (hello?.capabilities?.agents as { commands?: boolean } | undefined)?.commands === true
  const crowded = canCommand && (session.vitals?.context?.percent ?? 0) >= 66
  const compact = useCallback(
    () => void act('compact', () => call('agents.command', { id: session.id, name: 'compact' })),
    [act, call, session.id],
  )

  const groups = useMemo(() => groupBlocks(blocks), [blocks])

  /**
   * The question the agent is stopped on, if it is stopped on one.
   *
   * Drawn above the composer rather than at its place in the transcript: it is
   * the one thing on this screen that wants a decision, and a decision should
   * not have to be scrolled to. Once answered it goes back into the record
   * where it happened. There is only ever one — an agent that has asked is an
   * agent that has stopped — but the search runs from the end regardless.
   */
  const pending = useMemo<Extract<Group, { kind: 'row' }> | null>(() => {
    for (let i = groups.length - 1; i >= 0; i -= 1) {
      const group = groups[i]
      if (group.kind === 'row' && group.row.block.kind === 'question' && !group.row.result) return group
    }
    return null
  }, [groups])

  const offline = status !== 'connected'
  const settling = status === 'connecting' || status === 'reconnecting'

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
        onBack={onBack}
        raw={raw !== null}
        onToggleRaw={inPane(session) ? () => setRaw((was) => (was === null ? '' : null)) : undefined}
        onStatus={() => setSkills(true)}
        onCompact={crowded && session.writable ? compact : undefined}
        onStop={session.writable ? () => press('C-c') : undefined}
        acting={acting}
      />

      {/* Pinned rather than scrolled past: this is status, not conversation.
          It is also the only thing on the screen that answers "is it nearly
          done", which is the question that brought anyone here. */}
      <TaskStrip session={session} />

      {offline || actError ? (
        <View style={{ paddingHorizontal: space.lg, paddingTop: space.md }}>
          {offline ? (
            <Notice
              tone="warning"
              icon="wifi-off"
              error={linkError || (settling ? 'Reconnecting to the desktop' : 'Not connected to the desktop')}
              action={settling ? null : { label: 'Reconnect', icon: 'refresh-cw', onPress: reconnect }}
            />
          ) : null}
          <Notice error={actError} onDismiss={() => setActError(null)} />
        </View>
      ) : null}

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
        {loading ? <TranscriptSkeleton /> : null}
        <Notice
          error={error}
          onDismiss={() => setError(null)}
          action={{ label: 'Try again', icon: 'refresh-cw', onPress: () => setAttempt((n) => n + 1) }}
        />
        {!loading && !error && !groups.length ? (
          <Empty
            icon="message-square"
            text={session.state === 'starting' ? 'Starting · nothing in the transcript yet' : 'Nothing said yet'}
          />
        ) : null}

        {groups.map((group, i) => {
          // The pending question is drawn above the composer instead.
          if (group === pending) return null
          const mark = dayMark(i > 0 ? groupAt(groups[i - 1]) : undefined, groupAt(group))
          const item =
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
                onExpand={expand}
                onAnswer={answer}
              />
            )
          return mark ? (
            <React.Fragment key={group.seq}>
              <DayMark label={mark} />
              {item}
            </React.Fragment>
          ) : (
            item
          )
        })}

        {live ? <LiveText text={live} /> : null}

        {session.state === 'working' ? <Working /> : null}

        {session.state === 'gone' ? <Hint icon="slash">Gone · this agent is no longer running</Hint> : null}
      </ScrollView>

      {pending ? (
        <Pinned keyboard={keyboard}>
          <QuestionCard session={session} block={pending.row.block} result={pending.row.result} onAnswer={answer} live />
        </Pinned>
      ) : session.state === 'waiting' && session.prompt ? (
        <Pinned keyboard={keyboard}>
          <WaitingCard session={session} onKey={session.writable ? press : undefined} acting={acting} />
        </Pinned>
      ) : null}

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

/** Whether the software keyboard is up, so chrome can get out of its way. */
export function useKeyboardOpen(): boolean {
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

/* ── time ────────────────────────────────────────────────────────────── */

/** When a group happened: the first block in it. */
const groupAt = (group: Group): number => (group.kind === 'tools' ? group.rows[0].block.at : group.row.block.at)

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/**
 * The day a message belongs to, said only when it changes.
 *
 * A transcript is read in order and timestamps on every turn are noise the
 * reader learns to skip; a line saying "yesterday" where yesterday began is
 * the one piece of time that changes how the rest is read. Today is not
 * announced at the top of a chat that is all today.
 */
function dayMark(previous: number | undefined, at: number): string | null {
  if (!at) return null
  const day = new Date(at)
  const today = new Date()
  if (previous !== undefined) {
    if (new Date(previous).toDateString() === day.toDateString()) return null
    if (day.toDateString() === today.toDateString()) return 'today'
  } else if (day.toDateString() === today.toDateString()) {
    return null
  }
  const yesterday = new Date(today)
  yesterday.setDate(today.getDate() - 1)
  if (day.toDateString() === yesterday.toDateString()) return 'yesterday'
  return `${day.getDate()} ${MONTHS[day.getMonth()]}`
}

function DayMark({ label }: { label: string }) {
  return (
    <View style={{ alignItems: 'center', paddingVertical: space.xs }}>
      <Caps>{label}</Caps>
    </View>
  )
}

/**
 * The bottom of the screen that is not the composer: a question, a prompt.
 *
 * Bounded so a question with nine long options cannot push the field it sits
 * over off the screen, and bounded harder while the keyboard is up, because
 * then the screen is down to a few lines and the field is the one being used.
 */
function Pinned({ keyboard, children }: { keyboard: boolean; children: React.ReactNode }) {
  const palette = usePalette()
  return (
    <ScrollView
      style={{ maxHeight: keyboard ? 180 : 380, flexGrow: 0, backgroundColor: palette.background }}
      contentContainerStyle={{ paddingHorizontal: space.lg, paddingBottom: space.md }}
      keyboardShouldPersistTaps="handled"
      nestedScrollEnabled
    >
      {children}
    </ScrollView>
  )
}

/* ── the head of the screen ──────────────────────────────────────────── */

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
  const headline =
    summary.active ||
    (summary.next ? `Next · ${summary.next}` : summary.done === summary.total ? 'All done' : 'Between tasks')

  return (
    <View
      style={{
        paddingHorizontal: space.lg,
        backgroundColor: palette.darker_background,
        borderBottomWidth: StyleSheet.hairlineWidth * 2,
        borderBottomColor: palette.lighter_background,
      }}
    >
      <Pressable
        onPress={() => setOpen((was) => !was)}
        accessibilityRole="button"
        accessibilityLabel={`${summary.done} of ${summary.total} tasks done`}
        accessibilityState={{ expanded: open }}
        style={({ pressed }) => ({
          flexDirection: 'row',
          alignItems: 'center',
          gap: space.sm,
          minHeight: touch - 4,
          opacity: pressed ? 0.6 : 1,
        })}
      >
        <Feather name={open ? 'chevron-down' : 'chevron-right'} size={13} color={palette.muted} />
        <Label style={{ flex: 1 }}>{headline}</Label>
        <Caps tone={palette.light_foreground}>
          {summary.done}/{summary.total}
        </Caps>
        <View style={{ width: 44 }}>
          <Meter fraction={fraction} tone={fraction === 1 ? palette.green : palette.accent} height={3} />
        </View>
      </Pressable>

      {open ? (
        // A long plan must not push the conversation off the screen: the strip
        // is a header, and a header that takes half the display is a screen.
        <ScrollView
          nestedScrollEnabled
          style={{ maxHeight: 200 }}
          contentContainerStyle={{ gap: space.xs, paddingBottom: space.md }}
        >
          {(list?.tasks || []).map((task) => {
            const done = task.status === 'completed'
            const now = task.status === 'in_progress'
            return (
              <View key={task.id} style={{ flexDirection: 'row', alignItems: 'flex-start', gap: space.sm }}>
                <Feather
                  name={done ? 'check-square' : now ? 'play' : 'square'}
                  size={12}
                  color={done ? palette.green : now ? palette.accent : palette.muted}
                  style={{ marginTop: 3 }}
                />
                <Label
                  numberOfLines={2}
                  style={{
                    flex: 1,
                    color: done ? palette.muted : palette.light_foreground,
                    fontFamily: now ? font.medium : font.regular,
                    textDecorationLine: done ? 'line-through' : 'none',
                  }}
                >
                  {task.subject}
                </Label>
              </View>
            )
          })}
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
 * one of them changes. The top row is identity — whose conversation, and
 * whether it is moving. The bottom is the desktop's own status line: model,
 * context meter, permission mode. On the desktop that line is glanced at; here
 * it is what tells you whether to send the agent off on something long or
 * compact it first, which is a decision you can only make before you type.
 *
 * The status line is a button because the thing you do about a full context is
 * a slash command, and the sheet holding those is one tap from where the
 * number that prompted it is drawn.
 *
 * Three actions can sit on the right and rarely do at once: the terminal is
 * there only for a session in a pane, compact only while the context is
 * crowded, and the interrupt only where a key can reach.
 *
 * Not a `ScreenHeader`, on purpose. This is a chat, not a tab: the name on it
 * is the conversation's own title rather than a caps label, and a back button
 * has to come before it because there is nowhere else to go.
 */
function Header({
  session,
  onBack,
  raw,
  onToggleRaw,
  onStatus,
  onCompact,
  onStop,
  acting,
}: {
  session: AgentSession
  onBack: () => void
  raw: boolean
  onToggleRaw?: () => void
  onStatus?: () => void
  onCompact?: () => void
  onStop?: () => void
  acting: string | null
}) {
  const palette = usePalette()
  const insets = useSafeAreaInsets()
  const vitals = session.vitals ?? null
  const tone =
    session.state === 'waiting'
      ? palette.orange
      : session.state === 'working'
        ? palette.green
        : session.state === 'gone'
          ? palette.red
          : palette.muted

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
        gap: space.sm,
      }}
    >
      <IconButton icon="chevron-left" label="Back" onPress={onBack} />
      <View style={{ flex: 1, minWidth: 0, marginLeft: space.xs, gap: 2 }}>
        <Title>{session.title}</Title>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm, minHeight: line.micro }}>
          <Pulse tone={tone} on={session.state === 'working'} size={7} />
          <Caps tone={tone}>{session.state}</Caps>
          {vitals ? (
            <Pressable
              onPress={onStatus}
              disabled={!onStatus}
              accessibilityRole="button"
              accessibilityLabel="Skills and commands"
              style={({ pressed }) => ({ flex: 1, opacity: pressed ? 0.6 : 1 })}
            >
              <StatusLine vitals={vitals} dense />
            </Pressable>
          ) : null}
        </View>
      </View>
      {onToggleRaw ? (
        <IconButton
          icon="terminal"
          label={raw ? 'Show the chat' : 'Show the terminal'}
          tone={raw ? palette.accent : undefined}
          onPress={onToggleRaw}
        />
      ) : null}
      {onCompact ? (
        <IconButton
          icon="minimize-2"
          label="Compact the context"
          tone={palette.orange}
          loading={acting === 'compact'}
          onPress={onCompact}
        />
      ) : null}
      {onStop ? (
        <IconButton icon="square" label="Interrupt the agent" tone={palette.red} loading={acting === 'C-c'} onPress={onStop} />
      ) : null}
    </View>
  )
}

/**
 * The status dot, breathing while the agent works.
 *
 * A still dot cannot say whether a session is alive or wedged, and that is the
 * question anyone opening this screen is actually asking. The kit's
 * `StatusDot` has a `pulse` that only dims; this one moves, and belongs
 * beside it once a second screen wants a heartbeat.
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

/* ── the transcript ──────────────────────────────────────────────────── */

/**
 * The shape of a conversation before there is one.
 *
 * A question on the right, an answer on the left, a line of ledger under it —
 * drawn in the card's own greys so the screen reads as "loading a chat"
 * rather than "blank", and so that the real rows land where the eye already
 * is.
 */
function TranscriptSkeleton() {
  const palette = usePalette()
  const bar = (width: `${number}%`, height: number, right?: boolean) => (
    <View
      style={{
        width,
        height,
        borderRadius: radius.sm,
        backgroundColor: right ? palette.selection : palette.dark_background,
        alignSelf: right ? 'flex-end' : 'flex-start',
      }}
    />
  )
  return (
    <View style={{ gap: space.md, paddingTop: space.sm }} accessibilityLabel="Opening the transcript">
      {bar('55%', 36, true)}
      {bar('92%', line.body)}
      {bar('74%', line.body)}
      {bar('40%', line.label)}
      {bar('86%', line.body)}
    </View>
  )
}

/**
 * The answer as it is being typed, one poll behind the desktop's own screen.
 *
 * Deliberately plainer than the block that replaces it. The terminal has
 * already spent the markdown — the bold is bold, the asterisks are gone — so
 * running it back through the renderer would only invent structure that is not
 * there. It is set in the same body type as the real thing so the swap is not
 * a jolt, and dimmed a shade, because a draft that looked exactly like the
 * record would be a phone quietly claiming the file says something it does not
 * say yet. The line height is the one fixed by the kit, so words arriving a
 * few at a time extend the paragraph without moving what is already there.
 */
function LiveText({ text }: { text: string }) {
  const palette = usePalette()
  return <Body tone={alpha(palette.foreground, 0.75)}>{text}</Body>
}

/** The agent is mid-turn and has not said anything yet. */
function Working() {
  const palette = usePalette()
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
      <Pulse tone={palette.green} on size={6} />
      <Hint style={{ flex: 1 }}>Working</Hint>
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
          <Mono
            selectable
            style={{ color: palette.light_foreground, fontFamily: font.regular, fontSize: size.micro, lineHeight: line.micro }}
          >
            {screen}
          </Mono>
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
function ToolRunView({
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
        borderLeftWidth: StyleSheet.hairlineWidth * 2,
        borderLeftColor: palette.lighter_background,
        paddingLeft: space.sm,
      }}
    >
      {hidden ? (
        <Button
          variant="ghost"
          compact
          icon="chevron-up"
          label={`${hidden} more ${hidden === 1 ? 'step' : 'steps'}`}
          tone={palette.light_foreground}
          onPress={() => setUnfolded(true)}
          style={{ alignSelf: 'flex-start', paddingHorizontal: space.xs, minHeight: 32 }}
        />
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
 * The run, drawn again only when the run itself moved.
 *
 * A transcript this long is mostly history, and history does not change: the
 * draft frame that arrives every 400ms while an agent types, and the block
 * that lands when it stops, leave every earlier run holding exactly the calls
 * it held before. `groupBlocks` rebuilds the `rows` array each time all the
 * same, so the default shallow comparison would see a new array and redraw the
 * lot; `sameToolRun` looks at the blocks inside it instead.
 */
export const ToolRun = React.memo(ToolRunView, sameToolRun)

/**
 * The glyph for a tool, by what kind of thing it does.
 *
 * Read, search, edit, run, fetch, delegate — six shapes cover every tool a
 * coding agent has and a line of them scans faster than six names do. A tool
 * this has never heard of gets the generic glyph rather than nothing, so the
 * column stays a column.
 */
function toolIcon(tool: string | undefined): IconName {
  const name = (tool || '').toLowerCase()
  if (!name) return 'tool'
  if (name.includes('bash') || name.includes('shell') || name.includes('exec')) return 'terminal'
  if (name.includes('edit') || name.includes('write') || name.includes('notebook')) return 'edit-2'
  if (name.includes('read') || name.includes('cat')) return 'file-text'
  if (name.includes('grep') || name.includes('glob') || name.includes('search') || name.includes('find')) return 'search'
  if (name.includes('web') || name.includes('fetch') || name.includes('http')) return 'globe'
  if (name.includes('agent') || name.includes('task')) return 'users'
  if (name.includes('todo') || name.includes('plan')) return 'check-square'
  if (name.includes('skill')) return 'zap'
  return 'tool'
}

/**
 * One tool call, one line.
 *
 * Name, what it was pointed at, and how it went — anything more is the body,
 * and the body is behind a tap. The status lives in the colour of the glyph so
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
        hitSlop={6}
        accessibilityRole="button"
        accessibilityLabel={`${block.tool || 'tool'} ${block.summary || ''}`.trim()}
        accessibilityState={{ expanded: open }}
        style={({ pressed }) => ({
          flexDirection: 'row',
          alignItems: 'center',
          gap: space.sm,
          minHeight: 32,
          paddingHorizontal: space.xs,
          marginLeft: -space.xs,
          borderRadius: radius.sm,
          backgroundColor: pressed || open ? palette.dark_background : 'transparent',
        })}
      >
        <Feather name={toolIcon(block.tool)} size={12} color={tone} />
        <Label style={{ fontFamily: font.medium, flexShrink: 0 }}>{block.tool}</Label>
        <Label style={{ flex: 1 }} numberOfLines={1}>
          {block.summary}
        </Label>
        {status === 'error' ? (
          <Caps tone={palette.red}>failed</Caps>
        ) : result?.lines ? (
          <Caps>{result.lines}L</Caps>
        ) : null}
      </Pressable>

      {status === 'error' && !open ? (
        <Label numberOfLines={2} style={{ color: alpha(palette.red, 0.8), marginLeft: 12 + space.sm, marginBottom: space.xs }}>
          {result?.summary}
        </Label>
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
            <Mono
              selectable
              style={{
                color: palette.light_foreground,
                fontFamily: font.regular,
                fontSize: size.micro,
                lineHeight: line.micro,
                padding: space.md,
              }}
            >
              {expanded}
            </Mono>
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
function RowView({
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
  /**
   * Handed the block rather than closed over it, so that the callback the
   * parent passes is the same function on every frame — a fresh arrow per row
   * per render is a prop change, and a prop change is the one thing `memo`
   * cannot see past.
   */
  onExpand: (block: AgentBlock) => void
  onAnswer?: (seq: number, question: number, choices: number[]) => Promise<{ labels: string[] }>
}) {
  const palette = usePalette()
  const [thought, setThought] = useState(false)
  // When this was said, shown on a long press. A timestamp on every bubble is
  // the kind of furniture a chat learns to ignore; one on demand is an answer.
  const [stamp, setStamp] = useState(false)

  if (block.kind === 'text') {
    if (block.role === 'user') {
      return (
        <View style={{ alignItems: 'flex-end' }}>
          <Pressable
            onLongPress={() => setStamp((was) => !was)}
            accessibilityLabel={stamp ? undefined : 'Hold for the time'}
            style={{
              maxWidth: '88%',
              backgroundColor: palette.selection,
              borderRadius: radius.md,
              borderBottomRightRadius: radius.sm,
              paddingHorizontal: space.md,
              paddingVertical: space.sm,
            }}
          >
            <Body tone={palette.bright_foreground}>{block.text}</Body>
          </Pressable>
          {stamp ? <Caps style={{ marginTop: space.xs }}>{clock(block.at)}</Caps> : null}
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
        accessibilityRole="button"
        accessibilityLabel="Thinking"
        accessibilityState={{ expanded: thought }}
        hitSlop={6}
        style={{ flexDirection: 'row', alignItems: 'flex-start', gap: space.sm }}
      >
        <Feather name={thought ? 'chevron-down' : 'chevron-right'} size={12} color={palette.muted} style={{ marginTop: 3 }} />
        <Label style={{ flex: 1, opacity: 0.8 }} numberOfLines={thought ? 0 : 1}>
          {block.text}
        </Label>
      </Pressable>
    )
  }

  if (block.kind === 'question') {
    return <QuestionCard session={session ?? null} block={block} result={result} onAnswer={onAnswer} />
  }

  if (block.kind === 'tool') {
    return <ToolLine block={block} result={result} expanded={expanded} onExpand={() => onExpand(block)} />
  }

  // A result with no tool call in the window it was loaded from.
  return (
    <Label numberOfLines={2}>
      {block.summary} · {ago(block.at)}
    </Label>
  )
}

/**
 * Said and thought, drawn again only when this row's own blocks changed.
 *
 * The expensive half of a row is the `Markdown` under it — a whole answer
 * re-parsed and re-laid-out — and until this memo the price of one draft frame
 * was every answer in the transcript, several times a second.
 */
export const Row = React.memo(RowView, sameRow)

/* ── questions and prompts ───────────────────────────────────────────── */

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
 *
 * `live` is the card pinned over the composer: a bordered card in the
 * waiting colour. In the transcript the same block is a quiet record with a
 * rule down its side.
 */
function QuestionCard({
  session,
  block,
  result,
  onAnswer,
  live,
}: {
  session: AgentSession | null
  block: AgentBlock
  result?: AgentBlock
  onAnswer?: (seq: number, question: number, choices: number[]) => Promise<{ labels: string[] }>
  live?: boolean
}) {
  const palette = usePalette()
  const questions = block.questions || []
  const answered = result?.answers
  const tone = answered ? palette.muted : palette.orange

  return (
    <View
      style={
        live
          ? {
              backgroundColor: palette.dark_background,
              borderColor: alpha(palette.orange, 0.45),
              borderWidth: StyleSheet.hairlineWidth * 2,
              borderRadius: radius.md,
              padding: space.lg - 2,
              gap: space.lg,
            }
          : {
              borderLeftWidth: 2,
              borderLeftColor: tone,
              paddingVertical: space.xs,
              paddingHorizontal: space.md,
              gap: space.lg,
            }
      }
    >
      {questions.map((question, i) => (
        <Question
          key={`${block.seq}:${i}`}
          session={session}
          question={question}
          picked={pickedFrom(answered?.[question.question], question)}
          live={Boolean(live)}
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

/** The option the agent would pick itself, when it says so in the option. */
const RECOMMENDED = /recommended/i

function Question({
  session,
  question,
  picked,
  live,
  onAnswer,
}: {
  session: AgentSession | null
  question: AgentQuestion
  picked: string[] | null
  live: boolean
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
      <Caps tone={settled ? palette.muted : palette.orange}>{question.header || 'Question'}</Caps>
      {/* The one place a title may run to several lines: the question is the
          whole reason the card exists and a truncated question cannot be
          answered. */}
      {settled ? <Body>{question.question}</Body> : <Title numberOfLines={0}>{question.question}</Title>}

      {settled ? (
        <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: space.sm }}>
          <Feather name="check" size={13} color={picked ? palette.green : palette.muted} style={{ marginTop: 2 }} />
          <Label numberOfLines={3} style={{ flex: 1, fontFamily: font.medium }}>
            {settled.join(' · ')}
          </Label>
        </View>
      ) : (
        <View style={{ gap: space.sm, marginTop: space.xs }}>
          {question.options.map((option, i) => (
            <OptionRow
              key={option.label}
              n={i + 1}
              option={option}
              checked={checked.includes(i + 1)}
              recommended={RECOMMENDED.test(option.label) || RECOMMENDED.test(option.description || '')}
              multi={Boolean(question.multiSelect)}
              enabled={answerable && !busy}
              busy={busy && !question.multiSelect}
              onPress={() => tap(i + 1)}
            />
          ))}
        </View>
      )}

      {question.multiSelect && !settled ? (
        <Button
          label={checked.length ? `Send ${checked.length}` : 'Send'}
          icon="check"
          variant="solid"
          tone={palette.orange}
          disabled={!answerable || !checked.length}
          loading={busy}
          onPress={() => submit([...checked].sort((a, b) => a - b))}
          style={{ marginTop: space.xs }}
        />
      ) : null}

      {!session?.writable && !settled ? <Hint icon="eye">Read only · answer this at the desktop</Hint> : null}
      <Notice error={error} onDismiss={() => setError(null)} style={{ marginBottom: 0 }} />
    </View>
  )
}

/**
 * One option: its number, its label, and what it means.
 *
 * Full width, because a choice is a button and a button on a phone is the
 * width of a thumb's reach. The description is the half that decides the
 * question and the half a phone has no room for, so it is kept — two lines of
 * it — rather than folded away behind a tap nobody would take while deciding.
 * The recommended one is drawn solid, the way the primary button is
 * everywhere else.
 */
function OptionRow({
  n,
  option,
  checked,
  recommended,
  multi,
  enabled,
  busy,
  onPress,
}: {
  n: number
  option: { label: string; description?: string }
  checked: boolean
  recommended: boolean
  multi: boolean
  enabled: boolean
  busy: boolean
  onPress: () => void
}) {
  const palette = usePalette()
  const accent = palette.orange
  const lit = checked || recommended
  return (
    <Pressable
      onPress={onPress}
      disabled={!enabled}
      accessibilityRole="button"
      accessibilityLabel={`${n}. ${option.label}`}
      accessibilityState={{ disabled: !enabled, checked: multi ? checked : undefined }}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: space.sm,
        minHeight: touch,
        paddingVertical: space.sm,
        paddingHorizontal: space.md,
        borderRadius: radius.sm,
        borderWidth: StyleSheet.hairlineWidth * 2,
        borderColor: lit ? alpha(accent, 0.6) : palette.lighter_background,
        backgroundColor: lit ? alpha(accent, pressed ? 0.3 : 0.18) : pressed ? palette.selection : palette.darker_background,
        opacity: enabled || busy ? 1 : 0.5,
      })}
    >
      <Caps tone={lit ? accent : palette.light_foreground} style={{ minWidth: 14 }}>
        {n}
      </Caps>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Body tone={palette.bright_foreground} style={{ fontFamily: font.medium }}>
          {option.label}
        </Body>
        {option.description ? (
          <Label numberOfLines={2} style={{ marginTop: 1 }}>
            {option.description}
          </Label>
        ) : null}
      </View>
      {multi ? (
        <Feather name={checked ? 'check-square' : 'square'} size={16} color={checked ? accent : palette.muted} />
      ) : null}
    </Pressable>
  )
}

/**
 * A prompt the transcript never saw.
 *
 * A permission dialog is drawn on the terminal and written nowhere, so all the
 * phone has is the sentence the hook reported and the knowledge that the
 * terminal is sitting on a numbered list with the first entry highlighted.
 * Allow presses the digit that means yes and Deny presses escape, the two
 * answers the desktop's list always has; the small row under them is for the
 * prompts whose second and third options are the interesting ones, and for
 * taking whatever the cursor is on.
 */
function WaitingCard({
  session,
  onKey,
  acting,
}: {
  session: AgentSession
  onKey?: (key: string) => void
  acting: string | null
}) {
  const palette = usePalette()
  return (
    <View
      style={{
        backgroundColor: palette.dark_background,
        borderColor: alpha(palette.orange, 0.45),
        borderWidth: StyleSheet.hairlineWidth * 2,
        borderRadius: radius.md,
        padding: space.lg - 2,
        gap: space.sm,
      }}
    >
      <Caps tone={palette.orange}>Waiting for you</Caps>
      <Title numberOfLines={0}>{session.prompt}</Title>
      {onKey ? (
        <>
          <View style={{ flexDirection: 'row', gap: space.sm, marginTop: space.xs }}>
            <Button
              label="Allow"
              icon="check"
              variant="solid"
              tone={palette.green}
              loading={acting === '1'}
              disabled={acting !== null}
              onPress={() => onKey('1')}
              style={{ flex: 1 }}
            />
            <Button
              label="Deny"
              icon="x"
              variant="danger"
              loading={acting === 'Escape'}
              disabled={acting !== null}
              onPress={() => onKey('Escape')}
              style={{ flex: 1 }}
            />
          </View>
          <View style={{ flexDirection: 'row', gap: space.sm }}>
            <Button compact label="Option 2" loading={acting === '2'} disabled={acting !== null} onPress={() => onKey('2')} style={{ flex: 1, paddingHorizontal: space.sm }} />
            <Button compact label="Option 3" loading={acting === '3'} disabled={acting !== null} onPress={() => onKey('3')} style={{ flex: 1, paddingHorizontal: space.sm }} />
            <Button
              compact
              label="Enter"
              icon="corner-down-left"
              loading={acting === 'Enter'}
              disabled={acting !== null}
              onPress={() => onKey('Enter')}
              style={{ flex: 1, paddingHorizontal: space.sm }}
            />
          </View>
        </>
      ) : (
        <Hint icon="eye">Read only · answer this at the desktop</Hint>
      )}
    </View>
  )
}

/* ── the composer ────────────────────────────────────────────────────── */

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
    <Pressable
      onPress={onRemove}
      accessibilityRole="button"
      accessibilityLabel={`Remove ${shot.name}`}
      style={{ width: 56, height: 56 }}
    >
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

/**
 * The microphone while it is open: red, counting, and one tap from done.
 *
 * The count is the only honest reassurance a microphone can give — nothing
 * else on screen proves it is still open — and the limit beside it is the
 * desktop's, so the moment the recording will be cut short is visible before
 * it happens.
 */
function RecordingPill({
  held,
  max,
  onStop,
  onDiscard,
}: {
  held: number
  max: number
  onStop: () => void
  onDiscard: () => void
}) {
  const palette = usePalette()
  const stamp = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
  return (
    <Pressable
      onPress={onStop}
      onLongPress={onDiscard}
      hitSlop={6}
      accessibilityRole="button"
      accessibilityLabel="Stop recording and transcribe; hold to discard"
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: space.sm,
        height: 36,
        paddingHorizontal: space.md,
        borderRadius: 18,
        borderWidth: StyleSheet.hairlineWidth * 2,
        borderColor: alpha(palette.red, 0.6),
        backgroundColor: alpha(palette.red, pressed ? 0.3 : 0.15),
      })}
    >
      <Pulse tone={palette.red} on size={7} />
      <Mono style={{ color: palette.red, fontFamily: font.medium, fontSize: size.label, lineHeight: line.label }}>
        {stamp(held)}
      </Mono>
      <Caps tone={alpha(palette.red, 0.7)}>/ {stamp(max)}</Caps>
      <Feather name="square" size={12} color={palette.red} />
    </Pressable>
  )
}

/**
 * Answering the agent.
 *
 * The text field sends prose, and the row of controls around it does the
 * three other things a sofa needs: a picture, a slash command, a voice. The
 * digits a permission prompt wants are not here any more — they are on the
 * prompt itself, above this row, where the question they answer is drawn.
 *
 * A session on the `wtype` road says so before its first send rather than
 * after. The compositor typing on the user's behalf steals focus for a moment
 * and interleaves with anyone at the real keyboard — that cannot be fixed, but
 * it can be told to the person deciding whether to press send.
 *
 * The paperclip is the one that changes what can be asked from a sofa. "Why
 * does this look wrong" is a question about a picture, and until the picture
 * can cross, the answer is to get up. The screenshot goes to the desktop and
 * the agent is handed its path — a terminal carries text and nothing else, so
 * the path *is* how an image is passed, not a workaround for not being able to
 * pass one.
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
  /**
   * The message went across and stayed in the agent's own composer. The fix
   * is one keystroke, and the notice that says so is where the key goes.
   */
  const [stuck, setStuck] = useState(false)
  const [acknowledged, setAcknowledged] = useState(false)
  const [shots, setShots] = useState<Attachment[]>([])
  const [sources, setSources] = useState(false)
  const [focused, setFocused] = useState(false)
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
  const failed = shots.find((shot) => shot.error)
  const canCommand = (hello?.capabilities?.agents as { commands?: boolean } | undefined)?.commands === true
  const speech = hello?.capabilities?.dictation as { available?: boolean; maxSeconds?: number } | undefined
  const canDictate = speech?.available === true
  const maxHold = speech?.maxSeconds ?? 300
  const hasText = Boolean(text.trim()) || ready.length > 0

  const guard = useCallback(
    async (what: () => Promise<unknown>) => {
      setBusy(true)
      setError(null)
      setStuck(false)
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
        if (result?.submitted === false) {
          setStuck(true)
          throw new Error('Typed, but the agent did not take it — it is still in the composer on the desktop')
        }
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
        else setError('The desktop heard nothing in that')
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
    paddingTop: space.sm,
    // With the keyboard up it is the keyboard, not the gesture bar, below this
    // row — reserving room for both is how the field ends up half a thumb
    // higher than it needs to be on a screen that has none to spare.
    paddingBottom: keyboard ? space.sm : Math.max(insets.bottom, space.md),
    backgroundColor: palette.dark_background,
    borderTopWidth: StyleSheet.hairlineWidth * 2,
    borderTopColor: palette.lighter_background,
  }

  /**
   * The field itself, and the same one in every state the composer has.
   *
   * A rounded pill at one line that grows to five: past that a message is a
   * document and the transcript above it deserves the screen back.
   */
  const field = (placeholder: string) => (
    <TextInput
      value={text}
      onChangeText={setText}
      placeholder={placeholder}
      placeholderTextColor={palette.muted}
      autoCapitalize="sentences"
      autoCorrect
      multiline
      // Return adds a newline and the arrow sends, the way every chat
      // app on a phone works — and here it earns its keep twice over,
      // because a multi-line message travels as a bracketed paste and
      // arrives as one message rather than as several half-sent ones.
      submitBehavior="newline"
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      maxFontSizeMultiplier={MAX_FONT_SCALE}
      accessibilityLabel={placeholder}
      style={{
        flex: 1,
        minHeight: 36,
        maxHeight: line.body * 5 + 16,
        color: palette.bright_foreground,
        fontFamily: font.regular,
        fontSize: size.body,
        lineHeight: line.body,
        backgroundColor: palette.darker_background,
        borderColor: focused ? palette.foreground : palette.lighter_background,
        borderWidth: StyleSheet.hairlineWidth * 2,
        borderRadius: 18,
        paddingHorizontal: space.md,
        paddingTop: 8,
        paddingBottom: 8,
        textAlignVertical: 'center',
      }}
    />
  )

  /** The send arrow: solid once there is something to send. */
  const sendButton = (onPress: () => void, enabled: boolean) => (
    <IconButton
      icon="arrow-up"
      label="Send"
      onPress={onPress}
      disabled={!enabled}
      loading={busy}
      tone={enabled ? palette.accent : undefined}
      style={enabled ? { backgroundColor: alpha(palette.accent, 0.18), borderColor: alpha(palette.accent, 0.6) } : undefined}
    />
  )

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
            {field('Reply to resume')}
            {sendButton(continueInBackground, !busy && Boolean(text.trim()))}
          </View>
          {keyboard ? null : <Hint icon="rotate-cw">Finished · a reply resumes it as a new background run</Hint>}
        </View>
      )
    }
    return (
      <View style={frame}>
        <Hint icon="eye">
          {/* Two different reasons wear the same silence, and blaming the
              desktop for the wrong one sends people hunting for a tmux that
              would not have helped. A background agent has no terminal to be
              reached: it was started detached, and answering it is not
              something this desktop can do on your behalf. */}
          {session.job
            ? session.job.live === false
              ? 'Read only · this background agent finished, and the phone cannot start one'
              : 'Read only · this agent runs in the background with no terminal to type into'
            : 'Read only · nothing on the desktop can reach this terminal'}
        </Hint>
      </View>
    )
  }

  if (needsWarning) {
    return (
      <View style={frame}>
        <Notice
          tone="warning"
          icon="edit-2"
          error={
            'No pane here, so the desktop focuses the window and types for you.\n' +
            'It takes focus for a moment and interleaves with anyone at the keyboard. ' +
            'Start the agent with `omarchy-connect agent run` for a clean road.'
          }
          action={{ label: 'Type anyway', icon: 'edit-2', onPress: () => setAcknowledged(true) }}
          style={{ marginBottom: 0 }}
        />
      </View>
    )
  }

  return (
    <View style={frame}>
      <Notice
        error={error}
        onDismiss={() => {
          setError(null)
          setStuck(false)
        }}
        action={stuck ? { label: 'Press Enter', icon: 'corner-down-left', onPress: () => press('Enter') } : null}
        style={{ marginBottom: space.sm }}
      />
      {/* A picture that did not cross says so here as well as on its
          thumbnail; dismissing the notice drops the picture it is about. */}
      {failed ? (
        <Notice
          error={failed.error}
          icon="image"
          onDismiss={() => setShots((prev) => prev.filter((s) => s.key !== failed.key))}
          style={{ marginBottom: space.sm }}
        />
      ) : null}

      {/* Where a picture comes from, only while one is being chosen. Three
          sources rather than one because a screenshot is in a different place
          depending on how it got there — and the clipboard, which is where it
          is a second after being cropped, is the one no picker can reach. */}
      {sources ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm, marginBottom: space.sm }}>
          <Chip label="Photos" icon="image" onPress={() => void add(attach.fromLibrary)} />
          <Chip label="Files" icon="folder" onPress={() => void add(attach.fromFiles)} />
          <Chip label="Paste" icon="clipboard" onPress={() => void add(attach.fromClipboard)} />
          <View style={{ flex: 1 }} />
          <IconButton icon="x" label="Close" size={34} onPress={() => setSources(false)} />
        </View>
      ) : null}

      {shots.length ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ gap: space.sm, paddingBottom: space.sm, paddingTop: space.xs }}
          keyboardShouldPersistTaps="handled"
        >
          {shots.map((shot) => (
            <Thumbnail key={shot.key} shot={shot} onRemove={() => setShots((prev) => prev.filter((s) => s.key !== shot.key))} />
          ))}
        </ScrollView>
      ) : null}

      <View style={{ flexDirection: 'row', gap: space.sm, alignItems: 'flex-end' }}>
        {canAttach ? (
          <IconButton
            icon="paperclip"
            label="Attach a picture"
            onPress={() => setSources((was) => !was)}
            disabled={shots.length >= MAX_SHOTS}
            tone={sources ? palette.accent : undefined}
          />
        ) : null}
        {/* Everything the agent answers to by name. The reason it sits beside
            the field rather than in a menu somewhere: a slash command is the
            one part of a coding agent already shaped for a device with no
            keyboard, and it should cost one tap to reach. */}
        {canCommand ? <IconButton icon="slash" label="Skills and commands" onPress={onSkills} /> : null}

        {field('Message')}

        {/* Speak instead of typing, with the desktop doing the listening —
            its Whisper model knows what hyprctl and cherry-pick are, and the
            recording never leaves the two machines that already talk to each
            other. Tap to open the microphone, tap again to send the sound
            across; hold to throw the take away. The microphone stands where
            the send arrow will, so the row is one control wider than the
            field and never two. */}
        {hearing ? (
          <IconButton icon="mic" label="Transcribing" loading disabled />
        ) : listening ? (
          <RecordingPill held={held} max={maxHold} onStop={() => void heard(true)} onDiscard={() => void heard(false)} />
        ) : canDictate && !hasText && !busy ? (
          <IconButton icon="mic" label="Dictate" onPress={() => void listen()} />
        ) : (
          sendButton(send, !busy && !settling && hasText)
        )}
      </View>

      {/* Worth a line while you are reading, worth nothing while you are
          typing and the screen is down to a few lines. */}
      {keyboard ? null : listening ? (
        <Hint icon="mic" style={{ marginTop: space.sm }}>
          Recording · tap to transcribe on the desktop, hold to discard
        </Hint>
      ) : hearing ? (
        <Hint icon="mic" style={{ marginTop: space.sm }}>
          Transcribing on the desktop
        </Hint>
      ) : shots.length ? (
        <Hint icon="image" style={{ marginTop: space.sm }}>
          The desktop keeps the picture and hands the agent its path
        </Hint>
      ) : !inPane(session) ? (
        <Hint icon="edit-2" style={{ marginTop: space.sm }}>
          The desktop types this · focus moves for a moment
        </Hint>
      ) : null}
    </View>
  )
}
