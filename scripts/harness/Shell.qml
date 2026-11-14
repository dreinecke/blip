import QtQuick
import QtQuick.Controls
import "mocks/Quickshell/Io"
import "blip" as Blip

// C-009 scratch host: the REAL BlipView.qml from ./blip (a copy of the repo
// with imports rewritten to the mocks beside this file), driven by Genome's
// real-input driver under Xvfb. No subprocess, no Quickshell instance, no Mac
// bridge, no IPC — the mock Process answers canned data.
Window {
  id: shell
  width: 420
  height: 660
  visible: true
  title: "blip-harness"
  color: "#101315"

  StubHost { id: stubHost }

  Blip.BlipView {
    id: view
    anchors.fill: parent
    hostWidget: stubHost
    surfaceOpen: true
    onNavigationFocusRequested: view.navigationKeys.forceActiveFocus()
  }
  Component.onCompleted: console.error("HARNESS loaded")
  Timer {
    interval: 2000; running: true; repeat: false
    onTriggered: console.error("HARNESS state listShowing=" + view.listShowing
      + " loading=" + view.loading + " rendered=" + view.rendered
      + " inThread=" + view.inThread + " threads=" + view.hostWidget.threads.length)
  }
}
