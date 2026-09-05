import React from 'react'
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type StyleProp,
  type TextProps,
  type TextStyle,
  type ViewStyle,
} from 'react-native'
import { Feather } from '@expo/vector-icons'
import * as Clipboard from 'expo-clipboard'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { MAX_FONT_SCALE, alpha, font, line, radius, size, space, touch, type Palette } from '../theme'
import { usePalette } from '../state/ConnectionContext'
import { problem } from '../lib/errors'

export type IconName = React.ComponentProps<typeof Feather>['name']

/* ── text ────────────────────────────────────────────────────────────── */

/**
 * Every piece of text in the app goes through this, so the two things that
 * make a monospace layout fall apart — an unbounded OS font scale and a
 * default that lets a value wrap under its label — are decided once.
 */
export function Mono(props: TextProps) {
  return <Text maxFontSizeMultiplier={MAX_FONT_SCALE} {...props} />
}

/** A dim, one-line label: the left half of a key–value row. */
export function Label({ children, style, numberOfLines = 1 }: { children: React.ReactNode; style?: StyleProp<TextStyle>; numberOfLines?: number }) {
  const p = usePalette()
  return (
    <Mono style={[{ color: p.light_foreground, fontFamily: font.regular, fontSize: size.label, lineHeight: line.label }, style]} numberOfLines={numberOfLines}>
      {children}
    </Mono>
  )
}

/**
 * Small caps for section names and card subtitles. Always one line: a caps
 * string that wraps is a sentence that should have been shorter.
 */
export function Caps({
  children,
  style,
  tone,
  numberOfLines = 1,
}: {
  children: React.ReactNode
  style?: StyleProp<TextStyle>
  tone?: string
  numberOfLines?: number
}) {
  const p = usePalette()
  return (
    <Mono
      numberOfLines={numberOfLines}
      style={[
        {
          color: tone ?? p.muted,
          fontFamily: font.medium,
          fontSize: size.micro,
          lineHeight: line.micro,
          letterSpacing: 1.2,
          textTransform: 'uppercase',
        },
        style,
      ]}
    >
      {children}
    </Mono>
  )
}

/** A reading: the right half of a key–value row. Bright, one line, never wraps. */
export function Value({
  children,
  tone,
  style,
  numberOfLines = 1,
}: {
  children: React.ReactNode
  tone?: string
  style?: StyleProp<TextStyle>
  numberOfLines?: number
}) {
  const p = usePalette()
  return (
    <Mono
      style={[{ color: tone ?? p.bright_foreground, fontFamily: font.regular, fontSize: size.value, lineHeight: line.value }, style]}
      numberOfLines={numberOfLines}
    >
      {children}
    </Mono>
  )
}

export function Title({ children, style, numberOfLines = 1 }: { children: React.ReactNode; style?: StyleProp<TextStyle>; numberOfLines?: number }) {
  const p = usePalette()
  return (
    <Mono style={[{ color: p.bright_foreground, fontFamily: font.bold, fontSize: size.title, lineHeight: line.title }, style]} numberOfLines={numberOfLines}>
      {children}
    </Mono>
  )
}

/** The one big number on a card: a percentage, a temperature, a count. */
export function Hero({ children, tone, style }: { children: React.ReactNode; tone?: string; style?: StyleProp<TextStyle> }) {
  const p = usePalette()
  return (
    <Mono
      numberOfLines={1}
      style={[{ color: tone ?? p.bright_foreground, fontFamily: font.bold, fontSize: size.hero, lineHeight: line.hero, letterSpacing: -0.5 }, style]}
    >
      {children}
    </Mono>
  )
}

export function Body({
  children,
  tone,
  style,
  numberOfLines,
  selectable,
}: {
  children: React.ReactNode
  tone?: string
  style?: StyleProp<TextStyle>
  numberOfLines?: number
  selectable?: boolean
}) {
  const p = usePalette()
  return (
    <Mono
      selectable={selectable}
      numberOfLines={numberOfLines}
      style={[{ color: tone ?? p.foreground, fontFamily: font.regular, fontSize: size.body, lineHeight: line.body }, style]}
    >
      {children}
    </Mono>
  )
}

/**
 * The one line of help a card is allowed.
 *
 * Where a paragraph used to explain a feature, this says the one thing the
 * reader needs to act — "Needs a sudo rule on the desktop", "Android only".
 * Two lines at most, and if it does not fit in two it belongs in the README.
 */
export function Hint({ children, tone, icon, style }: { children: React.ReactNode; tone?: string; icon?: IconName; style?: StyleProp<ViewStyle> }) {
  const p = usePalette()
  const colour = tone ?? p.muted
  return (
    <View style={[{ flexDirection: 'row', alignItems: 'flex-start', gap: space.sm }, style]}>
      {icon ? <Feather name={icon} size={13} color={colour} style={{ marginTop: 2 }} /> : null}
      <Mono numberOfLines={2} style={{ flex: 1, color: colour, fontFamily: font.regular, fontSize: size.label, lineHeight: line.label }}>
        {children}
      </Mono>
    </View>
  )
}

/* ── containers ──────────────────────────────────────────────────────── */

export function Screen({
  children,
  scroll = true,
  refreshControl,
  padded = true,
}: {
  children: React.ReactNode
  scroll?: boolean
  refreshControl?: React.ReactElement<any>
  /** `false` for screens that draw their own edge-to-edge list. */
  padded?: boolean
}) {
  const p = usePalette()
  const insets = useSafeAreaInsets()
  const padding = {
    paddingTop: insets.top + space.sm,
    paddingHorizontal: padded ? space.lg : 0,
    paddingBottom: space.xxl,
  }
  if (!scroll) {
    return <View style={[{ flex: 1, backgroundColor: p.background }, padding]}>{children}</View>
  }
  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: p.background }}
      contentContainerStyle={padding}
      keyboardShouldPersistTaps="handled"
      showsVerticalScrollIndicator={false}
      refreshControl={refreshControl}
    >
      {children}
    </ScrollView>
  )
}

/**
 * The line at the top of every tab: what this screen is, as a bold title —
 * caps at 10sp next to a 36dp button read as a footnote — and up to
 * two actions on the right. `status` is the small coloured word beside the
 * title — "connected", "offline" — and is the only place a tab says how the
 * link is doing.
 */
export function ScreenHeader({
  title,
  status,
  right,
}: {
  title: string
  status?: { label: string; tone: string } | null
  right?: React.ReactNode
}) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', minHeight: touch, marginBottom: space.sm }}>
      <View style={{ flex: 1, flexDirection: 'row', alignItems: 'baseline', gap: space.md, minWidth: 0 }}>
        <Title style={{ fontSize: size.title + 2, lineHeight: line.title + 2 }}>{title}</Title>
        {status ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.xs + 2, flexShrink: 1 }}>
            <StatusDot tone={status.tone} size={6} />
            <Caps tone={status.tone}>{status.label}</Caps>
          </View>
        ) : null}
      </View>
      {right ? <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>{right}</View> : null}
    </View>
  )
}

export function Card({ children, style, tone }: { children: React.ReactNode; style?: StyleProp<ViewStyle>; tone?: string }) {
  const p = usePalette()
  return (
    <View
      style={[
        {
          backgroundColor: p.dark_background,
          borderColor: tone ? alpha(tone, 0.45) : p.lighter_background,
          borderWidth: StyleSheet.hairlineWidth * 2,
          borderRadius: radius.md,
          padding: space.lg - 2,
          marginBottom: space.md,
        },
        style,
      ]}
    >
      {children}
    </View>
  )
}

export function IconBox({ name, tone, size: box = 32 }: { name: IconName; tone?: string; size?: number }) {
  const p = usePalette()
  return (
    <View
      style={{
        width: box,
        height: box,
        borderRadius: radius.sm,
        borderWidth: StyleSheet.hairlineWidth * 2,
        borderColor: p.lighter_background,
        backgroundColor: p.darker_background,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Feather name={name} size={Math.round(box / 2)} color={tone ?? p.bright_foreground} />
    </View>
  )
}

/**
 * The top row of a card: a boxed icon, a one-line title, a one-line caps
 * subtitle, and a slot on the right for a value or an icon button. Both text
 * lines truncate rather than wrap — a header that wraps is a header that
 * pushes the card's content below the fold.
 */
export function CardHeader({
  icon,
  title,
  subtitle,
  tone,
  right,
  style,
}: {
  icon: IconName
  title: string
  subtitle?: string | null
  tone?: string
  right?: React.ReactNode
  style?: StyleProp<ViewStyle>
}) {
  return (
    <View style={[{ flexDirection: 'row', alignItems: 'center', marginBottom: space.md }, style]}>
      <IconBox name={icon} tone={tone} />
      <View style={{ flex: 1, marginLeft: space.md, minWidth: 0 }}>
        <Title>{title}</Title>
        {subtitle ? <Caps style={{ marginTop: 2 }}>{subtitle}</Caps> : null}
      </View>
      {right ? <View style={{ marginLeft: space.sm, flexShrink: 0 }}>{right}</View> : null}
    </View>
  )
}

/**
 * A caps heading inside a card, separating one group of rows from the next,
 * with an optional right-hand slot (a count, a small action).
 */
export function Section({ title, right, tone, style }: { title: string; right?: React.ReactNode; tone?: string; style?: StyleProp<ViewStyle> }) {
  return (
    <View style={[{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: space.sm }, style]}>
      <Caps tone={tone}>{title}</Caps>
      {right}
    </View>
  )
}

export function Divider({ style }: { style?: StyleProp<ViewStyle> }) {
  const p = usePalette()
  return (
    <View
      style={[{ height: StyleSheet.hairlineWidth * 2, backgroundColor: p.lighter_background, marginVertical: space.md }, style]}
    />
  )
}

/* ── data display ────────────────────────────────────────────────────── */

export type Pair = { label: string; value: React.ReactNode; tone?: string }

/**
 * One key–value line: dim label on the left, bright value flush right.
 *
 * The label keeps its width and the value gives way, so what truncates —
 * when anything must — is the tail of a long value and never the name of
 * the thing being read.
 */
export function Row({ label, value, tone, style }: Pair & { style?: StyleProp<ViewStyle> }) {
  return (
    <View style={[{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: line.value + space.sm }, style]}>
      <Label style={{ flexShrink: 0, marginRight: space.md }}>{label}</Label>
      {typeof value === 'string' || typeof value === 'number' ? (
        <Value tone={tone} style={{ flexShrink: 1, textAlign: 'right' }}>
          {value}
        </Value>
      ) : (
        <View style={{ flexShrink: 1, alignItems: 'flex-end' }}>{value}</View>
      )}
    </View>
  )
}

/**
 * The two-column readout from the Omarchy status cards, re-cut for a phone.
 *
 * On a 360dp screen in a monospace face, two columns have room for a label
 * and about six characters of value each. Anything longer — an address, a
 * kernel string, a rate with a unit — was arriving as "192.1…". So `columns`
 * is now the most this grid will use, not what it always uses: a pair goes
 * side by side with its neighbour only when both of them are short enough
 * to fit, and otherwise takes a full-width row of its own. Callers keep
 * passing what they passed; the grid decides what fits.
 */
export function DataGrid({ pairs, columns = 2, style }: { pairs: Pair[]; columns?: 1 | 2; style?: StyleProp<ViewStyle> }) {
  const rows: Pair[][] = []
  const fitsHalf = (pair: Pair) =>
    (typeof pair.value === 'string' || typeof pair.value === 'number') &&
    pair.label.length + String(pair.value).length <= 15
  for (let i = 0; i < pairs.length; ) {
    const a = pairs[i]
    const b = pairs[i + 1]
    if (columns === 2 && b && fitsHalf(a) && fitsHalf(b)) {
      rows.push([a, b])
      i += 2
    } else {
      rows.push([a])
      i += 1
    }
  }
  return (
    <View style={style}>
      {rows.map((row, i) => (
        <View key={i} style={{ flexDirection: 'row' }}>
          {row.map((pair, j) => (
            <Row key={pair.label} {...pair} style={{ flex: 1, marginLeft: j === 1 ? space.lg : 0 }} />
          ))}
        </View>
      ))}
    </View>
  )
}

/**
 * A big reading with its name under it — "2%" over "CPU", "28°C" over
 * "TEMP". Two or three of these across a card is how a dashboard says the
 * headline before the detail.
 */
export function Stat({ value, label, tone, align = 'left', style }: { value: string; label: string; tone?: string; align?: 'left' | 'right'; style?: StyleProp<ViewStyle> }) {
  return (
    <View style={[{ alignItems: align === 'right' ? 'flex-end' : 'flex-start' }, style]}>
      <Hero tone={tone}>{value}</Hero>
      <Caps style={{ marginTop: 2 }}>{label}</Caps>
    </View>
  )
}

export function Meter({ fraction, tone, height = 4, style }: { fraction: number; tone?: string; height?: number; style?: StyleProp<ViewStyle> }) {
  const p = usePalette()
  const clamped = Math.max(0, Math.min(1, Number.isFinite(fraction) ? fraction : 0))
  return (
    <View style={[{ height, borderRadius: height / 2, backgroundColor: p.lighter_background, overflow: 'hidden' }, style]}>
      <View style={{ width: `${clamped * 100}%`, height: '100%', borderRadius: height / 2, backgroundColor: tone ?? p.accent }} />
    </View>
  )
}

export function StatusDot({ tone, pulse, size: dot = 7 }: { tone: string; pulse?: boolean; size?: number }) {
  return (
    <View
      style={{
        width: dot,
        height: dot,
        borderRadius: dot / 2,
        backgroundColor: tone,
        opacity: pulse ? 0.7 : 1,
      }}
    />
  )
}

/** A small filled word: a state ("waiting"), a kind ("apk"), a count. */
export function Pill({ label, tone, icon, caps = true }: { label: string; tone?: string; icon?: IconName; /** `false` for a value with a unit — "22 ms" should not read "22 MS". */ caps?: boolean }) {
  const p = usePalette()
  const colour = tone ?? p.light_foreground
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: space.xs,
        paddingHorizontal: space.sm,
        height: 22,
        borderRadius: 11,
        backgroundColor: alpha(colour, 0.14),
      }}
    >
      {icon ? <Feather name={icon} size={11} color={colour} /> : null}
      <Mono
        numberOfLines={1}
        style={{
          color: colour,
          fontFamily: font.medium,
          fontSize: caps ? size.micro : size.label,
          lineHeight: caps ? line.micro : line.label,
          letterSpacing: caps ? 0.8 : 0,
          textTransform: caps ? 'uppercase' : 'none',
        }}
      >
        {label}
      </Mono>
    </View>
  )
}

/* ── controls ────────────────────────────────────────────────────────── */

export function Button({
  label,
  icon,
  onPress,
  onLongPress,
  tone,
  variant = 'default',
  disabled,
  loading,
  compact,
  style,
}: {
  label?: string
  icon?: IconName
  onPress?: () => void
  onLongPress?: () => void
  tone?: string
  variant?: 'default' | 'solid' | 'ghost' | 'danger'
  disabled?: boolean
  loading?: boolean
  /** A shorter button for a row of them inside a card. */
  compact?: boolean
  style?: StyleProp<ViewStyle>
}) {
  const p = usePalette()
  const accent = variant === 'danger' ? p.red : tone ?? p.foreground
  const solid = variant === 'solid'
  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      disabled={disabled || loading}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled || !!loading }}
      style={({ pressed }) => [
        {
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'center',
          gap: space.sm,
          minHeight: compact ? 36 : touch,
          paddingVertical: compact ? space.sm : space.md - 2,
          paddingHorizontal: space.lg,
          borderRadius: radius.sm,
          borderWidth: variant === 'ghost' ? 0 : StyleSheet.hairlineWidth * 2,
          borderColor: solid ? alpha(accent, 0.6) : variant === 'danger' ? alpha(p.red, 0.4) : p.lighter_background,
          backgroundColor:
            variant === 'ghost'
              ? pressed
                ? p.selection
                : 'transparent'
              : solid
                ? alpha(accent, pressed ? 0.3 : 0.18)
                : pressed
                  ? p.selection
                  : p.darker_background,
          opacity: disabled ? 0.4 : 1,
        },
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator size="small" color={accent} />
      ) : icon ? (
        <Feather name={icon} size={15} color={accent} />
      ) : null}
      {label ? (
        <Mono style={{ color: accent, fontFamily: font.medium, fontSize: size.body, lineHeight: line.body }} numberOfLines={1}>
          {label}
        </Mono>
      ) : null}
    </Pressable>
  )
}

/** A square button with only an icon in it — the refresh in a card header, the close on a row. */
export function IconButton({
  icon,
  onPress,
  onLongPress,
  tone,
  disabled,
  loading,
  label,
  active,
  size: box = 36,
  style,
}: {
  icon: IconName
  onPress?: () => void
  onLongPress?: () => void
  tone?: string
  disabled?: boolean
  loading?: boolean
  /** What a screen reader says. */
  label: string
  /** A toggled-on state — mute while muted — drawn in `tone` with a tinted fill. */
  active?: boolean
  size?: number
  style?: StyleProp<ViewStyle>
}) {
  const p = usePalette()
  const colour = tone ?? p.foreground
  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      disabled={disabled || loading}
      hitSlop={6}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled || !!loading, selected: !!active }}
      style={({ pressed }) => [
        {
          width: box,
          height: box,
          borderRadius: radius.sm,
          borderWidth: StyleSheet.hairlineWidth * 2,
          borderColor: active ? alpha(colour, 0.6) : p.lighter_background,
          backgroundColor: active ? alpha(colour, pressed ? 0.3 : 0.18) : pressed ? p.selection : p.darker_background,
          alignItems: 'center',
          justifyContent: 'center',
          opacity: disabled ? 0.4 : 1,
        },
        style,
      ]}
    >
      {loading ? <ActivityIndicator size="small" color={colour} /> : <Feather name={icon} size={Math.round(box * 0.45)} color={colour} />}
    </Pressable>
  )
}

/**
 * The DNS-provider row from the Omarchy card: equal-width bordered boxes,
 * the active one filled. A label that would not fit its box shrinks to fit
 * rather than being cut — "Cloudf…" is not a choice anyone can make.
 */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  disabled,
}: {
  options: { value: T; label: string }[]
  value: T | null
  onChange: (value: T) => void
  disabled?: boolean
}) {
  const p = usePalette()
  return (
    <View style={{ flexDirection: 'row', gap: space.sm }}>
      {options.map((option) => {
        const active = option.value === value
        return (
          <Pressable
            key={option.value}
            disabled={disabled}
            onPress={() => onChange(option.value)}
            accessibilityRole="button"
            accessibilityState={{ selected: active, disabled: !!disabled }}
            style={({ pressed }) => ({
              flex: 1,
              minHeight: touch - 4,
              paddingHorizontal: space.xs,
              borderRadius: radius.sm,
              borderWidth: StyleSheet.hairlineWidth * 2,
              borderColor: active ? p.foreground : p.lighter_background,
              backgroundColor: active ? p.selection : pressed ? p.lighter_background : p.darker_background,
              alignItems: 'center',
              justifyContent: 'center',
              opacity: disabled ? 0.4 : 1,
            })}
          >
            <Mono
              style={{
                color: active ? p.bright_foreground : p.foreground,
                fontFamily: active ? font.medium : font.regular,
                fontSize: size.body,
              }}
              numberOfLines={1}
              adjustsFontSizeToFit
              minimumFontScale={0.7}
            >
              {option.label}
            </Mono>
          </Pressable>
        )
      })}
    </View>
  )
}

export function Empty({ icon, text, action }: { icon: IconName; text: string; action?: { label: string; icon?: IconName; onPress: () => void } | null }) {
  const p = usePalette()
  return (
    <View style={{ alignItems: 'center', paddingVertical: space.xl }}>
      <Feather name={icon} size={20} color={p.muted} />
      <Body tone={p.muted} style={{ marginTop: space.sm, textAlign: 'center' }} numberOfLines={2}>
        {text}
      </Body>
      {action ? <Button label={action.label} icon={action.icon} onPress={action.onPress} compact style={{ marginTop: space.md }} /> : null}
    </View>
  )
}

/**
 * Something went wrong, said in one line.
 *
 * This is the one surface for every failure a screen shows. It takes the
 * thrown value itself — not a string a caller squeezed out of it —
 * normalises it through `lib/errors`, and shows the sentence. The rest of the
 * trace is not thrown away: when there is more to read, the notice says so,
 * and a tap opens it in a box of its own that scrolls rather than grows.
 * Long-press copies the lot, because the place a stack trace belongs is a
 * bug report.
 *
 * `tone` carries the meaning: `error` red, `warning` orange, `ok` green,
 * `info` the palette's blue for a note that is neither.
 *
 * `action` is the way out, for the failures that have one. The sentence
 * saying what stopped is the natural place for the button that starts it
 * again: the screen has already drawn the user's eye here.
 */
export function Notice({
  error,
  tone = 'error',
  icon,
  onDismiss,
  action,
  style,
}: {
  error: unknown
  tone?: 'error' | 'warning' | 'ok' | 'info'
  icon?: IconName
  onDismiss?: () => void
  action?: { label: string; icon?: IconName; onPress: () => void } | null
  style?: StyleProp<ViewStyle>
}) {
  const p = usePalette()
  const [open, setOpen] = React.useState(false)
  const [copied, setCopied] = React.useState(false)

  // Nothing to say is not a notice. Screens hold `null` when all is well and
  // render this unconditionally, so the empty case has to be silent.
  if (error == null || (typeof error === 'string' && !error.trim())) return null

  const { message, detail } = problem(error)
  const colour = tone === 'ok' ? p.green : tone === 'warning' ? p.orange : tone === 'info' ? p.blue : p.red
  const name =
    icon ?? (tone === 'ok' ? 'check-circle' : tone === 'warning' ? 'alert-triangle' : tone === 'info' ? 'info' : 'alert-circle')

  const copy = () => {
    void Clipboard.setStringAsync(detail || message)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <View
      accessibilityRole="alert"
      style={[
        {
          flexDirection: 'row',
          alignItems: 'flex-start',
          borderRadius: radius.sm,
          borderLeftWidth: 2,
          borderLeftColor: colour,
          backgroundColor: alpha(colour, 0.1),
          paddingVertical: space.md - 2,
          paddingHorizontal: space.md,
          marginBottom: space.md,
        },
        style,
      ]}
    >
      <Feather name={name} size={15} color={colour} style={{ marginTop: 2 }} />
      <View style={{ flex: 1, marginLeft: space.sm }}>
        <Pressable onPress={() => detail && setOpen((was) => !was)} onLongPress={copy} disabled={!detail}>
          <Mono
            style={{ color: colour, fontFamily: font.regular, fontSize: size.body, lineHeight: line.body }}
            numberOfLines={open ? undefined : 3}
          >
            {message}
          </Mono>
          {detail ? (
            <Mono style={{ color: p.muted, fontFamily: font.regular, fontSize: size.micro, lineHeight: line.micro, marginTop: space.xs }}>
              {copied ? 'copied' : open ? 'tap to hide · hold to copy' : 'tap for details'}
            </Mono>
          ) : null}
          {open && detail ? (
            <ScrollView
              style={{
                maxHeight: 160,
                marginTop: space.sm,
                backgroundColor: p.darker_background,
                borderRadius: radius.sm,
                padding: space.sm,
              }}
              nestedScrollEnabled
            >
              <Mono selectable style={{ color: p.light_foreground, fontFamily: font.regular, fontSize: size.micro, lineHeight: line.micro }}>
                {detail}
              </Mono>
            </ScrollView>
          ) : null}
        </Pressable>
        {action ? (
          <View style={{ flexDirection: 'row', marginTop: space.sm }}>
            <Button label={action.label} icon={action.icon} onPress={action.onPress} variant="solid" tone={colour} compact />
          </View>
        ) : null}
      </View>
      {onDismiss ? (
        <Pressable onPress={onDismiss} hitSlop={10} accessibilityRole="button" accessibilityLabel="Dismiss" style={{ marginLeft: space.sm }}>
          <Feather name="x" size={15} color={p.muted} />
        </Pressable>
      ) : null}
    </View>
  )
}

export function toneFor(p: Palette, fraction: number) {
  if (fraction >= 0.9) return p.red
  if (fraction >= 0.75) return p.orange
  return p.accent
}

/**
 * A meter you can set by touch. React Native ships no slider, and pulling one
 * in for two controls is not worth it: tap or drag along the bar instead.
 */
export function LevelBar({
  value,
  onChange,
  tone,
  disabled,
}: {
  value: number
  onChange: (percent: number) => void
  tone?: string
  disabled?: boolean
}) {
  const p = usePalette()
  const [width, setWidth] = React.useState(0)
  const clamped = Math.max(0, Math.min(100, value))

  const emit = (x: number) => {
    if (!width || disabled) return
    onChange(Math.round(Math.max(0, Math.min(1, x / width)) * 100))
  }

  return (
    <View
      onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
      onStartShouldSetResponder={() => !disabled}
      onMoveShouldSetResponder={() => !disabled}
      onResponderGrant={(e) => emit(e.nativeEvent.locationX)}
      onResponderMove={(e) => emit(e.nativeEvent.locationX)}
      accessibilityRole="adjustable"
      accessibilityValue={{ min: 0, max: 100, now: Math.round(clamped) }}
      style={{
        height: touch,
        justifyContent: 'center',
        opacity: disabled ? 0.4 : 1,
      }}
    >
      <View
        style={{
          height: 8,
          borderRadius: 4,
          backgroundColor: p.lighter_background,
          overflow: 'hidden',
        }}
      >
        <View style={{ width: `${clamped}%`, height: '100%', borderRadius: 4, backgroundColor: tone ?? p.accent }} />
      </View>
      <View
        pointerEvents="none"
        style={{
          position: 'absolute',
          left: `${clamped}%`,
          marginLeft: -7,
          width: 14,
          height: 14,
          borderRadius: 7,
          backgroundColor: p.bright_foreground,
        }}
      />
    </View>
  )
}

export function Chip({
  label,
  active,
  onPress,
  onLongPress,
  tone,
  icon,
  disabled,
}: {
  label: string
  active?: boolean
  onPress?: () => void
  onLongPress?: () => void
  tone?: string
  icon?: IconName
  disabled?: boolean
}) {
  const p = usePalette()
  const colour = active ? tone ?? p.bright_foreground : p.foreground
  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityState={{ selected: !!active, disabled: !!disabled }}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: space.xs + 2,
        paddingHorizontal: space.md,
        height: 34,
        borderRadius: radius.sm,
        borderWidth: StyleSheet.hairlineWidth * 2,
        borderColor: active ? tone ?? p.foreground : p.lighter_background,
        backgroundColor: active ? p.selection : pressed ? p.lighter_background : p.darker_background,
        minWidth: 40,
        justifyContent: 'center',
        opacity: disabled ? 0.4 : 1,
      })}
    >
      {icon ? <Feather name={icon} size={12} color={colour} /> : null}
      <Mono
        numberOfLines={1}
        style={{
          color: colour,
          fontFamily: active ? font.medium : font.regular,
          fontSize: size.label,
          lineHeight: line.label,
        }}
      >
        {label}
      </Mono>
    </Pressable>
  )
}

/**
 * A labelled text box. Lived in the pairing screen until a second screen
 * needed one to take an address by hand.
 */
export function Field({
  label,
  value,
  onChange,
  placeholder,
  keyboardType,
  maxLength,
  error,
  autoFocus,
  secure,
  onSubmit,
  right,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  placeholder?: string
  keyboardType?: 'default' | 'number-pad' | 'numbers-and-punctuation' | 'url'
  maxLength?: number
  /** Shown under the box in red; the box's border turns red with it. */
  error?: string | null
  autoFocus?: boolean
  secure?: boolean
  onSubmit?: () => void
  right?: React.ReactNode
}) {
  const p = usePalette()
  const [focused, setFocused] = React.useState(false)
  return (
    <View style={{ marginBottom: space.md }}>
      <Caps style={{ marginBottom: space.xs + 2 }}>{label}</Caps>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
        <TextInput
          value={value}
          onChangeText={onChange}
          placeholder={placeholder}
          placeholderTextColor={p.muted}
          keyboardType={keyboardType}
          maxLength={maxLength}
          autoFocus={autoFocus}
          secureTextEntry={secure}
          onSubmitEditing={onSubmit}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          autoCapitalize="none"
          autoCorrect={false}
          maxFontSizeMultiplier={MAX_FONT_SCALE}
          accessibilityLabel={label}
          style={{
            flex: 1,
            minHeight: touch,
            color: p.bright_foreground,
            fontFamily: font.regular,
            fontSize: size.value,
            backgroundColor: p.darker_background,
            borderColor: error ? p.red : focused ? p.foreground : p.lighter_background,
            borderWidth: StyleSheet.hairlineWidth * 2,
            borderRadius: radius.sm,
            paddingHorizontal: space.md,
            paddingVertical: space.sm + 2,
          }}
        />
        {right}
      </View>
      {error ? (
        <Mono numberOfLines={2} style={{ color: p.red, fontFamily: font.regular, fontSize: size.label, lineHeight: line.label, marginTop: space.xs }}>
          {error}
        </Mono>
      ) : null}
    </View>
  )
}

export function ListRow({
  title,
  subtitle,
  right,
  left,
  onPress,
  onLongPress,
  tone,
  chevron,
  last,
  lines = 1,
}: {
  title: string
  subtitle?: string | null
  right?: React.ReactNode
  left?: React.ReactNode
  onPress?: () => void
  onLongPress?: () => void
  tone?: string
  /** Draws the disclosure arrow on the right, for rows that open something. */
  chevron?: boolean
  /** The last row of a list draws no rule under it. */
  last?: boolean
  /** How many lines the title may take — 2 for titles somebody else wrote (window titles, session names). */
  lines?: 1 | 2
}) {
  const p = usePalette()
  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      disabled={!onPress && !onLongPress}
      accessibilityRole={onPress ? 'button' : undefined}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        minHeight: touch + 4,
        paddingVertical: space.sm + 2,
        borderBottomWidth: last ? 0 : StyleSheet.hairlineWidth * 2,
        borderBottomColor: p.lighter_background,
        opacity: pressed ? 0.6 : 1,
      })}
    >
      {left ? <View style={{ marginRight: space.md }}>{left}</View> : null}
      <View style={{ flex: 1, marginRight: space.md, minWidth: 0 }}>
        <Mono style={{ color: tone ?? p.bright_foreground, fontFamily: font.regular, fontSize: size.value, lineHeight: line.value }} numberOfLines={lines}>
          {title}
        </Mono>
        {subtitle ? (
          <Mono style={{ color: p.muted, fontFamily: font.regular, fontSize: size.label, lineHeight: line.label, marginTop: 1 }} numberOfLines={1}>
            {subtitle}
          </Mono>
        ) : null}
      </View>
      {right}
      {chevron ? <Feather name="chevron-right" size={16} color={p.muted} style={{ marginLeft: space.xs }} /> : null}
    </Pressable>
  )
}

/**
 * A row with a switch on it, for the settings that are one bit. The label
 * says what is on; the hint under it, when there is one, says what that
 * costs — in one line.
 */
export function Toggle({
  label,
  hint,
  value,
  onChange,
  disabled,
  tone,
  last,
}: {
  label: string
  hint?: string | null
  value: boolean
  onChange: (next: boolean) => void
  disabled?: boolean
  tone?: string
  last?: boolean
}) {
  const p = usePalette()
  const on = tone ?? p.accent
  return (
    <Pressable
      onPress={() => onChange(!value)}
      disabled={disabled}
      accessibilityRole="switch"
      accessibilityState={{ checked: value, disabled: !!disabled }}
      accessibilityLabel={label}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        minHeight: touch + 4,
        paddingVertical: space.sm + 2,
        borderBottomWidth: last ? 0 : StyleSheet.hairlineWidth * 2,
        borderBottomColor: p.lighter_background,
        opacity: disabled ? 0.4 : pressed ? 0.7 : 1,
      })}
    >
      <View style={{ flex: 1, marginRight: space.md, minWidth: 0 }}>
        <Mono style={{ color: p.bright_foreground, fontFamily: font.regular, fontSize: size.value, lineHeight: line.value }} numberOfLines={1}>
          {label}
        </Mono>
        {hint ? (
          <Mono style={{ color: p.muted, fontFamily: font.regular, fontSize: size.label, lineHeight: line.label, marginTop: 1 }} numberOfLines={2}>
            {hint}
          </Mono>
        ) : null}
      </View>
      <View
        style={{
          width: 40,
          height: 24,
          borderRadius: 12,
          padding: 3,
          backgroundColor: value ? on : p.lighter_background,
          alignItems: value ? 'flex-end' : 'flex-start',
          justifyContent: 'center',
        }}
      >
        <View style={{ width: 18, height: 18, borderRadius: 9, backgroundColor: value ? p.background : p.muted }} />
      </View>
    </Pressable>
  )
}
