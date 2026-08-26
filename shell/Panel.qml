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
// The daemon on this machine already knows everything worth showing — which
// phone is on the other end of the link, whether the channel is encrypted,
// what has moved across it. This draws that, and hands back the four things
// you actually do from the desktop side: pair, send, open the inbox, and stop
// the daemon.

Panel {
  id: root
  moduleName: "omarchy-connect.phone"
  ipcTarget: "omarchy-connect"
  // manageIpc: false so this panel owns the single IpcHandler the target
  // permits and can add refresh/pair to the open/close verbs.
  manageIpc: false

  property string focusSection: "header"
  property int deviceIndex: 0
  property int actionIndex: 0
  property bool cursorActive: false
  property int phraseIndex: 0
  property real now: Date.now()

  readonly property var activePhrases: [
    "Bridging devices",
    "Holding the line",
    "Sealing frames",
    "Counting packets",
    "Keeping in touch",
    "Minding the link",
    "Trading secrets",
    "Watching the wire"
  ]
  readonly property string heroPhraseText: activePhrases[phraseIndex % activePhrases.length]

  readonly property color foreground: bar ? bar.foreground : Color.foreground
  readonly property color urgent: bar ? bar.urgent : Color.urgent
  readonly property color dim: Qt.darker(foreground, 1.55)
  readonly property string fontFamily: bar ? bar.fontFamily : Style.font.family

  readonly property bool linked: bridge.online.length > 0
  readonly property bool pairing: Model.pairingActive(bridge.status, root.now)
  readonly property var phone: bridge.primary
  readonly property bool paired: bridge.devices.length > 0

  // The bar icon carries three states and nothing else: linked, running but
  // alone, and down. Pairing borrows the bar's active color, because a code
  // on screen with a three-minute fuse is the one thing worth interrupting for.
  readonly property color barIconColor: {
    if (!bridge.running) return Qt.darker(barForeground, 2.1)
    if (!linked) return Qt.darker(barForeground, 1.55)
    return barForeground
  }

  readonly property string statusLine: {
    if (!bridge.loaded) return "NOT INSTALLED"
    if (!bridge.running) return "DAEMON STOPPED"
    if (pairing) return "WAITING FOR A PHONE"
    if (linked) return root.heroPhraseText
    if (!paired) return "NO PHONE PAIRED"
    return "PHONE OFFLINE"
  }

  readonly property string linkText: {
    if (!bridge.running) return "down"
    if (!linked) return "listening"
    return phone && phone.secure === false ? "plaintext" : "encrypted"
  }

  /* ── actions ───────────────────────────────────────────────────────── */

  readonly property var actions: buildActions()

  function buildActions() {
    var list = [{ key: "pair", label: "Pair", icon: "󰐗", tooltip: "Show a pairing QR code" }]
    if (bridge.running) list.push({ key: "send", label: "Send", icon: "󰈤", tooltip: "Pick a file to send to the phone" })
    list.push({ key: "inbox", label: "Inbox", icon: "󰉋", tooltip: "Open the folder phones drop files into" })
    list.push(bridge.serviceEnabled
      ? { key: "service", label: "Autostart", icon: "󰄲", tooltip: "Runs at login — click to stop that" }
      : { key: "service", label: "Autostart", icon: "󰄱", tooltip: "Run the daemon at login" })
    return list
  }

  function runAction(key) {
    if (key === "pair") bridge.pair()
    else if (key === "send") bridge.sendFile()
    else if (key === "inbox") bridge.openInbox()
    else if (key === "service") bridge.toggleAutostart()
  }

  /* ── cursor ────────────────────────────────────────────────────────── */

  function sectionsBelow(section) {
    if (section === "header") return bridge.devices.length > 0 ? "devices" : "actions"
    if (section === "devices") return "actions"
    return ""
  }

  function ensureCursor() {
    if (deviceIndex >= bridge.devices.length) deviceIndex = Math.max(0, bridge.devices.length - 1)
    if (deviceIndex < 0) deviceIndex = 0
    if (actionIndex >= actions.length) actionIndex = Math.max(0, actions.length - 1)
    if (actionIndex < 0) actionIndex = 0
    if (focusSection === "devices" && bridge.devices.length === 0) focusSection = "actions"
  }

  function moveCursor(dx, dy) {
    cursorActive = true
    ensureCursor()

    if (dx !== 0 && focusSection === "actions") {
      actionIndex = Math.max(0, Math.min(actions.length - 1, actionIndex + dx))
      return
    }
    if (dy === 0) return

    if (focusSection === "header") {
      if (dy > 0) focusSection = sectionsBelow("header")
      return
    }
    if (focusSection === "devices") {
      var next = deviceIndex + dy
      if (next < 0) {
        focusSection = "header"
        if (panelFlick) panelFlick.contentY = 0
        return
      }
      if (next >= bridge.devices.length) {
        focusSection = "actions"
        return
      }
      deviceIndex = next
      scrollCursorIntoView()
      return
    }
    if (focusSection === "actions" && dy < 0) {
      focusSection = bridge.devices.length > 0 ? "devices" : "header"
      deviceIndex = Math.max(0, bridge.devices.length - 1)
    }
  }

  function activateCursor() {
    ensureCursor()
    if (focusSection === "header") bridge.toggleDaemon()
    else if (focusSection === "devices") bridge.pair()
    else if (focusSection === "actions") runAction(actions[actionIndex].key)
  }

  function deleteSelected() {
    ensureCursor()
    if (focusSection !== "devices") return
    if (deviceIndex < bridge.devices.length) bridge.unpair(bridge.devices[deviceIndex])
  }

  function setHeaderCursor() {
    cursorActive = true
    focusSection = "header"
    if (panelFlick) panelFlick.contentY = 0
  }

  function setDeviceCursor(index) {
    cursorActive = true
    focusSection = "devices"
    deviceIndex = index
    scrollCursorIntoView()
  }

  function setActionCursor(index) {
    cursorActive = true
    focusSection = "actions"
    actionIndex = index
  }

  function scrollCursorIntoView() {
    if (focusSection !== "devices" || !panelFlick || !deviceColumn) return
    if (deviceIndex < 0 || deviceIndex >= deviceColumn.children.length) return
    var item = deviceColumn.children[deviceIndex]
    Qt.callLater(function () {
      if (!item || !panelFlick) return
      var margin = Style.space(6)
      var top = item.mapToItem(panelFlick.contentItem, 0, 0).y
      var bottom = top + item.height
      var viewTop = panelFlick.contentY
      var maxY = Math.max(0, panelFlick.contentHeight - panelFlick.height)
      if (top < viewTop + margin) panelFlick.contentY = Math.max(0, top - margin)
      else if (bottom > viewTop + panelFlick.height - margin)
        panelFlick.contentY = Math.min(maxY, bottom + margin - panelFlick.height)
    })
  }

  /* ── lifecycle ─────────────────────────────────────────────────────── */

  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  // A machine that has never paired a phone can keep its bar clean.
  visible: !(root.setting("hideWhenUnpaired", false) === true && bridge.loaded && !paired && !bridge.running)

  onOpenedChanged: {
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
      onMoveRequested: function (dx, dy) {
        if (!root.cursorActive) { root.cursorActive = true; return }
        root.moveCursor(dx, dy)
      }
      onActivateRequested: if (root.cursorActive) root.activateCursor()
      onCloseRequested: root.close()
      onDeleteRequested: root.deleteSelected()
      onTabRequested: function (direction) { root.switchPanel(direction) }
      onTextKey: function (t) {
        var key = String(t).toLowerCase()
        if (key === "p") bridge.pair()
        else if (key === "s") bridge.sendFile()
        else if (key === "i") bridge.openInbox()
        else if (key === "r") bridge.refresh()
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
            function focusHero() { root.setHeaderCursor() }

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

          /* ── the numbers ────────────────────────────────────────── */

          GridLayout {
            visible: bridge.loaded
            width: parent.width
            columns: 4
            columnSpacing: Style.space(20)
            rowSpacing: Style.spacing.labelGap

            InfoLabel { text: "Link" }
            DetailValue {
              text: root.linkText
              color: bridge.running && root.phone && root.phone.secure === false ? root.urgent : root.foreground
            }
            InfoLabel { text: "Notified" }
            DetailValue { text: String(bridge.counters.notifications || 0) }

            InfoLabel { text: "Battery" }
            DetailValue {
              text: root.phone && root.phone.battery
                ? Model.batteryGlyph(root.phone.battery) + "  " + Model.batteryText(root.phone.battery)
                : "--"
            }
            InfoLabel { text: root.linked ? "Connected" : "Last seen" }
            DetailValue {
              text: root.linked
                ? Model.uptime(root.phone.since, root.now)
                : (root.phone ? Model.since(root.phone.lastSeen, root.now) : "--")
            }

            InfoLabel { text: "Received" }
            DetailValue { text: String(bridge.counters.filesIn || 0) + " files" }
            InfoLabel { text: "Sent" }
            DetailValue { text: String(bridge.counters.filesOut || 0) + " files" }

            InfoLabel { text: "Transport" }
            DetailValue {
              text: bridge.tls ? "tls · pinned" : "plain"
              color: bridge.tls ? root.foreground : root.dim
            }
            InfoLabel { text: "Missed" }
            DetailValue {
              text: String(bridge.phone.missed || 0)
              color: (bridge.phone.missed || 0) > 0 ? root.urgent : root.foreground
            }

            InfoLabel { text: "Bluetooth" }
            DetailValue {
              Layout.columnSpan: 3
              text: Model.handsfreeText(bridge.bluetooth)
              color: bridge.bluetooth && bridge.bluetooth.connected === true ? root.foreground : root.dim
            }

            InfoLabel { text: "iPhone" }
            DetailValue {
              Layout.columnSpan: 3
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

          /* ── paired phones ──────────────────────────────────────── */

          PanelSeparator {
            visible: bridge.devices.length > 0
            foreground: root.foreground
          }

          Column {
            visible: bridge.devices.length > 0
            width: parent.width
            spacing: Style.space(10)

            PanelSectionHeader {
              text: "PAIRED PHONES"
              foreground: root.foreground
              fontFamily: root.fontFamily
            }

            Column {
              id: deviceColumn
              width: parent.width
              spacing: Style.space(6)

              Repeater {
                model: bridge.devices

                DeviceRow {
                  required property var modelData
                  required property int index
                  width: deviceColumn.width
                  device: modelData
                  rowIndex: index
                }
              }
            }
          }

          /* ── recent transfers ───────────────────────────────────── */

          PanelSeparator {
            visible: bridge.transfers.length > 0
            foreground: root.foreground
          }

          // Three sources feed this one list — an Android build over the LAN,
          // a hands-free link, and an iPhone's own notifications over low
          // energy — and none of them is guaranteed, so the section stays out
          // of the way entirely until something arrives.
          Column {
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

          Column {
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

          Column {
            width: parent.width
            spacing: Style.space(10)

            PanelSectionHeader {
              text: "ACTIONS"
              foreground: root.foreground
              fontFamily: root.fontFamily
            }

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
    }
  }

  /* ── the hero's rotating phrase ──────────────────────────────────── */

  Timer {
    interval: 2800
    running: root.opened && root.linked
    repeat: true
    onTriggered: phraseSwap.restart()
  }

  SequentialAnimation {
    id: phraseSwap
    PropertyAnimation {
      target: hero; property: "metaOpacity"
      to: 0.0; duration: 180; easing.type: Easing.OutQuad
    }
    ScriptAction {
      script: root.phraseIndex = (root.phraseIndex + 1) % root.activePhrases.length
    }
    PropertyAnimation {
      target: hero; property: "metaOpacity"
      to: 1.0; duration: 260; easing.type: Easing.InQuad
    }
  }

  /* ── row components ──────────────────────────────────────────────── */

  component DeviceRow: CursorSurface {
    id: deviceRow
    property var device: null
    property int rowIndex: 0
    readonly property bool isOnline: !!device && device.online === true

    hasCursor: root.cursorActive && root.focusSection === "devices" && root.deviceIndex === rowIndex
    foreground: root.foreground
    implicitHeight: deviceContent.implicitHeight + Style.spacing.rowPaddingX

    MouseArea {
      anchors.fill: parent
      hoverEnabled: true
      cursorShape: Qt.PointingHandCursor
      onEntered: root.setDeviceCursor(deviceRow.rowIndex)
      onClicked: bridge.pair()
    }

    RowLayout {
      anchors.left: parent.left
      anchors.right: parent.right
      anchors.verticalCenter: parent.verticalCenter
      anchors.leftMargin: Style.space(10)
      anchors.rightMargin: Style.space(10)
      spacing: Style.space(8)

      Text {
        text: Model.deviceGlyph(deviceRow.device ? deviceRow.device.platform : "")
        color: deviceRow.isOnline ? root.foreground : root.dim
        font.family: root.fontFamily
        font.pixelSize: Style.font.icon
        Layout.alignment: Qt.AlignVCenter
      }

      ColumnLayout {
        id: deviceContent
        Layout.fillWidth: true
        spacing: Style.space(1)

        Text {
          Layout.fillWidth: true
          text: deviceRow.device ? String(deviceRow.device.name) : ""
          color: root.foreground
          font.family: root.fontFamily
          font.pixelSize: Style.font.body
          elide: Text.ElideRight
        }

        Text {
          Layout.fillWidth: true
          text: {
            if (!deviceRow.device) return ""
            var parts = []
            var platform = Model.platformLabel(deviceRow.device.platform)
            if (platform !== "") parts.push(platform)
            if (deviceRow.isOnline) {
              parts.push(deviceRow.device.address ? String(deviceRow.device.address).replace("::ffff:", "") : "connected")
              if (deviceRow.device.battery) parts.push(Model.batteryText(deviceRow.device.battery))
            } else {
              parts.push(Model.since(deviceRow.device.lastSeen, root.now))
            }
            return parts.join(" · ")
          }
          color: root.dim
          font.family: root.fontFamily
          font.pixelSize: Style.font.caption
          elide: Text.ElideRight
        }
      }

      // A filled dot for a live link, a hollow one for a phone that is merely
      // remembered. It reads at a glance and costs no width.
      Text {
        text: deviceRow.isOnline ? "●" : "○"
        color: deviceRow.isOnline ? root.foreground : root.dim
        font.family: root.fontFamily
        font.pixelSize: Style.font.caption
        Layout.alignment: Qt.AlignVCenter
      }

      PanelActionButton {
        iconText: "󰅖"
        tooltipText: "Unpair " + (deviceRow.device ? deviceRow.device.name : "")
        foreground: root.foreground
        hoverColor: root.urgent
        fontFamily: root.fontFamily
        enabled: !bridge.busy
        Layout.alignment: Qt.AlignVCenter
        onClicked: bridge.unpair(deviceRow.device)
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
