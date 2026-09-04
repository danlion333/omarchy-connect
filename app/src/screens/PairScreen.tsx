import React, { useCallback, useEffect, useRef, useState } from 'react'
import { ActivityIndicator, View } from 'react-native'
import { CameraView, useCameraPermissions } from 'expo-camera'

import { useConnection, usePalette } from '../state/ConnectionContext'
import { Body, Button, Caps, Card, CardHeader, Empty, Field, ListRow, Notice, Screen, Segmented, Title } from '../ui/kit'
import { DEFAULT_PORT, parsePairingUrl, probeHost, scanSubnet, type Discovered, type PairingTarget } from '../api/discovery'
import { acceptsFrame, nextPhase, type ScanEvent, type ScanPhase } from '../lib/pair-scan'
import { alpha, font, radius, size, space } from '../theme'

type Mode = 'scan' | 'find' | 'manual'

/**
 * `notice` is the one thing this screen says that is not about pairing: a
 * share arrived from another app and there is no desktop to send it to yet.
 * Saying so here is the difference between a refusal and a disappearance.
 */
export function PairScreen({ notice }: { notice?: string | null } = {}) {
  const { pair, palette } = useConnection()
  const [mode, setMode] = useState<Mode>('scan')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)

  // The scanner's phase is held here, above the pane that draws the camera,
  // and in two places on purpose. The state is what the screen renders; the
  // ref is what `onBarcodeScanned` reads, because frames arrive several times a
  // second and a state update that React has not committed yet would let the
  // same code through twice. Both live in `PairScreen`, which stays mounted
  // across an attempt — the pane below does not.
  const phase = useRef<ScanPhase>('armed')
  const [scanPhase, setScanPhase] = useState<ScanPhase>('armed')
  const [invalid, setInvalid] = useState(false)

  const moveScan = useCallback((event: ScanEvent) => {
    const next = nextPhase(phase.current, event)
    phase.current = next
    setScanPhase(next)
    return next
  }, [])

  const attempt = useCallback(
    async (target: PairingTarget, fromScan = false) => {
      setBusy(true)
      setError(null)
      try {
        await pair(target)
      } catch (err) {
        setError(err)
        // The scanner stops itself here rather than on the way back into the
        // pane: the QR is still in front of the lens, and anything that arms
        // it without the user asking is the retry loop this screen used to be.
        if (fromScan) moveScan('attempt-failed')
      } finally {
        setBusy(false)
      }
    },
    [moveScan, pair],
  )

  /** One frame off the camera, and the only place a scan starts an attempt. */
  const onFrame = useCallback(
    (data: string) => {
      if (!acceptsFrame(phase.current)) return
      const parsed = parsePairingUrl(data)
      if (!parsed) {
        setInvalid(true)
        moveScan('invalid-code')
        return
      }
      setInvalid(false)
      moveScan('valid-code')
      void attempt(parsed, true)
    },
    [attempt, moveScan],
  )

  /** The gesture. Nothing else in this screen arms the camera again. */
  const scanAgain = useCallback(() => {
    setError(null)
    setInvalid(false)
    moveScan('scan-again')
  }, [moveScan])

  return (
    <Screen>
      <View style={{ marginBottom: space.xl }}>
        <Title style={{ fontSize: 26 }}>Omarchy Connect</Title>
        <Caps style={{ marginTop: space.xs }}>pair with your desktop</Caps>
        <Notice error={notice} tone="warning" style={{ marginTop: space.md }} />
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

      <Notice
        error={error}
        onDismiss={() => setError(null)}
        action={mode === 'scan' && scanPhase === 'stopped' ? { label: 'Scan again', icon: 'refresh-cw', onPress: scanAgain } : null}
      />

      {busy ? (
        <Card>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
            <ActivityIndicator color={palette.accent} />
            <Body>Pairing…</Body>
          </View>
        </Card>
      ) : null}

      {/*
        In scan mode the pane stays mounted through an attempt, under the
        "Pairing…" card rather than instead of it. Swapping it out was what
        reset the camera's "already handled this" latch on every failure, and
        it also cost a camera restart and a flash of "Checking camera access…"
        between attempts.
      */}
      {mode === 'scan' ? (
        <ScanPane phase={scanPhase} invalid={invalid} onFrame={onFrame} onScanAgain={scanAgain} />
      ) : busy ? null : mode === 'find' ? (
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
        <Body tone={palette.muted} style={{ fontSize: size.micro, marginTop: space.md }}>
          A desktop pairs with one phone at a time. If it already has one, run `omarchy-connect unpair` there to free
          it before pairing this phone.
        </Body>
      </Card>
    </Screen>
  )
}

type PairFn = (target: PairingTarget) => void

/**
 * The camera, and nothing else: whether a frame counts is decided above, so
 * this pane owns no state that a remount could quietly reset. It draws what the
 * phase says — live, waiting on an attempt, or stopped after one failed — and
 * carries its own "Scan again" for the case where the error notice above it has
 * been dismissed and its button went with it.
 */
function ScanPane({
  phase,
  invalid,
  onFrame,
  onScanAgain,
}: {
  phase: ScanPhase
  invalid: boolean
  onFrame: (data: string) => void
  onScanAgain: () => void
}) {
  const palette = usePalette()
  const [permission, requestPermission] = useCameraPermissions()

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
      <CardHeader
        icon="maximize"
        title="Scan"
        subtitle={phase === 'pairing' ? 'pairing…' : phase === 'stopped' ? 'stopped' : 'point at the terminal'}
      />
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
          onBarcodeScanned={({ data }) => onFrame(data)}
        />
        {/*
          A stopped scanner still shows the preview — the camera is exactly
          where the user left it — but says so over the top, so that a code
          sitting in frame and doing nothing reads as a decision rather than
          as a broken app.
        */}
        {phase === 'stopped' ? (
          <View
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              alignItems: 'center',
              justifyContent: 'center',
              padding: space.lg,
              backgroundColor: alpha(palette.background, 0.82),
            }}
          >
            <Body tone={palette.muted} style={{ fontSize: size.label, textAlign: 'center', marginBottom: space.md }}>
              Scanning stopped after that attempt. The same code will not be tried again on its own.
            </Body>
            <Button icon="refresh-cw" label="Scan again" variant="solid" onPress={onScanAgain} />
          </View>
        ) : null}
      </View>
      {invalid && phase !== 'stopped' ? (
        <Body tone={palette.orange} style={{ marginTop: space.md, fontSize: size.label }}>
          That is not an Omarchy Connect code.
        </Body>
      ) : null}
    </Card>
  )
}

function FindPane({ onPaired }: { onPaired: PairFn }) {
  const palette = usePalette()
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

  // A desktop pairs one phone at a time, so one that is already taken is
  // listed but not offered: tapping it would only end in a refusal from the
  // far end, and the way out of it is on the desktop, not here.
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
            subtitle={`${desktop.host}:${desktop.port} · v${desktop.version}${
              desktop.paired ? ' · another phone is paired' : desktop.pairing ? ' · pairing open' : ''
            }${desktop.fingerprint ? `\n${desktop.fingerprint}` : ''}`}
            onPress={desktop.paired ? undefined : () => setSelected(desktop)}
            tone={desktop.paired ? palette.muted : desktop.pairing ? palette.green : undefined}
            right={
              <Caps tone={desktop.paired ? palette.orange : palette.muted}>{desktop.paired ? 'taken' : 'pair'}</Caps>
            }
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
  const palette = usePalette()
  const [host, setHost] = useState('')
  const [port, setPort] = useState(String(DEFAULT_PORT))
  const [code, setCode] = useState('')
  const [checking, setChecking] = useState(false)
  const [reachable, setReachable] = useState<string | null>(null)
  const [taken, setTaken] = useState(false)

  const check = useCallback(async () => {
    setChecking(true)
    setReachable(null)
    setTaken(false)
    const info = await probeHost(host.trim(), Number(port) || DEFAULT_PORT)
    setTaken(info?.paired === true)
    setReachable(
      info
        ? info.paired
          ? `${info.name} already has a phone paired — unpair it on the desktop first`
          : `${info.name} · v${info.version}${info.tls ? ' · tls' : ''}${info.fingerprint ? ` · ${info.fingerprint}` : ''}`
        : 'no answer from that address',
    )
    setChecking(false)
  }, [host, port])

  return (
    <Card>
      <CardHeader icon="edit-3" title="Manual" subtitle="address and code" />
      <Body tone={palette.muted} style={{ fontSize: size.label, marginBottom: space.md }}>
        any address the desktop answers on will do — including the one its tunnel gave it, if you are
        pairing from somewhere else entirely. `omarchy-connect pair` prints that one beside the QR.
      </Body>
      <Field label="Host" value={host} onChange={setHost} placeholder="192.168.1.100" keyboardType="numbers-and-punctuation" />
      <Field label="Port" value={port} onChange={setPort} placeholder={String(DEFAULT_PORT)} keyboardType="number-pad" />
      <Field label="Code" value={code} onChange={setCode} placeholder="123456" keyboardType="number-pad" maxLength={6} />
      {reachable ? (
        <Body
          tone={reachable.startsWith('no answer') ? palette.red : taken ? palette.orange : palette.green}
          style={{ fontSize: size.label, marginBottom: space.md }}
        >
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
          disabled={!host.trim() || code.length !== 6 || taken}
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
  const palette = usePalette()
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

