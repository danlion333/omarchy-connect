import type { Palette } from '../theme'
import type { WakeInfo } from '../lib/wol'
import { parkedReason, reachable, retryDelay, type NetworkFacts } from '../lib/retry.ts'
import { SecureChannel, fingerprint, startHandshake } from './crypto.ts'

export type ConnectionStatus =
  | 'idle'
  | 'connecting'
  | 'pairing'
  | 'connected'
  | 'reconnecting'
  /** Not trying, because on this network trying could not work. See `lib/retry`. */
  | 'parked'
  | 'error'

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
  /** How this desktop could be woken once it is asleep. Absent on older daemons. */
  wake?: WakeInfo
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
    netmask?: string | null
    broadcast?: string | null
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

/** `starting` is a process with no transcript yet — stuck at a first-run prompt, usually. */
export type AgentState = 'idle' | 'working' | 'waiting' | 'starting' | 'gone'

/**
 * The desktop's own status line for a session, read off its transcript.
 *
 * None of it is asked of the agent: the model is on its last turn, the
 * permission mode on the last mode line, the branch on every entry, and the
 * title is the one the CLI generated for the conversation once it had read
 * enough of it to name. Every field is optional because a transcript that has
 * not got there yet is a meter that is not drawn, not a session that is
 * missing.
 */
export type AgentVitals = {
  model: string | null
  effort: string | null
  mode: string | null
  branch: string | null
  version: string | null
  title: string | null
  cwd: string | null
  turnAt: number | null
  /** What the conversation is holding, against what it can hold. */
  context: { tokens: number; window: number; percent: number } | null
}

/**
 * A background agent: a session with no terminal, and so nothing on the
 * desktop showing it. `detail` is the sentence it wrote about what it is
 * doing, which is the only running commentary such a session has.
 */
export type AgentJob = {
  id: string
  name: string
  detail: string
  state: string
  tokens: number
  updatedAt: number
  /**
   * Whether anything is actually running this job right now. The state file
   * outlives the process, so `state` alone says "working" about jobs that
   * died hours ago. Absent from a daemon too old to know — treat as live.
   */
  live?: boolean
}

/**
 * One item on the list an agent is working through.
 *
 * `activeForm` is the present-continuous the CLI shows in its own spinner, and
 * it is the field this is worth carrying for: "Pushing background-agent state
 * live" is what a phone wants where it would otherwise print the name of a
 * tool.
 */
export type AgentTask = {
  id: string
  subject: string
  description: string
  activeForm: string
  status: 'pending' | 'in_progress' | 'completed' | string
  blockedBy: string[]
}

export type AgentTasks = {
  tasks: AgentTask[]
  total: number
  done: number
  active: AgentTask | null
  /** What it will pick up next, for the moment between two tasks. */
  next: AgentTask | null
}

/** One usage window: how much of it is spent, and when it turns over. */
export type AgentLimit = {
  kind: string
  label: string
  percent: number
  resetsAt: number | null
  severity: string
  /** The window the desktop says it is actually spending against now. */
  active: boolean
}

export type AgentLimits = {
  fetchedAt: number
  /** Whether the CLI's cache is old enough that the numbers are history. */
  stale: boolean
  limits: AgentLimit[]
  spend: { used: number | null; limit: number | null; currency: string; percent: number | null } | null
}

/** A skill, a project command, or one of the CLI's own — one list on a phone. */
export type AgentSkill = {
  kind: 'skill' | 'command' | 'builtin'
  name: string
  description: string
  scope: 'user' | 'project' | 'plugin' | 'builtin'
  args?: string
}

/** A conversation on disk, running or not — what `--resume` picks from. */
export type AgentHistoryEntry = {
  id: string
  agent: string
  sessionId: string
  cwd: string | null
  title: string
  model: string | null
  branch: string | null
  context: { tokens: number; window: number; percent: number } | null
  at: number
  size: number
  live: boolean
  liveId: string | null
  background: boolean
}

export type AgentSession = {
  id: string
  agent: string
  title: string
  /** The project the conversation is in, once the title stops saying so. */
  project?: string
  cwd: string | null
  state: AgentState
  /**
   * How a message could be typed into this session. `tmux` and `herdr` are
   * both exact — the pane's pty belongs to the multiplexer, so the text
   * arrives as if it had been typed; `wtype` borrows the compositor's
   * keyboard and steals focus for a moment; `null` means nothing on that
   * desktop can reach the terminal it is running in.
   */
  writable: 'tmux' | 'herdr' | 'wtype' | null
  pane: string | null
  pid: number | null
  startedAt: number
  lastActivity: number
  preview: string
  /** What the agent is blocked on, when it is blocked. */
  prompt: string | null
  /** `hook` is the agent reporting in; `scan` is us guessing from /proc. */
  via: 'hook' | 'scan'
  /** Subagents it has out right now — the only visible sign of a fan-out. */
  subagents?: number
  /** Model, context, permission mode — absent from a daemon too old to send it. */
  vitals?: AgentVitals | null
  /** The background job behind this conversation, when it is one. */
  job?: AgentJob | null
  /** What it is working through, small enough to ride on every frame. */
  tasks?: { total: number; done: number; active: string | null; next?: string | null } | null
}

/** The best road a desktop has into a terminal, whatever a session is on. */
export type AgentWrite = 'tmux' | 'herdr' | 'wtype' | null

export type AgentCapabilities = {
  enabled?: boolean
  adapters?: string[]
  read?: boolean
  write?: AgentWrite
  /** The named keys this desktop will accept from a phone. */
  keys?: string[]
  /** Whether this desktop understands being handed a picture for an agent. */
  attach?: boolean
  /** …and picking an answer off a numbered list rather than typing a digit. */
  answer?: boolean
  spawn?: boolean
  /** Whether the desktop can list its skills and slash commands. */
  skills?: boolean
  /** …run one by name, with the name checked against that list. */
  commands?: boolean
  /** …list the conversations on disk, running or not. */
  history?: boolean
  /** …and the background agents it has going. */
  jobs?: boolean
  /** …and the task list a session is working through. */
  tasks?: boolean
  /** The plan's headroom as of `hello`; kept current by `ev:agent`. */
  limits?: AgentLimits | null
}

/**
 * A multiple-choice question the agent stopped on.
 *
 * The order matters twice over: it is the order the terminal draws the options
 * in, and the position of an option is the keystroke that picks it.
 */
export type AgentQuestion = {
  header?: string
  question: string
  multiSelect?: boolean
  options: { label: string; description?: string }[]
}

export type AgentBlock = {
  seq: number
  role: 'user' | 'assistant' | 'system'
  kind: 'text' | 'thinking' | 'tool' | 'question' | 'result' | 'state'
  at: number
  text?: string
  tool?: string
  summary?: string
  status?: 'ok' | 'error' | 'interrupted'
  lines?: number
  ref?: string | null
  /**
   * On a `question` block, what was asked. Every other tool call is collapsed
   * to one line on its way here; this one arrives whole, because the options
   * are the entire reason it is worth putting on a phone.
   */
  questions?: AgentQuestion[]
  /** On the `result` that closed a question: what was picked, by question. */
  answers?: Record<string, string>
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
  // The plan's headroom moved. Sent only when a percentage actually changes,
  // so this is rare enough to be worth pushing rather than polling.
  | { kind: 'limits'; limits: AgentLimits | null }
  // A background agent said something new about itself. Sent only when one
  // actually changes, which is what makes it worth pushing: a detached agent
  // has no screen anywhere else, and a list that only updates on a pull-down
  // is not one anybody watches.
  | { kind: 'jobs'; jobs: AgentJob[] }

type Listener = (data: any) => void

const REQUEST_TIMEOUT = 12_000
const PING_EVERY = 15_000
const PING_TIMEOUT = 10_000

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
   * What the phone is attached to, as last reported by the native module.
   *
   * `null` until something says otherwise, which is also the permanent state
   * anywhere the module does not exist — and `reachable` reads that as "try
   * anyway", so nothing here changes behaviour on a platform that cannot
   * answer the question.
   */
  private network: NetworkFacts | null = null
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

  /**
   * `force` is the escape hatch for the Reconnect button, and only for it.
   *
   * Parking is decided from what Android says about the network, and an OEM
   * that describes it wrongly would otherwise leave the user with a phone that
   * refuses to dial and no way to argue. A deliberate tap outranks the guess.
   */
  connect(force = false) {
    this.closedByUser = false
    clearTimeout(this.retryTimer)
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return
    // Pairing is exempt: the user is holding the phone in front of the address
    // they just typed or scanned, and refusing to try would be absurd.
    if (!force && !this.pairCode && !reachable(this.host, this.network)) return this.park()

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
  reconnectNow(force = false) {
    this.attempt = 0
    clearTimeout(this.retryTimer)
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return
    this.connect(force)
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

  /**
   * What the phone is attached to, from the native network callback.
   *
   * This is the other half of the backoff: the ladder decides how long to wait
   * between attempts, and this decides whether an attempt could succeed at
   * all. A desktop at 192.168.1.20 is not going to answer a phone on mobile
   * data however patiently it is asked.
   */
  setNetwork(facts: NetworkFacts | null) {
    this.network = facts
    if (this.closedByUser) return
    if (reachable(this.host, facts)) {
      // The phone just walked back onto a network that could carry this. The
      // ladder starts over — waiting out a rung earned on the wrong network
      // would be the delay this whole change exists to remove.
      if (this.status === 'parked') this.reconnectNow()
      return
    }
    // An open socket outranks any description of the network: if bytes are
    // still moving, this phone is demonstrably able to reach that desktop, and
    // no reading of the transport gets to say otherwise. A socket that only
    // looks alive dies of its own ping timeout soon enough, and the parking
    // decision is made properly on the way back through `onclose`.
    if (this.ws?.readyState === WebSocket.OPEN) return
    if (this.status !== 'idle' && this.status !== 'error') this.park()
  }

  /** The current view of the network, for anyone who has to explain it. */
  get networkFacts(): NetworkFacts | null {
    return this.network
  }

  /** Why the phone is not trying, in the words the notification uses. */
  get parkedNote(): string {
    return parkedReason(this.network)
  }

  /**
   * Stops trying until something changes.
   *
   * The socket is not closed here — if one somehow survives onto a network
   * that cannot reach the desktop it dies of its own ping timeout, and closing
   * it would only route back through `onclose` into this same decision. All
   * this does is cancel the timer that was going to fail.
   */
  private park() {
    clearTimeout(this.retryTimer)
    this.retryTimer = null
    this.attempt = 0
    this.setStatus('parked', null)
  }

  private scheduleReconnect() {
    if (!this.pairCode && !reachable(this.host, this.network)) return this.park()
    const delay = retryDelay(this.attempt)
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

  /**
   * `dest` picks which door the file goes through on the desktop. The default
   * is the share inbox, which notifies and is kept; `agent` is the swept cache
   * a picture waits in while an agent is told where to look, and the desktop
   * answers that one with the path it wrote.
   */
  uploadHeaders(filename: string, dest: 'inbox' | 'agent' = 'inbox') {
    return {
      'x-oc-token': this.token ?? '',
      'x-oc-filename': encodeURIComponent(filename),
      'x-oc-dest': dest,
      'content-type': 'application/octet-stream',
    }
  }

  downloadUrl(offerToken: string) {
    return `${this.baseUrl}/api/download/${offerToken}?token=${this.token ?? ''}`
  }
}
