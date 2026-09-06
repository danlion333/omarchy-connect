import React, { useCallback, useEffect, useRef, useState } from 'react'
import { ActivityIndicator, KeyboardAvoidingView, ScrollView, View } from 'react-native'

import { useConnection, usePalette } from '../state/ConnectionContext'
import { alpha, font, radius, size, space } from '../theme'
import {
  Card,
  CardHeader,
  Chip,
  ChipRow,
  Empty,
  Field,
  Hint,
  IconButton,
  Mono,
  Notice,
  Pill,
  Screen,
  ScreenHeader,
  useToast,
} from '../ui/kit'

/**
 * Workspace 3: the phone as a keyboard for the desktop.
 *
 * The one thing this screen is not is a terminal. The desktop has no output
 * readback — `input.text` and `input.key` push keystrokes at whatever window
 * Hyprland has focused and nothing comes back — so the log in the middle of
 * the screen is the history of what *this phone sent*, and it is labelled
 * that way. Nothing here ever claims to be what the desktop replied.
 *
 * Which makes the "Target" card the important one: keys land in the focused
 * window, so the screen says which window that is, in what workspace, and
 * warns when it is not a terminal at all. The mock drew a thumbnail of the
 * desktop with the terminal's output in it; that is the one thing the daemon
 * cannot provide, so the thumbnail became the truth it was standing in for.
 */
export function TerminalScreen() {
  const palette = usePalette()
  const { call, can, status } = useConnection()
  const toast = useToast()

  const connected = status === 'connected'
  const canType = can('input', 'text')
  const canKeys = can('input', 'keys')
  const canWindows = can('desktop', 'hyprland')
  const canLaunch = can('desktop', 'launch')

  const [windows, setWindows] = useState<Window[] | null>(null)
  const [loadingWindows, setLoadingWindows] = useState(false)
  const [windowsError, setWindowsError] = useState<unknown>(null)

  const [sent, setSent] = useState<Sent[]>([])
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [sendError, setSendError] = useState<unknown>(null)
  const [launching, setLaunching] = useState(false)

  const seq = useRef(0)
  const push = useCallback((text: string) => {
    seq.current += 1
    const entry: Sent = { id: seq.current, text, at: clockOf(new Date()) }
    setSent((was) => [...was, entry].slice(-HISTORY))
  }, [])

  /**
   * The focused window, re-read on mount, on the refresh button, and after
   * every send — a command that opened a new window has moved the target, and
   * a card that still names the old one would be lying about where the next
   * keystroke goes.
   */
  const loadWindows = useCallback(async () => {
    if (!connected || !canWindows) return
    setLoadingWindows(true)
    try {
      const res = await call<{ windows: Window[] }>('hypr.windows')
      setWindows(res.windows)
      setWindowsError(null)
    } catch (error) {
      setWindowsError(error)
    } finally {
      setLoadingWindows(false)
    }
  }, [call, canWindows, connected])

  useEffect(() => {
    void loadWindows()
  }, [loadWindows])

  const target = windows ? (windows.find((w) => w.focused) ?? null) : null
  const onTerminal = target ? isTerminalClass(target.class) : true

  const send = useCallback(async () => {
    const text = draft.trim()
    if (!text || sending) return
    setSending(true)
    setSendError(null)
    try {
      await call('input.text', { text })
      await call('input.key', { key: 'Return' })
      setDraft('')
      push(`❯ ${text}`)
      toast({ value: text, hint: 'typed into the desktop terminal' })
      void loadWindows()
    } catch (error) {
      setSendError(error)
    } finally {
      setSending(false)
    }
  }, [call, draft, loadWindows, push, sending, toast])

  const press = useCallback(
    async (key: KeyChip) => {
      setSendError(null)
      try {
        await call('input.key', { key: key.key, mods: key.mods ?? '' })
        push(key.entry)
        toast({ value: key.label, hint: 'sent to the desktop' })
        void loadWindows()
      } catch (error) {
        setSendError(error)
      }
    },
    [call, loadWindows, push, toast],
  )

  const openOnDesktop = useCallback(async () => {
    setLaunching(true)
    try {
      await call('system.launch', { app: 'floating-terminal' })
      toast({ value: 'Floating terminal', hint: 'opened on the desktop' })
      void loadWindows()
    } catch (error) {
      setSendError(error)
    } finally {
      setLaunching(false)
    }
  }, [call, loadWindows, toast])

  const sub = !connected
    ? 'not connected'
    : target
      ? `${target.class} · workspace ${target.workspace}`
      : canWindows
        ? 'nothing focused on the desktop'
        : 'typing into the focused window'

  return (
    <KeyboardAvoidingView
      // `padding` on both platforms, as the agent chat does: Android 15 stopped
      // resizing the window under an edge-to-edge app, so without this the
      // command field sits behind the keyboard it just raised.
      behavior="padding"
      style={{ flex: 1 }}
    >
      <Screen>
        <ScreenHeader
          title="Terminal"
          sub={sub}
          dot={connected ? 'ok' : 'off'}
          right={
            <>
              {canLaunch ? (
                <IconButton
                  icon="external-link"
                  label="Open on desktop"
                  onPress={openOnDesktop}
                  loading={launching}
                  disabled={!connected}
                />
              ) : null}
              <IconButton
                icon="refresh-cw"
                label="Read the focused window again"
                onPress={() => void loadWindows()}
                loading={loadingWindows && windows !== null}
                disabled={!connected || !canWindows}
              />
            </>
          }
        />

        {/* The fifth state for the whole screen: with no link there is no
            window to type into and no key to send, so everything below is
            dimmed at once rather than each card explaining the same thing. */}
        {!connected ? <Hint icon="wifi-off">Not connected · the keys have nowhere to go until the desktop answers</Hint> : null}

        <View style={{ opacity: connected ? 1 : 0.62 }} pointerEvents={connected ? 'auto' : 'none'}>
          <Card dim={!canWindows}>
            <CardHeader
              icon="monitor"
              title={target ? target.class : canWindows ? 'No focused window' : 'Target'}
              subtitle={target ? target.title : null}
              tone={canWindows ? undefined : palette.muted}
              right={target ? <Pill label={`workspace ${target.workspace}`} caps={false} /> : null}
            />
            {!canWindows ? (
              <Hint>This desktop does not run Hyprland · keys still go to whatever it has focused</Hint>
            ) : windowsError ? (
              <Notice error={windowsError} tone="warning" action={{ label: 'Try again', onPress: () => void loadWindows() }} />
            ) : windows === null ? (
              <View style={{ paddingVertical: space.md }}>
                <ActivityIndicator size="small" color={palette.light_foreground} />
              </View>
            ) : !onTerminal ? (
              <Hint tone={palette.orange} icon="alert-triangle">
                Keys go to this window · focus a terminal on the desktop first
              </Hint>
            ) : (
              <Hint>Keys go to this window</Hint>
            )}
          </Card>

          <Card>
            <CardHeader icon="corner-down-left" title="Sent" subtitle="from this phone, this session" />
            {sent.length ? (
              <SentLog entries={sent} />
            ) : (
              <Empty icon="terminal" text="Nothing sent yet" />
            )}
            <Hint>The desktop sends nothing back · this is what went out, not what it answered</Hint>
          </Card>

          <Notice
            error={sendError}
            tone="error"
            action={{ label: 'Try again', onPress: () => void send() }}
            onDismiss={() => setSendError(null)}
          />

          <ChipRow>
            {KEYS.map((key) => (
              <Chip key={key.label} label={key.label} onPress={() => void press(key)} disabled={!canKeys || !connected} />
            ))}
            {INSERTS.map((snippet) => (
              <Chip
                key={snippet}
                label={snippet.trim()}
                onPress={() => setDraft((was) => insertSnippet(was, snippet))}
                disabled={!canType || !connected}
              />
            ))}
          </ChipRow>
          {!canKeys ? <Hint>The desktop cannot send keys · Hyprland is not answering</Hint> : null}

          {/* No `disabled` on `Field` yet, so the "not possible here" state is
              drawn around it: dimmed, deaf to touches, and told why. */}
          <View style={{ opacity: canType ? 1 : 0.62, marginTop: space.sm }} pointerEvents={canType ? 'auto' : 'none'}>
            <Field
              value={draft}
              onChange={setDraft}
              placeholder="Type a command"
              icon="chevron-right"
              onSubmit={() => void send()}
              right={
                <IconButton
                  icon="send"
                  label="Send to the desktop"
                  onPress={() => void send()}
                  loading={sending}
                  disabled={!draft.trim()}
                />
              }
            />
          </View>
          {!canType ? <Hint>Needs wtype on the desktop</Hint> : null}
        </View>
      </Screen>
    </KeyboardAvoidingView>
  )
}

/* ── the local pieces ─────────────────────────────────────────────────── */

/**
 * The mock's `.term` block: a dark panel that grows to a point and then
 * scrolls, always showing its end.
 *
 * A candidate for the kit if a second screen ever wants a running log — it is
 * `Code` with a height budget and an auto-scroll.
 */
function SentLog({ entries }: { entries: Sent[] }) {
  const p = usePalette()
  const ref = useRef<ScrollView>(null)
  return (
    <View
      style={{
        backgroundColor: alpha(p.darker_background, 0.82),
        borderRadius: radius.ctl,
        minHeight: 160,
        maxHeight: 260,
      }}
    >
      <ScrollView
        ref={ref}
        onContentSizeChange={() => ref.current?.scrollToEnd({ animated: false })}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingVertical: 10, paddingHorizontal: space.md }}
      >
        {entries.map((entry) => (
          <View key={entry.id} style={{ flexDirection: 'row', alignItems: 'flex-start', gap: space.sm }}>
            <Mono
              style={{ flex: 1, color: p.bright_foreground, fontFamily: font.regular, fontSize: size.label, lineHeight: 18 }}
            >
              {entry.text}
            </Mono>
            <Mono style={{ color: p.muted, fontFamily: font.regular, fontSize: size.label, lineHeight: 18 }}>{entry.at}</Mono>
          </View>
        ))}
      </ScrollView>
    </View>
  )
}

/* ── the pure parts ───────────────────────────────────────────────────── */

export type Window = { address: string; title: string; class: string; workspace: number; focused: boolean }

type Sent = { id: number; text: string; at: string }

type KeyChip = {
  label: string
  /** What `input.key` is asked for — Hyprland's own key names. */
  key: string
  /** Hyprland modifier names, space separated. */
  mods?: string
  /** How the press reads in the Sent log. */
  entry: string
}

/** How many lines of history the screen keeps before the oldest fall off. */
const HISTORY = 200

/**
 * The keys a phone cannot type but a terminal cannot do without: the two that
 * interrupt, the one that completes, and the history arrows.
 */
const KEYS: KeyChip[] = [
  { label: 'Esc', key: 'Escape', entry: '⎋ Esc' },
  { label: 'Tab', key: 'Tab', entry: '⇥ Tab' },
  { label: 'Ctrl+C', key: 'c', mods: 'CTRL', entry: '^C' },
  { label: '↑', key: 'Up', entry: '↑' },
  { label: '↓', key: 'Down', entry: '↓' },
  { label: 'Ctrl+D', key: 'd', mods: 'CTRL', entry: '^D' },
  { label: 'Ctrl+L', key: 'l', mods: 'CTRL', entry: '^L' },
]

/** Prefixes worth a tap rather than a spelling, on a phone keyboard. */
const INSERTS = ['~/', '| ', 'uwsm-app -- ', 'systemctl --user ', 'omarchy ', 'git ', 'sudo ']

/** The classes that are a shell prompt rather than a browser about to eat a `git status`. */
const TERMINALS = [
  'alacritty',
  'foot',
  'footclient',
  'kitty',
  'ghostty',
  'com.mitchellh.ghostty',
  'wezterm',
  'org.wezfurlong.wezterm',
]

export function isTerminalClass(cls: string | null | undefined): boolean {
  if (!cls) return false
  const name = cls.toLowerCase()
  return TERMINALS.some((t) => name === t || name.endsWith(`.${t}`))
}

/**
 * A chip's text joined to the draft the way a shell would read it: a new word
 * unless the draft already ends in a space.
 */
export function insertSnippet(draft: string, snippet: string): string {
  if (!draft) return snippet
  return /\s$/.test(draft) ? draft + snippet : `${draft} ${snippet}`
}

function clockOf(date: Date): string {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}
