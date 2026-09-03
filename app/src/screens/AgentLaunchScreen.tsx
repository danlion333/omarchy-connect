import React, { useCallback, useEffect, useMemo, useState } from 'react'
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native'
import { Feather } from '@expo/vector-icons'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { useConnection, usePalette } from '../state/ConnectionContext'
import type { AgentHistoryEntry } from '../api/client'
import { Body, Button, Card, CardHeader, Divider, Empty } from '../ui/kit'
import { Badge, modelLabel, tokens } from '../ui/agentkit'
import { ago } from '../lib/format'
import { alpha, font, radius, size, space } from '../theme'

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
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

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
      setError(null)
    } catch (err) {
      setHistory([])
      setError((err as Error).message)
    }
  }, [call])

  useEffect(() => {
    void load()
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

  const start = useCallback(
    async ({ resume, cwd }: { resume?: string; cwd?: string | null }) => {
      setBusy(resume || 'new')
      setError(null)
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
        setError((err as Error).message)
      } finally {
        setBusy(null)
      }
    },
    [background, call, load, onBack, prompt, refreshAgents],
  )

  return (
    <KeyboardAvoidingView behavior="padding" style={{ flex: 1, backgroundColor: palette.background }}>
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
        <Text style={{ flex: 1, color: palette.bright_foreground, fontFamily: font.medium, fontSize: size.value }}>
          Conversations
        </Text>
      </View>

      <ScrollView
        contentContainerStyle={{ padding: space.lg, paddingBottom: insets.bottom + space.xl, gap: space.lg }}
        keyboardShouldPersistTaps="handled"
      >
        {error ? <Body tone={palette.red}>{error}</Body> : null}

        {canSpawn ? (
          <Card>
            <CardHeader
              icon="play"
              title="Send one off"
              subtitle={background ? 'no terminal — it works and you read it later' : 'in a pane you can type into'}
            />
            {places.length ? (
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={{ gap: space.sm, paddingBottom: space.sm }}
              >
                {places.map((dir) => (
                  <Place key={dir} dir={dir} active={dir === where} onPress={() => setWhere(dir)} />
                ))}
              </ScrollView>
            ) : null}

            <TextInput
              value={prompt}
              onChangeText={setPrompt}
              placeholder="what should it work on…"
              placeholderTextColor={palette.muted}
              multiline
              style={{
                minHeight: 76,
                maxHeight: 160,
                color: palette.light_foreground,
                fontFamily: font.regular,
                fontSize: size.body,
                backgroundColor: palette.darker_background,
                borderColor: palette.lighter_background,
                borderWidth: 1,
                borderRadius: radius.sm,
                paddingHorizontal: space.md,
                paddingVertical: space.md,
                textAlignVertical: 'top',
              }}
            />

            <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm, marginTop: space.md }}>
              <Pressable
                onPress={() => setBackground((was) => !was)}
                hitSlop={8}
                style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm, flex: 1 }}
              >
                <Feather
                  name={background ? 'check-square' : 'square'}
                  size={16}
                  color={background ? palette.accent : palette.muted}
                />
                <Text style={{ color: palette.foreground, fontFamily: font.regular, fontSize: size.label }}>
                  in the background
                </Text>
              </Pressable>
              <Button
                label="Start"
                icon="play"
                disabled={!prompt.trim() || !where}
                loading={busy === 'new'}
                onPress={() => void start({ cwd: where })}
              />
            </View>

            <Body tone={palette.muted} style={{ marginTop: space.sm, fontSize: size.micro }}>
              {background
                ? 'It detaches: nothing on the desktop shows it, and nothing can type into it. What it did is read here.'
                : 'It opens in a pane of its own that nobody is looking at — answerable from this phone, and there when you sit down.'}
            </Body>
          </Card>
        ) : (
          <Card>
            <CardHeader icon="play" title="Starting one is off" subtitle="reading is a different decision from starting" />
            <Body tone={palette.muted}>
              Reading an agent and answering the one already open are things somebody at that desktop started. Starting a
              new one is a process that was not there before, so it has its own switch:
            </Body>
            <Body style={{ marginTop: space.md }}>omarchy-connect agent spawn on</Body>
          </Card>
        )}

        <Card>
          <CardHeader
            icon="clock"
            title="Earlier"
            subtitle={history === null ? 'reading the desktop…' : `${history.length} on that desktop`}
          />
          {history === null ? (
            <ActivityIndicator color={palette.accent} style={{ marginVertical: space.lg }} />
          ) : history.length ? (
            history.map((entry, i) => (
              <View key={entry.id}>
                {i > 0 ? <Divider style={{ marginVertical: space.xs }} /> : null}
                <HistoryRow
                  entry={entry}
                  busy={busy === entry.sessionId}
                  canSpawn={canSpawn}
                  onPress={() => {
                    if (entry.live && entry.liveId) return onOpen(entry.liveId)
                    if (canSpawn) void start({ resume: entry.sessionId, cwd: entry.cwd })
                  }}
                />
              </View>
            ))
          ) : (
            <Empty icon="clock" text="No conversations on that desktop yet" />
          )}
        </Card>
      </ScrollView>
    </KeyboardAvoidingView>
  )
}

/** A working directory, by the name a person would call it. */
function Place({ dir, active, onPress }: { dir: string; active: boolean; onPress: () => void }) {
  const palette = usePalette()
  const name = dir.split('/').filter(Boolean).slice(-1)[0] || dir
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => ({
        paddingHorizontal: space.md,
        paddingVertical: space.sm,
        borderRadius: radius.sm,
        borderWidth: StyleSheet.hairlineWidth * 2,
        borderColor: active ? palette.accent : palette.lighter_background,
        backgroundColor: active ? alpha(palette.accent, 0.12) : pressed ? palette.selection : palette.darker_background,
      })}
    >
      <Text
        style={{
          color: active ? palette.bright_foreground : palette.foreground,
          fontFamily: active ? font.medium : font.regular,
          fontSize: size.label,
        }}
      >
        {name}
      </Text>
    </Pressable>
  )
}

/**
 * One conversation on disk.
 *
 * The title is the one the CLI wrote for it, which is what makes this list
 * readable at all — five rows called `omarchy-connect` are five rows nobody
 * can choose between, and the sentence the CLI named the conversation with is
 * the one you were actually looking for.
 */
function HistoryRow({
  entry,
  busy,
  canSpawn,
  onPress,
}: {
  entry: AgentHistoryEntry
  busy: boolean
  canSpawn: boolean
  onPress: () => void
}) {
  const palette = usePalette()
  const model = modelLabel(entry.model)
  const actionable = entry.live || canSpawn
  return (
    <Pressable
      onPress={onPress}
      disabled={!actionable || busy}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: space.md,
        paddingVertical: space.md,
        opacity: pressed ? 0.6 : actionable ? 1 : 0.55,
      })}
    >
      <View style={{ flex: 1 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
          <Text
            style={{ flex: 1, color: palette.light_foreground, fontFamily: font.regular, fontSize: size.body }}
            numberOfLines={1}
          >
            {entry.title}
          </Text>
          {entry.live ? <Badge label="open" tone={palette.green} /> : null}
          {entry.background && !entry.live ? <Badge label="bg" tone={palette.muted} /> : null}
        </View>
        <Text
          style={{ color: palette.muted, fontFamily: font.regular, fontSize: size.label, marginTop: 2 }}
          numberOfLines={1}
        >
          {[
            entry.cwd ? entry.cwd.split('/').filter(Boolean).slice(-1)[0] : null,
            entry.branch,
            model,
            entry.context ? `${tokens(entry.context.tokens)} ctx` : null,
            ago(entry.at),
          ]
            .filter(Boolean)
            .join(' · ')}
        </Text>
      </View>
      {busy ? (
        <ActivityIndicator size="small" color={palette.accent} />
      ) : (
        <Feather
          name={entry.live ? 'chevron-right' : 'rotate-ccw'}
          size={15}
          color={actionable ? palette.muted : palette.lighter_background}
        />
      )}
    </Pressable>
  )
}
