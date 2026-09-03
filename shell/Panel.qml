import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Ui
import "Model.js" as Model

// Omarchy Connect, as a bar widget and a panel.
//
// The daemon on this machine knows a great deal about the link, and an earlier
// version of this panel drew all of it at once. Most of it is not something you
// open a panel to find out. So the top of the panel answers the only question
// that is always live — is the phone there, and what is it doing — anything
// that has just happened gets a card of its own, and the readouts and the two
// switches wait behind a row you can open when you actually want them.

Panel {
  id: root
  moduleName: "omarchy-connect.phone"
  ipcTarget: "omarchy-connect"
  // manageIpc: false so this panel owns the single IpcHandler the target
  // permits and can add refresh/pair to the open/close verbs.
  manageIpc: false

  property string focusSection: "header"
  property int actionIndex: 0
  property bool cursorActive: false
  property real now: Date.now()
  // Both start shut on every open. A panel that remembered being expanded
  // would be back to drawing everything at once within a week.
  property bool detailsOpen: false
  property bool settingsOpen: false
  // Letting a phone read the coding agents on this desktop is the widest door
  // this panel can open, so the switch asks first. Nothing else here does.
  property bool agentConfirmOpen: false

  // Answering a mirrored message happens in the row that carried it: the
  // number of the message being answered, and the half-typed answer itself.
  // Both live up here rather than in the delegate because the list is rebuilt
  // from the status file whenever anything about the phone changes, and a
  // draft that vanished because the battery level ticked over would be a
  // panel nobody types into twice. `replyFocused` is what tells the key
  // catcher to keep its hands off the letters while somebody is using them.
  // The row the field is open on, keyed by the entry rather than by the
  // number: two messages from the same person are two rows, and keying on the
  // number would open a field on both of them and point them at one draft.
  property string replyId: ""
  property string replyTo: ""
  property string replyDraft: ""
  property bool replyFocused: false
  property int messageIndex: 0

  readonly property color foreground: bar ? bar.foreground : Color.foreground
  readonly property color urgent: bar ? bar.urgent : Color.urgent
  readonly property color dim: Qt.darker(foreground, 1.55)
  readonly property string fontFamily: bar ? bar.fontFamily : Style.font.family
  readonly property color accent: Color.accent

  // Every glyph on this panel is drawn into a cell of this width rather than
  // taking whatever width its own outline happens to want. Nerd Fonts draws a
  // phone, a tray and a robot at three different widths, and a list whose
  // names start on three different columns is a list you read one row at a
  // time. One number, and the whole panel lines up.
  readonly property int iconCell: Math.round(Style.font.body * 1.5)

  readonly property bool linked: bridge.online.length > 0
  readonly property bool pairing: Model.pairingActive(bridge.status, root.now)
  readonly property var phone: bridge.primary
  readonly property bool paired: bridge.paired

  // The conversation this desktop is in, if it is in one. The bar says so in
  // its tooltip and nowhere else: the count belongs on the notification card,
  // which is already on screen for the length of the call and does not cost
  // the bar a widening, shifting run of digits every second. One glyph is what
  // this widget is, in every state it has.
  readonly property var call: bridge.liveCall
  readonly property bool talking: !!call && call.state === "active"

  // The bar icon carries three states and nothing else: linked, running but
  // alone, and down. Pairing borrows the bar's active color, because a code
  // on screen with a three-minute fuse is the one thing worth interrupting for.
  readonly property color barIconColor: {
    if (!bridge.running) return Qt.darker(barForeground, 2.1)
    if (!linked) return Qt.darker(barForeground, 1.55)
    return barForeground
  }

  // One line under the phone's name, and the only readout the panel shows
  // without being asked. It carries what the four rows of a stats grid used to
  // say between them: whether the channel is encrypted, how long it has been
  // up, and how much battery is behind it.
  //
  // Built once as glyph-and-words pairs, because it is read twice: the hero
  // draws the glyphs, and the IPC verb answers with the words alone. A script
  // asking this panel what the link is doing wants a sentence, not four
  // private-use codepoints it has no font for.
  readonly property var statusParts: {
    if (!bridge.loaded) return [{ glyph: "󰋽", text: "Not installed" }]
    if (!bridge.running) return [{ glyph: "󰚦", text: "Daemon stopped" }]
    if (pairing) return [{ glyph: "󰐲", text: "Waiting for a phone" }]
    if (linked) {
      var parts = [phone && phone.secure === false
        ? { glyph: "󱙱", text: "Unencrypted" }
        : { glyph: "󰌾", text: "Encrypted" }]
      var up = Model.uptime(phone.since, root.now)
      if (up !== "") parts.push({ glyph: "󰅐", text: up })
      // The battery glyph tracks the level and grows a bolt while it charges,
      // so the shape of it says the number before the number is read.
      if (phone.battery) parts.push({ glyph: Model.batteryGlyph(phone.battery), text: Model.batteryText(phone.battery) })
      // Which road it came in on, and only when that is not the ordinary one
      // — every other line here earns its place by being surprising.
      var road = Model.linkText(phone)
      if (road !== "") parts.push({ glyph: "󰖟", text: road })
      return parts
    }
    if (!paired) return [{ glyph: "󰥍", text: "No phone paired" }]
    return [{ glyph: "󰌺", text: "Offline · last seen " + Model.since(phone ? phone.lastSeen : 0, root.now) }]
  }

  readonly property string statusLine: statusParts.map(function (p) { return p.text }).join(" · ")
  readonly property string heroMeta: statusParts.map(function (p) { return p.glyph + " " + p.text }).join("  ·  ")

  // Every row behind *Details* is gated on having something to say. A readout
  // whose whole content is "no" is not a readout: an Android phone on the LAN
  // has no use for a line telling it no iPhone is paired, and a link that has
  // moved nothing has no use for two zeroes.
  readonly property bool showTransfers: (bridge.counters.filesIn || 0) > 0 || (bridge.counters.filesOut || 0) > 0
  readonly property bool showNotified: (bridge.counters.notifications || 0) > 0 || (bridge.phone.missed || 0) > 0
  // The hands-free link stands in *Details* from the moment the desktop knows
  // which handset is its own — not, as it used to, only once the link is
  // carrying something or has failed at it. Under the `ring` policy the link
  // is down almost all of the time, and that was the one state the panel had
  // nothing at all to say about.
  // A desktop paired over the LAN with no bond under it is the one that most
  // needs this row, so `paired` goes in: without it the row waits for a
  // failure before it appears, which is the wrong end of the problem.
  readonly property bool showHandsfree: Model.handsfreeShown(bridge.bluetooth, root.paired)
  // "", "bond", "connect" or "disconnect" — empty while a page or a pairing
  // window is in flight, so the button goes away rather than offering a race.
  readonly property string handsfreeAction: Model.handsfreeAction(bridge.bluetooth, root.paired)
  // Bonded-but-idle stays, because that one *is* fixable by re-pairing.
  readonly property bool showIos: !!bridge.ios && (bridge.ios.subscribed === true
    || bridge.ios.paired === true || !!bridge.ios.pairing)
  // The same rule as the switch below it: a desktop that has never been put
  // on a tunnel has nothing to report and gets no row.
  readonly property bool showRemote: bridge.remoteAvailable

  /* ── actions ───────────────────────────────────────────────────────── */

  // Three, and all three are things you came here to do. Autostart used to sit
  // in this row and never belonged: it is a preference, not an action, and it
  // now lives with the other switch.
  readonly property var actions: buildActions()

  function buildActions() {
    // A desktop holds one phone, so this slot is either the way in or the way
    // out — never both. Offering Pair beside a phone that is already paired
    // would be a button whose only outcome is a refusal.
    var list = [root.paired
      ? { key: "unpair", label: "Unpair", icon: "󰥍",
          tooltip: "Forget " + (bridge.device ? bridge.device.name : "this phone") + " — a desktop pairs one phone at a time" }
      // A QR code is what the button actually puts on screen, so it is what the
      // button wears.
      : { key: "pair", label: "Pair", icon: "󰐲", tooltip: "Show a pairing QR code" }]
    if (bridge.running) list.push({ key: "send", label: "Send", icon: "󱀹", tooltip: "Pick a file to send to the phone" })
    // Only with a phone on the socket, and it changes its mind mid-search:
    // a button still offering to ring a phone that is already ringing is one
    // whose only outcome is a second minute of noise.
    if (bridge.canLocate) {
      list.push(bridge.phoneRinging
        ? { key: "hush", label: "Hush", icon: "󰂛", tooltip: "Stop the phone ringing — it stops on its own after a minute" }
        : { key: "locate", label: "Ring", icon: "󰂚",
            tooltip: "Ring the phone until somebody finds it — loud even on silent" })
    }
    list.push({ key: "inbox", label: "Inbox", icon: "󰷏", tooltip: "Open the folder phones drop files into" })
    return list
  }

  /**
   * The agent switch. Off is immediate — closing a door never needs a second
   * thought — and on goes through the confirmation, because the click that
   * turns it on is the click that hands a phone every line of source, every
   * command and every command's output that an agent has seen.
   */
  function requestAgents(on) {
    if (!on) {
      agentConfirmOpen = false
      bridge.disableAgents()
      return
    }
    agentConfirm.selectedIndex = 0
    agentConfirmOpen = true
  }

  // No confirmation behind this one. Letting a phone read the agents on this
  // desktop is handing it a shell; letting it reach the desktop from a
  // different room is not a decision of that size, and the telephony it would
  // otherwise carry is switched off on that link anyway.
  function requestRemote(on) {
    if (on) bridge.enableRemote()
    else bridge.disableRemote()
  }

  function runAction(key) {
    if (key === "pair") bridge.pair()
    else if (key === "unpair") bridge.unpair(bridge.device)
    else if (key === "send") bridge.sendFile()
    else if (key === "inbox") bridge.openInbox()
    else if (key === "locate") bridge.ringPhone()
    else if (key === "hush") bridge.hushPhone()
  }

  /* ── cursor ────────────────────────────────────────────────────────── */

  // Everything the keyboard can land on, in the order it is drawn. The two
  // expanders are always here; what they hold only joins the list once they
  // are open, which is the same rule the eye follows.
  // The rows a reply field can open on, in the order the list draws them.
  // Everything the keyboard does with this section is an index into this,
  // rather than into the list itself, so `l` never lands the cursor on a
  // notification that has nothing to answer.
  readonly property var answerable: bridge.phoneRecent.slice(0, 4).filter(function (entry) {
    return Model.phoneReplyTo(entry) !== ""
  })

  // The row the keyboard cursor is on, named the same way the field names
  // the row it is open on. Comparing entries themselves would compare two
  // wrappers around one object and quietly never match.
  readonly property string cursorEntryId: {
    var entry = answerable[messageIndex]
    if (!entry) return ""
    return String(entry.id || Model.phoneReplyTo(entry))
  }

  readonly property var sections: {
    var list = ["header", "actions"]
    if (answerable.length > 0) list.push("messages")
    list.push("details", "settings")
    if (settingsOpen) {
      if (bridge.agentsAvailable) list.push("agents")
      if (bridge.remoteAvailable) list.push("remote")
      list.push("autostart")
    }
    return list
  }

  function ensureCursor() {
    if (actionIndex >= actions.length) actionIndex = Math.max(0, actions.length - 1)
    if (actionIndex < 0) actionIndex = 0
    if (messageIndex >= answerable.length) messageIndex = Math.max(0, answerable.length - 1)
    if (messageIndex < 0) messageIndex = 0
    if (sections.indexOf(focusSection) < 0) focusSection = "actions"
  }

  function moveCursor(dx, dy) {
    cursorActive = true
    ensureCursor()

    if (dx !== 0) {
      if (focusSection === "actions")
        actionIndex = Math.max(0, Math.min(actions.length - 1, actionIndex + dx))
      else if (focusSection === "messages")
        messageIndex = Math.max(0, Math.min(answerable.length - 1, messageIndex + dx))
      return
    }
    if (dy === 0) return

    var index = sections.indexOf(focusSection) + dy
    if (index < 0 || index >= sections.length) return
    focusSection = sections[index]
    if (focusSection === "header" && panelFlick) panelFlick.contentY = 0
    else if (focusSection !== "actions" && focusSection !== "messages") scrollToBottom()
  }

  function activateCursor() {
    ensureCursor()
    if (focusSection === "header") bridge.toggleDaemon()
    else if (focusSection === "actions") runAction(actions[actionIndex].key)
    // Enter on a message opens the field under it rather than sending
    // anything; the second Enter, with the field holding the keyboard, is the
    // one that sends.
    else if (focusSection === "messages") toggleReply(answerable[messageIndex])
    else if (focusSection === "details") toggleDetails()
    else if (focusSection === "settings") toggleSettings()
    // Enter on the agent switch opens the question rather than answering it,
    // which is why the cursor is allowed here at all.
    else if (focusSection === "agents") requestAgents(!bridge.agentsEnabled)
    else if (focusSection === "remote") requestRemote(!bridge.remoteEnabled)
    else if (focusSection === "autostart") bridge.toggleAutostart()
  }

  function toggleDetails() {
    detailsOpen = !detailsOpen
    if (detailsOpen) scrollToBottom()
  }

  function toggleSettings() {
    settingsOpen = !settingsOpen
    // Folding the settings away takes the two switches inside them out of the
    // cursor's reach, so the cursor has to come out with them.
    ensureCursor()
    if (settingsOpen) scrollToBottom()
  }

  // The two expanders are the last things in the column, so anything they grow
  // appears at the bottom and that is where the view has to be.
  function scrollToBottom() {
    if (!panelFlick) return
    Qt.callLater(function () {
      if (!panelFlick) return
      panelFlick.contentY = Math.max(0, panelFlick.contentHeight - panelFlick.height)
    })
  }

  // A desktop pairs one phone, so there is nothing to select: `x` means that
  // phone or it means nothing.
  function deleteSelected() {
    if (bridge.paired) bridge.unpair(bridge.device)
  }

  /* ── answering a message ───────────────────────────────────────────── */

  /**
   * Open the field under a message, or shut the one that is already open.
   *
   * One at a time, and a new one starts empty: two drafts on screen at once
   * would be two Enters that mean different things, and carrying the text
   * from one conversation into the next is how a message ends up with the
   * wrong person.
   */
  function toggleReply(entry) {
    var number = Model.phoneReplyTo(entry)
    if (number === "") return
    var id = String((entry && entry.id) || number)
    if (replyId === id) { cancelReply(); return }
    replyId = id
    replyTo = number
    replyDraft = ""
  }

  function cancelReply() {
    replyId = ""
    replyId = ""
    replyTo = ""
    replyDraft = ""
    replyFocused = false
    if (opened) Qt.callLater(function () { keyCatcher.forceActiveFocus() })
  }

  /**
   * Enter. The field shuts on the way out rather than on the way back: the
   * daemon holds an SMS open until the handset confirms it, which is seconds
   * with a phone on a slow network, and a field that sat there full and
   * unresponsive would read as a keystroke that did nothing. What the send
   * actually did shows up where every other action's outcome does — the
   * status line under the header, and the error line when it failed.
   */
  function sendReply() {
    var number = replyTo
    var body = replyDraft
    cancelReply()
    bridge.sendSms(number, body)
  }

  function setCursor(section) {
    cursorActive = true
    focusSection = section
    if (section === "header" && panelFlick) panelFlick.contentY = 0
  }

  function setActionCursor(index) {
    cursorActive = true
    focusSection = "actions"
    actionIndex = index
  }

  /* ── lifecycle ─────────────────────────────────────────────────────── */

  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  // A machine that has never paired a phone can keep its bar clean.
  visible: !(root.setting("hideWhenUnpaired", false) === true && bridge.loaded && !paired && !bridge.running)

  onOpenedChanged: {
    agentConfirmOpen = false
    replyTo = ""
    replyDraft = ""
    replyFocused = false
    detailsOpen = false
    settingsOpen = false
    if (!opened) return
    cursorActive = false
    focusSection = "header"
    if (panelFlick) panelFlick.contentY = 0
    bridge.refresh()
    Qt.callLater(function () { keyCatcher.forceActiveFocus() })
  }

  Service {
    id: bridge
    settings: root.settings
    watching: root.opened
  }

  Connections {
    target: bridge
    function onChanged() { root.ensureCursor() }
  }

  // Relative times ("3m ago", "2h 14m") and the pairing countdown are only
  // honest if something moves them along. One second while open, nothing at all
  // while closed.
  Timer {
    interval: 1000
    repeat: true
    running: root.opened
    triggeredOnStart: true
    onTriggered: root.now = Date.now()
  }

  IpcHandler {
    target: root.ipcTarget
    function open(): void { root.open() }
    function close(): void { root.close() }
    function show(): void { root.open() }
    function hide(): void { root.close() }
    function toggle(): void { root.toggle() }
    function refresh(): string { bridge.refresh(); return "ok" }
    function pair(): string { bridge.pair(); return "ok" }
    function status(): string { return root.statusLine }
  }

  /* ── bar ───────────────────────────────────────────────────────────── */

  BarIconButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    text: Model.deviceGlyph(root.phone ? root.phone.platform : "")
    foreground: bridge.ringing ? root.urgent : root.barIconColor
    // A file held over the icon lights it the way a live pairing code does.
    // The icon has one way of saying "this is about to do something" and
    // borrowing it costs nothing; a drag has no tooltip to read instead,
    // because the pointer is holding a file rather than hovering.
    active: root.pairing || fileDrop.containsDrag
    tooltipText: {
      if (!bridge.loaded) return "Omarchy Connect is not set up"
      if (!bridge.running) return "Omarchy Connect is stopped"
      if (bridge.ringing) return Model.callWho(root.call) + " is calling"
      if (root.talking) return "On call with " + Model.callWho(root.call)
      if (root.pairing) return "Waiting for a phone to pair"
      if (root.linked) return root.phone.name + " is connected — drop a file here to send it"
      return root.paired ? root.phone.name + " is offline" : "No phone paired yet"
    }
    onPressed: function (buttonCode) {
      if (buttonCode === Qt.RightButton) bridge.pair()
      else if (buttonCode === Qt.MiddleButton) bridge.refresh()
      else root.toggle()
    }

    /**
     * Drag a file onto the icon and it goes to the phone.
     *
     * `text/uri-list` is what every file manager on this desktop puts on a
     * drag, and it is the only thing accepted here: with the key set, a drag
     * carrying anything else never enters, so the icon does not light up for
     * something it would refuse anyway. Whether there is a phone to send to is
     * a different question and deliberately not asked until the drop — a drag
     * that silently declines to land tells the user nothing, and the point of
     * the refusal is that it can be read.
     */
    DropArea {
      id: fileDrop
      anchors.fill: parent
      keys: ["text/uri-list"]
      onDropped: function (drop) {
        bridge.sendPaths(drop.hasUrls ? drop.urls : [])
        drop.acceptProposedAction()
      }
    }
  }

  /* ── panel ─────────────────────────────────────────────────────────── */

  KeyboardPanel {
    id: panel
    anchorItem: button
    owner: root
    bar: root.bar
    open: root.opened
    focusTarget: keyCatcher
    contentWidth: panel.fittedContentWidth(Style.space(400))
    contentHeight: panel.fittedContentHeight(column.implicitHeight, Style.space(600))

    PanelKeyCatcher {
      id: keyCatcher
      anchors.fill: parent
      // While somebody is typing an answer, every key belongs to the field.
      // `j` and `k` are a cursor here and two letters there, and the panel's
      // single-key actions would otherwise turn a reply into a pairing.
      blocked: root.replyFocused
      // A question on screen owns the keyboard until it is answered: the
      // cursor, the letter keys and Esc all mean something about the question
      // rather than about the panel behind it.
      onMoveRequested: function (dx, dy) {
        if (root.agentConfirmOpen) {
          if (dx !== 0) agentConfirm.selectedIndex = agentConfirm.selectedIndex === 0 ? 1 : 0
          return
        }
        if (!root.cursorActive) { root.cursorActive = true; return }
        root.moveCursor(dx, dy)
      }
      onActivateRequested: {
        if (root.agentConfirmOpen) {
          if (agentConfirm.selectedIndex === 0) root.agentConfirmOpen = false
          else { root.agentConfirmOpen = false; bridge.enableAgents() }
          return
        }
        if (root.cursorActive) root.activateCursor()
      }
      onCloseRequested: {
        if (root.agentConfirmOpen) root.agentConfirmOpen = false
        else root.close()
      }
      onDeleteRequested: if (!root.agentConfirmOpen) root.deleteSelected()
      onTabRequested: function (direction) { root.switchPanel(direction) }
      onTextKey: function (t) {
        if (root.agentConfirmOpen) return
        var key = String(t).toLowerCase()
        // Still `p` for pair. With a phone already paired the service answers
        // with why rather than doing anything — dropping a pairing is not
        // something a single unmodified keystroke should be able to do.
        if (key === "p") bridge.pair()
        else if (key === "s") bridge.sendFile()
        else if (key === "i") bridge.openInbox()
        else if (key === "r") bridge.refresh()
        // The two expanders answer to the letters they are named after, so the
        // readouts are one keystroke away from a keyboard user rather than
        // permanently on screen for everybody.
        else if (key === "e") root.toggleDetails()
        else if (key === "c") root.toggleSettings()
        // Only while there is something to act on — a stray `a` on an idle
        // panel should do nothing rather than dial into the void.
        else if (key === "a" && bridge.ringing) bridge.answerCall()
        else if (key === "d" && bridge.liveCall) {
          if (bridge.ringing) bridge.rejectCall()
          else bridge.hangUp()
        }
        // `b` for the Bluetooth link, under the same rule: with no handset
        // matched, or a page already in flight, it does nothing rather than
        // guess which way the user meant it to go.
        else if (key === "b" && root.handsfreeAction !== "") bridge.toggleHandsfree()
        // `f` for find, and only with a phone to find. It flips to hushing
        // for as long as the phone is shouting, so the same key ends what it
        // started rather than starting it again.
        else if (key === "f" && bridge.canLocate) {
          if (bridge.phoneRinging) bridge.hushPhone()
          else bridge.ringPhone()
        }
      }

      Flickable {
        id: panelFlick
        anchors.fill: parent
        contentWidth: width
        contentHeight: column.implicitHeight
        clip: true
        boundsBehavior: Flickable.StopAtBounds
        flickableDirection: Flickable.VerticalFlick
        interactive: contentHeight > height
        ScrollBar.vertical: ScrollBar { policy: ScrollBar.AsNeeded }

        Column {
          id: column
          width: panelFlick.width
          spacing: Style.space(12)

          /* ── hero ───────────────────────────────────────────────── */

          Item {
            id: header
            width: parent.width
            implicitHeight: hero.implicitHeight
            // Exposed for the hero's trailingControl, whose `root` resolves to
            // PanelHero rather than this Panel.
            readonly property bool ringVisible: root.cursorActive && root.focusSection === "header"
            function focusHero() { root.setCursor("header") }

            PanelHero {
              id: hero
              width: parent.width
              title: root.phone ? String(root.phone.name) : (bridge.status ? String(bridge.status.name) : "Omarchy Connect")
              detail: root.phone ? Model.platformLabel(root.phone.platform) : ""
              meta: root.heroMeta
              foreground: root.foreground
              fontFamily: root.fontFamily
              iconOpacity: root.linked ? 1.0 : 0.55
              iconComponent: Component {
                Text {
                  text: Model.deviceGlyph(root.phone ? root.phone.platform : "")
                  color: root.linked ? root.foreground : root.dim
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.display
                }
              }

              trailingControl: Component {
                ToggleSwitch {
                  id: powerSwitch
                  checked: bridge.running
                  busy: bridge.busy
                  hasCursor: header.ringVisible
                  foreground: hero.foreground
                  onHovered: function (on) { if (on) header.focusHero() }
                  onToggled: bridge.toggleDaemon()

                  PanelToolTip {
                    visible: powerSwitch.containsMouse
                    text: bridge.running
                      ? "Stop the daemon"
                      : (bridge.serviceInstalled ? "Start the daemon" : "Install the service and start it")
                    fontFamily: hero.fontFamily
                  }
                }
              }
            }
          }

          /* ── messages ───────────────────────────────────────────── */

          Row {
            id: messageRow
            visible: messageText.text !== ""
            width: parent.width
            spacing: Style.space(8)

            readonly property bool failed: bridge.lastError !== "" && bridge.actionStatus === ""

            Text {
              width: root.iconCell
              text: messageRow.failed ? "󰅚" : "󰋼"
              color: messageRow.failed ? root.urgent : root.dim
              font.family: root.fontFamily
              font.pixelSize: Style.font.bodySmall
              horizontalAlignment: Text.AlignHCenter
            }

            Text {
              id: messageText
              width: parent.width - root.iconCell - parent.spacing
              text: bridge.actionStatus !== "" ? bridge.actionStatus : bridge.lastError
              color: messageRow.failed ? root.urgent : root.dim
              font.family: root.fontFamily
              font.pixelSize: Style.font.bodySmall
              wrapMode: Text.WordWrap
            }
          }

          // A live pairing code, front and centre — it expires in three minutes
          // and nothing else on this panel is time-critical.
          CursorSurface {
            visible: root.pairing
            width: parent.width
            bordered: true
            foreground: root.foreground
            implicitHeight: pairingRow.implicitHeight + Style.spacing.rowPaddingX

            MouseArea {
              anchors.fill: parent
              hoverEnabled: true
              cursorShape: Qt.PointingHandCursor
              onClicked: bridge.pair()
            }

            RowLayout {
              id: pairingRow
              anchors.left: parent.left
              anchors.right: parent.right
              anchors.verticalCenter: parent.verticalCenter
              anchors.leftMargin: Style.space(10)
              anchors.rightMargin: Style.space(10)
              spacing: Style.space(10)

              Text {
                text: "󰄡"
                color: root.foreground
                font.family: root.fontFamily
                font.pixelSize: Style.font.icon
                Layout.alignment: Qt.AlignVCenter
              }

              ColumnLayout {
                Layout.fillWidth: true
                spacing: Style.space(1)

                Text {
                  Layout.fillWidth: true
                  text: bridge.status && bridge.status.pairing ? String(bridge.status.pairing.code) : ""
                  color: root.foreground
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.subtitle
                  font.bold: true
                  font.letterSpacing: 3
                }

                Text {
                  Layout.fillWidth: true
                  text: "Enter it in the app · expires in "
                    + Model.countdown(bridge.status && bridge.status.pairing ? bridge.status.pairing.expiresAt : 0, root.now)
                  color: root.dim
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.caption
                  elide: Text.ElideRight
                }
              }

              PanelActionButton {
                iconText: "󰐲"
                tooltipText: "Show the QR code"
                foreground: root.foreground
                fontFamily: root.fontFamily
                Layout.alignment: Qt.AlignVCenter
                onClicked: bridge.pair()
              }
            }
          }

          /* ── the call in progress ────────────────────────────────── */

          // The one card that is a remote control rather than a readout. It
          // appears for a call down any road: Bluetooth is the link that
          // carries the audio and is preferred for exactly that reason, but a
          // handset that connects over the profile and never reports its calls
          // is common, and answering from here still beats reaching for it.
          CursorSurface {
            visible: !!bridge.liveCall
            width: parent.width
            bordered: true
            foreground: bridge.ringing ? root.urgent : root.foreground
            accent: bridge.ringing ? root.urgent : root.foreground
            implicitHeight: callColumn.implicitHeight + Style.spacing.rowPaddingX

            Column {
              id: callColumn
              anchors.left: parent.left
              anchors.right: parent.right
              anchors.verticalCenter: parent.verticalCenter
              anchors.leftMargin: Style.space(10)
              anchors.rightMargin: Style.space(10)
              spacing: Style.space(6)

              Text {
                width: parent.width
                text: Model.callHeadline(bridge.liveCall)
                color: bridge.ringing ? root.urgent : root.foreground
                font.family: root.fontFamily
                font.pixelSize: Style.font.bodySmall
                elide: Text.ElideRight
              }

              Row {
                width: parent.width
                spacing: Style.space(8)

                Text {
                  width: parent.width - callActions.width - parent.spacing
                  text: Model.callDetail(bridge.liveCall, bridge.bluetooth, root.now)
                  color: root.dim
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.caption
                  elide: Text.ElideRight
                  anchors.verticalCenter: parent.verticalCenter
                }

                Row {
                  id: callActions
                  spacing: Style.space(6)
                  anchors.verticalCenter: parent.verticalCenter

                  PanelActionButton {
                    visible: bridge.ringing
                    iconText: "󰏲"
                    tooltipText: bridge.liveCall && bridge.liveCall.via && bridge.liveCall.via !== "bluetooth"
                      ? "Answer — the call stays on the handset"
                      : "Answer — audio comes out of this machine"
                    foreground: root.foreground
                    fontFamily: root.fontFamily
                    onClicked: bridge.answerCall()
                  }

                  PanelActionButton {
                    iconText: "󰏵"
                    tooltipText: bridge.ringing ? "Decline" : "Hang up"
                    foreground: root.urgent
                    fontFamily: root.fontFamily
                    onClicked: bridge.ringing ? bridge.rejectCall() : bridge.hangUp()
                  }
                }
              }
            }
          }

          // The daemon can only warn about a closed port; opening it is the
          // user's call, so the panel hands over the exact command and no more.
          CursorSurface {
            visible: bridge.firewall && bridge.firewall.blocked === true
            width: parent.width
            bordered: true
            foreground: root.urgent
            accent: root.urgent
            implicitHeight: firewallColumn.implicitHeight + Style.spacing.rowPaddingX

            Column {
              id: firewallColumn
              anchors.left: parent.left
              anchors.right: parent.right
              anchors.verticalCenter: parent.verticalCenter
              anchors.leftMargin: Style.space(10)
              anchors.rightMargin: Style.space(10)
              spacing: Style.space(4)

              Row {
                width: parent.width
                spacing: Style.space(8)

                Text {
                  width: root.iconCell
                  text: "󰻍"
                  color: root.urgent
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.bodySmall
                  horizontalAlignment: Text.AlignHCenter
                }

                Text {
                  width: parent.width - root.iconCell - parent.spacing
                  text: "Port " + (bridge.status ? bridge.status.port : "") + " is closed — phones cannot reach this desktop."
                  color: root.urgent
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.bodySmall
                  wrapMode: Text.WordWrap
                }
              }

              Row {
                width: parent.width
                spacing: Style.space(8)

                Text {
                  width: parent.width - copyRule.width - parent.spacing
                  text: bridge.firewall.command || ""
                  color: root.dim
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.caption
                  elide: Text.ElideMiddle
                  anchors.verticalCenter: parent.verticalCenter
                }

                PanelActionButton {
                  id: copyRule
                  iconText: "󰆏"
                  tooltipText: "Copy the command"
                  foreground: root.foreground
                  fontFamily: root.fontFamily
                  onClicked: bridge.copyText(bridge.firewall.command)
                }
              }
            }
          }

          /* ── coding agents at work ──────────────────────────────── */

          // Only the sessions, and only while there are any. The switch that
          // decides whether the phone may see them is a preference and sits
          // with the other one; this is the part that changes by the minute.
          PanelSeparator {
            visible: agentList.visible
            foreground: root.foreground
          }

          Column {
            id: agentList
            visible: bridge.agentsEnabled && bridge.agentSessions.length > 0
            width: parent.width
            spacing: Style.space(8)

            SectionHeader {
              glyph: "󰚩"
              label: "CODING AGENTS"
            }

            Column {
              width: parent.width
              spacing: Style.space(4)

              Repeater {
                model: bridge.agentSessions.slice(0, 3)

                // The mark is the agent's own — Claude's, where Claude is what
                // is running. Which agent this is answers a question the words
                // never do, and it answers it without spending a word: the
                // line beside it is already carrying what the session is doing.
                delegate: ListRow {
                  required property var modelData
                  readonly property bool waiting: modelData.state === "waiting"

                  // A session that never said which agent it is gets no URL at
                  // all rather than a resolved directory, which Image would
                  // spend a load failing before falling back anyway.
                  mark: Model.agentMark(modelData) === "" ? "" : Qt.resolvedUrl(Model.agentMark(modelData))
                  glyph: Model.agentGlyph(modelData)
                  glyphColor: waiting ? root.urgent : root.dim
                  title: Model.agentTitle(modelData)
                  titleColor: waiting ? root.urgent : root.foreground
                  detail: Model.agentDetail(modelData, root.now)
                  detailColor: waiting ? root.urgent : root.dim
                }
              }
            }
          }

          /* ── from the phone ─────────────────────────────────────── */

          PanelSeparator {
            visible: phoneList.visible
            foreground: root.foreground
          }

          // Three sources feed this one list — an Android build over the LAN,
          // a hands-free link, and an iPhone's own notifications over low
          // energy — and none of them is guaranteed, so the section stays out
          // of the way entirely until something arrives.
          Column {
            id: phoneList
            visible: bridge.phoneRecent.length > 0
            width: parent.width
            spacing: Style.space(8)

            SectionHeader {
              glyph: "󰄜"
              label: "FROM THE PHONE"
            }

            Column {
              width: parent.width
              spacing: Style.space(4)

              Repeater {
                model: bridge.phoneRecent.slice(0, 4)

                // The line, and under a message this desktop could answer,
                // the field that answers it. A row whose sender has no number
                // — an app's own notification, an iPhone message that came
                // down the low-energy road as a name and a sentence — is a
                // plain line and nothing else, which is `phoneReplyTo`'s
                // whole job.
                delegate: Column {
                  id: phoneEntry
                  required property var modelData
                  readonly property bool missed: modelData.missed === true
                  readonly property string replyTo: Model.phoneReplyTo(modelData)
                  readonly property string entryId: String((modelData && modelData.id) || replyTo)
                  readonly property bool replying: replyTo !== "" && root.replyId === entryId
                  readonly property bool cursored: root.cursorActive && root.focusSection === "messages"
                    && root.cursorEntryId === entryId

                  width: parent.width
                  spacing: Style.space(4)

                  // The row is a layout, so the click target cannot be
                  // anchored inside it — it goes over the top instead, in an
                  // item the layout does not manage.
                  Item {
                    width: parent.width
                    height: phoneRow.implicitHeight

                    // The keyboard cursor, on the one list that has rows worth
                    // landing on. It is the same fill every other control on
                    // this panel wears under the cursor, drawn a little wider
                    // than the text so the row reads as picked rather than as
                    // highlighted.
                    Rectangle {
                      anchors.fill: parent
                      anchors.leftMargin: -Style.space(4)
                      anchors.rightMargin: -Style.space(4)
                      anchors.topMargin: -Style.space(2)
                      anchors.bottomMargin: -Style.space(2)
                      visible: phoneEntry.cursored
                      color: Style.hoverFillFor(root.foreground, root.accent)
                      radius: Style.cornerRadius
                    }

                    ListRow {
                      id: phoneRow
                      glyph: Model.phoneGlyph(phoneEntry.modelData)
                      glyphColor: phoneEntry.missed ? root.urgent : root.dim
                      title: Model.phoneWho(phoneEntry.modelData)
                      titleColor: phoneEntry.missed ? root.urgent : root.foreground
                      detail: Model.phoneDetail(phoneEntry.modelData, root.now)
                    }

                    MouseArea {
                      anchors.fill: parent
                      enabled: phoneEntry.replyTo !== ""
                      hoverEnabled: enabled
                      cursorShape: enabled ? Qt.PointingHandCursor : Qt.ArrowCursor
                      onClicked: root.toggleReply(phoneEntry.modelData)
                    }
                  }

                  // Indented to where the names start, so the field reads as
                  // belonging to the line above it rather than to the list.
                  TextField {
                    visible: phoneEntry.replying
                    x: root.iconCell + Style.space(8)
                    width: parent.width - x
                    placeholderText: "Reply to " + Model.phoneWho(phoneEntry.modelData)
                    foreground: root.foreground
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.bodySmall
                    horizontalPadding: Style.spacing.controlGap
                    verticalPadding: Style.spacing.controlPaddingY

                    // The draft lives on the panel, not here: this delegate is
                    // thrown away and rebuilt every time the status file moves.
                    onVisibleChanged: {
                      if (!visible) return
                      text = root.replyDraft
                      Qt.callLater(forceActiveFocus)
                    }
                    onTextChanged: if (phoneEntry.replying) root.replyDraft = text
                    onActiveFocusChanged: root.replyFocused = activeFocus
                    // Enter is handled here rather than through `accepted`
                    // because a TextField does not swallow the key: an
                    // unaccepted Return carries on up to the panel's key
                    // catcher, which — with the field now closed and no
                    // longer holding the keyboard — reads it as Enter on the
                    // row and opens the field straight back up. Taking the
                    // key here ends it here, which is also how Esc has always
                    // behaved.
                    Keys.onReturnPressed: root.sendReply()
                    Keys.onEnterPressed: root.sendReply()
                    Keys.onEscapePressed: root.cancelReply()
                  }
                }
              }
            }
          }

          /* ── recent transfers ───────────────────────────────────── */

          PanelSeparator {
            visible: transferList.visible
            foreground: root.foreground
          }

          Column {
            id: transferList
            visible: bridge.transfers.length > 0
            width: parent.width
            spacing: Style.space(8)

            SectionHeader {
              glyph: "󱁥"
              label: "RECENT TRANSFERS"
            }

            Column {
              width: parent.width
              spacing: Style.space(4)

              Repeater {
                model: bridge.transfers.slice(0, 4)

                // A file name is worth more in the middle than at either end,
                // so this is the one list that elides from the middle.
                delegate: ListRow {
                  required property var modelData

                  glyph: Model.transferGlyph(modelData.direction)
                  title: String(modelData.name || "")
                  titleElide: Text.ElideMiddle
                  detail: Model.transferLabel(modelData, root.now)
                }
              }
            }
          }

          /* ── actions ────────────────────────────────────────────── */

          PanelSeparator { foreground: root.foreground }

          Row {
            id: actionRow
            width: parent.width
            spacing: Style.space(6)

            readonly property int count: Math.max(1, root.actions.length)
            readonly property real cellWidth: (width - spacing * (count - 1)) / count

            Repeater {
              model: root.actions

              delegate: Item {
                required property var modelData
                required property int index
                width: actionRow.cellWidth
                height: actionPill.implicitHeight

                Button {
                  id: actionPill
                  width: parent.width
                  text: modelData.label
                  iconText: modelData.icon
                  tooltipText: modelData.tooltip
                  bordered: true
                  hasCursor: root.cursorActive && root.focusSection === "actions" && root.actionIndex === index
                  foreground: root.foreground
                  accent: root.foreground
                  fontFamily: root.fontFamily
                  onHovered: function (on) { if (on) root.setActionCursor(index) }
                  onClicked: root.runAction(modelData.key)
                }
              }
            }
          }

          /* ── details, folded away ───────────────────────────────── */

          // Where the daemon can be reached and how to recognise it, plus
          // whichever counters and Bluetooth links have anything to report.
          // One row until you want them.
          Expander {
            width: parent.width
            visible: bridge.loaded
            label: "Details"
            glyph: "󰋽"
            section: "details"
            expanded: root.detailsOpen
            onToggled: root.toggleDetails()
          }

          GridLayout {
            visible: bridge.loaded && root.detailsOpen
            width: parent.width
            columns: 2
            columnSpacing: Style.space(20)
            rowSpacing: Style.spacing.labelGap

            // The transport is the one thing here that is true whether or not a
            // phone is on the other end, so it is the one row with no gate.
            InfoLabel { glyph: "󰒍"; text: "Transport" }
            DetailValue {
              text: bridge.tls ? "󰦝 tls · pinned" : "󰦜 plain"
              color: bridge.tls ? root.foreground : root.dim
            }

            InfoLabel { glyph: "󱀲"; text: "Files"; visible: root.showTransfers }
            DetailValue {
              visible: root.showTransfers
              text: String(bridge.counters.filesIn || 0) + " in · " + String(bridge.counters.filesOut || 0) + " out"
            }

            InfoLabel { glyph: "󰂜"; text: "Notified"; visible: root.showNotified }
            DetailValue {
              visible: root.showNotified
              // Missed calls are the half of this row worth a colour, so they
              // only appear once there are any.
              text: {
                var parts = [String(bridge.counters.notifications || 0) + " mirrored"]
                if ((bridge.phone.missed || 0) > 0) parts.push(String(bridge.phone.missed) + " missed")
                return parts.join(" · ")
              }
              color: (bridge.phone.missed || 0) > 0 ? root.urgent : root.foreground
            }

            // The one row here that is a control as well as a readout. Dropping
            // the link leaves the bond standing, which is exactly why it is
            // worth a button: connect for the call, disconnect afterwards, and
            // the phone is still paired either way.
            InfoLabel {
              glyph: Model.handsfreeGlyph(bridge.bluetooth)
              text: "Bluetooth"
              visible: root.showHandsfree
            }
            RowLayout {
              visible: root.showHandsfree
              Layout.fillWidth: true
              spacing: Style.space(6)

              DetailValue {
                text: Model.handsfreeText(bridge.bluetooth, root.now)
                color: bridge.bluetooth && bridge.bluetooth.connected === true ? root.foreground : root.dim
              }

              // Sized down from the default action button: this one sits in a
              // table of eleven-pixel rows, and a full-height button would
              // make the row it is in the tallest thing behind the expander.
              PanelActionButton {
                visible: root.handsfreeAction !== ""
                Layout.alignment: Qt.AlignVCenter
                iconText: root.handsfreeAction === "disconnect"
                  ? "󰂲"
                  : root.handsfreeAction === "bond" ? "󰐲" : "󰂱"
                // Three buttons in one, and the third is not a louder version
                // of the second: `bond` makes the pairing the other two
                // assume, and it makes this machine visible for a minute to
                // do it. Saying so is the difference between a button somebody
                // presses on purpose and one they press to see what happens.
                tooltipText: root.handsfreeAction === "disconnect"
                  ? "Disconnect — the pairing stays"
                  : root.handsfreeAction === "bond"
                    ? "Pair a handset — this desktop becomes visible for a minute"
                    : "Connect over Bluetooth"
                foreground: root.foreground
                fontFamily: root.fontFamily
                fontSize: Style.font.iconSmall
                size: Style.space(18)
                onClicked: bridge.toggleHandsfree()
              }
            }

            InfoLabel { glyph: "󰀷"; text: "iPhone"; visible: root.showIos }
            DetailValue {
              visible: root.showIos
              text: Model.iosText(bridge.ios)
              color: bridge.ios && bridge.ios.subscribed === true ? root.foreground : root.dim
            }

            // These two are the only values too long for a quarter of the card,
            // so they take a whole row each rather than being elided into
            // uselessness — a truncated fingerprint verifies nothing.
            InfoLabel { glyph: "󰩠"; text: "Address" }
            DetailValue {
              text: bridge.address || "--"
              copyable: !!bridge.address
              tooltipText: "Copy the address"
            }
            InfoLabel { glyph: "󰖟"; text: "Remote"; visible: root.showRemote }
            DetailValue {
              visible: root.showRemote
              text: Model.remoteText(bridge.remote)
              color: bridge.remoteEnabled && bridge.remote.address ? root.foreground : root.dim
              copyable: !!bridge.remote.address
              copyValue: bridge.remote.address ? String(bridge.remote.address) : ""
              tooltipText: "Copy the remote address"
            }
            InfoLabel { glyph: "󰈷"; text: "Fingerprint" }
            DetailValue {
              text: bridge.status ? String(bridge.status.fingerprint) : "--"
              copyable: !!bridge.status
              tooltipText: "Copy the fingerprint"
            }
          }

          /* ── the two switches, folded away ──────────────────────── */

          // Both of these are decided once and then left alone for months, so
          // neither earns a permanent place on the panel. They are still here,
          // one row down, because they are decisions that belong on the desktop
          // rather than in the app.
          Expander {
            width: parent.width
            label: "Settings"
            glyph: "󰒓"
            section: "settings"
            expanded: root.settingsOpen
            onToggled: root.toggleSettings()
          }

          Column {
            visible: root.settingsOpen
            width: parent.width
            spacing: Style.space(8)

            // The card stays out of the way on a machine with no agent
            // installed, because a switch for a thing that does not exist is
            // only a question.
            Toggle {
              visible: bridge.agentsAvailable
              width: parent.width
              label: bridge.agentsEnabled ? "The phone can read and answer agents" : "Let the phone read and answer agents"
              description: (bridge.agentsEnabled ? "󰛐  " : "󰛑  ") + Model.agentsText(bridge.agents, bridge.running)
              checked: bridge.agentsEnabled
              hasCursor: root.cursorActive && root.focusSection === "agents"
              onHovered: function (on) { if (on) root.setCursor("agents") }
              foreground: root.foreground
              // An agent that has stopped to ask you something is the one
              // thing on this card worth interrupting for.
              accent: bridge.agentsWaiting > 0 ? root.urgent : root.foreground
              fontFamily: root.fontFamily
              onClicked: root.requestAgents(!bridge.agentsEnabled)
            }

            // Hidden on a desktop with no tunnel to offer, for the same
            // reason: there is nothing here to switch on until the machine
            // has been put on one.
            Toggle {
              visible: bridge.remoteAvailable
              width: parent.width
              label: bridge.remoteEnabled ? "The phone can reach this desktop from anywhere" : "Let the phone reach this desktop from anywhere"
              description: (bridge.remoteEnabled ? "󰖟  " : "󰖠  ") + Model.remoteText(bridge.remote)
              checked: bridge.remoteEnabled
              hasCursor: root.cursorActive && root.focusSection === "remote"
              onHovered: function (on) { if (on) root.setCursor("remote") }
              foreground: root.foreground
              accent: root.foreground
              fontFamily: root.fontFamily
              onClicked: root.requestRemote(!bridge.remoteEnabled)
            }

            // Reading works without hooks; knowing that an agent is *stuck*
            // does not, because a permission prompt is drawn on a terminal and
            // never written to a transcript. The hooks live in the user's own
            // Claude settings, so this stays a button rather than something
            // turning the switch on quietly did.
            CursorSurface {
              visible: bridge.agentsAvailable && bridge.agentsEnabled && !bridge.agentHooks
              width: parent.width
              bordered: true
              foreground: root.foreground
              implicitHeight: hooksRow.implicitHeight + Style.spacing.rowPaddingX

              RowLayout {
                id: hooksRow
                anchors.left: parent.left
                anchors.right: parent.right
                anchors.verticalCenter: parent.verticalCenter
                anchors.leftMargin: Style.space(10)
                anchors.rightMargin: Style.space(10)
                spacing: Style.space(10)

                Text {
                  text: "󰀦"
                  color: root.dim
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.bodySmall
                  horizontalAlignment: Text.AlignHCenter
                  Layout.preferredWidth: root.iconCell
                  Layout.alignment: Qt.AlignVCenter
                }

                Text {
                  Layout.fillWidth: true
                  text: "No hooks yet — the desktop can see an agent working, but not that it has stopped to ask you something."
                  color: root.dim
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.caption
                  wrapMode: Text.WordWrap
                }

                Button {
                  text: "Install"
                  iconText: "󰐗"
                  tooltipText: "Add the lifecycle hooks to ~/.claude/settings.json"
                  bordered: true
                  foreground: root.foreground
                  accent: root.foreground
                  fontFamily: root.fontFamily
                  Layout.alignment: Qt.AlignVCenter
                  onClicked: bridge.installAgentHooks()
                }
              }
            }

            // Starting and stopping the daemon *right now* is the hero's
            // switch. This is the separate decision of whether it comes back
            // on its own tomorrow.
            Toggle {
              width: parent.width
              label: "Start at login"
              description: "󰐥  " + (bridge.serviceInstalled
                ? (bridge.serviceEnabled ? "The daemon comes up with the session" : "The daemon only runs when you start it")
                : "The service is not installed yet")
              checked: bridge.serviceEnabled
              hasCursor: root.cursorActive && root.focusSection === "autostart"
              onHovered: function (on) { if (on) root.setCursor("autostart") }
              foreground: root.foreground
              accent: root.foreground
              fontFamily: root.fontFamily
              onClicked: bridge.toggleAutostart()
            }
          }

          Row {
            width: parent.width
            visible: !bridge.loaded
            spacing: Style.space(8)

            Text {
              width: root.iconCell
              text: "󰋽"
              color: root.dim
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
              horizontalAlignment: Text.AlignHCenter
            }

            Text {
              width: parent.width - root.iconCell - parent.spacing
              text: "No status file yet. Run `omarchy-connect panel install` once, then start the daemon."
              color: root.dim
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
              wrapMode: Text.WordWrap
            }
          }
        }
      }

      // The one question this panel asks. Everything else here either reports
      // or does something you can undo with the same click; this one widens
      // what leaves the machine, and it is worth a sentence and a second click.
      ConfirmDialog {
        id: agentConfirm
        anchors.fill: parent
        z: 10
        opened: root.agentConfirmOpen
        message: "Let " + (bridge.device ? bridge.device.name : "the paired phone")
          + " read and answer the coding agents on this desktop? It sees everything they saw — your source, the commands they ran, and the output of those commands — and it can type into them, which the agent will act on. That is a shell."
        confirmText: "Let it in"
        foreground: root.foreground
        fontFamily: root.fontFamily
        onCanceled: root.agentConfirmOpen = false
        onConfirmed: {
          root.agentConfirmOpen = false
          bridge.enableAgents()
        }
      }
    }
  }

  /* ── row components ──────────────────────────────────────────────── */

  // One line that stands in for a section until you ask for it: a chevron, a
  // word, and the whole row as a click target.
  component Expander: CursorSurface {
    id: expander
    property string label: ""
    property string glyph: ""
    property string section: ""
    property bool expanded: false

    signal toggled()

    hasCursor: root.cursorActive && root.focusSection === expander.section
    foreground: root.foreground
    implicitHeight: expanderRow.implicitHeight + Style.spacing.rowPaddingX

    MouseArea {
      anchors.fill: parent
      hoverEnabled: true
      cursorShape: Qt.PointingHandCursor
      onEntered: root.setCursor(expander.section)
      onClicked: expander.toggled()
    }

    Row {
      id: expanderRow
      anchors.left: parent.left
      anchors.right: parent.right
      anchors.verticalCenter: parent.verticalCenter
      anchors.leftMargin: Style.space(10)
      anchors.rightMargin: Style.space(10)
      spacing: Style.space(8)

      Text {
        text: expander.expanded ? "󰅀" : "󰅂"
        color: root.dim
        font.family: root.fontFamily
        font.pixelSize: Style.font.bodySmall
        anchors.verticalCenter: parent.verticalCenter
      }

      Text {
        width: root.iconCell
        text: expander.glyph
        color: root.dim
        font.family: root.fontFamily
        font.pixelSize: Style.font.bodySmall
        horizontalAlignment: Text.AlignHCenter
        anchors.verticalCenter: parent.verticalCenter
      }

      Text {
        text: expander.label
        color: root.foreground
        font.family: root.fontFamily
        font.pixelSize: Style.font.bodySmall
        anchors.verticalCenter: parent.verticalCenter
      }
    }
  }

  // The header over a section, with the section's own glyph in the shared icon
  // column — so the mark on every row below it sits directly under the mark on
  // the header rather than beside it.
  component SectionHeader: Row {
    id: sectionHeader
    property string glyph: ""
    property string label: ""

    width: parent ? parent.width : implicitWidth
    spacing: Style.space(8)

    Text {
      width: root.iconCell
      text: sectionHeader.glyph
      color: Qt.darker(root.foreground, 1.4)
      font.family: root.fontFamily
      font.pixelSize: Style.font.caption
      horizontalAlignment: Text.AlignHCenter
      topPadding: Math.ceil(Style.font.caption * 0.15)
    }

    PanelSectionHeader {
      text: sectionHeader.label
      foreground: root.foreground
      fontFamily: root.fontFamily
    }
  }

  /**
   * One line in one of the three lists: a mark, a name, and the one thing
   * worth saying about it, right-aligned.
   *
   * The mark is an SVG the agent or the source ships where there is one and a
   * font glyph where there is not, and either way it is drawn into the shared
   * icon column rather than at its own width — a call, a file and a coding
   * agent are three different outlines, and a list whose names start in three
   * different places is a list you have to read one row at a time.
   *
   * Both texts flex. The name takes whatever room is going; the detail is
   * capped at the width of what it has to say, so a short "12 KB · 3m ago"
   * never steals half the row, and a long prompt still gets its share instead
   * of the name squeezing it out of existence the way the old arithmetic did.
   */
  component ListRow: RowLayout {
    id: listRow

    property string mark: ""
    property string glyph: ""
    property color glyphColor: root.dim
    property string title: ""
    property color titleColor: root.foreground
    property string detail: ""
    property color detailColor: root.dim
    property int titleElide: Text.ElideRight

    width: parent ? parent.width : implicitWidth
    spacing: Style.space(8)

    // The detail is capped at the width of what it has to say, and that width
    // is measured here rather than read off the label itself. An eliding Text
    // reports the width it *is* drawing, not the width it wants, so capping it
    // with its own implicitWidth is a ratchet: one narrow layout pass elides
    // the text, the cap follows it down, and "ringing" spends the rest of the
    // session as "ringi…" beside half a row of empty space.
    TextMetrics {
      id: detailMetrics
      font.family: root.fontFamily
      font.pixelSize: Style.font.bodySmall
      text: listRow.detail
    }

    Item {
      Layout.preferredWidth: root.iconCell
      Layout.preferredHeight: root.iconCell
      Layout.alignment: Qt.AlignVCenter

      Image {
        id: markImage
        anchors.centerIn: parent
        width: root.iconCell
        height: root.iconCell
        source: listRow.mark
        sourceSize.width: root.iconCell * 2
        sourceSize.height: root.iconCell * 2
        fillMode: Image.PreserveAspectFit
        visible: status === Image.Ready
      }

      Text {
        anchors.centerIn: parent
        visible: !markImage.visible
        text: listRow.glyph
        color: listRow.glyphColor
        font.family: root.fontFamily
        font.pixelSize: Style.font.bodySmall
      }
    }

    Text {
      text: listRow.title
      color: listRow.titleColor
      font.family: root.fontFamily
      font.pixelSize: Style.font.bodySmall
      elide: listRow.titleElide
      Layout.fillWidth: true
      Layout.minimumWidth: 0
      Layout.alignment: Qt.AlignVCenter
    }

    Text {
      text: listRow.detail
      color: listRow.detailColor
      font.family: root.fontFamily
      font.pixelSize: Style.font.bodySmall
      horizontalAlignment: Text.AlignRight
      elide: Text.ElideRight
      visible: text !== ""
      Layout.fillWidth: true
      Layout.minimumWidth: 0
      Layout.maximumWidth: Math.ceil(detailMetrics.advanceWidth) + 1
      Layout.alignment: Qt.AlignVCenter
    }
  }

  component DetailValue: InfoValue {
    property bool copyable: false
    property string tooltipText: "Copy to clipboard"
    // What lands on the clipboard, when that is not the whole line. A row
    // that reads "tailscale · 100.101.102.103" is the right thing to look at
    // and the wrong thing to paste into an address field.
    property string copyValue: ""

    Layout.fillWidth: true
    horizontalAlignment: Text.AlignRight
    elide: Text.ElideMiddle

    MouseArea {
      id: valueMouse
      anchors.fill: parent
      enabled: parent.copyable && parent.text !== ""
      hoverEnabled: enabled
      cursorShape: enabled ? Qt.PointingHandCursor : Qt.ArrowCursor
      onClicked: bridge.copyText(parent.copyValue !== "" ? parent.copyValue : parent.text)
    }

    PanelToolTip {
      visible: valueMouse.enabled && valueMouse.containsMouse
      text: parent.tooltipText
      fontFamily: root.fontFamily
    }
  }

  // A label in *Details*, led by the glyph for what it is a reading of. Same
  // icon column as everything else, so the seven rows behind that expander read
  // as one table rather than as seven sentences that happen to be stacked.
  component InfoLabel: Row {
    id: infoLabel
    property string glyph: ""
    property string text: ""

    spacing: Style.space(8)
    Layout.alignment: Qt.AlignLeft | Qt.AlignVCenter

    Text {
      width: root.iconCell
      text: infoLabel.glyph
      color: root.foreground
      opacity: 0.45
      font.family: root.fontFamily
      font.pixelSize: Style.font.bodySmall
      horizontalAlignment: Text.AlignHCenter
      anchors.verticalCenter: parent.verticalCenter
    }

    Text {
      text: infoLabel.text
      color: root.foreground
      opacity: 0.6
      font.family: root.fontFamily
      font.pixelSize: Style.font.bodySmall
      anchors.verticalCenter: parent.verticalCenter
    }
  }

  component InfoValue: Text {
    color: root.foreground
    font.family: root.fontFamily
    font.pixelSize: Style.font.bodySmall
  }
}
