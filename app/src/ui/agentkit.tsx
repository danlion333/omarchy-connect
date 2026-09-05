import React from 'react'
import { View, type StyleProp, type TextStyle } from 'react-native'

import { usePalette } from '../state/ConnectionContext'
import type { AgentLimit, AgentLimits, AgentSession, AgentVitals } from '../api/client'
import { Caps, Hint, Label, Meter, Mono, Pill, Row, Value } from './kit'
import { font, line, size, space } from '../theme'

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
 * "resets 06:00 on Tuesday" makes you do the arithmetic; "4d 6h" and "38m"
 * are the answer to the question actually being asked, which is whether
 * waiting is an option. Days alone are not: the difference between "3d" that
 * means three days and "3d" that means three and a half is a whole evening,
 * and it is the evening you were deciding about.
 */
export function until(at: number | null | undefined): string | null {
  if (!at) return null
  const ms = at - Date.now()
  if (ms <= 0) return 'now'
  const minutes = Math.round(ms / 60_000)
  if (minutes < 60) return `${minutes}m`
  const hours = ms / 3_600_000
  if (hours < 48) return `${Math.round(hours)}h`
  const days = Math.floor(hours / 24)
  const rest = Math.round(hours - days * 24)
  // 24 hours of remainder is another day, not "3d 24h".
  return rest === 24 ? `${days + 1}d` : rest ? `${days}d ${rest}h` : `${days}d`
}

/**
 * How old a figure is, for the ones nothing on the desktop is refreshing.
 *
 * The mirror image of `until`, and needed for the same reason: a percentage
 * measured last Friday is not the plan's state, it is a memory of it, and the
 * only honest way to show one is beside its age.
 */
export function since(at: number | null | undefined): string | null {
  if (!at) return null
  const hours = (Date.now() - at) / 3_600_000
  if (hours < 1) return null
  if (hours < 48) return `${Math.round(hours)}h old`
  return `${Math.round(hours / 24)}d old`
}

/** Green until it matters, then orange, then red. */
export function fillTone(palette: ReturnType<typeof usePalette>, percent: number) {
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

/** The width of the context meter. Fixed, so six status lines in a list read as one column. */
const METER_WIDTH = 60

/**
 * The small type this line is set in: `size.micro`, one line, never wrapping.
 * Values on it are `light_foreground` rather than `muted` — a percentage is a
 * reading, and the rules say `muted` never carries one.
 */
function Micro({ children, tone, weight, style }: { children: React.ReactNode; tone?: string; weight?: 'regular' | 'medium'; style?: StyleProp<TextStyle> }) {
  const palette = usePalette()
  return (
    <Mono
      numberOfLines={1}
      style={[
        {
          color: tone ?? palette.light_foreground,
          fontFamily: weight === 'medium' ? font.medium : font.regular,
          fontSize: size.micro,
          lineHeight: line.micro,
        },
        style,
      ]}
    >
      {children}
    </Mono>
  )
}

/**
 * One line: what it is running as, and how full it is.
 *
 * Budgeted for the 300dp inside a card: the model ("Fable 5.1", ~54dp), a
 * fixed 60dp meter, the reading beside it, the mode as a pill, and the branch
 * last with whatever is left — it is the only part that may truncate, because
 * a branch name is recognisable from its head and nothing else here is. In
 * `dense` (the list) the reading is the percentage and the effort is dropped;
 * in full (the chat) it is "149k/200k" and the effort is shown.
 */
export function StatusLine({ vitals, dense }: { vitals: AgentVitals | null | undefined; dense?: boolean }) {
  const palette = usePalette()
  if (!vitals) return null

  const model = modelLabel(vitals.model)
  const context = vitals.context
  const mode = vitals.mode ? MODES[vitals.mode] : null
  if (!model && !context && !mode) return null

  const percent = context?.percent ?? 0
  const tone = fillTone(palette, percent)

  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm, minHeight: 22 }}>
      {model ? <Micro weight="medium">{model}</Micro> : null}
      {vitals.effort && vitals.effort !== 'medium' && !dense ? <Micro tone={palette.muted}>{vitals.effort}</Micro> : null}

      {context ? (
        <>
          <Meter fraction={percent / 100} tone={tone} height={3} style={{ width: METER_WIDTH }} />
          <Micro tone={percent >= 75 ? tone : undefined}>
            {dense ? `${percent}%` : `${tokens(context.tokens)}/${tokens(context.window)}`}
          </Micro>
        </>
      ) : null}

      {mode ? <Badge label={mode.label} tone={mode.tone === 'warn' ? palette.red : palette.light_foreground} /> : null}

      {vitals.branch ? (
        <Micro tone={palette.muted} style={{ flexShrink: 1, marginLeft: 'auto' }}>
          {vitals.branch}
        </Micro>
      ) : null}
    </View>
  )
}

/**
 * A small tinted word. Kept as a name for the screens that already use it;
 * it is the kit's `Pill`, so the two are one shape.
 */
export function Badge({ label, tone }: { label: string; tone: string }) {
  return <Pill label={label} tone={tone} />
}

/**
 * One usage window: its name, when it turns over, and how much is used, on
 * one line over a meter.
 *
 * The active window — the one that will actually stop you — is the bright
 * one; the others are labels.
 */
export function LimitRow({ limit }: { limit: AgentLimit }) {
  const palette = usePalette()
  const tone = fillTone(palette, limit.percent)
  // A stale row's own age is the more useful of the two facts, and printing
  // both would crowd a line that has a percentage to fit as well.
  const age = limit.stale ? since(limit.asOf) : null
  const gap = age ? null : until(limit.resetsAt)
  return (
    <View style={{ gap: space.xs + 2 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
        <Label style={{ flex: 1, color: limit.active ? palette.bright_foreground : palette.light_foreground }}>{limit.label}</Label>
        {age ? <Caps>{age}</Caps> : gap ? <Caps>{`resets in ${gap}`}</Caps> : null}
        <Value tone={age ? palette.light_foreground : tone} style={{ minWidth: 34, textAlign: 'right' }}>
          {limit.percent}%
        </Value>
      </View>
      <Meter fraction={limit.percent / 100} tone={age ? palette.muted : tone} height={4} />
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
  if (!limits?.limits?.length) return null
  // Normally every row here was measured seconds ago: the desktop asks the
  // account service outright, and it answers each window at once. A row only
  // has an age when that ask failed and something older had to stand in — so
  // the note names the rows it is about and, when the desktop knows, says
  // what went wrong instead of describing a cache as if it were the design.
  const stale = limits.limits.filter((limit) => limit.stale).map((limit) => limit.label)
  const because = limits.probeStatus ? `the desktop is ${limits.probeStatus}` : 'the desktop has nothing newer'
  const spend = limits.spend
  return (
    <View style={{ gap: space.md }}>
      {limits.limits.map((limit) => (
        <LimitRow key={`${limit.kind}:${limit.label}`} limit={limit} />
      ))}
      {spend?.limit ? (
        <Row label="Extra usage" value={`${spend.used?.toFixed(2) ?? '0.00'} / ${spend.limit.toFixed(2)} ${spend.currency}`} />
      ) : null}
      {stale.length ? (
        <Hint icon="clock">
          {stale.length === limits.limits.length ? `Measured earlier · ${because}` : `${stale.join(', ')} measured earlier · ${because}`}
        </Hint>
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
