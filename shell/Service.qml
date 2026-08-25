import QtQuick
import Quickshell
import Quickshell.Io
import "Model.js" as Model

// The data half of the desktop client.
//
// The daemon publishes one file — ~/.local/state/omarchy-connect/status.json —
// and rewrites it the moment anything changes: a phone connects, a file moves,
// a pairing code is minted. Watching that file means the panel reacts as fast
// as the daemon does without a single poll, and still has something true to
// draw while the daemon is stopped.
//
// The one thing a file cannot report is its own writer dying: a `kill -9`
// leaves the last snapshot behind claiming to be live. So while the panel is
// open, `omarchy-connect status --json` runs on a slow timer; it probes
// loopback, has the final word on `running`, and heals the stale file.
Item {
  id: root
  visible: false

  property var settings: ({})
  property bool watching: false

  property var status: null
  property bool loaded: false
  property string lastError: ""
  property string actionStatus: ""

  readonly property string stateHome: {
    var xdg = Quickshell.env("XDG_STATE_HOME")
    return (xdg && xdg.length > 0) ? xdg : Quickshell.env("HOME") + "/.local/state"
  }
  readonly property string statusPath: stateHome + "/omarchy-connect/status.json"

  readonly property bool installed: loaded
  readonly property bool running: !!status && status.running === true
  readonly property var devices: (status && Array.isArray(status.devices)) ? status.devices : []
  readonly property var online: Model.onlineDevices(status)
  readonly property var primary: online.length > 0 ? online[0] : (devices.length > 0 ? devices[0] : null)
  readonly property var counters: (status && status.counters) ? status.counters : ({ filesIn: 0, filesOut: 0, notifications: 0 })
  readonly property var transfers: (status && Array.isArray(status.transfers)) ? status.transfers : []
  readonly property var firewall: (status && status.firewall) ? status.firewall : ({ blocked: false })
  readonly property var phone: (status && status.phone)
    ? status.phone
    : ({ messages: 0, calls: 0, missed: 0, sent: 0, notifications: 0, recent: [] })
  readonly property var phoneRecent: (phone && Array.isArray(phone.recent)) ? phone.recent : []
  // The Bluetooth hands-free link. This is the half that carries the audio, so
  // it is also the half the panel offers Answer and Decline on.
  readonly property var bluetooth: (phone && phone.bluetooth)
    ? phone.bluetooth
    : ({ available: false, connected: false, device: null, audio: null, call: null })
  // The low-energy half of the same phone. An iPhone tells a hands-free unit
  // about a call and tells a *notification consumer* about everything else, so
  // these two rows describe one handset through two different windows.
  readonly property var ios: (phone && phone.ios)
    ? phone.ios
    : ({ available: false, connected: false, subscribed: false, device: null, paired: false, pairing: null })
  readonly property var liveCall: (bluetooth && bluetooth.call) ? bluetooth.call : null
  readonly property bool ringing: !!liveCall && (liveCall.state === "incoming" || liveCall.state === "waiting")
  // Whether the daemon is serving https + wss. The panel only reports it —
  // switching TLS on is `omarchy-connect tls enable`, which needs a restart.
  readonly property bool tls: !!status && !!status.tls && status.tls.enabled === true
  readonly property bool serviceInstalled: !!status && !!status.service && status.service.installed === true
  readonly property bool serviceEnabled: !!status && !!status.service && status.service.enabled === true
  readonly property string address: {
    if (!status) return ""
    return status.host ? status.host + ":" + status.port : "port " + (status ? status.port : "")
  }

  readonly property bool busy: probe.running || action.running
  readonly property int refreshIntervalSec: {
    var value = parseInt(String(setting("refreshIntervalSec", 15)), 10)
    if (!isFinite(value)) value = 15
    return Math.max(5, Math.min(300, value))
  }

  signal changed()

  function setting(name, fallback) {
    var value = settings ? settings[name] : undefined
    return value === undefined || value === null ? fallback : value
  }

  function apply(content) {
    try {
      var parsed = JSON.parse(String(content || ""))
      if (parsed && typeof parsed === "object") {
        root.status = parsed
        root.loaded = true
        root.lastError = ""
        root.changed()
        return
      }
    } catch (e) {
      console.warn("omarchy-connect", "ignoring unreadable status file", e)
    }
    root.lastError = "The status file could not be read."
  }

  FileView {
    path: root.statusPath
    watchChanges: true
    printErrors: false
    onFileChanged: reload()
    onLoaded: root.apply(text())
    onLoadFailed: {
      root.loaded = false
      root.status = null
    }
  }

  /* ── liveness ─────────────────────────────────────────────────────── */

  function refresh() {
    if (probe.running) return
    probe.command = Model.command(root.status, ["status", "--json"])
    probe.running = true
  }

  Process {
    id: probe
    running: false
    command: []
    stdout: StdioCollector { id: probeOut; waitForEnd: true }
    stderr: StdioCollector { id: probeErr; waitForEnd: true }
    onExited: function (exitCode) {
      if (exitCode === 0) root.apply(String(probeOut.text || ""))
      else root.lastError = elide(String(probeErr.text || "") || "omarchy-connect is not installed")
    }
  }

  Timer {
    interval: root.refreshIntervalSec * 1000
    repeat: true
    running: root.watching
    triggeredOnStart: true
    onTriggered: root.refresh()
  }

  /* ── actions ──────────────────────────────────────────────────────── */

  function elide(text) {
    var value = String(text || "").replace(/\s+/g, " ").trim()
    return value.length > 140 ? value.substring(0, 137) + "…" : value
  }

  function note(text) {
    root.actionStatus = text
    noteTimer.restart()
  }

  Timer {
    id: noteTimer
    interval: 2600
    onTriggered: root.actionStatus = ""
  }

  /** Fire-and-forget: the status file reports the outcome on its own. */
  function detach(argv) {
    Quickshell.execDetached(argv)
  }

  /** Run and wait, for the two commands whose failure is worth a message. */
  function invoke(argv, message) {
    if (action.running) return
    root.actionStatus = message || ""
    action.command = argv
    action.running = true
  }

  /* ── calls ────────────────────────────────────────────────────────── */

  /**
   * Answering is the one action worth waiting on: the daemon may have to go out
   * over D-Bus to the hands-free profile, and if it refuses the user needs to
   * be told rather than left watching a status file that never changes.
   */
  function answerCall() {
    invoke(Model.command(root.status, ["call", "answer"]), "Answering…")
  }

  function rejectCall() {
    invoke(Model.command(root.status, ["call", "reject"]), "Declining…")
  }

  function hangUp() {
    invoke(Model.command(root.status, ["call", "hangup"]), "Hanging up…")
  }

  Process {
    id: action
    running: false
    command: []
    stdout: StdioCollector { id: actionOut; waitForEnd: true }
    stderr: StdioCollector { id: actionErr; waitForEnd: true }
    onExited: function (exitCode) {
      if (exitCode !== 0) {
        root.lastError = root.elide(String(actionErr.text || actionOut.text || "The command failed."))
        root.actionStatus = ""
      } else {
        root.lastError = ""
        root.actionStatus = ""
      }
      root.refresh()
    }
  }

  /**
   * Pairing is a QR code and a wait, so it belongs in a terminal rather than
   * in a popup that closes the moment you look away from it. Omarchy's own
   * presentation wrapper gives it the theme and the floating window.
   */
  function pair() {
    detach(["omarchy-launch-floating-terminal-with-presentation",
            Model.shellQuote(Model.command(root.status, ["pair", "--wait"]))])
    note("Pairing window opened")
  }

  function sendFile() {
    detach(["omarchy-launch-floating-terminal-with-presentation",
            Model.shellQuote(Model.command(root.status, ["send", "--pick"]))])
    note("Pick a file to send")
  }

  function openInbox() {
    var inbox = (root.status && root.status.inbox) ? String(root.status.inbox) : ""
    if (inbox === "") return
    detach(["uwsm-app", "--", "nautilus", inbox])
    note("Opened the inbox")
  }

  function unpair(device) {
    if (!device || !device.id) return
    invoke(Model.command(root.status, ["unpair", device.id]), "Unpairing " + device.name + "…")
  }

  function startDaemon() {
    if (!root.serviceInstalled) return installService()
    invoke(["systemctl", "--user", "start", "omarchy-connect.service"], "Starting…")
  }

  /** Autostart is a separate decision from "is it running right now". */
  function toggleAutostart() {
    if (!root.serviceInstalled) return installService()
    if (root.serviceEnabled) invoke(["systemctl", "--user", "disable", "omarchy-connect.service"], "Turning autostart off…")
    else invoke(["systemctl", "--user", "enable", "--now", "omarchy-connect.service"], "Turning autostart on…")
  }

  function stopDaemon() {
    invoke(["systemctl", "--user", "stop", "omarchy-connect.service"], "Stopping…")
  }

  function toggleDaemon() {
    if (root.running) stopDaemon()
    else startDaemon()
  }

  /**
   * Writing the unit and enabling it in one go — the daemon writes the file,
   * systemd has to be told it exists, and only then can it be started.
   */
  function installService() {
    var cli = Model.shellQuote(Model.command(root.status, ["install-service"]))
    invoke(["bash", "-lc",
            cli + " && systemctl --user daemon-reload && systemctl --user enable --now omarchy-connect.service"],
           "Installing the service…")
  }

  function copyText(text) {
    if (!text) return
    detach(["bash", "-lc", "printf %s " + Model.shellQuote([String(text)]) + " | wl-copy"])
    note("Copied")
  }
}
