import React, { useCallback, useEffect, useState } from 'react'
import { Alert, Platform, View } from 'react-native'
import { Feather } from '@expo/vector-icons'

import { useConnection } from '../state/ConnectionContext'
import { Body, Button, Caps, Card, CardHeader, Chip, DataGrid, Divider, Empty, Screen } from '../ui/kit'
import { clock, duration } from '../lib/format'
import {
  canAnswerCalls,
  phoneMirrorSupported,
  phonePermission,
  requestCallPermission,
  requestPhonePermission,
} from '../api/phone'
import { font, size, space } from '../theme'

export function SettingsScreen() {
  const { desktop, hello, palette, status, call, can, forget, reconnect, error, fingerprint } = useConnection()
  const [themes, setThemes] = useState<string[]>([])
  const [currentTheme, setCurrentTheme] = useState<string | null>(null)
  const [switching, setSwitching] = useState<string | null>(null)
  const [themeError, setThemeError] = useState<string | null>(null)

  const connected = status === 'connected'

  const loadThemes = useCallback(async () => {
    if (!connected || !can('desktop', 'themes')) return
    try {
      const res = await call<{ themes: string[]; current: string | null }>('theme.list')
      setThemes(res.themes)
      setCurrentTheme(res.current)
    } catch (err) {
      setThemeError((err as Error).message)
    }
  }, [call, can, connected])

  useEffect(() => {
    loadThemes()
  }, [loadThemes])

  const applyTheme = useCallback(
    async (name: string) => {
      setSwitching(name)
      setThemeError(null)
      try {
        await call('theme.set', { name })
        setCurrentTheme(name)
      } catch (err) {
        setThemeError((err as Error).message)
      } finally {
        setSwitching(null)
      }
    },
    [call],
  )

  const confirmForget = useCallback(() => {
    Alert.alert('Unpair this desktop?', 'You will need a new pairing code to connect again.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Unpair', style: 'destructive', onPress: () => forget() },
    ])
  }, [forget])

  const capabilities = hello?.capabilities ?? {}

  return (
    <Screen>
      <Caps style={{ marginBottom: space.md }}>Setup</Caps>

      <Card>
        <CardHeader
          icon="monitor"
          title={hello?.server.name ?? desktop?.name ?? 'no desktop'}
          subtitle={statusLabel(status)}
          tone={connected ? palette.green : status === 'error' ? palette.red : palette.orange}
          right={<Button icon="refresh-cw" variant="ghost" onPress={reconnect} />}
        />
        <DataGrid
          pairs={[
            { label: 'Address', value: desktop ? `${desktop.host}:${desktop.port}` : '—' },
            { label: 'Paired', value: desktop ? clock(desktop.pairedAt) : '—' },
            { label: 'Daemon', value: hello?.server.version ?? '—' },
            { label: 'Protocol', value: hello ? `v${hello.protocol}` : '—' },
            { label: 'Kernel', value: hello?.host?.kernel ?? '—' },
            { label: 'Uptime', value: hello ? duration(hello.host?.uptime) : '—' },
          ]}
        />
        <Divider />
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
          <Feather name={hello?.secure ? 'lock' : 'unlock'} size={13} color={hello?.secure ? palette.green : palette.orange} />
          <Caps tone={palette.muted}>{hello?.secure ? 'encrypted' : 'not encrypted'}</Caps>
          <Chip label={desktop?.tls ? 'tls' : 'plain'} tone={desktop?.tls ? palette.green : palette.muted} />
          <Body tone={palette.light_foreground} style={{ fontFamily: font.medium, fontSize: size.label, marginLeft: 'auto' }}>
            {fingerprint ?? '—'}
          </Body>
        </View>
        <Body tone={palette.muted} style={{ fontSize: size.micro, marginTop: space.xs }}>
          this is the desktop key your phone pinned — `omarchy-connect status` prints the same digest
        </Body>
        {error ? (
          <Body tone={palette.red} style={{ marginTop: space.md, fontSize: size.label }}>
            {error}
          </Body>
        ) : null}
      </Card>

      {can('desktop', 'themes') ? (
        <Card>
          <CardHeader
            icon="droplet"
            title="Theme"
            subtitle={`${palette.name} · the app follows the desktop`}
            right={<Button icon="refresh-cw" variant="ghost" onPress={loadThemes} />}
          />
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>
            {themes.map((name) => (
              <Chip
                key={name}
                label={switching === name ? `${name}…` : name}
                active={name === currentTheme}
                onPress={() => applyTheme(name)}
              />
            ))}
          </View>
          {themeError ? (
            <Body tone={palette.red} style={{ marginTop: space.md, fontSize: size.label }}>
              {themeError}
            </Body>
          ) : null}
        </Card>
      ) : null}

      <Card>
        <CardHeader icon="check-circle" title="Capabilities" subtitle="what this desktop can do" />
        {Object.keys(capabilities).length ? (
          Object.entries(capabilities).map(([plugin, features], i) => (
            <View key={plugin}>
              {i > 0 ? <Divider style={{ marginVertical: space.sm }} /> : null}
              <Caps style={{ marginBottom: space.sm }}>{plugin}</Caps>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>
                {Object.entries(features).map(([feature, enabled]) => (
                  <Body
                    key={feature}
                    tone={enabled ? palette.green : palette.muted}
                    style={{ fontSize: size.label }}
                  >
                    {`${enabled ? '+' : '−'} ${feature}`}
                  </Body>
                ))}
              </View>
            </View>
          ))
        ) : (
          <Empty icon="help-circle" text="Connect to see what the desktop supports" />
        )}
      </Card>

      <PhoneMirror enabled={Boolean((capabilities.phone as any)?.mirror)} />

      <Card>
        <CardHeader icon="smartphone" title="This phone" subtitle={hello?.device.name ?? 'not paired'} />
        <DataGrid
          pairs={[
            { label: 'Platform', value: hello?.device.platform ?? '—' },
            { label: 'Device id', value: hello?.device.id?.slice(0, 14) ?? '—' },
          ]}
          columns={1}
        />
        <View style={{ height: space.md }} />
        <Button icon="trash-2" label="Unpair this desktop" variant="danger" onPress={confirmForget} />
      </Card>

      <Body tone={palette.muted} style={{ fontSize: size.label, textAlign: 'center', marginTop: space.sm }}>
        Omarchy Connect · everything stays on your network
      </Body>
    </Screen>
  )
}

/**
 * Granting Android the right to read messages and call state.
 *
 * Deliberately a button rather than something asked for at startup: this is
 * the most invasive permission the app has, and the user should be the one who
 * decides to hand it over, at a moment when it is obvious what it buys them.
 */
function PhoneMirror({ enabled }: { enabled: boolean }) {
  const { palette } = useConnection()
  const supported = phoneMirrorSupported()
  const [granted, setGranted] = useState(false)
  const [canAskAgain, setCanAskAgain] = useState(true)
  const [busy, setBusy] = useState(false)
  const [answering, setAnswering] = useState(false)
  const [askingCalls, setAskingCalls] = useState(false)

  useEffect(() => {
    if (!supported) return
    phonePermission().then((result) => {
      setGranted(result.granted)
      setCanAskAgain(result.canAskAgain)
    })
    setAnswering(canAnswerCalls())
  }, [supported])

  const ask = useCallback(async () => {
    setBusy(true)
    try {
      const result = await requestPhonePermission()
      setGranted(result.granted)
      setCanAskAgain(result.canAskAgain)
    } finally {
      setBusy(false)
    }
  }, [])

  const askCalls = useCallback(async () => {
    setAskingCalls(true)
    try {
      setAnswering(await requestCallPermission())
    } finally {
      setAskingCalls(false)
    }
  }, [])

  if (!enabled) return null

  return (
    <Card>
      <CardHeader
        icon="message-square"
        title="Messages and calls"
        subtitle={
          supported
            ? granted
              ? 'mirroring to the desktop'
              : 'permission needed'
            : Platform.OS === 'ios'
              ? 'over Bluetooth, not the app'
              : 'not available here'
        }
        tone={supported && granted ? palette.green : palette.orange}
      />
      {supported ? (
        <>
          <Body tone={palette.muted} style={{ fontSize: size.label, marginBottom: space.md }}>
            Incoming messages and calls appear as desktop notifications. Anything that arrives while this app is
            closed is forwarded the next time you open it — nothing runs in the background.
          </Body>
          {granted ? (
            <DataGrid pairs={[{ label: 'Status', value: 'granted' }]} columns={1} />
          ) : (
            <Button
              icon="shield"
              label={canAskAgain ? 'Allow SMS and calls' : 'Open Android settings to allow'}
              variant="solid"
              loading={busy}
              disabled={!canAskAgain}
              onPress={ask}
            />
          )}
          <Body tone={palette.muted} style={{ fontSize: size.label, marginTop: space.md }}>
            Answering from the desktop is a separate permission, because picking up someone's call is not a
            passive act. Granted here, the call is answered but the audio stays on this phone — pair the desktop
            over Bluetooth if you want to speak through it.
          </Body>
          {answering ? (
            <DataGrid pairs={[{ label: 'Answer calls', value: 'granted' }]} columns={1} />
          ) : (
            <Button
              icon="phone"
              label="Allow answering from the desktop"
              variant="ghost"
              loading={askingCalls}
              onPress={askCalls}
            />
          )}
        </>
      ) : Platform.OS === 'ios' ? (
        <IosBridge />
      ) : (
        <Body tone={palette.muted} style={{ fontSize: size.label }}>
          This needs a real Android build — Expo Go cannot hold the SMS and call-log permissions.
        </Body>
      )}
    </Card>
  )
}

type BridgeState = { subscribed: boolean; device: string | null; paired: boolean; available: boolean }

/**
 * What an iPhone can do instead.
 *
 * iOS publishes no messages, no call log and no notification centre to any
 * app, so there is no permission this screen could offer — asking would be a
 * button that does nothing. It publishes all three to a Bluetooth accessory,
 * though, which is a road the desktop can take on its own. Nothing here is
 * therefore a control: it is a readout of a link that lives on the other end,
 * and the one instruction the user actually needs.
 */
function IosBridge() {
  const { palette, call, status } = useConnection()
  const [bridge, setBridge] = useState<BridgeState | null>(null)
  const [checking, setChecking] = useState(false)

  const refresh = useCallback(async () => {
    if (status !== 'connected') return
    setChecking(true)
    try {
      const res = await call<{ ios?: BridgeState }>('phone.history', { limit: 1 })
      setBridge(res.ios ?? null)
    } catch {
      // An older daemon has no answer to give; the copy below still stands.
      setBridge(null)
    } finally {
      setChecking(false)
    }
  }, [call, status])

  useEffect(() => {
    refresh()
  }, [refresh])

  const live = bridge?.subscribed === true

  return (
    <>
      <Body tone={palette.muted} style={{ fontSize: size.label, marginBottom: space.md }}>
        iOS gives no app access to messages, the call log, or notifications — including this one. It gives all of
        them to a Bluetooth accessory, so the desktop asks to be one. Pair this iPhone with it and your messages,
        calls and app notifications appear on the desktop with no app running at all.
      </Body>
      <DataGrid
        pairs={[
          { label: 'Bridge', value: live ? 'mirroring' : bridge?.paired ? 'paired, idle' : 'not paired' },
          { label: 'Desktop sees', value: bridge?.device ?? '—' },
        ]}
        columns={2}
      />
      {live ? null : (
        <Body tone={palette.muted} style={{ fontSize: size.label, marginTop: space.md }}>
          On the desktop run{' '}
          <Body tone={palette.bright_foreground} style={{ fontSize: size.label, fontFamily: font.bold }}>
            omarchy-connect ios pair
          </Body>
          , then open Settings › Bluetooth here and tap the desktop. iOS will ask whether to show notifications on
          it — that prompt is the whole feature.
        </Body>
      )}
      <Button
        icon="refresh-cw"
        label="Check the bridge"
        variant="ghost"
        loading={checking}
        onPress={refresh}
        style={{ marginTop: space.md }}
      />
    </>
  )
}

function statusLabel(status: string) {
  switch (status) {
    case 'connected':
      return 'connected'
    case 'reconnecting':
      return 'reconnecting…'
    case 'connecting':
      return 'connecting…'
    case 'error':
      return 'connection problem'
    default:
      return 'offline'
  }
}
