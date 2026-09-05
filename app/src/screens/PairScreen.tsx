import React, { useCallback, useEffect, useRef, useState } from 'react'
import { ActivityIndicator, Linking, View } from 'react-native'
import { CameraView, useCameraPermissions } from 'expo-camera'

import { useConnection, usePalette } from '../state/ConnectionContext'
import {
  Body,
  Button,
  Card,
  CardHeader,
  Empty,
  Field,
  Hint,
  IconButton,
  ListRow,
  Notice,
  Pill,
  Row,
  Screen,
  ScreenHeader,
  Segmented,
  Title,
} from '../ui/kit'
import { DEFAULT_PORT, parsePairingUrl, probeHost, scanSubnet, type Discovered, type PairingTarget } from '../api/discovery'
import { acceptsFrame, nextPhase, type ScanEvent, type ScanPhase } from '../lib/pair-scan'
import { alpha, radius, space, touch } from '../theme'

type Mode = 'scan' | 'find' | 'manual'

/** The one line under a code box that is not six digits yet. */
const codeError = (code: string) => (code.length && !/^\d{6}$/.test(code) ? 'Six digits' : null)

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
      <ScreenHeader title="Pair" />

      <View style={{ marginBottom: space.xl }}>
        <Title>Omarchy Connect</Title>
        <Hint style={{ marginTop: space.xs }}>Scan the QR your desktop printed</Hint>
      </View>

      <Notice error={notice} tone="info" />

      <View style={{ marginBottom: space.md }}>
        <Segmented<Mode>
          options={[
            { value: 'scan', label: 'Scan' },
            { value: 'find', label: 'Nearby' },
            { value: 'manual', label: 'Type' },
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

      {/*
        In scan mode the pane stays mounted through an attempt and says
        "Pairing…" over its own preview. Swapping it out was what reset the
        camera's "already handled this" latch on every failure, and it also
        cost a camera restart and a flash of "Checking camera access…" between
        attempts. The other two panes have no such latch, so while an attempt
        runs they give way to one card with the spinner in it.
      */}
      {mode === 'scan' ? (
        <ScanPane phase={scanPhase} invalid={invalid} onFrame={onFrame} onScanAgain={scanAgain} />
      ) : busy ? (
        <Card>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md, minHeight: touch }}>
            <ActivityIndicator color={palette.accent} />
            <Body>Pairing…</Body>
          </View>
        </Card>
      ) : mode === 'find' ? (
        <FindPane onPaired={attempt} />
      ) : (
        <ManualPane onPaired={attempt} />
      )}
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

  // The viewfinder is a square whatever the sensor's aspect: a QR is square,
  // and a box that keeps its shape from "checking" through "denied" to "live"
  // is a card that does not jump while the permission dialog is up.
  const frame = {
    aspectRatio: 1,
    borderRadius: radius.sm,
    overflow: 'hidden' as const,
    borderWidth: 1,
    borderColor: palette.lighter_background,
    backgroundColor: palette.darker_background,
  }

  if (!permission) {
    return (
      <Card>
        <CardHeader icon="maximize" title="Scan" subtitle="camera" />
        <View style={[frame, { alignItems: 'center', justifyContent: 'center' }]}>
          <ActivityIndicator color={palette.accent} />
        </View>
      </Card>
    )
  }

  if (!permission.granted) {
    // Once Android has heard "no" twice the dialog never comes back, and
    // asking a third time does nothing at all — the only way in is the app's
    // own settings page, so that is where the button goes.
    const blocked = !permission.canAskAgain
    return (
      <Card>
        <CardHeader icon="camera-off" title="Scan" subtitle="no camera access" tone={palette.muted} />
        <View style={[frame, { justifyContent: 'center' }]}>
          <Empty
            icon="camera-off"
            text={blocked ? 'Camera blocked · Allow it in Android settings' : 'Needs the camera to read the QR'}
            action={
              blocked
                ? { label: 'Open settings', icon: 'settings', onPress: () => void Linking.openSettings() }
                : { label: 'Allow camera', icon: 'camera', onPress: () => void requestPermission() }
            }
          />
        </View>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader
        icon="maximize"
        title="Scan"
        subtitle={phase === 'pairing' ? 'pairing' : phase === 'stopped' ? 'stopped' : 'point at the terminal'}
      />
      <View style={frame}>
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
          as a broken app. An attempt in flight is drawn the same way, for the
          same reason: the code is in frame and nothing visible is happening.
        */}
        {phase !== 'armed' ? (
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
              gap: space.lg,
              backgroundColor: alpha(palette.background, 0.82),
            }}
          >
            {phase === 'pairing' ? (
              <>
                <ActivityIndicator color={palette.accent} />
                <Body>Pairing…</Body>
              </>
            ) : (
              <>
                <Body style={{ textAlign: 'center' }}>Stopped after that attempt</Body>
                <Button icon="refresh-cw" label="Scan again" variant="solid" onPress={onScanAgain} />
              </>
            )}
          </View>
        ) : null}
      </View>
      {invalid && phase !== 'stopped' ? (
        <Hint icon="alert-triangle" tone={palette.orange} style={{ marginTop: space.md }}>
          Not an Omarchy Connect code
        </Hint>
      ) : (
        <Hint icon="terminal" style={{ marginTop: space.md }}>
          No QR yet · Run omarchy-connect pair on the desktop
        </Hint>
      )}
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
        title="Nearby desktops"
        subtitle={scanning ? `scanning ${Math.round(progress * 100)}%` : `${found.length} found`}
        right={<IconButton icon="refresh-cw" label="Scan the network again" onPress={start} loading={scanning} />}
      />
      {found.length ? (
        found.map((desktop, i) => (
          <ListRow
            key={desktop.host}
            title={desktop.name}
            subtitle={`${desktop.host}:${desktop.port} · v${desktop.version}`}
            onPress={desktop.paired ? undefined : () => setSelected(desktop)}
            tone={desktop.paired ? palette.muted : undefined}
            right={desktop.paired ? <Pill label="taken" tone={palette.orange} /> : desktop.pairing ? <Pill label="open" tone={palette.green} /> : null}
            chevron={!desktop.paired}
            last={i === found.length - 1}
          />
        ))
      ) : scanning ? (
        <View style={{ alignItems: 'center', paddingVertical: space.xl }}>
          <ActivityIndicator color={palette.accent} />
        </View>
      ) : (
        <Empty
          icon="wifi-off"
          text="No desktop answered · Check Wi-Fi and the daemon"
          action={{ label: 'Scan again', icon: 'refresh-cw', onPress: start }}
        />
      )}
    </Card>
  )
}

/** A port a socket can be opened on, or nothing typed yet. */
const portError = (port: string) => {
  if (!port.trim()) return null
  const n = Number(port)
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? null : '1–65535'
}

function ManualPane({ onPaired }: { onPaired: PairFn }) {
  const palette = usePalette()
  const [host, setHost] = useState('')
  const [port, setPort] = useState(String(DEFAULT_PORT))
  const [code, setCode] = useState('')
  const [checking, setChecking] = useState(false)
  // `null` until the address has been checked; then what the check found,
  // with `info: null` meaning nothing answered there.
  const [probe, setProbe] = useState<{ info: Discovered | null } | null>(null)
  const taken = probe?.info?.paired === true

  const check = useCallback(async () => {
    setChecking(true)
    setProbe(null)
    const info = await probeHost(host.trim(), Number(port) || DEFAULT_PORT)
    setProbe({ info })
    setChecking(false)
  }, [host, port])

  const desktop = probe?.info ?? null

  return (
    <Card>
      <CardHeader icon="edit-3" title="Address and code" subtitle="beside the QR on the desktop" />
      <Field
        label="Address"
        value={host}
        onChange={(v) => {
          setHost(v)
          setProbe(null)
        }}
        placeholder="192.168.1.100"
        keyboardType="numbers-and-punctuation"
        error={probe && !desktop ? 'No desktop answered here' : null}
      />
      <View style={{ flexDirection: 'row', gap: space.md }}>
        <View style={{ flex: 1 }}>
          <Field
            label="Port"
            value={port}
            onChange={(v) => {
              setPort(v)
              setProbe(null)
            }}
            placeholder={String(DEFAULT_PORT)}
            keyboardType="number-pad"
            error={portError(port)}
          />
        </View>
        <View style={{ flex: 1 }}>
          <Field label="Code" value={code} onChange={setCode} placeholder="123456" keyboardType="number-pad" maxLength={6} error={codeError(code)} />
        </View>
      </View>
      {desktop ? (
        <View style={{ marginBottom: space.md }}>
          <Row label="Desktop" value={desktop.name} tone={taken ? palette.orange : palette.green} />
          <Row label="Version" value={`v${desktop.version}${desktop.tls ? ' · TLS' : ''}`} />
          {desktop.fingerprint ? <Row label="Fingerprint" value={desktop.fingerprint} /> : null}
          {taken ? (
            <Hint icon="alert-triangle" tone={palette.orange} style={{ marginTop: space.sm }}>
              Already holds another phone · Unpair it on the desktop first
            </Hint>
          ) : null}
        </View>
      ) : null}
      <View style={{ flexDirection: 'row', gap: space.sm }}>
        <Button icon="activity" label="Check" onPress={check} loading={checking} disabled={!host.trim()} style={{ flex: 1 }} />
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

/**
 * The last step of the Nearby path: the desktop's fingerprint to check
 * against the one it printed, and the six digits that prove the reader is
 * looking at that terminal. "Pair" is the confirmation — there is no separate
 * "looks right" because the code cannot be typed from anywhere else.
 */
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
  return (
    <Card>
      <CardHeader icon="key" title={title} subtitle={subtitle} />
      {fingerprint ? (
        <View style={{ marginBottom: space.md }}>
          <Row label="Fingerprint" value={fingerprint} />
          <Hint style={{ marginTop: space.xs }}>Must match what the desktop printed</Hint>
        </View>
      ) : null}
      <Field
        label="Pairing code"
        value={code}
        onChange={setCode}
        placeholder="123456"
        keyboardType="number-pad"
        maxLength={6}
        error={codeError(code)}
      />
      <View style={{ flexDirection: 'row', gap: space.sm }}>
        <Button label="Cancel" icon="x" onPress={onCancel} style={{ flex: 1 }} />
        <Button label="Pair" icon="link" variant="solid" onPress={onSubmit} disabled={code.length !== 6} style={{ flex: 1 }} />
      </View>
    </Card>
  )
}
