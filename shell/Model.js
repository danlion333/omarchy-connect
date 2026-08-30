.pragma library

// Pure formatting for the panel. Nothing here reads state or runs anything —
// the Service owns the data, Panel.qml owns the layout, and this file only
// turns numbers into the short strings a status card can hold.

function isObject(value) {
  return value !== null && value !== undefined && typeof value === "object"
}

function num(value, fallback) {
  var n = Number(value)
  return isFinite(n) ? n : (fallback === undefined ? 0 : fallback)
}

/** `1536` → `1.5 KB`. Powers of 1024, one decimal until it stops helping. */
function bytes(value) {
  var n = num(value, -1)
  if (n < 0) return "--"
  if (n < 1024) return n + " B"
  var units = ["KB", "MB", "GB", "TB"]
  var i = -1
  do {
    n /= 1024
    i += 1
  } while (n >= 1024 && i < units.length - 1)
  return (n >= 10 ? Math.round(n) : Math.round(n * 10) / 10) + " " + units[i]
}

/** `now` is passed in so every row in one repaint agrees on what "now" is. */
function since(timestamp, now) {
  var at = num(timestamp, 0)
  if (at <= 0) return "never"
  var seconds = Math.floor((num(now, 0) - at) / 1000)
  if (seconds < 0) seconds = 0
  if (seconds < 45) return "just now"
  if (seconds < 90) return "a minute ago"
  var minutes = Math.round(seconds / 60)
  if (minutes < 60) return minutes + "m ago"
  var hours = Math.round(minutes / 60)
  if (hours < 24) return hours + "h ago"
  var days = Math.round(hours / 24)
  if (days < 30) return days + "d ago"
  return Math.round(days / 30) + "mo ago"
}

/** Duration a link has been up: `3h 12m`, `48s`. */
function uptime(from, now) {
  var start = num(from, 0)
  if (start <= 0) return ""
  var seconds = Math.max(0, Math.floor((num(now, 0) - start) / 1000))
  if (seconds < 60) return seconds + "s"
  var minutes = Math.floor(seconds / 60)
  if (minutes < 60) return minutes + "m"
  var hours = Math.floor(minutes / 60)
  return hours + "h " + (minutes % 60) + "m"
}

function countdown(expiresAt, now) {
  var left = Math.round((num(expiresAt, 0) - num(now, 0)) / 1000)
  return left > 0 ? left + "s" : "expired"
}

function platformLabel(platform) {
  var value = String(platform || "").toLowerCase()
  if (value === "ios") return "iOS"
  if (value === "android") return "Android"
  if (value === "") return ""
  return value.charAt(0).toUpperCase() + value.slice(1)
}

/** A battery glyph that actually tracks the level, charging bolt included. */
function batteryGlyph(battery) {
  if (!isObject(battery)) return "󰂑"
  if (battery.charging === true) return "󰂄"
  var steps = ["󰂎", "󰁺", "󰁻", "󰁼", "󰁽", "󰁾", "󰁿", "󰂀", "󰂁", "󰂂", "󰁹"]
  var index = Math.round(num(battery.percent, 0) / 10)
  if (index < 0) index = 0
  if (index > 10) index = 10
  return steps[index]
}

function batteryText(battery) {
  if (!isObject(battery)) return "--"
  return num(battery.percent, 0) + "%" + (battery.charging === true ? " charging" : "")
}

function transferGlyph(direction) {
  // A tray rather than a bare arrow: the direction is half the answer, and the
  // other half — that this row is a file at all — is what the tray carries.
  return String(direction) === "out" ? "󰄝" : "󰄠"
}

function transferLabel(entry, now) {
  if (!isObject(entry)) return ""
  var parts = []
  if (entry.size !== undefined && entry.size !== null) parts.push(bytes(entry.size))
  parts.push(since(entry.at, now))
  return parts.join(" · ")
}

function deviceGlyph(platform) {
  var value = String(platform || "").toLowerCase()
  if (value === "ios") return "󰀷"
  if (value === "android") return "󰀲"
  return "󰄜"
}

/** The daemon publishes `exec` as argv; a terminal wants one command line. */
function shellQuote(argv) {
  var parts = []
  var list = Array.isArray(argv) && argv.length > 0 ? argv : ["omarchy-connect"]
  for (var i = 0; i < list.length; i++) {
    var arg = String(list[i])
    parts.push(/^[A-Za-z0-9_\/.:=-]+$/.test(arg) ? arg : "'" + arg.replace(/'/g, "'\\''") + "'")
  }
  return parts.join(" ")
}

/** argv for the daemon CLI plus the given arguments. */
function command(status, args) {
  var exec = isObject(status) && Array.isArray(status.exec) && status.exec.length > 0
    ? status.exec.slice()
    : ["omarchy-connect"]
  return exec.concat(args || [])
}

function onlineDevices(status) {
  if (!isObject(status) || !Array.isArray(status.devices)) return []
  return status.devices.filter(function (d) { return d && d.online === true })
}

function pairingActive(status, now) {
  if (!isObject(status) || !isObject(status.pairing)) return false
  return num(status.pairing.expiresAt, 0) > num(now, 0)
}

/** SMS or call, which way it went, and whether anybody picked up. */
function phoneGlyph(entry) {
  if (!entry) return "󰍩"
  if (entry.kind === "notification") return "󰂜"
  if (entry.kind === "sms") return "󰍩"
  if (entry.missed) return "󰏺"
  if (entry.state === "ringing") return "󱆫"
  if (entry.state === "active") return "󰏶"
  if (entry.direction === "outgoing") return "󰏻"
  return "󰏷"
}

/** Who it was with — a name where the phone knew one, the number otherwise. */
function phoneWho(entry) {
  if (!entry) return ""
  // A mirrored app notification has no correspondent — the app is the subject.
  if (entry.kind === "notification") return entry.appName || entry.app || "app"
  return entry.name || entry.from || "unknown"
}

/** The one line of detail that fits beside the name. */
function phoneDetail(entry, now) {
  if (!entry) return ""
  var when = since(entry.at, now)
  if (entry.kind === "notification") {
    var line = String(entry.body || entry.title || "").replace(/\s+/g, " ").trim()
    return line ? line : when
  }
  if (entry.kind === "sms") {
    var body = String(entry.body || "").replace(/\s+/g, " ").trim()
    return body ? body : when
  }
  if (entry.missed) return "missed · " + when
  if (entry.state === "ringing") return "ringing"
  // A call still up has no "ago" to report — it is happening now, and a row
  // reading "0s" beside a live conversation is the panel looking past it.
  if (entry.state === "active") return "on the call"
  if (entry.direction === "outgoing") return "called · " + when
  return when
}

/* ── Bluetooth hands-free ─────────────────────────────────────────────── */

/**
 * Which handset this row is about, connected or not.
 *
 * `device` is filled only while the link is up, so a row that wants to name
 * the phone when it is down falls back to the handset the daemon has already
 * matched — the same one it would page. Pinned comes last because it is an
 * address somebody typed, and a name beats an address whenever there is one.
 */
function handsfreeName(bt) {
  if (!isObject(bt)) return ""
  var link = isObject(bt.link) ? bt.link : {}
  var known = isObject(link.handset) ? link.handset : null
  if (bt.device) return String(bt.device)
  if (known) return String(known.name || known.address || "")
  return link.pinned ? String(link.pinned) : ""
}

/**
 * Whether the Bluetooth row has anything to say.
 *
 * This row used to appear only while the link was up or failing, on the
 * grounds that the link is the desktop's business rather than the user's.
 * That held while a call was the only thing that could raise it. It stopped
 * holding once the row grew a button: a control that shows up only after it
 * has been used is not a control, and a handset that is bonded but idle — the
 * ordinary state under the `ring` policy — was leaving the panel with nothing
 * on screen at all.
 *
 * `paired` is the last state it grew to cover, and the one this row was worst
 * at: a desktop paired over the LAN with no Bluetooth bond had nothing on
 * screen until somebody pressed something that failed, and then a sentence
 * with no button under it. That desktop is exactly the one with something to
 * do here — it knows whose phone it wants — so the row stands for it too, and
 * the button under it makes the bond.
 */
function handsfreeShown(bt, paired) {
  if (!isObject(bt) || bt.available !== true) return false
  var link = isObject(bt.link) ? bt.link : {}
  if (bt.connected === true || link.raising === true || link.error || isObject(link.bonding)) return true
  return !!(isObject(link.handset) || link.pinned || paired)
}

/**
 * Which way the button points: `bond`, `connect`, `disconnect`, or neither.
 *
 * Neither while a page or a pairing window is in flight — pressing then races
 * the daemon for a state that lands on its own a moment later.
 *
 * With no handset matched there is no address to page, and the button used to
 * disappear for that reason. It was the wrong answer to the right observation:
 * there is nothing to *connect* to, but there is very much something to do,
 * and it is the one thing that turns this row from a sentence about a problem
 * into the fix for it.
 */
function handsfreeAction(bt, paired) {
  if (!handsfreeShown(bt, paired)) return ""
  var link = isObject(bt.link) ? bt.link : {}
  if (link.raising === true || link.standingDown === true || isObject(link.bonding)) return ""
  if (bt.connected === true) return "disconnect"
  if (handsfreeName(bt)) return "connect"
  return "bond"
}

/**
 * The state of the hands-free link, in one line.
 *
 * "unsupported" and "not connected" are different answers and the difference
 * is actionable: the first means this machine's PipeWire is too old to publish
 * org.pipewire.Telephony, the second only means nothing is paired yet.
 *
 * A matched handset with the link down names the phone *and* says it is off,
 * because those are the two things the button beside it is about to change,
 * and because a bond that outlives its link is the whole point of raising one
 * by hand instead of by pairing.
 */
function handsfreeText(bt, now) {
  if (!isObject(bt) || bt.available !== true) return "unsupported"
  var link = isObject(bt.link) ? bt.link : {}
  var name = handsfreeName(bt)
  // A window in flight outranks everything else the row could say: it is the
  // only state in which something is expected to happen on the phone, and the
  // panel is where whoever pressed the button is looking for that news.
  if (isObject(link.bonding)) return bondingText(link.bonding, now)
  if (bt.connected !== true) {
    if (link.raising === true) return "connecting…"
    if (link.error) return String(link.error)
    // "not connected" is an answer about a link. With no bond under it there
    // is no link to be disconnected from, and the row said so in the tense of
    // something broken rather than something not made yet.
    if (!name) return "no handset paired"
    return name + " · not connected"
  }
  if (link.standingDown === true) return "disconnecting…"
  // "active" is the transport state that means audio is actually on this
  // machine's speakers rather than the profile merely being up.
  if (bt.audio === "active") return name + " · audio here"
  return name || "connected"
}

/**
 * A pairing window, in the tense of the thing being waited for.
 *
 * The stages are not equally interesting. `looking` is the one the user has to
 * act on — the desktop is visible and the phone is where the next move
 * happens — so it says that rather than naming the stage, and it counts down,
 * because a window with an end is a wait somebody can decide to sit through.
 */
function bondingText(bonding, now) {
  var who = isObject(bonding.handset) ? bonding.handset.name || bonding.handset.address : ""
  // A pin means the handset fell back to legacy pairing and its dialog is
  // waiting for a code right now — nothing else on the row matters until the
  // person standing at the phone learns what to type.
  if (bonding.pin) return "type " + bonding.pin + " on the phone"
  if (bonding.stage === "pairing") return "pairing with " + (who || "the handset") + "…"
  if (bonding.stage === "connecting") return "paired · connecting…"
  var left = Math.max(0, Math.round((Number(bonding.until || 0) - (now || Date.now())) / 1000))
  return "visible for " + left + "s — pick this desktop on the phone"
}

/**
 * The glyph in front of the row, carrying the state the words have no width
 * for. The same trick the bar plays with its three colours: a reader who only
 * glances gets the answer from the icon, and the words wait for the one who
 * stops.
 */
function handsfreeGlyph(bt) {
  if (!isObject(bt)) return "󰂯"
  var link = isObject(bt.link) ? bt.link : {}
  if (link.raising === true || link.standingDown === true || isObject(link.bonding)) return "󰂳"
  if (bt.connected === true) return "󰂱"
  if (link.error) return "󰂲"
  return "󰂯"
}

/**
 * The iPhone bridge row.
 *
 * Three states worth telling apart: this machine has no BlueZ at all, a phone
 * is bonded but nothing is coming through, and notifications are arriving.
 * Only the middle one is fixed by re-pairing, which is why it says so.
 */
function iosText(ios) {
  if (!ios || ios.available !== true) return "unavailable"
  if (ios.pairing) return "pairing open"
  if (ios.subscribed === true) return (ios.device || "iPhone") + " · mirroring"
  if (ios.paired === true) return (ios.device || "iPhone") + " · idle"
  return "not paired"
}

/**
 * How long the conversation has been going, as a phone would show it.
 *
 * The desktop that answered the call is the only clock in the room — the
 * handset's own timer is on a screen nobody is holding — so the card counts,
 * and this is the panel's copy of it. The bar deliberately has none: a number
 * that changes width every second does not belong in a row of fixed-width
 * icons. Empty until somebody picks up: a ringing phone has nothing to count
 * yet. A call on hold is still counted: the conversation it belongs to has
 * started, and the phone in your pocket does not reset its timer either.
 */
function callClock(call, now) {
  if (!isObject(call) || (call.state !== "active" && call.state !== "held")) return ""
  var start = num(call.startedAt, 0)
  if (start <= 0) return ""
  var seconds = Math.max(0, Math.floor((num(now, 0) - start) / 1000))
  var pad = function (n) { return n < 10 ? "0" + n : String(n) }
  var minutes = Math.floor(seconds / 60)
  if (minutes < 60) return pad(minutes) + ":" + pad(seconds % 60)
  return Math.floor(minutes / 60) + ":" + pad(minutes % 60) + ":" + pad(seconds % 60)
}

/** Who the live call is with, in plain words — no glyph, for a tooltip. */
function callWho(call) {
  if (!isObject(call)) return ""
  return String(call.name || call.from || "unknown number")
}

/** The headline on the live-call card. */
function callHeadline(call) {
  if (!call) return ""
  var who = callWho(call)
  if (call.state === "incoming" || call.state === "waiting" || call.state === "ringing") return "󱆫  " + who
  if (call.state === "dialing" || call.state === "alerting") return "󰏻  " + who
  return "󰏶  " + who
}

/** The dim second line: what the call is doing, and where the sound goes. */
function callDetail(call, bt, now) {
  if (!call) return ""
  var state = String(call.state || "")
  // Where the sound will come out is the one thing worth saying before the
  // button is pressed, and it is not the same answer on both roads: only the
  // hands-free profile moves the audio, the app just presses the button.
  if (state === "incoming" || state === "ringing") {
    return call.via && call.via !== "bluetooth"
      ? "ringing · answering leaves the audio on the phone"
      : "ringing · answer to take it here"
  }
  if (state === "waiting") return "call waiting · answering holds the first"
  if (state === "held") {
    var paused = callClock(call, now)
    return paused === "" ? "on hold" : paused + " · on hold"
  }
  // Ringing at the far end, which is not a conversation and so has no clock —
  // counting from here is exactly the error this line exists not to make.
  if (state === "dialing" || state === "alerting") return "dialling"
  if (state === "active") {
    var here = call.audio === "active" || (bt && bt.audio === "active")
    // The clock leads, because it is the one thing on this line that changes
    // while you read it, and the reason anybody looks twice.
    var elapsed = callClock(call, now)
    var where = here ? "audio on this machine" : "audio on the handset"
    return (elapsed === "" ? "in progress" : elapsed) + " · " + where
  }
  return state
}

/* ── coding agents ────────────────────────────────────────────────────── */

/**
 * The coding-agent half of the status file, with every field defaulted.
 *
 * A daemon old enough not to publish this at all is the same case as a desktop
 * with the feature off: nothing to show, and a switch that says so.
 */
/**
 * How this desktop is reachable from off its own network, in one line.
 *
 * The address alone would be a puzzle — 100.101.102.103 means nothing to
 * anybody who has not just set up a tailnet — so the kind that handed it over
 * goes in front of it.
 */
function remoteText(remote) {
  if (!isObject(remote)) return "off"
  if (remote.enabled !== true) return "off"
  if (!remote.address) return "on, no tunnel up"
  var kind = remote.kind ? String(remote.kind) : "overlay"
  return kind + " \u00b7 " + String(remote.address)
}

/** How a connected phone got here. Empty when it came in the ordinary way. */
function linkText(device) {
  if (!isObject(device)) return ""
  if (device.via !== "remote") return ""
  return device.link ? "via " + String(device.link) : "from away"
}

function agents(status) {
  var value = isObject(status) && isObject(status.agents) ? status.agents : {}
  return {
    enabled: value.enabled === true,
    hooks: value.hooks === true,
    adapters: Array.isArray(value.adapters) ? value.adapters : [],
    // "tmux", "herdr", "wtype" or null — this desktop's road into a terminal.
    // A daemon from before the writing half simply has none, which reads the
    // same as a desktop that cannot type into anything.
    write: typeof value.write === "string" ? value.write : null,
    running: num(value.running, 0),
    waiting: num(value.waiting, 0),
    // Agents with no terminal at all. Nothing else on this desktop draws
    // them — no pane, no window — so a count here is the only sign from the
    // bar that the machine is working on something.
    jobs: num(value.jobs, 0),
    // How much of the plan is left, as the daemon read it out of the CLI's
    // own cache. A daemon too old to publish it has none, which reads the
    // same as an account with no limits to report.
    limits: isObject(value.limits) && Array.isArray(value.limits.limits) ? value.limits.limits : [],
    sessions: Array.isArray(value.sessions) ? value.sessions : []
  }
}

/**
 * The tightest usage window, when it is tight enough to be worth a word.
 *
 * Below three quarters this is noise on a bar — the number moves all day and
 * nothing follows from it. Past three quarters it is the reason a long run is
 * about to stop, which is exactly what a status line is for.
 */
function agentsPressure(value) {
  var worst = null
  for (var i = 0; i < value.limits.length; i += 1) {
    var limit = value.limits[i]
    if (!isObject(limit)) continue
    if (worst === null || num(limit.percent, 0) > num(worst.percent, 0)) worst = limit
  }
  if (worst === null || num(worst.percent, 0) < 75) return ""
  return String(worst.label || "usage") + " " + num(worst.percent, 0) + "%"
}

/** The one line under the header: what agent control is doing right now. */
function agentsText(value, running) {
  if (!value.enabled) return "off · the phone sees nothing"
  if (!running) return "on · nothing is watching while the daemon is stopped"
  if (value.waiting > 0) return value.waiting === 1 ? "one agent is waiting for you" : value.waiting + " agents are waiting for you"
  if (value.running > 0) {
    // Whether the phone can answer or only watch is the difference between a
    // notification you can act on and one you can only read, so it is what
    // this line spends its remaining words on — counted from the sessions
    // themselves, because a desktop with a multiplexer still has agents
    // running outside it.
    var answerable = value.sessions.filter(function (s) { return isObject(s) && s.writable }).length
    var how = answerable === 0 ? "reading only" : answerable === value.running ? "answerable" : answerable + " answerable"
    return (value.running === 1 ? "one session · " : value.running + " sessions · ") + how
  }
  if (value.jobs > 0) {
    return value.jobs === 1 ? "one agent working in the background" : value.jobs + " agents working in the background"
  }
  if (value.adapters.length === 0) return "on · no coding agent is installed here"
  var pressure = agentsPressure(value)
  return pressure !== "" ? "on · nothing running · " + pressure : "on · nothing running"
}

/** What a session is called: its own title, or the directory it works in. */
function agentTitle(session) {
  if (!isObject(session)) return ""
  var title = String(session.title || "").trim()
  if (title !== "") return title
  var parts = String(session.cwd || "").split("/").filter(function (p) { return p !== "" })
  return parts.length > 0 ? parts[parts.length - 1] : String(session.agent || "agent")
}

/**
 * The dim second line. `waiting` is the whole reason this panel carries agents
 * at all, so it says what the agent asked rather than when it last moved.
 */
function agentDetail(session, now) {
  if (!isObject(session)) return ""
  var mark = agentStateGlyph(session) + " "
  if (session.state === "waiting") {
    var prompt = String(session.prompt || "").replace(/\s+/g, " ").trim()
    return mark + (prompt !== "" ? prompt : "waiting for an answer")
  }
  // Right-aligned and elided from the right, so the order is what survives
  // being cut: what it is doing, when it last did it, and only then that the
  // session was a guess — a scan matched a transcript to a directory rather
  // than a hook naming it. The agent's own name is not here at all; one line
  // under a header that says CODING AGENTS does not need to repeat it.
  var parts = [session.state === "working" ? "working" : "idle", since(session.lastActivity, now)]
  // Only once it is news. A conversation past two thirds of its window is
  // about to start losing its own beginning, and that is worth a word on a
  // line that otherwise says how long ago something moved.
  var context = isObject(session.vitals) && isObject(session.vitals.context) ? num(session.vitals.context.percent, 0) : 0
  if (context >= 66) parts.push(context + "% full")
  if (session.via === "scan") parts.push("scanned")
  return mark + parts.join(" · ")
}

/** Which agent this is, lowercased, or "" for a session that never said. */
function agentId(session) {
  if (isObject(session)) return String(session.agent || "").toLowerCase()
  return String(session || "").toLowerCase()
}

/**
 * The agent's own mark, as a file beside the panel.
 *
 * Marks resolve by convention — `assets/<id>.svg` — which is the same rule the
 * shell's own agents panel follows, and it means a second agent needs a file
 * dropped in a folder rather than a line of code here. A session whose agent
 * ships nothing falls back to `agentGlyph`, and the row never notices.
 */
function agentMark(session) {
  var id = agentId(session)
  return id === "" ? "" : "assets/" + id + ".svg"
}

/**
 * The font's answer to the same question, for a mark that failed to load.
 *
 * Nerd Fonts draws the two agents anybody is likely to be running; a terminal
 * stands in for the rest, which is what an agent is when you cannot name it.
 */
function agentGlyph(session) {
  var id = agentId(session)
  if (id === "claude") return ""
  if (id === "codex" || id === "openai") return ""
  if (id === "copilot") return ""
  return "󰆍"
}

/**
 * What the session is doing, as one glyph in front of the line that says it in
 * words. The alert is the whole point of the card; the other two are there so
 * a glance down the list reads as a shape rather than as three sentences.
 */
function agentStateGlyph(session) {
  if (!isObject(session)) return ""
  if (session.state === "waiting") return "󰀦"
  if (session.state === "working") return "󰦖"
  return "󰒲"
}
