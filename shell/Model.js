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
  return String(direction) === "out" ? "󰁝" : "󰁅"
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

/** SMS or call, and whether anybody picked up. */
function phoneGlyph(entry) {
  if (!entry) return "󰍩"
  if (entry.kind === "notification") return "󰂚"
  if (entry.kind === "sms") return "󰍩"
  if (entry.missed) return "󰏶"
  if (entry.direction === "outgoing") return "󰏳"
  return "󰏲"
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
  return when
}

/* ── Bluetooth hands-free ─────────────────────────────────────────────── */

/**
 * The state of the hands-free link, in one line.
 *
 * "unsupported" and "not connected" are different answers and the difference
 * is actionable: the first means this machine's PipeWire is too old to publish
 * org.pipewire.Telephony, the second only means nothing is paired yet.
 */
function handsfreeText(bt) {
  if (!bt || bt.available !== true) return "unsupported"
  if (bt.connected !== true) return "not connected"
  var name = bt.device || "connected"
  // "active" is the transport state that means audio is actually on this
  // machine's speakers rather than the profile merely being up.
  if (bt.audio === "active") return name + " · audio here"
  return name
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

/** The headline on the live-call card. */
function callHeadline(call) {
  if (!call) return ""
  var who = call.name || call.from || "unknown number"
  if (call.state === "incoming" || call.state === "waiting" || call.state === "ringing") return "󰏲  " + who
  if (call.state === "dialing" || call.state === "alerting") return "󰏳  " + who
  return "󰂰  " + who
}

/** The dim second line: what the call is doing, and where the sound goes. */
function callDetail(call, bt) {
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
  if (state === "held") return "on hold"
  if (state === "dialing" || state === "alerting") return "dialling"
  if (state === "active") {
    var here = call.audio === "active" || (bt && bt.audio === "active")
    return here ? "in progress · audio on this machine" : "in progress · audio on the handset"
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
function agents(status) {
  var value = isObject(status) && isObject(status.agents) ? status.agents : {}
  return {
    enabled: value.enabled === true,
    hooks: value.hooks === true,
    adapters: Array.isArray(value.adapters) ? value.adapters : [],
    running: num(value.running, 0),
    waiting: num(value.waiting, 0),
    sessions: Array.isArray(value.sessions) ? value.sessions : []
  }
}

/** The one line under the header: what reading agents is doing right now. */
function agentsText(value, running) {
  if (!value.enabled) return "off · the phone sees nothing"
  if (!running) return "on · nothing is watching while the daemon is stopped"
  if (value.waiting > 0) return value.waiting === 1 ? "one agent is waiting for you" : value.waiting + " agents are waiting for you"
  if (value.running > 0) return value.running === 1 ? "one session · reading only" : value.running + " sessions · reading only"
  if (value.adapters.length === 0) return "on · no coding agent is installed here"
  return "on · nothing running"
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
  if (session.state === "waiting") {
    var prompt = String(session.prompt || "").replace(/\s+/g, " ").trim()
    return prompt !== "" ? prompt : "waiting for an answer"
  }
  // Right-aligned and elided from the right, so the order is what survives
  // being cut: what it is doing, when it last did it, and only then that the
  // session was a guess — a scan matched a transcript to a directory rather
  // than a hook naming it. The agent's own name is not here at all; one line
  // under a header that says CODING AGENTS does not need to repeat it.
  var parts = [session.state === "working" ? "working" : "idle", since(session.lastActivity, now)]
  if (session.via === "scan") parts.push("scanned")
  return parts.join(" · ")
}

/** One glyph per session: the alert is the whole point of the card. */
function agentGlyph(session) {
  return isObject(session) && session.state === "waiting" ? "󰀦" : "󰆍"
}
