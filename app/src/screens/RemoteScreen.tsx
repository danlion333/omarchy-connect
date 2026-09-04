import React, { useCallback, useEffect, useState } from 'react'
import { Alert, View } from 'react-native'
import * as Haptics from 'expo-haptics'

import { useConnection } from '../state/ConnectionContext'
import { Body, Button, Caps, Card, CardHeader, Chip, Divider, LevelBar, ListRow, Notice, Screen, Value } from '../ui/kit'
import { canWake } from '../api/wake'
import { space, size } from '../theme'

type MediaState = {
  output: { percent: number; muted: boolean } | null
  input: { percent: number; muted: boolean } | null
  brightness: { percent: number } | null
  player: { available: boolean; playing?: boolean; title?: string | null; artist?: string | null; status?: string }
}

type Workspace = { id: number; name: string; windows: number }
type Window = { address: string; title: string; class: string; workspace: number; focused: boolean }

export function RemoteScreen() {
  const { call, can, palette, status, desktop, wake, waking } = useConnection()
  const [media, setMedia] = useState<MediaState | null>(null)
  const [workspaces, setWorkspaces] = useState<Workspace[]>([])
  const [activeWorkspace, setActiveWorkspace] = useState<number | null>(null)
  const [windows, setWindows] = useState<Window[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  /** The thrown value itself; `Notice` turns it into a line a person reads. */
  const [error, setError] = useState<unknown>(null)

  const connected = status === 'connected'

  const refresh = useCallback(async () => {
    if (!connected) return
    try {
      const [m, w] = await Promise.all([
        call<MediaState>('media.state'),
        can('desktop', 'hyprland')
          ? call<{ workspaces: Workspace[]; activeId: number }>('hypr.workspaces')
          : Promise.resolve(null),
      ])
      setMedia(m)
      if (w) {
        setWorkspaces(w.workspaces)
        setActiveWorkspace(w.activeId)
      }
    } catch (err) {
      setError(err)
    }
  }, [call, can, connected])

  const loadWindows = useCallback(async () => {
    if (!connected || !can('desktop', 'hyprland')) return
    try {
      const res = await call<{ windows: Window[] }>('hypr.windows')
      setWindows(res.windows)
    } catch {
      /* the rest of the screen still works */
    }
  }, [call, can, connected])

  useEffect(() => {
    refresh()
    loadWindows()
  }, [refresh, loadWindows])

  const act = useCallback(
    async (key: string, method: string, params: Record<string, unknown> = {}, after?: () => void) => {
      setBusy(key)
      setError(null)
      try {
        Haptics.selectionAsync().catch(() => {})
        const data = await call<any>(method, params)
        if (data && (data.output || data.brightness || data.input)) {
          setMedia((prev) => (prev ? { ...prev, ...data } : prev))
        }
        after?.()
      } catch (err) {
        setError(err)
      } finally {
        setBusy(null)
      }
    },
    [call],
  )

  const confirmPower = useCallback(
    (action: 'reboot' | 'shutdown') => {
      Alert.alert(
        action === 'reboot' ? 'Reboot the desktop?' : 'Shut the desktop down?',
        'Unsaved work on the desktop will be lost.',
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: action === 'reboot' ? 'Reboot' : 'Shut down',
            style: 'destructive',
            onPress: () => act(action, 'system.power', { action, confirm: true }),
          },
        ],
      )
    },
    [act],
  )

  /**
   * The one control on this screen that is for a desktop that is *not*
   * answering — so it is the one that comes alive when everything else greys
   * out. Nothing acknowledges a magic packet, so the button waits for the
   * daemon itself rather than claiming success the moment it is sent.
   */
  const wakeable = canWake(desktop?.wake)
  const [woke, setWoke] = useState<string | null>(null)

  const onWake = useCallback(async () => {
    setWoke(null)
    setError(null)
    try {
      Haptics.selectionAsync().catch(() => {})
      const answered = await wake()
      setWoke(
        answered
          ? 'the desktop is back'
          : desktop?.wake?.armed === false
            ? 'no answer — this desktop\'s card is not set to wake it, see Setup'
            : 'no answer yet — it may still be starting up',
      )
    } catch (err) {
      setError(err)
    }
  }, [wake, desktop?.wake?.armed])

  const player = media?.player
  const volume = media?.output?.percent ?? 0
  const muted = media?.output?.muted ?? false

  return (
    <Screen>
      <Caps style={{ marginBottom: space.md }}>Remote control</Caps>

      <Notice error={error} onDismiss={() => setError(null)} />

      <Card>
        <CardHeader
          icon={muted ? 'volume-x' : 'volume-2'}
          title={muted ? 'Muted' : `${volume}%`}
          subtitle="Output volume"
          tone={muted ? palette.red : undefined}
          right={media?.input ? <Value tone={palette.muted}>{`mic ${media.input.muted ? 'off' : `${media.input.percent}%`}`}</Value> : undefined}
        />
        <LevelBar
          value={volume}
          onChange={(percent) => act('volume', 'volume.set', { percent })}
          tone={muted ? palette.muted : palette.accent}
          disabled={!can('media', 'volume') || !connected}
        />
        <View style={{ flexDirection: 'row', gap: space.sm, marginTop: space.sm }}>
          <Button icon="minus" onPress={() => act('vol-', 'volume.step', { delta: -5 })} style={{ flex: 1 }} disabled={!connected} />
          <Button
            icon={muted ? 'volume-x' : 'volume-1'}
            label={muted ? 'Unmute' : 'Mute'}
            onPress={() => act('mute', 'volume.mute', {}, refresh)}
            tone={muted ? palette.red : undefined}
            style={{ flex: 2 }}
            disabled={!connected}
          />
          <Button icon="plus" onPress={() => act('vol+', 'volume.step', { delta: 5 })} style={{ flex: 1 }} disabled={!connected} />
        </View>
      </Card>

      {can('media', 'player') ? (
        <Card>
          <CardHeader
            icon="music"
            title={player?.title || (player?.available ? 'Nothing playing' : 'Media keys')}
            subtitle={player?.artist || player?.status || 'playerctl'}
          />
          <View style={{ flexDirection: 'row', gap: space.sm }}>
            <Button icon="skip-back" onPress={() => act('prev', 'player.previous', {}, refresh)} style={{ flex: 1 }} disabled={!connected} />
            <Button
              icon={player?.playing ? 'pause' : 'play'}
              onPress={() => act('play', 'player.play', {}, refresh)}
              variant="solid"
              style={{ flex: 2 }}
              disabled={!connected}
              loading={busy === 'play'}
            />
            <Button icon="skip-forward" onPress={() => act('next', 'player.next', {}, refresh)} style={{ flex: 1 }} disabled={!connected} />
          </View>
        </Card>
      ) : null}

      {can('media', 'brightness') && media?.brightness ? (
        <Card>
          <CardHeader icon="sun" title={`${media.brightness.percent}%`} subtitle="Display brightness" />
          <LevelBar
            value={media.brightness.percent}
            onChange={(percent) => act('brightness', 'brightness.set', { percent })}
            tone={palette.yellow}
            disabled={!connected}
          />
        </Card>
      ) : null}

      {can('desktop', 'hyprland') ? (
        <Card>
          <CardHeader
            icon="grid"
            title="Workspaces"
            subtitle={activeWorkspace ? `active ${activeWorkspace}` : 'hyprland'}
            right={<Button icon="refresh-cw" variant="ghost" onPress={() => { refresh(); loadWindows() }} />}
          />
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>
            {workspaces.map((ws) => (
              <Chip
                key={ws.id}
                label={String(ws.id)}
                active={ws.id === activeWorkspace}
                onPress={() =>
                  act(`ws-${ws.id}`, 'hypr.goto', { id: ws.id }, () => {
                    setActiveWorkspace(ws.id)
                    loadWindows()
                  })
                }
              />
            ))}
            {workspaces.length === 0 ? <Body tone={palette.muted}>no workspaces reported</Body> : null}
          </View>

          {windows.length ? (
            <>
              <Divider />
              <Caps style={{ marginBottom: space.sm }}>{`${windows.length} windows`}</Caps>
              {windows.slice(0, 12).map((win) => (
                <ListRow
                  key={win.address}
                  title={win.title || win.class}
                  subtitle={`${win.class} · workspace ${win.workspace}`}
                  tone={win.focused ? palette.bright_foreground : undefined}
                  onPress={() => act(`focus-${win.address}`, 'hypr.focus', { address: win.address }, loadWindows)}
                  right={
                    <Button
                      icon="x"
                      variant="ghost"
                      onPress={() => act(`close-${win.address}`, 'hypr.close', { address: win.address }, loadWindows)}
                    />
                  }
                />
              ))}
            </>
          ) : null}
        </Card>
      ) : null}

      <Card>
        <CardHeader icon="power" title="System" subtitle="power and capture" />
        <View style={{ gap: space.sm }}>
          <View style={{ flexDirection: 'row', gap: space.sm }}>
            <Button icon="lock" label="Lock" onPress={() => act('lock', 'system.power', { action: 'lock' })} style={{ flex: 1 }} disabled={!connected} />
            <Button icon="moon" label="Sleep" onPress={() => act('sleep', 'system.power', { action: 'sleep' })} style={{ flex: 1 }} disabled={!connected} />
          </View>
          {wakeable ? (
            <>
              <Button
                icon="zap"
                label={waking ? 'Waking…' : 'Wake'}
                onPress={onWake}
                loading={waking}
                disabled={connected || waking}
              />
              {woke && !connected ? (
                <Body tone={palette.muted} style={{ fontSize: size.label }}>
                  {woke}
                </Body>
              ) : null}
            </>
          ) : null}
          <View style={{ flexDirection: 'row', gap: space.sm }}>
            <Button
              icon="camera"
              label="Screenshot"
              onPress={() => act('shot', 'system.screenshot', { mode: 'fullscreen', target: 'copy' })}
              style={{ flex: 1 }}
              disabled={!connected || !can('desktop', 'screenshot')}
            />
            <Button icon="bell" label="Locate" onPress={() => act('locate', 'system.locate')} style={{ flex: 1 }} disabled={!connected} />
          </View>
          <View style={{ flexDirection: 'row', gap: space.sm }}>
            <Button icon="rotate-cw" label="Reboot" variant="danger" onPress={() => confirmPower('reboot')} style={{ flex: 1 }} disabled={!connected} />
            <Button icon="power" label="Shut down" variant="danger" onPress={() => confirmPower('shutdown')} style={{ flex: 1 }} disabled={!connected} />
          </View>
        </View>
      </Card>
    </Screen>
  )
}
