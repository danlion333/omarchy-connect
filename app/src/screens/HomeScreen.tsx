import React, { useCallback, useEffect, useState } from 'react'
import { ActivityIndicator, RefreshControl, View } from 'react-native'
import { Feather } from '@expo/vector-icons'
import * as Haptics from 'expo-haptics'

import { useConnection, usePalette, useStats } from '../state/ConnectionContext'
import type { Stats } from '../api/client'
import { useLook } from '../ui/look'
import { TOGGLE_COMMAND, useToggles, type ToggleName } from '../lib/toggles'
import {
  Button,
  Buttons,
  Caps,
  Card,
  CardHeader,
  Chip,
  ChipRow,
  Divider,
  Empty,
  Hint,
  IconButton,
  Label,
  LevelBar,
  ListRow,
  Meter,
  Notice,
  Pill,
  Row,
  Screen,
  ScreenHeader,
  Section,
  Segmented,
  Sparkline,
  Stat,
  Tile,
  Tiles,
  Value,
  toneFor,
  useConfirm,
  useToast,
  type IconName,
} from '../ui/kit'
import { bytes, duration, ms, percent, rate } from '../lib/format'
import { space } from '../theme'

type MediaState = {
  output: { percent: number; muted: boolean } | null
  input: { percent: number; muted: boolean } | null
  brightness: { percent: number } | null
  player: { available: boolean; playing?: boolean; title?: string | null; artist?: string | null; status?: string }
}

type Workspace = { id: number; name: string; windows: number }
type Window = { address: string; title: string; class: string; workspace: number; focused: boolean }

const DNS_OPTIONS = [
  { value: 'DHCP', label: 'DHCP' },
  { value: 'Cloudflare', label: 'Cloudflare' },
  { value: 'Google', label: 'Google' },
  { value: 'Custom', label: 'Custom' },
] as const

type DnsProvider = (typeof DNS_OPTIONS)[number]['value']

/** Which card a failure belongs under. A notice sits where the thing that failed is. */
type CardKey = 'now' | 'load' | 'network' | 'media' | 'toggles' | 'quick'

/**
 * Workspace 1: the desktop at a glance, and the controls that change it.
 *
 * This is the old Stats and Remote tabs in one screen, in the mock's order:
 * what is on the screens right now, what the machine is doing under them, what
 * it is playing, the switches, and the six buttons that put it to sleep. Every
 * card is one thing the desktop said and one thing the phone can say back;
 * every tap answers with a toast naming the command that ran.
 */
export function HomeScreen() {
  const { hello, palette, status, call, can, desktop, watchStats } = useConnection()
  const stats = useStats()
  const look = useLook()
  const toast = useToast()
  const confirm = useConfirm()
  const { toggles, flip, refresh: refreshToggles, loading: togglesLoading, error: togglesError } = useToggles()

  const [media, setMedia] = useState<MediaState | null>(null)
  const [workspaces, setWorkspaces] = useState<Workspace[]>([])
  const [activeWorkspace, setActiveWorkspace] = useState<number | null>(null)
  const [windows, setWindows] = useState<Window[]>([])
  const [sawWindows, setSawWindows] = useState(false)
  /** The last 40 CPU samples, kept here because the link only ever holds the latest one. */
  const [history, setHistory] = useState<number[]>([])
  const [dns, setDns] = useState<DnsProvider | null>(null)
  const [dnsRetry, setDnsRetry] = useState<DnsProvider | null>(null)
  const [errors, setErrors] = useState<Partial<Record<CardKey, unknown>>>({})
  const [busy, setBusy] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)

  const connected = status === 'connected'
  const hyprOk = connected && can('desktop', 'hyprland')
  const togglesOffered = can('desktop', 'toggles')
  const dnsOffered = can('desktop', 'dns')

  const setError = useCallback((card: CardKey, err: unknown) => {
    setErrors((prev) => ({ ...prev, [card]: err }))
  }, [])

  /* ── reading ──────────────────────────────────────────────────────── */

  // Somebody is looking at the numbers for as long as this screen is mounted.
  useEffect(() => watchStats(), [watchStats])

  useEffect(() => {
    const usage = stats?.cpu?.usage
    if (usage === null || usage === undefined) return
    setHistory((prev) => [...prev, Math.max(0, Math.min(100, usage * 100))].slice(-40))
  }, [stats?.at, stats?.cpu?.usage])

  const loadMedia = useCallback(async () => {
    if (!connected) return
    try {
      setMedia(await call<MediaState>('media.state'))
      setError('media', null)
    } catch (err) {
      setError('media', err)
    }
  }, [call, connected, setError])

  const loadHypr = useCallback(async () => {
    if (!connected || !can('desktop', 'hyprland')) return
    try {
      const [spaces, wins] = await Promise.all([
        call<{ workspaces: Workspace[]; activeId: number }>('hypr.workspaces'),
        call<{ windows: Window[] }>('hypr.windows'),
      ])
      setWorkspaces(spaces.workspaces)
      setActiveWorkspace(spaces.activeId)
      setWindows(wins.windows)
      setSawWindows(true)
      setError('now', null)
    } catch (err) {
      setError('now', err)
    }
  }, [call, can, connected, setError])

  const loadDns = useCallback(async () => {
    if (!connected || !can('desktop', 'dns')) return
    try {
      const res = await call<{ provider: DnsProvider | null }>('dns.get')
      setDns(res.provider)
    } catch {
      /* the card still works without it */
    }
  }, [call, can, connected])

  useEffect(() => {
    void loadMedia()
    void loadHypr()
    void loadDns()
  }, [loadMedia, loadHypr, loadDns])

  const refreshAll = useCallback(async () => {
    setRefreshing(true)
    try {
      await Promise.all([
        loadMedia(),
        loadHypr(),
        loadDns(),
        refreshToggles(),
        call('system.stats').catch(() => null),
      ])
    } finally {
      setRefreshing(false)
    }
  }, [call, loadMedia, loadHypr, loadDns, refreshToggles])

  /* ── saying something back ────────────────────────────────────────── */

  /**
   * One command, with the answer the reader gets: a haptic tick, the toast
   * naming what ran on the desktop, and the failure under the card it came
   * from rather than at the top of the screen.
   */
  const act = useCallback(
    async (
      card: CardKey,
      key: string,
      method: string,
      params: Record<string, unknown>,
      note: { value: string; hint?: string } | null,
      after?: () => void,
    ) => {
      setBusy(key)
      setError(card, null)
      try {
        Haptics.selectionAsync().catch(() => {})
        const data = await call<any>(method, params)
        if (data && (data.output || data.brightness || data.input)) {
          setMedia((prev) => (prev ? { ...prev, ...data } : prev))
        }
        if (note) toast({ value: note.value, hint: note.hint ?? 'ran on desktop' })
        after?.()
      } catch (err) {
        setError(card, err)
      } finally {
        setBusy(null)
      }
    },
    [call, setError, toast],
  )

  const focusWindow = useCallback(
    (win: Window) =>
      act(
        'now',
        `focus-${win.address}`,
        'hypr.focus',
        { address: win.address },
        { value: `hyprctl dispatch focuswindow class:${win.class}`, hint: `workspace ${win.workspace}` },
        loadHypr,
      ),
    [act, loadHypr],
  )

  const closeWindow = useCallback(
    async (win: Window) => {
      const ok = await confirm({
        title: `Close ${win.class}?`,
        detail: `hyprctl dispatch closewindow address:${win.address}`,
        confirmLabel: 'Close',
      })
      if (!ok) return
      await act(
        'now',
        `close-${win.address}`,
        'hypr.close',
        { address: win.address },
        { value: `hyprctl dispatch closewindow class:${win.class}` },
        loadHypr,
      )
    },
    [act, confirm, loadHypr],
  )

  const gotoWorkspace = useCallback(
    (id: number) =>
      act('now', `ws-${id}`, 'hypr.goto', { id }, { value: `hyprctl dispatch workspace ${id}` }, () => {
        setActiveWorkspace(id)
        void loadHypr()
      }),
    [act, loadHypr],
  )

  const changeDns = useCallback(
    async (provider: DnsProvider) => {
      const previous = dns
      setDns(provider)
      setError('network', null)
      setDnsRetry(null)
      try {
        await call('dns.set', { provider })
        toast({ value: `omarchy-dns ${provider.toLowerCase()}`, hint: 'the desktop resolves through it now' })
      } catch (err) {
        setDns(previous)
        setError('network', err)
        setDnsRetry(provider)
      }
    },
    [call, dns, setError, toast],
  )

  const flipToggle = useCallback(
    async (name: ToggleName) => {
      setBusy(name)
      setError('toggles', null)
      try {
        Haptics.selectionAsync().catch(() => {})
        const state = await flip(name)
        toast({
          value: TOGGLE_COMMAND[name],
          hint: state ? `${state.on ? 'on' : 'off'} · ran on desktop` : 'ran on desktop',
        })
      } catch (err) {
        setError('toggles', err)
      } finally {
        setBusy(null)
      }
    },
    [flip, setError, toast],
  )

  const power = useCallback(
    async (action: 'sleep' | 'reboot' | 'shutdown', title: string, label: string, command: string) => {
      const ok = await confirm({ title, detail: command, confirmLabel: label })
      if (!ok) return
      await act('quick', action, 'system.power', { action, confirm: true }, { value: command })
    },
    [act, confirm],
  )

  /* ── what the cards are drawn from ────────────────────────────────── */

  const cpu = stats?.cpu
  const mem = stats?.memory
  const disk = stats?.disk
  const net = stats?.network
  const battery = stats?.battery
  const focused = windows.find((win) => win.focused) ?? null
  const player = media?.player
  const volume = media?.output?.percent ?? 0
  const muted = media?.output?.muted ?? false
  const brightness = media?.brightness?.percent ?? 0

  const volumeOk = connected && can('media', 'volume')
  const playerOk = connected && can('media', 'player')
  const brightnessOk = connected && can('media', 'brightness') && media?.brightness != null
  const mediaOk = volumeOk || playerOk

  const loadingNow = hyprOk && !sawWindows && errors.now == null
  const loadingMedia = connected && media === null && errors.media == null
  const memFraction = mem && mem.total ? mem.used / mem.total : 0
  const swapFraction = mem && mem.swapTotal ? mem.swapUsed / mem.swapTotal : 0
  const diskFraction = disk && disk.total ? disk.used / disk.total : 0
  const wifi = net?.type === 'wifi'

  const user = (hello?.host as { user?: string } | undefined)?.user
  const uptime = stats?.uptime ?? hello?.host?.uptime ?? null

  return (
    <Screen
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refreshAll} tintColor={palette.muted} />}
    >
      <ScreenHeader
        title={hello ? (user ? `${user}@${hello.host.hostname}` : hello.host.hostname) : 'Desktop'}
        dot={connected ? 'ok' : status === 'connecting' || status === 'pairing' || status === 'reconnecting' ? 'warn' : 'off'}
        // Theme and uptime only: with the kernel the line ran past a 360dp phone
        // ("lackluster-mint · 7.1.9-arch1-…"), and Setup carries the kernel.
        sub={[palette.name, uptime === null ? null : `up ${duration(uptime)}`]
          .filter(Boolean)
          .join(' · ')}
        right={
          <>
            <IconButton icon="refresh-cw" label="Refresh" onPress={refreshAll} loading={refreshing} disabled={!connected} />
            <IconButton
              icon="lock"
              label="Lock the desktop"
              onPress={() =>
                act('quick', 'lock', 'system.power', { action: 'lock' }, { value: 'omarchy-system-lock', hint: 'locked' })
              }
              loading={busy === 'lock'}
              disabled={!connected}
            />
          </>
        }
      />

      {/* ── Now ──────────────────────────────────────────────────────── */}
      <Card dim={!hyprOk}>
        <CardHeader
          title="Now"
          tone={hyprOk ? undefined : palette.muted}
          right={activeWorkspace ? <Pill label={`workspace ${activeWorkspace}`} variant="on" /> : undefined}
        />
        {!hyprOk ? (
          <Hint>{connected ? 'Needs Hyprland on the desktop' : 'Waiting for the desktop'}</Hint>
        ) : errors.now != null ? (
          <Notice
            error={errors.now}
            action={{ label: 'Try again', icon: 'refresh-cw', onPress: () => void loadHypr() }}
            onDismiss={() => setError('now', null)}
            style={{ marginBottom: 0 }}
          />
        ) : loadingNow ? (
          <Loading />
        ) : (
          <>
            <Row label="Focused" value={focused ? focused.class : '—'} />
            <Hint style={{ marginTop: -6 }}>{focused ? focused.title : 'Nothing focused'}</Hint>
            {workspaces.length ? (
              <ChipRow>
                {workspaces.map((ws) => (
                  <Chip
                    key={ws.id}
                    label={dotted(ws.id, ws.windows)}
                    active={ws.id === activeWorkspace}
                    onPress={() => gotoWorkspace(ws.id)}
                  />
                ))}
              </ChipRow>
            ) : null}
            <Divider />
            {windows.length === 0 ? (
              <Empty icon="layout" text="No windows open" />
            ) : (
              <>
                <Caps>{windows.length === 1 ? '1 window' : `${windows.length} windows`}</Caps>
                {windows.slice(0, 12).map((win, i, shown) => (
                  <ListRow
                    key={win.address}
                    icon={windowIcon(win.class)}
                    fill={win.focused}
                    title={win.class}
                    subtitle={win.title}
                    last={i === shown.length - 1}
                    onPress={() => focusWindow(win)}
                    right={
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.xs }}>
                        <Label style={{ color: palette.muted }}>{String(win.workspace)}</Label>
                        <IconButton
                          icon="x"
                          label={`Close ${win.class}`}
                          size={32}
                          onPress={() => closeWindow(win)}
                          loading={busy === `close-${win.address}`}
                        />
                      </View>
                    }
                  />
                ))}
              </>
            )}
          </>
        )}
      </Card>

      {/* ── Load ─────────────────────────────────────────────────────── */}
      <Card>
        <CardHeader
          title="Load"
          right={
            cpu?.tempC === null || cpu?.tempC === undefined ? undefined : (
              <Pill label={`${cpu.tempC}°C`} caps={false} variant={(cpu.usage ?? 0) > 0.7 ? 'warn' : 'default'} />
            )
          }
        />
        {!cpu || !mem ? (
          <Loading />
        ) : (
          <>
            <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: space.lg - 2 }}>
              <Stat value={percent(cpu.usage)} label="CPU" />
              <Sparkline data={history} style={{ flex: 1.6 }} />
            </View>
            <Row label="Memory" value={`${bytes(mem.used)} / ${bytes(mem.total)}`} />
            <Meter fraction={memFraction} tone={toneFor(palette, memFraction)} />
            <Row label="Disk" value={disk ? `${percent(diskFraction)} of ${bytes(disk.total)}` : '—'} />
            {disk ? <Meter fraction={diskFraction} state={diskFraction > 0.85 ? 'warn' : 'ok'} /> : null}
            {mem.swapTotal ? (
              <>
                <Row label="Swap" value={`${bytes(mem.swapUsed)} / ${bytes(mem.swapTotal)}`} />
                <Meter fraction={swapFraction} tone={toneFor(palette, swapFraction)} />
              </>
            ) : null}
            <Row label="Load average" value={loadAverage(cpu.loadavg)} />
          </>
        )}
      </Card>

      {/* ── Battery, when the desktop has one ────────────────────────── */}
      {battery ? (
        <Card>
          <CardHeader
            icon={battery.charging ? 'battery-charging' : 'battery'}
            title="Battery"
            subtitle={battery.status}
            tone={batteryTone(palette, battery.percent, battery.charging)}
            right={battery.watts ? <Pill label={`${battery.watts} W`} caps={false} /> : undefined}
          />
          <Stat value={`${battery.percent}%`} label="Charge" tone={batteryTone(palette, battery.percent, battery.charging)} />
          <Meter fraction={battery.percent / 100} tone={batteryTone(palette, battery.percent, battery.charging)} />
          {battery.secondsLeft ? (
            <Row label={battery.charging ? 'Until full' : 'Time left'} value={duration(battery.secondsLeft)} />
          ) : null}
        </Card>
      ) : null}

      {/* ── Network ──────────────────────────────────────────────────── */}
      <Card tone={net && !net.up ? palette.red : undefined}>
        <CardHeader
          icon={!net ? 'activity' : !net.up ? 'wifi-off' : wifi ? 'wifi' : 'server'}
          title={!net ? 'Network' : !net.up ? 'Offline' : wifi ? 'Wi-Fi' : 'Ethernet'}
          subtitle={linkSubtitle(net)}
          tone={net && !net.up ? palette.red : undefined}
        />
        {!net ? (
          <Loading />
        ) : (
          <>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
              <Stat value={ms(net.pingMs)} label="Ping" tone={pingTone(palette, net.pingMs)} />
              <Stat
                value={net.packetLoss === null || net.packetLoss === undefined ? '—' : `${net.packetLoss}%`}
                label="Loss"
                tone={net.packetLoss ? palette.orange : undefined}
                align="right"
              />
            </View>
            <Row label="Down" value={rate(net.rxRate)} />
            <Row label="Up" value={rate(net.txRate)} />
            <Row label="Downloaded" value={bytes(net.rxTotal)} />
            <Row label="Uploaded" value={bytes(net.txTotal)} />
            {wifi ? <Row label="Network" value={net.ssid ?? '—'} /> : null}
            {wifi && net.signalDbm != null ? <Row label="Signal" value={`${net.signalDbm} dBm`} /> : null}
            <Row label="IP address" value={net.ip ?? '—'} />
            <Row label="Gateway" value={net.gateway ?? '—'} />
          </>
        )}

        <Divider />

        <Section title="DNS provider" tone={dnsOffered ? undefined : palette.muted} />
        <Segmented
          options={DNS_OPTIONS as unknown as { value: DnsProvider; label: string }[]}
          value={dns ?? (net?.dnsProvider as DnsProvider) ?? null}
          onChange={changeDns}
          disabled={!dnsOffered || !connected}
        />
        {!dnsOffered ? (
          <Hint icon="slash">Needs a sudo rule on the desktop</Hint>
        ) : errors.network != null ? (
          <Notice
            error={errors.network}
            onDismiss={() => {
              setError('network', null)
              setDnsRetry(null)
            }}
            action={dnsRetry ? { label: 'Try again', icon: 'refresh-cw', onPress: () => changeDns(dnsRetry) } : null}
            style={{ marginBottom: 0 }}
          />
        ) : null}
        {net?.dns?.length ? (
          <>
            <Section title="Resolvers" />
            {net.dns.map((address) => (
              <Value key={address}>{address}</Value>
            ))}
          </>
        ) : null}
      </Card>

      {/* ── Media ────────────────────────────────────────────────────── */}
      <Card dim={connected && !mediaOk}>
        <CardHeader
          icon="music"
          title={playerOk && player?.title ? player.title : 'Media'}
          subtitle={playerOk ? player?.artist ?? null : null}
          tone={mediaOk ? undefined : palette.muted}
          right={
            playerOk && player?.status ? (
              <Pill label={player.playing ? 'playing' : 'paused'} variant={player.playing ? 'on' : 'default'} />
            ) : undefined
          }
        />
        {loadingMedia ? (
          <Loading />
        ) : (
          <>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.xs }}>
              <IconButton
                icon="skip-back"
                label="Previous track"
                onPress={() => act('media', 'prev', 'player.previous', {}, { value: 'playerctl previous' }, loadMedia)}
                loading={busy === 'prev'}
                disabled={!playerOk}
              />
              <IconButton
                icon={player?.playing ? 'pause' : 'play'}
                label={player?.playing ? 'Pause' : 'Play'}
                tone={playerOk ? palette.bright_foreground : undefined}
                onPress={() =>
                  act(
                    'media',
                    'play',
                    'player.play',
                    {},
                    { value: 'playerctl play-pause', hint: player?.playing ? 'paused' : 'playing' },
                    loadMedia,
                  )
                }
                loading={busy === 'play'}
                disabled={!playerOk}
              />
              <IconButton
                icon="skip-forward"
                label="Next track"
                onPress={() => act('media', 'next', 'player.next', {}, { value: 'playerctl next' }, loadMedia)}
                loading={busy === 'next'}
                disabled={!playerOk}
              />
              <IconButton
                icon={muted ? 'volume-x' : 'volume-2'}
                label={muted ? 'Unmute' : 'Mute'}
                active={muted}
                tone={muted ? palette.red : undefined}
                onPress={() =>
                  act(
                    'media',
                    'mute',
                    'volume.mute',
                    {},
                    { value: 'wpctl set-mute @DEFAULT_AUDIO_SINK@ toggle', hint: muted ? 'unmuted' : 'muted' },
                    loadMedia,
                  )
                }
                loading={busy === 'mute'}
                disabled={!volumeOk}
              />
              <View style={{ flex: 1 }}>
                <LevelBar
                  value={volume}
                  onChange={(value) =>
                    act('media', 'volume', 'volume.set', { percent: value }, { value: `wpctl set-volume @DEFAULT_AUDIO_SINK@ ${value}%` })
                  }
                  tone={muted ? palette.muted : palette.accent}
                  disabled={!volumeOk}
                />
              </View>
              <Value style={{ width: 34, textAlign: 'right' }}>{media?.output ? String(volume) : '—'}</Value>
            </View>

            <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
              <Feather name="sun" size={20} color={brightnessOk ? palette.light_foreground : palette.muted} />
              <View style={{ flex: 1 }}>
                <LevelBar
                  value={brightness}
                  onChange={(value) =>
                    act('media', 'brightness', 'brightness.set', { percent: value }, { value: `brightnessctl set ${value}%` })
                  }
                  tone={palette.yellow}
                  disabled={!brightnessOk}
                />
              </View>
              <Value style={{ width: 34, textAlign: 'right' }}>{media?.brightness ? String(brightness) : '—'}</Value>
            </View>

            {media?.input ? (
              <Row label={media.input.muted ? 'Mic muted' : 'Mic'} value={`${media.input.percent}%`} />
            ) : null}

            {connected && !can('media', 'player') ? (
              <Hint>Needs playerctl on the desktop</Hint>
            ) : connected && !can('media', 'volume') ? (
              <Hint>Needs wpctl on the desktop</Hint>
            ) : connected && !can('media', 'brightness') ? (
              <Hint>Brightness needs brightnessctl on the desktop</Hint>
            ) : connected && media && media.brightness == null ? (
              <Hint>No adjustable display on the desktop</Hint>
            ) : null}
          </>
        )}
        {errors.media != null ? (
          <Notice error={errors.media} onDismiss={() => setError('media', null)} style={{ marginBottom: 0 }} />
        ) : null}
      </Card>

      {/* ── Toggles ──────────────────────────────────────────────────── */}
      <Card>
        <CardHeader title="Toggles" />
        {togglesOffered && toggles === null && togglesLoading ? (
          <Loading />
        ) : (
          <Tiles>
            <Tile
              icon="moon"
              label="Nightlight"
              state={stateWord(toggles?.nightlight?.on)}
              on={toggles?.nightlight?.on === true}
              disabled={!connected || !togglesOffered || !toggles?.nightlight || busy === 'nightlight'}
              onPress={() => flipToggle('nightlight')}
            />
            <Tile
              icon="coffee"
              label="Stay awake"
              state={stateWord(toggles?.idle?.on)}
              on={toggles?.idle?.on === true}
              disabled={!connected || !togglesOffered || !toggles?.idle || busy === 'idle'}
              onPress={() => flipToggle('idle')}
            />
            {/* The tile is "Notifications", so it is on when the desktop is *not* silencing them. */}
            <Tile
              icon="bell"
              label="Notifications"
              state={stateWord(toggles?.silencing ? !toggles.silencing.on : undefined)}
              on={toggles?.silencing?.on === false}
              disabled={!connected || !togglesOffered || !toggles?.silencing || busy === 'silencing'}
              onPress={() => flipToggle('silencing')}
            />
            <Tile
              icon="droplet"
              label="Transparency"
              state={look.transparency ? 'on' : 'off'}
              on={look.transparency}
              onPress={() => {
                look.setTransparency(!look.transparency)
                toast({ value: 'transparency', hint: `${look.transparency ? 'off' : 'on'} · on this phone` })
              }}
            />
          </Tiles>
        )}
        {!togglesOffered ? (
          <Hint>{connected ? 'Needs the omarchy toggle scripts on the desktop' : 'Waiting for the desktop'}</Hint>
        ) : toggles && (!toggles.nightlight || !toggles.idle || !toggles.silencing) ? (
          <Hint>A switch this desktop cannot answer for is left grey</Hint>
        ) : null}
        {errors.toggles != null || togglesError != null ? (
          <Notice
            error={errors.toggles ?? togglesError}
            onDismiss={() => setError('toggles', null)}
            action={{ label: 'Try again', icon: 'refresh-cw', onPress: () => void refreshToggles() }}
            style={{ marginBottom: 0 }}
          />
        ) : null}
      </Card>

      {/* ── Quick ────────────────────────────────────────────────────── */}
      <Card>
        <CardHeader title="Quick" />
        <Buttons>
          <Button
            icon="camera"
            label="Shot"
            compact
            onPress={() =>
              act(
                'quick',
                'shot',
                'system.screenshot',
                { mode: 'fullscreen', target: 'copy' },
                { value: 'omarchy-capture-screenshot', hint: 'saved on the desktop' },
              )
            }
            loading={busy === 'shot'}
            disabled={!connected || !can('desktop', 'screenshot')}
          />
          <Button
            icon="monitor"
            label="Saver"
            compact
            onPress={() =>
              act('quick', 'saver', 'system.power', { action: 'screensaver' }, { value: 'omarchy-launch-screensaver' })
            }
            loading={busy === 'saver'}
            disabled={!connected}
          />
          <Button
            icon="bell"
            label="Find"
            compact
            onPress={() => act('quick', 'locate', 'system.locate', {}, { value: 'notify-send', hint: 'the desktop is calling out' })}
            loading={busy === 'locate'}
            disabled={!connected}
          />
        </Buttons>
        {connected && !can('desktop', 'screenshot') ? <Hint>Shot needs omarchy-capture-screenshot</Hint> : null}
        <Buttons>
          <Button
            icon="moon"
            label="Suspend"
            variant="ghost"
            compact
            onPress={() => power('sleep', 'Suspend the desktop?', 'Suspend', 'systemctl suspend')}
            loading={busy === 'sleep'}
            disabled={!connected}
          />
          <Button
            icon="rotate-cw"
            label="Reboot"
            variant="ghost"
            compact
            onPress={() => power('reboot', 'Reboot the desktop?', 'Reboot', 'omarchy-system-reboot')}
            loading={busy === 'reboot'}
            disabled={!connected}
          />
          <Button
            icon="power"
            label="Off"
            variant="ghost"
            compact
            onPress={() => power('shutdown', 'Shut down the desktop?', 'Shut down', 'omarchy-system-shutdown')}
            loading={busy === 'shutdown'}
            disabled={!connected}
          />
        </Buttons>
        {errors.quick != null ? (
          <Notice error={errors.quick} onDismiss={() => setError('quick', null)} style={{ marginBottom: 0 }} />
        ) : null}
      </Card>
    </Screen>
  )
}

/* ── the small decisions ─────────────────────────────────────────────── */


/** The chip for a workspace: its number, then one dot per window on it. */
function dotted(id: number, windows: number): string {
  return windows > 0 ? `${id} ${'·'.repeat(Math.min(windows, 5))}` : String(id)
}

/** The glyph for a window, by what kind of program its class says it is. */
function windowIcon(cls: string): IconName {
  const name = cls.toLowerCase()
  if (/alacritty|foot|kitty|ghostty|wezterm|nvim|vim|term/.test(name)) return 'terminal'
  if (/spotify|music|mpv|vlc/.test(name)) return 'music'
  if (/signal|telegram|discord|slack|element/.test(name)) return 'message-square'
  return 'globe'
}

function stateWord(on: boolean | undefined): string {
  return on === undefined ? '—' : on ? 'on' : 'off'
}

function loadAverage(load: number[] | undefined) {
  if (!load?.length) return '—'
  return load
    .slice(0, 3)
    .map((v) => v.toFixed(2))
    .join(' · ')
}

/** The interface and, when the kernel says, its speed or signal: `enp8s0 · 1 Gbit/s`. */
function linkSubtitle(net: Stats['network'] | undefined) {
  if (!net) return null
  const parts: string[] = []
  if (net.interface) parts.push(net.interface)
  if (net.type === 'wifi') {
    if (net.signalQuality != null) parts.push(`${net.signalQuality}% signal`)
  } else if (net.linkSpeedMbit) {
    parts.push(net.linkSpeedMbit >= 1000 ? `${net.linkSpeedMbit / 1000} Gbit/s` : `${net.linkSpeedMbit} Mbit/s`)
  }
  return parts.length ? parts.join(' · ') : null
}

function pingTone(palette: { green: string; orange: string; red: string }, value: number | null | undefined) {
  if (value === null || value === undefined) return undefined
  if (value > 120) return palette.red
  if (value > 40) return palette.orange
  return undefined
}

function batteryTone(palette: { green: string; orange: string; red: string }, pct: number, charging: boolean) {
  if (charging) return palette.green
  if (pct <= 10) return palette.red
  if (pct <= 25) return palette.orange
  return undefined
}

/* ── local pieces (candidates for the kit) ───────────────────────────── */

/** The first-load state of a card: a spinner where the reading will be, at the reading's height. */
function Loading() {
  const p = usePalette()
  return (
    <View style={{ height: 50, justifyContent: 'center', alignItems: 'flex-start' }} accessibilityRole="progressbar">
      <ActivityIndicator size="small" color={p.light_foreground} />
    </View>
  )
}
