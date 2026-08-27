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

  readonly property color foreground: bar ? bar.foreground : Color.foreground
  readonly property color urgent: bar ? bar.urgent : Color.urgent
  readonly property color dim: Qt.darker(foreground, 1.55)
  readonly property string fontFamily: bar ? bar.fontFamily : Style.font.family

  readonly property bool linked: bridge.online.length > 0
  readonly property bool pairing: Model.pairingActive(bridge.status, root.now)
  readonly property var phone: bridge.primary
  readonly property bool paired: bridge.paired

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
  readonly property string statusLine: {
    if (!bridge.loaded) return "Not installed"
    if (!bridge.running) return "Daemon stopped"
    if (pairing) return "Waiting for a phone"
    if (linked) {
      var parts = [phone && phone.secure === false ? "Unencrypted" : "Encrypted"]
      var up = Model.uptime(phone.since, root.now)
      if (up !== "") parts.push(up)
      if (phone.battery) parts.push(Model.batteryText(phone.battery))
      return parts.join(" · ")
    }
    if (!paired) return "No phone paired"
    return "Offline · last seen " + Model.since(phone ? phone.lastSeen : 0, root.now)
  }

  // Every row behind *Details* is gated on having something to say. A readout
  // whose whole content is "no" is not a readout: an Android phone on the LAN
  // has no use for a line telling it no iPhone is paired, and a link that has
  // moved nothing has no use for two zeroes.
  readonly property bool showTransfers: (bridge.counters.filesIn || 0) > 0 || (bridge.counters.filesOut || 0) > 0
  readonly property bool showNotified: (bridge.counters.notifications || 0) > 0 || (bridge.phone.missed || 0) > 0
  // The hands-free link is the desktop's business, not the user's, right up
  // until it is carrying something or has failed at it.
  readonly property bool showHandsfree: !!bridge.bluetooth && (bridge.bluetooth.connected === true
    || (!!bridge.bluetooth.link && (bridge.bluetooth.link.raising === true || !!bridge.bluetooth.link.error)))
  // Bonded-but-idle stays, because that one *is* fixable by re-pairing.
  readonly property bool showIos: !!bridge.ios && (bridge.ios.subscribed === true
    || bridge.ios.paired === true || !!bridge.ios.pairing)

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
      ? { key: "unpair", label: "Unpair", icon: "󰅖",
          tooltip: "Forget " + (bridge.device ? bridge.device.name : "this phone") + " — a desktop pairs one phone at a time" }
      : { key: "pair", label: "Pair", icon: "󰐗", tooltip: "Show a pairing QR code" }]
    if (bridge.running) list.push({ key: "send", label: "Send", icon: "󰈤", tooltip: "Pick a file to send to the phone" })
    list.push({ key: "inbox", label: "Inbox", icon: "󰉋", tooltip: "Open the folder phones drop files into" })
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

  function runAction(key) {
    if (key === "pair") bridge.pair()
    else if (key === "unpair") bridge.unpair(bridge.device)
    else if (key === "send") bridge.sendFile()
    else if (key === "inbox") bridge.openInbox()
  }

  /* ── cursor ────────────────────────────────────────────────────────── */

  // Everything the keyboard can land on, in the order it is drawn. The two
  // expanders are always here; what they hold only joins the list once they
  // are open, which is the same rule the eye follows.
  readonly property var sections: {
    var list = ["header", "actions", "details", "settings"]
    if (settingsOpen) {
      if (bridge.agentsAvailable) list.push("agents")
      list.push("autostart")
    }
    return list
  }

  function ensureCursor() {
    if (actionIndex >= actions.length) actionIndex = Math.max(0, actions.length - 1)
    if (actionIndex < 0) actionIndex = 0
    if (sections.indexOf(focusSection) < 0) focusSection = "actions"
  }

  function moveCursor(dx, dy) {
    cursorActive = true
    ensureCursor()

    if (dx !== 0) {
      if (focusSection === "actions")
        actionIndex = Math.max(0, Math.min(actions.length - 1, actionIndex + dx))
      return
    }
    if (dy === 0) return

    var index = sections.indexOf(focusSection) + dy
    if (index < 0 || index >= sections.length) return
    focusSection = sections[index]
    if (focusSection === "header" && panelFlick) panelFlick.contentY = 0
    else if (focusSection !== "actions") scrollToBottom()
  }

  function activateCursor() {
    ensureCursor()
    if (focusSection === "header") bridge.toggleDaemon()
    else if (focusSection === "actions") runAction(actions[actionIndex].key)
    else if (focusSection === "details") toggleDetails()
    else if (focusSection === "settings") toggleSettings()
    // Enter on the agent switch opens the question rather than answering it,
    // which is why the cursor is allowed here at all.
    else if (focusSection === "agents") requestAgents(!bridge.agentsEnabled)
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
    foreground: root.barIconColor
    active: root.pairing
    tooltipText: {
      if (!bridge.loaded) return "Omarchy Connect is not set up"
      if (!bridge.running) return "Omarchy Connect is stopped"
      if (root.pairing) return "Waiting for a phone to pair"
      if (root.linked) return root.phone.name + " is connected"
      return root.paired ? root.phone.name + " is offline" : "No phone paired yet"
    }
    onPressed: function (buttonCode) {
      if (buttonCode === Qt.RightButton) bridge.pair()
      else if (buttonCode === Qt.MiddleButton) bridge.refresh()
      else root.toggle()
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
              meta: root.statusLine
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

          Text {
            visible: text !== ""
            width: parent.width
            text: bridge.actionStatus !== "" ? bridge.actionStatus : bridge.lastError
            color: bridge.lastError !== "" && bridge.actionStatus === "" ? root.urgent : root.dim
            font.family: root.fontFamily
            font.pixelSize: Style.font.bodySmall
            wrapMode: Text.WordWrap
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
                text: "󰐗"
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
                  text: Model.callDetail(bridge.liveCall, bridge.bluetooth)
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
                    iconText: "󰏳"
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

              Text {
                width: parent.width
                text: "Port " + (bridge.status ? bridge.status.port : "") + " is closed — phones cannot reach this desktop."
                color: root.urgent
                font.family: root.fontFamily
                font.pixelSize: Style.font.bodySmall
                wrapMode: Text.WordWrap
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

            PanelSectionHeader {
              text: "CODING AGENTS"
              foreground: root.foreground
              fontFamily: root.fontFamily
            }

            Column {
              width: parent.width
              spacing: Style.space(4)

              Repeater {
                model: bridge.agentSessions.slice(0, 3)

                delegate: Row {
                  required property var modelData
                  width: parent.width
                  spacing: Style.space(8)

                  readonly property bool waiting: modelData.state === "waiting"

                  Text {
                    id: agentGlyph
                    text: Model.agentGlyph(modelData)
                    color: waiting ? root.urgent : root.dim
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.bodySmall
                    anchors.verticalCenter: parent.verticalCenter
                  }

                  Text {
                    id: agentName
                    text: Model.agentTitle(modelData)
                    color: waiting ? root.urgent : root.foreground
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.bodySmall
                    anchors.verticalCenter: parent.verticalCenter
                  }

                  Text {
                    width: Math.max(0, parent.width - agentGlyph.width - agentName.width - parent.spacing * 2)
                    text: Model.agentDetail(modelData, root.now)
                    color: root.dim
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.bodySmall
                    horizontalAlignment: Text.AlignRight
                    elide: Text.ElideRight
                    anchors.verticalCenter: parent.verticalCenter
                  }
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

            PanelSectionHeader {
              text: "FROM THE PHONE"
              foreground: root.foreground
              fontFamily: root.fontFamily
            }

            Column {
              width: parent.width
              spacing: Style.space(4)

              Repeater {
                model: bridge.phoneRecent.slice(0, 4)

                delegate: Row {
                  required property var modelData
                  width: parent.width
                  spacing: Style.space(8)

                  Text {
                    id: phoneGlyph
                    text: Model.phoneGlyph(modelData)
                    color: modelData.missed === true ? root.urgent : root.dim
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.bodySmall
                    anchors.verticalCenter: parent.verticalCenter
                  }

                  Text {
                    id: phoneWho
                    text: Model.phoneWho(modelData)
                    color: root.foreground
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.bodySmall
                    anchors.verticalCenter: parent.verticalCenter
                  }

                  Text {
                    width: Math.max(0, parent.width - phoneGlyph.width - phoneWho.width - parent.spacing * 2)
                    text: Model.phoneDetail(modelData, root.now)
                    color: root.dim
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.bodySmall
                    horizontalAlignment: Text.AlignRight
                    elide: Text.ElideRight
                    anchors.verticalCenter: parent.verticalCenter
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

            PanelSectionHeader {
              text: "RECENT TRANSFERS"
              foreground: root.foreground
              fontFamily: root.fontFamily
            }

            Column {
              width: parent.width
              spacing: Style.space(4)

              Repeater {
                model: bridge.transfers.slice(0, 4)

                delegate: Row {
                  required property var modelData
                  width: parent.width
                  spacing: Style.space(8)

                  Text {
                    id: transferGlyph
                    text: Model.transferGlyph(modelData.direction)
                    color: root.dim
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.bodySmall
                    anchors.verticalCenter: parent.verticalCenter
                  }

                  Text {
                    id: transferName
                    width: Math.max(0, parent.width - transferGlyph.width - transferMeta.implicitWidth - parent.spacing * 2)
                    text: String(modelData.name || "")
                    color: root.foreground
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.bodySmall
                    elide: Text.ElideMiddle
                    anchors.verticalCenter: parent.verticalCenter
                  }

                  Text {
                    id: transferMeta
                    text: Model.transferLabel(modelData, root.now)
                    color: root.dim
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.caption
                    anchors.verticalCenter: parent.verticalCenter
                  }
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
            section: "details"
            expanded: root.detailsOpen
            onToggled: root.toggleDetails()
          }

          GridLayout {
            visible: bridge.loaded && root.detailsOpen
            width: parent.width
            columns: 4
            columnSpacing: Style.space(20)
            rowSpacing: Style.spacing.labelGap

            // The transport is the one thing here that is true whether or not a
            // phone is on the other end, so it is the one row with no gate.
            InfoLabel { text: "Transport" }
            DetailValue {
              Layout.columnSpan: 3
              text: bridge.tls ? "tls · pinned" : "plain"
              color: bridge.tls ? root.foreground : root.dim
            }

            InfoLabel { text: "Files"; visible: root.showTransfers }
            DetailValue {
              Layout.columnSpan: 3
              visible: root.showTransfers
              text: String(bridge.counters.filesIn || 0) + " in · " + String(bridge.counters.filesOut || 0) + " out"
            }

            InfoLabel { text: "Notified"; visible: root.showNotified }
            DetailValue {
              Layout.columnSpan: 3
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

            InfoLabel { text: "Bluetooth"; visible: root.showHandsfree }
            DetailValue {
              Layout.columnSpan: 3
              visible: root.showHandsfree
              text: Model.handsfreeText(bridge.bluetooth)
              color: bridge.bluetooth && bridge.bluetooth.connected === true ? root.foreground : root.dim
            }

            InfoLabel { text: "iPhone"; visible: root.showIos }
            DetailValue {
              Layout.columnSpan: 3
              visible: root.showIos
              text: Model.iosText(bridge.ios)
              color: bridge.ios && bridge.ios.subscribed === true ? root.foreground : root.dim
            }

            // These two are the only values too long for a quarter of the card,
            // so they take a whole row each rather than being elided into
            // uselessness — a truncated fingerprint verifies nothing.
            InfoLabel { text: "Address" }
            DetailValue {
              Layout.columnSpan: 3
              text: bridge.address || "--"
              copyable: !!bridge.address
              tooltipText: "Copy the address"
            }
            InfoLabel { text: "Fingerprint" }
            DetailValue {
              Layout.columnSpan: 3
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
              description: Model.agentsText(bridge.agents, bridge.running)
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
              description: bridge.serviceInstalled
                ? (bridge.serviceEnabled ? "The daemon comes up with the session" : "The daemon only runs when you start it")
                : "The service is not installed yet"
              checked: bridge.serviceEnabled
              hasCursor: root.cursorActive && root.focusSection === "autostart"
              onHovered: function (on) { if (on) root.setCursor("autostart") }
              foreground: root.foreground
              accent: root.foreground
              fontFamily: root.fontFamily
              onClicked: bridge.toggleAutostart()
            }
          }

          Text {
            width: parent.width
            visible: !bridge.loaded
            text: "No status file yet. Run `omarchy-connect panel install` once, then start the daemon."
            color: root.dim
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
            wrapMode: Text.WordWrap
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
        text: expander.label
        color: root.foreground
        font.family: root.fontFamily
        font.pixelSize: Style.font.bodySmall
        anchors.verticalCenter: parent.verticalCenter
      }
    }
  }

  component DetailValue: InfoValue {
    property bool copyable: false
    property string tooltipText: "Copy to clipboard"

    Layout.fillWidth: true
    horizontalAlignment: Text.AlignRight
    elide: Text.ElideMiddle

    MouseArea {
      id: valueMouse
      anchors.fill: parent
      enabled: parent.copyable && parent.text !== ""
      hoverEnabled: enabled
      cursorShape: enabled ? Qt.PointingHandCursor : Qt.ArrowCursor
      onClicked: bridge.copyText(parent.text)
    }

    PanelToolTip {
      visible: valueMouse.enabled && valueMouse.containsMouse
      text: parent.tooltipText
      fontFamily: root.fontFamily
    }
  }

  component InfoLabel: Text {
    color: root.foreground
    opacity: 0.6
    font.family: root.fontFamily
    font.pixelSize: Style.font.bodySmall
  }

  component InfoValue: Text {
    color: root.foreground
    font.family: root.fontFamily
    font.pixelSize: Style.font.bodySmall
  }
}
