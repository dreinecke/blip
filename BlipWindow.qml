import QtQuick
import Quickshell
import Quickshell.Io
import Quickshell.Hyprland
import qs.Commons
import qs.Commons as Commons

FloatingWindow {
  id: win
  property var hostWidget: null
  // Invariant: the title stays the "Blip" prefix ("Blip (3)" while unread
  // exists) — selectors match the prefix.
  property string restorationTitle: ""
  title: restorationTitle || "Blip" + (hostWidget && hostWidget.unread > 0 ? " (" + hostWidget.unread + ")" : "")
  // Invariant: same fill as Omarchy's other FloatingWindow (dev gallery).
  // A 0.70 alpha assumed Hyprland blur, which Omarchy 4.x ships off.
  color: Commons.Color.background
  implicitWidth: 1040
  implicitHeight: 720
  minimumSize: Qt.size(720, 480)
  visible: false
  // Invariant: focused means Hyprland's active toplevel is this window,
  // matched by EXACT title — a terminal titled "Blip documentation" used to
  // count as this window being read (Astra A#6). A visible-but-unfocused
  // window keeps refreshing but does not mark read.
  readonly property bool focused: visible && Hyprland.activeToplevel !== null
    && String(Hyprland.activeToplevel.title || "") === win.title

  readonly property bool inThread: view.inThread
  readonly property var active: view.active
  readonly property bool loading: view.loading
  readonly property bool rendered: view.rendered
  readonly property string seenTs: view.seenTs
  readonly property bool peeking: view.peeking
  readonly property string activeLastTs: view.activeLastTs
  function openThread(t) { view.openThread(t) }
  function shareLink(url) { return view.shareLink(url) }
  function pushReload() { view.pushReload() }
  // Invariant: the automation surface when no bar popout exists (icon
  // hidden, C-006). composeAndSend keeps the popout's blind-send guard — a
  // closed surface remembers its last thread, and IPC must never send into it
  // blind.
  function composeAndSend(text) {
    if (!win.visible) return "window closed — open the conversation first"
    return view.composeAndSend(text)
  }
  function bubbleModel() { return view.bubbleModel() }
  function searchFor(query) { return view.searchFor(query) }
  function newChatFor(query) { return view.newChatFor(query) }
  function navText(event) {
    if (event.key === Qt.Key_Slash) return "/"
    if (event.key === Qt.Key_N) return "n"
    var typed = event.text
    if (typed && typed.length > 0) return typed
    if (event.modifiers & (Qt.ShiftModifier | Qt.ControlModifier | Qt.AltModifier | Qt.MetaModifier))
      return ""
    if (event.key >= Qt.Key_1 && event.key <= Qt.Key_9) return String.fromCharCode(event.key)
    return typed
  }

  readonly property string stateDir: Quickshell.env("HOME") + "/.local/state/blip"
  property bool restoring: true
  property bool restoreReady: false
  property bool explicitShow: false
  property string savedWorkspace: ""
  readonly property var ownToplevel: Hyprland.toplevels.values.find(function(t) {
    return Number(t.lastIpcObject.pid) === Quickshell.processId && t.title === win.title
  }) || null
  readonly property string currentWorkspace: ownToplevel && ownToplevel.workspace
    ? String(ownToplevel.workspace.name) : ""
  Connections {
    target: Hyprland
    function onRawEvent(event) {
      // Invariant: new toplevels initially have no IPC metadata (including
      // their PID).
      if (event.name === "openwindow" || event.name === "movewindowv2") Hyprland.refreshToplevels()
    }
  }
  onCurrentWorkspaceChanged: {
    if (currentWorkspace !== "") { savedWorkspace = currentWorkspace; saveWinState() }
  }
  onOwnToplevelChanged: {
    if (ownToplevel && restorationTitle !== "") Qt.callLater(function() { restorationTitle = "" })
  }
  function requestShow() {
    explicitShow = true
    if (restoreReady) visible = true
  }
  Process {
    id: prepareRestore
    command: ["bun", Qt.resolvedUrl("window-restore.ts").toString().replace(/^file:\/\//, ""), win.savedWorkspace]
    stdout: StdioCollector {
      onStreamFinished: {
        try { win.restorationTitle = JSON.parse(text).title || "" } catch (e) { }
      }
    }
    onExited: (code, status) => {
      win.restoreReady = true
      win.restoring = false
      if (code === 0 || win.explicitShow) win.visible = true
      if (win.hostWidget && win.visible) win.hostWidget.refresh(true, false)
    }
  }
  FileView {
    id: winState
    path: win.stateDir + "/window.json"
    blockLoading: true
    printErrors: false
  }
  function saveWinState() {
    if (restoring) return
    var j = JSON.stringify({ visible: visible, width: Math.round(width), height: Math.round(height), workspace: savedWorkspace })
    // Invariant: detached, because a Process object drops writes while a
    // previous one is alive, and hideWindow() destroying this window mid-write
    // lost the "hidden" state
    Quickshell.execDetached(["sh", "-c",
      "umask 077 && mkdir -p \"$1\" && printf '%s' \"$2\" > \"$1/window.json.tmp.$$\" && mv \"$1/window.json.tmp.$$\" \"$1/window.json\"",
      "blip", stateDir, j])
  }
  Component.onCompleted: {
    try {
      var d = JSON.parse(winState.text())
      if (d && d.width >= 720 && d.height >= 480) { implicitWidth = d.width; implicitHeight = d.height }
      if (d && typeof d.workspace === "string") savedWorkspace = d.workspace
      if (d && d.visible === true) { prepareRestore.running = true; return }
    } catch (e) { /* first run */ }
    Qt.callLater(function() { win.restoring = false; win.restoreReady = true; if (win.explicitShow) win.visible = true })
  }
  onVisibleChanged: { saveWinState(); if (visible) Qt.callLater(view.focusDefault) }
  onWidthChanged: if (visible) saveWinState()
  onHeightChanged: if (visible) saveWinState()

  FocusScope {
    id: scope
    anchors.fill: parent
    focus: true

    Keys.priority: Keys.AfterItem
    Keys.onPressed: function(event) {
      if (event.key === Qt.Key_Escape) {
        if (!view.unwind()) win.visible = false
        event.accepted = true
        return
      }
      if (view.catchNavText(win.navText(event))) event.accepted = true
    }

    Item {
      id: navCatcher
      anchors.fill: parent
      focus: true
      Keys.priority: Keys.BeforeItem
      Keys.onPressed: function(event) {
        if (event.key === Qt.Key_Escape && view.catchEscape()) {
          event.accepted = true
          return
        }
        if (view.catchNavKey(event.key)) {
          event.accepted = true
          return
        }
        if (view.catchNavText(win.navText(event))) event.accepted = true
      }

      BlipView {
        id: view
        anchors.fill: parent
        // Invariant: inset from the window edge — Hyprland rounds the corners,
        // and text flush to the border got clipped by the radius (Fred).
        anchors.margins: Style.space(12)
        hostWidget: win.hostWidget
        splitView: true
        surfaceOpen: win.visible
        readActive: win.focused
        foreground: Commons.Color.foreground
        urgent: Commons.Color.urgent
        themeFont: Style.font.family
        onNavigationFocusRequested: navCatcher.forceActiveFocus()
      }
    }
  }
}
