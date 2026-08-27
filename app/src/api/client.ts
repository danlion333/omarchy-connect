import type { Palette } from '../theme'
import { SecureChannel, fingerprint, startHandshake } from './crypto.ts'

export type ConnectionStatus = 'idle' | 'connecting' | 'pairing' | 'connected' | 'reconnecting' | 'error'

export type DeviceIdentity = {
  id: string
  name: string
  platform: string
  model?: string
}

export type Capabilities = Record<string, Record<string, unknown>>

export type HostInfo = {
  hostname: string
  os: string
  kernel: string
  uptime: number
  arch: string
  cpuModel: string
  cores: number
  loadavg: number[]
}

export type Hello = {
  protocol: number
  secure: boolean
  fingerprint: string
  server: { name: string; version: string }
  device: { id: string; name: string; platform: string; pairedAt: number }
  host: HostInfo
  capabilities: Capabilities
  theme: Palette
  events: string[]
}

export type Stats = {
  at: number
  cpu: { usage: number | null; tempC: number | null; loadavg: number[] }
  memory: { total: number; used: number; available: number; swapTotal: number; swapUsed: number }
  disk: { total: number; used: number; free: number; mount: string } | null
  battery: {
    percent: number
    status: string
    charging: boolean
    secondsLeft: number | null
    watts: number | null
  } | null
  network: {
    interface: string | null
    type: 'ethernet' | 'wifi' | 'virtual' | 'loopback' | 'offline'
    up: boolean
    ip: string | null
    ipv6: string | null
    mac: string | null
    gateway: string | null
    dns: string[]
    dnsProvider: string
    linkSpeedMbit: number | null
    rxRate: number
    txRate: number
    rxTotal: number
    txTotal: number
    ssid?: string | null
    signalDbm?: number | null
    signalQuality?: number | null
    pingMs: number | null
    packetLoss: number | null
    target: string | null
  }
  uptime: number
}

/* ── coding agents ─────────────────────────────────────────────────────── */

export type AgentState = 'idle' | 'working' | 'waiting' | 'gone'

export type AgentSession = {
  id: string
  agent: string
  title: string
  cwd: string | null
  state: AgentState
  /**
   * How a message could be typed into this session. `tmux` is exact; `wtype`
   * borrows the compositor's keyboard and steals focus for a moment; `null`
   * means nothing on that desktop can reach the terminal it is running in.
   */
  writable: 'tmux' | 'wtype' | null
  pane: string | null
  pid: number | null
  startedAt: number
  lastActivity: number
  preview: string
  /** What the agent is blocked on, when it is blocked. */
  prompt: string | null
  /** `hook` is the agent reporting in; `scan` is us guessing from /proc. */
  via: 'hook' | 'scan'
}

/** The best road a desktop has into a terminal, whatever a session is on. */
export type AgentWrite = 'tmux' | 'wtype' | null

export type AgentCapabilities = {
  enabled?: boolean
  adapters?: string[]
  read?: boolean
  write?: AgentWrite
  /** The named keys this desktop will accept from a phone. */
  keys?: string[]
  spawn?: boolean
}

export type AgentBlock = {
  seq: number
  role: 'user' | 'assistant' | 'system'
  kind: 'text' | 'thinking' | 'tool' | 'result' | 'state'
  at: number
  text?: string
  tool?: string
  summary?: string
  status?: 'ok' | 'error' | 'interrupted'
  lines?: number
  ref?: string | null
  /** Whether a fuller body is one `agents.detail` away. */
  expandable?: boolean
}

export type AgentEvent =
  | { kind: 'session'; id: string; removed: boolean; session: AgentSession | null }
  | { kind: 'state'; id: string; state: AgentState; prompt: string | null; preview: string; lastActivity: number }
  | { kind: 'blocks'; id: string; blocks: AgentBlock[]; cursor: number; reset?: boolean }
  // The desktop turning reading on or off under a live link — the switch on
  // its panel, or the CLI. `hello` answered this question once at connect
  // time; this is how the answer changes without reconnecting.
  | { kind: 'control'; enabled: boolean; adapters: string[]; write?: AgentWrite }

type Listener = (data: any) => void

const REQUEST_TIMEOUT = 12_000
const PING_EVERY = 15_000
const PING_TIMEOUT = 10_000
const BACKOFF = [1000, 2000, 4000, 8000, 15_000]

/**
 * One WebSocket to one desktop, with request/response correlation, an event
 * bus, and reconnection. The socket is the only thing that talks to the
 * daemon; screens go through `call()` and `on()`.
 */
export class ConnectClient {
  host: string
  port: number
  token: string | null
  pairCode: string | null
  device: DeviceIdentity
  status: ConnectionStatus = 'idle'
  hello: Hello | null = null
  lastError: string | null = null
  latencyMs: number | null = null
  /** The desktop identity key this client pins, as hex. */
  publicKey: string | null
  /** Whether this desktop is spoken to over TLS. */
  tls: boolean
  /** The certificate pin recorded at pairing time, for display and diagnosis. */
  certPin: string | null

  private secure: SecureChannel | null = null
  private handshake: ReturnType<typeof startHandshake> | null = null

  private ws: WebSocket | null = null
  private seq = 0
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: any }>()
  private listeners = new Map<string, Set<Listener>>()
  private pingTimer: any = null
  private pingSentAt: number | null = null
  private retryTimer: any = null
  private attempt = 0
  private closedByUser = false
  /**
   * `phone` is not optional decoration: it is the channel the desktop uses to
   * ask this handset to answer a call or send a message. Leaving it out makes
   * every such request time out on the desktop with no sign anything is wrong.
   */
  private subscriptions: string[] = ['stats', 'clipboard', 'theme', 'file', 'agent', 'phone']

  constructor(opts: {
    host: string
    port: number
    token?: string | null
    pairCode?: string | null
    publicKey?: string | null
    tls?: boolean
    certPin?: string | null
    device: DeviceIdentity
  }) {
    this.host = opts.host
    this.port = opts.port
    this.token = opts.token ?? null
    this.pairCode = opts.pairCode ?? null
    this.publicKey = opts.publicKey ?? null
    this.tls = opts.tls ?? false
    this.certPin = opts.certPin ?? null
    this.device = opts.device
  }

  /**
   * The transport the file endpoints use. With TLS on this is https, which is
   * what puts the file bodies — the one part of the protocol the WebSocket's
   * own encryption never covered — inside a tunnel as well.
   */
  get baseUrl() {
    return `${this.tls ? 'https' : 'http'}://${this.host}:${this.port}`
  }

  /** The human-comparable digest of the pinned desktop key, or null. */
  get fingerprint() {
    return this.publicKey ? fingerprint(this.publicKey) : null
  }

  /* ── events ──────────────────────────────────────────────────────── */

  on(event: string, listener: Listener) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set())
    this.listeners.get(event)!.add(listener)
    return () => this.off(event, listener)
  }

  off(event: string, listener: Listener) {
    this.listeners.get(event)?.delete(listener)
  }

  private emit(event: string, data?: any) {
    this.listeners.get(event)?.forEach((l) => {
      try {
        l(data)
      } catch {
        /* a broken listener must not take down the socket */
      }
    })
  }

  private setStatus(status: ConnectionStatus, error?: string | null) {
    this.status = status
    if (error !== undefined) this.lastError = error
    this.emit('status', { status, error: this.lastError })
  }

  /* ── lifecycle ───────────────────────────────────────────────────── */

  connect() {
    this.closedByUser = false
    clearTimeout(this.retryTimer)
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return

    this.setStatus(this.pairCode ? 'pairing' : this.attempt > 0 ? 'reconnecting' : 'connecting', null)

    const ws = new WebSocket(`${this.tls ? 'wss' : 'ws'}://${this.host}:${this.port}/ws`)
    ws.binaryType = 'arraybuffer'
    this.ws = ws
    this.secure = null
    this.handshake = null

    ws.onopen = () => {
      if (!this.publicKey) {
        // Without a pinned key we cannot tell the desktop apart from anything
        // else answering on that address, so we refuse rather than fall back.
        this.lastError = 'this desktop has no pinned key — pair again'
        ws.close(4003, 'no pinned key')
        return
      }
      try {
        this.handshake = startHandshake(this.publicKey)
        ws.send(this.handshake.frame.buffer as ArrayBuffer)
      } catch (err) {
        this.lastError = (err as Error).message
        ws.close(4003, 'handshake failed')
      }
    }

    ws.onmessage = (event) => {
      const data = event.data
      if (typeof data === 'string') return this.handleMessage(data)
      this.handleBinary(new Uint8Array(data as ArrayBuffer))
    }

    ws.onerror = () => {
      // React Native gives no useful detail here; onclose carries the outcome.
      this.lastError = this.lastError || 'connection failed'
    }

    ws.onclose = (event) => {
      this.stopPing()
      this.failAllPending(new Error('disconnected'))
      if (this.closedByUser) {
        this.setStatus('idle', null)
        return
      }
      // 4003/4005 mean the desktop rejected our credentials or our key —
      // retrying cannot help, only pairing again can.
      if (event.code === 4003 || event.code === 4005) {
        this.setStatus('error', this.lastError || 'pairing rejected')
        this.emit('unauthorized', this.lastError)
        return
      }
      this.scheduleReconnect()
    }
  }

  /**
   * Retries immediately instead of waiting out the backoff. Used when
   * something told us the world changed — the app came back to the foreground,
   * or the phone joined a different network.
   */
  reconnectNow() {
    this.attempt = 0
    clearTimeout(this.retryTimer)
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return
    this.connect()
  }

  /** Follows the desktop to a new address, keeping the pinned key. */
  moveTo(host: string, port: number) {
    if (host === this.host && port === this.port) return
    this.host = host
    this.port = port
    this.attempt = 0
    try {
      this.ws?.close(4009, 'address changed')
    } catch {
      /* already gone */
    }
    this.ws = null
    this.connect()
  }

  /** How many reconnect attempts have failed back-to-back. */
  get failedAttempts() {
    return this.attempt
  }

  private scheduleReconnect() {
    const delay = BACKOFF[Math.min(this.attempt, BACKOFF.length - 1)]
    this.attempt += 1
    this.setStatus('reconnecting')
    clearTimeout(this.retryTimer)
    this.retryTimer = setTimeout(() => this.connect(), delay)
  }

  close() {
    this.closedByUser = true
    clearTimeout(this.retryTimer)
    this.stopPing()
    this.failAllPending(new Error('closed'))
    this.ws?.close()
    this.ws = null
    this.setStatus('idle', null)
  }

  private startPing() {
    this.stopPing()
    this.pingTimer = setInterval(() => {
      // An unanswered ping means the socket is a zombie: phones move between
      // networks and sleep, and the TCP connection often dies without a close.
      if (this.pingSentAt && Date.now() - this.pingSentAt > PING_TIMEOUT) {
        this.pingSentAt = null
        this.ws?.close(4008, 'ping timeout')
        return
      }
      try {
        this.pingSentAt = Date.now()
        this.send({ t: 'ping' })
      } catch {
        /* onclose will drive the reconnect */
      }
    }, PING_EVERY)
  }

  private stopPing() {
    clearInterval(this.pingTimer)
    this.pingTimer = null
    this.pingSentAt = null
  }

  /* ── messaging ───────────────────────────────────────────────────── */

  private handleBinary(frame: Uint8Array) {
    if (this.handshake) {
      const pending = this.handshake
      this.handshake = null
      try {
        this.secure = pending.finish(frame)
      } catch (err) {
        // Only the desktop holding the pinned private key can produce a reply
        // we can use, so a failure here is an impostor, not a glitch.
        this.lastError = 'this is not the desktop you paired with'
        this.ws?.close(4003, 'key mismatch')
        return
      }
      this.sendHello()
      return
    }
    if (!this.secure) return
    try {
      this.handleMessage(new TextDecoder().decode(this.secure.decrypt(frame)))
    } catch {
      this.lastError = 'the connection failed authentication'
      this.ws?.close(4005, 'decryption failed')
    }
  }

  private sendHello() {
    this.send(
      this.pairCode
        ? { t: 'hello', pairCode: this.pairCode, device: this.device }
        : { t: 'hello', token: this.token, device: this.device },
    )
  }

  private handleMessage(raw: string) {
    let msg: any
    try {
      msg = JSON.parse(raw)
    } catch {
      return
    }

    switch (msg.t) {
      case 'paired':
        this.token = msg.token
        this.pairCode = null
        this.emit('paired', msg)
        return
      case 'hello.ok':
        this.attempt = 0
        this.hello = msg as Hello
        this.setStatus('connected', null)
        this.emit('hello', msg)
        this.subscribe(this.subscriptions)
        this.startPing()
        return
      case 'hello.err':
        this.lastError = msg.error
        this.setStatus('error', msg.error)
        this.emit('unauthorized', msg.error)
        return
      case 'ev':
        this.emit(`ev:${msg.event}`, msg.data)
        this.emit('ev', msg)
        return
      case 'res': {
        const entry = this.pending.get(msg.id)
        if (!entry) return
        clearTimeout(entry.timer)
        this.pending.delete(msg.id)
        if (msg.ok) entry.resolve(msg.data)
        else entry.reject(new Error(msg.error || 'request failed'))
        return
      }
      case 'pong':
        if (this.pingSentAt) {
          this.latencyMs = Date.now() - this.pingSentAt
          this.pingSentAt = null
          this.emit('latency', this.latencyMs)
        }
        return
      case 'error':
        this.emit('server-error', msg.error)
        return
      default:
        return
    }
  }

  private send(payload: object) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) throw new Error('not connected')
    if (!this.secure) throw new Error('the secure channel is not up yet')
    const frame = this.secure.encrypt(new TextEncoder().encode(JSON.stringify(payload)))
    this.ws.send(frame.buffer as ArrayBuffer)
  }

  subscribe(events: string[]) {
    this.subscriptions = events
    try {
      this.send({ t: 'sub', events })
    } catch {
      /* re-subscribed on the next successful handshake */
    }
  }

  call<T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    return new Promise((resolve, reject) => {
      let id: number
      try {
        id = ++this.seq
        this.send({ t: 'req', id, method, params })
      } catch (err) {
        reject(err as Error)
        return
      }
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${method} timed out`))
      }, REQUEST_TIMEOUT)
      this.pending.set(id, { resolve, reject, timer })
    })
  }

  private failAllPending(error: Error) {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer)
      entry.reject(error)
    }
    this.pending.clear()
  }

  /* ── HTTP side ───────────────────────────────────────────────────── */

  uploadHeaders(filename: string) {
    return {
      'x-oc-token': this.token ?? '',
      'x-oc-filename': encodeURIComponent(filename),
      'content-type': 'application/octet-stream',
    }
  }

  downloadUrl(offerToken: string) {
    return `${this.baseUrl}/api/download/${offerToken}?token=${this.token ?? ''}`
  }
}
