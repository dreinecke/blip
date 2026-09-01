import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Ui

// Blip window — the "actual app": a Messages.app-style two-pane window.
//
// Hosted INSIDE the Omarchy shell (like the dev-gallery's FloatingWindow), so
// it shares the bar widget's poller, push watcher, and read-state ledger —
// no daemon, no second collector. `hostWidget` is injected by BarWidget.
//
// v1 scope (Tier 4, step 1): sidebar with every thread + a read-only text
// conversation + compose. The rich bubble renderer (tapbacks, receipts,
// inline photos, replies) still lives in Panel.qml; step 2 extracts it into a
// shared BlipView so both surfaces render identically. Until then this pane
// is the honest, simple version.
FloatingWindow {
  id: win
  property var hostWidget: null
  title: "Blip"
  color: Color.background
  implicitWidth: 1040
  implicitHeight: 720
  minimumSize: Qt.size(720, 480)
  visible: false

  readonly property var threads: hostWidget ? hostWidget.threads : []
  readonly property bool online: hostWidget ? hostWidget.online : false
  readonly property color fg: Color.foreground
  readonly property color dim: Qt.darker(fg, 1.45)
  readonly property bool themeHasAccent: Color.accent.toString() !== Color.foreground.toString()
  readonly property color accent: themeHasAccent ? Color.accent : "#0a84ff"
  readonly property color mineText:
    (0.299 * accent.r + 0.587 * accent.g + 0.114 * accent.b) > 0.35 ? "#1a1a1a" : "#ffffff"
  readonly property color theirsFill: Qt.rgba(fg.r, fg.g, fg.b, 0.14)
  readonly property string home: Quickshell.env("HOME")
  readonly property string threadScript:
    decodeURIComponent(Qt.resolvedUrl("thread.ts").toString().replace(/^file:\/\//, ""))

  property var active: null
  property var bubbles: []
  property string bubblesJson: ""
  property bool loading: false
  property string note: ""
  property string activeLastTs: ""

  function isGroupId(c) { c = String(c || ""); return c !== "" && !/^\+?[0-9]{5,}$/.test(c) && c.indexOf("@") < 0 }
  function isSendable(t) {
    if (!t) return false
    var c = String(t.chat || "")
    if (isGroupId(c)) return /^[A-Za-z]+;[+-];.+$/.test(String(t.guid || ""))
    return /^\+?[0-9]{5,}$/.test(c) || c.indexOf("@") > 0
  }

  function openThread(t) {
    if (!t) return
    active = t
    activeLastTs = String(t.last_ts || "")
    bubbles = []
    bubblesJson = ""
    note = ""
    loading = true
    threadProc.command = ["bun", win.threadScript, String(t.chat), "120"]
    threadProc.running = true
    Qt.callLater(function() { composeField.forceActiveFocus() })
  }

  // The shared poller advanced this thread — reload (and mark read, since
  // the window is visible and the conversation is on screen).
  onThreadsChanged: {
    if (!visible || !active) return
    for (var i = 0; i < threads.length; i++) {
      var t = threads[i]
      if (String(t.chat) !== String(active.chat)) continue
      if (String(t.last_ts) !== activeLastTs && !threadProc.running) {
        activeLastTs = String(t.last_ts)
        active = t
        threadProc.command = ["bun", win.threadScript, String(t.chat), "120"]
        threadProc.running = true
      }
      return
    }
  }

  function send() {
    var text = composeField.text.trim()
    if (!active || text === "" || sendProc.running) return
    if (!isSendable(active)) { note = "read-only — group id unknown"; return }
    note = "sending…"
    var target = isGroupId(active.chat) ? ["--chat-id", String(active.guid)] : ["--to", String(active.chat)]
    sendProc.command = [win.home + "/bin/imsg-send"].concat(target).concat(["--yes", "--", text])
    sendProc.running = true
  }

  Process {
    id: threadProc
    stdout: StdioCollector {
      onStreamFinished: {
        win.loading = false
        try {
          var d = JSON.parse(text.trim())
          if (d.ok === true) {
            var list = Array.isArray(d.bubbles) ? d.bubbles : []
            var j = JSON.stringify(list)
            if (j !== win.bubblesJson) { win.bubblesJson = j; win.bubbles = list; Qt.callLater(convo.toBottom) }
            if (win.hostWidget && win.active) win.hostWidget.markThreadRead(String(win.active.chat))
          } else { win.note = String(d.error || "could not load") }
        } catch (e) { win.note = "could not load this thread" }
      }
    }
  }
  Process {
    id: sendProc
    onExited: function(code) {
      if (code === 0) { win.note = ""; composeField.text = "" }
      else win.note = code === 69 || code === 255 ? "not sent — Mac unreachable" : "send failed (exit " + code + ")"
      if (win.active && win.hostWidget) win.hostWidget.refresh(true, false)
    }
  }

  RowLayout {
    anchors.fill: parent
    spacing: 0

    // ------------------------------------------------------------ sidebar
    Rectangle {
      Layout.preferredWidth: 320
      Layout.fillHeight: true
      color: Qt.rgba(win.fg.r, win.fg.g, win.fg.b, 0.04)
      ColumnLayout {
        anchors.fill: parent
        spacing: 0
        Text {
          Layout.fillWidth: true
          text: win.online ? "Messages" : "Messages · Mac offline"
          color: win.fg
          font.family: Style.font.family
          font.pixelSize: Style.font.body
          font.bold: true
          padding: Style.space(14)
        }
        Flickable {
          id: sideFlick
          Layout.fillWidth: true
          Layout.fillHeight: true
          contentWidth: width
          contentHeight: sideCol.implicitHeight
          clip: true
          boundsBehavior: Flickable.StopAtBounds
          MouseArea {
            anchors.fill: parent; z: -1; acceptedButtons: Qt.NoButton
            onWheel: function(w) {
              var d = w.pixelDelta.y !== 0 ? w.pixelDelta.y * 3.0 : w.angleDelta.y * 4.5
              sideFlick.contentY = Math.max(0, Math.min(Math.max(0, sideFlick.contentHeight - sideFlick.height), sideFlick.contentY - d))
              w.accepted = true
            }
          }
          ColumnLayout {
            id: sideCol
            width: parent.width
            spacing: 0
            Repeater {
              model: win.threads
              delegate: Rectangle {
                required property var modelData
                readonly property bool selected: win.active && String(win.active.chat) === String(modelData.chat)
                Layout.fillWidth: true
                implicitHeight: Style.space(58)
                color: selected ? win.accent : (rowHover.hovered ? Qt.rgba(win.fg.r, win.fg.g, win.fg.b, 0.08) : "transparent")
                HoverHandler { id: rowHover }
                TapHandler { onTapped: win.openThread(modelData) }
                RowLayout {
                  anchors.fill: parent
                  anchors.leftMargin: Style.space(12); anchors.rightMargin: Style.space(12)
                  spacing: Style.space(10)
                  Rectangle {
                    width: Style.space(36); height: width; radius: width / 2
                    color: selected ? Qt.rgba(1, 1, 1, 0.25) : Qt.rgba(win.fg.r, win.fg.g, win.fg.b, 0.14)
                    Text {
                      anchors.centerIn: parent
                      text: { var n = String(modelData.name || ""); var p = n.split(/\s+/).filter(Boolean); return ((p[0] || "#")[0] + (p.length > 1 ? p[p.length - 1][0] : "")).toUpperCase() }
                      color: selected ? win.mineText : win.fg
                      font.family: Style.font.family; font.pixelSize: Style.font.caption; font.bold: true
                    }
                  }
                  ColumnLayout {
                    Layout.fillWidth: true
                    spacing: 2
                    RowLayout {
                      Layout.fillWidth: true
                      Text {
                        Layout.fillWidth: true
                        text: String(modelData.name || modelData.chat)
                        elide: Text.ElideRight
                        color: selected ? win.mineText : win.fg
                        font.family: Style.font.family; font.pixelSize: Style.font.bodySmall
                        font.bold: (modelData.unread || 0) > 0
                      }
                      Text {
                        text: String(modelData.last_ts || "").slice(11, 16)
                        color: selected ? win.mineText : win.dim
                        font.family: Style.font.family; font.pixelSize: Style.font.caption
                      }
                    }
                    Text {
                      Layout.fillWidth: true
                      text: (modelData.last_from_me ? "You: " : "") + String(modelData.last_text || "").replace(/￼/g, "📎")
                      elide: Text.ElideRight
                      color: selected ? win.mineText : win.dim
                      font.family: Style.font.family; font.pixelSize: Style.font.caption
                    }
                  }
                  Rectangle {
                    visible: (modelData.unread || 0) > 0 && !selected
                    width: Style.space(9); height: width; radius: width / 2
                    color: win.accent
                  }
                }
              }
            }
          }
        }
      }
    }

    Rectangle { Layout.preferredWidth: 1; Layout.fillHeight: true; color: Qt.rgba(win.fg.r, win.fg.g, win.fg.b, 0.12) }

    // ------------------------------------------------------- conversation
    ColumnLayout {
      Layout.fillWidth: true
      Layout.fillHeight: true
      spacing: 0

      Text {
        Layout.fillWidth: true
        text: win.active ? String(win.active.name || win.active.chat) : "Select a conversation"
        color: win.fg
        font.family: Style.font.family; font.pixelSize: Style.font.body; font.bold: true
        padding: Style.space(14)
      }
      Rectangle { Layout.fillWidth: true; Layout.preferredHeight: 1; color: Qt.rgba(win.fg.r, win.fg.g, win.fg.b, 0.12) }

      Flickable {
        id: convo
        Layout.fillWidth: true
        Layout.fillHeight: true
        contentWidth: width
        contentHeight: convoCol.implicitHeight + Style.space(24)
        clip: true
        boundsBehavior: Flickable.StopAtBounds
        function toBottom() { contentY = Math.max(0, contentHeight - height) }
        MouseArea {
          anchors.fill: parent; z: -1; acceptedButtons: Qt.NoButton
          onWheel: function(w) {
            var d = w.pixelDelta.y !== 0 ? w.pixelDelta.y * 3.0 : w.angleDelta.y * 4.5
            convo.contentY = Math.max(0, Math.min(Math.max(0, convo.contentHeight - convo.height), convo.contentY - d))
            w.accepted = true
          }
        }
        ColumnLayout {
          id: convoCol
          width: parent.width - Style.space(24)
          x: Style.space(12); y: Style.space(12)
          spacing: Style.space(3)
          Text {
            Layout.fillWidth: true
            visible: win.loading
            text: "loading…"; horizontalAlignment: Text.AlignHCenter
            color: win.dim; font.family: Style.font.family; font.pixelSize: Style.font.caption
          }
          Repeater {
            model: win.bubbles
            delegate: ColumnLayout {
              id: b
              required property var modelData
              readonly property bool mine: modelData.from_me === true
              Layout.fillWidth: true
              spacing: 2
              Text {
                Layout.fillWidth: true
                visible: String(modelData.day || "") !== ""
                text: String(modelData.day || ""); horizontalAlignment: Text.AlignHCenter
                color: win.dim; font.family: Style.font.family; font.pixelSize: Style.font.caption; font.bold: true
                topPadding: Style.space(10); bottomPadding: Style.space(4)
              }
              RowLayout {
                Layout.fillWidth: true
                Layout.topMargin: modelData.groupStart ? Style.space(6) : 0
                spacing: 0
                Item { Layout.fillWidth: true; visible: b.mine }
                Rectangle {
                  Layout.preferredWidth: Math.min(Math.ceil(bt.implicitWidth) + Style.space(22), Math.round(convo.width * 0.7))
                  Layout.preferredHeight: Math.ceil(bt.contentHeight) + Style.space(14)
                  radius: Style.space(16)
                  color: b.mine ? win.accent : win.theirsFill
                  TextEdit {
                    id: bt
                    x: Style.space(11); y: Style.space(7)
                    width: parent.width - Style.space(22)
                    text: String(modelData.text || "") || ((modelData.attachments || []).length > 0 ? "📎 " + String(modelData.attachments[0].name || "attachment") : "")
                    textFormat: TextEdit.PlainText; wrapMode: TextEdit.Wrap
                    readOnly: true; selectByMouse: true
                    color: b.mine ? win.mineText : win.fg
                    font.family: Style.font.family; font.pixelSize: Style.font.bodySmall
                  }
                }
                Item { Layout.fillWidth: true; visible: !b.mine }
              }
              RowLayout {
                Layout.fillWidth: true
                visible: String(modelData.time || "") !== "" || modelData.failed === true
                spacing: 0
                Item { Layout.fillWidth: true; visible: b.mine }
                Text {
                  text: (modelData.failed === true ? "⚠ Not Delivered · " : "") + String(modelData.time || "")
                       + (String(modelData.receipt || "") !== "" ? "  ·  " + modelData.receipt : "")
                  color: modelData.failed === true ? Color.urgent : win.dim
                  font.family: Style.font.family; font.pixelSize: Style.font.caption
                  bottomPadding: Style.space(4)
                }
                Item { Layout.fillWidth: true; visible: !b.mine }
              }
            }
          }
        }
      }

      Rectangle { Layout.fillWidth: true; Layout.preferredHeight: 1; color: Qt.rgba(win.fg.r, win.fg.g, win.fg.b, 0.12) }
      RowLayout {
        Layout.fillWidth: true
        Layout.margins: Style.space(10)
        spacing: Style.space(8)
        TextField {
          id: composeField
          Layout.fillWidth: true
          enabled: win.online && win.isSendable(win.active)
          placeholderText: !win.active ? "select a conversation" : win.isSendable(win.active) ? "iMessage" : "read-only — group id unknown"
          foreground: win.fg
          accent: win.accent
          font.family: Style.font.family; font.pixelSize: Style.font.bodySmall
          onAccepted: win.send()
        }
        Rectangle {
          width: Style.space(30); height: width; radius: width / 2
          color: composeField.text.trim() !== "" ? win.accent : Qt.rgba(win.fg.r, win.fg.g, win.fg.b, 0.15)
          Text { anchors.centerIn: parent; text: "↑"; color: composeField.text.trim() !== "" ? win.mineText : win.dim; font.bold: true; font.family: Style.font.family }
          TapHandler { onTapped: win.send() }
        }
      }
      Text {
        Layout.fillWidth: true
        visible: win.note !== ""
        text: win.note
        color: win.note === "sending…" ? win.dim : Color.urgent
        font.family: Style.font.family; font.pixelSize: Style.font.caption
        leftPadding: Style.space(12); bottomPadding: Style.space(6)
      }
    }
  }
}
