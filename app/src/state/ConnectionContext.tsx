import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'

import type { AgentSession, ConnectClient, ConnectionStatus, Hello, Stats } from '../api/client'
import { link, type ClipboardEvent, type FileEvent, type LinkState } from '../api/link'
import type { SavedDesktop } from '../api/storage'
import type { PairingTarget } from '../api/discovery'
import { fingerprint as keyFingerprint } from '../api/crypto'
import { type Palette } from '../theme'

export type { ClipboardEvent, FileEvent }

type ConnectionValue = {
  status: ConnectionStatus
  ready: boolean
  error: string | null
  desktop: SavedDesktop | null
  hello: Hello | null
  palette: Palette
  stats: Stats | null
  agents: AgentSession[]
  agentsWaiting: number
  refreshAgents: () => Promise<void>
  clipboard: ClipboardEvent | null
  files: FileEvent[]
  latencyMs: number | null
  fingerprint: string | null
  relocating: boolean
  /** A magic packet is out and the desktop has not answered yet. */
  waking: boolean
  client: ConnectClient | null
  call: <T = any>(method: string, params?: Record<string, unknown>) => Promise<T>
  pair: (target: PairingTarget) => Promise<void>
  reconnect: () => void
  /** Sends the magic packet, then waits for the desktop to answer again. */
  wake: () => Promise<boolean>
  forget: () => Promise<void>
  can: (plugin: string, feature: string) => boolean
}

const ConnectionContext = createContext<ConnectionValue | null>(null)

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

  const call = useCallback<ConnectionValue['call']>((method, params = {}) => link.call(method, params), [])
  const pair = useCallback((target: PairingTarget) => link.pair(target), [])
  const forget = useCallback(() => link.forget(), [])
  const reconnect = useCallback(() => link.reconnectNow(), [])
  const wake = useCallback(() => link.wake(), [])
  const refreshAgents = useCallback(() => link.refreshAgents(), [])

  const can = useCallback(
    (plugin: string, feature: string) => Boolean((state.hello?.capabilities?.[plugin] as any)?.[feature]),
    [state.hello],
  )

  /** Agents blocked on a question — the one thing a phone can actually fix. */
  const agentsWaiting = useMemo(() => state.agents.filter((a) => a.state === 'waiting').length, [state.agents])

  const fingerprint = useMemo(
    () => (state.desktop?.publicKey ? keyFingerprint(state.desktop.publicKey) : null),
    [state.desktop?.publicKey],
  )

  const value = useMemo<ConnectionValue>(
    () => ({
      ...state,
      agentsWaiting,
      refreshAgents,
      fingerprint,
      call,
      pair,
      reconnect,
      wake,
      forget,
      can,
    }),
    [state, agentsWaiting, refreshAgents, fingerprint, call, pair, reconnect, wake, forget, can],
  )

  return <ConnectionContext.Provider value={value}>{children}</ConnectionContext.Provider>
}

export function useConnection() {
  const ctx = useContext(ConnectionContext)
  if (!ctx) throw new Error('useConnection must be used inside ConnectionProvider')
  return ctx
}

export function usePalette() {
  return useConnection().palette
}
