import React, { useCallback, useEffect, useMemo, useState } from 'react'
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  RefreshControl,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { useConnection, usePalette } from '../state/ConnectionContext'
import type { AgentHistoryEntry } from '../api/client'
import {
  Button,
  Caps,
  Card,
  Chip,
  Divider,
  Empty,
  Field,
  Hint,
  IconButton,
  ListRow,
  Notice,
  Pill,
  Section,
  Segmented,
  Title,
} from '../ui/kit'
import { modelLabel, tokens } from '../ui/agentkit'
import { ago } from '../lib/format'
import { MAX_FONT_SCALE, font, line, radius, size, space, touch } from '../theme'

/** How many past conversations show before the list folds behind "Show all". */
const FOLD = 5

/** What `agents.spawn` was last asked for, so a failed attempt can be retried as it was. */
type Attempt = { resume?: string; cwd?: string | null }

/**
 * Every conversation this desktop has had, and the one it has not had yet.
 *
 * The live list answers "what is running". This answers the two questions that
 * come before it: *pick up the thing from yesterday*, and *start something new
 * while I am not there*. Both are `--resume` and `--bg` — flags that have
 * existed on the CLI all along and that nothing away from the keyboard could
 * reach, because reaching them means starting a process, and starting a
 * process is the one thing the reading switch deliberately does not grant.
 *
 * So it is behind its own switch, and says so when it is off rather than
 * hiding. A background agent started from a bus stop is the single most useful
 * thing a phone can do with a desktop, and a screen that quietly disappears
 * teaches nobody that the switch exists.
 */
export function AgentLaunchScreen({ onBack, onOpen }: { onBack: () => void; onOpen: (id: string) => void }) {
  const { call, palette, refreshAgents, hello } = useConnection()
  const insets = useSafeAreaInsets()
  const [history, setHistory] = useState<AgentHistoryEntry[] | null>(null)
  // Two failures, drawn where each one happened: the list that would not load
  // sits in the list's place, the launch that did not start sits over its
  // button. One shared error put both at the top of the screen, away from
  // whichever thing the reader had just touched.
  const [loadError, setLoadError] = useState<unknown>(null)
  const [startError, setStartError] = useState<unknown>(null)
  const [attempt, setAttempt] = useState<Attempt | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)

  /* The fold and the search over the past conversations. */
  const [query, setQuery] = useState('')
  const [showAll, setShowAll] = useState(false)

  const caps = (hello?.capabilities?.agents ?? null) as { spawn?: boolean; history?: boolean } | null
  const canSpawn = caps?.spawn === true

  /* What to start, and where. */
  const [prompt, setPrompt] = useState('')
  const [where, setWhere] = useState<string | null>(null)
  const [background, setBackground] = useState(true)

  const load = useCallback(async () => {
    try {
      const res = await call<{ sessions: AgentHistoryEntry[] }>('agents.history', { limit: 30 })
      setHistory(res.sessions || [])
      setLoadError(null)
    } catch (err) {
      setHistory([])
      setLoadError(err)
    }
  }, [call])

  useEffect(() => {
    void load()
  }, [load])

  const refresh = useCallback(async () => {
    setRefreshing(true)
    await load()
    setRefreshing(false)
  }, [load])

  /**
   * Where a new agent could be started.
   *
   * The phone cannot browse the desktop's disk and should not pretend to: what
   * it can offer is the directories that already have conversations in them,
   * which is the same set anybody would actually pick from. A project you have
   * never opened an agent in is not one you are going to start one in from a
   * phone.
   */
  const places = useMemo(() => {
    const seen = new Map<string, number>()
    for (const entry of history || []) {
      if (!entry.cwd) continue
      seen.set(entry.cwd, Math.max(seen.get(entry.cwd) || 0, entry.at))
    }
    return [...seen.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([dir]) => dir)
      .slice(0, 8)
  }, [history])

  useEffect(() => {
    if (!where && places.length) setWhere(places[0])
  }, [places, where])

  /**
   * Two projects can share a last segment — `app` under two repositories —
   * and a chip that says `app` twice is not a choice. Those get their parent
   * in front; everything else is called what a person calls it.
   */
  const chipName = useMemo(() => {
    const counts = new Map<string, number>()
    for (const dir of places) counts.set(tail(dir, 1), (counts.get(tail(dir, 1)) || 0) + 1)
    return (dir: string) => tail(dir, (counts.get(tail(dir, 1)) || 0) > 1 ? 2 : 1)
  }, [places])

  const start = useCallback(
    async ({ resume, cwd }: Attempt) => {
      setBusy(resume || 'new')
      setStartError(null)
      setAttempt({ resume, cwd })
      try {
        const res = await call<{ ok: boolean; via: string }>('agents.spawn', {
          resume: resume || null,
          cwd: cwd ?? null,
          prompt: resume ? '' : prompt.trim(),
          background: resume ? false : background,
        })
        setPrompt('')
        await refreshAgents()
        await load()
        // A resumed session and a new pane both turn up in the list behind
        // this screen, which is where the person is going next; a background
        // agent takes a moment to register and has nothing to open yet. Asked
        // the way round that keeps working: which multiplexer held the pane is
        // the desktop's business, and there is more than one of them.
        if (res.via !== 'background') onBack()
      } catch (err) {
        setStartError(err)
      } finally {
        setBusy(null)
      }
    },
    [background, call, load, onBack, prompt, refreshAgents],
  )

  /* The list as shown: searched when there is a query, folded when there is not. */
  const searchable = (history?.length ?? 0) > FOLD
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle || !history) return history ?? []
    return history.filter((entry) =>
      [entry.title, basename(entry.cwd), entry.branch].some((part) => part?.toLowerCase().includes(needle)),
    )
  }, [history, query])
  const visible = showAll || query.trim() ? filtered : filtered.slice(0, FOLD)
  const hidden = filtered.length - visible.length

  const retry = attempt
    ? { label: 'Try again', icon: 'refresh-cw' as const, onPress: () => void start(attempt) }
    : null
  const canStart = canSpawn && Boolean(prompt.trim()) && Boolean(where)

  return (
    <KeyboardAvoidingView behavior="padding" style={{ flex: 1, backgroundColor: palette.background }}>
      <SheetBar
        onBack={onBack}
        title="New agent"
        right={<IconButton icon="refresh-cw" label="Refresh" loading={refreshing} onPress={() => void refresh()} />}
      />

      <ScrollView
        contentContainerStyle={{ padding: space.lg, paddingBottom: insets.bottom + space.xl }}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} tintColor={palette.muted} />}
      >
        {/* The form is drawn whether or not the desktop will take it. Off, it
            is dimmed with the one line that turns it on — a screen that hides
            the switch teaches nobody it exists. */}
        <Card tone={canSpawn ? undefined : palette.muted}>
          <View style={{ opacity: canSpawn ? 1 : 0.45 }} pointerEvents={canSpawn ? 'auto' : 'none'}>
            <Section title="Project" />
            {places.length ? (
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>
                {places.map((dir) => (
                  <Chip
                    key={dir}
                    label={chipName(dir)}
                    icon="folder"
                    active={dir === where}
                    tone={palette.accent}
                    disabled={!canSpawn}
                    onPress={() => setWhere(dir)}
                  />
                ))}
              </View>
            ) : (
              <Hint icon="folder">A project appears once a conversation has run in it</Hint>
            )}

            <Divider />

            <Section title="Prompt" />
            <PromptBox
              value={prompt}
              onChange={setPrompt}
              placeholder="What should it do?"
              label="Prompt"
              minLines={4}
              maxLines={8}
              disabled={!canSpawn}
            />
            <View style={{ marginTop: space.md, gap: space.sm }}>
              <Segmented
                options={[
                  { value: 'background', label: 'Background' },
                  { value: 'pane', label: 'Desktop pane' },
                ]}
                value={background ? 'background' : 'pane'}
                onChange={(mode) => setBackground(mode === 'background')}
                disabled={!canSpawn}
              />
              <Hint icon={background ? 'eye-off' : 'terminal'}>
                {background ? 'Runs unattended · what it did is read here' : 'Opens a pane on the desktop · answer it here'}
              </Hint>
            </View>
          </View>

          {!canSpawn ? (
            <Hint icon="lock" style={{ marginTop: space.md }}>
              Switch on with omarchy-connect agent spawn on
            </Hint>
          ) : null}

          {!attempt?.resume ? (
            <Notice
              error={startError}
              action={retry}
              onDismiss={() => setStartError(null)}
              style={{ marginTop: space.md, marginBottom: 0 }}
            />
          ) : null}

          <Button
            label="Start"
            icon="play"
            variant="solid"
            tone={palette.accent}
            disabled={!canStart}
            loading={busy === 'new'}
            onPress={() => void start({ cwd: where })}
            style={{ marginTop: space.md }}
          />
        </Card>

        <Card>
          {searchable ? (
            <Field label="Resume" value={query} onChange={setQuery} placeholder="Search conversations" />
          ) : (
            <Section title="Resume" right={history?.length ? <Caps>{String(history.length)}</Caps> : null} />
          )}

          {attempt?.resume ? <Notice error={startError} action={retry} onDismiss={() => setStartError(null)} /> : null}

          {history === null ? (
            <ActivityIndicator color={palette.accent} style={{ marginVertical: space.lg }} />
          ) : loadError ? (
            <Notice
              error={loadError}
              action={{ label: 'Try again', icon: 'refresh-cw', onPress: () => void refresh() }}
              style={{ marginBottom: 0 }}
            />
          ) : !history.length ? (
            <Empty icon="clock" text="No conversations on that desktop yet" />
          ) : !filtered.length ? (
            <Empty icon="search" text="Nothing matches" />
          ) : (
            <>
              {visible.map((entry, i) => (
                <HistoryRow
                  key={entry.id}
                  entry={entry}
                  busy={busy === entry.sessionId}
                  canSpawn={canSpawn}
                  last={i === visible.length - 1 && !hidden}
                  onPress={() => {
                    if (entry.live && entry.liveId) return onOpen(entry.liveId)
                    if (canSpawn) void start({ resume: entry.sessionId, cwd: entry.cwd })
                  }}
                />
              ))}
              {hidden ? (
                <Button
                  label={`Show all ${filtered.length}`}
                  icon="chevron-down"
                  variant="ghost"
                  compact
                  onPress={() => setShowAll(true)}
                  style={{ marginTop: space.sm }}
                />
              ) : null}
            </>
          )}
        </Card>
      </ScrollView>
    </KeyboardAvoidingView>
  )
}

/**
 * One conversation on disk.
 *
 * The title is the one the CLI wrote for it, which is what makes this list
 * readable at all — five rows called `omarchy-connect` are five rows nobody
 * can choose between, and the sentence the CLI named the conversation with is
 * the one you were actually looking for.
 *
 * Under it, as much of when / branch / model / context as fits on one line at
 * the label size, dropped from the right. The project is not there: it is
 * what the chips above already say, and the line has room for the things
 * they do not.
 */
function HistoryRow({
  entry,
  busy,
  canSpawn,
  last,
  onPress,
}: {
  entry: AgentHistoryEntry
  busy: boolean
  canSpawn: boolean
  last: boolean
  onPress: () => void
}) {
  const palette = usePalette()
  const actionable = entry.live || canSpawn
  const pill = entry.live ? (
    <Pill label="open" tone={palette.green} />
  ) : entry.background ? (
    <Pill label="bg" />
  ) : null
  // 12sp mono is 7.2dp a character; the subtitle has the card's 300dp less
  // the chevron and, when there is one, the pill.
  const subtitle = fitLine(
    [ago(entry.at), entry.branch, modelLabel(entry.model), entry.context ? `${tokens(entry.context.tokens)} ctx` : null],
    pill ? 30 : 36,
  )
  return (
    <ListRow
      title={entry.title}
      subtitle={subtitle}
      tone={actionable ? undefined : palette.light_foreground}
      right={busy ? <ActivityIndicator size="small" color={palette.accent} /> : pill}
      chevron={actionable && !busy}
      onPress={actionable && !busy ? onPress : undefined}
      last={last}
    />
  )
}

/* ── local primitives (candidates for ui/kit) ─────────────────────────── */

/**
 * The top of a pushed screen: back, a title, up to two actions. The tabs use
 * `ScreenHeader`; a screen you arrive at by tapping something needs a way back
 * more than it needs the tab's name.
 */
export function SheetBar({
  onBack,
  title,
  caps,
  right,
  below,
}: {
  onBack: () => void
  /** A `Title` in the bar, for a screen with a short fixed name. */
  title?: string
  /** A `Caps` word in the bar instead, when the real title goes `below`. */
  caps?: string
  right?: React.ReactNode
  /** Extra lines under the bar — a title too long for it, a subtitle. */
  below?: React.ReactNode
}) {
  const p = usePalette()
  const insets = useSafeAreaInsets()
  return (
    <View
      style={{
        paddingTop: insets.top + space.sm,
        paddingBottom: space.md,
        paddingHorizontal: space.lg,
        backgroundColor: p.dark_background,
        borderBottomWidth: StyleSheet.hairlineWidth * 2,
        borderBottomColor: p.lighter_background,
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md, minHeight: touch }}>
        <IconButton icon="chevron-left" label="Back" onPress={onBack} />
        <View style={{ flex: 1, minWidth: 0 }}>
          {title ? <Title>{title}</Title> : caps ? <Caps>{caps}</Caps> : null}
        </View>
        {right ? <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>{right}</View> : null}
      </View>
      {below ? <View style={{ marginTop: space.sm }}>{below}</View> : null}
    </View>
  )
}

/**
 * A multi-line text box in the kit's clothes. `Field` is one line with a
 * label; a prompt or a message needs room to grow and is labelled by the
 * section it sits under.
 */
export function PromptBox({
  value,
  onChange,
  placeholder,
  label,
  minLines = 1,
  maxLines = 6,
  disabled,
  style,
}: {
  value: string
  onChange: (v: string) => void
  placeholder?: string
  /** What a screen reader says. */
  label: string
  minLines?: number
  maxLines?: number
  disabled?: boolean
  style?: StyleProp<ViewStyle>
}) {
  const p = usePalette()
  const [focused, setFocused] = useState(false)
  const pad = space.sm + 2
  return (
    <TextInput
      value={value}
      onChangeText={onChange}
      placeholder={placeholder}
      placeholderTextColor={p.muted}
      editable={!disabled}
      multiline
      submitBehavior="newline"
      autoCapitalize="sentences"
      autoCorrect
      textAlignVertical="top"
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      maxFontSizeMultiplier={MAX_FONT_SCALE}
      accessibilityLabel={label}
      style={[
        {
          minHeight: line.body * minLines + pad * 2,
          maxHeight: line.body * maxLines + pad * 2,
          color: p.bright_foreground,
          fontFamily: font.regular,
          fontSize: size.body,
          lineHeight: line.body,
          backgroundColor: p.darker_background,
          borderColor: focused ? p.foreground : p.lighter_background,
          borderWidth: StyleSheet.hairlineWidth * 2,
          borderRadius: radius.sm,
          paddingHorizontal: space.md,
          paddingVertical: pad,
        },
        style,
      ]}
    />
  )
}

/* ── helpers ─────────────────────────────────────────────────────────── */

/** `/home/dan/Projects/omarchy-connect` → `omarchy-connect`. */
function basename(dir: string | null | undefined): string | null {
  if (!dir) return null
  return dir.split('/').filter(Boolean).slice(-1)[0] || dir
}

/** The last `n` segments of a path, joined back: `Projects/omarchy-connect`. */
function tail(dir: string, n: number): string {
  return dir.split('/').filter(Boolean).slice(-n).join('/') || dir
}

/**
 * The parts joined with ` · `, dropped from the right until the line fits
 * in `max` characters — so what goes when something must is the least
 * important fact, and never the middle of a word.
 */
export function fitLine(parts: (string | null | undefined)[], max: number): string {
  const kept = parts.filter((part): part is string => Boolean(part))
  while (kept.length > 1 && kept.join(' · ').length > max) kept.pop()
  return kept.join(' · ')
}
