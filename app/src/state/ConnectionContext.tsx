import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'

import type { ConnectClient, ConnectionStatus } from '../api/client'
import { link, type ClipboardEvent, type FileEvent, type LinkState } from '../api/link'
import type { PairingTarget } from '../api/discovery'
import { fingerprint as keyFingerprint } from '../api/crypto'
import { agentsSlice, shallowEqual, statusSlice, type AgentsSlice, type StatusSlice } from '../lib/state'
import { FALLBACK_PALETTE, type Palette } from '../theme'
import type { Stats } from '../api/client'

export type { ClipboardEvent, FileEvent }
export type { AgentsSlice }

/**
 * The things a screen can ask the link to do.
 *
 * All of them are thin wrappers around a module that outlives the tree, so
 * none of them ever change for the life of the app. That is what makes them
 * worth a context of their own: a component that only sends — the share sheet,
 * the remote — subscribes to nothing that moves.
 */
type Actions = {
  refreshAgents: () => Promise<void>
  /** Asks for them, and answers with which are also sessions to walk into. */
  refreshAgentJobs: () => Promise<Record<string, string>>
  call: <T = any>(method: string, params?: Record<string, unknown>) => Promise<T>
  pair: (target: PairingTarget) => Promise<void>
  reconnect: () => void
  /** Clears the desktop's last complaint once it has been read. */
  dismissServerError: () => void
  /** Sends the magic packet, then waits for the desktop to answer again. */
  wake: () => Promise<boolean>
  forget: () => Promise<void>
  /** Adds an address by hand, after proving it is the paired desktop. */
  addEndpoint: (host: string, port: number) => Promise<{ ok: boolean; error?: string }>
  removeEndpoint: (host: string, port: number) => Promise<void>
  /**
   * Says "somebody is reading the stats" for as long as the returned function
   * has not been called. Nothing is subscribed to the desktop's 1 Hz sampler
   * while no screen is holding one.
   */
  watchStats: () => () => void
  /**
   * Offer this phone's microphone to the desktop, or take it back. What comes
   * of it is read off `mic` in the status slice, not returned here: the answer
   * outlives the press, and the card has to be right for a screen that was not
   * mounted when the button was pressed.
   */
  offerMic: () => Promise<void>
}

/** The link itself, plus the two things derived from it rather than sent. */
type StatusValue = StatusSlice & {
  fingerprint: string | null
  can: (plugin: string, feature: string) => boolean
}

export type ConnectionValue = StatusValue & Actions & { palette: Palette }

/**
 * Five contexts where there used to be one.
 *
 * The old single value was rebuilt on every `LinkState`, and the link makes a
 * new one of those once a second for the stats sampler and twice that again
 * while an agent is typing. Every consumer in the tree re-rendered for each —
 * and nearly every consumer in this app is a `usePalette()` inside a `Label`
 * or a `Card`, reading a value that changes when the desktop's theme changes
 * and at no other time.
 *
 * So the state is served in the shapes it actually moves in. A palette that
 * moves with the theme, a status that moves with the socket, stats that move
 * every second, agents that move while one is running, and actions that never
 * move at all. What a component reads is now what re-renders it.
 */
const PaletteContext = createContext<Palette>(FALLBACK_PALETTE)
const StatusContext = createContext<StatusValue | null>(null)
const StatsContext = createContext<Stats | null>(null)
const AgentsContext = createContext<AgentsSlice | null>(null)
const ActionsContext = createContext<Actions | null>(null)

/**
 * A window onto the link, not the link itself.
 *
 * Everything that has to survive the app being backgrounded — the socket, the
 * reconnection, the phone mirror, the event history — lives in `api/link`,
 * which is owned by the process rather than by this tree. What is left here is
 * what only a screen cares about: React state to render from.
 */
export function ConnectionProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<LinkState>(link.state)

  useEffect(() => {
    // Subscribe before starting: the link may already be connected — the
    // service can have brought it up long before this tree was mounted — and
    // its first state has to be picked up either way.
    const unsubscribe = link.subscribe(setState)
    setState(link.state)
    void link.start()
    return unsubscribe
  }, [])

  const call = useCallback<Actions['call']>((method, params = {}) => link.call(method, params), [])
  const pair = useCallback((target: PairingTarget) => link.pair(target), [])
  const forget = useCallback(() => link.forget(), [])
  const addEndpoint = useCallback((host: string, port: number) => link.addEndpoint(host, port), [])
  const removeEndpoint = useCallback((host: string, port: number) => link.removeEndpoint(host, port), [])
  const reconnect = useCallback(() => link.reconnectNow(), [])
  const dismissServerError = useCallback(() => link.dismissServerError(), [])
  const wake = useCallback(() => link.wake(), [])
  const refreshAgents = useCallback(() => link.refreshAgents(), [])
  const refreshAgentJobs = useCallback(() => link.refreshAgentJobs(), [])
  const watchStats = useCallback(() => link.watchStats(), [])
  const offerMic = useCallback(() => link.offerMic(), [])

  const actions = useMemo<Actions>(
    () => ({
      refreshAgents,
      refreshAgentJobs,
      call,
      pair,
      reconnect,
      dismissServerError,
      wake,
      forget,
      addEndpoint,
      removeEndpoint,
      watchStats,
      offerMic,
    }),
    [
      refreshAgents,
      refreshAgentJobs,
      call,
      pair,
      reconnect,
      dismissServerError,
      wake,
      forget,
      addEndpoint,
      removeEndpoint,
      watchStats,
      offerMic,
    ],
  )

  const status = useSlice(statusSlice, state)
  const agents = useSlice(agentsSlice, state)

  const can = useCallback(
    (plugin: string, feature: string) => Boolean((status.hello?.capabilities?.[plugin] as any)?.[feature]),
    [status.hello],
  )

  const fingerprint = useMemo(
    () => (status.desktop?.publicKey ? keyFingerprint(status.desktop.publicKey) : null),
    [status.desktop?.publicKey],
  )

  const statusValue = useMemo<StatusValue>(() => ({ ...status, fingerprint, can }), [status, fingerprint, can])

  // `children` is the same element through all of this, so a state change that
  // moves none of these values re-renders nothing below.
  return (
    <ActionsContext.Provider value={actions}>
      <PaletteContext.Provider value={state.palette}>
        <StatusContext.Provider value={statusValue}>
          <StatsContext.Provider value={state.stats}>
            <AgentsContext.Provider value={agents}>{children}</AgentsContext.Provider>
          </StatsContext.Provider>
        </StatusContext.Provider>
      </PaletteContext.Provider>
    </ActionsContext.Provider>
  )
}

/**
 * The slice, kept by identity for as long as its fields hold still.
 *
 * The selector builds a fresh object every render because that is the only way
 * to compare; what is handed on is the one from last time whenever the new one
 * says the same thing. A ref rather than `useMemo` because the dependency is
 * the answer itself and not a list of inputs — and because a cache that React
 * is allowed to throw away would hand out a new object for no reason.
 */
function useSlice<T extends Record<string, unknown>>(select: (state: LinkState) => T, state: LinkState): T {
  const held = useRef<T | null>(null)
  const next = select(state)
  if (!held.current || !shallowEqual(held.current, next)) held.current = next
  return held.current
}

/**
 * The link and what can be asked of it — everything except the two feeds.
 *
 * Stats and agents are deliberately not here: they move on their own clock,
 * and a screen that wanted them would have dragged every other reader of this
 * hook along with it. Ask for those with `useStats` and `useAgents`.
 */
export function useConnection(): ConnectionValue {
  const status = useContext(StatusContext)
  const actions = useContext(ActionsContext)
  const palette = useContext(PaletteContext)
  if (!status || !actions) throw new Error('useConnection must be used inside ConnectionProvider')
  return { ...status, ...actions, palette }
}

export function usePalette() {
  return useContext(PaletteContext)
}

/** The desktop's last snapshot, or null while nothing is subscribed to it. */
export function useStats() {
  return useContext(StatsContext)
}

export function useAgents(): AgentsSlice {
  const agents = useContext(AgentsContext)
  if (!agents) throw new Error('useAgents must be used inside ConnectionProvider')
  return agents
}
