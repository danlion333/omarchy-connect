import { AppState, Platform } from 'react-native'

import {
  ConnectClient,
  type AgentEvent,
  type AgentJob,
  type AgentLimits,
  type AgentSession,
  type AgentWrite,
  type ConnectionStatus,
  type Hello,
  type Stats,
} from './client'
import {
  deviceId,
  forgetDesktop,
  loadAlertPrefs,
  loadDesktop,
  saveDesktop,
  type SavedDesktop,
} from './storage'
import { findDesktopByKey, probeHost, type PairingTarget } from './discovery'
import { canWake, sendWakePacket, waitForDesktop } from './wake'
import { startReporting } from './telemetry'
import { startPhoneMirror } from './phone'
import {
  backgroundLinkChosen,
  backgroundLinkEnabled,
  drainOutbox,
  linkService,
  networkFacts,
  noteAgentAlert,
  noteFileAlert,
  setBackgroundLinkStatus,
  startBackgroundLink,
  stopBackgroundLink,
} from '../../modules/omarchy-link'
import {
  alertClipboard,
  alertFile,
  clearFileAlert,
  resetAlerts,
  setAlertPrefs,
  syncAgentAlerts,
} from './alerts'
import { downloadOffer } from '../lib/download'
import { saveToGallery } from '../lib/gallery'
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
 * tore the activity down used to show no stats at all until the next event
 * arrived. The state outlived nothing; now it outlives the screen.
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
  agents: AgentSession[]
  /**
   * How much of the plan is left.
   *
   * Kept beside the sessions rather than inside them because it is a property
   * of the account and not of any one conversation — and because it is the
   * number that decides whether to start something long, which is a decision
   * made on the list screen before any session is opened.
   */
  agentLimits: AgentLimits | null
  /**
   * The agents running with no terminal.
   *
   * Beside the sessions rather than among them: a background agent is not a
   * session this phone can open until the desktop has one for its transcript,
   * and until then it is still the only thing anywhere saying the machine is
   * working.
   */
  agentJobs: AgentJob[]
  clipboard: ClipboardEvent | null
  files: FileEvent[]
  latencyMs: number | null
  relocating: boolean
  /** A magic packet is out and the desktop has not answered yet. */
  waking: boolean
  client: ConnectClient | null
}

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
  agents: [],
  agentLimits: null,
  agentJobs: [],
  clipboard: null,
  files: [],
  latencyMs: null,
  relocating: false,
  waking: false,
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
  private wakingNow = false
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
    // Read before the first event can arrive: a phone that has asked not to be
    // interrupted must not be interrupted by the reconnect itself.
    setAlertPrefs(await loadAlertPrefs())
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
    // Seeded before the first dial, because the change event is no help here:
    // on a cold start after a reboot the last network change happened before
    // this process existed. Without this the first attempt goes out blind.
    client.setNetwork(networkFacts())
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
        // Written down every time rather than once at pairing: the card can
        // be armed, swapped or given a new subnet long after, and the copy
        // that matters is the one taken while the desktop was still awake.
        void this.rememberWake(msg.wake ?? null)
        // The desktop client puts this phone's battery in the Omarchy bar.
        // Only a desktop that says it wants the report gets one.
        stopReporting?.()
        stopReporting = (msg.capabilities?.device as any)?.report ? startReporting(client) : undefined
        // Whatever a notification button asked for while the phone had no
        // socket — after a reboot, or once Android tore the runtime down under
        // the service. This is the first moment any of it can be done.
        void this.flushOutbox()
      }),
      client.on('ev:stats', (data: Stats) => this.patch({ stats: data })),
      client.on('ev:theme', (data: Palette) => this.patch({ palette: { ...FALLBACK_PALETTE, ...data } })),
      /**
       * The session list is kept current by events, not by polling: a
       * `waiting` agent is the badge on the tab bar, and it has to appear
       * while the phone is on another screen entirely. Block traffic is not
       * handled here — only the chat that asked for it cares.
       */
      client.on('ev:agent', (data: AgentEvent) => {
        // The desktop flipped its own switch. Capabilities came from `hello`
        // and nothing is about to say hello again, so they are patched in
        // place — otherwise the screen would keep telling the user to run a
        // command they have already run.
        if (data.kind === 'control') return this.agentsSwitched(data.enabled, data.adapters, data.write ?? null)
        if (data.kind === 'limits') return this.patch({ agentLimits: data.limits })
        if (data.kind === 'jobs') return this.patch({ agentJobs: data.jobs || [] })
        this.setAgents(reduceAgents(this.state.agents, data))
      }),
      client.on('ev:clipboard', (data: ClipboardEvent) => {
        this.patch({ clipboard: data })
        alertClipboard(data.text)
      }),
      client.on('ev:file', (data: FileEvent) => {
        this.patch({ files: [data, ...this.state.files].slice(0, MAX_FILE_EVENTS) })
        // `out` is out of the desktop, which is the only direction that is
        // news here — a file this phone sent is a file its owner just watched
        // leave. The token is what makes it fetchable; without one there is
        // nothing a notification could offer to do.
        if (data.direction === 'out' && data.token) {
          alertFile({ token: data.token, name: data.name, size: data.size })
        }
      }),
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
  /**
   * Reading was turned on or off on the desktop while this phone was linked.
   * On, the list is fetched at once so the screen fills without a visit; off,
   * it is dropped, because nothing on it can be opened any more.
   */
  private agentsSwitched(enabled: boolean, adapters: string[], write: AgentWrite) {
    const hello = this.state.hello
    if (hello) {
      const capabilities = { ...(hello.capabilities || {}) } as Record<string, any>
      capabilities.agents = { ...(capabilities.agents || {}), enabled, adapters, write }
      this.patch({ hello: { ...hello, capabilities } as Hello })
    }
    if (enabled) void this.refreshAgents()
    else {
      this.setAgents([])
      this.patch({ agentLimits: null, agentJobs: [] })
    }
  }

  private attachGlobalListeners() {
    if (this.listening) return
    this.listening = true

    AppState.addEventListener('change', (state) => {
      if (state === 'active') this.client?.reconnectNow()
    })

    const native = linkService()
    if (native) {
      native.addListener('onNetworkChange', (facts) => {
        // Two things at once. The facts decide whether dialling this desktop
        // could work at all — a phone that has just left the house cannot
        // reach a 192.168 address however often it asks — and a phone that
        // has just arrived should not wait out a backoff rung it earned on
        // the wrong network. `setNetwork` does both: it parks, or it re-dials.
        //
        // A phone that just joined a network cannot resolve the desktop the
        // same millisecond; the first attempt failing is normal and the
        // backoff takes it from there.
        this.client?.setNetwork(facts ?? null)
      })
      // Somebody answered a waiting agent from the notification shade. The
      // text is already safe in the native backlog; this is the fast path for
      // the ordinary case where the runtime happened to be up.
      // A notification button asked for something. Whatever it was is already
      // safe in the native outbox; this is the fast path for the ordinary case
      // where the runtime happened to be up.
      native.addListener('onOutbox', () => void this.flushOutbox())
      native.addListener('onLinkReconnect', () => {
        // Forced: a deliberate tap outranks whatever Android said about the
        // network. If the phone is parked because the facts are wrong, this
        // is the only way out of it.
        this.client?.reconnectNow(true)
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

  /**
   * Keeps the stored pairing's wake block in step with what the desktop just
   * said about itself. A no-op when nothing moved — this writes to secure
   * storage, and doing that once a reconnect for no reason is a waste.
   */
  private async rememberWake(wake: Hello['wake'] | null) {
    const desktop = this.state.desktop
    if (!desktop || !wake) return
    if (JSON.stringify(desktop.wake ?? null) === JSON.stringify(wake)) return
    const next = { ...desktop, wake }
    await saveDesktop(next).catch(() => {})
    this.patch({ desktop: next })
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
            : // Parked is not a failure and must not read as one. The line used
              // to say "the phone keeps trying", which stops being true the
              // moment it stops trying — so it says what it is waiting for.
              status === 'parked'
              ? this.client?.parkedNote ?? 'waiting for your home network'
              : status === 'error'
                ? this.state.error || 'not connected'
                : 'not connected'
    setBackgroundLinkStatus(text, this.state.desktop?.name ?? null, status === 'connected', status === 'parked')
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
    resetAlerts()
    this.unwire?.()
    this.unwire = null
    this.client?.close()
    this.client = null
    await forgetDesktop()
    this.patch({ ...INITIAL, ready: true })
  }

  /**
   * The reconnect the user asked for, from a screen.
   *
   * Forced, for the same reason the notification's button is: the link parks
   * itself on a network Android describes as unable to reach this desktop, and
   * an OEM that describes it wrongly must not leave somebody staring at a
   * phone that refuses to dial. Tapping outranks the guess.
   */
  reconnectNow() {
    this.client?.reconnectNow(true)
  }

  /**
   * Wakes the desktop, then waits for it to come back.
   *
   * Nothing acknowledges a magic packet, so the only honest confirmation is
   * the daemon answering `/api/info` again — which is what this waits for, and
   * what it reports. A desktop that came up on a new address is not a failure
   * either: the socket's own retry hands over to `relocate()`, which finds it
   * by the key the phone pinned.
   */
  async wake(): Promise<boolean> {
    const desktop = this.state.desktop
    if (!desktop) throw new Error('not paired with a desktop yet')
    if (!canWake(desktop.wake)) {
      throw new Error(
        desktop.wake?.mac
          ? 'waking a desktop needs the Android app — nothing in Expo Go or on iOS can send this packet'
          : 'this desktop has not told the app how to wake it — connect once and try again',
      )
    }
    if (this.wakingNow) return false
    this.wakingNow = true
    this.patch({ waking: true })
    try {
      await sendWakePacket(desktop.wake!, desktop.host)
      const answered = await waitForDesktop(() => probeHost(desktop.host, desktop.port))
      // Forced on the strength of the probe: something just answered at that
      // address over HTTP, which is better evidence that the desktop is
      // reachable than anything the transport can imply.
      this.client?.reconnectNow(true)
      return answered
    } finally {
      this.wakingNow = false
      this.patch({ waking: false })
    }
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
      const res = await client.call<{ sessions: AgentSession[]; limits?: AgentLimits | null }>('agents.list', {})
      this.setAgents(res.sessions || [])
      // The list carries the limits with it, so the status line is filled by
      // the same round trip that fills the screen under it rather than by a
      // second call the app would have to remember to make.
      if (res.limits !== undefined) this.patch({ agentLimits: res.limits })
    } catch {
      // Disabled on the desktop, or an older daemon: an empty list is the
      // honest answer, and the screen says why.
      this.setAgents([])
    }
  }

  /**
   * The background agents, asked for rather than waited on.
   *
   * Changes are pushed — a detached agent's commentary moves every few seconds
   * and the phone is its only screen — but a phone that has just connected has
   * missed every change there ever was. An event stream is not a starting
   * state, so the screen asks once and listens after that.
   *
   * The answer carries one thing only a round trip knows: which of the jobs
   * this daemon also has a live session for, and so which of them the phone
   * can walk into rather than only read about.
   */
  async refreshAgentJobs(): Promise<Record<string, string>> {
    const client = this.client
    if (!client || client.status !== 'connected') return {}
    try {
      const res = await client.call<{ jobs: AgentJob[]; open: Record<string, string> }>('agents.jobs', {})
      this.patch({ agentJobs: res.jobs || [] })
      return res.open || {}
    } catch {
      // Disabled on the desktop, or a daemon too old to know the call.
      this.patch({ agentJobs: [] })
      return {}
    }
  }

  /**
   * The one door the session list changes through.
   *
   * Everything the phone shows about agents hangs off this — the screen, the
   * tab badge, and now the notification that interrupts. Routing the three
   * writers through here is what keeps the shade from disagreeing with the
   * list: a question answered on the desktop clears its card whether the news
   * arrived as an event or as a fresh `agents.list` after a reconnect.
   */
  private setAgents(agents: AgentSession[]) {
    this.patch({ agents })
    syncAgentAlerts(agents)
  }

  /**
   * Does whatever a notification button asked for.
   *
   * The request was written down natively before this had any chance to run —
   * see `Outbox` — so failing here is recoverable: the notification says what
   * happened and the thing is still there to do properly. Nothing is retried
   * behind the user's back, because an answer arriving at an agent that has
   * since moved on is worse than one that never came.
   */
  private async flushOutbox() {
    // Draining is destructive, so it waits for a socket that could actually
    // carry the work out. Anything asked for while the phone was offline stays
    // in the native outbox until `hello`, which is where this is called again.
    if (this.client?.status !== 'connected') return
    for (const entry of await drainOutbox()) {
      if (entry.kind === 'reply') await this.deliverReply(entry.id, entry.text)
      else if (entry.kind === 'save') await this.saveOffer(entry.id, entry.text)
    }
  }

  private async deliverReply(id: string, text: string) {
    try {
      await this.call('agents.send', { id, text })
      noteAgentAlert(id, `sent: ${text}`)
    } catch (error) {
      noteAgentAlert(id, `not sent — ${(error as Error)?.message || 'the desktop did not take it'}`)
    }
  }

  /**
   * Fetches an offered file and puts it in the phone's own gallery.
   *
   * Runs with no screen mounted, which is the entire point — **Save** on the
   * notification is meant to be the whole interaction. On Android 13 and up
   * that needs no prompt, because writing through MediaStore is allowed
   * outright; older versions want a storage permission that cannot be asked
   * for without an activity, and there the notification says so and the app is
   * one tap away.
   */
  private async saveOffer(token: string, name: string) {
    const client = this.client
    if (!client) return
    try {
      const uri = await downloadOffer(client.downloadUrl(token), token, name)
      await saveToGallery(uri)
      noteFileAlert(token, name, 'in your gallery')
      // Kept on screen for a moment as a receipt, then taken down: the offer
      // has been dealt with, and a card that lingers invites a second save.
      setTimeout(() => clearFileAlert(token), 8_000)
    } catch (error) {
      noteFileAlert(token, name, `not saved — ${(error as Error)?.message || 'the phone refused it'}`)
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

/**
 * A stand-in, on purpose. The phone cannot ask the platform what its owner
 * named it — Android hides that behind a permission on the versions that
 * matter, iOS hands out "iPhone" and nothing more without an entitlement — so
 * the desktop does the naming instead, from the hostname the phone put on its
 * DHCP lease. See `daemon/src/lib/hostname.js`.
 */
function deviceName() {
  return Platform.OS === 'ios' ? 'iPhone' : 'Android phone'
}

export const link = new Link()
