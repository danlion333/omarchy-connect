import React, { useState } from 'react'
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native'
import { StatusBar } from 'expo-status-bar'
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context'
import { Feather } from '@expo/vector-icons'
import { useFonts, JetBrainsMono_400Regular, JetBrainsMono_500Medium, JetBrainsMono_700Bold } from '@expo-google-fonts/jetbrains-mono'

import { ConnectionProvider, useConnection } from './src/state/ConnectionContext'
import { DashboardScreen } from './src/screens/DashboardScreen'
import { RemoteScreen } from './src/screens/RemoteScreen'
import { TouchpadScreen } from './src/screens/TouchpadScreen'
import { ShareScreen } from './src/screens/ShareScreen'
import { NotificationsScreen } from './src/screens/NotificationsScreen'
import { SettingsScreen } from './src/screens/SettingsScreen'
import { PairScreen } from './src/screens/PairScreen'
import { FALLBACK_PALETTE, font, size, space } from './src/theme'

type TabKey = 'stats' | 'remote' | 'touch' | 'share' | 'alerts' | 'setup'

const TABS: { key: TabKey; icon: React.ComponentProps<typeof Feather>['name']; label: string }[] = [
  { key: 'stats', icon: 'activity', label: 'Stats' },
  { key: 'remote', icon: 'sliders', label: 'Remote' },
  { key: 'touch', icon: 'move', label: 'Touch' },
  { key: 'share', icon: 'upload-cloud', label: 'Share' },
  { key: 'alerts', icon: 'bell', label: 'Alerts' },
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

  if (!ready) return <Splash />
  if (!desktop) return <PairScreen />

  return (
    <View style={{ flex: 1, backgroundColor: palette.background }}>
      <View style={{ flex: 1 }}>
        {tab === 'stats' ? <DashboardScreen /> : null}
        {tab === 'remote' ? <RemoteScreen /> : null}
        {tab === 'touch' ? <TouchpadScreen /> : null}
        {tab === 'share' ? <ShareScreen /> : null}
        {tab === 'alerts' ? <NotificationsScreen /> : null}
        {tab === 'setup' ? <SettingsScreen /> : null}
      </View>
      <TabBar current={tab} onChange={setTab} />
    </View>
  )
}

function TabBar({ current, onChange }: { current: TabKey; onChange: (tab: TabKey) => void }) {
  const { palette, unreadCount, status } = useConnection()
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
        const badge = entry.key === 'alerts' && unreadCount > 0
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
                    backgroundColor: palette.red,
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <Text style={{ color: palette.bright_foreground, fontFamily: font.medium, fontSize: 9 }}>
                    {unreadCount > 9 ? '9+' : unreadCount}
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
