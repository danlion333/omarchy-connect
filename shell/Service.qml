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
  // A desktop pairs one phone at a time, so `devices` is a list of nothing or
  // of one. `device` is that one; `primary` stays as the name the rest of the
  // panel already reads it by.
  readonly property var device: devices.length > 0 ? devices[0] : null
  readonly property bool paired: devices.length > 0
  readonly property var primary: online.length > 0 ? online[0] : device
  readonly property var counters: (status && status.counters) ? status.counters : ({ filesIn: 0, filesOut: 0, notifications: 0 })
  readonly property var transfers: (status && Array.isArray(status.transfers)) ? status.transfers : []
  readonly property var firewall: (status && status.firewall) ? status.firewall : ({ blocked: false })
  readonly property var phone: (status && status.phone)
    ? status.phone
    : ({ messages: 0, calls: 0, missed: 0, sent: 0, notifications: 0, recent: [], call: null })
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
  // The call the buttons act on. The daemon has already picked which road saw
  // it — hands-free when the profile published a call object, the mirrored
  // event otherwise — so the panel takes its word rather than looking at
  // Bluetooth alone. `bluetooth.call` stays as the fallback for a daemon old
  // enough not to publish the merged field.
  readonly property var liveCall: (phone && phone.call)
    ? phone.call
    : ((bluetooth && bluetooth.call) ? bluetooth.call : null)
  // Two vocabularies meet here: the hands-free profile says "incoming", the
  // mirrored events say "ringing", and both mean a phone nobody has picked up.
  readonly property bool ringing: !!liveCall
    && (liveCall.state === "incoming" || liveCall.state === "waiting" || liveCall.state === "ringing")
  // The coding agents this desktop can read and answer, and whether it may.
  // Unlike TLS this one *is* switchable from here: the daemon applies it
  // without a restart, so the link survives the click.
  readonly property var agents: Model.agents(status)
  readonly property bool agentsEnabled: agents.enabled
  readonly property bool agentHooks: agents.hooks
  readonly property var agentSessions: agents.sessions
  readonly property int agentsWaiting: agents.waiting
  // Worth a card at all: either an agent is installed here, or reading is on
  // and the switch has to be reachable to be turned back off.
  readonly property bool agentsAvailable: agents.enabled || agents.adapters.length > 0

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

  /**
   * One line of CLI output, fit for a panel.
   *
   * The CLI writes for a terminal: colour escapes, a timestamp and a three-
   * character tag in front of every line. None of that means anything inside a
   * QML Text — the escapes come out as mojibake and the stamp says nothing the
   * panel does not already know — so both are stripped and what is left is the
   * sentence.
   */
  function elide(text) {
    var value = String(text || "")
      .replace(/\x1b\[[0-9;]*m/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/^\d{2}:\d{2}:\d{2}\s+(?:ok|err|!!|dbg|inf)\s+/, "")
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
        // A command can succeed and still have something to say — a daemon too
        // old to take a switch live is the case this was written for. Saying it
        // dimly beats a panel that looks like nothing happened.
        var warning = root.elide(String(actionErr.text || ""))
        if (warning !== "") root.note(warning)
      }
      root.refresh()
    }
  }

  /**
   * Pairing is a QR code and a wait, so it belongs in a terminal rather than
   * in a popup that closes the moment you look away from it.
   *
   * Omarchy's presentation wrapper is how the panel opens the others, but it
   * prints the logo first, and a dozen lines of banner in a window this size
   * pushes the QR off the top of the screen — the one thing here that has to
   * be readable whole. So the same window is opened without the banner, and
   * kept from vanishing at the end the way the wrapper does. 130 is ctrl-c,
   * which is the user closing the window themselves.
   */
  function pair() {
    // The daemon would refuse anyway; saying so here spares the user a
    // terminal window that opens only to print a rejection.
    if (root.paired) {
      note("Unpair " + root.device.name + " first — one phone at a time")
      return
    }
    var cmd = Model.shellQuote(Model.command(root.status, ["pair", "--wait"]))
    detach(["setsid", "uwsm-app", "--", "xdg-terminal-exec",
            "--app-id=org.omarchy.terminal", "--title=Omarchy", "-e", "bash", "-c",
            "source omarchy-restart-gum; " + cmd + "; (( $? != 130 )) && omarchy-show-done"])
    note("Pairing window opened")
  }

  /**
   * No terminal, unlike pairing: the picker is the GTK file dialog now, and it
   * draws its own window. What the CLI would have printed into a terminal
   * arrives as a notification instead.
   */
  function sendFile() {
    detach(Model.command(root.status, ["send", "--pick"]))
    note("Pick a file to send")
  }

  function openInbox() {
    var inbox = (root.status && root.status.inbox) ? String(root.status.inbox) : ""
    if (inbox === "") return
    detach(["uwsm-app", "--", "nautilus", inbox])
    note("Opened the inbox")
  }

  function unpair(target) {
    var phone = target || root.device
    if (!phone || !phone.id) return
    invoke(Model.command(root.status, ["unpair", phone.id]), "Unpairing " + phone.name + "…")
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

  /* ── coding agents ────────────────────────────────────────────────── */

  /**
   * The one switch on this panel that widens what the phone can see, so it is
   * the one that waits for its command rather than firing and forgetting: the
   * CLI writes the config and tells the running daemon in the same call, and
   * anything that goes wrong there is worth a line on screen.
   */
  function enableAgents() {
    invoke(Model.command(root.status, ["agent", "enable"]), "Letting the phone read and answer agents…")
  }

  function disableAgents() {
    invoke(Model.command(root.status, ["agent", "disable"]), "Turning agent control off…")
  }

  /**
   * Hooks are what tell the desktop an agent has stopped and is waiting. They
   * are written into `~/.claude/settings.json`, which is the user's file and
   * nothing the daemon touches on its own — so this is a button, never
   * something the panel does because reading was turned on.
   */
  function installAgentHooks() {
    invoke(Model.command(root.status, ["agent", "install-hooks"]), "Installing the hooks…")
  }

  function copyText(text) {
    if (!text) return
    detach(["bash", "-lc", "printf %s " + Model.shellQuote([String(text)]) + " | wl-copy"])
    note("Copied")
  }
}
