import React, { useEffect, useMemo, useState } from 'react'
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native'
import { StatusBar } from 'expo-status-bar'
import * as Linking from 'expo-linking'
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context'
import { Feather } from '@expo/vector-icons'
import { useFonts, JetBrainsMono_400Regular, JetBrainsMono_500Medium, JetBrainsMono_700Bold } from '@expo-google-fonts/jetbrains-mono'

import { ConnectionProvider, useAgents, useConnection } from './src/state/ConnectionContext'
import { DashboardScreen } from './src/screens/DashboardScreen'
import { RemoteScreen } from './src/screens/RemoteScreen'
import { ShareScreen } from './src/screens/ShareScreen'
import { AgentsScreen } from './src/screens/AgentsScreen'
import { SettingsScreen } from './src/screens/SettingsScreen'
import { PairScreen } from './src/screens/PairScreen'
import { FALLBACK_PALETTE, font, size, space } from './src/theme'

type TabKey = 'stats' | 'remote' | 'agents' | 'share' | 'setup'

const TABS: { key: TabKey; icon: React.ComponentProps<typeof Feather>['name']; label: string }[] = [
  { key: 'stats', icon: 'activity', label: 'Stats' },
  { key: 'remote', icon: 'sliders', label: 'Remote' },
  { key: 'agents', icon: 'terminal', label: 'Agents' },
  { key: 'share', icon: 'upload-cloud', label: 'Share' },
  { key: 'setup', icon: 'settings', label: 'Setup' },
]

export default function App() {
  const [fontsLoaded] = useFonts({
    JetBrainsMono_400Regular,
    JetBrainsMono_500Medium,
    JetBrainsMono_700Bold,
  })

  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      <ConnectionProvider>{fontsLoaded ? <Shell /> : <Splash />}</ConnectionProvider>
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
  const { desktop, ready, palette } = useConnection()
  const [tab, setTab] = useState<TabKey>('stats')
  const route = useRequestedRoute()
  const [opening, setOpening] = useState<string | null>(null)

  // A tapped notification should land where its news is, not on whatever
  // screen the app happened to be left on. `useURL` covers both the cold start
  // and the app already running, so this is the whole of it.
  useEffect(() => {
    if (!route) return
    setTab(route.tab)
    if (route.agent) setOpening(route.agent)
  }, [route])

  if (!ready) return <Splash />
  if (!desktop) return <PairScreen />

  return (
    <View style={{ flex: 1, backgroundColor: palette.background }}>
      <View style={{ flex: 1 }}>
        {tab === 'stats' ? <DashboardScreen /> : null}
        {tab === 'remote' ? <RemoteScreen /> : null}
        {tab === 'agents' ? <AgentsScreen open={opening} onOpened={() => setOpening(null)} /> : null}
        {tab === 'share' ? <ShareScreen /> : null}
        {tab === 'setup' ? <SettingsScreen /> : null}
      </View>
      <TabBar current={tab} onChange={setTab} />
    </View>
  )
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
  // would re-fire the effect that acts on it, and the tab bar would spring
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

function TabBar({ current, onChange }: { current: TabKey; onChange: (tab: TabKey) => void }) {
  const { palette, status } = useConnection()
  const { agentsWaiting } = useAgents()
  const insets = useSafeAreaInsets()

  return (
    <View
      style={{
        flexDirection: 'row',
        backgroundColor: palette.dark_background,
        borderTopWidth: StyleSheet.hairlineWidth * 2,
        borderTopColor: palette.lighter_background,
        paddingBottom: Math.max(insets.bottom, space.sm),
        paddingTop: space.sm,
      }}
    >
      {TABS.map((entry) => {
        const active = entry.key === current
        // An agent stuck on a permission prompt is the one thing on this bar
        // that is costing someone time right now.
        const count = entry.key === 'agents' ? agentsWaiting : 0
        const badge = count > 0
        return (
          <Pressable
            key={entry.key}
            onPress={() => onChange(entry.key)}
            style={{ flex: 1, alignItems: 'center', paddingVertical: space.xs, gap: 3 }}
          >
            <View>
              <Feather name={entry.icon} size={19} color={active ? palette.bright_foreground : palette.muted} />
              {badge ? (
                <View
                  style={{
                    position: 'absolute',
                    top: -2,
                    right: -6,
                    minWidth: 14,
                    height: 14,
                    borderRadius: 7,
                    paddingHorizontal: 3,
                    backgroundColor: palette.orange,
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <Text style={{ color: palette.bright_foreground, fontFamily: font.medium, fontSize: 9 }}>
                    {count > 9 ? '9+' : count}
                  </Text>
                </View>
              ) : null}
            </View>
            <Text
              style={{
                color: active ? palette.foreground : palette.muted,
                fontFamily: active ? font.medium : font.regular,
                fontSize: size.micro,
                letterSpacing: 0.6,
              }}
            >
              {entry.label}
            </Text>
            {entry.key === 'stats' && status !== 'connected' ? (
              <View
                style={{
                  position: 'absolute',
                  bottom: 2,
                  width: 4,
                  height: 4,
                  borderRadius: 2,
                  backgroundColor: status === 'error' ? palette.red : palette.orange,
                }}
              />
            ) : null}
          </Pressable>
        )
      })}
    </View>
  )
}
