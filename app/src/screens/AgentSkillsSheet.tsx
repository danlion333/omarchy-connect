import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { ActivityIndicator, ScrollView, StyleSheet, TextInput, View } from 'react-native'
import { Feather } from '@expo/vector-icons'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { useConnection, usePalette } from '../state/ConnectionContext'
import type { AgentSession, AgentSkill } from '../api/client'
import { Card, Empty, IconButton, ListRow, Notice, Pill, Title } from '../ui/kit'
import { MAX_FONT_SCALE, alpha, font, radius, size, space, touch } from '../theme'

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
      <View style={{ paddingHorizontal: space.lg }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', minHeight: touch, marginBottom: space.sm }}>
          <Title style={{ flex: 1 }}>Skills</Title>
          <IconButton icon="x" label="Close" onPress={onClose} />
        </View>
        <SearchField value={query} onChange={setQuery} placeholder="Search" />
        <Notice error={error} onDismiss={() => setError(null)} />
      </View>

      <ScrollView
        contentContainerStyle={{ paddingHorizontal: space.lg, paddingBottom: insets.bottom + space.xl }}
        keyboardShouldPersistTaps="handled"
      >
        <Card>
          {entries === null && !error ? <ActivityIndicator color={palette.muted} style={{ paddingVertical: space.xl }} /> : null}

          {shown.map((entry, i) => (
            <SkillRow
              key={`${entry.kind}:${entry.name}`}
              entry={entry}
              busy={running === entry.name}
              disabled={running !== null}
              last={i === shown.length - 1}
              onPress={() => void pick(entry)}
            />
          ))}

          {entries !== null && !shown.length ? (
            <Empty icon="search" text={entries.length ? 'Nothing matches' : 'No skills or commands on this desktop'} />
          ) : null}
        </Card>
      </ScrollView>
    </View>
  )
}

/**
 * One name, what it does, and what kind of thing it is.
 *
 * The pill says skill, command or built in; a project's own skill is the
 * accent colour, because a skill this project ships is a different promise
 * from one the whole machine has. The argument hint rides on the title the way
 * the CLI prints it, so "/issue <number>" says before the tap that there is
 * something to fill in.
 */
function SkillRow({
  entry,
  busy,
  disabled,
  last,
  onPress,
}: {
  entry: AgentSkill
  busy: boolean
  disabled: boolean
  last: boolean
  onPress: () => void
}) {
  const palette = usePalette()
  const kind = entry.kind === 'builtin' ? 'built in' : entry.kind
  return (
    <View style={{ opacity: disabled && !busy ? 0.5 : 1 }}>
      <ListRow
        title={entry.args ? `/${entry.name} ${entry.args}` : `/${entry.name}`}
        subtitle={entry.description || null}
        right={
          busy ? (
            <ActivityIndicator size="small" color={palette.accent} />
          ) : (
            <Pill label={kind} tone={entry.scope === 'project' ? palette.accent : palette.light_foreground} />
          )
        }
        onPress={disabled ? undefined : onPress}
        last={last}
      />
    </View>
  )
}

/**
 * A text box with a magnifier in it and no label over it — the kit's `Field`
 * insists on a caps label, and a search box's label is its icon. Belongs in
 * the kit as `Field` with an optional label, or as `SearchField`.
 */
function SearchField({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  const palette = usePalette()
  const [focused, setFocused] = React.useState(false)
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: space.sm,
        minHeight: touch,
        marginBottom: space.md,
        paddingHorizontal: space.md,
        backgroundColor: palette.darker_background,
        borderColor: focused ? palette.foreground : palette.lighter_background,
        borderWidth: StyleSheet.hairlineWidth * 2,
        borderRadius: radius.sm,
      }}
    >
      <Feather name="search" size={14} color={palette.light_foreground} />
      <TextInput
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        placeholderTextColor={palette.muted}
        autoCapitalize="none"
        autoCorrect={false}
        autoFocus
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        maxFontSizeMultiplier={MAX_FONT_SCALE}
        accessibilityLabel={placeholder}
        style={{
          flex: 1,
          minHeight: touch - 4,
          color: palette.bright_foreground,
          fontFamily: font.regular,
          fontSize: size.value,
          paddingVertical: space.sm,
        }}
      />
      {value ? <IconButton icon="x" label="Clear search" size={28} onPress={() => onChange('')} /> : null}
    </View>
  )
}
