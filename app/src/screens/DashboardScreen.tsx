import React, { useCallback, useEffect, useState } from 'react'
import { RefreshControl, View } from 'react-native'

import { useConnection, useStats } from '../state/ConnectionContext'
import { Body, Caps, Card, CardHeader, DataGrid, Divider, Meter, Notice, Screen, Segmented, StatusDot, Value, toneFor } from '../ui/kit'
import { bytes, duration, ms, percent, rate } from '../lib/format'
import { size, space } from '../theme'

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
      try {
        await call('dns.set', { provider })
      } catch (err) {
        setDns(previous)
        setDnsError(err)
      }
    },
    [call, dns],
  )

  const net = stats?.network
  const mem = stats?.memory
  const cpu = stats?.cpu

  const linkLabel = (() => {
    if (!net || !net.up) return 'Offline'
    if (net.type === 'wifi') return net.ssid ? `Wi-Fi (${net.ssid})` : 'Wi-Fi'
    const speed = net.linkSpeedMbit
    const pretty = speed ? (speed >= 1000 ? `${speed / 1000}gbit` : `${speed}mbit`) : null
    return pretty ? `Ethernet (${pretty})` : 'Ethernet'
  })()

  const traffic = (net?.rxRate ?? 0) + (net?.txRate ?? 0)
  const linkState = !net?.up ? 'Link down' : traffic > 2048 ? 'Handling packets' : 'Idle'

  const memFraction = mem && mem.total ? mem.used / mem.total : 0
  const diskFraction = stats?.disk && stats.disk.total ? stats.disk.used / stats.disk.total : 0

  return (
    <Screen refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={palette.muted} />}>
      <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: space.lg, gap: space.sm }}>
        <StatusDot tone={status === 'connected' ? palette.green : status === 'error' ? palette.red : palette.orange} />
        <Caps tone={palette.foreground}>{hello?.server.name ?? 'not connected'}</Caps>
        <View style={{ flex: 1 }} />
        <Caps>{stats ? `up ${duration(stats.uptime)}${latencyMs === null ? '' : ` · ${latencyMs}ms`}` : status}</Caps>
      </View>

      <Card>
        <CardHeader
          icon={net?.type === 'wifi' ? 'wifi' : 'server'}
          title={linkLabel}
          subtitle={linkState}
          tone={net?.up ? palette.bright_foreground : palette.red}
          right={
            <View style={{ alignItems: 'flex-end' }}>
              <Value tone={palette.accent} style={{ fontSize: size.body }}>
                {net?.interface ?? '—'}
              </Value>
            </View>
          }
        />

        <DataGrid
          pairs={[
            { label: 'Ping', value: ms(net?.pingMs), tone: pingTone(palette, net?.pingMs) },
            { label: 'Packet Loss', value: net?.packetLoss === null || net?.packetLoss === undefined ? '—' : `${net.packetLoss}%`, tone: net?.packetLoss ? palette.orange : undefined },
            { label: 'Receiving', value: rate(net?.rxRate) },
            { label: 'Sending', value: rate(net?.txRate) },
            { label: 'Downloaded', value: bytes(net?.rxTotal) },
            { label: 'Uploaded', value: bytes(net?.txTotal) },
            { label: 'IP Address', value: net?.ip ?? '—' },
            { label: 'Gateway', value: net?.gateway ?? '—' },
          ]}
        />

        <Divider />

        <Caps style={{ marginBottom: space.md }}>DNS provider</Caps>
        <Segmented
          options={DNS_OPTIONS as unknown as { value: DnsProvider; label: string }[]}
          value={dns ?? (net?.dnsProvider as DnsProvider) ?? null}
          onChange={changeDns}
          disabled={!can('desktop', 'dns') || status !== 'connected'}
        />
        {dnsError ? (
          <Notice error={dnsError} style={{ marginTop: space.sm, marginBottom: 0 }} onDismiss={() => setDnsError(null)} />
        ) : net?.dns?.length ? (
          <Body tone={palette.muted} style={{ marginTop: space.sm, fontSize: size.label }}>
            {net.dns.join('  ')}
          </Body>
        ) : null}
      </Card>

      <Card>
        <CardHeader
          icon="cpu"
          title={percent(cpu?.usage ?? null)}
          subtitle={`${cpuLabel(hello)} · load ${cpu?.loadavg?.[0]?.toFixed(2) ?? '—'}`}
          right={cpu?.tempC ? <Value tone={cpu.tempC > 80 ? palette.red : palette.foreground}>{`${cpu.tempC}°C`}</Value> : undefined}
        />
        <Meter fraction={cpu?.usage ?? 0} tone={toneFor(palette, cpu?.usage ?? 0)} />

        <View style={{ height: space.lg }} />

        <DataGrid
          pairs={[
            { label: 'Memory', value: `${bytes(mem?.used)} / ${bytes(mem?.total)}` },
            { label: 'Swap', value: mem?.swapTotal ? bytes(mem.swapUsed) : 'none' },
          ]}
          columns={1}
        />
        <Meter fraction={memFraction} tone={toneFor(palette, memFraction)} />

        <View style={{ height: space.lg }} />

        <DataGrid
          pairs={[
            { label: 'Disk', value: stats?.disk ? `${bytes(stats.disk.used)} / ${bytes(stats.disk.total)}` : '—' },
            { label: 'Free', value: stats?.disk ? bytes(stats.disk.free) : '—' },
          ]}
          columns={1}
        />
        <Meter fraction={diskFraction} tone={toneFor(palette, diskFraction)} />
      </Card>

      {stats?.battery ? (
        <Card>
          <CardHeader
            icon={stats.battery.charging ? 'battery-charging' : 'battery'}
            title={`${stats.battery.percent}%`}
            subtitle={stats.battery.status}
            tone={batteryTone(palette, stats.battery.percent, stats.battery.charging)}
            right={stats.battery.watts ? <Value>{`${stats.battery.watts} W`}</Value> : undefined}
          />
          <Meter
            fraction={stats.battery.percent / 100}
            tone={batteryTone(palette, stats.battery.percent, stats.battery.charging)}
          />
          {stats.battery.secondsLeft ? (
            <Body tone={palette.muted} style={{ marginTop: space.md, fontSize: size.label }}>
              {`${duration(stats.battery.secondsLeft)} remaining`}
            </Body>
          ) : null}
        </Card>
      ) : null}

      <Card>
        <CardHeader icon="monitor" title={hello?.server.name ?? 'desktop'} subtitle={`${palette.name} theme`} />
        <DataGrid
          pairs={[
            { label: 'OS', value: hello?.host?.os ?? 'Omarchy' },
            { label: 'Kernel', value: hello?.host?.kernel ?? '—' },
            { label: 'Cores', value: hello?.host?.cores ?? '—' },
            { label: 'Version', value: hello?.server.version ?? '—' },
            { label: 'Uptime', value: stats ? duration(stats.uptime) : '—' },
            { label: 'Protocol', value: `v${hello?.protocol ?? '—'}` },
          ]}
        />
      </Card>
    </Screen>
  )
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

function cpuLabel(hello: { host?: { cpuModel?: string } } | null) {
  const model = hello?.host?.cpuModel
  if (!model) return 'processor'
  return model.replace(/\(R\)|\(TM\)|CPU|Processor/gi, '').replace(/\s+/g, ' ').trim()
}
