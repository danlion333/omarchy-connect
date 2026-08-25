import React, { useCallback, useEffect, useRef, useState } from 'react'
import { ActivityIndicator, TextInput, View } from 'react-native'
import { CameraView, useCameraPermissions } from 'expo-camera'

import { useConnection } from '../state/ConnectionContext'
import { Body, Button, Caps, Card, CardHeader, Empty, ListRow, Screen, Segmented, Title } from '../ui/kit'
import { DEFAULT_PORT, parsePairingUrl, probeHost, scanSubnet, type Discovered, type PairingTarget } from '../api/discovery'
import { font, radius, size, space } from '../theme'

type Mode = 'scan' | 'find' | 'manual'

export function PairScreen() {
  const { pair, palette } = useConnection()
  const [mode, setMode] = useState<Mode>('scan')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const attempt = useCallback(
    async (target: PairingTarget) => {
      setBusy(true)
      setError(null)
      try {
        await pair(target)
      } catch (err) {
        setError((err as Error).message)
      } finally {
        setBusy(false)
      }
    },
    [pair],
  )

  return (
    <Screen>
      <View style={{ marginBottom: space.xl }}>
        <Title style={{ fontSize: 26 }}>Omarchy Connect</Title>
        <Caps style={{ marginTop: space.xs }}>pair with your desktop</Caps>
      </View>

      <View style={{ marginBottom: space.lg }}>
        <Segmented<Mode>
          options={[
            { value: 'scan', label: 'Scan' },
            { value: 'find', label: 'Find' },
            { value: 'manual', label: 'Manual' },
          ]}
          value={mode}
          onChange={setMode}
          disabled={busy}
        />
      </View>

      {error ? (
        <Card>
          <Body tone={palette.red} style={{ fontSize: size.body }}>
            {error}
          </Body>
        </Card>
      ) : null}

      {busy ? (
        <Card>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
            <ActivityIndicator color={palette.accent} />
            <Body>Pairing…</Body>
          </View>
        </Card>
      ) : mode === 'scan' ? (
        <ScanPane onPaired={attempt} />
      ) : mode === 'find' ? (
        <FindPane onPaired={attempt} />
      ) : (
        <ManualPane onPaired={attempt} />
      )}

      <Card>
        <CardHeader icon="terminal" title="On the desktop" subtitle="one command" />
        <Body tone={palette.muted} style={{ fontSize: size.label, marginBottom: space.sm }}>
          Start the daemon and show a pairing code:
        </Body>
        <View
          style={{
            backgroundColor: palette.darker_background,
            borderRadius: radius.sm,
            padding: space.md,
            borderWidth: 1,
            borderColor: palette.lighter_background,
          }}
        >
          <Body tone={palette.accent} style={{ fontFamily: font.medium, fontSize: size.label }}>
            omarchy-connect start
          </Body>
        </View>
      </Card>
    </Screen>
  )
}

type PairFn = (target: PairingTarget) => void

function ScanPane({ onPaired }: { onPaired: PairFn }) {
  const { palette } = useConnection()
  const [permission, requestPermission] = useCameraPermissions()
  const [invalid, setInvalid] = useState(false)
  const handled = useRef(false)

  if (!permission) {
    return (
      <Card>
        <Empty icon="camera" text="Checking camera access…" />
      </Card>
    )
  }

  if (!permission.granted) {
    return (
      <Card>
        <CardHeader icon="camera-off" title="Camera" subtitle="needed to read the QR code" />
        <Body tone={palette.muted} style={{ marginBottom: space.md, fontSize: size.label }}>
          The pairing code is shown as a QR block in your terminal. Grant camera access to scan it, or pair
          manually instead.
        </Body>
        <Button icon="camera" label="Allow camera" onPress={requestPermission} variant="solid" />
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader icon="maximize" title="Scan" subtitle="point at the terminal" />
      <View
        style={{
          height: 300,
          borderRadius: radius.sm,
          overflow: 'hidden',
          borderWidth: 1,
          borderColor: palette.lighter_background,
        }}
      >
        <CameraView
          style={{ flex: 1 }}
          facing="back"
          barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
          onBarcodeScanned={({ data }) => {
            if (handled.current) return
            const parsed = parsePairingUrl(data)
            if (!parsed) {
              setInvalid(true)
              return
            }
            handled.current = true
            onPaired(parsed)
          }}
        />
      </View>
      {invalid ? (
        <Body tone={palette.orange} style={{ marginTop: space.md, fontSize: size.label }}>
          That is not an Omarchy Connect code.
        </Body>
      ) : null}
    </Card>
  )
}

function FindPane({ onPaired }: { onPaired: PairFn }) {
  const { palette } = useConnection()
  const [scanning, setScanning] = useState(false)
  const [progress, setProgress] = useState(0)
  const [found, setFound] = useState<Discovered[]>([])
  const [selected, setSelected] = useState<Discovered | null>(null)
  const [code, setCode] = useState('')

  const start = useCallback(async () => {
    setScanning(true)
    setFound([])
    setProgress(0)
    await scanSubnet(
      (desktop) => setFound((prev) => (prev.some((d) => d.host === desktop.host) ? prev : [...prev, desktop])),
      (done, total) => setProgress(done / total),
    )
    setScanning(false)
  }, [])

  useEffect(() => {
    start()
  }, [start])

  if (selected) {
    return (
      <CodeEntry
        title={selected.name}
        subtitle={`${selected.host}:${selected.port}`}
        code={code}
        setCode={setCode}
        onCancel={() => setSelected(null)}
        onSubmit={() =>
          onPaired({
            host: selected.host,
            port: selected.port,
            code,
            name: selected.name,
            publicKey: selected.publicKey,
            tls: selected.tls,
            certPin: selected.certPin,
          })
        }
        fingerprint={selected.fingerprint}
      />
    )
  }

  return (
    <Card>
      <CardHeader
        icon="search"
        title="Desktops nearby"
        subtitle={scanning ? `scanning ${Math.round(progress * 100)}%` : `${found.length} found`}
        right={<Button icon="refresh-cw" variant="ghost" onPress={start} disabled={scanning} />}
      />
      {found.length ? (
        found.map((desktop) => (
          <ListRow
            key={desktop.host}
            title={desktop.name}
            subtitle={`${desktop.host}:${desktop.port} · v${desktop.version}${desktop.pairing ? ' · pairing open' : ''}${
              desktop.fingerprint ? `\n${desktop.fingerprint}` : ''
            }`}
            onPress={() => setSelected(desktop)}
            tone={desktop.pairing ? palette.green : undefined}
            right={<Caps tone={palette.muted}>pair</Caps>}
          />
        ))
      ) : scanning ? (
        <View style={{ alignItems: 'center', paddingVertical: space.xl }}>
          <ActivityIndicator color={palette.accent} />
        </View>
      ) : (
        <Empty icon="wifi-off" text="No desktop answered on this network. Is the daemon running?" />
      )}
    </Card>
  )
}

function ManualPane({ onPaired }: { onPaired: PairFn }) {
  const { palette } = useConnection()
  const [host, setHost] = useState('')
  const [port, setPort] = useState(String(DEFAULT_PORT))
  const [code, setCode] = useState('')
  const [checking, setChecking] = useState(false)
  const [reachable, setReachable] = useState<string | null>(null)

  const check = useCallback(async () => {
    setChecking(true)
    setReachable(null)
    const info = await probeHost(host.trim(), Number(port) || DEFAULT_PORT)
    setReachable(
      info
        ? `${info.name} · v${info.version}${info.tls ? ' · tls' : ''}${info.fingerprint ? ` · ${info.fingerprint}` : ''}`
        : 'no answer from that address',
    )
    setChecking(false)
  }, [host, port])

  return (
    <Card>
      <CardHeader icon="edit-3" title="Manual" subtitle="address and code" />
      <Field label="Host" value={host} onChange={setHost} placeholder="192.168.1.100" keyboardType="numbers-and-punctuation" />
      <Field label="Port" value={port} onChange={setPort} placeholder={String(DEFAULT_PORT)} keyboardType="number-pad" />
      <Field label="Code" value={code} onChange={setCode} placeholder="123456" keyboardType="number-pad" maxLength={6} />
      {reachable ? (
        <Body tone={reachable.startsWith('no answer') ? palette.red : palette.green} style={{ fontSize: size.label, marginBottom: space.md }}>
          {reachable}
        </Body>
      ) : null}
      <View style={{ flexDirection: 'row', gap: space.sm }}>
        <Button icon="activity" label="Test" onPress={check} loading={checking} disabled={!host.trim()} style={{ flex: 1 }} />
        <Button
          icon="link"
          label="Pair"
          variant="solid"
          onPress={() =>
            onPaired({
              host: host.trim(),
              port: Number(port) || DEFAULT_PORT,
              code,
              name: host.trim(),
              publicKey: null,
              // Filled in from the desktop itself: a typed address pins
              // nothing, so the transport is discovered rather than declared.
              tls: false,
              certPin: null,
            })
          }
          disabled={!host.trim() || code.length !== 6}
          style={{ flex: 1 }}
        />
      </View>
    </Card>
  )
}

function CodeEntry({
  title,
  subtitle,
  code,
  setCode,
  onCancel,
  onSubmit,
  fingerprint,
}: {
  title: string
  subtitle: string
  code: string
  setCode: (v: string) => void
  onCancel: () => void
  onSubmit: () => void
  fingerprint?: string | null
}) {
  const { palette } = useConnection()
  return (
    <Card>
      <CardHeader icon="key" title={title} subtitle={subtitle} />
      {fingerprint ? (
        <View style={{ marginBottom: space.md }}>
          <Caps style={{ marginBottom: space.xs }}>desktop fingerprint</Caps>
          <Body tone={palette.accent} style={{ fontFamily: font.medium, fontSize: size.label }}>
            {fingerprint}
          </Body>
          <Body tone={palette.muted} style={{ fontSize: size.micro, marginTop: space.xs }}>
            it should match what `omarchy-connect pair` prints
          </Body>
        </View>
      ) : null}
      <Field label="Pairing code" value={code} onChange={setCode} placeholder="123456" keyboardType="number-pad" maxLength={6} />
      <View style={{ flexDirection: 'row', gap: space.sm }}>
        <Button label="Back" icon="arrow-left" onPress={onCancel} style={{ flex: 1 }} />
        <Button label="Pair" icon="link" variant="solid" onPress={onSubmit} disabled={code.length !== 6} style={{ flex: 1 }} />
      </View>
    </Card>
  )
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  keyboardType,
  maxLength,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  placeholder?: string
  keyboardType?: 'default' | 'number-pad' | 'numbers-and-punctuation'
  maxLength?: number
}) {
  const { palette } = useConnection()
  return (
    <View style={{ marginBottom: space.md }}>
      <Caps style={{ marginBottom: space.xs }}>{label}</Caps>
      <TextInput
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        placeholderTextColor={palette.muted}
        keyboardType={keyboardType}
        maxLength={maxLength}
        autoCapitalize="none"
        autoCorrect={false}
        style={{
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
    </View>
  )
}
