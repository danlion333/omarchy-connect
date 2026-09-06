import React from 'react'
import {
  AccessibilityInfo,
  ActivityIndicator,
  Animated,
  AppState,
  Easing,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  useWindowDimensions,
  type StyleProp,
  type TextProps,
  type TextStyle,
  type ViewStyle,
} from 'react-native'
import { Feather } from '@expo/vector-icons'
import * as Clipboard from 'expo-clipboard'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { MAX_FONT_SCALE, alpha, font, line, radius, size, space, surface, touch, type Palette } from '../theme'
import { usePalette } from '../state/ConnectionContext'
import { useLook } from './look'
import { problem } from '../lib/errors'

/**
 * The card surface for this phone right now: glass over the wallpaper, or
 * solid when Transparency is off. Anything that draws a card-like panel — the
 * card itself, a toast, the confirm — reads it from here.
 */
export function useSurface() {
  const p = usePalette()
  const { transparency } = useLook()
  return React.useMemo(() => surface(p, !transparency), [p, transparency])
}

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
    paddingTop: insets.top + space.sm + 2,
    paddingHorizontal: padded ? space.lg : 0,
    paddingBottom: space.xl,
  }
  // The workspace is transparent: the wallpaper is one layer behind the whole
  // pager, so a screen that paints its own background would cover it.
  if (!scroll) {
    return <View style={[{ flex: 1 }, padding]}>{children}</View>
  }
  return (
    <ScrollView
      style={{ flex: 1 }}
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
  sub,
  dot,
  status,
  right,
}: {
  title: string
  /** One line under the title: who this desktop is, what it is wearing, how far away it is. */
  sub?: string | null
  /** A small coloured dot before `sub`: the link, in one pixel. */
  dot?: 'ok' | 'warn' | 'off' | null
  /** The older shape, kept for the screens that have not been re-cut: drawn as `sub` with a dot. */
  status?: { label: string; tone: string } | null
  /** At most two `IconButton`s. */
  right?: React.ReactNode
}) {
  const p = usePalette()
  const tone = dot === 'warn' ? p.orange : dot === 'off' ? p.muted : p.green
  const line2 = sub ?? status?.label ?? null
  return (
    <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: space.sm + 2, minHeight: touch, paddingHorizontal: 2, marginBottom: space.xs }}>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Title>{title}</Title>
        {line2 ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.xs + 2, minWidth: 0 }}>
            {dot || status ? <StatusDot tone={status ? status.tone : tone} size={6} /> : null}
            <Label style={{ flexShrink: 1 }}>{line2}</Label>
          </View>
        ) : null}
      </View>
      {right ? <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.xs }}>{right}</View> : null}
    </View>
  )
}

/**
 * The panel everything on a screen sits in: glass over the wallpaper, or a
 * solid dark panel when Transparency is off. `tone` paints the border — an
 * orange card is an agent waiting — and `dim` is the "not possible here"
 * state, the whole card at 62%.
 */
export function Card({
  children,
  style,
  tone,
  dim,
}: {
  children: React.ReactNode
  style?: StyleProp<ViewStyle>
  tone?: string
  dim?: boolean
}) {
  const { card, edge } = useSurface()
  return (
    <View
      style={[
        {
          backgroundColor: card,
          borderColor: tone ? alpha(tone, 0.55) : edge,
          borderWidth: StyleSheet.hairlineWidth * 2,
          borderRadius: radius.md,
          padding: space.lg - 2,
          marginBottom: space.md,
          gap: space.sm + 2,
          opacity: dim ? 0.62 : 1,
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
/**
 * The top row of a card: an optional leading icon, the card's name at 14 bold,
 * one line of subtitle under it, and a slot on the right for a pill or an icon
 * button. Both text lines truncate rather than wrap — a header that wraps is a
 * header that pushes the card's content below the fold.
 *
 * `tone` is what the "not possible here" state is drawn with: pass
 * `palette.muted` and the whole header dims with it.
 */
export function CardHeader({
  icon,
  title,
  subtitle,
  tone,
  right,
  style,
}: {
  icon?: IconName | null
  title: string
  subtitle?: string | null
  tone?: string
  right?: React.ReactNode
  style?: StyleProp<ViewStyle>
}) {
  const p = usePalette()
  return (
    <View style={[{ flexDirection: 'row', alignItems: 'center', gap: space.sm + 2, minHeight: 24 }, style]}>
      {icon ? <Feather name={icon} size={20} color={tone ?? p.light_foreground} /> : null}
      <View style={{ flex: 1, minWidth: 0 }}>
        <Mono
          numberOfLines={1}
          style={{ color: tone ?? p.bright_foreground, fontFamily: font.bold, fontSize: size.cardTitle, lineHeight: line.cardTitle }}
        >
          {title}
        </Mono>
        {subtitle ? <Label style={tone ? { color: tone } : undefined}>{subtitle}</Label> : null}
      </View>
      {right ? <View style={{ flexShrink: 0 }}>{right}</View> : null}
    </View>
  )
}

/**
 * A caps heading inside a card, separating one group of rows from the next,
 * with an optional right-hand slot (a count, a small action).
 */
export function Section({ title, right, tone, style }: { title: string; right?: React.ReactNode; tone?: string; style?: StyleProp<ViewStyle> }) {
  return (
    <View style={[{ flexDirection: 'row', alignItems: 'center', gap: space.sm + 2, marginTop: space.xs }, style]}>
      <Caps tone={tone} style={{ flex: 1 }}>
        {title}
      </Caps>
      {right}
    </View>
  )
}

export function Divider({ style }: { style?: StyleProp<ViewStyle> }) {
  const { edge } = useSurface()
  return (
    <View
      style={[{ height: StyleSheet.hairlineWidth * 2, backgroundColor: edge, marginVertical: 2 }, style]}
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
    <View style={[{ flexDirection: 'row', alignItems: 'baseline', gap: space.md, minHeight: line.value }, style]}>
      <Label style={{ flex: 1 }}>{label}</Label>
      {typeof value === 'string' || typeof value === 'number' ? (
        <Value tone={tone} style={{ flexShrink: 1, textAlign: 'right' }}>
          {value}
        </Value>
      ) : (
        <View style={{ flexShrink: 1, alignItems: 'flex-end', alignSelf: 'center' }}>{value}</View>
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

export function Meter({
  fraction,
  tone,
  state,
  height = 4,
  style,
}: {
  fraction: number
  tone?: string
  /** The reading's meaning, when the screen would rather not name a colour. */
  state?: 'ok' | 'warn' | 'bad'
  height?: number
  style?: StyleProp<ViewStyle>
}) {
  const p = usePalette()
  const clamped = Math.max(0, Math.min(1, Number.isFinite(fraction) ? fraction : 0))
  const fill = tone ?? (state === 'bad' ? p.red : state === 'warn' ? p.orange : p.accent)
  return (
    <View style={[{ height, borderRadius: height / 2, backgroundColor: p.lighter_background, overflow: 'hidden' }, style]}>
      <View style={{ width: `${clamped * 100}%`, height: '100%', borderRadius: height / 2, backgroundColor: fill }} />
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

/**
 * A small outlined word: a state ("waiting"), a kind ("apk"), a count.
 *
 * `variant` is the mock's four: the default outline, `on` in the accent,
 * `warn` orange, `bad` red, and `solid` filled with the accent for the one
 * pill on a card that is the answer rather than a label. `tone` still wins
 * where a screen has a colour of its own.
 */
export function Pill({
  label,
  tone,
  icon,
  caps = true,
  variant = 'default',
}: {
  label: string
  tone?: string
  icon?: IconName
  /** `false` for a value with a unit — "22 ms" should not read "22 MS". */
  caps?: boolean
  variant?: 'default' | 'on' | 'warn' | 'bad' | 'solid'
}) {
  const p = usePalette()
  const { edge } = useSurface()
  const painted = variant === 'on' ? p.accent : variant === 'warn' ? p.orange : variant === 'bad' ? p.red : variant === 'solid' ? p.accent : null
  const colour = variant === 'solid' ? p.background : tone ?? painted ?? p.light_foreground
  const border = variant === 'solid' ? 'transparent' : tone ? alpha(tone, 0.6) : painted ? alpha(painted, variant === 'bad' ? 0.55 : 0.6) : edge
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: space.xs,
        paddingHorizontal: space.sm,
        paddingVertical: 3,
        borderRadius: radius.pill,
        borderWidth: StyleSheet.hairlineWidth * 2,
        borderColor: border,
        backgroundColor: variant === 'solid' ? p.accent : 'transparent',
      }}
    >
      {icon ? <Feather name={icon} size={12} color={colour} /> : null}
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
  /**
   * `primary` fills with the accent, `destructive` is red on nothing, `ghost`
   * has no fill of its own. `solid` and `danger` are the older names for the
   * first two and still work.
   */
  variant?: 'default' | 'primary' | 'destructive' | 'ghost' | 'solid' | 'danger'
  disabled?: boolean
  loading?: boolean
  /** A shorter button for a row of them inside a card. */
  compact?: boolean
  style?: StyleProp<ViewStyle>
}) {
  const p = usePalette()
  const { edge } = useSurface()
  const primary = variant === 'primary' || variant === 'solid'
  const destructive = variant === 'destructive' || variant === 'danger'
  const accent = primary ? p.background : destructive ? p.red : tone ?? p.foreground
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
          paddingHorizontal: compact ? space.md : space.lg,
          borderRadius: radius.ctl,
          borderWidth: StyleSheet.hairlineWidth * 2,
          borderColor: primary ? 'transparent' : destructive ? alpha(p.red, 0.5) : edge,
          backgroundColor: primary
            ? pressed
              ? alpha(tone ?? p.accent, 0.8)
              : tone ?? p.accent
            : destructive || variant === 'ghost'
              ? pressed
                ? p.selection
                : 'transparent'
              : pressed
                ? p.selection
                : alpha(p.lighter_background, 0.45),
          opacity: disabled ? 0.4 : 1,
        },
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator size="small" color={accent} />
      ) : icon ? (
        <Feather name={icon} size={compact ? 14 : 16} color={accent} />
      ) : null}
      {label ? (
        <Mono
          style={{ color: accent, fontFamily: font.medium, fontSize: compact ? size.label : size.body, lineHeight: compact ? line.label : line.body }}
          numberOfLines={1}
        >
          {label}
        </Mono>
      ) : null}
    </Pressable>
  )
}

/** A row of buttons across a card, each taking an equal share of the width. */
export function Buttons({ children, style }: { children: React.ReactNode; style?: StyleProp<ViewStyle> }) {
  return (
    <View style={[{ flexDirection: 'row', gap: space.sm }, style]}>
      {React.Children.map(children, (child) =>
        React.isValidElement(child) ? <View style={{ flex: 1 }}>{child}</View> : child,
      )}
    </View>
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
  const colour = tone ?? (active ? p.accent : p.light_foreground)
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
          borderRadius: radius.ctl,
          backgroundColor: active ? alpha(colour, pressed ? 0.3 : 0.18) : pressed ? p.selection : 'transparent',
          alignItems: 'center',
          justifyContent: 'center',
          opacity: disabled ? 0.4 : 1,
        },
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator size="small" color={colour} />
      ) : (
        <Feather name={icon} size={Math.round(box * 0.55)} color={colour} />
      )}
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
  const { edge } = useSurface()
  return (
    <View
      style={{
        flexDirection: 'row',
        borderRadius: radius.ctl,
        borderWidth: StyleSheet.hairlineWidth * 2,
        borderColor: edge,
        backgroundColor: alpha(p.darker_background, 0.5),
        overflow: 'hidden',
      }}
    >
      {options.map((option, index) => {
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
              minHeight: 36,
              paddingHorizontal: space.xs,
              borderLeftWidth: index === 0 ? 0 : StyleSheet.hairlineWidth * 2,
              borderLeftColor: edge,
              backgroundColor: active ? p.selection : pressed ? alpha(p.lighter_background, 0.5) : 'transparent',
              alignItems: 'center',
              justifyContent: 'center',
              opacity: disabled ? 0.4 : 1,
            })}
          >
            <Mono
              style={{
                color: active ? p.bright_foreground : p.light_foreground,
                fontFamily: active ? font.medium : font.regular,
                fontSize: size.label,
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
    <View style={{ alignItems: 'center', gap: space.xs + 2, paddingVertical: 18 }}>
      <Feather name={icon} size={28} color={p.muted} />
      <Body tone={p.muted} style={{ textAlign: 'center' }} numberOfLines={2}>
        {text}
      </Body>
      {action ? <Button label={action.label} icon={action.icon} onPress={action.onPress} compact style={{ marginTop: space.xs }} /> : null}
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
  const { edge } = useSurface()
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
          gap: space.sm + 2,
          borderRadius: radius.ctl,
          borderWidth: StyleSheet.hairlineWidth * 2,
          borderColor: alpha(colour, 0.5),
          backgroundColor: alpha(colour, 0.1),
          paddingVertical: space.sm + 2,
          paddingHorizontal: space.md,
          marginBottom: space.md,
        },
        style,
      ]}
    >
      <Feather name={name} size={16} color={colour} style={{ marginTop: 1 }} />
      <View style={{ flex: 1, minWidth: 0 }}>
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
  swatch,
  disabled,
}: {
  label: string
  active?: boolean
  onPress?: () => void
  onLongPress?: () => void
  tone?: string
  icon?: IconName
  /** A colour dot before the label — the accent of a theme in a row of themes. */
  swatch?: string | null
  disabled?: boolean
}) {
  const p = usePalette()
  const { edge } = useSurface()
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
        minHeight: 32,
        borderRadius: radius.sm,
        borderWidth: StyleSheet.hairlineWidth * 2,
        borderColor: active ? tone ?? p.accent : edge,
        backgroundColor: pressed ? p.selection : alpha(p.lighter_background, 0.35),
        minWidth: 40,
        justifyContent: 'center',
        opacity: disabled ? 0.4 : 1,
      })}
    >
      {swatch ? (
        <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: swatch, borderWidth: StyleSheet.hairlineWidth, borderColor: alpha('#000000', 0.25) }} />
      ) : null}
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
 * A row of chips that scrolls sideways, bleeding into the card's padding so
 * the first chip lines up with the text above it and the last one runs off
 * the edge rather than stopping short of it.
 *
 * It claims the horizontal gesture from the workspace pager: a drag that
 * starts on a chip row scrolls the row.
 */
export function ChipRow({ children, style }: { children: React.ReactNode; style?: StyleProp<ViewStyle> }) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
      style={[{ marginHorizontal: -(space.lg - 2), flexGrow: 0 }, style]}
      contentContainerStyle={{ flexDirection: 'row', gap: space.sm, paddingHorizontal: space.lg - 2 }}
    >
      {children}
    </ScrollView>
  )
}

/** Chips that wrap onto as many lines as they need — themes, skills, tags. */
export function Chips({ children, style }: { children: React.ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }, style]}>{children}</View>
}

/**
 * A labelled text box. Lived in the pairing screen until a second screen
 * needed one to take an address by hand.
 */
/**
 * One line of typing: a 44dp box with an optional leading icon, the text, and
 * an optional trailing slot — usually the send `IconButton` that finishes it.
 *
 * `label` is optional now. With one, the field keeps the caps label above it
 * that the pairing screen asks by hand; without, it is the mock's bare field —
 * a command, a message, a search.
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
  icon,
  right,
  multiline,
  style,
}: {
  label?: string
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
  /** A dim glyph before the text: a chevron for a command, an arrow for a send. */
  icon?: IconName
  right?: React.ReactNode
  multiline?: boolean
  style?: StyleProp<ViewStyle>
}) {
  const p = usePalette()
  const { edge } = useSurface()
  const [focused, setFocused] = React.useState(false)
  return (
    <View style={[{ marginBottom: label ? space.md : 0 }, style]}>
      {label ? <Caps style={{ marginBottom: space.xs + 2 }}>{label}</Caps> : null}
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: space.sm,
          minHeight: touch,
          paddingHorizontal: space.md,
          borderRadius: radius.ctl,
          borderWidth: StyleSheet.hairlineWidth * 2,
          borderColor: error ? p.red : focused ? p.accent : edge,
          backgroundColor: alpha(p.darker_background, 0.7),
        }}
      >
        {icon ? <Feather name={icon} size={16} color={p.light_foreground} /> : null}
        <TextInput
          value={value}
          onChangeText={onChange}
          placeholder={placeholder}
          placeholderTextColor={p.muted}
          keyboardType={keyboardType}
          maxLength={maxLength}
          autoFocus={autoFocus}
          secureTextEntry={secure}
          multiline={multiline}
          onSubmitEditing={onSubmit}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          autoCapitalize="none"
          autoCorrect={false}
          maxFontSizeMultiplier={MAX_FONT_SCALE}
          accessibilityLabel={label ?? placeholder}
          style={{
            flex: 1,
            minWidth: 0,
            paddingVertical: space.sm,
            color: p.bright_foreground,
            fontFamily: font.regular,
            fontSize: size.value,
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

/**
 * One thing in a list of things: a window, a file, a session, a permission.
 *
 * A row with an `onPress` bleeds out to the card's edge so the whole width
 * highlights under the thumb, and the highlight is the desktop's selection
 * colour rather than a fade. The rule under it is the card's edge, and the
 * last row of a list has none.
 */
export function ListRow({
  title,
  subtitle,
  right,
  left,
  icon,
  fill,
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
  /** The leading glyph. Dim by default; in the accent when `fill` says this row is the live one. */
  icon?: IconName
  fill?: boolean
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
  const { edge } = useSurface()
  const tappable = !!onPress || !!onLongPress
  const bleed = space.lg - 2
  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      disabled={!tappable}
      accessibilityRole={onPress ? 'button' : undefined}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: space.md,
        minHeight: 48,
        paddingVertical: space.xs,
        marginHorizontal: tappable ? -bleed : 0,
        paddingHorizontal: tappable ? bleed : 0,
        borderBottomWidth: last ? 0 : StyleSheet.hairlineWidth * 2,
        borderBottomColor: edge,
        backgroundColor: pressed && tappable ? alpha(p.selection, 0.7) : 'transparent',
      })}
    >
      {icon ? <Feather name={icon} size={20} color={fill ? p.accent : p.light_foreground} /> : null}
      {left}
      <View style={{ flex: 1, minWidth: 0 }}>
        <Mono
          style={{ color: tone ?? (fill ? p.accent : p.bright_foreground), fontFamily: font.regular, fontSize: size.value, lineHeight: line.value }}
          numberOfLines={lines}
        >
          {title}
        </Mono>
        {subtitle ? (
          <Mono style={{ color: p.light_foreground, fontFamily: font.regular, fontSize: size.label, lineHeight: line.label }} numberOfLines={1}>
            {subtitle}
          </Mono>
        ) : null}
      </View>
      {right}
      {chevron ? <Feather name="chevron-right" size={16} color={p.muted} /> : null}
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
  /** Kept for the screens that pass it; the mock's toggles carry no rule of their own. */
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
        gap: space.md,
        minHeight: touch,
        paddingVertical: 2,
        opacity: disabled ? 0.55 : pressed ? 0.7 : 1,
      })}
    >
      <View style={{ flex: 1, minWidth: 0 }}>
        <Mono style={{ color: p.bright_foreground, fontFamily: font.regular, fontSize: size.value, lineHeight: line.value }} numberOfLines={1}>
          {label}
        </Mono>
        {hint ? (
          <Mono style={{ color: p.muted, fontFamily: font.regular, fontSize: size.label, lineHeight: line.label }} numberOfLines={2}>
            {hint}
          </Mono>
        ) : null}
      </View>
      <View
        style={{
          width: 38,
          height: 22,
          borderRadius: 11,
          padding: 3,
          backgroundColor: value ? on : p.lighter_background,
          alignItems: value ? 'flex-end' : 'flex-start',
          justifyContent: 'center',
        }}
      >
        <View style={{ width: 16, height: 16, borderRadius: 8, backgroundColor: value ? p.background : p.light_foreground }} />
      </View>
    </Pressable>
  )
}

/* ── tiles, code, sparkline ──────────────────────────────────────────── */

/** The two-column grid the desktop's toggles sit in. */
export function Tiles({ children, style }: { children: React.ReactNode; style?: StyleProp<ViewStyle> }) {
  return (
    <View style={[{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }, style]}>
      {React.Children.map(children, (child) =>
        React.isValidElement(child) ? <View style={{ flexBasis: '48%', flexGrow: 1 }}>{child}</View> : child,
      )}
    </View>
  )
}

/**
 * A square-ish button with a state under its name — nightlight, stay awake,
 * notification silencing. On, it fills with the accent; off, it is an outline.
 * The state word is the caps line, so the tile says what it *is*, not what
 * tapping it would do.
 */
export function Tile({
  icon,
  label,
  state,
  on,
  onPress,
  disabled,
  tone,
}: {
  icon: IconName
  label: string
  /** The caps line under the label: "on", "off", "armed". */
  state?: string | null
  on?: boolean
  onPress?: () => void
  disabled?: boolean
  tone?: string
}) {
  const p = usePalette()
  const { edge } = useSurface()
  const accent = tone ?? p.accent
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || !onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: !!on, disabled: !!disabled }}
      style={({ pressed }) => ({
        minHeight: 64,
        borderRadius: radius.ctl,
        borderWidth: StyleSheet.hairlineWidth * 2,
        borderColor: on ? alpha(accent, 0.55) : edge,
        backgroundColor: on ? alpha(accent, 0.16) : pressed ? p.selection : alpha(p.lighter_background, 0.3),
        paddingVertical: space.sm + 2,
        paddingHorizontal: space.md,
        justifyContent: 'space-between',
        gap: space.xs + 2,
        opacity: disabled ? 0.55 : 1,
      })}
    >
      <Feather name={icon} size={20} color={on ? p.bright_foreground : p.light_foreground} />
      <View>
        <Mono
          numberOfLines={1}
          style={{ color: on ? p.bright_foreground : p.foreground, fontFamily: font.regular, fontSize: size.label, lineHeight: line.label }}
        >
          {label}
        </Mono>
        {state ? <Caps tone={on ? accent : p.muted}>{state}</Caps> : null}
      </View>
    </Pressable>
  )
}

/** A command, a path, a clipboard: something the desktop said, verbatim. */
export function Code({ children, style, lines }: { children: React.ReactNode; style?: StyleProp<ViewStyle>; lines?: number }) {
  const p = usePalette()
  return (
    <View style={[{ backgroundColor: alpha(p.darker_background, 0.7), borderRadius: 6, paddingVertical: 6, paddingHorizontal: space.sm }, style]}>
      <Mono
        numberOfLines={lines}
        selectable
        style={{ color: p.bright_foreground, fontFamily: font.regular, fontSize: size.label, lineHeight: 18 }}
      >
        {children}
      </Mono>
    </View>
  )
}

/**
 * The shape of the last minute, beside the number it ends on.
 *
 * React Native draws no lines without a canvas, and a canvas is a native
 * dependency this app is not taking on for one card. So the line is 40 thin
 * bars, each as tall as its sample, at a low alpha with a bright cap: from
 * arm's length it reads as the filled area the mock draws, and it costs
 * nothing per frame that a row of `View`s does not already cost.
 */
export function Sparkline({
  data,
  tone,
  height = 36,
  max = 100,
  style,
}: {
  /** Oldest first, 0–`max`. Fewer than two samples draws nothing. */
  data: number[]
  tone?: string
  height?: number
  max?: number
  style?: StyleProp<ViewStyle>
}) {
  const p = usePalette()
  const colour = tone ?? p.accent
  const bars = 40
  const samples = React.useMemo(() => {
    if (data.length <= bars) return data
    return data.slice(data.length - bars)
  }, [data])
  if (samples.length < 2) return <View style={[{ height }, style]} />
  return (
    <View style={[{ height, flexDirection: 'row', alignItems: 'flex-end', gap: 1 }, style]} accessibilityRole="image" accessibilityLabel="Recent load">
      {samples.map((value, i) => {
        const fraction = Math.max(0, Math.min(1, (Number.isFinite(value) ? value : 0) / max))
        const tall = Math.max(2, Math.round(fraction * (height - 3)))
        const last = i === samples.length - 1
        return (
          <View key={i} style={{ flex: 1, height: tall, backgroundColor: alpha(colour, last ? 1 : 0.22), borderTopWidth: 1.5, borderTopColor: colour }} />
        )
      })}
    </View>
  )
}

/* ── the wallpaper ───────────────────────────────────────────────────── */

const BLOBS: { key: 'accent' | 'blue' | 'magenta' | 'cyan'; x: number; y: number; r: number; drift: number }[] = [
  { key: 'accent', x: 0.42, y: 0.2, r: 0.95, drift: 26 },
  { key: 'blue', x: 0.78, y: 0.55, r: 1.15, drift: -34 },
  { key: 'magenta', x: 0.16, y: 0.78, r: 0.8, drift: 30 },
  { key: 'cyan', x: 0.88, y: 0.1, r: 0.75, drift: -22 },
]

/**
 * What the cards float over.
 *
 * `aurora` is four very soft lights in the theme's own colours — each one a
 * stack of circles whose alpha falls off outward, because a phone with no
 * blur and no gradients still has to make a round glow — drifting slowly on
 * the native driver so the JS thread never sees a frame. `dots` is a static
 * grid, `none` is the background and nothing else. Reduce-motion and a
 * backgrounded app both stop the drift.
 */
export function Wallpaper({ kind }: { kind?: 'aurora' | 'dots' | 'none' }) {
  const p = usePalette()
  const look = useLook()
  const which = kind ?? (look.transparency ? look.wallpaper : 'none')
  const { width, height } = useWindowDimensions()
  const drift = React.useRef(new Animated.Value(0)).current
  const [moving, setMoving] = React.useState(true)

  React.useEffect(() => {
    let alive = true
    AccessibilityInfo.isReduceMotionEnabled().then((reduce) => {
      if (alive) setMoving(!reduce)
    })
    const sub = AppState.addEventListener('change', (state) => setMoving(state === 'active'))
    return () => {
      alive = false
      sub.remove()
    }
  }, [])

  React.useEffect(() => {
    if (which !== 'aurora' || !moving) return
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(drift, { toValue: 1, duration: 24000, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
        Animated.timing(drift, { toValue: 0, duration: 24000, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
      ]),
    )
    loop.start()
    return () => loop.stop()
  }, [which, moving, drift])

  if (which === 'none') {
    return <View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: p.background }]} />
  }

  if (which === 'dots') {
    const step = 26
    const cols = Math.ceil(width / step)
    const rows = Math.ceil(height / step)
    return (
      <View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: p.background, overflow: 'hidden' }]}>
        {Array.from({ length: rows }, (_, r) => (
          <View key={r} style={{ flexDirection: 'row', height: step }}>
            {Array.from({ length: cols }, (_, c) => (
              <View key={c} style={{ width: step, alignItems: 'center', justifyContent: 'center' }}>
                <View
                  style={{
                    width: 2,
                    height: 2,
                    borderRadius: 1,
                    backgroundColor: alpha((r + c) % 9 === 0 ? p.accent : p.foreground, 0.16),
                  }}
                />
              </View>
            ))}
          </View>
        ))}
      </View>
    )
  }

  return (
    <View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: p.background, overflow: 'hidden' }]}>
      {BLOBS.map((blob) => {
        const radius0 = blob.r * width
        const move = drift.interpolate({ inputRange: [0, 1], outputRange: [-blob.drift, blob.drift] })
        return (
          <Animated.View
            key={blob.key}
            style={{
              position: 'absolute',
              left: blob.x * width - radius0,
              top: blob.y * height - radius0,
              width: radius0 * 2,
              height: radius0 * 2,
              alignItems: 'center',
              justifyContent: 'center',
              transform: [{ translateX: move }, { translateY: Animated.multiply(move, 0.6) }],
            }}
          >
            {[1, 0.78, 0.58, 0.4, 0.24, 0.12].map((ring) => (
              <View
                key={ring}
                style={{
                  position: 'absolute',
                  width: radius0 * 2 * ring,
                  height: radius0 * 2 * ring,
                  borderRadius: radius0 * ring,
                  backgroundColor: alpha(p[blob.key], p.mode === 'light' ? 0.035 : 0.045),
                }}
              />
            ))}
          </Animated.View>
        )
      })}
      {/* The shade: the mock darkens the top and the bottom of the wallpaper so
          a card's edge never fights a light. One flat wash is enough here. */}
      <View style={[StyleSheet.absoluteFill, { backgroundColor: alpha(p.background, 0.45) }]} />
    </View>
  )
}

/* ── toast and confirm ───────────────────────────────────────────────── */

export type ToastRequest = { value: string; hint?: string | null; icon?: IconName }
export type ConfirmRequest = {
  /** The verb, as a question: "Shut down the desktop?" */
  title: string
  /** What will actually run, or what will be lost. */
  detail?: string | null
  /** The destructive button's label. Defaults to "Yes". */
  confirmLabel?: string
  cancelLabel?: string
}

type Feedback = {
  toast: (request: ToastRequest | string) => void
  confirm: (request: ConfirmRequest) => Promise<boolean>
}

const FeedbackContext = React.createContext<Feedback>({
  toast: () => {},
  confirm: async () => false,
})

/**
 * Every command the phone sends the desktop says so, and every destructive one
 * asks first.
 *
 * The toast is the mock's: the command as the value, what happened under it,
 * 2.4 seconds, one at a time — a second one replaces the first rather than
 * stacking. The confirm is a card floating over a scrim above the bar, and it
 * answers a promise, so a screen writes `if (await confirm({...}))` where it
 * used to reach for `Alert.alert`.
 */
export function FeedbackProvider({ children }: { children: React.ReactNode }) {
  const p = usePalette()
  const { edge } = useSurface()
  const insets = useSafeAreaInsets()
  const [note, setNote] = React.useState<ToastRequest | null>(null)
  const [ask, setAsk] = React.useState<(ConfirmRequest & { answer: (yes: boolean) => void }) | null>(null)
  const rise = React.useRef(new Animated.Value(0)).current
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null)

  const value = React.useMemo<Feedback>(
    () => ({
      toast: (request) => {
        setNote(typeof request === 'string' ? { value: request } : request)
      },
      confirm: (request) =>
        new Promise<boolean>((resolve) => {
          setAsk({ ...request, answer: resolve })
        }),
    }),
    [],
  )

  React.useEffect(() => {
    if (!note) return
    Animated.timing(rise, { toValue: 1, duration: 250, easing: Easing.out(Easing.quad), useNativeDriver: true }).start()
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      Animated.timing(rise, { toValue: 0, duration: 250, useNativeDriver: true }).start(() => setNote(null))
    }, 2400)
    return () => {
      if (timer.current) clearTimeout(timer.current)
    }
  }, [note, rise])

  const answer = (yes: boolean) => {
    ask?.answer(yes)
    setAsk(null)
  }

  return (
    <FeedbackContext.Provider value={value}>
      <View style={{ flex: 1 }}>
        {children}
        {note ? (
          <Animated.View
            pointerEvents="none"
            accessibilityLiveRegion="polite"
            style={{
              position: 'absolute',
              left: space.lg - 2,
              right: space.lg - 2,
              bottom: 76 + insets.bottom,
              flexDirection: 'row',
              alignItems: 'center',
              gap: space.sm + 2,
              borderRadius: radius.ctl,
              borderWidth: StyleSheet.hairlineWidth * 2,
              borderColor: p.lighter_background,
              backgroundColor: alpha(p.darker_background, 0.94),
              paddingVertical: space.sm + 2,
              paddingHorizontal: space.md,
              opacity: rise,
              transform: [{ translateY: rise.interpolate({ inputRange: [0, 1], outputRange: [16, 0] }) }],
            }}
          >
            <Feather name={note.icon ?? 'play'} size={16} color={p.accent} />
            <View style={{ flex: 1, minWidth: 0 }}>
              <Mono numberOfLines={1} style={{ color: p.bright_foreground, fontFamily: font.regular, fontSize: size.label, lineHeight: line.label }}>
                {note.value}
              </Mono>
              {note.hint ? <Hint>{note.hint}</Hint> : null}
            </View>
          </Animated.View>
        ) : null}
        {ask ? (
          <>
            <Pressable
              accessibilityLabel="Cancel"
              onPress={() => answer(false)}
              style={[StyleSheet.absoluteFill, { backgroundColor: alpha(p.darker_background, 0.55) }]}
            />
            <View
              accessibilityViewIsModal
              accessibilityRole="alert"
              style={{
                position: 'absolute',
                left: space.md,
                right: space.md,
                bottom: 84 + insets.bottom,
                borderRadius: radius.md,
                borderWidth: StyleSheet.hairlineWidth * 2,
                borderColor: edge,
                backgroundColor: p.dark_background,
                padding: space.lg - 2,
                gap: space.sm + 2,
              }}
            >
              {/* The icon is the warning, not the words: the title stays bright so it is read first. */}
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm + 2 }}>
                <Feather name="alert-triangle" size={20} color={p.orange} />
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Mono numberOfLines={2} style={{ color: p.bright_foreground, fontFamily: font.bold, fontSize: size.cardTitle, lineHeight: line.cardTitle }}>
                    {ask.title}
                  </Mono>
                  {ask.detail ? <Label numberOfLines={2}>{ask.detail}</Label> : null}
                </View>
              </View>
              <Buttons>
                <Button label={ask.cancelLabel ?? 'Cancel'} compact onPress={() => answer(false)} />
                <Button label={ask.confirmLabel ?? 'Yes'} compact variant="destructive" onPress={() => answer(true)} />
              </Buttons>
            </View>
          </>
        ) : null}
      </View>
    </FeedbackContext.Provider>
  )
}

/** Say what was just sent to the desktop. One line, 2.4 seconds, no buttons. */
export function useToast() {
  return React.useContext(FeedbackContext).toast
}

/** Ask before something that cannot be taken back. Replaces `Alert.alert`. */
export function useConfirm() {
  return React.useContext(FeedbackContext).confirm
}
