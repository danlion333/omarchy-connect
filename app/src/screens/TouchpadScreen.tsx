import React, { useCallback, useMemo, useRef, useState } from 'react'
import { PanResponder, Pressable, StyleSheet, TextInput, View } from 'react-native'
import { Feather } from '@expo/vector-icons'
import * as Haptics from 'expo-haptics'

import { useConnection } from '../state/ConnectionContext'
import { Body, Caps, Card, CardHeader, Empty, Screen } from '../ui/kit'
import { font, radius, size, space } from '../theme'

/** Deltas are batched to this cadence; one request is ever in flight. */
const FLUSH_MS = 22
const TAP_MS = 220
const TAP_SLOP = 8
const SCROLL_DIVISOR = 18

const KEYS: { label: string; key: string; mods?: string; icon?: React.ComponentProps<typeof Feather>['name'] }[] = [
  { label: 'esc', key: 'Escape' },
  { label: 'tab', key: 'Tab' },
  { label: '⌫', key: 'BackSpace' },
  { label: '↵', key: 'Return' },
  { label: 'super', key: 'Super_L' },
  { label: '←', key: 'Left' },
  { label: '↑', key: 'Up' },
  { label: '↓', key: 'Down' },
  { label: '→', key: 'Right' },
]

export function TouchpadScreen() {
  const { call, palette, can, hello } = useConnection()
  const [typing, setTyping] = useState('')
  const [note, setNote] = useState<string | null>(null)

  const pending = useRef({ dx: 0, dy: 0 })
  const inFlight = useRef(false)
  const timer = useRef<ReturnType<typeof setInterval> | null>(null)
  // `seen` is the gesture's cumulative offset at the previous move event:
  // PanResponder reports totals since the touch began, and a touchpad needs
  // the step between events.
  const gesture = useRef({ startedAt: 0, fingers: 1, scrollRest: 0, seen: { dx: 0, dy: 0 } })

  const supported = can('input', 'pointer')
  const scrollMode = (hello?.capabilities?.input as { scrollMode?: string } | undefined)?.scrollMode

  /**
   * The pad produces deltas far faster than the desktop can answer, so they
   * are accumulated and shipped one request at a time. Waiting for each reply
   * before sending the next is the backpressure — without it a slow link turns
   * into a queue of stale movements and the pointer swims.
   */
  const flush = useCallback(() => {
    if (inFlight.current) return
    const { dx, dy } = pending.current
    if (!dx && !dy) return
    pending.current = { dx: 0, dy: 0 }
    inFlight.current = true
    call('input.move', { dx, dy })
      .catch(() => {})
      .finally(() => {
        inFlight.current = false
      })
  }, [call])

  const startFlushing = useCallback(() => {
    if (timer.current) return
    timer.current = setInterval(flush, FLUSH_MS)
  }, [flush])

  const stopFlushing = useCallback(() => {
    if (!timer.current) return
    clearInterval(timer.current)
    timer.current = null
    flush()
  }, [flush])

  const tapped = useCallback(
    (button: 'left' | 'right') => {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {})
      call('input.click', { button }).catch((err: Error) => setNote(err.message))
    },
    [call],
  )

  const responder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        // Capture, so the surrounding ScrollView never gets to interpret a
        // drag on the pad as a scroll of the page.
        onStartShouldSetPanResponderCapture: () => true,
        onMoveShouldSetPanResponderCapture: () => true,
        onPanResponderTerminationRequest: () => false,
        onPanResponderGrant: (evt) => {
          gesture.current = {
            startedAt: Date.now(),
            fingers: evt.nativeEvent.touches.length,
            scrollRest: 0,
            seen: { dx: 0, dy: 0 },
          }
          startFlushing()
        },
        onPanResponderMove: (evt, state) => {
          const fingers = evt.nativeEvent.touches.length
          gesture.current.fingers = Math.max(gesture.current.fingers, fingers)

          const stepX = state.dx - gesture.current.seen.dx
          const stepY = state.dy - gesture.current.seen.dy
          gesture.current.seen = { dx: state.dx, dy: state.dy }

          if (fingers >= 2) {
            // Two fingers scroll. Whole notches only, with the remainder kept
            // so slow drags still add up to a scroll instead of vanishing.
            const total = gesture.current.scrollRest + stepY / SCROLL_DIVISOR
            const notches = Math.trunc(total)
            gesture.current.scrollRest = total - notches
            if (notches) call('input.scroll', { dy: -notches }).catch(() => {})
            return
          }
          pending.current.dx += stepX
          pending.current.dy += stepY
        },
        onPanResponderRelease: (evt, state) => {
          stopFlushing()
          const held = Date.now() - gesture.current.startedAt
          const moved = Math.abs(state.dx) + Math.abs(state.dy)
          if (held < TAP_MS && moved < TAP_SLOP) tapped(gesture.current.fingers >= 2 ? 'right' : 'left')
        },
        onPanResponderTerminate: stopFlushing,
      }),
    [call, startFlushing, stopFlushing, tapped],
  )

  const sendKey = useCallback(
    (key: string, mods?: string) => {
      Haptics.selectionAsync().catch(() => {})
      call('input.key', { key, mods: mods ?? '' }).catch((err: Error) => setNote(err.message))
    },
    [call],
  )

  const sendText = useCallback(() => {
    const text = typing
    if (!text) return
    setTyping('')
    call('input.text', { text }).catch((err: Error) => setNote(err.message))
  }, [call, typing])

  if (!supported) {
    return (
      <Screen>
        <Caps style={{ marginBottom: space.md }}>Touchpad</Caps>
        <Card>
          <Empty icon="mouse-pointer" text="This desktop cannot inject input — Hyprland is not answering." />
        </Card>
      </Screen>
    )
  }

  return (
    <Screen>
      <Caps style={{ marginBottom: space.md }}>Touchpad · drag to move, tap to click</Caps>
      <Card style={{ padding: 0, overflow: 'hidden' }}>
        <View
          {...responder.panHandlers}
          style={{
            height: 300,
            backgroundColor: palette.darker_background,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Feather name="move" size={26} color={palette.lighter_background} />
          <Caps tone={palette.lighter_background} style={{ marginTop: space.sm }}>
            touch surface
          </Caps>
        </View>
        <View style={{ flexDirection: 'row', borderTopWidth: StyleSheet.hairlineWidth * 2, borderTopColor: palette.lighter_background }}>
          <PadButton label="Left" onPress={() => tapped('left')} />
          <PadButton label="Middle" onPress={() => call('input.click', { button: 'middle' }).catch(() => {})} divider />
          <PadButton label="Right" onPress={() => tapped('right')} divider />
        </View>
      </Card>

      <Card>
        <CardHeader icon="type" title="Type" subtitle="sends to the focused window" />
        <View style={{ flexDirection: 'row', gap: space.sm }}>
          <TextInput
            value={typing}
            onChangeText={setTyping}
            onSubmitEditing={sendText}
            placeholder="type here…"
            placeholderTextColor={palette.muted}
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="send"
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
              paddingVertical: space.md,
            }}
          />
          <Pressable
            onPress={sendText}
            style={{
              paddingHorizontal: space.lg,
              justifyContent: 'center',
              backgroundColor: palette.lighter_background,
              borderRadius: radius.sm,
            }}
          >
            <Feather name="corner-down-left" size={16} color={palette.bright_foreground} />
          </Pressable>
        </View>

        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, marginTop: space.md }}>
          {KEYS.map((entry) => (
            <Pressable
              key={entry.key}
              onPress={() => sendKey(entry.key, entry.mods)}
              style={{
                minWidth: 52,
                alignItems: 'center',
                paddingVertical: space.sm,
                paddingHorizontal: space.md,
                backgroundColor: palette.darker_background,
                borderWidth: 1,
                borderColor: palette.lighter_background,
                borderRadius: radius.sm,
              }}
            >
              <Body tone={palette.light_foreground} style={{ fontSize: size.label }}>
                {entry.label}
              </Body>
            </Pressable>
          ))}
        </View>
      </Card>

      {scrollMode === 'keys' ? (
        <Card>
          <Body tone={palette.muted} style={{ fontSize: size.label }}>
            Two-finger scrolling uses arrow keys on this desktop — Hyprland cannot inject a scroll wheel on its own.
            Install <Body tone={palette.accent} style={{ fontSize: size.label }}>ydotool</Body> for real wheel events.
          </Body>
        </Card>
      ) : null}

      {note ? (
        <Card>
          <Body tone={palette.red} style={{ fontSize: size.label }}>
            {note}
          </Body>
        </Card>
      ) : null}
    </Screen>
  )
}

function PadButton({ label, onPress, divider }: { label: string; onPress: () => void; divider?: boolean }) {
  const { palette } = useConnection()
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => ({
        flex: 1,
        alignItems: 'center',
        paddingVertical: space.md,
        backgroundColor: pressed ? palette.lighter_background : 'transparent',
        borderLeftWidth: divider ? StyleSheet.hairlineWidth * 2 : 0,
        borderLeftColor: palette.lighter_background,
      })}
    >
      <Caps tone={palette.foreground}>{label}</Caps>
    </Pressable>
  )
}
