import * as Clipboard from 'expo-clipboard'
import * as Haptics from 'expo-haptics'
import React, { useCallback, useEffect, useRef, useState } from 'react'
import {
  ActivityIndicator,
  AppState,
  KeyboardAvoidingView,
  type LayoutChangeEvent,
  Pressable,
  ScrollView,
  View,
} from 'react-native'

import { fitCols, fitRows, rememberCommand, screenLines, shortPath, type Shot, type TerminalCaps } from '../lib/terminal'
import { useConnection, usePalette } from '../state/ConnectionContext'
import { alpha, font, line, radius, size, space } from '../theme'
import { Card, CardHeader, Chip, ChipRow, Field, Hint, IconButton, Mono, Notice, Screen, ScreenHeader, useToast } from '../ui/kit'

/**
 * Workspace 3: the desktop's shell, on the phone.
 *
 * This screen used to be a keyboard. The desktop had no readback — `input.text`
 * and `input.key` pushed keystrokes at whatever window Hyprland had focused and
 * nothing came back — so the panel in the middle was the log of what *this
 * phone had sent*, the card at the top warned you when the focused window was
 * not a terminal, and "create that directory, grep that, look at the output"
 * was not a thing you could do from the sofa at all.
 *
 * The daemon's `terminal` plugin is what replaced all of that. There is one
 * tmux session on the desktop; this screen types into it and reads it back.
 * The three parts are the three the shell has: where you are (`cwd`, in the
 * header), what it says (the pane, in the middle), and what you say next (the
 * field and the chips, over the keyboard).
 *
 * **The screen is pushed, never polled.** The phone subscribes to `terminal`
 * while it is looking at it and the desktop sends a whole new screen within a
 * quarter of a second of the pane changing — and nothing at all while it does
 * not. The subscription is held only while this workspace is on screen and the
 * app is in the foreground, because `capture-pane` on the desktop is a read of
 * somebody's terminal and a phone in a pocket has no business asking for one.
 */
export function TerminalScreen({ visible = true }: { visible?: boolean }) {
  const palette = usePalette()
  const { call, client, hello, status } = useConnection()
  const toast = useToast()

  const caps = (hello?.capabilities?.terminal ?? null) as TerminalCaps | null
  const connected = status === 'connected'
  const enabled = caps?.enabled === true
  // Absent capabilities are a daemon too old to have the plugin at all, which
  // from this screen is indistinguishable from a desktop without tmux, and the
  // sentence to say is the same one.
  const available = caps ? caps.available === true : false
  const canAttach = caps?.attach === true

  const [shot, setShot] = useState<Shot | null>(null)
  const [gone, setGone] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [history, setHistory] = useState<string[]>([])
  const [copied, setCopied] = useState<number | null>(null)
  const [attaching, setAttaching] = useState(false)
  const [pane, setPane] = useState({ width: 0, height: 0 })

  /* The app in front of somebody, which is half of "is anybody looking". */
  const [active, setActive] = useState(AppState.currentState === 'active')
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => setActive(state === 'active'))
    return () => sub.remove()
  }, [])

  const cols = fitCols(pane.width, size.micro)
  const rows = fitRows(pane.height, line.micro)

  /**
   * The `terminal` feed, held for exactly as long as somebody is looking at
   * this workspace and no longer — not while the app is behind another one,
   * and not while the phone is in a pocket with the workspace still mounted
   * (every workspace stays mounted once visited).
   *
   * Held even when the shell is switched off, which is the one case worth
   * spelling out: `kind: "control"` is how the desktop says it has just been
   * switched **on**, and it goes to the subscribers of this very feed. A phone
   * that only subscribed once it was already allowed would never hear it, and
   * this screen would sit there telling its owner to run a command they ran a
   * minute ago. It costs nothing to hold: with no `terminal.open` outstanding
   * the desktop does not read the pane at all, so an off — or merely unwatched
   * — shell sends nothing.
   */
  const looking = connected && visible && active
  useEffect(() => {
    if (!client || !looking) return
    client.subscribe([EVENT])
    return () => client.unsubscribe([EVENT])
  }, [client, looking])

  /**
   * Open the shell, and give it up again when nobody is looking.
   *
   * This is the other half and it is a different question: the subscription is
   * what the desktop sends, `terminal.open`/`terminal.close` is whether it
   * reads the pane at all. A size change re-runs it, which is how a phone that
   * was turned sideways resizes the session it is already in — `terminal.open`
   * on an existing session is a resize and a read, not a new shell.
   */
  const watching = looking && enabled && available && cols > 0 && rows > 0
  useEffect(() => {
    if (!client || !watching) return
    let live = true
    call<Shot>('terminal.open', { cols, rows })
      .then((res) => {
        if (!live) return
        setShot(res)
        setGone(false)
        setError(null)
      })
      .catch((err) => live && setError(err))
    return () => {
      live = false
      // The socket may already be gone, in which case the desktop stopped
      // reading the pane when it lost the subscriber and there is nothing here
      // worth reporting.
      call('terminal.close').catch(() => {})
    }
  }, [call, client, cols, rows, watching])

  /* Every redraw of the screen arrives here. Nothing on this screen polls. */
  useEffect(() => {
    if (!client) return
    return client.on('ev:terminal', (data: TerminalEvent) => {
      if (data?.kind === 'screen') {
        setShot({ screen: data.screen, cwd: data.cwd, running: data.running, cols: data.cols, rows: data.rows })
        setGone(false)
        setError(null)
        return
      }
      // Exited out of. The screen on the phone is of a shell that no longer
      // exists, so it stops being drawn as if it were live; the next thing
      // typed makes a new session.
      if (data?.kind === 'gone') setGone(true)
    })
  }, [client])

  const scroller = useRef<ScrollView>(null)
  const atBottom = useRef(true)
  const lines = screenLines(shot?.screen)

  /* Follow the shell, unless the reader has flicked back to look at something. */
  useEffect(() => {
    if (atBottom.current) requestAnimationFrame(() => scroller.current?.scrollToEnd({ animated: false }))
  }, [shot])

  /**
   * A new shell, after the old one was exited out of.
   *
   * `terminal.type` and `terminal.key` make a session on the desktop if there
   * is none, so the command has already landed by the time this runs; what it
   * is for is the watching, which stopped when the session died.
   */
  const reopen = useCallback(async () => {
    if (!client) return
    try {
      const res = await call<Shot>('terminal.open', { cols, rows })
      setShot(res)
      setGone(false)
    } catch (err) {
      setError(err)
    }
  }, [call, client, cols, rows])

  const send = useCallback(async () => {
    const text = draft.trim()
    if (!text || sending) return
    setSending(true)
    setError(null)
    try {
      await call('terminal.type', { text })
      await call('terminal.key', { key: 'Enter' })
      setDraft('')
      setHistory((was) => rememberCommand(was, text))
      if (gone) await reopen()
    } catch (err) {
      setError(err)
    } finally {
      setSending(false)
    }
  }, [call, draft, gone, reopen, sending])

  const press = useCallback(
    async (key: string) => {
      setError(null)
      try {
        await call('terminal.key', { key })
        if (gone) await reopen()
      } catch (err) {
        setError(err)
      }
    },
    [call, gone, reopen],
  )

  /**
   * One line of the shell, into the phone's clipboard.
   *
   * A long press rather than a tap: a tap on the pane is how you dismiss the
   * keyboard, and a screen that copied a line every time somebody put the
   * keyboard away would be unusable. The flash and the haptic are the code
   * block's, in `ui/markdown`.
   */
  const flash = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(
    () => () => {
      if (flash.current) clearTimeout(flash.current)
    },
    [],
  )
  const copyLine = useCallback((index: number, text: string) => {
    void Clipboard.setStringAsync(text)
    void Haptics.selectionAsync().catch(() => {})
    setCopied(index)
    if (flash.current) clearTimeout(flash.current)
    flash.current = setTimeout(() => setCopied(null), 1400)
  }, [])

  const attach = useCallback(async () => {
    setAttaching(true)
    try {
      const res = await call<{ session: string }>('terminal.attach')
      toast({ value: res.session, hint: 'opened on the desktop' })
    } catch (err) {
      setError(err)
    } finally {
      setAttaching(false)
    }
  }, [call, toast])

  const where = shortPath(shot?.cwd)
  const sub = !connected
    ? 'not connected'
    : !available
      ? 'no shell on this desktop'
      : !enabled
        ? 'off on the desktop'
        : gone
          ? 'the shell was closed'
          : (where ?? 'opening a shell')

  /* Not possible here: no multiplexer, so there is no shell to draw a card
     around. One line, and not an empty panel above it pretending otherwise. */
  if (connected && !available) {
    return (
      <Screen>
        <ScreenHeader title="Terminal" sub={sub} dot="off" />
        <Hint icon="terminal">This desktop has no tmux · there is no shell the phone can open</Hint>
      </Screen>
    )
  }

  /* Switched off at the desktop. The card stays, dimmed, with the one command
     that fills it — the Agents screen's state, for the same switch. */
  if (connected && !enabled) {
    return (
      <Screen>
        <ScreenHeader title="Terminal" sub={sub} dot="off" />
        <Card dim>
          <CardHeader icon="terminal" title="Shell" subtitle="off on the desktop" tone={palette.muted} />
          <Hint icon="power">Switch on with omarchy-connect terminal on</Hint>
        </Card>
      </Screen>
    )
  }

  const running = shot?.running === true

  return (
    <KeyboardAvoidingView
      // `padding` on both platforms, as the agent chat does: Android 15 stopped
      // resizing the window under an edge-to-edge app, so without this the
      // command field sits behind the keyboard it just raised.
      behavior="padding"
      style={{ flex: 1 }}
    >
      <Screen scroll={false}>
        <ScreenHeader
          title="Terminal"
          sub={sub}
          dot={connected ? (running ? 'warn' : 'ok') : 'off'}
          right={
            canAttach ? (
              <IconButton
                icon="external-link"
                label="Open on desktop"
                onPress={() => void attach()}
                loading={attaching}
                disabled={!connected}
              />
            ) : null
          }
        />

        {!connected ? <Hint icon="wifi-off">Not connected · nothing typed here can reach the desktop</Hint> : null}

        {/* The pane. It is measured before it is filled — the size it reports
            is the size the desktop wraps the shell to. */}
        <View
          onLayout={(event: LayoutChangeEvent) => {
            const { width, height } = event.nativeEvent.layout
            setPane((was) => (Math.abs(was.width - width) < 1 && Math.abs(was.height - height) < 1 ? was : { width, height }))
          }}
          style={{
            flex: 1,
            marginTop: space.xs,
            marginBottom: space.sm,
            borderRadius: radius.ctl,
            backgroundColor: alpha(palette.darker_background, 0.82),
            overflow: 'hidden',
          }}
        >
          <ScrollView
            ref={scroller}
            onScroll={(event) => {
              const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent
              atBottom.current = contentOffset.y + layoutMeasurement.height >= contentSize.height - 24
            }}
            scrollEventThrottle={32}
            showsVerticalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={{ paddingVertical: space.sm, paddingHorizontal: space.md }}
          >
            {shot === null && connected && !error ? (
              <ActivityIndicator size="small" color={palette.light_foreground} style={{ paddingVertical: space.lg }} />
            ) : null}
            {lines.map((text, i) => (
              <Pressable key={i} onLongPress={() => copyLine(i, text)} delayLongPress={350}>
                <Mono
                  numberOfLines={1}
                  style={{
                    color: copied === i ? palette.green : palette.light_foreground,
                    fontFamily: font.regular,
                    fontSize: size.micro,
                    lineHeight: line.micro,
                  }}
                >
                  {text || ' '}
                </Mono>
              </Pressable>
            ))}
          </ScrollView>
        </View>

        {copied !== null ? <Hint icon="check" tone={palette.green}>Line copied to this phone</Hint> : null}
        {gone ? <Hint icon="power">The shell was closed on the desktop · the next command starts a new one</Hint> : null}

        <Notice error={error} tone="error" onDismiss={() => setError(null)} />

        {/* What this phone has already run, newest first, one tap back into the
            field. A phone keyboard is the reason: `systemctl --user status
            omarchy-connect` is not a thing anybody wants to type twice. */}
        {history.length ? (
          <ChipRow style={{ marginBottom: space.xs }}>
            {history.map((command) => (
              <Chip key={command} label={command} icon="corner-up-left" onPress={() => setDraft(command)} />
            ))}
          </ChipRow>
        ) : null}

        <ChipRow style={{ marginBottom: space.sm }}>
          {/* First in the row and lit while there is something to interrupt:
              the one key you reach for in a hurry is not one to hunt for. */}
          <Chip
            label="Ctrl+C"
            icon={running ? 'x-octagon' : undefined}
            active={running}
            tone={running ? palette.orange : undefined}
            onPress={() => void press('C-c')}
            disabled={!connected}
          />
          {KEYS.map((key) => (
            <Chip key={key.key} label={key.label} onPress={() => void press(key.key)} disabled={!connected} />
          ))}
        </ChipRow>

        <Field
          value={draft}
          onChange={setDraft}
          placeholder={running ? 'Running · type to answer it' : 'Type a command'}
          icon="chevron-right"
          onSubmit={() => void send()}
          right={
            <IconButton
              icon="send"
              label="Run on the desktop"
              onPress={() => void send()}
              loading={sending}
              disabled={!draft.trim() || !connected}
            />
          }
        />
      </Screen>
    </KeyboardAvoidingView>
  )
}

/* ── the pure parts ───────────────────────────────────────────────────── */

/** The event this screen holds a subscription to while it is being looked at. */
const EVENT = 'terminal'

type TerminalEvent =
  | ({ kind: 'screen' } & Shot)
  | { kind: 'gone' }
  | { kind: 'control'; enabled: boolean; available: boolean }

/**
 * The keys a phone cannot type but a shell cannot do without: completion, the
 * escape, the history and line arrows, end-of-input and the clear.
 *
 * Names are tmux's own, which is what `capabilities.terminal.keys` publishes
 * and what `terminal.key` takes — not Hyprland keysyms, which is what this
 * screen used to send when it was pushing keys at a window.
 */
const KEYS: { label: string; key: string }[] = [
  { label: 'Tab', key: 'Tab' },
  { label: 'Esc', key: 'Escape' },
  { label: '↑', key: 'Up' },
  { label: '↓', key: 'Down' },
  { label: '←', key: 'Left' },
  { label: '→', key: 'Right' },
  { label: 'Ctrl+D', key: 'C-d' },
  { label: 'Ctrl+L', key: 'C-l' },
  { label: 'Ctrl+U', key: 'C-u' },
]
