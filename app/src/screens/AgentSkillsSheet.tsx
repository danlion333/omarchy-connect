import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'
import { Feather } from '@expo/vector-icons'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { useConnection, usePalette } from '../state/ConnectionContext'
import type { AgentSession, AgentSkill } from '../api/client'
import { Body, Caps, Notice } from '../ui/kit'
import { Badge } from '../ui/agentkit'
import { alpha, font, radius, size, space } from '../theme'

/**
 * Everything the desktop's agent answers to by name.
 *
 * A slash command is the one part of a coding agent that was already designed
 * for a device with no keyboard: the name is short, what it does is long, and
 * the whole interaction is choosing one from a list. `/security-review` is
 * four seconds of thumb-typing and one tap; the reason it was never on the
 * phone is that nothing had ever told the phone which names exist.
 *
 * What a tap does is decided by the row rather than by a second control, and
 * the row says which it will be:
 *
 *   - A command that takes no arguments **runs**. `/compact` from a sofa is
 *     the entire feature; asking someone to then find the send button is
 *     ceremony.
 *   - A command with an argument hint **goes into the composer** with the
 *     slash and the name already typed, because the interesting half is the
 *     part the list cannot know.
 *
 * The names are checked again on the desktop against the same list before
 * anything is typed into a terminal, so a stale sheet cannot invent one.
 */
export function AgentSkillsSheet({
  session,
  onCompose,
  onClose,
}: {
  session: AgentSession
  onCompose: (text: string) => void
  onClose: () => void
}) {
  const { call, palette } = useConnection()
  const insets = useSafeAreaInsets()
  const [entries, setEntries] = useState<AgentSkill[] | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [query, setQuery] = useState('')
  const [running, setRunning] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    call<{ skills: AgentSkill[]; commands: AgentSkill[]; builtins: AgentSkill[] }>('agents.skills', { id: session.id })
      .then((res) => {
        if (!live) return
        setEntries([...(res.skills || []), ...(res.commands || []), ...(res.builtins || [])])
        setError(null)
      })
      .catch((err) => live && setError(err))
    return () => {
      live = false
    }
  }, [call, session.id])

  /**
   * Search over the name and the description both.
   *
   * The description is where the useful words are — nobody remembers that the
   * skill for driving a phone over USB is called `adb-phone`, but everybody
   * remembers it is the one about the phone.
   */
  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const all = entries || []
    if (!needle) return all
    return all.filter(
      (entry) => entry.name.toLowerCase().includes(needle) || entry.description.toLowerCase().includes(needle),
    )
  }, [entries, query])

  const groups = useMemo(
    () => [
      { title: 'Skills', rows: shown.filter((e) => e.kind === 'skill') },
      { title: 'Commands', rows: shown.filter((e) => e.kind === 'command') },
      { title: 'Built in', rows: shown.filter((e) => e.kind === 'builtin') },
    ],
    [shown],
  )

  const pick = useCallback(
    async (entry: AgentSkill) => {
      // Something to fill in: the composer is where that happens, and the
      // sheet gets out of the way rather than growing a second field.
      if (entry.args) {
        onCompose(`/${entry.name} `)
        onClose()
        return
      }
      setRunning(entry.name)
      setError(null)
      try {
        await call('agents.command', { id: session.id, name: entry.name })
        onClose()
      } catch (err) {
        setError(err)
      } finally {
        setRunning(null)
      }
    },
    [call, onClose, onCompose, session.id],
  )

  return (
    <View
      style={[
        StyleSheet.absoluteFill,
        { backgroundColor: alpha(palette.background, 0.97), paddingTop: insets.top + space.sm },
      ]}
    >
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: space.md,
          paddingHorizontal: space.lg,
          paddingBottom: space.md,
        }}
      >
        <Feather name="command" size={16} color={palette.accent} />
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder="skills and commands…"
          placeholderTextColor={palette.muted}
          autoCapitalize="none"
          autoCorrect={false}
          autoFocus
          style={{
            flex: 1,
            color: palette.light_foreground,
            fontFamily: font.regular,
            fontSize: size.body,
            backgroundColor: palette.darker_background,
            borderColor: palette.lighter_background,
            borderWidth: 1,
            borderRadius: radius.sm,
            paddingHorizontal: space.md,
            paddingVertical: space.sm,
          }}
        />
        <Pressable onPress={onClose} hitSlop={12}>
          <Feather name="x" size={20} color={palette.muted} />
        </Pressable>
      </View>

      <Notice error={error} style={{ marginHorizontal: space.lg }} onDismiss={() => setError(null)} />

      <ScrollView
        contentContainerStyle={{ paddingHorizontal: space.lg, paddingBottom: insets.bottom + space.xl, gap: space.lg }}
        keyboardShouldPersistTaps="handled"
      >
        {entries === null && !error ? <ActivityIndicator color={palette.accent} style={{ marginTop: space.xl }} /> : null}

        {groups.map((group) =>
          group.rows.length ? (
            <View key={group.title} style={{ gap: space.xs }}>
              <Caps>{group.title}</Caps>
              {group.rows.map((entry) => (
                <SkillRow
                  key={`${entry.kind}:${entry.name}`}
                  entry={entry}
                  busy={running === entry.name}
                  disabled={running !== null}
                  onPress={() => void pick(entry)}
                />
              ))}
            </View>
          ) : null,
        )}

        {entries !== null && !shown.length ? (
          <Body tone={palette.muted} style={{ textAlign: 'center', marginTop: space.xl }}>
            {entries.length ? 'Nothing by that name' : 'This desktop has no skills or commands installed'}
          </Body>
        ) : null}
      </ScrollView>
    </View>
  )
}

/**
 * One name, what it does, and — where it matters — where it came from.
 *
 * The scope badge is only on the rows where it changes the meaning: a skill
 * this project ships is a different promise from one the whole machine has,
 * and the built-in list is already under its own heading.
 */
function SkillRow({
  entry,
  busy,
  disabled,
  onPress,
}: {
  entry: AgentSkill
  busy: boolean
  disabled: boolean
  onPress: () => void
}) {
  const palette = usePalette()
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: space.sm,
        paddingVertical: space.sm,
        paddingHorizontal: space.sm,
        marginHorizontal: -space.sm,
        borderRadius: radius.sm,
        backgroundColor: pressed ? palette.selection : 'transparent',
        opacity: disabled && !busy ? 0.5 : 1,
      })}
    >
      <View style={{ flex: 1 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
          <Text style={{ color: palette.bright_foreground, fontFamily: font.medium, fontSize: size.label }}>
            /{entry.name}
          </Text>
          {entry.args ? (
            <Text style={{ color: palette.muted, fontFamily: font.regular, fontSize: size.micro }}>{entry.args}</Text>
          ) : null}
          {entry.scope === 'project' ? <Badge label="project" tone={palette.accent} /> : null}
          {entry.scope === 'plugin' ? <Badge label="plugin" tone={palette.muted} /> : null}
        </View>
        {entry.description ? (
          <Text
            style={{ color: palette.muted, fontFamily: font.regular, fontSize: size.micro, lineHeight: 15, marginTop: 2 }}
            numberOfLines={2}
          >
            {entry.description}
          </Text>
        ) : null}
      </View>
      {busy ? (
        <ActivityIndicator size="small" color={palette.accent} />
      ) : (
        // Which of the two things a tap will do, said before it is taken.
        <Feather name={entry.args ? 'edit-2' : 'corner-down-left'} size={13} color={palette.muted} style={{ marginTop: 3 }} />
      )}
    </Pressable>
  )
}
