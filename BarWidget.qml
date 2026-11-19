import QtQuick
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Commons as Commons
import qs.Ui
import Quickshell.Hyprland

BarWidget {
  id: root
  moduleName: "nixfred.blip"

  // Invariant: one popout per session. Omarchy builds one bar — and therefore
  // one of these widgets — PER SCREEN. Only the widget on the first screen owns
  // the popout and registers as the service's panelHost; the others render
  // the same service state and hand clicks to it over IPC.
  readonly property var ownScreen: QsWindow.window ? QsWindow.window.screen : null
  readonly property bool leader: !ownScreen || Quickshell.screens.length === 0
    || String(ownScreen.name) === String(Quickshell.screens[0].name)

  // Invariant: serviceFor() only returns an ALREADY-created service, and the
  // binding cannot see it appear later, so poll until it shows up (the generic
  // service loader runs at shell start, alongside us).
  property var service: null
  function syncService() {
    var s = (bar && bar.shell) ? bar.shell.serviceFor(root.moduleName) : null
    if (s !== service) service = s
  }
  onBarChanged: { syncService(); injectPanel() }
  Component.onCompleted: syncService()
  Timer {
    interval: 1000
    running: root.service === null
    repeat: true
    triggeredOnStart: true
    onTriggered: root.syncService()
  }
  onServiceChanged: {
    if (!service) return
    if (root.leader) service.registerPanel(root)
    pushFormats()
    injectPanel()
  }
  onLeaderChanged: {
    if (!service) return
    if (root.leader) service.registerPanel(root)
    else service.unregisterPanel(root)
  }
  Component.onDestruction: if (service) service.unregisterPanel(root)

  property bool fbOnline: false
  property int fbUnread: 0
  readonly property bool online: service ? service.online : fbOnline
  readonly property int unread: service ? service.unread : fbUnread
  readonly property bool healthy: service ? service.healthy : fbOnline
  readonly property var threads: service ? service.threads : []
  readonly property string lastError: service ? service.lastError : ""
  readonly property bool hasUnread: unread > 0

  FileView {
    id: followerState
    path: Quickshell.env("HOME") + "/.local/state/blip/state.json"
    watchChanges: root.service === null
    printErrors: false
    onFileChanged: reload()
    onLoaded: if (root.service === null) {
      try {
        var st = JSON.parse(text())
        var counts = st.unreadCounts || {}
        // Invariant: one key per conversation (the ledger is folded before
        // saving), so nonzero keys are the unread conversations — the badge unit.
        var n = 0
        for (var k in counts) if ((Number(counts[k]) || 0) > 0) n++
        root.fbUnread = n; root.fbOnline = true
      } catch (e) {}
    }
  }

  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  // Invariant: clock and date patterns come from this widget's shell.json
  // entry — Qt format strings, exactly as Omarchy's clock takes `format` —
  // and are pushed to the service (which owns no bar settings) so both
  // surfaces format alike, even when only the app window is left.
  readonly property string localeTimeFormat:
    /ap/i.test(Qt.locale().timeFormat(Locale.ShortFormat)) ? "h:mm AP" : "HH:mm"
  readonly property string timeFormat: formatSetting("timeFormat", localeTimeFormat)
  readonly property string dateFormat: formatSetting("dateFormat", "MMM d")
  readonly property string dateFormatWithYear: formatSetting("dateFormatWithYear", "MMM d, yyyy")
  function formatSetting(name, fallback) { var v = String(setting(name, "")); return v === "" ? fallback : v }
  function pushFormats() {
    if (service) service.formatsFromBar(root.timeFormat, root.dateFormat, root.dateFormatWithYear)
  }
  onTimeFormatChanged: pushFormats()
  onDateFormatChanged: pushFormats()
  onDateFormatWithYearChanged: pushFormats()

  // Invariant: Omarchy's panel hotkeys (`omarchy-shell shell toggle
  // nixfred.blip`, SUPER+CTRL+<n> by bar position) find a bar widget's panel
  // through open(), close() AND this property — without it the shell logs
  // "summon: no live bar widget" and does nothing. Same line as Omarchy's
  // clock widget.
  // Invariant: the loaded popout as a REAL property. QML ids are
  // component-scoped, so the service could never reach
  // panelHost.panelLoader.item — it reads this instead, and the binding
  // tracks the Loader's item as it comes and goes.
  readonly property var panel: panelLoader.item
  readonly property bool opened: panelLoader.item ? panelLoader.item.opened === true : false
  function open() { if (panelLoader.item) panelLoader.item.open() }
  function close() { if (panelLoader.item) panelLoader.item.close() }
  function toggle() { if (panelLoader.item) panelLoader.item.toggle() }

  function injectPanel() {
    var target = panelLoader.item
    if (!target || !service) return
    target.bar = root.bar
    target.anchorItem = button
    // Invariant: barHost is the panel's Omarchy identity (owner,
    // switchPanelFrom must name the bar slot's activeItem); hostWidget is
    // the service (message state and actions). The two are not one object.
    target.barHost = root
    target.hostWidget = service
  }

  Loader {
    id: panelLoader
    active: root.leader && root.service !== null
    source: Qt.resolvedUrl("Panel.qml")
    visible: false
    onLoaded: {
      root.injectPanel()
      Qt.callLater(root.injectPanel)
    }
  }

  // Invariant: single click = panel, opening immediately with no
  // double-click lag; a second click within the double-click window closes
  // the panel and opens the APP.
  Timer { id: dblClick; interval: 320 }
  function leftClick() {
    if (!root.leader) {
      // Invariant: a follower bar asks the service (only it answers IPC)
      if (dblClick.running) { dblClick.stop(); Quickshell.execDetached(["qs", "-p", "/usr/share/omarchy/shell", "ipc", "call", root.moduleName, "app"]); return }
      dblClick.restart()
      Quickshell.execDetached(["qs", "-p", "/usr/share/omarchy/shell", "ipc", "call", root.moduleName, "toggle"])
      return
    }
    if (!service) return
    if (dblClick.running) {
      dblClick.stop()
      service.showApp()
      return
    }
    dblClick.restart()
    root.toggle()
  }

  function tooltip() {
    var parts = []
    if (!root.online) parts.push("Mac unreachable — iMessage bridge offline")
    else if (root.unread === 0) parts.push("No unread conversations")
    else parts.push(root.unread + " unread conversation" + (root.unread === 1 ? "" : "s"))

    if (root.online && root.unread > 0) {
      var hot = root.threads.filter(function(t){ return t.unread > 0 }).slice(0, 4)
      for (var i = 0; i < hot.length; i++)
        parts.push("  " + hot[i].name + " (" + hot[i].unread + ")")
    }
    if (root.online && !root.healthy && root.lastError !== "") parts.push("⚠ " + root.lastError)
    return parts.join("\n") + "\nclick: threads · double-click: app · middle: refresh · right: mark all read"
  }

  WidgetButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    text: ""
    hasVisualContent: true
    labelVisible: false
    keepSpace: true
    fixedWidth: content.implicitWidth + Style.spaceReal(horizontalMargin) * 2
    dimmed: !root.online
    active: root.hasUnread
    useActiveColor: false
    tooltipText: root.tooltip()
    onPressed: function(code) {
      if (!root.leader && code !== Qt.LeftButton) {
        // Invariant: a follower bar never starts its own collector — a refresh
        // or mark-all begun HERE was a second collector racing the service over
        // state.json (Astra #10). Ask the service, like leftClick. `read` is
        // automation-gated, so with automation=off this is a no-op.
        Quickshell.execDetached(["qs", "-p", "/usr/share/omarchy/shell", "ipc", "call",
                                 root.moduleName, code === Qt.RightButton ? "read" : "refresh"])
        return
      }
      if (!service) return
      if (code === Qt.MiddleButton) service.refresh(service.anySurfaceOpen(), false)
      else if (code === Qt.RightButton) service.markAllRead()
      else root.leftClick()
    }

    Row {
      id: content
      anchors.centerIn: parent
      spacing: Style.spaceReal(4)

      Text {
        anchors.verticalCenter: parent.verticalCenter
        // Invariant: the icon language — filled speech bubble when unread,
        // outline when quiet, slashed when the bridge is down.
        text: !root.online ? "󰻞" : (root.hasUnread ? "󰭹" : "󰭻")
        textFormat: Text.PlainText
        color: root.hasUnread ? root.blipAccent : button.foreground
        font.family: button.fontFamily
        font.pixelSize: Style.font.body
        renderType: Text.NativeRendering
      }

      Text {
        anchors.verticalCenter: parent.verticalCenter
        visible: root.online && root.unread > 0
        text: root.unread > 99 ? "99+" : root.unread
        textFormat: Text.PlainText
        color: root.blipAccent
        font.family: button.fontFamily
        font.pixelSize: Style.font.bodySmall
        font.bold: true
        renderType: Text.NativeRendering
      }
    }
  }

  // Invariant: the dot and the lit glyph follow the Omarchy theme's accent,
  // so the bar reads as one piece when the theme changes. Upstream pins them
  // to iMessage blue (Fred, 2.3.3: "should ALWAYS be BLUE no matter what").
  // This fork diverges deliberately (Dave, 2026-09-13, after looking at his
  // machine): several Omarchy themes use red, and a red dot on a messaging
  // icon reads as an error. A theme with no distinct accent falls back to
  // blue rather than the foreground colour, which would hide the signal.
  readonly property bool themeHasAccent: Commons.Color.accent.toString() !== Commons.Color.foreground.toString()
  readonly property color blipAccent: themeHasAccent ? Commons.Color.accent : "#0a84ff"
}
