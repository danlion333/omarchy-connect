import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ActivityIndicator, AppState, Linking, Platform, Pressable, View } from 'react-native'
import * as Clipboard from 'expo-clipboard'
import Constants from 'expo-constants'
import { Camera } from 'expo-camera'
import * as MediaLibrary from 'expo-media-library'

import { useConnection, usePalette } from '../state/ConnectionContext'
import {
  Button,
  Buttons,
  Card,
  CardHeader,
  Chip,
  Chips,
  Divider,
  Empty,
  Field,
  Hint,
  IconButton,
  Label,
  ListRow,
  Notice,
  Pill,
  Row,
  Screen,
  ScreenHeader,
  Section,
  Segmented,
  Toggle,
  Value,
  useConfirm,
  useToast,
  type IconName,
} from '../ui/kit'
import { useLook, useReportSetupAsks, type Wallpaper } from '../ui/look'
import { clock } from '../lib/format'
import {
  canAnswerCalls,
  canReadCallNotifications,
  canReadContacts,
  canSendMessages,
  openNotificationAccess,
  phoneMirrorSupported,
  phonePermission,
  requestCallPermission,
  requestPhonePermission,
  requestSendPermission,
} from '../api/phone'
import {
  backgroundLinkEnabled,
  backgroundLinkRunning,
  backgroundLinkSupported,
  canPostNotifications,
  hasMicPermission,
  isBatteryOptimized,
  micSupported,
  openBatterySettings,
  requestMicPermission,
  requestNotificationPermission,
  startBackgroundLink,
  stopBackgroundLink,
} from '../../modules/omarchy-link'
import { alertPrefs, setAlertPrefs, type AlertCategory, type AlertPrefs } from '../api/alerts'
import { saveAlertPrefs } from '../api/storage'
import { space } from '../theme'

/**
 * Setup, in the mock's language: the desktop at the top, then everything this
 * phone had to be given before the rest of the app could work.
 *
 * The order is who-owns-what rather than how-interesting-it-is. The first card
 * is the machine on the other end and every fact about how this socket reached
 * it; the next four are the phone's own half — the permissions Android holds,
 * the service that keeps the link up, what it may say from the shade, and how
 * it is painted; then the microphone, what the desktop can do, and the two
 * things that end a pairing.
 */
export function SettingsScreen() {
  const { hello, palette, status, latencyMs, reconnect, forget } = useConnection()
  const confirm = useConfirm()
  const toast = useToast()

  const connected = status === 'connected'
  const dialling = status === 'connecting' || status === 'reconnecting' || status === 'pairing'

  const telephony = Boolean((hello?.capabilities?.phone as any)?.mirror)
  const remote = hello?.link?.via === 'remote'

  const unpair = useCallback(async () => {
    const yes = await confirm({
      title: 'Unpair this desktop?',
      detail: 'The key is thrown away · pairing again needs a new code',
      confirmLabel: 'Unpair',
    })
    if (!yes) return
    await forget()
    toast({ value: 'unpaired', hint: 'the key was thrown away' })
  }, [confirm, forget, toast])

  return (
    <Screen>
      <ScreenHeader
        title="Setup"
        sub={headerLine(hello, latencyMs)}
        dot={connected ? 'ok' : dialling ? 'warn' : 'off'}
        right={
          <IconButton
            icon="refresh-cw"
            label="Reconnect"
            loading={dialling}
            onPress={() => {
              reconnect()
              toast({ value: 'omarchy-connect relink', hint: 'dialling the desktop again' })
            }}
          />
        }
      />

      <Desktop />
      <Permissions telephony={telephony} remote={remote} />
      <BackgroundLink />
      <Notifications />
      <Theme />
      <Microphone />
      <Capabilities capabilities={hello?.capabilities ?? {}} />
      <About />

      <Button icon="x-circle" label="Unpair this desktop" variant="destructive" onPress={() => void unpair()} />
    </Screen>
  )
}

/* ── the desktop ─────────────────────────────────────────────────────── */

/**
 * The machine on the other end, and every fact about how this socket got to
 * it: the key it was pinned to, the road it took, and the road it would take
 * if the first one went away.
 *
 * Remote access was a card of its own and is now a section of this one,
 * because it is an answer to the same question — where is this desktop and how
 * do I reach it — and it is not worth a header on a screen that already has
 * eight.
 */
function Desktop() {
  const { desktop, hello, palette, status, error, fingerprint, reconnect } = useConnection()
  const toast = useToast()
  const [copied, setCopied] = useState(false)

  const connected = status === 'connected'
  const dialling = status === 'connecting' || status === 'reconnecting' || status === 'pairing'

  const endpoints = hello?.endpoints ?? desktop?.endpoints ?? []
  const travelling = endpoints.filter((entry) => entry.kind !== 'lan')
  const fallback = travelling[0]

  const copyKey = useCallback(async () => {
    if (!fingerprint) return
    await Clipboard.setStringAsync(fingerprint)
    setCopied(true)
    toast({ value: fingerprint, hint: 'copied · compare with omarchy-connect status' })
  }, [fingerprint, toast])

  return (
    <Card>
      <CardHeader
        icon="monitor"
        title={hello?.host?.hostname ?? hello?.server.name ?? desktop?.name ?? 'No desktop'}
        subtitle={desktop ? `${desktop.host}:${desktop.port}` : 'not paired'}
        right={
          <Pill
            label={connected ? 'paired' : status === 'error' ? 'problem' : 'offline'}
            variant={connected ? 'on' : status === 'error' ? 'bad' : 'warn'}
          />
        }
      />
      {/* The whole fingerprint fits on its row, so nothing is hidden behind
          the tap; what the tap gives is the key in the clipboard, next to the
          `omarchy-connect status` it is meant to be compared with. */}
      <Pressable onPress={() => void copyKey()} accessibilityRole="button" accessibilityLabel="Copy the desktop's key">
        <Row label="Key" value={fingerprint ?? '—'} tone={copied ? palette.green : undefined} />
      </Pressable>
      <Row label="Transport" value={transportLabel(hello, desktop?.tls)} />
      <Row label="Daemon" value={hello ? `${hello.server.version} · v${hello.protocol}` : '—'} />
      <Row label="Paired" value={desktop ? clock(desktop.pairedAt) : '—'} />
      <Row
        label="Fallback"
        value={fallback ? `${kindLabel(fallback.kind)} · ready` : 'none'}
        tone={fallback ? undefined : palette.muted}
      />
      {!hello && dialling ? <Busy label="Connecting" /> : null}
      <Notice
        error={error}
        action={connected ? null : { label: 'Try again', icon: 'refresh-cw', onPress: reconnect }}
        style={{ marginBottom: 0 }}
      />
      <Buttons>
        <Button
          compact
          icon="refresh-cw"
          label="Reconnect"
          loading={dialling}
          onPress={() => {
            reconnect()
            toast({ value: 'omarchy-connect relink', hint: 'dialling the desktop again' })
          }}
        />
      </Buttons>

      <RemoteAccess />
    </Card>
  )
}

/**
 * The addresses this desktop can be reached at from off its own network, and
 * a way to add one it could not describe itself.
 *
 * A section rather than a card now: it is the same question as the Fallback
 * row above it, only answered in full. Everything it could do before it can
 * still do — the offered roads, the ones typed in by hand, and removing one.
 */
function RemoteAccess() {
  const { desktop, hello, palette, addEndpoint, removeEndpoint } = useConnection()
  const toast = useToast()
  const [host, setHost] = useState('')
  const [port, setPort] = useState(String(desktop?.port ?? 8765))
  const [checking, setChecking] = useState(false)
  const [outcome, setOutcome] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)

  const endpoints = desktop?.endpoints ?? []
  const travelling = endpoints.filter((entry) => entry.kind !== 'lan')
  const manual = travelling.filter((entry) => entry.source === 'manual')
  const offered = travelling.filter((entry) => entry.source !== 'manual')
  const remote = hello?.link?.via === 'remote'

  const submit = async () => {
    setChecking(true)
    setOutcome(null)
    const result = await addEndpoint(host, Number(port) || (desktop?.port ?? 8765))
    setChecking(false)
    if (result.ok) {
      toast({ value: host, hint: 'kept · this desktop answered there' })
      setHost('')
      setAdding(false)
      setOutcome(null)
      return
    }
    setOutcome(result.error ?? 'that address could not be used')
  }

  const form = adding ? (
    <>
      <Field
        label="Address"
        value={host}
        onChange={(next) => {
          setHost(next)
          if (outcome) setOutcome(null)
        }}
        placeholder="100.101.102.103"
        keyboardType="url"
        error={outcome}
        autoFocus
        onSubmit={host.trim() && !checking ? submit : undefined}
      />
      <Field label="Port" value={port} onChange={setPort} keyboardType="number-pad" maxLength={5} />
      <Buttons>
        <Button compact icon="check" label="Add" onPress={submit} loading={checking} disabled={!host.trim()} />
        <Button
          compact
          variant="ghost"
          label="Cancel"
          onPress={() => {
            setAdding(false)
            setOutcome(null)
          }}
        />
      </Buttons>
    </>
  ) : (
    <View style={{ flexDirection: 'row' }}>
      <Button compact variant="ghost" icon="plus" label="Add an address by hand" onPress={() => setAdding(true)} />
    </View>
  )

  return (
    <>
      <Divider />
      <Section
        title="Remote access"
        right={travelling.length ? <Pill label={remote ? 'in use' : 'ready'} variant={remote ? 'on' : 'default'} /> : null}
      />
      {offered.map((entry) => (
        <FitRow
          key={`${entry.host}:${entry.port}`}
          label={kindLabel(entry.kind)}
          value={`${entry.host}${entry.port === desktop?.port ? '' : `:${entry.port}`}`}
          tone={entry.host === desktop?.host ? palette.green : undefined}
        />
      ))}
      {manual.map((entry, i) => (
        <ListRow
          key={`${entry.host}:${entry.port}`}
          icon="map-pin"
          title={entry.host}
          subtitle={`port ${entry.port}`}
          tone={entry.host === desktop?.host ? palette.green : undefined}
          right={
            <IconButton
              icon="x"
              label="Remove this address"
              onPress={() => {
                void removeEndpoint(entry.host, entry.port)
                toast({ value: entry.host, hint: 'forgotten' })
              }}
            />
          }
          last={i === manual.length - 1}
        />
      ))}
      {travelling.length ? (
        <Hint>Calls and messages stay on the home network</Hint>
      ) : (
        <Hint>Not offered · switch it on with omarchy-connect remote on</Hint>
      )}
      {form}
    </>
  )
}

/* ── permissions ─────────────────────────────────────────────────────── */

type Ask = 'granted' | 'ask' | 'denied' | 'asking'
type PermKey = 'notifications' | 'microphone' | 'camera' | 'photos' | 'phone' | 'send' | 'answer' | 'caller' | 'contacts'
type Answers = Record<PermKey, Ask>

const NO_ANSWERS: Answers = {
  notifications: 'ask',
  microphone: 'ask',
  camera: 'ask',
  photos: 'ask',
  phone: 'ask',
  send: 'ask',
  answer: 'ask',
  caller: 'ask',
  contacts: 'ask',
}

/**
 * Everything Android has been asked for, in one place, with the answer beside
 * it and the ask a tap away.
 *
 * Only the permissions this build can actually read are listed. There is no
 * getter for `SYSTEM_ALERT_WINDOW` in either native module, so the mock's
 * "Display over other apps" row is not drawn: a row whose pill would be a
 * guess is worse than no row. The rest are read from the module that owns
 * them, re-read whenever the app comes back — every one of these is granted on
 * a screen that is not ours — and a second refusal in a row opens the app's
 * page in Android settings, which is the only road left once Android has
 * decided to stop asking.
 */
function Permissions({ telephony, remote }: { telephony: boolean; remote: boolean }) {
  const palette = usePalette()
  const toast = useToast()
  const report = useReportSetupAsks()

  const linkModule = backgroundLinkSupported()
  const micModule = micSupported()
  const tel = phoneMirrorSupported() && telephony

  const [answers, setAnswers] = useState<Answers>(NO_ANSWERS)
  const [loading, setLoading] = useState(true)
  const [canAskPhone, setCanAskPhone] = useState(true)
  const refusals = useRef<Partial<Record<PermKey, number>>>({})

  const read = useCallback(async () => {
    const next: Answers = { ...NO_ANSWERS }
    if (linkModule) next.notifications = canPostNotifications() ? 'granted' : 'ask'
    if (micModule) next.microphone = hasMicPermission() ? 'granted' : 'ask'
    next.camera = fromResponse(await Camera.getCameraPermissionsAsync().catch(() => null))
    next.photos = fromResponse(await MediaLibrary.getPermissionsAsync(true).catch(() => null))
    if (tel) {
      const held = await phonePermission()
      setCanAskPhone(held.canAskAgain)
      next.phone = held.granted ? 'granted' : held.canAskAgain ? 'ask' : 'denied'
      next.send = canSendMessages() ? 'granted' : 'ask'
      next.answer = canAnswerCalls() ? 'granted' : 'ask'
      next.caller = canReadCallNotifications() ? 'granted' : 'ask'
      next.contacts = canReadContacts() ? 'granted' : held.canAskAgain ? 'ask' : 'denied'
    }
    setAnswers(next)
    setLoading(false)
  }, [linkModule, micModule, tel])

  useEffect(() => {
    void read()
    // Half of these are granted on a system screen rather than in a dialog, so
    // coming back to the app is the only moment the answer can be learned.
    const subscription = AppState.addEventListener('change', (next) => {
      if (next === 'active') void read()
    })
    return () => subscription.remove()
  }, [read])

  const ask = useCallback(
    async (key: PermKey, title: string) => {
      setAnswers((was) => ({ ...was, [key]: 'asking' }))
      let granted = false
      let again = true
      try {
        switch (key) {
          case 'notifications':
            granted = await requestNotificationPermission()
            break
          case 'microphone':
            granted = await requestMicPermission()
            break
          case 'camera': {
            const result = await Camera.requestCameraPermissionsAsync()
            granted = result.granted
            again = result.canAskAgain
            break
          }
          case 'photos': {
            const result = await MediaLibrary.requestPermissionsAsync(true)
            granted = result.granted
            again = result.canAskAgain
            break
          }
          case 'phone': {
            const result = await requestPhonePermission()
            granted = result.granted
            again = result.canAskAgain
            break
          }
          case 'send':
            granted = await requestSendPermission()
            break
          case 'answer':
            granted = await requestCallPermission()
            break
          case 'contacts': {
            const result = await requestPhonePermission()
            granted = canReadContacts()
            again = result.canAskAgain
            break
          }
          case 'caller':
            // Notification access has no dialog, only a settings screen.
            await openNotificationAccess()
            toast({ value: 'Android settings', hint: 'notification access · allow Omarchy Connect' })
            await read()
            return
        }
      } catch {
        granted = false
      }
      if (granted) {
        refusals.current[key] = 0
        toast({ value: title, hint: 'granted' })
      } else {
        const count = (refusals.current[key] ?? 0) + 1
        refusals.current[key] = count
        if (count >= 2 || !again) {
          toast({ value: 'Android settings', hint: `${title} · turn it on there` })
          await Linking.openSettings().catch(() => {})
        } else {
          toast({ value: title, hint: 'not granted · tap once more to open settings' })
        }
      }
      await read()
    },
    [read, toast],
  )

  const rows = useMemo(() => {
    const list: { key: PermKey; icon: IconName; title: string; sub: string }[] = []
    if (linkModule) list.push({ key: 'notifications', icon: 'bell', title: 'Notifications', sub: 'The link, agents, files' })
    if (micModule) list.push({ key: 'microphone', icon: 'mic', title: 'Microphone', sub: 'Dictation, offer this mic' })
    list.push({ key: 'camera', icon: 'camera', title: 'Camera', sub: 'Scanning the pairing QR code' })
    list.push({ key: 'photos', icon: 'image', title: 'Photos and files', sub: 'Saving a picture to the gallery' })
    return list
  }, [linkModule, micModule])

  const calls = useMemo(() => {
    if (!tel) return []
    return [
      { key: 'phone' as PermKey, icon: 'phone' as IconName, title: 'Phone and SMS', sub: 'Mirrored to the desktop' },
      { key: 'answer' as PermKey, icon: 'phone-call' as IconName, title: 'Answer calls', sub: 'The audio stays on this phone' },
      { key: 'send' as PermKey, icon: 'message-square' as IconName, title: 'Reply by SMS', sub: 'Sending can cost money' },
      { key: 'caller' as PermKey, icon: 'user' as IconName, title: 'Caller ID', sub: 'Read off the dialler' },
      ...(answers.caller === 'granted'
        ? [{ key: 'contacts' as PermKey, icon: 'users' as IconName, title: 'Contact names', sub: 'Saved callers, by name' }]
        : []),
    ]
  }, [answers.caller, tel])

  const every = useMemo(() => [...rows, ...calls], [rows, calls])
  const granted = every.filter((row) => answers[row.key] === 'granted').length
  const waiting = every.length - granted

  // The Omarchy bar wears this number as a badge on workspace 5.
  useEffect(() => {
    report(loading ? 0 : waiting)
  }, [loading, report, waiting])

  const row = (entry: { key: PermKey; icon: IconName; title: string; sub: string }, last: boolean) => (
    <ListRow
      key={entry.key}
      icon={entry.icon}
      fill={answers[entry.key] === 'granted'}
      title={entry.title}
      subtitle={entry.sub}
      onPress={answers[entry.key] === 'asking' ? undefined : () => void ask(entry.key, entry.title)}
      right={<AskPill state={answers[entry.key]} />}
      last={last}
    />
  )

  return (
    <Card dim={!linkModule}>
      <CardHeader
        icon="smartphone"
        title="Permissions"
        subtitle="Tap a row to ask again"
        right={<Pill label={`${granted} of ${every.length}`} />}
      />
      {loading ? <Busy label="Reading permissions" /> : null}
      {rows.map((entry, i) => row(entry, i === rows.length - 1 && !calls.length))}
      {calls.length ? (
        <>
          <Divider />
          <Section title="Messages and calls" />
          {calls.map((entry, i) => row(entry, i === calls.length - 1))}
          {!canAskPhone ? (
            <Hint icon="alert-triangle" tone={palette.orange}>
              Allow SMS, calls and contacts in Android settings
            </Hint>
          ) : null}
          {remote ? <Hint>Off while on a remote link</Hint> : null}
        </>
      ) : null}
      <Hint>A denied row twice in a row opens Android settings for the app</Hint>
      {!linkModule ? (
        <Hint>{Platform.OS === 'ios' ? 'Not possible on iOS' : 'Needs the Android build'} · nothing here can be asked for</Hint>
      ) : null}
    </Card>
  )
}

/** Expo's permission answer, as one of the three words a pill can carry. */
function fromResponse(result: { granted: boolean; canAskAgain: boolean } | null): Ask {
  if (!result) return 'ask'
  return result.granted ? 'granted' : result.canAskAgain ? 'ask' : 'denied'
}

/** The state of one Android permission, as a word in a pill. */
function AskPill({ state }: { state: Ask }) {
  if (state === 'asking') return <Pill label="asking…" />
  if (state === 'granted') return <Pill label="granted" variant="on" icon="check" />
  if (state === 'denied') return <Pill label="denied" variant="bad" />
  return <Pill label="not asked" variant="warn" />
}

/* ── the phone's own half ────────────────────────────────────────────── */

/**
 * Whether this phone exists on the link when nobody is looking.
 *
 * Android suspends an app's timers the moment it leaves the screen and
 * reclaims the process soon after, which takes the socket, the keepalive and
 * every event with it. A foreground service is the only sanctioned way out,
 * and it costs a standing notification — so it is a choice made with the price
 * in front of the reader, not switched on behind their back. Battery
 * optimisation is the other half: several manufacturers run their own killer
 * on top of Doze, and the exemption is the one switch that answers to an app.
 */
function BackgroundLink() {
  const { palette, hello } = useConnection()
  const toast = useToast()
  const supported = backgroundLinkSupported()
  const [enabled, setEnabled] = useState(false)
  const [running, setRunning] = useState(false)
  const [optimized, setOptimized] = useState(false)
  const [shown, setShown] = useState(true)
  const [busy, setBusy] = useState(false)
  const [fault, setFault] = useState<unknown>(null)

  const sync = useCallback(() => {
    if (!supported) return
    setEnabled(backgroundLinkEnabled())
    setRunning(backgroundLinkRunning())
    setOptimized(isBatteryOptimized())
    setShown(canPostNotifications())
  }, [supported])

  useEffect(() => {
    sync()
    const subscription = AppState.addEventListener('change', (next) => {
      if (next === 'active') sync()
    })
    return () => subscription.remove()
  }, [sync])

  const enable = useCallback(async () => {
    setBusy(true)
    setFault(null)
    try {
      // Asked for first: without it the service still runs, but Android hides
      // its notification, and an invisible foreground service is the kind of
      // thing a reader is right to be annoyed to discover later.
      await requestNotificationPermission()
      startBackgroundLink()
      toast({ value: 'foreground service started', hint: 'the link stays up with the app closed' })
    } catch (err) {
      setFault(err)
    } finally {
      setBusy(false)
      sync()
    }
  }, [sync, toast])

  const disable = useCallback(() => {
    stopBackgroundLink()
    sync()
    toast({ value: 'foreground service stopped', hint: 'the link lives only while the app is open' })
  }, [sync, toast])

  const cannot = Platform.OS === 'ios' ? 'Not possible on iOS · pair over Bluetooth instead' : 'Needs the Android build'

  return (
    <Card dim={!supported}>
      <CardHeader
        icon="link"
        title="Background link"
        subtitle={supported ? (enabled ? 'standing notification' : 'only while open') : 'not available'}
        tone={supported ? undefined : palette.muted}
      />
      <Toggle
        label="Stay connected"
        hint={supported ? 'A standing notification keeps the link up with the app closed' : cannot}
        value={supported && enabled}
        onChange={(next) => (next ? void enable() : disable())}
        disabled={!supported || busy}
      />
      <Notice error={fault} action={{ label: 'Try again', onPress: () => void enable() }} style={{ marginBottom: 0 }} />
      <Divider />
      <Row
        label="Battery"
        value={optimized ? 'optimized · may sleep' : 'unrestricted'}
        tone={optimized ? palette.orange : undefined}
      />
      {optimized ? (
        <View style={{ flexDirection: 'row' }}>
          <Button
            compact
            variant="ghost"
            icon="battery-charging"
            label="Exempt from battery saver"
            onPress={() => {
              void openBatterySettings()
              toast({ value: 'Android settings', hint: 'battery · allow unrestricted' })
            }}
          />
        </View>
      ) : (
        <Hint>Android will not put the link to sleep</Hint>
      )}
      <Row label="Start at boot" value={supported && enabled ? 'yes' : 'no'} />
      {supported && enabled ? (
        <>
          <Row label="Service" value={running ? 'running' : 'stopped'} tone={running ? undefined : palette.orange} />
          <Row label="Notification" value={shown ? 'shown' : 'hidden'} tone={shown ? undefined : palette.orange} />
          {shown ? null : (
            <View style={{ flexDirection: 'row' }}>
              <Button compact variant="ghost" icon="bell" label="Show notification" loading={busy} onPress={() => void enable()} />
            </View>
          )}
        </>
      ) : null}
      <Divider />
      <Section title="This phone" />
      <Row label="Platform" value={hello?.device.platform ?? Platform.OS} />
      <Row label="Device id" value={hello?.device.id?.slice(0, 14) ?? '—'} />
    </Card>
  )
}

/**
 * What the phone may say from the shade, one switch per favour.
 *
 * Four rather than one, because the four are not the same favour: being told
 * an agent is waiting is worth a sound at midnight, being told the desktop
 * copied a word is worth a line at the bottom of the shade and nothing more.
 * All on by default — a notification nobody sees is an agent sitting idle and
 * a file nobody knew arrived.
 */
function Notifications() {
  const { palette, hello } = useConnection()
  const toast = useToast()
  const supported = backgroundLinkSupported()
  const [prefs, setPrefs] = useState<AlertPrefs>(alertPrefs)
  const [allowed, setAllowed] = useState(true)

  const sync = useCallback(() => {
    if (supported) setAllowed(canPostNotifications())
  }, [supported])

  useEffect(() => {
    sync()
    const subscription = AppState.addEventListener('change', (next) => {
      if (next === 'active') sync()
    })
    return () => subscription.remove()
  }, [sync])

  const flip = useCallback(
    async (key: AlertCategory, label: string) => {
      const next = { ...prefs, [key]: !prefs[key] }
      setPrefs(next)
      setAlertPrefs(next)
      await saveAlertPrefs(next).catch(() => {})
      toast({ value: label, hint: next[key] ? 'on' : 'off' })
      // Asked for the moment something is switched on rather than at launch: a
      // permission dialog nobody asked for is a dialog nobody reads.
      if (next[key]) {
        await requestNotificationPermission()
        sync()
      }
    },
    [prefs, sync, toast],
  )

  const reading = Boolean((hello?.capabilities?.agents as any)?.enabled)
  const alerts: { key: AlertCategory; label: string; hint: string }[] = [
    {
      key: 'waiting',
      label: 'Agent waiting',
      hint: reading ? 'With a reply box on the notification' : 'Idle until the desktop reads agents',
    },
    { key: 'done', label: 'Agent finished', hint: 'Only after a run of a minute or more' },
    { key: 'files', label: 'File arrived', hint: 'With Save for a picture or a video' },
    { key: 'clipboard', label: 'Desktop copied something', hint: 'Silent · hidden while the app is open' },
  ]
  const on = alerts.filter((row) => prefs[row.key]).length

  return (
    <Card dim={!supported}>
      <CardHeader
        icon="bell"
        title="Notifications"
        subtitle={!supported ? 'not available' : allowed ? 'allowed by Android' : 'blocked by Android'}
        tone={supported ? undefined : palette.muted}
        right={supported ? <Pill label={`${on} of ${alerts.length} on`} /> : null}
      />
      {supported ? (
        alerts.map((row) => (
          <Toggle
            key={row.key}
            label={row.label}
            hint={row.hint}
            value={prefs[row.key]}
            onChange={() => void flip(row.key, row.label)}
            disabled={!allowed}
          />
        ))
      ) : (
        <Hint>{Platform.OS === 'ios' ? 'Not possible on iOS' : 'Needs the Android build'}</Hint>
      )}
      {supported && !allowed ? (
        <>
          <Hint icon="alert-triangle" tone={palette.orange}>
            Notifications are blocked for this app in Android settings
          </Hint>
          <View style={{ flexDirection: 'row' }}>
            <Button
              compact
              variant="ghost"
              icon="bell"
              label="Allow notifications"
              onPress={() => {
                void requestNotificationPermission().then(sync)
              }}
            />
          </View>
        </>
      ) : null}
    </Card>
  )
}

/* ── the look ────────────────────────────────────────────────────────── */

const WALLPAPERS: { value: Wallpaper; label: string }[] = [
  { value: 'aurora', label: 'Aurora' },
  { value: 'dots', label: 'Dots' },
  { value: 'none', label: 'None' },
]

/**
 * The desktop's theme, and the two things about the look that are the phone's
 * own. The chips repaint the desktop as well as the phone — the app never
 * ships colours of its own — while the wallpaper and the glass are written on
 * this phone and nowhere else.
 */
function Theme() {
  const { palette, call, can, status } = useConnection()
  const { transparency, wallpaper, setTransparency, setWallpaper } = useLook()
  const toast = useToast()
  const [themes, setThemes] = useState<string[]>([])
  const [current, setCurrent] = useState<string | null>(null)
  const [switching, setSwitching] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [fault, setFault] = useState<unknown>(null)

  const connected = status === 'connected'
  const themeable = can('desktop', 'themes')

  const load = useCallback(async () => {
    if (!connected || !themeable) return
    setLoading(true)
    try {
      const res = await call<{ themes: string[]; current: string | null }>('theme.list')
      setThemes(res.themes)
      setCurrent(res.current)
      setFault(null)
    } catch (err) {
      setFault(err)
    } finally {
      setLoading(false)
    }
  }, [call, connected, themeable])

  useEffect(() => {
    void load()
  }, [load])

  const apply = useCallback(
    async (name: string) => {
      setSwitching(name)
      setFault(null)
      try {
        await call('theme.set', { name })
        setCurrent(name)
        toast({ value: `omarchy-theme-set ${name}`, hint: 'the desktop repainted' })
      } catch (err) {
        setFault(err)
      } finally {
        setSwitching(null)
      }
    },
    [call, toast],
  )

  return (
    <Card dim={!themeable}>
      <CardHeader
        icon="droplet"
        title="Theme"
        subtitle={`${(current ?? palette.name).replace(/-/g, ' ')} · follows the desktop`}
        tone={themeable ? undefined : palette.muted}
        right={
          themeable ? (
            <IconButton icon="refresh-cw" label="Reload themes" onPress={() => void load()} loading={loading || switching !== null} />
          ) : null
        }
      />
      {!themeable ? (
        <Hint>Needs omarchy-theme-list on the desktop</Hint>
      ) : themes.length ? (
        <Chips>
          {themes.map((name) => (
            <Chip
              key={name}
              label={name}
              active={name === current}
              disabled={switching === name}
              onPress={() => void apply(name)}
            />
          ))}
        </Chips>
      ) : loading ? (
        <Busy label="Loading themes" />
      ) : fault ? null : (
        <Empty icon="droplet" text="No themes on the desktop" />
      )}
      <Notice error={fault} action={{ label: 'Try again', icon: 'refresh-cw', onPress: () => void load() }} style={{ marginBottom: 0 }} />
      <Divider />
      <Section title="Background" />
      <Segmented
        options={WALLPAPERS}
        value={wallpaper}
        onChange={(kind) => {
          setWallpaper(kind)
          toast({ value: 'background', hint: `${kind} · on this phone` })
        }}
      />
      <Toggle
        label="Transparency"
        hint="Glass cards over the background · costs a little battery"
        value={transparency}
        onChange={(next) => {
          setTransparency(next)
          toast({ value: 'transparency', hint: next ? 'on · on this phone' : 'off · on this phone' })
        }}
      />
    </Card>
  )
}

/* ── the microphone ──────────────────────────────────────────────────── */

/**
 * The microphone, offered from the end that is holding it.
 *
 * The desktop could already ask for this phone's microphone with no screen
 * open at all, which is the right behaviour and an uncomfortable one to have
 * no window onto: without this card a person cannot offer the microphone in
 * their own hand, and cannot see when the machine in the other room is
 * listening to it. Everything on it is read out of the link rather than held
 * here — a recording outlives this screen.
 */
function Microphone() {
  const { palette, mic, status, can, offerMic, hello } = useConnection()
  const toast = useToast()
  const supported = micSupported()
  const connected = status === 'connected'
  const [granted, setGranted] = useState(true)

  useEffect(() => {
    if (!supported) return
    const sync = () => setGranted(hasMicPermission())
    sync()
    const subscription = AppState.addEventListener('change', (next) => {
      if (next === 'active') sync()
    })
    return () => subscription.remove()
  }, [supported])

  if (!hello) return null

  const offered = can('audio', 'receive')
  if (!offered || !supported) {
    return (
      <Card dim>
        <CardHeader icon="mic-off" title="Microphone" subtitle="not available" tone={palette.muted} />
        <Hint>
          {!offered
            ? "This desktop's daemon has no audio plugin"
            : Platform.OS === 'ios'
              ? 'Not possible on iOS'
              : 'Needs the Android build'}
        </Hint>
      </Card>
    )
  }

  return (
    <Card dim={!granted}>
      <CardHeader
        icon={mic.listening ? 'mic' : 'mic-off'}
        title="Microphone"
        subtitle={mic.listening ? 'the desktop is listening' : connected ? 'off' : 'not connected'}
        tone={mic.listening ? palette.red : undefined}
      />
      {mic.listening ? (
        <>
          <Row label="Started" value={mic.since ? clock(mic.since) : '—'} />
          <Row label="Stream" value={mic.stream === null ? '—' : `#${mic.stream}`} />
          {mic.path ? <FitRow label="Recording" value={mic.path} /> : null}
        </>
      ) : null}
      <Button
        compact
        icon={mic.listening ? 'mic-off' : 'mic'}
        label={mic.listening ? 'Stop the desktop listening' : 'Offer this microphone'}
        variant={mic.listening ? 'destructive' : 'default'}
        loading={mic.busy}
        disabled={!connected || mic.busy}
        onPress={() => {
          void offerMic()
          toast({
            value: mic.listening ? 'audio.stop' : 'audio.offer',
            hint: mic.listening ? 'stopped' : 'this mic is a source on the desktop',
          })
        }}
      />
      {!granted ? <Hint>Needs the Microphone permission above</Hint> : null}
      {!connected ? <Hint>Off while the link is down</Hint> : null}
      <Notice error={mic.error} style={{ marginBottom: 0 }} />
    </Card>
  )
}

/* ── what the desktop can do ─────────────────────────────────────────── */

/**
 * What the desktop said it can do, one section per plugin.
 *
 * The raw list is the most useful thing on this screen to somebody debugging a
 * plugin and the least useful to everybody else, so the card says how much
 * there is and the feature-by-feature list waits behind a button. A feature
 * the desktop answered `false` for is still listed, unlit, because "not there"
 * and "switched off" are different news.
 */
function Capabilities({ capabilities }: { capabilities: Record<string, Record<string, unknown>> }) {
  const palette = usePalette()
  const [open, setOpen] = useState(false)
  const groups = Object.entries(capabilities)
  const on = groups.reduce((sum, [, features]) => sum + Object.values(features).filter(Boolean).length, 0)

  if (!groups.length) {
    return (
      <Card dim>
        <CardHeader icon="check-circle" title="Capabilities" subtitle="not connected" tone={palette.muted} />
        <Empty icon="help-circle" text="Connect to see what the desktop can do" />
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader icon="check-circle" title="Capabilities" subtitle={`${groups.length} plugins · ${on} on`} />
      {open ? (
        groups.map(([plugin, features], i) => {
          const entries = Object.entries(features)
          const lit = entries.filter(([, enabled]) => Boolean(enabled)).length
          return (
            <View key={plugin} style={{ gap: space.sm }}>
              {i > 0 ? <Divider /> : null}
              <Section title={plugin} right={<Pill label={`${lit} of ${entries.length}`} />} />
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.xs + 2 }}>
                {entries.map(([feature, enabled]) => (
                  <Pill key={feature} label={featureLabel(feature)} tone={enabled ? palette.green : palette.muted} />
                ))}
              </View>
            </View>
          )
        })
      ) : (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.xs + 2 }}>
          {groups.map(([plugin, features]) => (
            <Pill key={plugin} label={`${plugin} ${Object.values(features).filter(Boolean).length}`} />
          ))}
        </View>
      )}
      <View style={{ flexDirection: 'row' }}>
        <Button
          compact
          variant="ghost"
          icon={open ? 'chevron-up' : 'chevron-down'}
          label={open ? 'Hide details' : 'Show details'}
          onPress={() => setOpen((was) => !was)}
        />
      </View>
    </Card>
  )
}

/** What this app is, on what. The last card before the one button that ends a pairing. */
function About() {
  const version = Constants.expoConfig?.version ?? '—'
  const release = Platform.OS === 'android' ? (Platform.constants as { Release?: string }).Release : null
  const os = release ? `Android ${release}` : `${Platform.OS} ${String(Platform.Version)}`
  return (
    <Card>
      <CardHeader icon="info" title="Omarchy Connect" subtitle={`${version} · ${os}`} />
    </Card>
  )
}

/* ── words ───────────────────────────────────────────────────────────── */

/** `dan@omarchy · LAN · 28 ms` — who, how far, and how long it takes to answer. */
function headerLine(hello: { host?: { hostname: string }; server?: { name: string }; link?: { via: string } } | null, latencyMs: number | null) {
  const who = hello?.host?.hostname ?? hello?.server?.name ?? 'not paired'
  const road = hello?.link ? (hello.link.via === 'remote' ? 'remote' : 'LAN') : null
  const lag = latencyMs === null ? null : `${latencyMs} ms`
  return [who, road, lag].filter(Boolean).join(' · ')
}

/** `LAN · TLS`, `remote · tailscale` — which road, and what is wrapped around it. */
function transportLabel(hello: { link?: { via: string; kind: string | null }; secure?: boolean } | null, tls?: boolean) {
  if (!hello) return '—'
  if (hello.link?.via === 'remote') return `remote · ${hello.link.kind ?? 'tunnel'}`
  return `LAN · ${tls ? 'TLS' : hello.secure ? 'encrypted' : 'plain'}`
}

/** `tailscale` → `Tailscale`, so a road reads like a name rather than a tag. */
function kindLabel(kind: string) {
  return kind.charAt(0).toUpperCase() + kind.slice(1)
}

/** `receiveFiles` → `receive files`, so a pill in caps stays readable. */
function featureLabel(feature: string) {
  return feature.replace(/([a-z0-9])([A-Z])/g, '$1 $2')
}

/* ── local primitives ────────────────────────────────────────────────── */

/**
 * The width sums the kit's `DataGrid` counts in characters, written out in
 * dp for the one decision it does not make: whether a value fits beside its
 * label at all. Content inside a card is 360 − 32 − 28 = 300dp; a 12sp
 * monospace label is about 7.2dp a character and a 14sp value about 8.4.
 */
const CONTENT_DP = 300
const LABEL_DP = 7.2
const VALUE_DP = 8.4

/**
 * A key–value row whose value is never cut. When it fits beside its label it
 * is a `Row`; when it does not — a Tailscale FQDN, a recording path — the
 * label takes one line and the value the next, wrapping once if it must.
 *
 * Worth lifting into the kit: three screens now have a value somebody else
 * chose the length of.
 */
function FitRow({ label, value, tone }: { label: string; value: string; tone?: string }) {
  if (label.length * LABEL_DP + space.md + value.length * VALUE_DP <= CONTENT_DP) {
    return <Row label={label} value={value} tone={tone} />
  }
  return (
    <View style={{ paddingVertical: space.xs }}>
      <Label>{label}</Label>
      <Value tone={tone} numberOfLines={2}>
        {value}
      </Value>
    </View>
  )
}

/** A spinner with a word beside it, for a card whose content has not arrived yet. */
function Busy({ label }: { label: string }) {
  const p = usePalette()
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm, minHeight: 32 }}>
      <ActivityIndicator size="small" color={p.light_foreground} />
      <Label>{label}</Label>
    </View>
  )
}
