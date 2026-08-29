import React from 'react'
import { StyleSheet, Text, View } from 'react-native'

import { useConnection } from '../state/ConnectionContext'
import type { AgentLimit, AgentLimits, AgentSession, AgentVitals } from '../api/client'
import { Meter } from './kit'
import { alpha, font, radius, size, space } from '../theme'

/**
 * The desktop's status line, drawn on a phone.
 *
 * Claude Code puts a line under its prompt saying what it is running as and
 * how full it is: the model, the context meter, the permission mode. On the
 * desktop that line is glanced at; on a phone it is the difference between
 * sending an agent off on something long and finding out an hour later that
 * it stopped. So it is not decoration — it is the half of the screen you read
 * before you decide what to type into the other half.
 *
 * Everything here is derived, nothing is asked for. The daemon reads the
 * figures off the transcript, and these components only decide what a phone
 * has room for.
 */

/**
 * A model id as a person says it out loud.
 *
 * `claude-opus-5` on a status line is four wasted words: the prefix is the
 * same on every model this will ever see, and the phone has room for the part
 * that differs. An id that does not match the shape is shown as it came —
 * being wrong about a new model's name is worse than being verbose about it.
 */
export function modelLabel(model: string | null | undefined): string | null {
  const id = String(model || '').trim()
  if (!id) return null
  if (id === '<synthetic>') return null
  const match = /^claude-([a-z]+)-(\d+(?:-\d+)?)/.exec(id)
  if (!match) return id.replace(/^claude-/, '')
  const family = match[1][0].toUpperCase() + match[1].slice(1)
  return `${family} ${match[2].replace('-', '.')}`
}

/** 149388 → "149k". A phone has room for two significant figures of a token count. */
export function tokens(n: number | null | undefined): string {
  const value = Number(n) || 0
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`
  if (value >= 1000) return `${Math.round(value / 1000)}k`
  return String(value)
}

/**
 * When a usage window turns over, as a gap rather than a date.
 *
 * "resets 06:00 on Tuesday" makes you do the arithmetic; "4d" and "38m" are
 * the answer to the question actually being asked, which is whether waiting
 * is an option.
 */
export function until(at: number | null | undefined): string | null {
  if (!at) return null
  const ms = at - Date.now()
  if (ms <= 0) return 'now'
  const minutes = Math.round(ms / 60_000)
  if (minutes < 60) return `${minutes}m`
  const hours = ms / 3_600_000
  if (hours < 48) return `${Math.round(hours)}h`
  return `${Math.round(hours / 24)}d`
}

/** Green until it matters, then orange, then red. */
export function fillTone(palette: ReturnType<typeof useConnection>['palette'], percent: number) {
  if (percent >= 90) return palette.red
  if (percent >= 75) return palette.orange
  return palette.accent
}

/**
 * The permission mode, in the words the CLI uses for it.
 *
 * Only worth drawing when it is not the ordinary one: a badge that is always
 * on screen saying "normal" costs width and says nothing, while a session
 * quietly running in `bypassPermissions` is exactly the thing you would want
 * a phone to have told you.
 */
const MODES: Record<string, { label: string; tone: 'warn' | 'note' }> = {
  plan: { label: 'plan', tone: 'note' },
  acceptEdits: { label: 'accepts edits', tone: 'note' },
  auto: { label: 'auto', tone: 'note' },
  dontAsk: { label: "doesn't ask", tone: 'warn' },
  bypassPermissions: { label: 'no permissions', tone: 'warn' },
}

/**
 * One line: what it is running as, and how full it is.
 *
 * Laid out so the meter is the widest thing on it. The model and the mode are
 * chips of fixed width either side; the bar takes what is left, because it is
 * the only part whose value is in its length.
 */
export function StatusLine({ vitals, dense }: { vitals: AgentVitals | null | undefined; dense?: boolean }) {
  const { palette } = useConnection()
  if (!vitals) return null

  const model = modelLabel(vitals.model)
  const context = vitals.context
  const mode = vitals.mode ? MODES[vitals.mode] : null
  if (!model && !context && !mode) return null

  const percent = context?.percent ?? 0
  const tone = fillTone(palette, percent)

  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
      {model ? (
        <Text style={{ color: palette.light_foreground, fontFamily: font.medium, fontSize: size.micro }}>{model}</Text>
      ) : null}
      {vitals.effort && vitals.effort !== 'medium' && !dense ? (
        <Text style={{ color: palette.muted, fontFamily: font.regular, fontSize: size.micro }}>{vitals.effort}</Text>
      ) : null}

      {context ? (
        <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: space.sm, minWidth: 70 }}>
          <View style={{ flex: 1 }}>
            <Meter fraction={percent / 100} tone={tone} height={3} />
          </View>
          <Text style={{ color: percent >= 75 ? tone : palette.muted, fontFamily: font.regular, fontSize: size.micro }}>
            {dense ? `${percent}%` : `${tokens(context.tokens)}/${tokens(context.window)}`}
          </Text>
        </View>
      ) : (
        <View style={{ flex: 1 }} />
      )}

      {mode ? <Badge label={mode.label} tone={mode.tone === 'warn' ? palette.red : palette.muted} /> : null}
      {vitals.branch && !dense ? (
        <Text
          style={{ color: palette.muted, fontFamily: font.regular, fontSize: size.micro, maxWidth: 90 }}
          numberOfLines={1}
        >
          {vitals.branch}
        </Text>
      ) : null}
    </View>
  )
}

/** A small tinted word. Used where a chip would be too much furniture. */
export function Badge({ label, tone }: { label: string; tone: string }) {
  return (
    <View
      style={{
        paddingHorizontal: 6,
        paddingVertical: 1,
        borderRadius: radius.sm,
        backgroundColor: alpha(tone, 0.15),
        borderWidth: StyleSheet.hairlineWidth * 2,
        borderColor: alpha(tone, 0.4),
      }}
    >
      <Text style={{ color: tone, fontFamily: font.medium, fontSize: size.micro }}>{label}</Text>
    </View>
  )
}

/**
 * One usage window, as a bar with its reset time on the end.
 *
 * The active one is marked, because an account usually has two and only one of
 * them is the one that will actually stop you.
 */
export function LimitRow({ limit }: { limit: AgentLimit }) {
  const { palette } = useConnection()
  const tone = fillTone(palette, limit.percent)
  const gap = until(limit.resetsAt)
  return (
    <View style={{ gap: 4 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
        <Text
          style={{
            flex: 1,
            color: limit.active ? palette.light_foreground : palette.muted,
            fontFamily: limit.active ? font.medium : font.regular,
            fontSize: size.label,
          }}
          numberOfLines={1}
        >
          {limit.label}
        </Text>
        {gap ? (
          <Text style={{ color: palette.muted, fontFamily: font.regular, fontSize: size.micro }}>resets in {gap}</Text>
        ) : null}
        <Text style={{ color: tone, fontFamily: font.medium, fontSize: size.label, minWidth: 34, textAlign: 'right' }}>
          {limit.percent}%
        </Text>
      </View>
      <Meter fraction={limit.percent / 100} tone={tone} height={4} />
    </View>
  )
}

/**
 * The plan's headroom, all of it.
 *
 * Deliberately not folded away behind a tap. It is two rows, it changes the
 * answer to "should I start this now", and it is the one thing on the agents
 * screen that is true whether or not anything is running.
 */
export function Limits({ limits }: { limits: AgentLimits | null | undefined }) {
  const { palette } = useConnection()
  if (!limits?.limits?.length) return null
  return (
    <View style={{ gap: space.md }}>
      {limits.limits.map((limit) => (
        <LimitRow key={`${limit.kind}:${limit.label}`} limit={limit} />
      ))}
      {limits.spend?.limit ? (
        <Text style={{ color: palette.muted, fontFamily: font.regular, fontSize: size.micro }}>
          extra usage: {limits.spend.used?.toFixed(2)} of {limits.spend.limit.toFixed(2)} {limits.spend.currency}
        </Text>
      ) : null}
      {limits.stale ? (
        <Text style={{ color: palette.muted, fontFamily: font.regular, fontSize: size.micro }}>
          from the desktop's cache — it refreshes when a session runs there
        </Text>
      ) : null}
    </View>
  )
}

/**
 * Is this session in a multiplexer's pane, rather than at a keyboard the
 * desktop has to borrow?
 *
 * Two roads answer yes — tmux and herdr — and everything the phone decides
 * from the answer is the same for both: the composer is a text field rather
 * than an apology, the raw screen is one tap away, and nothing on the desktop
 * moves when you send. Which of the two it is belongs on the one line that
 * names the pane, and nowhere else.
 */
export const inPane = (session: Pick<AgentSession, 'writable'>) =>
  session.writable === 'tmux' || session.writable === 'herdr'
