import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { AppState, Platform } from 'react-native'

import { ConnectClient, type ConnectionStatus, type Hello, type NotificationItem, type Stats } from '../api/client'
import { deviceId, forgetDesktop, loadDesktop, saveDesktop, type SavedDesktop } from '../api/storage'
import { findDesktopByKey, probeHost, type PairingTarget } from '../api/discovery'
import { fingerprint as keyFingerprint } from '../api/crypto'
import { startReporting } from '../api/telemetry'
import { startPhoneMirror } from '../api/phone'
import { FALLBACK_PALETTE, type Palette } from '../theme'

export type ClipboardEvent = { text: string; at: number; source: string }
export type FileEvent = { direction: 'in' | 'out'; name: string; size: number; token?: string; at?: number }

type ConnectionValue = {
  status: ConnectionStatus
  ready: boolean
  error: string | null
  desktop: SavedDesktop | null
  hello: Hello | null
  palette: Palette
  stats: Stats | null
  notifications: NotificationItem[]
  clipboard: ClipboardEvent | null
  files: FileEvent[]
  latencyMs: number | null
  fingerprint: string | null
  relocating: boolean
  client: ConnectClient | null
  call: <T = any>(method: string, params?: Record<string, unknown>) => Promise<T>
  pair: (target: PairingTarget) => Promise<void>
  reconnect: () => void
  forget: () => Promise<void>
  can: (plugin: string, feature: string) => boolean
  markNotificationsRead: () => void
  unreadCount: number
}

const ConnectionContext = createContext<ConnectionValue | null>(null)

const MAX_NOTIFICATIONS = 100
const MAX_FILE_EVENTS = 30
/** After this many failed retries we stop trusting the stored address. */
const RELOCATE_AFTER = 3

export function ConnectionProvider({ children }: { children: React.ReactNode }) {
  const clientRef = useRef<ConnectClient | null>(null)
  const relocatingRef = useRef(false)
  const [status, setStatus] = useState<ConnectionStatus>('idle')
  const [error, setError] = useState<string | null>(null)
  const [desktop, setDesktop] = useState<SavedDesktop | null>(null)
  const [ready, setReady] = useState(false)
  const [hello, setHello] = useState<Hello | null>(null)
  const [palette, setPalette] = useState<Palette>(FALLBACK_PALETTE)
  const [stats, setStats] = useState<Stats | null>(null)
  const [notifications, setNotifications] = useState<NotificationItem[]>([])
  const [clipboard, setClipboard] = useState<ClipboardEvent | null>(null)
  const [files, setFiles] = useState<FileEvent[]>([])
  const [readAt, setReadAt] = useState(Date.now())
  const [latencyMs, setLatencyMs] = useState<number | null>(null)
  const [relocating, setRelocating] = useState(false)

  /**
   * The stored address goes stale whenever the router hands the desktop a new
   * lease. Rather than making the user re-pair, sweep the subnet for the
   * identity key we already pinned and follow it there.
   */
  const relocate = useCallback(async () => {
    const client = clientRef.current
    if (!client || relocatingRef.current || !client.publicKey) return
    relocatingRef.current = true
    setRelocating(true)
    try {
      const found = await findDesktopByKey(client.publicKey, client.port)
      // The identity key already proves this is the right machine, but if it
      // has TLS on it must also still be the certificate we pinned — a desktop
      // that answers with a different one is not one we follow silently.
      if (found && client.certPin && found.certPin && found.certPin !== client.certPin) return
      if (found && (found.host !== client.host || found.port !== client.port)) {
        client.moveTo(found.host, found.port)
        setDesktop((prev) => {
          if (!prev) return prev
          const next = { ...prev, host: found.host, port: found.port }
          saveDesktop(next)
          return next
        })
      }
    } finally {
      relocatingRef.current = false
      setRelocating(false)
    }
  }, [])

  const wire = useCallback(
    (client: ConnectClient) => {
      let stopReporting: (() => void) | undefined
      // Started once for the life of the socket rather than per-hello: it
      // listens for `hello` itself, which is when it drains whatever the
      // native receiver wrote down while the app was closed.
      const stopMirror = startPhoneMirror(client)
      const offs = [
        client.on('status', ({ status: s, error: e }: { status: ConnectionStatus; error: string | null }) => {
          setStatus(s)
          setError(e)
          if (s === 'reconnecting' && client.failedAttempts >= RELOCATE_AFTER) relocate()
        }),
        client.on('hello', (msg: Hello) => {
          setHello(msg)
          if (msg.theme) setPalette({ ...FALLBACK_PALETTE, ...msg.theme })
          // The desktop client puts this phone's battery in the Omarchy bar.
          // Only a desktop that says it wants the report gets one.
          stopReporting?.()
          stopReporting = (msg.capabilities?.device as any)?.report ? startReporting(client) : undefined
        }),
        client.on('ev:stats', (data: Stats) => setStats(data)),
        client.on('ev:theme', (data: Palette) => setPalette({ ...FALLBACK_PALETTE, ...data })),
        client.on('ev:notification', (data: NotificationItem) =>
          setNotifications((prev) => [data, ...prev].slice(0, MAX_NOTIFICATIONS)),
        ),
        client.on('ev:clipboard', (data: ClipboardEvent) => setClipboard(data)),
        client.on('ev:file', (data: FileEvent) => setFiles((prev) => [data, ...prev].slice(0, MAX_FILE_EVENTS))),
        client.on('latency', (value: number) => setLatencyMs(value)),
      ]
      return () => {
        stopReporting?.()
        stopMirror()
        offs.forEach((off) => off())
      }
    },
    [relocate],
  )

  /* Restore the paired desktop on launch and reconnect to it. */
  useEffect(() => {
    let disposed = false
    let unwire: (() => void) | undefined

    ;(async () => {
      const saved = await loadDesktop()
      const id = await deviceId()
      if (disposed) return
      setDesktop(saved)
      setReady(true)
      if (!saved) return

      const client = new ConnectClient({
        host: saved.host,
        port: saved.port,
        token: saved.token,
        publicKey: saved.publicKey,
        tls: saved.tls ?? false,
        certPin: saved.certPin ?? null,
        device: { id, name: deviceName(), platform: Platform.OS, model: String(Platform.Version) },
      })
      clientRef.current = client
      unwire = wire(client)
      client.connect()
    })()

    return () => {
      disposed = true
      unwire?.()
      clientRef.current?.close()
      clientRef.current = null
    }
  }, [wire])

  /**
   * Phones suspend sockets the moment they go to the background, and the
   * backoff would otherwise leave the app looking dead for up to fifteen
   * seconds after the user opens it again.
   */
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') clientRef.current?.reconnectNow()
    })
    return () => sub.remove()
  }, [])

  const pair = useCallback<ConnectionValue['pair']>(
    async (target) => {
      clientRef.current?.close()

      // The QR carries the desktop's identity key. When the user typed the
      // address by hand there is none, so we read it from the desktop itself
      // and show the fingerprint — that is theirs to verify, not ours.
      let publicKey = target.publicKey
      let { tls, certPin } = target
      if (!publicKey) {
        const info = await probeHost(target.host, target.port)
        if (!info) throw new Error('no Omarchy Connect daemon answered at that address')
        if (!info.publicKey) throw new Error('that desktop is running an older daemon — please update it')
        publicKey = info.publicKey
        // A hand-typed address means nothing was pinned in advance: take the
        // transport the desktop actually answered on, and show the fingerprint
        // so the user can be the one who verifies it.
        tls = info.tls
        certPin = info.certPin
      }

      const id = await deviceId()
      const client = new ConnectClient({
        host: target.host,
        port: target.port,
        pairCode: target.code,
        publicKey,
        tls,
        certPin,
        device: { id, name: deviceName(), platform: Platform.OS, model: String(Platform.Version) },
      })
      clientRef.current = client
      wire(client)

      const outcome = new Promise<void>((resolve, reject) => {
        const done = client.on('hello', async () => {
          done()
          failed()
          const saved: SavedDesktop = {
            host: target.host,
            port: target.port,
            token: client.token ?? '',
            name: target.name,
            pairedAt: Date.now(),
            publicKey: publicKey!,
            tls,
            certPin,
          }
          await saveDesktop(saved)
          setDesktop(saved)
          resolve()
        })
        const failed = client.on('unauthorized', (message: string) => {
          done()
          failed()
          reject(new Error(message || 'pairing failed'))
        })
        setTimeout(() => reject(new Error('the desktop did not answer')), 15_000)
      })

      client.connect()
      await outcome
    },
    [wire],
  )

  const call = useCallback<ConnectionValue['call']>(async (method, params = {}) => {
    const client = clientRef.current
    if (!client) throw new Error('not paired with a desktop yet')
    return client.call(method, params)
  }, [])

  const reconnect = useCallback(() => {
    clientRef.current?.reconnectNow()
  }, [])

  const forget = useCallback(async () => {
    clientRef.current?.close()
    clientRef.current = null
    await forgetDesktop()
    setDesktop(null)
    setHello(null)
    setStats(null)
    setNotifications([])
    setFiles([])
    setClipboard(null)
    setLatencyMs(null)
    setPalette(FALLBACK_PALETTE)
    setStatus('idle')
  }, [])

  const can = useCallback(
    (plugin: string, feature: string) => Boolean((hello?.capabilities?.[plugin] as any)?.[feature]),
    [hello],
  )

  const unreadCount = useMemo(
    () => notifications.filter((n) => n.timestamp > readAt).length,
    [notifications, readAt],
  )

  const fingerprint = useMemo(
    () => (desktop?.publicKey ? keyFingerprint(desktop.publicKey) : null),
    [desktop?.publicKey],
  )

  const value = useMemo<ConnectionValue>(
    () => ({
      status,
      ready,
      error,
      desktop,
      hello,
      palette,
      stats,
      notifications,
      clipboard,
      files,
      latencyMs,
      fingerprint,
      relocating,
      client: clientRef.current,
      call,
      pair,
      reconnect,
      forget,
      can,
      markNotificationsRead: () => setReadAt(Date.now()),
      unreadCount,
    }),
    [
      status,
      ready,
      error,
      desktop,
      hello,
      palette,
      stats,
      notifications,
      clipboard,
      files,
      latencyMs,
      fingerprint,
      relocating,
      call,
      pair,
      reconnect,
      forget,
      can,
      unreadCount,
    ],
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

function deviceName() {
  return Platform.OS === 'ios' ? 'iPhone' : 'Android phone'
}
