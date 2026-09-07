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
  forgetHistory,
  loadAlertPrefs,
  loadDesktop,
  loadHistory,
  mergeEndpoints,
  saveDesktop,
  saveHistory,
  type SavedDesktop,
} from './storage'
import { findDesktopByKey, probeHost, type PairingTarget } from './discovery'
import { orderCandidates } from '../lib/retry'
import { shouldRedial } from '../lib/announce'
import { reduceAgents } from '../lib/agents'
import { remember } from '../lib/clipboard'
import { rememberFile } from '../lib/history'
import { merged } from '../lib/state'
import { errorLine } from '../lib/errors.ts'
import { startReporting } from './telemetry'
import { startPhoneMirror } from './phone'
import { startLocateResponder } from './locate'
import { NO_MIC, startMicResponder, type MicResponder, type MicState } from './mic'
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
  alertClipboardImage,
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

/**
 * What the desktop copied. `text` is null when it copied a picture instead —
 * the bytes are not on the event, they are a standing file offer, and `token`
 * is what fetches them over the same download road as any other offer.
 */
export type ClipboardEvent = {
  text: string | null
  at: number
  source: string
  kind?: 'text' | 'binary'
  mime?: string
  token?: string | null
  name?: string
  size?: number
}
export type FileEvent = { direction: 'in' | 'out'; name: string; size: number; token?: string; at?: number }

export type LinkState = {
  /** False until the stored pairing has been read off disk. */
  ready: boolean
  status: ConnectionStatus
  error: string | null
  /**
   * The last complaint the desktop sent about something this phone asked for.
   *
   * Separate from `error`, which is the socket's own health and is rewritten
   * by every status event: a desktop that says "no such method" while the link
   * is perfectly up would have been overwritten within the second, which is
   * why `server-error` used to be emitted to nobody at all. This one is
   * cleared only when the user has seen it and dismissed it.
   */
  serverError: string | null
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
  /**
   * Why the session list is empty, when it is empty because asking failed.
   *
   * `refreshAgents` swallowed its throw and set an empty list, which reads on
   * screen exactly like a desktop with nothing running — the one case where
   * "nothing is running" and "I could not find out" must not look the same.
   */
  agentsError: string | null
  /**
   * What the desktop has copied, newest first — a history and not a slot, so
   * the phone can still reach the URL that the next copy overwrote. Capped by
   * `MAX_CLIPBOARD_EVENTS`; `remember` decides what stays.
   */
  clipboard: ClipboardEvent[]
  files: FileEvent[]
  latencyMs: number | null
  relocating: boolean
  /**
   * Whether the desktop is listening to this phone's microphone, and why the
   * last press did not do what it said. Kept here rather than in the card,
   * because a recording outlives the screen that started it.
   */
  mic: MicState
  client: ConnectClient | null
}

/** After this many failed retries we stop trusting the stored address. */
const RELOCATE_AFTER = 3
/** The one subscription that is held by a screen rather than by the socket. */
const STATS = 'stats'

const INITIAL: LinkState = {
  ready: false,
  status: 'idle',
  error: null,
  serverError: null,
  desktop: null,
  hello: null,
  palette: FALLBACK_PALETTE,
  stats: null,
  agents: [],
  agentLimits: null,
  agentJobs: [],
  agentsError: null,
  clipboard: [],
  files: [],
  latencyMs: null,
  relocating: false,
  mic: NO_MIC,
  client: null,
}

type Subscriber = (state: LinkState) => void

class Link {
  state: LinkState = INITIAL

  private subscribers = new Set<Subscriber>()
  private client: ConnectClient | null = null
  private unwire: (() => void) | null = null
  /** The live microphone responder, while there is a socket to offer down. */
  private microphone: MicResponder | null = null
  private starting: Promise<void> | null = null
  private started = false
  private relocatingNow = false
  private listening = false
  /**
   * How many screens are asking for the per-second stats snapshot.
   *
   * Counted rather than a flag because the answer has to survive two screens
   * overlapping: React mounts the incoming one before it unmounts the one
   * going away, and a boolean would be turned off by the departure and stay
   * off. Nothing is holding this most of the time, which is the point.
   */
  private statsWatchers = 0
  /** Whether the desktop has been told, so it is told once per change. */
  private statsWanted = false

  /* ── subscription ────────────────────────────────────────────────── */

  subscribe(subscriber: Subscriber) {
    this.subscribers.add(subscriber)
    return () => {
      this.subscribers.delete(subscriber)
    }
  }

  /**
   * Writes the changes down and tells everybody — unless there is nothing to
   * tell. `merged` hands back the state it was given when every field already
   * holds what the change says, and a state that did not move is not news: no
   * new object goes out, so no context value changes and no screen re-renders
   * for an event that only repeated itself.
   */
  private patch(changes: Partial<LinkState>) {
    const next = merged(this.state, changes)
    if (next === this.state) return
    this.state = next
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
    // What arrived while a previous process was alive. Only for a phone that
    // is still paired: the history belongs to the pairing, and an unpaired
    // phone has nothing it is entitled to show.
    const history = saved ? await loadHistory() : null
    if (this.started) return
    this.started = true
    this.patch({ desktop: saved, ready: true, ...(history ?? {}) })
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
      // The pull half of the network question. The change event is no help on
      // a cold start — after a reboot the last change happened before this
      // process existed — and it is no help either after the last network
      // goes away, which is the change nothing can report a successor to. So
      // every decision to dial asks rather than remembers.
      network: networkFacts,
      // How a candidate address is asked whether the desktop is behind it.
      // Handed in rather than reached for, so `api/client` stays free of the
      // native modules `api/discovery` needs.
      probe: probeHost,
      endpoints: saved.endpoints ?? [],
    })
    this.adopt(client)
    // Still seeded here, so the screen and the notification have an answer
    // before the first dial rather than only after it.
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
    // A fresh client starts out subscribed to the always-on events and
    // nothing else, so whatever is on screen right now has to ask again.
    this.statsWanted = false
    this.syncStats()
  }

  /**
   * Asks for the stats feed while something is on screen to read it.
   *
   * The daemon samples CPU, memory, disk and network once a second and sends
   * the lot to every subscribed phone. That is worth paying for while the
   * dashboard is in front of somebody and worth nothing at all otherwise — on
   * another tab, or with the phone in a pocket and the link held open by the
   * foreground service. The subscription is therefore held by the screen that
   * reads it rather than by the socket, and released when it goes away.
   *
   * Returns the release, which is idempotent: an effect cleanup that runs
   * twice must not take somebody else's watch down with it.
   */
  watchStats(): () => void {
    this.statsWatchers += 1
    this.syncStats()
    let released = false
    return () => {
      if (released) return
      released = true
      this.statsWatchers -= 1
      this.syncStats()
    }
  }

  /**
   * Brings the desktop's idea of the stats subscription in line with ours.
   *
   * Two things decide it: whether a screen is holding a watch, and whether the
   * app is in front of anybody at all. The second matters as much as the
   * first — the dashboard stays mounted while the phone is face-down on a
   * table, which is exactly the case this is for.
   *
   * `appState` is passed in from the listener rather than read here, because
   * the change event is the earliest anything knows and there is no reason to
   * trust that the global has caught up yet.
   */
  private syncStats(appState: string = AppState.currentState) {
    const wanted = this.statsWatchers > 0 && appState === 'active'
    if (wanted === this.statsWanted) return
    this.statsWanted = wanted
    if (!wanted) return this.client?.unsubscribe([STATS])
    this.client?.subscribe([STATS])
    // The tick is a whole second wide and the numbers on screen are whatever
    // the dashboard was last showing, so returning to it would otherwise mean
    // up to a second of visibly old figures. One question answers that
    // straight away; the feed takes over from the next tick.
    this.client
      ?.call<Stats>('system.stats', {})
      .then((data) => {
        if (this.statsWanted) this.patch({ stats: data })
      })
      .catch(() => {
        /* the subscription is the real source; a missed one-shot costs a tick */
      })
  }

  private wire(client: ConnectClient) {
    let stopReporting: (() => void) | undefined
    // Started once for the life of the socket rather than per-hello: it
    // listens for `hello` itself, which is when it drains whatever the
    // native receiver wrote down while the app was closed.
    const stopMirror = startPhoneMirror(client)
    // Separate from the mirror on purpose: being findable is not telephony.
    // It needs no SMS permission, no call log and no Android build that has
    // any of them — only the alarm the link module can play — so it must not
    // be switched off by the same `null` that turns mirroring into a no-op.
    const stopLocating = startLocateResponder(client)
    // The same shape as locating, and for the same reason: the desktop asks,
    // the handset answers, and neither needs a screen to be open for it. The
    // difference is the card: the responder outlives every screen, so what it
    // reports here is what the microphone card draws when somebody comes back
    // to it — a stream that started an hour and two tabs ago included.
    const microphone = startMicResponder(client, (mic) => this.patch({ mic }))
    this.microphone = microphone
    const stopMicrophone = () => {
      if (this.microphone === microphone) this.microphone = null
      microphone.stop()
      this.patch({ mic: NO_MIC })
    }
    const offs = [
      client.on('status', ({ status, error }: { status: ConnectionStatus; error: string | null }) => {
        this.patch({ status, error })
        this.announce(status)
        if (status === 'reconnecting' && client.failedAttempts >= RELOCATE_AFTER) void this.relocate()
      }),
      client.on('hello', (msg: Hello) => {
        this.patch({ hello: msg, ...(msg.theme ? { palette: { ...FALLBACK_PALETTE, ...msg.theme } } : {}) })
        // Written down every time rather than once at pairing: the address
        // list changes with the desktop's tunnels, and the address this socket
        // actually landed on is only known now.
        void this.rememberPairing(client, msg)
        // The desktop client puts this phone's battery in the Omarchy bar.
        // Only a desktop that says it wants the report gets one.
        stopReporting?.()
        stopReporting = (msg.capabilities?.device as any)?.report ? startReporting(client) : undefined
        // Whatever a notification button asked for while the phone had no
        // socket — after a reboot, or once Android tore the runtime down under
        // the service. This is the first moment any of it can be done.
        void this.flushOutbox()
      }),
      /**
       * The desktop's address list changing under a live socket is worth
       * exactly as much as the one in `hello`, and until now it was worth
       * less: the client took it into memory and nothing wrote it down. A
       * desktop that greeted the phone before its own tunnel was detected —
       * which is every restart the phone redials into — corrected itself
       * seconds later with this event, and the correction died with the
       * process. Written through the same merge as `hello`, so a typed-in
       * address still survives it.
       */
      client.on('ev:endpoints', (data: { endpoints?: Hello['endpoints'] }) => {
        void this.rememberEndpoints(data?.endpoints ?? null)
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
        // A picture with nothing fetchable behind it is the desktop saying
        // it is holding one it will not carry; there is nothing the phone
        // could show for it and nothing it could fetch, so it is dropped.
        if (data.kind === 'binary' && !data.token) return
        this.patch({ clipboard: remember(this.state.clipboard, data) })
        this.writeHistory()
        // Text and picture are the same one card in the shade — the desktop
        // clipboard holds one thing — but they reach it differently: the text
        // is already here, while the picture is a standing offer whose bytes
        // have to be fetched before there is anything to draw.
        if (typeof data.text === 'string') alertClipboard(data.text)
        else if (data.token) void this.announceClipboardImage(data.token, data.name || 'a picture', data.size)
      }),
      client.on('ev:file', (data: FileEvent) => {
        this.patch({ files: rememberFile(this.state.files, data) })
        this.writeHistory()
        // `out` is out of the desktop, which is the only direction that is
        // news here — a file this phone sent is a file its owner just watched
        // leave. The token is what makes it fetchable; without one there is
        // nothing a notification could offer to do.
        if (data.direction === 'out' && data.token) {
          alertFile({ token: data.token, name: data.name, size: data.size })
        }
      }),
      client.on('latency', (value: number) => this.patch({ latencyMs: value })),
      // The desktop objecting to something. It reaches a banner in the tab
      // shell; before this listener existed it reached nothing whatsoever.
      client.on('server-error', (message: string) => this.patch({ serverError: errorLine(message, 'the desktop refused that') })),
    ]
    return () => {
      stopReporting?.()
      stopMirror()
      stopLocating()
      stopMicrophone()
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
      // Going away drops the stats feed even with the dashboard still mounted;
      // coming back picks it up again. Every other subscription is untouched,
      // because everything else on the list is news the phone wants precisely
      // when nobody is looking at it.
      this.syncStats(state)
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
      native.addListener('onDesktopAnnounce', (announce) => {
        // A desktop somewhere on this subnet has just started its daemon. The
        // packet is a hint and nothing more — it is broadcast, so anything on
        // the network could have sent it — and `shouldRedial` is where that
        // is taken seriously: unless it names the key this phone pinned, and
        // unless the link is actually down, nothing happens at all.
        const client = this.client
        if (!client) return
        if (!shouldRedial(announce, { publicKey: client.publicKey, status: client.status })) return
        // Forced, for the same reason the notification's button is. A phone
        // that parked itself on a network Android described badly is exactly
        // the phone this feature exists for, and the desktop saying it is up
        // is better evidence than the description.
        client.reconnectNow(true)
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
      // The addresses we already know come first, and they are asked one at a
      // time rather than swept for: a tunnel address is a single question with
      // a yes-or-no answer, and it can be asked from anywhere. The subnet
      // sweep is the expensive road and the only one that can find an address
      // nobody has told us about — so it runs second, and only while the
      // phone is on a subnet worth sweeping. An overlay is never scanned;
      // dialling addresses it handed us is the whole of the contract.
      const found =
        (await this.probeKnownEndpoints(client)) ??
        (client.networkFacts === null || client.networkFacts.lan
          ? await findDesktopByKey(client.publicKey, client.port)
          : null)
      // The certificate pin is compared for the same reason it is compared
      // anywhere else, but neither it nor the identity key proves anything
      // here: both were read out of the candidate's own answer about itself,
      // and any HTTP server on this subnet can echo them back. A probe says
      // where to try next, no more.
      if (found && client.certPin && found.certPin && found.certPin !== client.certPin) return
      if (found && client.suspect(found.host, found.port)) return
      if (found && (found.host !== client.host || found.port !== client.port)) {
        // Followed, but not written down. The address on the stored pairing is
        // documented as the last one that actually worked, and until now this
        // wrote a probe result there — so a host that echoed the pinned key
        // once left the phone holding somebody else's address on disk. The
        // record is now moved by `rememberAddress` alone, off the back of a
        // `hello.ok`, which is the only moment anything has been proved.
        client.moveTo(found.host, found.port)
      }
    } finally {
      this.relocatingNow = false
      this.patch({ relocating: false })
    }
  }

  /**
   * Ask each address the desktop gave us, cheapest first, whether it is home.
   *
   * The two checks are the ones `relocate` has always made before following an
   * address anywhere: the identity key must be the one pinned at pairing, and
   * a certificate pin we hold must not have changed under us. Anything that
   * answers with somebody else's key is not our desktop, whatever the address.
   */
  private async probeKnownEndpoints(client: ConnectClient) {
    const candidates = orderCandidates(this.state.desktop?.endpoints ?? [], client.networkFacts, client.host)
    for (const candidate of candidates) {
      if (candidate.host === client.host && candidate.port === client.port) continue
      const found = await probeHost(candidate.host, candidate.port).catch(() => null)
      if (!found || found.publicKey !== client.publicKey) continue
      if (client.certPin && found.certPin && found.certPin !== client.certPin) continue
      // An address that has already claimed this key and then failed the
      // handshake is not asked a second time.
      if (client.suspect(candidate.host, candidate.port)) continue
      return found
    }
    return null
  }

  /**
   * Everything a working `hello` teaches us about the pairing, written down.
   *
   * One after another rather than both at once: each of these reads the
   * stored record, changes one part of it and writes the whole thing back, so
   * running them together would have the last writer quietly drop what the
   * others had just decided.
   */
  private async rememberPairing(client: ConnectClient, msg: Hello) {
    await this.rememberAddress(client.host, client.port)
    await this.rememberEndpoints(msg.endpoints ?? null)
  }

  /**
   * The address that just carried a working connection.
   *
   * `host`/`port` on the stored pairing are documented as the last address
   * that actually worked, and until now only `relocate` ever moved them. The
   * client picks its own address too — it orders the candidates at every dial
   * and races the ones it is not dialling — and none of that reached the
   * record, so the phone could sit on a tunnel address while the pairing still
   * named the home one. That is not just untidy: it is what the Settings
   * screen reads to say which road is in use, and what `orderCandidates` is
   * handed as the address that last worked.
   *
   * Written only when it says something new. This goes to the keychain, and a
   * reconnect that landed exactly where the record already points has nothing
   * to add.
   */
  private async rememberAddress(host: string, port: number) {
    const desktop = this.state.desktop
    if (!desktop || !host) return
    const moved = desktop.host !== host || desktop.port !== port
    const endpoints = desktop.endpoints ?? []
    const unproven = !endpoints.some((entry) => entry.host === host && entry.port === port && entry.lastGood)
    if (!moved && !unproven) return
    const now = Date.now()
    const next = {
      ...desktop,
      host,
      port,
      endpoints: endpoints.map((entry) =>
        entry.host === host && entry.port === port ? { ...entry, lastGood: now } : entry,
      ),
    }
    await saveDesktop(next).catch(() => {})
    this.patch({ desktop: next })
  }

  /**
   * Keeps the stored list of addresses in step with what the desktop just
   * said about itself. A no-op when nothing moved — this writes to secure
   * storage, and doing that once a reconnect for no reason is a waste.
   *
   * An address somebody typed in survives this; see `mergeEndpoints`.
   */
  private async rememberEndpoints(advertised: Hello['endpoints'] | null) {
    const desktop = this.state.desktop
    if (!desktop || !Array.isArray(advertised)) return
    const addresses = mergeEndpoints(
      desktop.endpoints,
      advertised.map((entry) => ({ ...entry, source: 'hello' as const })),
    )
    this.client?.setEndpoints(addresses)
    if (JSON.stringify(desktop.endpoints ?? []) === JSON.stringify(addresses)) return
    const next = { ...desktop, endpoints: addresses }
    await saveDesktop(next).catch(() => {})
    this.patch({ desktop: next })
  }

  /** Keeps the foreground service's notification honest. */
  private announce(status: ConnectionStatus) {
    // Worth saying out loud, because it is the difference between "the phone
    // is home" and "the phone is anywhere at all and the tunnel is up", and
    // because it explains why the telephony surfaces have gone quiet.
    const via = this.state.hello?.link
    const remotely =
      via?.via === 'remote'
        ? via.kind && via.kind !== 'overlay'
          ? `connected over ${via.kind}`
          : 'connected remotely'
        : 'connected'
    const text =
      status === 'connected'
        ? remotely
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
    // The history goes with the pairing, key first — see `forgetHistory`.
    // Awaited rather than fired off, so a screen that redraws on the empty
    // state cannot be showing rows a still-running write is about to save.
    await forgetHistory()
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
   * Puts what arrived on the disk, so it is still there after the process is
   * killed.
   *
   * Called from the two events that change it and nowhere else, and never
   * awaited: an event is delivered to the screen first and written down
   * second, because the socket must not wait on a file system, and a copy
   * that reaches the screen and not the disk is worth more than the reverse.
   * `saveHistory` serialises the writes itself.
   */
  private writeHistory() {
    if (!this.state.desktop) return
    void saveHistory({ clipboard: this.state.clipboard, files: this.state.files })
  }

  /** The user has read the desktop's complaint; the banner can go. */
  dismissServerError() {
    this.patch({ serverError: null })
  }

  /**
   * Offer this phone's microphone to the desktop, or take it back. One press
   * either way, and the responder — not the screen — decides what that means.
   */
  async offerMic(): Promise<void> {
    if (!this.microphone) {
      return this.patch({ mic: { ...this.state.mic, error: 'this phone is not connected to a desktop' } })
    }
    await this.microphone.offer()
  }

  /**
   * Take an address somebody typed in, having checked it is the right machine.
   *
   * The check is the point of the whole flow. An address entered by hand is
   * the one road into this app that no pairing QR vouched for, so the desktop
   * at the other end has to prove it is the desktop we already paired with, by
   * the same pinned identity key everything else here rests on. Anything else
   * answering is refused by name rather than stored and puzzled over later.
   */
  async addEndpoint(host: string, port: number): Promise<{ ok: boolean; error?: string }> {
    const desktop = this.state.desktop
    const client = this.client
    if (!desktop || !client?.publicKey) return { ok: false, error: 'no desktop is paired' }
    const address = host.trim()
    if (!address) return { ok: false, error: 'an address is needed' }

    const found = await probeHost(address, port).catch(() => null)
    if (!found) return { ok: false, error: 'no answer from that address' }
    if (found.publicKey !== client.publicKey) return { ok: false, error: 'that machine is not your desktop' }
    if (client.certPin && found.certPin && found.certPin !== client.certPin) {
      return { ok: false, error: 'that desktop answered with a different certificate' }
    }

    const endpoints = [
      ...(desktop.endpoints ?? []).filter((entry) => !(entry.host === address && entry.port === port)),
      { host: address, port, kind: 'manual' as const, source: 'manual' as const },
    ]
    await this.storeEndpoints(endpoints)
    return { ok: true }
  }

  /** Forgets an address somebody added by hand. The desktop's own stay. */
  async removeEndpoint(host: string, port: number) {
    const desktop = this.state.desktop
    if (!desktop) return
    await this.storeEndpoints(
      (desktop.endpoints ?? []).filter(
        (entry) => entry.source !== 'manual' || entry.host !== host || entry.port !== port,
      ),
    )
  }

  private async storeEndpoints(endpoints: SavedDesktop['endpoints']) {
    const desktop = this.state.desktop
    if (!desktop) return
    const next = { ...desktop, endpoints }
    this.client?.setEndpoints(endpoints ?? [])
    await saveDesktop(next).catch(() => {})
    this.patch({ desktop: next })
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
      this.patch({ agentsError: null })
      // The list carries the limits with it, so the status line is filled by
      // the same round trip that fills the screen under it rather than by a
      // second call the app would have to remember to make.
      if (res.limits !== undefined) this.patch({ agentLimits: res.limits })
    } catch (error) {
      // Disabled on the desktop, or an older daemon: an empty list is the
      // honest answer, and the screen says why — and now it can also say why
      // when the answer never arrived, instead of showing an empty list.
      this.setAgents([])
      this.patch({ agentsError: errorLine(error, 'the desktop did not send its agents') })
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
    // `reduceAgents` hands back the array it was given for every frame that is
    // not about the list — the draft of the sentence an agent is typing, which
    // arrives twice a second while it works. Nothing downstream of the list
    // has changed then, so neither the state nor the notification shade is
    // touched; the chat reads block traffic straight off the client.
    if (agents === this.state.agents) return
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
      // `submitted: false` is the desktop saying it typed the answer and
      // watched it stay in the agent's composer. Nothing was asked, so the
      // notification must not say the answer went through.
      const result = await this.call<{ submitted?: boolean }>('agents.send', { id, text })
      if (result?.submitted === false) throw new Error('it is still sitting in the composer on the desktop')
      noteAgentAlert(id, `sent: ${text}`)
    } catch (error) {
      noteAgentAlert(id, `not sent — ${(error as Error)?.message || 'the desktop did not take it'}`)
    }
  }

  /**
   * Puts a picture the desktop copied in the shade, preview and all.
   *
   * The bytes come down the road every offer uses, so this is `saveOffer`
   * without the gallery — and, like it, it runs with no screen mounted. It is
   * deliberately not awaited by the event handler: the history card is up the
   * moment the event lands, and a download the size of a screenshot must not
   * hold the socket's callback while it happens.
   */
  private async announceClipboardImage(token: string, name: string, size?: number) {
    await alertClipboardImage({ token, name, size }, async () => {
      const client = this.client
      if (!client) return null
      return downloadOffer(client.downloadUrl(token), token, name, await client.downloadPass())
    })
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
      const uri = await downloadOffer(client.downloadUrl(token), token, name, await client.downloadPass())
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
