import QtQuick
import Quickshell
import qs.Commons

// Blip window — the "actual app": a Messages.app-style two-pane window.
//
// Hosted INSIDE the Omarchy shell (like the dev-gallery's FloatingWindow), so
// it shares the bar widget's poller, push watcher, and read-state ledger —
// no daemon, no second collector. `hostWidget` is injected by BarWidget.
//
// The content is the SAME BlipView the bar popout renders, in splitView:
// sidebar + conversation side by side, with every feature the popout has
// (tapbacks, receipts, inline photos, replies, search, composer,
// attachments). No PanelKeyCatcher here — a normal window keeps normal
// editor/Tab behavior; Esc unwinds the view (thread → list, search → list)
// and closes the window only when there is nothing left to unwind.
FloatingWindow {
  id: win
  property var hostWidget: null
  title: "Blip"
  color: Color.background
  implicitWidth: 1040
  implicitHeight: 720
  minimumSize: Qt.size(720, 480)
  visible: false

  // Proxies BarWidget relies on (same names as the popout host).
  readonly property bool inThread: view.inThread
  readonly property var active: view.active
  readonly property bool loading: view.loading
  readonly property string activeLastTs: view.activeLastTs
  function openThread(t) { view.openThread(t) }
  function pushReload() { view.pushReload() }

  onVisibleChanged: if (visible) Qt.callLater(view.focusDefault)

  FocusScope {
    id: scope
    anchors.fill: parent
    focus: true

    Keys.priority: Keys.AfterItem
    Keys.onPressed: function(event) {
      if (event.key === Qt.Key_Escape) {
        if (!view.unwind()) win.visible = false
        event.accepted = true
      }
    }

    BlipView {
      id: view
      anchors.fill: parent
      hostWidget: win.hostWidget
      splitView: true
      surfaceOpen: win.visible
      foreground: Color.foreground
      urgent: Color.urgent
      fontFamily: Style.font.family
      onNavigationFocusRequested: scope.forceActiveFocus()
    }
  }
}
