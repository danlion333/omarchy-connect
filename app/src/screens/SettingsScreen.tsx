import React, { useCallback, useEffect, useState } from 'react'
import { Alert, AppState, Platform, View } from 'react-native'
import { Feather } from '@expo/vector-icons'
import * as Clipboard from 'expo-clipboard'

import { useConnection } from '../state/ConnectionContext'
import { Body, Button, Caps, Card, CardHeader, Chip, DataGrid, Divider, Empty, Field, ListRow, Screen } from '../ui/kit'
import { clock, duration } from '../lib/format'
import {
  canAnswerCalls,
  canReadCallNotifications,
  canReadContacts,
  openNotificationAccess,
  phoneMirrorSupported,
  phonePermission,
  requestCallPermission,
  requestPhonePermission,
} from '../api/phone'
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
import { font, size, space } from '../theme'

export function SettingsScreen() {
  const { desktop, hello, palette, status, call, can, forget, reconnect, error, fingerprint } = useConnection()
  const [themes, setThemes] = useState<string[]>([])
  const [currentTheme, setCurrentTheme] = useState<string | null>(null)
  const [switching, setSwitching] = useState<string | null>(null)
  const [themeError, setThemeError] = useState<string | null>(null)

  const connected = status === 'connected'

  const loadThemes = useCallback(async () => {
    if (!connected || !can('desktop', 'themes')) return
    try {
      const res = await call<{ themes: string[]; current: string | null }>('theme.list')
      setThemes(res.themes)
      setCurrentTheme(res.current)
    } catch (err) {
      setThemeError((err as Error).message)
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
        setThemeError((err as Error).message)
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

  return (
    <Screen>
      <Caps style={{ marginBottom: space.md }}>Setup</Caps>

      <Card>
        <CardHeader
          icon="monitor"
          title={hello?.server.name ?? desktop?.name ?? 'no desktop'}
          subtitle={statusLabel(status)}
          tone={connected ? palette.green : status === 'error' ? palette.red : palette.orange}
          right={<Button icon="refresh-cw" variant="ghost" onPress={reconnect} />}
        />
        <DataGrid
          pairs={[
            { label: 'Address', value: desktop ? `${desktop.host}:${desktop.port}` : '—' },
            // Which road, not which address. The address above answers "where
            // is it"; this answers "how did I get there", which is the fact
            // that explains why the telephony surfaces are missing.
            { label: 'Link', value: linkLabel(hello?.link) },
            { label: 'Paired', value: desktop ? clock(desktop.pairedAt) : '—' },
            { label: 'Daemon', value: hello?.server.version ?? '—' },
            { label: 'Protocol', value: hello ? `v${hello.protocol}` : '—' },
            { label: 'Kernel', value: hello?.host?.kernel ?? '—' },
            { label: 'Uptime', value: hello ? duration(hello.host?.uptime) : '—' },
          ]}
        />
        <Divider />
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
          <Feather name={hello?.secure ? 'lock' : 'unlock'} size={13} color={hello?.secure ? palette.green : palette.orange} />
          <Caps tone={palette.muted}>{hello?.secure ? 'encrypted' : 'not encrypted'}</Caps>
          <Chip label={desktop?.tls ? 'tls' : 'plain'} tone={desktop?.tls ? palette.green : palette.muted} />
          {hello?.link?.via === 'remote' ? <Chip label="remote" tone={palette.orange} /> : null}
          <Body tone={palette.light_foreground} style={{ fontFamily: font.medium, fontSize: size.label, marginLeft: 'auto' }}>
            {fingerprint ?? '—'}
          </Body>
        </View>
        <Body tone={palette.muted} style={{ fontSize: size.micro, marginTop: space.xs }}>
          this is the desktop key your phone pinned — `omarchy-connect status` prints the same digest
        </Body>
        {error ? (
          <Body tone={palette.red} style={{ marginTop: space.md, fontSize: size.label }}>
            {error}
          </Body>
        ) : null}
      </Card>

      {can('desktop', 'themes') ? (
        <Card>
          <CardHeader
            icon="droplet"
            title="Theme"
            subtitle={`${palette.name} · the app follows the desktop`}
            right={<Button icon="refresh-cw" variant="ghost" onPress={loadThemes} />}
          />
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>
            {themes.map((name) => (
              <Chip
                key={name}
                label={switching === name ? `${name}…` : name}
                active={name === currentTheme}
                onPress={() => applyTheme(name)}
              />
            ))}
          </View>
          {themeError ? (
            <Body tone={palette.red} style={{ marginTop: space.md, fontSize: size.label }}>
              {themeError}
            </Body>
          ) : null}
        </Card>
      ) : null}

      <Card>
        <CardHeader icon="check-circle" title="Capabilities" subtitle="what this desktop can do" />
        {Object.keys(capabilities).length ? (
          Object.entries(capabilities).map(([plugin, features], i) => (
            <View key={plugin}>
              {i > 0 ? <Divider style={{ marginVertical: space.sm }} /> : null}
              <Caps style={{ marginBottom: space.sm }}>{plugin}</Caps>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>
                {Object.entries(features).map(([feature, enabled]) => (
                  <Body
                    key={feature}
                    tone={enabled ? palette.green : palette.muted}
                    style={{ fontSize: size.label }}
                  >
                    {`${enabled ? '+' : '−'} ${feature}`}
                  </Body>
                ))}
              </View>
            </View>
          ))
        ) : (
          <Empty icon="help-circle" text="Connect to see what the desktop supports" />
        )}
      </Card>

      <RemoteAccess />

      <WakeOnLan />

      <BackgroundLink />

      <Notifications />

      <PhoneMirror enabled={Boolean((capabilities.phone as any)?.mirror)} />

      <Card>
        <CardHeader icon="smartphone" title="This phone" subtitle={hello?.device.name ?? 'not paired'} />
        <DataGrid
          pairs={[
            { label: 'Platform', value: hello?.device.platform ?? '—' },
            { label: 'Device id', value: hello?.device.id?.slice(0, 14) ?? '—' },
          ]}
          columns={1}
        />
        <View style={{ height: space.md }} />
        <Button icon="trash-2" label="Unpair this desktop" variant="danger" onPress={confirmForget} />
      </Card>

      <Body tone={palette.muted} style={{ fontSize: size.label, textAlign: 'center', marginTop: space.sm }}>
        {hello?.link?.via === 'remote'
          ? 'Omarchy Connect · no account, no cloud · this link is coming in over your own tunnel'
          : 'Omarchy Connect · no account, no cloud · nothing is leaving your network'}
      </Body>
    </Screen>
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
/**
 * The addresses this desktop can be reached at from off its own network, and
 * a way to add one the desktop could not describe.
 *
 * Shown once the desktop has offered a road that is not the local wire, or
 * once somebody has added one — a card explaining a feature that is switched
 * off on the desktop, on a screen nobody can switch it on from, is a card
 * that only makes the desktop look broken.
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

  if (!travelling.length && !adding) {
    return (
      <Card>
        <CardHeader icon="globe" title="Remote access" subtitle="reach this desktop away from home" tone={palette.muted} />
        <Body tone={palette.muted} style={{ fontSize: size.label }}>
          this desktop has only offered its address on your own network. Switch remote access on there —
          `omarchy-connect remote on`, or the panel — and the address it can be reached at from anywhere
          arrives on the next connection.
        </Body>
        <View style={{ height: space.md }} />
        <Button icon="plus" variant="ghost" label="Add an address by hand" onPress={() => setAdding(true)} />
      </Card>
    )
  }

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

  return (
    <Card>
      <CardHeader
        icon="globe"
        title="Remote access"
        subtitle={remote ? 'connected from away' : 'reach this desktop away from home'}
        tone={remote ? palette.green : palette.muted}
      />
      {travelling.length ? (
        <DataGrid
          pairs={travelling.map((entry) => ({
            label: entry.kind,
            value: `${entry.host}${entry.port === desktop?.port ? '' : `:${entry.port}`}`,
            tone: entry.host === desktop?.host ? palette.green : undefined,
          }))}
          columns={1}
        />
      ) : null}
      <Body tone={palette.muted} style={{ fontSize: size.label, marginTop: space.md }}>
        your desktop's tunnel address travels with it — pair once, and the phone finds it from anywhere the
        tunnel reaches. Calls and messages stay at home: telephony is switched off on a remote link.
      </Body>

      {travelling.some((entry) => entry.source === 'manual') ? (
        <>
          <Divider />
          <Caps style={{ marginBottom: space.xs }}>Added by hand</Caps>
          {travelling
            .filter((entry) => entry.source === 'manual')
            .map((entry) => (
              <ListRow
                key={`${entry.host}:${entry.port}`}
                title={entry.host}
                subtitle={`port ${entry.port}`}
                right={<Button icon="x" variant="ghost" onPress={() => void removeEndpoint(entry.host, entry.port)} />}
              />
            ))}
        </>
      ) : null}

      <Divider />
      {adding ? (
        <>
          <Field label="Address" value={host} onChange={setHost} placeholder="100.101.102.103" />
          <Field label="Port" value={port} onChange={setPort} keyboardType="number-pad" maxLength={5} />
          {outcome ? (
            <Body tone={palette.red} style={{ fontSize: size.label, marginBottom: space.md }}>
              {outcome}
            </Body>
          ) : null}
          <View style={{ flexDirection: 'row', gap: space.sm }}>
            <View style={{ flex: 1 }}>
              <Button
                icon={checking ? 'loader' : 'check'}
                label={checking ? 'Checking…' : 'Add'}
                onPress={submit}
                disabled={!host.trim() || checking}
              />
            </View>
            <Button
              variant="ghost"
              label="Cancel"
              onPress={() => {
                setAdding(false)
                setOutcome(null)
              }}
            />
          </View>
          <Body tone={palette.muted} style={{ fontSize: size.micro, marginTop: space.sm }}>
            the address is checked before it is kept — anything answering with a key that is not your
            desktop's is refused
          </Body>
        </>
      ) : (
        <Button icon="plus" variant="ghost" label="Add an address by hand" onPress={() => setAdding(true)} />
      )}
    </Card>
  )
}

function WakeOnLan() {
  const { desktop, palette, client } = useConnection()
  const [copied, setCopied] = useState(false)
  const wake = desktop?.wake

  if (!wake?.supported) return null

  // A magic packet is a broadcast on the local wire, and a tunnel does not
  // carry broadcasts. The button stays: sending it is a harmless datagram,
  // this reading of the network can be wrong, and a phone that has just
  // walked back through the front door should not have to reopen the screen
  // to get its button back. But it says what it expects to happen.
  const offTheWire = client?.networkFacts ? !client.networkFacts.lan : false

  const armed = wake.armed === null ? 'cannot tell' : wake.armed ? 'yes' : 'no'
  const copy = async (command: string) => {
    await Clipboard.setStringAsync(command)
    setCopied(true)
  }

  return (
    <Card>
      <CardHeader
        icon="zap"
        title="Wake on LAN"
        subtitle={wake.armed === true ? 'this desktop can be woken from sleep' : 'not ready yet'}
        tone={wake.armed === true ? palette.green : palette.orange}
      />
      {/* One column: a MAC and a broadcast address are the two facts this card
          exists to carry, and two columns cut both of them off. */}
      <DataGrid
        pairs={[
          { label: 'Card', value: wake.interface ? `${wake.interface} (${wake.type})` : '—' },
          { label: 'Armed', value: armed, tone: wake.armed === true ? palette.green : palette.orange },
          { label: 'MAC', value: wake.mac ?? '—' },
          { label: 'Packet to', value: wake.broadcast ? `${wake.broadcast}:${wake.port}` : '—' },
        ]}
        columns={1}
      />
      {!datagramsSupported() ? (
        <Body tone={palette.orange} style={{ fontSize: size.label, marginTop: space.md }}>
          this phone cannot send the packet — there is no UDP socket in Expo Go or on iOS, so waking needs the
          Android build
        </Body>
      ) : null}
      {offTheWire ? (
        <Body tone={palette.orange} style={{ fontSize: size.label, marginTop: space.md }}>
          this phone is not on the desktop's own network, and a magic packet does not travel down a tunnel —
          the button still works, it just has nowhere to shout from here
        </Body>
      ) : null}
      {wake.note ? (
        <Body tone={palette.muted} style={{ fontSize: size.label, marginTop: space.md }}>
          {wake.note}
        </Body>
      ) : null}
      {wake.command ? (
        <>
          <Divider />
          <Body tone={palette.muted} style={{ fontSize: size.micro }}>
            run this on the desktop — nothing here can change a setting on it
          </Body>
          <Body tone={palette.light_foreground} style={{ fontFamily: font.medium, fontSize: size.label, marginTop: space.xs }}>
            {wake.command}
          </Body>
          <View style={{ height: space.md }} />
          <Button
            icon={copied ? 'check' : 'copy'}
            label={copied ? 'Copied' : 'Copy the command'}
            onPress={() => copy(wake.command!)}
          />
        </>
      ) : null}
    </Card>
  )
}

/**
 * What this phone is allowed to say, and about what.
 *
 * Four separate switches rather than one, because the four are not the same
 * favour. Being told an agent is waiting is worth a sound at midnight; being
 * told the desktop copied a word is worth a line at the bottom of the shade
 * and nothing more. Bundling them would mean whoever wanted one and not the
 * other had to give up both.
 *
 * All on by default: a notification nobody sees is an agent sitting idle, a
 * file nobody knew arrived, and a clipboard that never left the desktop.
 */
function Notifications() {
  const { palette, hello } = useConnection()
  const supported = backgroundLinkSupported()
  const [prefs, setPrefs] = useState<AlertPrefs>(alertPrefs)

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

  if (!supported) return null

  const reading = Boolean((hello?.capabilities?.agents as any)?.enabled)

  const rows: { key: AlertCategory; title: string; subtitle: string }[] = [
    {
      key: 'waiting',
      title: 'An agent is waiting',
      subtitle: reading
        ? 'the question, and a reply box on the notification itself'
        : 'reading agents is off on the desktop, so there is nothing to be told about yet',
    },
    {
      key: 'done',
      title: 'An agent finished',
      subtitle: 'only after a long run — not for every turn it takes',
    },
    {
      key: 'files',
      title: 'A file arrived',
      subtitle: 'with Save straight to the gallery, for a picture or a video',
    },
    {
      key: 'clipboard',
      title: 'The desktop copied something',
      subtitle: 'silent, one line, and a Copy button — hidden while the app is open',
    },
  ]

  return (
    <Card>
      <CardHeader
        icon="bell"
        title="Notifications"
        subtitle={`${rows.filter((row) => prefs[row.key]).length} of ${rows.length} on`}
        tone={rows.some((row) => prefs[row.key]) ? palette.green : palette.muted}
      />
      {rows.map((row, index) => (
        <View key={row.key}>
          {index ? <Divider /> : null}
          {/* The chip is a Pressable in its own right, so it takes the same
              handler rather than swallowing the row's. */}
          <ListRow
            title={row.title}
            subtitle={row.subtitle}
            onPress={() => toggle(row.key)}
            right={
              <Chip
                label={prefs[row.key] ? 'on' : 'off'}
                active={prefs[row.key]}
                tone={palette.green}
                onPress={() => toggle(row.key)}
              />
            }
          />
        </View>
      ))}
    </Card>
  )
}

/**
 * The switch that decides whether this phone exists when nobody is looking.
 *
 * Android suspends an app's timers the moment it leaves the screen and
 * reclaims its process soon after, which took the socket, the keepalive and
 * every event with it. A foreground service is the only sanctioned way out,
 * and it costs a permanent notification — so it is a choice the user makes
 * with the price in front of them, not something switched on behind their
 * back.
 */
function BackgroundLink() {
  const { palette } = useConnection()
  const supported = backgroundLinkSupported()
  const [enabled, setEnabled] = useState(false)
  const [running, setRunning] = useState(false)
  const [optimized, setOptimized] = useState(false)
  const [notifications, setNotifications] = useState(true)
  const [busy, setBusy] = useState(false)

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
    try {
      // Asked for first: without it the service still runs, but Android hides
      // its notification, and an invisible foreground service is the kind of
      // thing a user is right to be annoyed about discovering later.
      await requestNotificationPermission()
      startBackgroundLink()
    } finally {
      setBusy(false)
      sync()
    }
  }, [sync])

  const disable = useCallback(() => {
    stopBackgroundLink()
    sync()
  }, [sync])

  if (!supported) {
    if (Platform.OS !== 'ios') return null
    return (
      <Card>
        <CardHeader icon="moon" title="Background link" subtitle="not possible on iOS" tone={palette.muted} />
        <Body tone={palette.muted} style={{ fontSize: size.label }}>
          iOS takes the socket away seconds after an app leaves the screen and gives nothing back that would
          hold it open. Pair the desktop over Bluetooth for the things that must work with the app closed.
        </Body>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader
        icon="moon"
        title="Background link"
        subtitle={enabled ? (running ? 'connected with the app closed' : 'starting') : 'off — this phone goes offline'}
        tone={enabled ? palette.green : palette.orange}
      />
      <Body tone={palette.muted} style={{ fontSize: size.label, marginBottom: space.md }}>
        With this off, the desktop only sees this phone while the app is open on screen — no calls, no messages,
        no battery in the bar. On, a quiet notification keeps the connection alive through sleep, a reboot, and
        the app being swiped away.
      </Body>
      {enabled ? (
        <>
          <DataGrid
            pairs={[
              { label: 'Service', value: running ? 'running' : 'stopped' },
              { label: 'Notification', value: notifications ? 'shown' : 'hidden' },
            ]}
            columns={2}
          />
          {notifications ? null : (
            <>
              <Body tone={palette.muted} style={{ fontSize: size.label, marginTop: space.md }}>
                The link is up, but Android is hiding the notification that says so. It keeps working either
                way — this is only about whether you can see that it is.
              </Body>
              <Button
                icon="bell"
                label="Show the connection notification"
                variant="ghost"
                loading={busy}
                onPress={enable}
              />
            </>
          )}
          <View style={{ height: space.md }} />
          <Button icon="moon" label="Stop staying connected" variant="ghost" onPress={disable} />
        </>
      ) : (
        <Button
          icon="moon"
          label="Stay connected in the background"
          variant="solid"
          loading={busy}
          onPress={enable}
        />
      )}
      {enabled && optimized ? (
        <>
          <Body tone={palette.muted} style={{ fontSize: size.label, marginTop: space.md }}>
            Android is still allowed to put this app to sleep. The link survives ordinary sleep either way, but
            several manufacturers run their own killer on top of it — exempting the app is the one lever there
            is against that.
          </Body>
          <Button icon="battery-charging" label="Turn off battery optimisation" variant="ghost" onPress={openBatterySettings} />
        </>
      ) : null}
    </Card>
  )
}

/**
 * Granting Android the right to read messages and call state.
 *
 * Deliberately a button rather than something asked for at startup: this is
 * the most invasive permission the app has, and the user should be the one who
 * decides to hand it over, at a moment when it is obvious what it buys them.
 */
function PhoneMirror({ enabled }: { enabled: boolean }) {
  const { palette } = useConnection()
  const supported = phoneMirrorSupported()
  const [granted, setGranted] = useState(false)
  const [canAskAgain, setCanAskAgain] = useState(true)
  const [busy, setBusy] = useState(false)
  const [answering, setAnswering] = useState(false)
  const [askingCalls, setAskingCalls] = useState(false)
  const [callerId, setCallerId] = useState(false)
  const [contacts, setContacts] = useState(false)

  useEffect(() => {
    if (!supported) return
    phonePermission().then((result) => {
      setGranted(result.granted)
      setCanAskAgain(result.canAskAgain)
    })
    setAnswering(canAnswerCalls())
    setCallerId(canReadCallNotifications())
    setContacts(canReadContacts())
    // Notification access is granted on a system screen rather than in a
    // dialog, so the only moment we can learn the answer is on the way back.
    const subscription = AppState.addEventListener('change', (next) => {
      if (next !== 'active') return
      setAnswering(canAnswerCalls())
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

  const askCalls = useCallback(async () => {
    setAskingCalls(true)
    try {
      setAnswering(await requestCallPermission())
    } finally {
      setAskingCalls(false)
    }
  }, [])

  if (!enabled) return null

  return (
    <Card>
      <CardHeader
        icon="message-square"
        title="Messages and calls"
        subtitle={
          supported
            ? granted
              ? 'mirroring to the desktop'
              : 'permission needed'
            : Platform.OS === 'ios'
              ? 'over Bluetooth, not the app'
              : 'not available here'
        }
        tone={supported && granted ? palette.green : palette.orange}
      />
      {supported ? (
        <>
          <Body tone={palette.muted} style={{ fontSize: size.label, marginBottom: space.md }}>
            Incoming messages and calls appear as desktop notifications. With the background link on they
            arrive as they happen; with it off they wait in a queue on this phone until you next open the app.
          </Body>
          {granted ? (
            <DataGrid pairs={[{ label: 'Status', value: 'granted' }]} columns={1} />
          ) : (
            <Button
              icon="shield"
              label={canAskAgain ? 'Allow SMS and calls' : 'Open Android settings to allow'}
              variant="solid"
              loading={busy}
              disabled={!canAskAgain}
              onPress={ask}
            />
          )}
          <Body tone={palette.muted} style={{ fontSize: size.label, marginTop: space.md }}>
            Answering from the desktop is a separate permission, because picking up someone's call is not a
            passive act. Granted here, the call is answered but the audio stays on this phone — pair the desktop
            over Bluetooth if you want to speak through it.
          </Body>
          {answering ? (
            <DataGrid pairs={[{ label: 'Answer calls', value: 'granted' }]} columns={1} />
          ) : (
            <Button
              icon="phone"
              label="Allow answering from the desktop"
              variant="ghost"
              loading={askingCalls}
              onPress={askCalls}
            />
          )}
          <Body tone={palette.muted} style={{ fontSize: size.label, marginTop: space.md }}>
            Android no longer tells any app who is calling — without notification access the desktop shows an
            incoming call as "unknown". Granting it lets this app read the caller's name off your dialler's own
            notification. Call notifications are the only ones it looks at.
          </Body>
          {callerId ? (
            <DataGrid
              pairs={[
                { label: 'Caller ID', value: 'granted' },
                { label: 'Contact names', value: contacts ? 'granted' : 'denied' },
              ]}
              columns={2}
            />
          ) : (
            <Button
              icon="user"
              label="Show who is calling"
              variant="ghost"
              onPress={openNotificationAccess}
            />
          )}
          {callerId && !contacts ? (
            <>
              <Body tone={palette.muted} style={{ fontSize: size.label, marginTop: space.md }}>
                Your dialler is being read, but the address book is not — so a caller who is saved on this phone
                still reaches the desktop as a bare number.
              </Body>
              <Button
                icon="users"
                label={canAskAgain ? 'Allow reading contacts' : 'Open Android settings to allow'}
                variant="ghost"
                loading={busy}
                disabled={!canAskAgain}
                onPress={ask}
              />
            </>
          ) : null}
        </>
      ) : Platform.OS === 'ios' ? (
        <IosBridge />
      ) : (
        <Body tone={palette.muted} style={{ fontSize: size.label }}>
          This needs a real Android build — Expo Go cannot hold the SMS and call-log permissions.
        </Body>
      )}
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
      <Body tone={palette.muted} style={{ fontSize: size.label, marginBottom: space.md }}>
        iOS gives no app access to messages, the call log, or notifications — including this one. It gives all of
        them to a Bluetooth accessory, so the desktop asks to be one. Pair this iPhone with it and your messages,
        calls and app notifications appear on the desktop with no app running at all.
      </Body>
      <DataGrid
        pairs={[
          { label: 'Bridge', value: live ? 'mirroring' : bridge?.paired ? 'paired, idle' : 'not paired' },
          { label: 'Desktop sees', value: bridge?.device ?? '—' },
        ]}
        columns={2}
      />
      {live ? null : (
        <Body tone={palette.muted} style={{ fontSize: size.label, marginTop: space.md }}>
          On the desktop run{' '}
          <Body tone={palette.bright_foreground} style={{ fontSize: size.label, fontFamily: font.bold }}>
            omarchy-connect ios pair
          </Body>
          , then open Settings › Bluetooth here and tap the desktop. iOS will ask whether to show notifications on
          it — that prompt is the whole feature.
        </Body>
      )}
      <Button
        icon="refresh-cw"
        label="Check the bridge"
        variant="ghost"
        loading={checking}
        onPress={refresh}
        style={{ marginTop: space.md }}
      />
    </>
  )
}

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

function statusLabel(status: string) {
  switch (status) {
    case 'connected':
      return 'connected'
    case 'reconnecting':
      return 'reconnecting…'
    case 'parked':
      return 'waiting for your network'
    case 'connecting':
      return 'connecting…'
    case 'error':
      return 'connection problem'
    default:
      return 'offline'
  }
}
