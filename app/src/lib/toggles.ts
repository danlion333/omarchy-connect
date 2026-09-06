import React from 'react'
import { AppState } from 'react-native'

import { useConnection } from '../state/ConnectionContext'

export type ToggleName = 'nightlight' | 'idle' | 'silencing'

/** One switch as the desktop sees it. `null` is "this machine cannot be asked". */
export type ToggleState = { on: boolean } | null

export type Toggles = Record<ToggleName, ToggleState>

export const TOGGLE_COMMAND: Record<ToggleName, string> = {
  nightlight: 'omarchy-toggle-nightlight',
  idle: 'omarchy-toggle-idle',
  silencing: 'omarchy-toggle-notification-silencing',
}

type Snapshot = { toggles: Toggles | null; loading: boolean; error: unknown }

/**
 * The three desktop switches, kept once for the whole app.
 *
 * Two places read them — the Toggles tiles on Home and the bell in the
 * Omarchy bar — and reading them costs the desktop three processes, one of
 * which talks to Quickshell over IPC. So the answer lives in a module rather
 * than in either component: one request serves both, a flip on Home moves the
 * bar's bell in the same frame, and a second mount does not spawn a second
 * round of scripts.
 *
 * There is no push event for any of them, so the state is re-read after a
 * flip and whenever the app comes back to the foreground — the user may well
 * have been on the desktop in between.
 */
let snapshot: Snapshot = { toggles: null, loading: false, error: null }
const listeners = new Set<() => void>()
let inflight: Promise<void> | null = null

function publish(next: Partial<Snapshot>) {
  snapshot = { ...snapshot, ...next }
  for (const listener of listeners) listener()
}

/** Forgets everything read so far — for tests, and for a desktop being unpaired. */
export function forgetToggles() {
  inflight = null
  publish({ toggles: null, loading: false, error: null })
}

export type TogglesValue = {
  toggles: Toggles | null
  /** Flips one switch on the desktop and answers with where it ended up. */
  flip: (name: ToggleName) => Promise<ToggleState>
  refresh: () => Promise<void>
  /** True only while nothing has been read yet — a reload keeps the old tiles up. */
  loading: boolean
  error: unknown
}

export function useToggles(): TogglesValue {
  const { call, can, status } = useConnection()
  const [, bump] = React.useReducer((n: number) => n + 1, 0)

  React.useEffect(() => {
    listeners.add(bump)
    return () => {
      listeners.delete(bump)
    }
  }, [])

  const offered = can('desktop', 'toggles')
  const connected = status === 'connected'

  const refresh = React.useCallback(async () => {
    if (!offered) return
    if (inflight) return inflight
    publish({ loading: snapshot.toggles === null })
    inflight = call<Toggles>('system.toggles')
      .then((res) => publish({ toggles: res, error: null, loading: false }))
      .catch((err) => publish({ error: err, loading: false }))
      .finally(() => {
        inflight = null
      })
    return inflight
  }, [call, offered])

  // First read, and again whenever the link comes back: the desktop may have
  // been touched by hand while the phone was away.
  React.useEffect(() => {
    if (connected && offered) void refresh()
  }, [connected, offered, refresh])

  React.useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active' && connected && offered) void refresh()
    })
    return () => sub.remove()
  }, [connected, offered, refresh])

  const flip = React.useCallback(
    async (name: ToggleName): Promise<ToggleState> => {
      const res = await call<{ name: ToggleName; on: boolean | null }>('system.toggle', { name })
      const state: ToggleState = res.on === null || res.on === undefined ? null : { on: res.on }
      publish({
        toggles: {
          nightlight: null,
          idle: null,
          silencing: null,
          ...(snapshot.toggles ?? {}),
          [name]: state,
        },
        error: null,
      })
      // The reply carries the switch it moved; the re-read carries the ones a
      // script may have moved with it.
      void refresh()
      return state
    },
    [call, refresh],
  )

  return { toggles: snapshot.toggles, flip, refresh, loading: snapshot.loading, error: snapshot.error }
}
