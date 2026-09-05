import React, { useCallback, useEffect, useState } from 'react'
import { RefreshControl, View } from 'react-native'

import { useConnection, usePalette, useStats } from '../state/ConnectionContext'
import type { ConnectionStatus, Hello, Stats } from '../api/client'
import {
  Card,
  CardHeader,
  DataGrid,
  Divider,
  Hint,
  IconButton,
  Meter,
  Mono,
  Notice,
  Pill,
  Row,
  Screen,
  ScreenHeader,
  Section,
  Segmented,
  Stat,
  toneFor,
} from '../ui/kit'
import { bytes, duration, ms, percent, rate } from '../lib/format'
import { font, line, radius, size, space, type Palette } from '../theme'

const DNS_OPTIONS = [
  { value: 'DHCP', label: 'DHCP' },
  { value: 'Cloudflare', label: 'Cloudflare' },
  { value: 'Google', label: 'Google' },
  { value: 'Custom', label: 'Custom' },
] as const

type DnsProvider = (typeof DNS_OPTIONS)[number]['value']

export function DashboardScreen() {
  const { hello, palette, status, call, can, latencyMs, watchStats } = useConnection()
  const stats = useStats()
  const [dns, setDns] = useState<DnsProvider | null>(null)
  const [dnsError, setDnsError] = useState<unknown>(null)
  // The choice that failed, kept so the notice can offer it again in place.
  const [dnsRetry, setDnsRetry] = useState<DnsProvider | null>(null)
  const [refreshing, setRefreshing] = useState(false)

  const loadDns = useCallback(async () => {
    if (!can('desktop', 'dns')) return
    try {
      const res = await call<{ provider: DnsProvider | null }>('dns.get')
      setDns(res.provider)
    } catch {
      /* the card still works without it */
    }
  }, [call, can])

  useEffect(() => {
    if (status === 'connected') loadDns()
  }, [status, loadDns])

  /**
   * Mounted is looked at.
   *
   * The shell renders this screen only while its tab is the current one, so
   * mounting and unmounting is the whole of "is anybody reading the numbers"
   * — and the link takes the other half, the phone being awake at all. Until
   * one of the two says yes, the desktop is not sampling and not sending.
   */
  useEffect(() => watchStats(), [watchStats])

  const onRefresh = useCallback(async () => {
    setRefreshing(true)
    await Promise.all([loadDns(), call('system.stats').catch(() => null)])
    setRefreshing(false)
  }, [call, loadDns])

  const changeDns = useCallback(
    async (provider: DnsProvider) => {
      const previous = dns
      setDns(provider)
      setDnsError(null)
      setDnsRetry(null)
      try {
        await call('dns.set', { provider })
      } catch (err) {
        setDns(previous)
        setDnsError(err)
        setDnsRetry(provider)
      }
    },
    [call, dns],
  )

  const connected = status === 'connected'
  const net = stats?.network
  const mem = stats?.memory
  const cpu = stats?.cpu
  const wifi = net?.type === 'wifi'
  const dnsOffered = can('desktop', 'dns')

  const memFraction = mem && mem.total ? mem.used / mem.total : 0
  const swapFraction = mem && mem.swapTotal ? mem.swapUsed / mem.swapTotal : 0
  const diskFraction = stats?.disk && stats.disk.total ? stats.disk.used / stats.disk.total : 0
  const cpuTone = cpu?.tempC && cpu.tempC > 80 ? palette.red : undefined

  return (
    <Screen refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={palette.muted} />}>
      <ScreenHeader
        title="Stats"
        status={linkStatus(palette, status, hello)}
        right={
          <>
            {/* The numbers stop moving with the link; the header says so rather than letting them look live. */}
            {stats && !connected ? <Pill label="paused" icon="pause" /> : null}
            {connected && latencyMs !== null ? <Pill label={`${latencyMs} ms`} /> : null}
            <IconButton icon="refresh-cw" label="Refresh" onPress={onRefresh} loading={refreshing} disabled={!connected} />
          </>
        }
      />

      <Card tone={net && !net.up ? palette.red : undefined}>
        <CardHeader
          icon={!net ? 'activity' : !net.up ? 'wifi-off' : wifi ? 'wifi' : 'server'}
          title={!net ? 'Network' : !net.up ? 'Offline' : wifi ? 'Wi-Fi' : 'Ethernet'}
          subtitle={linkSubtitle(net)}
          tone={net && !net.up ? palette.red : undefined}
        />

        {!net ? (
          <Skeleton rows={6} />
        ) : (
          <>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: space.md }}>
              <Stat value={ms(net.pingMs)} label="Ping" tone={pingTone(palette, net.pingMs)} />
              <Stat
                value={net.packetLoss === null || net.packetLoss === undefined ? '—' : `${net.packetLoss}%`}
                label="Loss"
                tone={net.packetLoss ? palette.orange : undefined}
                align="right"
              />
            </View>

            {/* One column on purpose: the rates change every second and a grid
                that re-paired them each tick would jump between layouts. */}
            <DataGrid
              columns={1}
              pairs={[
                { label: 'Down', value: rate(net.rxRate) },
                { label: 'Up', value: rate(net.txRate) },
                { label: 'Downloaded', value: bytes(net.rxTotal) },
                { label: 'Uploaded', value: bytes(net.txTotal) },
                ...(wifi ? [{ label: 'Network', value: net.ssid ?? '—' }] : []),
                ...(wifi && net.signalDbm != null ? [{ label: 'Signal', value: `${net.signalDbm} dBm` }] : []),
                { label: 'IP address', value: net.ip ?? '—' },
                { label: 'Gateway', value: net.gateway ?? '—' },
              ]}
            />
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
          <Hint icon="slash" style={{ marginTop: space.sm }}>
            Not offered by this desktop
          </Hint>
        ) : dnsError ? (
          <Notice
            error={dnsError}
            style={{ marginTop: space.sm, marginBottom: 0 }}
            onDismiss={() => {
              setDnsError(null)
              setDnsRetry(null)
            }}
            action={dnsRetry ? { label: 'Try again', icon: 'refresh-cw', onPress: () => changeDns(dnsRetry) } : null}
          />
        ) : null}

        {net?.dns?.length ? (
          <>
            <Section title="Resolvers" style={{ marginTop: space.lg }} />
            {net.dns.map((address) => (
              <Address key={address}>{address}</Address>
            ))}
          </>
        ) : null}
      </Card>

      <Card>
        <CardHeader icon="cpu" title="System" subtitle={cpuLabel(hello)} />

        {!cpu || !mem ? (
          <Skeleton rows={5} />
        ) : (
          <>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: space.md }}>
              <Stat value={percent(cpu.usage)} label="Load" />
              <Stat value={cpu.tempC === null ? '—' : `${cpu.tempC}°C`} label="Temp" tone={cpuTone} align="right" />
            </View>
            <Meter fraction={cpu.usage ?? 0} tone={toneFor(palette, cpu.usage ?? 0)} />
            <Row label="Load average" value={loadAverage(cpu.loadavg)} style={{ marginTop: space.sm }} />

            <Divider />

            <Row label="Memory" value={`${bytes(mem.used)} / ${bytes(mem.total)}`} />
            <Meter fraction={memFraction} tone={toneFor(palette, memFraction)} style={{ marginBottom: space.md }} />

            <Row label="Swap" value={mem.swapTotal ? `${bytes(mem.swapUsed)} / ${bytes(mem.swapTotal)}` : 'None'} />
            {mem.swapTotal ? <Meter fraction={swapFraction} tone={toneFor(palette, swapFraction)} style={{ marginBottom: space.md }} /> : null}

            <Row label="Disk" value={stats?.disk ? `${bytes(stats.disk.used)} / ${bytes(stats.disk.total)}` : '—'} />
            <Row label="Free" value={stats?.disk ? bytes(stats.disk.free) : '—'} />
            {stats?.disk ? <Meter fraction={diskFraction} tone={toneFor(palette, diskFraction)} /> : null}
          </>
        )}
      </Card>

      {stats?.battery ? (
        <Card>
          <CardHeader
            icon={stats.battery.charging ? 'battery-charging' : 'battery'}
            title="Battery"
            subtitle={stats.battery.status}
            tone={batteryTone(palette, stats.battery.percent, stats.battery.charging)}
          />
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: space.md }}>
            <Stat
              value={`${stats.battery.percent}%`}
              label="Charge"
              tone={batteryTone(palette, stats.battery.percent, stats.battery.charging)}
            />
            {stats.battery.watts ? <Stat value={`${stats.battery.watts} W`} label="Draw" align="right" /> : null}
          </View>
          <Meter
            fraction={stats.battery.percent / 100}
            tone={batteryTone(palette, stats.battery.percent, stats.battery.charging)}
          />
          {stats.battery.secondsLeft ? (
            <Row label={stats.battery.charging ? 'Until full' : 'Time left'} value={duration(stats.battery.secondsLeft)} style={{ marginTop: space.sm }} />
          ) : null}
        </Card>
      ) : null}

      <Card>
        <CardHeader icon="monitor" title={hello?.server.name ?? 'Desktop'} subtitle={hello ? `${palette.name} theme` : null} />
        {!hello ? (
          <Skeleton rows={4} />
        ) : (
          <DataGrid
            pairs={[
              { label: 'OS', value: hello.host?.os ?? 'Omarchy' },
              { label: 'Kernel', value: hello.host?.kernel ?? '—' },
              { label: 'Version', value: hello.server.version },
              { label: 'Protocol', value: `v${hello.protocol}` },
              { label: 'Uptime', value: stats ? duration(stats.uptime) : '—' },
            ]}
          />
        )}
      </Card>
    </Screen>
  )
}

/**
 * The word beside the screen name. The desktop's own name while the link is
 * up — one glance says which machine these numbers belong to — and the
 * link's state in a colour otherwise. `parked` and `idle` both read "offline"
 * here: the reason belongs to the Setup tab, not to a stats header.
 */
function linkStatus(palette: Palette, status: ConnectionStatus, hello: Hello | null) {
  switch (status) {
    case 'connected':
      return { label: 'connected', tone: palette.green }
    case 'connecting':
    case 'pairing':
    case 'reconnecting':
      return { label: status, tone: palette.orange }
    case 'error':
      return { label: 'error', tone: palette.red }
    default:
      return { label: 'offline', tone: palette.light_foreground }
  }
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

function loadAverage(load: number[] | undefined) {
  if (!load?.length) return '—'
  return load
    .slice(0, 3)
    .map((v) => v.toFixed(2))
    .join('  ')
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
  return undefined as unknown as string
}

/**
 * The processor in the space of a card subtitle: `i5-12400F · 12 cores`.
 *
 * The marketing wrapper — "12th Gen Intel(R) Core(TM)", "AMD", "8-Core
 * Processor" — is stripped, because the reader has one desktop and knows
 * whose chip is in it; what varies, and what they might want to quote, is
 * the model number.
 */
function cpuLabel(hello: { host?: { cpuModel?: string; cores?: number } } | null) {
  const model = hello?.host?.cpuModel
  if (!model) return null
  const short = model
    .replace(/\(R\)|\(TM\)|\bCPU\b|\bProcessor\b|\d+(st|nd|rd|th) Gen|\bIntel\b|\bAMD\b|\bCore\b|\d+-Core|with Radeon Graphics|@.*$/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
  const cores = hello?.host?.cores
  return cores ? `${short} · ${cores} cores` : short
}

/* ── local components (candidates for the kit) ───────────────────────── */

/**
 * A network address on a line of its own, shrinking to fit rather than
 * truncating: a resolver like `fd7a:115c:a1e0::53` fits at full size, and
 * an uncompressed IPv6 still reads whole at a smaller one.
 */
function Address({ children }: { children: string }) {
  const palette = usePalette()
  return (
    <Mono
      numberOfLines={1}
      adjustsFontSizeToFit
      minimumFontScale={0.7}
      style={{ color: palette.bright_foreground, fontFamily: font.regular, fontSize: size.value, lineHeight: line.value, minHeight: line.value + space.xs }}
    >
      {children}
    </Mono>
  )
}

/**
 * Where rows will be once the first sample arrives: a label-shaped block on
 * the left, a value-shaped one on the right, at the height of a `Row`. Drawn
 * instead of an empty card so the screen has its final shape from the start.
 */
function Skeleton({ rows }: { rows: number }) {
  const palette = usePalette()
  const widths = [72, 96, 60, 84, 72, 108]
  return (
    <View accessibilityLabel="Loading" accessibilityRole="progressbar">
      {Array.from({ length: rows }, (_, i) => (
        <View key={i} style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', minHeight: line.value + space.sm }}>
          <View style={{ width: widths[i % widths.length], height: size.label, borderRadius: radius.sm / 2, backgroundColor: palette.lighter_background }} />
          <View style={{ width: widths[(i + 3) % widths.length], height: size.value, borderRadius: radius.sm / 2, backgroundColor: palette.lighter_background }} />
        </View>
      ))}
    </View>
  )
}
