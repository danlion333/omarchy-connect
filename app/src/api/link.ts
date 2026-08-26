import { AppState, Platform } from 'react-native'

import {
  ConnectClient,
  type AgentEvent,
  type AgentSession,
  type ConnectionStatus,
  type Hello,
  type NotificationItem,
  type Stats,
} from './client'
import { deviceId, forgetDesktop, loadDesktop, saveDesktop, type SavedDesktop } from './storage'
import { findDesktopByKey, probeHost, type PairingTarget } from './discovery'
import { startReporting } from './telemetry'
import { startPhoneMirror } from './phone'
import {
  backgroundLinkChosen,
  backgroundLinkEnabled,
  linkService,
  setBackgroundLinkStatus,
  startBackgroundLink,
  stopBackgroundLink,
} from '../../modules/omarchy-link'
import { FALLBACK_PALETTE, type Palette } from '../theme'

/**
 * The connection to the desktop, owned outside React.
 *
 * It used to live in `ConnectionProvider`, which meant it lived exactly as
 * long as a mounted component tree — so the moment the phone left the app the
 * socket went with it, and with it the call mirroring, the battery report, the
 * clipboard and everything else. Nothing about a link to your desktop belongs
 * to a screen, so none of it is kept there any more: this module owns the
 * socket, the reconnection and the event history, the foreground service keeps
 * the process and its timers running (see `modules/omarchy-link`), and the
 * provider is reduced to a subscriber that renders whatever it finds here.
 *
 * That also fixes a smaller bug worth naming: reopening the app after Android
 * tore the activity down used to show an empty notification list and no stats
 * until the next event arrived. The state outlived nothing; now it outlives
 * the screen.
 */

export type ClipboardEvent = { text: string; at: number; source: string }
export type FileEvent = { direction: 'in' | 'out'; name: string; size: number; token?: string; at?: number }

export type LinkState = {
  /** False until the stored pairing has been read off disk. */
  ready: boolean
  status: ConnectionStatus
  error: string | null
  desktop: SavedDesktop | null
  hello: Hello | null
  palette: Palette
  stats: Stats | null
  notifications: NotificationItem[]
  agents: AgentSession[]
  clipboard: ClipboardEvent | null
  files: FileEvent[]
  latencyMs: number | null
  relocating: boolean
  client: ConnectClient | null
}

const MAX_NOTIFICATIONS = 100
const MAX_FILE_EVENTS = 30
/** After this many failed retries we stop trusting the stored address. */
const RELOCATE_AFTER = 3

const INITIAL: LinkState = {
  ready: false,
  status: 'idle',
  error: null,
  desktop: null,
  hello: null,
  palette: FALLBACK_PALETTE,
  stats: null,
  notifications: [],
  agents: [],
  clipboard: null,
  files: [],
  latencyMs: null,
  relocating: false,
  client: null,
}

type Subscriber = (state: LinkState) => void

class Link {
  state: LinkState = INITIAL

  private subscribers = new Set<Subscriber>()
  private client: ConnectClient | null = null
  private unwire: (() => void) | null = null
  private starting: Promise<void> | null = null
  private started = false
  private relocatingNow = false
  private listening = false

  /* ── subscription ────────────────────────────────────────────────── */

  subscribe(subscriber: Subscriber) {
    this.subscribers.add(subscriber)
    return () => {
      this.subscribers.delete(subscriber)
    }
  }

  private patch(changes: Partial<LinkState>) {
    this.state = { ...this.state, ...changes }
    for (const subscriber of this.subscribers) {
      try {
        subscriber(this.state)
      } catch {
        /* a broken subscriber must not take down the socket */
      }
    }
  }

  /* ── lifecycle ───────────────────────────────────────────────────── */

  /**
   * Brings the link up, once. Called from the app when it launches and from
   * the headless task when the service starts it without one, so it has to be
   * safe to call twice from two directions at the same time.
   */
  start(): Promise<void> {
    if (this.starting) return this.starting
    // Cached so two callers get one connection, but not cached through a
    // failure: the secure store can refuse to open on a phone that has not
    // been unlocked since boot, and the service will call again.
    this.starting = this.open().catch((error) => {
      this.starting = null
      throw error
    })
    return this.starting
  }

  private async open() {
    this.attachGlobalListeners()
    const saved = await loadDesktop()
    if (this.started) return
    this.started = true
    this.patch({ desktop: saved, ready: true })
    if (!saved) return

    const id = await deviceId()
    const client = new ConnectClient({
      host: saved.host,
      port: saved.port,
      token: saved.token,
      publicKey: saved.publicKey,
      tls: saved.tls ?? false,
      certPin: saved.certPin ?? null,
      device: { id, name: deviceName(), platform: Platform.OS, model: String(Platform.Version) },
    })
    this.adopt(client)
    // A phone that was told to stay connected should already be running the
    // service — but it is also how the link survives this launch, so make
    // sure of it rather than assuming Android kept its side of the bargain.
    // A phone that has never been asked counts as yes: it was paired before
    // any of this existed, and it is paired precisely so the desktop can see
    // it. Saying no in Settings is remembered and respected from then on.
    if (backgroundLinkEnabled() || !backgroundLinkChosen()) startBackgroundLink()
    client.connect()
  }

  private adopt(client: ConnectClient) {
    this.unwire?.()
    this.client = client
    this.unwire = this.wire(client)
    this.patch({ client })
  }

  private wire(client: ConnectClient) {
    let stopReporting: (() => void) | undefined
    // Started once for the life of the socket rather than per-hello: it
    // listens for `hello` itself, which is when it drains whatever the
    // native receiver wrote down while the app was closed.
    const stopMirror = startPhoneMirror(client)
    const offs = [
      client.on('status', ({ status, error }: { status: ConnectionStatus; error: string | null }) => {
        this.patch({ status, error })
        this.announce(status)
        if (status === 'reconnecting' && client.failedAttempts >= RELOCATE_AFTER) void this.relocate()
      }),
      client.on('hello', (msg: Hello) => {
        this.patch({ hello: msg, ...(msg.theme ? { palette: { ...FALLBACK_PALETTE, ...msg.theme } } : {}) })
        // The desktop client puts this phone's battery in the Omarchy bar.
        // Only a desktop that says it wants the report gets one.
        stopReporting?.()
        stopReporting = (msg.capabilities?.device as any)?.report ? startReporting(client) : undefined
      }),
      client.on('ev:stats', (data: Stats) => this.patch({ stats: data })),
      client.on('ev:theme', (data: Palette) => this.patch({ palette: { ...FALLBACK_PALETTE, ...data } })),
      client.on('ev:notification', (data: NotificationItem) =>
        this.patch({ notifications: [data, ...this.state.notifications].slice(0, MAX_NOTIFICATIONS) }),
      ),
      /**
       * The session list is kept current by events, not by polling: a
       * `waiting` agent is the badge on the tab bar, and it has to appear
       * while the phone is on another screen entirely. Block traffic is not
       * handled here — only the chat that asked for it cares.
       */
      client.on('ev:agent', (data: AgentEvent) => this.patch({ agents: reduceAgents(this.state.agents, data) })),
      client.on('ev:clipboard', (data: ClipboardEvent) => this.patch({ clipboard: data })),
      client.on('ev:file', (data: FileEvent) =>
        this.patch({ files: [data, ...this.state.files].slice(0, MAX_FILE_EVENTS) }),
      ),
      client.on('latency', (value: number) => this.patch({ latencyMs: value })),
    ]
    return () => {
      stopReporting?.()
      stopMirror()
      offs.forEach((off) => off())
    }
  }

  /**
   * The two things that reliably invalidate a socket without closing it: the
   * app coming back to the foreground after Android suspended its timers, and
   * the phone changing networks. Both are worth a dial rather than a wait —
   * the backoff would otherwise leave the app looking dead for fifteen seconds
   * after the user opens it.
   */
  private attachGlobalListeners() {
    if (this.listening) return
    this.listening = true

    AppState.addEventListener('change', (state) => {
      if (state === 'active') this.client?.reconnectNow()
    })

    const native = linkService()
    if (native) {
      native.addListener('onNetworkChange', () => {
        // A phone that just joined a network cannot resolve the desktop the
        // same millisecond; the first attempt failing is normal and the
        // backoff takes it from there.
        this.client?.reconnectNow()
      })
    }
  }

  /**
   * The stored address goes stale whenever the router hands the desktop a new
   * lease. Rather than making the user re-pair, sweep the subnet for the
   * identity key we already pinned and follow it there.
   */
  private async relocate() {
    const client = this.client
    if (!client || this.relocatingNow || !client.publicKey) return
    this.relocatingNow = true
    this.patch({ relocating: true })
    try {
      const found = await findDesktopByKey(client.publicKey, client.port)
      // The identity key already proves this is the right machine, but if it
      // has TLS on it must also still be the certificate we pinned — a desktop
      // that answers with a different one is not one we follow silently.
      if (found && client.certPin && found.certPin && found.certPin !== client.certPin) return
      if (found && (found.host !== client.host || found.port !== client.port)) {
        client.moveTo(found.host, found.port)
        const previous = this.state.desktop
        if (previous) {
          const next = { ...previous, host: found.host, port: found.port }
          await saveDesktop(next)
          this.patch({ desktop: next })
        }
      }
    } finally {
      this.relocatingNow = false
      this.patch({ relocating: false })
    }
  }

  /** Keeps the foreground service's notification honest. */
  private announce(status: ConnectionStatus) {
    const text =
      status === 'connected'
        ? 'connected'
        : status === 'reconnecting'
          ? 'reconnecting'
          : status === 'connecting' || status === 'pairing'
            ? 'connecting'
            : status === 'error'
              ? this.state.error || 'not connected'
              : 'not connected'
    setBackgroundLinkStatus(text, this.state.desktop?.name ?? null)
  }

  /* ── what the app asks of it ─────────────────────────────────────── */

  async pair(target: PairingTarget) {
    this.client?.close()

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
    this.adopt(client)

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
        this.patch({ desktop: saved })
        // A freshly paired phone is the one case where nobody has been asked
        // about the background link yet; defaulting it on is what makes the
        // desktop see this phone tomorrow morning as well as right now.
        startBackgroundLink()
        this.announce('connected')
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
  }

  async forget() {
    // Nothing left to stay awake for: the service goes before the socket, so
    // the notification does not linger over a link that no longer exists.
    stopBackgroundLink()
    this.unwire?.()
    this.unwire = null
    this.client?.close()
    this.client = null
    await forgetDesktop()
    this.patch({ ...INITIAL, ready: true })
  }

  reconnectNow() {
    this.client?.reconnectNow()
  }

  call<T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const client = this.client
    if (!client) throw new Error('not paired with a desktop yet')
    return client.call<T>(method, params)
  }

  /** The authoritative agent list, asked for when a screen opens. */
  async refreshAgents() {
    const client = this.client
    if (!client || client.status !== 'connected') return
    try {
      const res = await client.call<{ sessions: AgentSession[] }>('agents.list', {})
      this.patch({ agents: res.sessions || [] })
    } catch {
      // Disabled on the desktop, or an older daemon: an empty list is the
      // honest answer, and the screen says why.
      this.patch({ agents: [] })
    }
  }
}

function reduceAgents(previous: AgentSession[], data: AgentEvent): AgentSession[] {
  if (data.kind === 'session') {
    const rest = previous.filter((s) => s.id !== data.id)
    // A finished session is announced by its state change; a session frame
    // carrying `gone` must not put it back in the list.
    if (data.removed || !data.session || data.session.state === 'gone') return rest
    return [...rest, data.session]
  }
  if (data.kind === 'state') {
    if (data.state === 'gone') return previous.filter((s) => s.id !== data.id)
    return previous.map((s) =>
      s.id === data.id
        ? { ...s, state: data.state, prompt: data.prompt, preview: data.preview, lastActivity: data.lastActivity }
        : s,
    )
  }
  return previous
}

function deviceName() {
  return Platform.OS === 'ios' ? 'iPhone' : 'Android phone'
}

export const link = new Link()
