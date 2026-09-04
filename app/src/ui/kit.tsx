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
  type TextStyle,
  type ViewStyle,
} from 'react-native'
import { Feather } from '@expo/vector-icons'
import * as Clipboard from 'expo-clipboard'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { alpha, font, radius, size, space, type Palette } from '../theme'
import { usePalette } from '../state/ConnectionContext'
import { problem } from '../lib/errors'

/* ── text ────────────────────────────────────────────────────────────── */

export function Label({ children, style }: { children: React.ReactNode; style?: StyleProp<TextStyle> }) {
  const p = usePalette()
  return (
    <Text style={[{ color: p.muted, fontFamily: font.regular, fontSize: size.label }, style]} numberOfLines={1}>
      {children}
    </Text>
  )
}

export function Caps({ children, style, tone }: { children: React.ReactNode; style?: StyleProp<TextStyle>; tone?: string }) {
  const p = usePalette()
  return (
    <Text
      style={[
        {
          color: tone ?? p.muted,
          fontFamily: font.medium,
          fontSize: size.micro,
          letterSpacing: 1.6,
          textTransform: 'uppercase',
        },
        style,
      ]}
    >
      {children}
    </Text>
  )
}

export function Value({
  children,
  tone,
  style,
}: {
  children: React.ReactNode
  tone?: string
  style?: StyleProp<TextStyle>
}) {
  const p = usePalette()
  return (
    <Text
      style={[{ color: tone ?? p.light_foreground, fontFamily: font.regular, fontSize: size.value }, style]}
      numberOfLines={1}
    >
      {children}
    </Text>
  )
}

export function Title({ children, style }: { children: React.ReactNode; style?: StyleProp<TextStyle> }) {
  const p = usePalette()
  return (
    <Text
      style={[{ color: p.bright_foreground, fontFamily: font.bold, fontSize: size.title }, style]}
      numberOfLines={1}
    >
      {children}
    </Text>
  )
}

export function Body({ children, tone, style }: { children: React.ReactNode; tone?: string; style?: StyleProp<TextStyle> }) {
  const p = usePalette()
  return (
    <Text style={[{ color: tone ?? p.foreground, fontFamily: font.regular, fontSize: size.body, lineHeight: 21 }, style]}>
      {children}
    </Text>
  )
}

/* ── containers ──────────────────────────────────────────────────────── */

export function Screen({
  children,
  scroll = true,
  refreshControl,
}: {
  children: React.ReactNode
  scroll?: boolean
  refreshControl?: React.ReactElement<any>
}) {
  const p = usePalette()
  const insets = useSafeAreaInsets()
  const padding = { paddingTop: insets.top + space.md, paddingHorizontal: space.lg, paddingBottom: space.xxl * 2 }
  if (!scroll) {
    return <View style={[{ flex: 1, backgroundColor: p.background }, padding]}>{children}</View>
  }
  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: p.background }}
      contentContainerStyle={padding}
      keyboardShouldPersistTaps="handled"
      refreshControl={refreshControl}
    >
      {children}
    </ScrollView>
  )
}

export function Card({ children, style }: { children: React.ReactNode; style?: StyleProp<ViewStyle> }) {
  const p = usePalette()
  return (
    <View
      style={[
        {
          backgroundColor: p.dark_background,
          borderColor: p.lighter_background,
          borderWidth: StyleSheet.hairlineWidth * 2,
          borderRadius: radius.md,
          padding: space.lg,
          marginBottom: space.md,
        },
        style,
      ]}
    >
      {children}
    </View>
  )
}

export function IconBox({ name, tone }: { name: React.ComponentProps<typeof Feather>['name']; tone?: string }) {
  const p = usePalette()
  return (
    <View
      style={{
        width: 38,
        height: 38,
        borderRadius: radius.sm,
        borderWidth: StyleSheet.hairlineWidth * 2,
        borderColor: p.lighter_background,
        backgroundColor: p.darker_background,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Feather name={name} size={18} color={tone ?? p.bright_foreground} />
    </View>
  )
}

export function CardHeader({
  icon,
  title,
  subtitle,
  tone,
  right,
}: {
  icon: React.ComponentProps<typeof Feather>['name']
  title: string
  subtitle?: string
  tone?: string
  right?: React.ReactNode
}) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: space.lg }}>
      <IconBox name={icon} tone={tone} />
      <View style={{ flex: 1, marginLeft: space.md }}>
        <Title>{title}</Title>
        {subtitle ? <Caps style={{ marginTop: 3 }}>{subtitle}</Caps> : null}
      </View>
      {right}
    </View>
  )
}

export function Divider({ style }: { style?: StyleProp<ViewStyle> }) {
  const p = usePalette()
  return (
    <View
      style={[{ height: StyleSheet.hairlineWidth * 2, backgroundColor: p.lighter_background, marginVertical: space.lg }, style]}
    />
  )
}

/* ── data display ────────────────────────────────────────────────────── */

export type Pair = { label: string; value: React.ReactNode; tone?: string }

/**
 * The two-column readout from the Omarchy status cards: dim label on the
 * left, bright value hard against the right edge of its column.
 */
export function DataGrid({ pairs, columns = 2 }: { pairs: Pair[]; columns?: 1 | 2 }) {
  const rows: Pair[][] = []
  for (let i = 0; i < pairs.length; i += columns) rows.push(pairs.slice(i, i + columns))
  return (
    <View>
      {rows.map((row, i) => (
        <View key={i} style={{ flexDirection: 'row', marginBottom: space.sm }}>
          {row.map((pair, j) => (
            <View
              key={pair.label}
              style={{
                flex: 1,
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'space-between',
                marginRight: j === 0 && columns === 2 ? space.lg : 0,
              }}
            >
              <Label>{pair.label}</Label>
              <Value tone={pair.tone} style={{ marginLeft: space.sm, flexShrink: 1 }}>
                {pair.value}
              </Value>
            </View>
          ))}
          {row.length < columns ? <View style={{ flex: 1, marginLeft: space.lg }} /> : null}
        </View>
      ))}
    </View>
  )
}

export function Meter({ fraction, tone, height = 4 }: { fraction: number; tone?: string; height?: number }) {
  const p = usePalette()
  const clamped = Math.max(0, Math.min(1, Number.isFinite(fraction) ? fraction : 0))
  return (
    <View style={{ height, borderRadius: height / 2, backgroundColor: p.lighter_background, overflow: 'hidden' }}>
      <View style={{ width: `${clamped * 100}%`, height: '100%', backgroundColor: tone ?? p.accent }} />
    </View>
  )
}

export function StatusDot({ tone, pulse }: { tone: string; pulse?: boolean }) {
  return (
    <View
      style={{
        width: 8,
        height: 8,
        borderRadius: 4,
        backgroundColor: tone,
        opacity: pulse ? 0.7 : 1,
      }}
    />
  )
}

/* ── controls ────────────────────────────────────────────────────────── */

export function Button({
  label,
  icon,
  onPress,
  tone,
  variant = 'default',
  disabled,
  loading,
  style,
}: {
  label?: string
  icon?: React.ComponentProps<typeof Feather>['name']
  onPress?: () => void
  tone?: string
  variant?: 'default' | 'solid' | 'ghost' | 'danger'
  disabled?: boolean
  loading?: boolean
  style?: StyleProp<ViewStyle>
}) {
  const p = usePalette()
  const accent = variant === 'danger' ? p.red : tone ?? p.foreground
  const solid = variant === 'solid'
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || loading}
      style={({ pressed }) => [
        {
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'center',
          gap: space.sm,
          paddingVertical: space.md,
          paddingHorizontal: space.lg,
          borderRadius: radius.sm,
          borderWidth: variant === 'ghost' ? 0 : StyleSheet.hairlineWidth * 2,
          borderColor: solid ? accent : p.lighter_background,
          backgroundColor: solid ? alpha(accent, 0.18) : pressed ? p.selection : p.darker_background,
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
        <Text style={{ color: accent, fontFamily: font.medium, fontSize: size.body }} numberOfLines={1}>
          {label}
        </Text>
      ) : null}
    </Pressable>
  )
}

/**
 * The DNS-provider row from the Omarchy card: equal-width bordered boxes,
 * the active one filled.
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
            style={({ pressed }) => ({
              flex: 1,
              paddingVertical: space.md,
              borderRadius: radius.sm,
              borderWidth: StyleSheet.hairlineWidth * 2,
              borderColor: active ? p.foreground : p.lighter_background,
              backgroundColor: active ? p.selection : pressed ? p.lighter_background : p.darker_background,
              alignItems: 'center',
              opacity: disabled ? 0.4 : 1,
            })}
          >
            <Text
              style={{
                color: active ? p.bright_foreground : p.foreground,
                fontFamily: active ? font.medium : font.regular,
                fontSize: size.body,
              }}
              numberOfLines={1}
            >
              {option.label}
            </Text>
          </Pressable>
        )
      })}
    </View>
  )
}

export function Empty({ icon, text }: { icon: React.ComponentProps<typeof Feather>['name']; text: string }) {
  const p = usePalette()
  return (
    <View style={{ alignItems: 'center', paddingVertical: space.xxl }}>
      <Feather name={icon} size={22} color={p.muted} />
      <Body tone={p.muted} style={{ marginTop: space.md, textAlign: 'center' }}>
        {text}
      </Body>
    </View>
  )
}

/**
 * Something went wrong, said in one line.
 *
 * Every screen used to render its own failure as a bare red `Body` — nine
 * `useState<string | null>` across seven screens, each with slightly different
 * padding, each showing whatever message a cast to `Error` happened to find.
 * When
 * the throw came from the native side that was a Java stack trace, drawn onto
 * the screen until it had pushed the rest of the app off it.
 *
 * This is the one surface for all of them. It takes the thrown value itself —
 * not a string a caller squeezed out of it — normalises it through
 * `lib/errors`, and shows the sentence. The rest of the trace is not thrown
 * away: when there is more to read, the notice says so, and a tap opens it in
 * a box of its own that scrolls rather than grows. Long-press copies the lot,
 * because the place a stack trace belongs is a bug report.
 *
 * `tone` carries the meaning: `error` red, `warning` orange, `ok` green for
 * the "it worked" note that lived beside the red one on the share screen.
 */
export function Notice({
  error,
  tone = 'error',
  icon,
  onDismiss,
  style,
}: {
  error: unknown
  tone?: 'error' | 'warning' | 'ok'
  icon?: React.ComponentProps<typeof Feather>['name']
  onDismiss?: () => void
  style?: StyleProp<ViewStyle>
}) {
  const p = usePalette()
  const [open, setOpen] = React.useState(false)
  const [copied, setCopied] = React.useState(false)

  // Nothing to say is not a notice. Screens hold `null` when all is well and
  // render this unconditionally, so the empty case has to be silent.
  if (error == null || (typeof error === 'string' && !error.trim())) return null

  const { message, detail } = problem(error)
  const colour = tone === 'ok' ? p.green : tone === 'warning' ? p.orange : p.red
  const name = icon ?? (tone === 'ok' ? 'check-circle' : tone === 'warning' ? 'alert-triangle' : 'alert-circle')

  const copy = () => {
    void Clipboard.setStringAsync(detail || message)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <View
      style={[
        {
          flexDirection: 'row',
          alignItems: 'flex-start',
          borderRadius: radius.sm,
          borderLeftWidth: 2,
          borderLeftColor: colour,
          backgroundColor: alpha(colour, 0.1),
          paddingVertical: space.md,
          paddingHorizontal: space.md,
          marginBottom: space.md,
        },
        style,
      ]}
    >
      <Feather name={name} size={15} color={colour} style={{ marginTop: 2 }} />
      <Pressable
        onPress={() => detail && setOpen((was) => !was)}
        onLongPress={copy}
        style={{ flex: 1, marginLeft: space.sm }}
      >
        <Text
          style={{ color: colour, fontFamily: font.regular, fontSize: size.label, lineHeight: 19 }}
          numberOfLines={open ? undefined : 3}
        >
          {message}
        </Text>
        {detail ? (
          <Text style={{ color: p.muted, fontFamily: font.regular, fontSize: size.micro, marginTop: space.xs }}>
            {copied ? 'copied' : open ? 'tap to hide · long-press to copy' : 'tap for details'}
          </Text>
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
            <Text selectable style={{ color: p.light_foreground, fontFamily: font.regular, fontSize: size.micro }}>
              {detail}
            </Text>
          </ScrollView>
        ) : null}
      </Pressable>
      {onDismiss ? (
        <Pressable onPress={onDismiss} hitSlop={10} style={{ marginLeft: space.sm }}>
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
      style={{
        height: 34,
        justifyContent: 'center',
        opacity: disabled ? 0.4 : 1,
      }}
    >
      <View
        style={{
          height: 10,
          borderRadius: radius.sm,
          backgroundColor: p.darker_background,
          borderWidth: StyleSheet.hairlineWidth * 2,
          borderColor: p.lighter_background,
          overflow: 'hidden',
        }}
      >
        <View style={{ width: `${clamped}%`, height: '100%', backgroundColor: tone ?? p.accent }} />
      </View>
    </View>
  )
}

export function Chip({
  label,
  active,
  onPress,
  tone,
}: {
  label: string
  active?: boolean
  onPress?: () => void
  tone?: string
}) {
  const p = usePalette()
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => ({
        paddingHorizontal: space.md,
        paddingVertical: space.sm,
        borderRadius: radius.sm,
        borderWidth: StyleSheet.hairlineWidth * 2,
        borderColor: active ? tone ?? p.foreground : p.lighter_background,
        backgroundColor: active ? p.selection : pressed ? p.lighter_background : p.darker_background,
        minWidth: 42,
        alignItems: 'center',
      })}
    >
      <Text
        style={{
          color: active ? p.bright_foreground : p.foreground,
          fontFamily: active ? font.medium : font.regular,
          fontSize: size.body,
        }}
      >
        {label}
      </Text>
    </Pressable>
  )
}

/**
 * A labelled text box.
 *
 * Lived in the pairing screen until a second screen needed one to take an
 * address by hand. Nothing about it was ever specific to pairing.
 */
export function Field({
  label,
  value,
  onChange,
  placeholder,
  keyboardType,
  maxLength,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  placeholder?: string
  keyboardType?: 'default' | 'number-pad' | 'numbers-and-punctuation'
  maxLength?: number
}) {
  const p = usePalette()
  return (
    <View style={{ marginBottom: space.md }}>
      <Caps style={{ marginBottom: space.xs }}>{label}</Caps>
      <TextInput
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        placeholderTextColor={p.muted}
        keyboardType={keyboardType}
        maxLength={maxLength}
        autoCapitalize="none"
        autoCorrect={false}
        style={{
          color: p.light_foreground,
          fontFamily: font.regular,
          fontSize: size.body,
          backgroundColor: p.darker_background,
          borderColor: p.lighter_background,
          borderWidth: 1,
          borderRadius: radius.sm,
          paddingHorizontal: space.md,
          paddingVertical: space.md,
        }}
      />
    </View>
  )
}

export function ListRow({
  title,
  subtitle,
  right,
  onPress,
  tone,
}: {
  title: string
  subtitle?: string
  right?: React.ReactNode
  onPress?: () => void
  tone?: string
}) {
  const p = usePalette()
  return (
    <Pressable
      onPress={onPress}
      disabled={!onPress}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        paddingVertical: space.md,
        opacity: pressed ? 0.6 : 1,
      })}
    >
      <View style={{ flex: 1, marginRight: space.md }}>
        <Text style={{ color: tone ?? p.light_foreground, fontFamily: font.regular, fontSize: size.body }} numberOfLines={1}>
          {title}
        </Text>
        {subtitle ? (
          <Text style={{ color: p.muted, fontFamily: font.regular, fontSize: size.label, marginTop: 2 }} numberOfLines={2}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      {right}
    </Pressable>
  )
}
