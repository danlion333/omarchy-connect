import React, { useCallback, useEffect, useState } from 'react'
import { ActivityIndicator, Alert, AppState, Platform, View } from 'react-native'
import * as Clipboard from 'expo-clipboard'

import { useConnection, usePalette } from '../state/ConnectionContext'
import {
  Body,
  Button,
  Card,
  CardHeader,
  Chip,
  DataGrid,
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
  Toggle,
  Value,
} from '../ui/kit'
import { clock, duration } from '../lib/format'
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
import { micSupported } from '../../modules/omarchy-link'
import {
  backgroundLinkEnabled,
  backgroundLinkRunning,
  backgroundLinkSupported,
  canPostNotifications,
  isBatteryOptimized,
  openBatterySettings,
  requestNotificationPermission,
  startBackgroundLink,
  stopBackgroundLink,
} from '../../modules/omarchy-link'
import { datagramsSupported } from '../../modules/omarchy-link'
import { alertPrefs, setAlertPrefs, type AlertCategory, type AlertPrefs } from '../api/alerts'
import { saveAlertPrefs } from '../api/storage'
import { font, radius, size, space, type Palette } from '../theme'

export function SettingsScreen() {
  const { desktop, hello, palette, status, call, can, forget, reconnect, error, fingerprint } = useConnection()
  const [themes, setThemes] = useState<string[]>([])
  const [currentTheme, setCurrentTheme] = useState<string | null>(null)
  const [switching, setSwitching] = useState<string | null>(null)
  const [loadingThemes, setLoadingThemes] = useState(false)
  const [themeError, setThemeError] = useState<unknown>(null)

  const connected = status === 'connected'
  const dialling = status === 'connecting' || status === 'reconnecting' || status === 'pairing'

  const loadThemes = useCallback(async () => {
    if (!connected || !can('desktop', 'themes')) return
    setLoadingThemes(true)
    try {
      const res = await call<{ themes: string[]; current: string | null }>('theme.list')
      setThemes(res.themes)
      setCurrentTheme(res.current)
    } catch (err) {
      setThemeError(err)
    } finally {
      setLoadingThemes(false)
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
        setThemeError(err)
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

  // The address is the one fact worth the header's second line, and only
  // when it fits there whole; a long one goes into the grid instead, where
  // it gets a row of its own rather than an ellipsis.
  const address = desktop ? `${desktop.host}:${desktop.port}` : null
  const addressInHeader = address !== null && address.length <= 28

  return (
    <Screen>
      <ScreenHeader
        title="Setup"
        status={linkStatus(status, palette)}
        right={<IconButton icon="refresh-cw" label="Reconnect" onPress={reconnect} loading={dialling} />}
      />

      <Card>
        <CardHeader
          icon="monitor"
          title={hello?.server.name ?? desktop?.name ?? 'No desktop'}
          subtitle={addressInHeader ? address : null}
          tone={connected ? palette.green : status === 'error' ? palette.red : palette.orange}
        />
        <DataGrid
          pairs={[
            ...(addressInHeader ? [] : [{ label: 'Address', value: address ?? '—' }]),
            // Which road, not which address. The address above answers "where
            // is it"; this answers "how did I get there", which is the fact
            // that explains why the telephony surfaces are missing.
            { label: 'Link', value: linkLabel(hello?.link) },
            { label: 'Paired', value: desktop ? clock(desktop.pairedAt) : '—' },
            { label: 'Daemon', value: hello?.server.version ?? '—' },
            { label: 'Protocol', value: hello ? `v${hello.protocol}` : '—' },
            { label: 'Kernel', value: kernelLabel(hello?.host?.kernel) },
            { label: 'Uptime', value: hello ? duration(hello.host?.uptime) : '—' },
          ]}
        />
        {!hello && dialling ? <Busy label="Connecting" /> : null}
        <Divider />
        <Row
          label="Key"
          value={
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
              {/* TLS is the wire; "encrypted" is the channel inside it, which a
                  desktop paired before TLS existed still has. Plain is neither. */}
              <Pill
                label={desktop?.tls ? 'TLS' : hello?.secure ? 'encrypted' : 'plain'}
                icon={desktop?.tls || hello?.secure ? 'lock' : 'unlock'}
                tone={desktop?.tls || hello?.secure ? palette.green : palette.orange}
              />
              <Value>{fingerprint ?? '—'}</Value>
            </View>
          }
        />
        <Hint style={{ marginTop: space.xs }}>Compare with omarchy-connect status</Hint>
        <Notice
          error={error}
          action={connected ? null : { label: 'Try again', icon: 'refresh-cw', onPress: reconnect }}
          style={{ marginTop: space.md, marginBottom: 0 }}
        />
      </Card>

      {hello ? (
        <Card>
          <CardHeader
            icon="droplet"
            title="Theme"
            subtitle={can('desktop', 'themes') ? (currentTheme ?? palette.name).replace(/-/g, ' ') : 'not available'}
            tone={can('desktop', 'themes') ? undefined : palette.muted}
            right={
              can('desktop', 'themes') ? (
                <IconButton icon="refresh-cw" label="Reload themes" onPress={loadThemes} loading={loadingThemes || switching !== null} />
              ) : null
            }
          />
          {!can('desktop', 'themes') ? (
            <Hint>Needs omarchy-theme-list on the desktop</Hint>
          ) : themes.length ? (
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>
              {themes.map((name) => (
                <Chip
                  key={name}
                  label={name}
                  active={name === currentTheme}
                  disabled={switching === name}
                  onPress={() => applyTheme(name)}
                />
              ))}
            </View>
          ) : loadingThemes ? (
            <Busy label="Loading themes" />
          ) : themeError ? null : (
            <Empty icon="droplet" text="No themes on the desktop" />
          )}
          <Notice
            error={themeError}
            action={{ label: 'Try again', icon: 'refresh-cw', onPress: loadThemes }}
            style={{ marginTop: space.md, marginBottom: 0 }}
          />
        </Card>
      ) : null}

      <Capabilities capabilities={capabilities} />

      <RemoteAccess />

      <WakeOnLan />

      <ThisPhone />

      <PhoneMirror enabled={Boolean((capabilities.phone as any)?.mirror)} remote={hello?.link?.via === 'remote'} />

      <Microphone />

      <Button icon="trash-2" label="Unpair this desktop" variant="danger" onPress={confirmForget} style={{ marginTop: space.xs }} />
    </Screen>
  )
}

/**
 * What the desktop said it can do, folded to a line of counts.
 *
 * The raw list is the most useful thing on the screen to somebody debugging a
 * plugin and the least useful to everybody else, and open it filled two
 * screens. So the card says how much there is, one pill per group, and the
 * feature-by-feature list waits behind a button. A feature the desktop
 * answered `false` for — the `ios` bridge on a desktop without it — is still
 * listed, dimmed, because "not there" and "switched off" are different news.
 */
function Capabilities({ capabilities }: { capabilities: Record<string, Record<string, unknown>> }) {
  const palette = usePalette()
  const [open, setOpen] = useState(false)
  const groups = Object.entries(capabilities)
  const on = groups.reduce((sum, [, features]) => sum + Object.values(features).filter(Boolean).length, 0)

  if (!groups.length) {
    return (
      <Card>
        <CardHeader icon="check-circle" title="Capabilities" subtitle="not connected" tone={palette.muted} />
        <Empty icon="help-circle" text="Connect to see what the desktop can do" />
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader icon="check-circle" title="Capabilities" subtitle={`${groups.length} groups · ${on} capabilities`} />
      {open ? (
        groups.map(([plugin, features], i) => {
          const entries = Object.entries(features)
          const lit = entries.filter(([, enabled]) => Boolean(enabled)).length
          return (
            <View key={plugin}>
              {i > 0 ? <Divider style={{ marginVertical: space.sm }} /> : null}
              <Section title={plugin} right={<Pill label={`${lit}/${entries.length}`} />} />
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
      <View style={{ flexDirection: 'row', marginTop: space.md }}>
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

/**
 * The addresses this desktop can be reached at from off its own network, and
 * a way to add one the desktop could not describe.
 *
 * Shown dimmed until the desktop has offered a road that is not the local
 * wire, or until somebody has added one — a card explaining a feature that is
 * switched off on the desktop, on a screen nobody can switch it on from, is a
 * card that only makes the desktop look broken. It is still drawn, because
 * the one thing a phone can do about it is type an address in.
 */
function RemoteAccess() {
  const { desktop, hello, palette, addEndpoint, removeEndpoint } = useConnection()
  const [host, setHost] = useState('')
  const [port, setPort] = useState(String(desktop?.port ?? 8765))
  const [checking, setChecking] = useState(false)
  const [outcome, setOutcome] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)

  const endpoints = desktop?.endpoints ?? []
  const travelling = endpoints.filter((entry) => entry.kind !== 'lan')
  const remote = hello?.link?.via === 'remote'

  const submit = async () => {
    setChecking(true)
    setOutcome(null)
    const result = await addEndpoint(host, Number(port) || (desktop?.port ?? 8765))
    setChecking(false)
    if (result.ok) {
      setHost('')
      setAdding(false)
      setOutcome(null)
      return
    }
    setOutcome(result.error ?? 'that address could not be used')
  }

  const cancel = () => {
    setAdding(false)
    setOutcome(null)
  }

  // The address is checked before it is kept — anything answering with a key
  // that is not the paired desktop's is refused — so the field's own error
  // line is where that refusal lands, next to what was typed.
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
      <View style={{ flexDirection: 'row', gap: space.sm }}>
        <Button icon="check" label="Add" onPress={submit} loading={checking} disabled={!host.trim()} compact style={{ flex: 1 }} />
        <Button variant="ghost" label="Cancel" onPress={cancel} compact />
      </View>
    </>
  ) : (
    <View style={{ flexDirection: 'row' }}>
      <Button icon="plus" variant="ghost" label="Add an address by hand" onPress={() => setAdding(true)} compact />
    </View>
  )

  if (!travelling.length) {
    return (
      <Card>
        <CardHeader icon="globe" title="Remote access" subtitle="not offered" tone={palette.muted} />
        <Hint style={{ marginBottom: space.md }}>Switch it on with omarchy-connect remote on</Hint>
        {form}
      </Card>
    )
  }

  const manual = travelling.filter((entry) => entry.source === 'manual')
  const offered = travelling.filter((entry) => entry.source !== 'manual')

  return (
    <Card>
      <CardHeader
        icon="globe"
        title="Remote access"
        subtitle={remote ? 'in use now' : 'ready'}
        tone={remote ? palette.green : undefined}
      />
      {offered.map((entry) => (
        <FitRow
          key={`${entry.host}:${entry.port}`}
          label={entry.kind}
          value={`${entry.host}${entry.port === desktop?.port ? '' : `:${entry.port}`}`}
          tone={entry.host === desktop?.host ? palette.green : undefined}
        />
      ))}
      {manual.length ? (
        <>
          <Section title="Added by hand" style={{ marginTop: offered.length ? space.md : 0 }} />
          {manual.map((entry, i) => (
            <ListRow
              key={`${entry.host}:${entry.port}`}
              title={entry.host}
              subtitle={`port ${entry.port}`}
              tone={entry.host === desktop?.host ? palette.green : undefined}
              right={<IconButton icon="x" label="Remove this address" onPress={() => void removeEndpoint(entry.host, entry.port)} />}
              last={i === manual.length - 1}
            />
          ))}
        </>
      ) : null}
      <Hint style={{ marginTop: space.sm }}>Calls and messages stay on the home network</Hint>
      <Divider />
      {form}
    </Card>
  )
}

/**
 * What it would take to wake this desktop, and whether it would work.
 *
 * This is the diagnostic half of the feature — the button itself is on Remote,
 * with the other power controls. It is here because everything it says is a
 * thing to be fixed on the desktop rather than on the phone, and because the
 * answers were all given by the desktop while it was still awake: once it is
 * asleep there is nobody to ask.
 */
function WakeOnLan() {
  const { desktop, palette, client } = useConnection()
  const [copied, setCopied] = useState(false)
  const wake = desktop?.wake

  if (!wake) return null

  // A magic packet is a broadcast on the local wire, and a tunnel does not
  // carry broadcasts. The button stays: sending it is a harmless datagram,
  // this reading of the network can be wrong, and a phone that has just
  // walked back through the front door should not have to reopen the screen
  // to get its button back. But it says what it expects to happen.
  const offTheWire = client?.networkFacts ? !client.networkFacts.lan : false

  const copy = async (command: string) => {
    await Clipboard.setStringAsync(command)
    setCopied(true)
  }

  if (!wake.supported) {
    return (
      <Card>
        <CardHeader icon="zap" title="Wake on LAN" subtitle="not available" tone={palette.muted} />
        <Hint>{wake.note ?? 'This desktop cannot be woken over the network'}</Hint>
      </Card>
    )
  }

  const ready = wake.armed === true
  const armedTone = ready ? palette.green : palette.orange

  return (
    <Card>
      <CardHeader
        icon="zap"
        title="Wake on LAN"
        subtitle={ready ? 'ready' : wake.armed === null ? 'cannot tell' : 'not armed'}
        tone={armedTone}
      />
      <DataGrid
        columns={1}
        pairs={[
          { label: 'Interface', value: wake.interface ? `${wake.interface} (${wake.type})` : '—' },
          { label: 'Armed', value: wake.armed === null ? 'cannot tell' : wake.armed ? 'yes' : 'no', tone: armedTone },
          { label: 'MAC', value: wake.mac ?? '—' },
          { label: 'Packet to', value: wake.broadcast ? `${wake.broadcast}:${wake.port}` : '—' },
        ]}
      />
      {!datagramsSupported() ? (
        <Hint icon="alert-triangle" tone={palette.orange} style={{ marginTop: space.sm }}>
          Android only
        </Hint>
      ) : offTheWire ? (
        <Hint icon="alert-triangle" tone={palette.orange} style={{ marginTop: space.sm }}>
          Not on the desktop's network · the packet has nowhere to go from here
        </Hint>
      ) : null}
      {wake.note ? <Hint style={{ marginTop: space.sm }}>{wake.note}</Hint> : null}
      {wake.command ? (
        <>
          <Divider />
          <Section title="Run on the desktop" />
          <Command text={wake.command} />
          <View style={{ flexDirection: 'row', marginTop: space.sm }}>
            <Button compact icon={copied ? 'check' : 'copy'} label={copied ? 'Copied' : 'Copy command'} onPress={() => copy(wake.command!)} />
          </View>
        </>
      ) : null}
    </Card>
  )
}

/**
 * The phone's own half of the setup: what it is, whether it stays on the
 * link with the app closed, and what it is allowed to say from the shade.
 *
 * The background link is the switch that decides whether this phone exists
 * when nobody is looking. Android suspends an app's timers the moment it
 * leaves the screen and reclaims its process soon after, which took the
 * socket, the keepalive and every event with it. A foreground service is the
 * only sanctioned way out, and it costs a permanent notification — so it is a
 * choice the user makes with the price in front of them, not something
 * switched on behind their back.
 *
 * The notifications are four separate switches rather than one, because the
 * four are not the same favour. Being told an agent is waiting is worth a
 * sound at midnight; being told the desktop copied a word is worth a line at
 * the bottom of the shade and nothing more. Bundling them would mean whoever
 * wanted one and not the other had to give up both. All on by default: a
 * notification nobody sees is an agent sitting idle, a file nobody knew
 * arrived, and a clipboard that never left the desktop.
 */
function ThisPhone() {
  const { palette, hello, desktop } = useConnection()
  const supported = backgroundLinkSupported()
  const [enabled, setEnabled] = useState(false)
  const [running, setRunning] = useState(false)
  const [optimized, setOptimized] = useState(false)
  const [notifications, setNotifications] = useState(true)
  const [busy, setBusy] = useState(false)
  const [fault, setFault] = useState<unknown>(null)
  const [prefs, setPrefs] = useState<AlertPrefs>(alertPrefs)

  const sync = useCallback(() => {
    if (!supported) return
    setEnabled(backgroundLinkEnabled())
    setRunning(backgroundLinkRunning())
    setOptimized(isBatteryOptimized())
    setNotifications(canPostNotifications())
  }, [supported])

  useEffect(() => {
    sync()
    // Both the battery exemption and notification access are granted on
    // system screens, so coming back is the only moment we learn the answer.
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
      // thing a user is right to be annoyed about discovering later.
      await requestNotificationPermission()
      startBackgroundLink()
    } catch (err) {
      setFault(err)
    } finally {
      setBusy(false)
      sync()
    }
  }, [sync])

  const disable = useCallback(() => {
    stopBackgroundLink()
    sync()
  }, [sync])

  const toggle = useCallback(
    async (key: AlertCategory) => {
      const next = { ...prefs, [key]: !prefs[key] }
      setPrefs(next)
      setAlertPrefs(next)
      await saveAlertPrefs(next).catch(() => {})
      // Asked for the moment something is switched on rather than at launch: a
      // permission dialog nobody asked for is a dialog nobody reads.
      if (next[key]) await requestNotificationPermission()
    },
    [prefs],
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

  // Where there is no service there is nothing to post from, and the one
  // sentence that explains both halves is the platform's.
  const cannot = Platform.OS === 'ios' ? 'Not possible on iOS · pair over Bluetooth instead' : 'Needs the Android build'

  return (
    <Card>
      <CardHeader icon="smartphone" title="This phone" subtitle={hello?.device.name ?? (desktop ? 'offline' : 'not paired')} />
      <DataGrid
        pairs={[
          { label: 'Platform', value: hello?.device.platform ?? Platform.OS },
          { label: 'Device id', value: hello?.device.id?.slice(0, 14) ?? '—' },
        ]}
      />
      <Divider />
      <Section title="Background link" tone={supported ? undefined : palette.muted} />
      <Toggle
        label="Stay connected"
        hint={supported ? 'A standing notification keeps the link up with the app closed' : cannot}
        value={supported && enabled}
        onChange={(next) => (next ? void enable() : disable())}
        disabled={!supported || busy}
        last
      />
      <Notice error={fault} action={{ label: 'Try again', onPress: () => void enable() }} style={{ marginBottom: 0 }} />
      {supported && enabled ? (
        <>
          <DataGrid
            pairs={[
              { label: 'Service', value: running ? 'running' : 'stopped', tone: running ? undefined : palette.orange },
              { label: 'Notification', value: notifications ? 'shown' : 'hidden', tone: notifications ? undefined : palette.orange },
            ]}
          />
          {notifications ? null : (
            <Action hint="Android is hiding the notification · the link still works">
              <Button compact icon="bell" label="Show notification" variant="ghost" loading={busy} onPress={() => void enable()} />
            </Action>
          )}
          {optimized ? (
            <Action hint="Android may still put this app to sleep">
              <Button compact icon="battery-charging" label="Exempt from battery saver" variant="ghost" onPress={() => void openBatterySettings()} />
            </Action>
          ) : null}
        </>
      ) : null}
      <Divider />
      <Section
        title="Notifications"
        tone={supported ? undefined : palette.muted}
        right={supported ? <Pill label={`${alerts.filter((row) => prefs[row.key]).length} of ${alerts.length} on`} /> : null}
      />
      {supported ? (
        alerts.map((row, i) => (
          <Toggle
            key={row.key}
            label={row.label}
            hint={row.hint}
            value={prefs[row.key]}
            onChange={() => void toggle(row.key)}
            last={i === alerts.length - 1}
          />
        ))
      ) : (
        <Hint>Android only</Hint>
      )}
      {supported && !notifications && alerts.some((row) => prefs[row.key]) ? (
        <Hint icon="alert-triangle" tone={palette.orange} style={{ marginTop: space.sm }}>
          Notifications are blocked for this app in Android settings
        </Hint>
      ) : null}
    </Card>
  )
}

/**
 * The microphone, offered from the end that is holding it.
 *
 * The desktop could already ask for this phone's microphone, and the phone
 * would answer with no screen open at all — which is the right behaviour and
 * an uncomfortable one to have no window onto. Two things are missing without
 * this card, and they are the same thing twice: a person cannot offer the
 * microphone that is in their own hand, and cannot see when the machine in the
 * other room is listening to it. Android's own recording dot is the only other
 * answer to either, and a dot does not say to whom.
 *
 * Everything on it is read out of the link rather than held here. A recording
 * outlives this screen — the user switches tab, locks the phone, comes back —
 * and a card that started a stream and then forgot about it would be worse
 * than no card, because it would say "off" over a live microphone.
 */
function Microphone() {
  const { palette, mic, status, can, offerMic, hello } = useConnection()
  const supported = micSupported()
  const connected = status === 'connected'

  // Nothing to say about a desktop that has not said anything yet; the
  // desktop card carries the offline story. A desktop with no audio plugin
  // is a different case and gets the card, dimmed, so the absence is visible.
  if (!hello) return null

  if (!can('audio', 'receive')) {
    return (
      <Card>
        <CardHeader icon="mic-off" title="Microphone" subtitle="not available" tone={palette.muted} />
        <Hint>This desktop's daemon has no audio plugin</Hint>
      </Card>
    )
  }

  if (!supported) {
    return (
      <Card>
        <CardHeader icon="mic-off" title="Microphone" subtitle="not available" tone={palette.muted} />
        <Hint>{Platform.OS === 'ios' ? 'Not possible on iOS' : 'Needs the Android build'}</Hint>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader
        icon={mic.listening ? 'mic' : 'mic-off'}
        title="Microphone"
        subtitle={mic.listening ? 'the desktop is listening' : connected ? 'off' : 'not connected'}
        tone={mic.listening ? palette.red : palette.muted}
      />
      {mic.listening ? (
        <DataGrid
          pairs={[
            { label: 'Started', value: mic.since ? clock(mic.since) : '—' },
            { label: 'Stream', value: mic.stream === null ? '—' : `#${mic.stream}` },
          ]}
          style={{ marginBottom: space.sm }}
        />
      ) : null}
      {mic.listening && mic.path ? <FitRow label="Recording" value={mic.path} style={{ marginBottom: space.sm }} /> : null}
      <Button
        icon={mic.listening ? 'mic-off' : 'mic'}
        label={mic.listening ? 'Stop the desktop listening' : 'Offer this microphone'}
        variant={mic.listening ? 'danger' : 'solid'}
        loading={mic.busy}
        disabled={!connected || mic.busy}
        onPress={() => void offerMic()}
      />
      {!connected ? <Hint style={{ marginTop: space.sm }}>Off while the link is down</Hint> : null}
      {/* Every refusal is a sentence — a revoked permission, an input another
          app is holding, a desktop too old to be offered anything. The one
          thing this card must never do is nothing at all. */}
      <Notice error={mic.error} style={{ marginTop: space.md, marginBottom: 0 }} />
    </Card>
  )
}

/**
 * Granting Android the right to read messages and call state.
 *
 * Deliberately asked for from a row rather than at startup: this is the most
 * invasive permission the app has, and the user should be the one who decides
 * to hand it over, at a moment when it is obvious what it buys them. Each of
 * the four is a separate permission because each is a separate favour —
 * answering someone's call is not a passive act, sending an SMS is the one
 * thing here that can cost money, and reading the dialler's notification is
 * the only way Android still lets an app learn who is calling.
 */
function PhoneMirror({ enabled, remote }: { enabled: boolean; remote: boolean }) {
  const palette = usePalette()
  const supported = phoneMirrorSupported()
  const [granted, setGranted] = useState(false)
  const [canAskAgain, setCanAskAgain] = useState(true)
  const [busy, setBusy] = useState(false)
  const [answering, setAnswering] = useState(false)
  const [askingCalls, setAskingCalls] = useState(false)
  const [sending, setSending] = useState(false)
  const [askingSend, setAskingSend] = useState(false)
  const [callerId, setCallerId] = useState(false)
  const [contacts, setContacts] = useState(false)

  useEffect(() => {
    if (!supported) return
    phonePermission().then((result) => {
      setGranted(result.granted)
      setCanAskAgain(result.canAskAgain)
    })
    setAnswering(canAnswerCalls())
    setSending(canSendMessages())
    setCallerId(canReadCallNotifications())
    setContacts(canReadContacts())
    // Notification access is granted on a system screen rather than in a
    // dialog, so the only moment we can learn the answer is on the way back.
    const subscription = AppState.addEventListener('change', (next) => {
      if (next !== 'active') return
      setAnswering(canAnswerCalls())
      setSending(canSendMessages())
      setCallerId(canReadCallNotifications())
      setContacts(canReadContacts())
    })
    return () => subscription.remove()
  }, [supported])

  const ask = useCallback(async () => {
    setBusy(true)
    try {
      const result = await requestPhonePermission()
      setGranted(result.granted)
      setCanAskAgain(result.canAskAgain)
      setContacts(canReadContacts())
    } finally {
      setBusy(false)
    }
  }, [])

  const askSend = useCallback(async () => {
    setAskingSend(true)
    try {
      setSending(await requestSendPermission())
    } finally {
      setAskingSend(false)
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

  if (!supported) {
    return (
      <Card>
        <CardHeader
          icon="message-square"
          title="Messages and calls"
          subtitle={Platform.OS === 'ios' ? 'over Bluetooth' : 'not available'}
          tone={palette.muted}
        />
        {Platform.OS === 'ios' ? <IosBridge /> : <Hint>Needs the Android build</Hint>}
      </Card>
    )
  }

  // The first permission is the one the whole card hangs off; the rest are
  // refinements, and none of them is worth asking about before it is granted.
  const rows: { key: string; title: string; subtitle: string; state: PermissionState; onPress?: () => void }[] = [
    {
      key: 'mirror',
      title: 'SMS and calls',
      subtitle: 'Mirrored to the desktop',
      state: busy ? 'asking' : granted ? 'granted' : canAskAgain ? 'ask' : 'denied',
      onPress: !granted && canAskAgain ? () => void ask() : undefined,
    },
    {
      key: 'answer',
      title: 'Answer calls',
      subtitle: 'The audio stays on this phone',
      state: askingCalls ? 'asking' : answering ? 'granted' : 'ask',
      onPress: answering ? undefined : () => void askCalls(),
    },
    {
      key: 'send',
      title: 'Reply by SMS',
      subtitle: 'Sending can cost money',
      state: askingSend ? 'asking' : sending ? 'granted' : 'ask',
      onPress: sending ? undefined : () => void askSend(),
    },
    {
      key: 'caller',
      title: 'Caller ID',
      subtitle: 'Read off the dialler',
      state: callerId ? 'granted' : 'ask',
      onPress: callerId ? undefined : () => void openNotificationAccess(),
    },
    ...(callerId
      ? [
          {
            key: 'contacts',
            title: 'Contact names',
            subtitle: 'Saved callers, by name',
            state: (busy ? 'asking' : contacts ? 'granted' : canAskAgain ? 'ask' : 'denied') as PermissionState,
            onPress: !contacts && canAskAgain ? () => void ask() : undefined,
          },
        ]
      : []),
  ]

  return (
    <Card>
      <CardHeader
        icon="message-square"
        title="Messages and calls"
        subtitle={granted ? 'mirroring' : 'permission needed'}
        tone={granted ? palette.green : palette.orange}
      />
      {rows.map((row, i) => (
        <ListRow
          key={row.key}
          title={row.title}
          subtitle={row.subtitle}
          onPress={row.onPress}
          chevron={Boolean(row.onPress)}
          right={<PermissionPill state={row.state} />}
          last={i === rows.length - 1}
        />
      ))}
      {!canAskAgain && (!granted || (callerId && !contacts)) ? (
        <Hint icon="alert-triangle" tone={palette.orange} style={{ marginTop: space.sm }}>
          Allow SMS, calls and contacts in Android settings
        </Hint>
      ) : null}
      {remote ? <Hint style={{ marginTop: space.sm }}>Off while on a remote link</Hint> : null}
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
      <DataGrid
        pairs={[
          {
            label: 'Bridge',
            value: live ? 'mirroring' : bridge?.paired ? 'paired, idle' : 'not paired',
            tone: live ? palette.green : undefined,
          },
          { label: 'Desktop sees', value: bridge?.device ?? '—' },
        ]}
      />
      {live ? null : (
        <Hint style={{ marginTop: space.sm }}>omarchy-connect ios pair on the desktop, then Settings › Bluetooth here</Hint>
      )}
      <View style={{ flexDirection: 'row', marginTop: space.md }}>
        <Button compact icon="refresh-cw" label="Check the bridge" variant="ghost" loading={checking} onPress={refresh} />
      </View>
    </>
  )
}

/* ── words ───────────────────────────────────────────────────────────── */

/**
 * How this socket got here, in words rather than in a code.
 *
 * A desktop too old to say gets a dash rather than a guess: "home network" is
 * a claim, and the only thing that knows is the machine at the other end.
 */
function linkLabel(link?: { via: string; kind: string | null }) {
  if (!link) return '—'
  if (link.via !== 'remote') return 'home network'
  return link.kind && link.kind !== 'overlay' ? `${link.kind} · remote` : 'remote'
}

/**
 * The kernel as a version rather than a build string. `uname -r` on Arch is
 * `7.1.9-arch1-2`, which fits; a kernel that appends its git hash does not,
 * and the hash is not something anybody reads off a phone.
 */
function kernelLabel(kernel: string | null | undefined) {
  if (!kernel) return '—'
  return kernel.split('-').slice(0, 3).join('-')
}

/** `receiveFiles` → `receive files`, so a pill in caps stays readable. */
function featureLabel(feature: string) {
  return feature.replace(/([a-z0-9])([A-Z])/g, '$1 $2')
}

/** The small coloured word beside the screen's name. */
function linkStatus(status: string, palette: Palette): { label: string; tone: string } {
  switch (status) {
    case 'connected':
      return { label: 'connected', tone: palette.green }
    case 'reconnecting':
      return { label: 'reconnecting', tone: palette.orange }
    case 'connecting':
    case 'pairing':
      return { label: 'connecting', tone: palette.orange }
    case 'parked':
      return { label: 'waiting for network', tone: palette.orange }
    case 'error':
      return { label: 'connection problem', tone: palette.red }
    default:
      return { label: 'offline', tone: palette.muted }
  }
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
 */
function FitRow({ label, value, tone, style }: { label: string; value: string; tone?: string; style?: React.ComponentProps<typeof View>['style'] }) {
  if (label.length * LABEL_DP + space.md + value.length * VALUE_DP <= CONTENT_DP) {
    return <Row label={label} value={value} tone={tone} style={style} />
  }
  return (
    <View style={[{ paddingVertical: space.xs }, style]}>
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
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm, minHeight: 32, marginTop: space.xs }}>
      <ActivityIndicator size="small" color={p.light_foreground} />
      <Label>{label}</Label>
    </View>
  )
}

/** One line of why, and under it the one button that changes it. */
function Action({ hint, children }: { hint: string; children: React.ReactNode }) {
  return (
    <View style={{ marginTop: space.sm }}>
      <Hint>{hint}</Hint>
      <View style={{ flexDirection: 'row', marginTop: space.xs }}>{children}</View>
    </View>
  )
}

/** A shell command to be run elsewhere: selectable, wrapping, in a box. */
function Command({ text }: { text: string }) {
  const p = usePalette()
  return (
    <View style={{ backgroundColor: p.darker_background, borderRadius: radius.sm, paddingHorizontal: space.md, paddingVertical: space.sm }}>
      <Body selectable tone={p.bright_foreground} style={{ fontFamily: font.medium, fontSize: size.label }}>
        {text}
      </Body>
    </View>
  )
}

type PermissionState = 'granted' | 'ask' | 'denied' | 'asking'

/** The state of one Android permission, as a word in a pill. */
function PermissionPill({ state }: { state: PermissionState }) {
  const p = usePalette()
  const tone = state === 'granted' ? p.green : state === 'denied' ? p.orange : p.light_foreground
  return <Pill label={state === 'asking' ? 'asking…' : state} tone={tone} icon={state === 'granted' ? 'check' : undefined} />
}
