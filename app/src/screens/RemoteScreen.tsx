import React, { useCallback, useEffect, useState } from 'react'
import { ActivityIndicator, Alert, View } from 'react-native'
import * as Haptics from 'expo-haptics'

import { useConnection, usePalette } from '../state/ConnectionContext'
import {
  Button,
  Card,
  CardHeader,
  Chip,
  Divider,
  Empty,
  Hint,
  IconButton,
  Label,
  LevelBar,
  ListRow,
  Notice,
  Pill,
  Screen,
  ScreenHeader,
  Section,
  Stat,
  Value,
} from '../ui/kit'
import { canWake } from '../api/wake'
import { datagramsSupported } from '../../modules/omarchy-link'
import { macBytes } from '../lib/wol'
import { alpha, space } from '../theme'

type MediaState = {
  output: { percent: number; muted: boolean } | null
  input: { percent: number; muted: boolean } | null
  brightness: { percent: number } | null
  player: { available: boolean; playing?: boolean; title?: string | null; artist?: string | null; status?: string }
}

type Workspace = { id: number; name: string; windows: number }
type Window = { address: string; title: string; class: string; workspace: number; focused: boolean }

/**
 * Which card a failure is shown in. A notice belongs under the control that
 * was pressed, not at the top of a screen the reader has scrolled away from.
 */
type CardKey = 'load' | 'volume' | 'player' | 'brightness' | 'workspaces' | 'system'

/** The daemon probes the desktop this long before it admits it did not come up. */
const WAKE_WAIT = '90 s'

export function RemoteScreen() {
  const { call, can, palette, status, desktop, wake, waking } = useConnection()
  const [media, setMedia] = useState<MediaState | null>(null)
  const [workspaces, setWorkspaces] = useState<Workspace[]>([])
  const [activeWorkspace, setActiveWorkspace] = useState<number | null>(null)
  const [windows, setWindows] = useState<Window[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  /** The thrown values themselves, one per card; `Notice` turns each into a line a person reads. */
  const [errors, setErrors] = useState<Partial<Record<CardKey, unknown>>>({})
  /** True while the header's refresh is running, so the old data can stay up and the button spin. */
  const [refreshing, setRefreshing] = useState(false)

  const connected = status === 'connected'

  const setError = useCallback((card: CardKey, err: unknown) => {
    setErrors((prev) => ({ ...prev, [card]: err }))
  }, [])

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
      // One request carries the readings for three cards, so a failure lands
      // in the first of them, with the retry beside it.
      setError('load', err)
    }
  }, [call, can, connected, setError])

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

  const refreshAll = useCallback(async () => {
    setRefreshing(true)
    try {
      await Promise.all([refresh(), loadWindows()])
    } finally {
      setRefreshing(false)
    }
  }, [refresh, loadWindows])

  const act = useCallback(
    async (card: CardKey, key: string, method: string, params: Record<string, unknown> = {}, after?: () => void) => {
      setBusy(key)
      setError(card, null)
      try {
        Haptics.selectionAsync().catch(() => {})
        const data = await call<any>(method, params)
        if (data && (data.output || data.brightness || data.input)) {
          setMedia((prev) => (prev ? { ...prev, ...data } : prev))
        }
        after?.()
      } catch (err) {
        setError(card, err)
      } finally {
        setBusy(null)
      }
    },
    [call, setError],
  )

  const confirmPower = useCallback(
    (action: 'reboot' | 'shutdown') => {
      Alert.alert(
        action === 'reboot' ? 'Reboot the desktop?' : 'Shut down the desktop?',
        'Unsaved work on the desktop is lost',
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: action === 'reboot' ? 'Reboot' : 'Shut down',
            style: 'destructive',
            onPress: () => act('system', action, 'system.power', { action, confirm: true }),
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
  const [woke, setWoke] = useState<{ text: string; tone: 'ok' | 'warning' } | null>(null)

  const onWake = useCallback(async () => {
    setWoke(null)
    setError('system', null)
    try {
      Haptics.selectionAsync().catch(() => {})
      const answered = await wake()
      setWoke(
        answered
          ? { text: 'The desktop is back', tone: 'ok' }
          : desktop?.wake?.armed === false
            ? { text: 'No answer — the desktop\'s card is not set to wake it, see Setup', tone: 'warning' }
            : { text: 'No answer yet — it may still be starting', tone: 'warning' },
      )
    } catch (err) {
      setError('system', err)
    }
  }, [wake, desktop?.wake?.armed, setError])

  // The one line under Wake says why it is grey right now. The three reasons
  // are distinct and only one is ever true: this build cannot put a packet on
  // the wire at all, the desktop has never said which card to aim at, or the
  // desktop is awake and there is nothing to do.
  const wakeHint = !datagramsSupported()
    ? 'Android only'
    : !macBytes(desktop?.wake?.mac)
      ? 'Connect once so the desktop can say how to wake it'
      : waking
        ? `Waiting for the desktop, up to ${WAKE_WAIT}`
        : connected
          ? 'Wakes the desktop over LAN once it has slept'
          : 'Wakes the desktop over LAN'

  const player = media?.player
  const volume = media?.output?.percent ?? 0
  const muted = media?.output?.muted ?? false
  /** First load: connected, asked, nothing back yet and no refusal either. Afterwards the old numbers stay up. */
  const loadingMedia = connected && media === null && errors.load == null

  const volumeOk = connected && can('media', 'volume')
  const brightnessOk = connected && can('media', 'brightness') && media?.brightness != null
  const playerOk = connected && can('media', 'player')
  const hyprOk = connected && can('desktop', 'hyprland')

  return (
    <Screen>
      <ScreenHeader
        title="Remote"
        right={<IconButton icon="refresh-cw" label="Refresh" onPress={refreshAll} loading={refreshing} disabled={!connected} />}
      />

      <Card>
        <CardHeader icon={muted ? 'volume-x' : 'volume-2'} title="Volume" tone={volumeOk ? undefined : palette.muted} />
        {loadingMedia ? (
          <Loading />
        ) : (
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end' }}>
            <Stat
              value={media?.output ? `${volume}%` : '—'}
              label={muted ? 'Output muted' : 'Output'}
              tone={muted || !media?.output ? palette.light_foreground : undefined}
            />
            {media?.input ? (
              <Stat
                value={`${media.input.percent}%`}
                label={media.input.muted ? 'Mic muted' : 'Mic'}
                tone={media.input.muted ? palette.light_foreground : undefined}
                align="right"
              />
            ) : null}
          </View>
        )}
        <LevelBar
          value={volume}
          onChange={(percent) => act('volume', 'volume', 'volume.set', { percent })}
          tone={muted ? palette.muted : palette.accent}
          disabled={!volumeOk}
        />
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
          <IconButton
            icon="volume-x"
            label={muted ? 'Unmute' : 'Mute'}
            size={44}
            onPress={() => act('volume', 'mute', 'volume.mute', {}, refresh)}
            loading={busy === 'mute'}
            disabled={!volumeOk}
            tone={muted ? palette.red : undefined}
            style={muted ? { borderColor: alpha(palette.red, 0.45), backgroundColor: alpha(palette.red, 0.12) } : undefined}
          />
          <View style={{ flex: 1 }} />
          <IconButton icon="minus" label="Quieter" size={44} onPress={() => act('volume', 'vol-', 'volume.step', { delta: -5 })} loading={busy === 'vol-'} disabled={!volumeOk} />
          <IconButton icon="plus" label="Louder" size={44} onPress={() => act('volume', 'vol+', 'volume.step', { delta: 5 })} loading={busy === 'vol+'} disabled={!volumeOk} />
        </View>
        {connected && !can('media', 'volume') ? <Hint style={{ marginTop: space.md }}>Needs wpctl on the desktop</Hint> : null}
        <CardNotice error={errors.load} onDismiss={() => setError('load', null)} action={{ label: 'Try again', icon: 'refresh-cw', onPress: refreshAll }} />
        <CardNotice error={errors.volume} onDismiss={() => setError('volume', null)} />
      </Card>

      <Card>
        <CardHeader
          icon="music"
          title="Media"
          tone={playerOk ? undefined : palette.muted}
          right={player?.status && playerOk ? <Pill label={player.status} tone={player.playing ? palette.accent : undefined} /> : undefined}
        />
        {player?.title && playerOk ? (
          <View style={{ marginBottom: space.md }}>
            <Value numberOfLines={2}>{player.title}</Value>
            {player.artist ? <Label>{player.artist}</Label> : null}
          </View>
        ) : null}
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: space.lg }}>
          <IconButton icon="skip-back" label="Previous track" size={48} onPress={() => act('player', 'prev', 'player.previous', {}, refresh)} loading={busy === 'prev'} disabled={!playerOk} />
          <IconButton
            icon={player?.playing ? 'pause' : 'play'}
            label={player?.playing ? 'Pause' : 'Play'}
            size={56}
            tone={playerOk ? palette.bright_foreground : undefined}
            onPress={() => act('player', 'play', 'player.play', {}, refresh)}
            loading={busy === 'play'}
            disabled={!playerOk}
          />
          <IconButton icon="skip-forward" label="Next track" size={48} onPress={() => act('player', 'next', 'player.next', {}, refresh)} loading={busy === 'next'} disabled={!playerOk} />
        </View>
        {connected && !can('media', 'player') ? <Hint style={{ marginTop: space.md }}>Needs playerctl on the desktop</Hint> : null}
        <CardNotice error={errors.player} onDismiss={() => setError('player', null)} />
      </Card>

      <Card>
        <CardHeader icon="sun" title="Brightness" tone={brightnessOk ? undefined : palette.muted} />
        {loadingMedia ? (
          <Loading />
        ) : (
          <Stat
            value={media?.brightness ? `${media.brightness.percent}%` : '—'}
            label="Display"
            tone={media?.brightness ? undefined : palette.light_foreground}
          />
        )}
        <LevelBar
          value={media?.brightness?.percent ?? 0}
          onChange={(percent) => act('brightness', 'brightness', 'brightness.set', { percent })}
          tone={palette.yellow}
          disabled={!brightnessOk}
        />
        {connected && !can('media', 'brightness') ? (
          <Hint>Needs brightnessctl on the desktop</Hint>
        ) : connected && media && media.brightness == null ? (
          <Hint>No adjustable display on the desktop</Hint>
        ) : null}
        <CardNotice error={errors.brightness} onDismiss={() => setError('brightness', null)} />
      </Card>

      <Card>
        <CardHeader
          icon="grid"
          title="Workspaces"
          subtitle={hyprOk && activeWorkspace ? `active ${activeWorkspace}` : undefined}
          tone={hyprOk ? undefined : palette.muted}
        />
        {!hyprOk ? (
          <Hint>{connected ? 'Needs Hyprland on the desktop' : 'Waiting for the desktop'}</Hint>
        ) : workspaces.length === 0 && windows.length === 0 ? (
          <Empty icon="grid" text="No workspaces reported" />
        ) : (
          <>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>
              {workspaces.map((ws) => (
                <Chip
                  key={ws.id}
                  label={String(ws.id)}
                  active={ws.id === activeWorkspace}
                  onPress={() =>
                    act('workspaces', `ws-${ws.id}`, 'hypr.goto', { id: ws.id }, () => {
                      setActiveWorkspace(ws.id)
                      loadWindows()
                    })
                  }
                />
              ))}
            </View>
            <Divider />
            {windows.length ? (
              <>
                <Section title={windows.length === 1 ? '1 window' : `${windows.length} windows`} />
                {windows.slice(0, 12).map((win, i, shown) => (
                  <ListRow
                    key={win.address}
                    title={win.title || win.class}
                    subtitle={`${win.class} · ${win.workspace}`}
                    tone={win.focused ? undefined : palette.foreground}
                    last={i === shown.length - 1}
                    onPress={() => act('workspaces', `focus-${win.address}`, 'hypr.focus', { address: win.address }, loadWindows)}
                    right={
                      <IconButton
                        icon="x"
                        label="Close window"
                        onPress={() => act('workspaces', `close-${win.address}`, 'hypr.close', { address: win.address }, loadWindows)}
                        loading={busy === `close-${win.address}`}
                      />
                    }
                  />
                ))}
              </>
            ) : (
              <Empty icon="layout" text="No windows open" />
            )}
          </>
        )}
        <CardNotice error={errors.workspaces} onDismiss={() => setError('workspaces', null)} />
      </Card>

      <Card>
        <CardHeader icon="power" title="System" tone={connected || wakeable ? undefined : palette.muted} />
        <View style={{ gap: space.sm }}>
          <View style={{ flexDirection: 'row', gap: space.sm }}>
            <Button icon="lock" label="Lock" compact style={{ flex: 1 }} onPress={() => act('system', 'lock', 'system.power', { action: 'lock' })} loading={busy === 'lock'} disabled={!connected} />
            <Button icon="moon" label="Sleep" compact style={{ flex: 1 }} onPress={() => act('system', 'sleep', 'system.power', { action: 'sleep' })} loading={busy === 'sleep'} disabled={!connected} />
          </View>
          <View style={{ flexDirection: 'row', gap: space.sm }}>
            <Button
              icon="camera"
              label="Screenshot"
              compact
              style={{ flex: 1 }}
              onPress={() => act('system', 'shot', 'system.screenshot', { mode: 'fullscreen', target: 'copy' })}
              loading={busy === 'shot'}
              disabled={!connected || !can('desktop', 'screenshot')}
            />
            <Button icon="bell" label="Locate" compact style={{ flex: 1 }} onPress={() => act('system', 'locate', 'system.locate')} loading={busy === 'locate'} disabled={!connected} />
          </View>
          {connected && !can('desktop', 'screenshot') ? <Hint>Screenshot needs omarchy-capture-screenshot</Hint> : null}
          <Button icon="zap" label={waking ? 'Waking…' : 'Wake'} compact onPress={onWake} loading={waking} disabled={!wakeable || connected || waking} />
          <Hint>{wakeHint}</Hint>
          {woke && !connected ? <Notice error={woke.text} tone={woke.tone} onDismiss={() => setWoke(null)} style={{ marginBottom: 0 }} /> : null}
          <Divider style={{ marginVertical: space.xs }} />
          <View style={{ flexDirection: 'row', gap: space.sm }}>
            <Button icon="rotate-cw" label="Reboot" variant="danger" compact style={{ flex: 1 }} onPress={() => confirmPower('reboot')} loading={busy === 'reboot'} disabled={!connected} />
            <Button icon="power" label="Shut down" variant="danger" compact style={{ flex: 1 }} onPress={() => confirmPower('shutdown')} loading={busy === 'shutdown'} disabled={!connected} />
          </View>
        </View>
        <CardNotice error={errors.system} onDismiss={() => setError('system', null)} />
      </Card>
    </Screen>
  )
}

/* ── local pieces ─────────────────────────────────────────────────────── */

/** The first-load state of a card: a spinner where the reading will be, at the reading's height. */
function Loading() {
  const p = usePalette()
  return (
    <View style={{ height: 50, justifyContent: 'center', alignItems: 'flex-start' }}>
      <ActivityIndicator size="small" color={p.light_foreground} />
    </View>
  )
}

/** A `Notice` placed at the foot of a card: spaced from the controls above it, flush with the card's bottom padding. */
function CardNotice(props: React.ComponentProps<typeof Notice>) {
  if (props.error == null) return null
  return <Notice {...props} style={[{ marginTop: space.md, marginBottom: 0 }, props.style]} />
}
