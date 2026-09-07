import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native'
import { StatusBar } from 'expo-status-bar'
import * as Linking from 'expo-linking'
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context'
import { useFonts, JetBrainsMono_400Regular, JetBrainsMono_500Medium, JetBrainsMono_700Bold } from '@expo-google-fonts/jetbrains-mono'

import { ConnectionProvider, useAgents, useConnection } from './src/state/ConnectionContext'
import { HomeScreen } from './src/screens/HomeScreen'
import { TerminalScreen } from './src/screens/TerminalScreen'
import { ShareScreen } from './src/screens/ShareScreen'
import { AgentsScreen } from './src/screens/AgentsScreen'
import { SettingsScreen } from './src/screens/SettingsScreen'
import { PairScreen } from './src/screens/PairScreen'
import { ErrorBoundary } from './src/ui/ErrorBoundary'
import { FeedbackProvider, Notice, Wallpaper } from './src/ui/kit'
import { LookProvider, SetupAsksProvider, useSetupAsks } from './src/ui/look'
import { FALLBACK_PALETTE, alpha, font, radius, size, space } from './src/theme'
import { onSharedIntent, takeSharedIntent } from './modules/omarchy-link'
import { isEmptyShare, shareBlocked, type SharePayload } from './src/lib/share'

/**
 * The five workspaces, in the order the Omarchy bar numbers them. They are
 * workspaces rather than tabs: the bar at the bottom is the desktop's own bar,
 * the numbers are the desktop's numbers, and a swipe moves between them.
 */
type TabKey = 'home' | 'agents' | 'terminal' | 'share' | 'setup'

const WORKSPACES: { key: TabKey; label: string }[] = [
  { key: 'home', label: 'home' },
  { key: 'agents', label: 'agents' },
  { key: 'terminal', label: 'terminal' },
  { key: 'share', label: 'share' },
  { key: 'setup', label: 'setup' },
]

const indexOf = (key: TabKey) => Math.max(0, WORKSPACES.findIndex((entry) => entry.key === key))

export default function App() {
  const [fontsLoaded] = useFonts({
    JetBrainsMono_400Regular,
    JetBrainsMono_500Medium,
    JetBrainsMono_700Bold,
  })

  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      <ConnectionProvider>
        <LookProvider>
          <SetupAsksProvider>
            <FeedbackProvider>{fontsLoaded ? <Shell /> : <Splash />}</FeedbackProvider>
          </SetupAsksProvider>
        </LookProvider>
      </ConnectionProvider>
    </SafeAreaProvider>
  )
}

function Splash() {
  return (
    <View style={{ flex: 1, backgroundColor: FALLBACK_PALETTE.background, alignItems: 'center', justifyContent: 'center' }}>
      <ActivityIndicator color={FALLBACK_PALETTE.accent} />
    </View>
  )
}

function Shell() {
  const { desktop, ready, palette, serverError, dismissServerError } = useConnection()
  const [tab, setTab] = useState<TabKey>('home')
  const route = useRequestedRoute()
  const [opening, setOpening] = useState<string | null>(null)
  const [shared, setShared] = useState<SharePayload | null>(null)
  useIncomingShare(setShared)

  // A tapped notification should land where its news is, not on whatever
  // screen the app happened to be left on. `useURL` covers both the cold start
  // and the app already running, so this is the whole of it.
  useEffect(() => {
    if (!route) return
    setTab(route.tab)
    if (route.agent) setOpening(route.agent)
  }, [route])

  // Somebody shared to this app from another one: whatever they were looking
  // at, the screen that says what is happening to it is the Share workspace.
  useEffect(() => {
    if (shared) setTab('share')
  }, [shared])

  if (!ready) return <Splash />
  // A share that arrives before there is anywhere to send it must not vanish
  // into a pairing screen without a word: the whole point of the share sheet
  // is that nobody is watching the app afterwards.
  // Pairing happens before there is a desktop to take a wallpaper from, so it
  // gets the plain background rather than the glass the workspaces wear.
  if (!desktop) {
    return (
      <View style={{ flex: 1, backgroundColor: palette.background }}>
        <PairScreen notice={shared ? shareBlocked({ paired: false, connected: false }) : null} />
      </View>
    )
  }

  return (
    <View style={{ flex: 1, backgroundColor: palette.background }}>
      <Wallpaper />
      <Workspaces
        current={tab}
        onChange={setTab}
        opening={opening}
        onOpened={() => setOpening(null)}
        shared={shared}
        onSharedTaken={() => setShared(null)}
      />
      {/*
        The desktop's own complaints. They belong to no screen — the request
        that drew one may have been sent from a workspace the user has since
        left — so they are shown above the bar wherever the user happens to be,
        and stay until dismissed.
      */}
      {serverError ? (
        <View style={{ paddingHorizontal: space.lg }}>
          <Notice error={serverError} tone="warning" onDismiss={dismissServerError} />
        </View>
      ) : null}
      <OmarchyBar current={tab} onChange={setTab} />
    </View>
  )
}

/**
 * The five workspaces side by side, one screen wide each.
 *
 * A page is mounted the first time it is visited and then stays mounted, so
 * moving back to Home does not re-fetch everything it already knows; each one
 * keeps its own `ErrorBoundary`, so a screen that throws takes only its own
 * page down and is put back on its feet by leaving and returning.
 */
function Workspaces({
  current,
  onChange,
  opening,
  onOpened,
  shared,
  onSharedTaken,
}: {
  current: TabKey
  onChange: (tab: TabKey) => void
  opening: string | null
  onOpened: () => void
  shared: SharePayload | null
  onSharedTaken: () => void
}) {
  const { width } = useWindowDimensions()
  const scroller = useRef<ScrollView>(null)
  const index = indexOf(current)
  const [seen, setSeen] = useState<TabKey[]>([current])

  useEffect(() => {
    setSeen((was) => (was.includes(current) ? was : [...was, current]))
    scroller.current?.scrollTo({ x: index * width, animated: true })
  }, [current, index, width])

  // A page the finger is dragging toward has to be there before it arrives, or
  // the swipe reveals a blank screen and fills it a beat later.
  const reveal = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      const at = event.nativeEvent.contentOffset.x / Math.max(1, width)
      const near = [Math.floor(at), Math.ceil(at)]
      setSeen((was) => {
        const next = [...was]
        for (const i of near) {
          const key = WORKSPACES[i]?.key
          if (key && !next.includes(key)) next.push(key)
        }
        return next.length === was.length ? was : next
      })
    },
    [width],
  )

  const settled = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      const page = Math.round(event.nativeEvent.contentOffset.x / Math.max(1, width))
      const next = WORKSPACES[Math.max(0, Math.min(WORKSPACES.length - 1, page))]
      if (next && next.key !== current) onChange(next.key)
    },
    [current, onChange, width],
  )

  const page = (key: TabKey) => {
    if (!seen.includes(key)) return null
    return (
      <ErrorBoundary resetKey={key}>
        {key === 'home' ? <HomeScreen /> : null}
        {key === 'agents' ? <AgentsScreen open={opening} onOpened={onOpened} /> : null}
        {key === 'terminal' ? <TerminalScreen /> : null}
        {key === 'share' ? <ShareScreen incoming={shared} onIncomingTaken={onSharedTaken} /> : null}
        {key === 'setup' ? <SettingsScreen /> : null}
      </ErrorBoundary>
    )
  }

  return (
    <ScrollView
      ref={scroller}
      horizontal
      pagingEnabled
      // A drag that starts on a chip row, a slider or a text field belongs to
      // that control: the inner horizontal scroller takes the gesture first,
      // and the responder system hands a slider its drag before this view sees
      // a move. Vertical drags never reach here at all.
      directionalLockEnabled
      keyboardShouldPersistTaps="handled"
      showsHorizontalScrollIndicator={false}
      onScroll={reveal}
      scrollEventThrottle={32}
      onMomentumScrollEnd={settled}
      style={{ flex: 1 }}
      contentContainerStyle={{ width: width * WORKSPACES.length }}
    >
      {WORKSPACES.map((entry) => (
        <View key={entry.key} style={{ width }} accessibilityElementsHidden={entry.key !== current} importantForAccessibility={entry.key === current ? 'auto' : 'no-hide-descendants'}>
          {page(entry.key)}
        </View>
      ))}
    </ScrollView>
  )
}

/**
 * Whatever another app has just shared to this one.
 *
 * Two arrivals, one handler: a cold start, where the share is the intent the
 * activity was created with and is there to be collected as soon as the tree
 * is up, and a share into an app that was already open, which Android
 * delivers as a new intent and the native module announces. Taking a share
 * spends it, so a resumed app does not re-send the last photo.
 */
function useIncomingShare(onShare: (payload: SharePayload) => void) {
  useEffect(() => {
    let alive = true
    const collect = () => {
      takeSharedIntent().then((payload) => {
        if (alive && payload && !isEmptyShare(payload)) onShare(payload)
      })
    }
    collect()
    const off = onSharedIntent(collect)
    return () => {
      alive = false
      off()
    }
  }, [onShare])
}

/**
 * Where a deep link is asking the app to be.
 *
 * Two shapes, both carried by notifications this app raises:
 * `omarchy-connect://agent/<id>` for the agent that has stopped to ask
 * something, and `omarchy-connect://share` for a file or the clipboard. The
 * scheme is already declared for pairing and the activity is `singleTask`, so
 * one hook answers for a launch from cold and for a tap while the app is up.
 *
 * Each link carries a nonce it does not read, which is why identical taps
 * still register: React Native hands a deep link over as a value, and a value
 * the same as the last one is not a change.
 */
function useRequestedRoute(): { tab: TabKey; agent?: string } | null {
  const url = Linking.useURL()
  // Memoised on the URL, not merely computed: a fresh object every render
  // would re-fire the effect that acts on it, and the bar would spring
  // back to the notification's screen every time anything else re-rendered.
  return useMemo(() => {
    if (!url) return null
    try {
      const { hostname, path } = Linking.parse(url)
      if (hostname === 'share') return { tab: 'share' as TabKey }
      if (hostname !== 'agent') return null
      const id = (path || '').replace(/^\/+/, '')
      return id ? { tab: 'agents' as TabKey, agent: decodeURIComponent(id) } : { tab: 'agents' as TabKey }
    } catch {
      return null
    }
  }, [url])
}

/**
 * The Omarchy bar, at the bottom, where it is on the desktop.
 *
 * Five numbered workspaces and nothing else — the active one says its name and
 * wears an accent underline — with badges for what is waiting (an agent's
 * permission prompt, a permission Android never granted). The link, the
 * network, notification silencing and the clock used to sit in a tray on the
 * right; they were either dead glyphs or a second copy of what the screens and
 * the phone's own status bar already show, so the bar is only the workspaces.
 */
function OmarchyBar({ current, onChange }: { current: TabKey; onChange: (tab: TabKey) => void }) {
  const { palette } = useConnection()
  const { agentsWaiting } = useAgents()
  const asks = useSetupAsks()
  const insets = useSafeAreaInsets()

  return (
    <View
      accessibilityRole="tablist"
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 3,
        paddingHorizontal: 10,
        paddingTop: space.sm,
        paddingBottom: 10 + insets.bottom,
        backgroundColor: alpha(palette.darker_background, 0.88),
        borderTopWidth: StyleSheet.hairlineWidth * 2,
        borderTopColor: alpha(palette.lighter_background, 0.85),
      }}
    >
      {WORKSPACES.map((entry, i) => {
        const active = entry.key === current
        const count = entry.key === 'agents' ? agentsWaiting : entry.key === 'setup' ? asks : 0
        return (
          <Pressable
            key={entry.key}
            onPress={() => onChange(entry.key)}
            accessibilityRole="tab"
            accessibilityState={{ selected: active }}
            accessibilityLabel={entry.label}
            style={{
              height: 34,
              paddingHorizontal: space.sm,
              borderRadius: radius.sm,
              flexDirection: 'row',
              alignItems: 'center',
              gap: 7,
              backgroundColor: active ? palette.selection : 'transparent',
            }}
          >
            <Text
              maxFontSizeMultiplier={1.2}
              style={{
                color: active ? palette.accent : palette.light_foreground,
                fontFamily: font.bold,
                fontSize: size.label,
                fontVariant: ['tabular-nums'],
              }}
            >
              {i + 1}
            </Text>
            {active ? (
              <Text
                maxFontSizeMultiplier={1.2}
                numberOfLines={1}
                style={{ color: palette.bright_foreground, fontFamily: font.regular, fontSize: size.label, letterSpacing: 0.4 }}
              >
                {entry.label}
              </Text>
            ) : null}
            {count > 0 ? (
              <View
                style={{
                  position: 'absolute',
                  top: -3,
                  right: -4,
                  minWidth: 14,
                  height: 14,
                  borderRadius: 7,
                  paddingHorizontal: 3,
                  backgroundColor: palette.orange,
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Text style={{ color: palette.background, fontFamily: font.bold, fontSize: 9, lineHeight: 14 }}>{count > 9 ? '9+' : count}</Text>
              </View>
            ) : null}
            {active ? (
              <View style={{ position: 'absolute', left: space.sm, right: space.sm, bottom: 2, height: 2, borderRadius: 1, backgroundColor: palette.accent }} />
            ) : null}
          </Pressable>
        )
      })}
    </View>
  )
}
