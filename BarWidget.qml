import QtQuick
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Ui

// blip — iMessage in the bar.
//
// iMessage is macOS-only: chat.db and the AppleScript send path both live on
// the Mac. This Linux box is a thin client over a multiplexed SSH socket (~47ms warm). This
// widget owns the single poller; the panel reads its state rather than running
// its own collector.
//
// Badge counts EVERY unread. Toasts fire only for allowlisted handles
// (~/.config/blip/allowlist.json) — chat.db is mostly bank alerts and 2FA codes,
// and none of that deserves an interruption.
//
// Left-click = panel · middle-click = refresh · right-click = mark all read.
BarWidget {
  id: root
  moduleName: "nixfred.blip"

  readonly property string home: Quickshell.env("HOME")
  readonly property string collectorPath:
    decodeURIComponent(Qt.resolvedUrl("collector.ts").toString().replace(/^file:\/\//, ""))

  // ---- collector state
  property var threads: []           // [{chat,name,handle,service,last_ts,last_text,last_from_me,count,unread}]
  property string threadsJson: ""    // last assigned list, for no-op detection
  property int unread: 0
  property bool online: false        // fnix reachable
  property bool healthy: false       // last collector run parsed cleanly
  property string lastError: ""
  property string lastRun: ""

  readonly property bool hasUnread: unread > 0

  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  function open() { if (panelLoader.item) panelLoader.item.open() }
  function close() { if (panelLoader.item) panelLoader.item.close() }
  function toggle() { if (panelLoader.item) panelLoader.item.toggle() }
  function show(chat) {
    if (!panelLoader.item) return
    panelLoader.item.open()
    // `qs ipc call` rejects a leading "+" as a flag, so accept the bare digits too.
    // Exact match FIRST, alias second: when both variants exist as threads,
    // the alias must never shadow the exact one (Codex HIGH, 1.2.0).
    var want = String(chat)
    var t = null
    for (var i = 0; i < threads.length; i++) {
      if (String(threads[i].chat) === want) { t = threads[i]; break }
    }
    if (!t) for (var j = 0; j < threads.length; j++) {
      if (String(threads[j].chat) === "+" + want) { t = threads[j]; break }
    }
    if (!t && /^[0-9]+$/.test(want)) want = "+" + want
    // Unknown to the current window: still open it, with the id as the name.
    panelLoader.item.openThread(t || { chat: want, handle: want, name: want })
  }

  function injectPanel() {
    var target = panelLoader.item
    if (!target) return
    target.bar = root.bar
    target.anchorItem = button
    target.hostWidget = root
  }
  onBarChanged: injectPanel()

  Loader {
    id: panelLoader
    active: true
    source: Qt.resolvedUrl("Panel.qml")
    visible: false
    onLoaded: {
      root.injectPanel()
      Qt.callLater(root.injectPanel)
    }
  }

  // ------------------------------------------------------------ collector
  // `deep` widens the fetch window for the panel; `markRead` clears the badge.
  // `readChat` clears one thread's blue dot — iMessage semantics: the dot
  // survives viewing the list and only goes when that conversation is opened.
  property var refreshQueue: []        // stateful requests are never overwritten
  property bool collectorReserved: false // a queued run owns the next event-loop turn

  function refresh(deep, markRead, readChat, seen) {
    var req = { deep: deep === true, markRead: markRead === true,
                readChat: String(readChat || ""), seen: String(seen || "") }
    if (collector.running || collectorReserved) { enqueueRefresh(req); return }
    runRefresh(req)
  }
  function enqueueRefresh(req) {
    var q = refreshQueue.slice()
    // Coalesce identical state transitions: plain refreshes merge with plain
    // refreshes, and same-chat read refreshes merge too (viewing a thread
    // makes every ping carry its readChat — without this the queue grows one
    // entry per ping). mark-all stays FIFO and is never overwritten.
    if (!req.markRead) {
      for (var i = 0; i < q.length; i++) {
        if (!q[i].markRead && q[i].readChat === req.readChat) {
          q[i] = { deep: q[i].deep || req.deep, markRead: false, readChat: req.readChat,
                   seen: req.seen > q[i].seen ? req.seen : q[i].seen }
          refreshQueue = q
          return
        }
      }
    }
    q.push(req)
    refreshQueue = q
  }
  function runRefresh(req) {
    var args = ["bun", collectorPath]
    if (req.deep) args.push("--deep")
    if (req.markRead) args.push("--mark-read")
    if (req.readChat !== "") {
      args.push("--read", req.readChat)
      if (req.seen !== "") args.push("--seen", req.seen)
    }
    collector.command = args
    collector.running = true
  }
  // ---------------------------------------------------- read consistency
  //
  // Read state truly lives in state.json and moves via collector runs — but
  // a round-trip takes ~1s, and a poll already IN FLIGHT when the user opens
  // a thread can land after it and resurrect the dot (double-flash). So a
  // read is applied OPTIMISTICALLY to the local model, and remembered in
  // localReads[chat] = the thread's last_ts at read time. Every collector
  // result is then filtered: a chat read locally stays unread=0 unless a
  // genuinely NEWER inbound message exists. Entries expire once persisted
  // state has caught up (or after 60s, whichever first).
  property var localReads: ({})

  function noteLocalRead(chat, lastTs) {
    var m = Object.assign({}, localReads)
    m[String(chat)] = { ts: String(lastTs || ""), at: Date.now() }
    localReads = m
  }

  function applyLocalReads(list) {
    var now = Date.now()
    var m = Object.assign({}, localReads)
    var dirty = false
    var out = list.map(function(t) {
      var r = m[String(t.chat)]
      if (!r) return t
      // persistence caught up (or nothing left) — retire the entry so stale
      // suppression rules can't linger for the TTL (Codex #5)
      if (t.unread === 0) { delete m[String(t.chat)]; dirty = true; return t }
      if (now - r.at > 60000) { delete m[String(t.chat)]; dirty = true; return t }
      // ANY activity newer than what was read means the collector's count is
      // fresher than this suppression — trust it (direction-free: a
      // read→inbound→outbound sequence must not hide the inbound, Codex #2)
      if (String(t.last_ts) > r.ts) return t
      return Object.assign({}, t, { unread: 0 })
    })
    if (dirty) localReads = m
    return out
  }

  function markThreadRead(chat) {
    var c = String(chat)
    var lastTs = ""
    var list = threads.map(function(t) {
      if (String(t.chat) !== c) return t
      lastTs = String(t.last_ts || "")
      return t.unread > 0 ? Object.assign({}, t, { unread: 0 }) : t
    })
    noteLocalRead(c, lastTs)
    threads = list
    unread = list.reduce(function(n, t) { return n + (Number(t.unread) || 0) }, 0)
    refresh(true, false, c, lastTs)
  }

  function markAllRead() {
    for (var i = 0; i < threads.length; i++)
      noteLocalRead(String(threads[i].chat), String(threads[i].last_ts || ""))
    threads = threads.map(function(t) {
      return t.unread > 0 ? Object.assign({}, t, { unread: 0 }) : t
    })
    unread = 0
    refresh(false, true)
  }

  /** The open conversation's chat, "" when the panel is closed or listing —
   *  refreshes carry it so a message arriving in the thread the user is
   *  LOOKING AT is counted read in the same collector run, not flashed
   *  unread and cleared a round-trip later. */
  function activeReadChat() {
    var p = panelLoader.item
    // a still-LOADING conversation is not yet read (Codex #4)
    return (p && p.opened === true && p.inThread === true && p.loading !== true)
      ? String(p.active.chat) : ""
  }
  function activeSeenTs() {
    var p = panelLoader.item
    return (p && p.opened === true && p.inThread === true) ? String(p.activeLastTs || "") : ""
  }

  Process {
    id: collector
    command: ["bun", root.collectorPath]
    stdout: StdioCollector {
      onStreamFinished: {
        // A garbled run keeps the last good thread list rather than flashing
        // the bar empty — same discipline as larry.status's session collector.
        try {
          var d = JSON.parse(text.trim())
          root.online = d.online === true
          root.lastError = String(d.error || "")
          root.lastRun = String(d.ts || "")
          if (d.ok === true) {
            // Filter through the optimistic-read ledger: a poll that was
            // already in flight when the user opened a thread must not
            // resurrect its dot for one round-trip (the double-flash).
            var list = root.applyLocalReads(Array.isArray(d.threads) ? d.threads : [])
            // Reassigning `threads` rebuilds the panel's list Repeater and
            // resets its scroll — with push, that was every few seconds.
            // Skip the assignment when nothing actually changed.
            var j = JSON.stringify(list)
            if (j !== root.threadsJson) {
              root.threadsJson = j
              root.threads = list
            }
            root.unread = list.reduce(function(n, t) { return n + (Number(t.unread) || 0) }, 0)
            root.healthy = d.persisted !== false
            if (Array.isArray(d.toast)) root.fireToasts(d.toast)
            // A send of YOURS that died — not allowlist-gated, interrupts once.
            if (Array.isArray(d.failures) && d.failures.length > 0)
              root.fireToasts(d.failures.map(function(f) {
                return { chat: f.chat, name: "⚠ Not delivered to " + f.name, text: f.text, ts: f.ts, key: f.key }
              }))
          } else {
            root.healthy = false
            if (!root.online) root.unread = 0     // offline: no honest count to show
          }
        } catch (e) {
          root.healthy = false
          root.lastError = "collector produced unparseable output"
        }
      }
    }
    onExited: function(code, status) {
      if (code !== 0) root.healthy = false
      if (root.refreshQueue.length > 0) {
        var q = root.refreshQueue.slice()
        var next = q.shift()
        root.refreshQueue = q
        root.collectorReserved = true
        Qt.callLater(function() {
          root.collectorReserved = false
          root.runRefresh(next)
        })
      }
    }
  }

  Timer {
    // With the push watcher connected this is only a safety net; without it
    // (fnix down, watcher restarting) it is the old 6 s poll.
    interval: root.watchAlive ? 60000 : 6000
    running: true
    repeat: true
    triggeredOnStart: true
    // While the panel is open keep the wide window, or the list would shrink
    // from 40 threads to 14 on the next tick.
    onTriggered: root.refresh(panelLoader.item && panelLoader.item.opened === true, false,
                              root.activeReadChat(), root.activeSeenTs())
  }

  // ------------------------------------------------- real-time push
  // `imsg watch` blocks on fnix and emits one line per chat.db change — an
  // INVALIDATION, no content (BlueFerry's design: session-visible push
  // channels carry "something changed", clients fetch privately). Each ping
  // debounces into the normal refresh, so a burst of messages costs one
  // fetch. The ssh session rides the same ControlMaster mux as everything
  // else; if it dies (sleep, network), a timer restarts it and the 6 s poll
  // resumes in the meantime.
  property bool watchAlive: false
  property int watchFails: 0
  Process {
    id: watchProc
    command: [root.home + "/bin/imsg", "watch"]
    running: true
    stdout: SplitParser {
      onRead: function(line) {
        var l = String(line).trim()
        watchLiveness.restart()          // any line proves the channel is real
        if (l === "ready") { root.watchAlive = true; root.watchFails = 0; return }
        if (l === "hb") return           // heartbeat only — no refresh
        pingDebounce.restart()
      }
    }
    onExited: {
      root.watchAlive = false
      watchLiveness.stop()
      root.watchFails = Math.min(root.watchFails + 1, 5)
      watchRestart.restart()
    }
  }
  // The server heartbeats every ~30 s; 90 s of total silence means a
  // half-open ssh channel — kill it so the restart path (and the fast poll)
  // takes over instead of trusting a dead pipe forever.
  Timer {
    id: watchLiveness
    interval: 90000
    onTriggered: { watchProc.running = false }
  }
  Timer {
    id: pingDebounce
    interval: 250
    onTriggered: {
      var panel = panelLoader.item
      // Carrying the open thread's chat means a message landing in the
      // conversation the user is READING is counted read in this same run —
      // no badge flash, no second round-trip.
      root.refresh(panel && panel.opened === true, false, root.activeReadChat(), root.activeSeenTs())
      // Reload the OPEN conversation in parallel — waiting for the collector
      // and then reloading serially added a visible second of latency.
      if (panel && panel.opened === true && typeof panel.pushReload === "function")
        panel.pushReload()
    }
  }
  Timer {
    id: watchRestart
    // Exponential backoff on consecutive failures (8s → 128s cap): a Mac
    // that is off for the night must not eat an ssh probe every 8 seconds.
    // Any successful "ready" resets the ladder.
    interval: 8000 * Math.pow(2, root.watchFails)
    onTriggered: watchProc.running = true
  }

  // ------------------------------------------------------------ toasts
  // One notify-send per allowlisted inbound message. The collector has already
  // applied the allowlist and the dedupe ring, so anything arriving here is
  // meant to interrupt. Reuses the no-focus-steal notification behaviour.
  // With --wait + actions, clicking the toast (default) or its Reply button
  // opens the panel ON that conversation, compose focused — the daemon
  // advertises the "actions" capability (verified via GetCapabilities).
  Process {
    id: notifyProc
    stdout: StdioCollector {
      onStreamFinished: {
        var action = text.trim()
        if ((action === "default" || action === "reply") && notifyProc.toastChat !== "")
          root.show(notifyProc.toastChat)
      }
    }
    property string toastChat: ""
  }
  property var toastQueue: []

  function fireToasts(list) {
    if (!list || list.length === 0) return
    var q = toastQueue.slice()
    for (var i = 0; i < list.length; i++) q.push(list[i])
    // A hung notify-send must not grow the queue forever (Codex finding #14):
    // keep the newest 20 and drop the backlog — the badge still counts them.
    if (q.length > 20) q = q.slice(q.length - 20)
    toastQueue = q
    drainToasts()
  }
  function drainToasts() {
    if (notifyProc.running || toastQueue.length === 0) return
    var q = toastQueue.slice()
    var t = q.shift()
    toastQueue = q
    var body = String(t.text || "")
    if (body.length > 220) body = body.substring(0, 217) + "…"
    notifyProc.toastChat = String(t.chat || "")
    notifyProc.command = [
      "notify-send",
      "--app-name=Blip",
      "--icon=mail-message-new",
      "--expire-time=8000",
      // --wait blocks until the toast closes and prints the chosen action.
      // Only `default` (clicking the card): the Omarchy notification daemon
      // renders no action BUTTONS and only ever invokes default — an
      // advertised Reply button would be a lie (Codex, read the daemon).
      "--wait",
      "--action=default=Open",
      "--",                                   // a name or text starting with "-" is data, not a flag
      String(t.name || t.chat || "iMessage"),
      body
    ]
    notifyProc.running = true
    // The daemon PAUSES expiry while the pointer hovers a toast, and --wait
    // waits for closure — a toast parked under a stationary cursor must not
    // dam the whole serial queue (Codex, 1.2.0). 45 s is watchdog, not UX.
    toastWatchdog.restart()
  }
  Timer {
    id: toastWatchdog
    interval: 45000
    onTriggered: if (notifyProc.running) notifyProc.running = false
  }
  Connections {
    target: notifyProc
    function onExited(code, status) { toastWatchdog.stop(); Qt.callLater(root.drainToasts) }
  }

  // ------------------------------------------------------------ IPC
  IpcHandler {
    target: root.moduleName
    function status(): string {
      return "online=" + root.online + " unread=" + root.unread
        + " threads=" + root.threads.length + " healthy=" + root.healthy
        + " push=" + root.watchAlive
        + (root.lastError !== "" ? " error=" + root.lastError : "")
    }
    function threads(): string { return JSON.stringify(root.threads) }
    function refresh(): void { root.refresh(false, false) }
    function read(): void { root.markAllRead() }
    function open(): void { root.open() }
    function close(): void { root.close() }
    function toggle(): void { root.toggle() }
    function goto(chat: string): void { root.show(chat) }
    function compose(text: string): string { return panelLoader.item ? panelLoader.item.composeAndSend(text) : "no panel" }
    function bubbles(): string { return panelLoader.item ? panelLoader.item.bubbleModel() : "[]" }
    function find(query: string): string { return panelLoader.item ? panelLoader.item.searchFor(query) : "no panel" }
    function newchat(query: string): string { return panelLoader.item ? panelLoader.item.newChatFor(query) : "no panel" }
  }

  // ------------------------------------------------------------ bar button
  function tooltip() {
    var parts = []
    if (!root.online) parts.push("fnix unreachable — iMessage bridge offline")
    else if (root.unread === 0) parts.push("No unread messages")
    else parts.push(root.unread + " unread message" + (root.unread === 1 ? "" : "s"))

    if (root.online && root.unread > 0) {
      var hot = root.threads.filter(function(t){ return t.unread > 0 }).slice(0, 4)
      for (var i = 0; i < hot.length; i++)
        parts.push("  " + hot[i].name + " (" + hot[i].unread + ")")
    }
    if (root.online && !root.healthy && root.lastError !== "") parts.push("⚠ " + root.lastError)
    return parts.join("\n") + "\nleft: threads · middle: refresh · right: mark all read"
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
      if (code === Qt.MiddleButton) root.refresh(false, false)
      else if (code === Qt.RightButton) root.markAllRead()
      else root.toggle()
    }

    Row {
      id: content
      anchors.centerIn: parent
      spacing: Style.spaceReal(4)

      Text {
        anchors.verticalCenter: parent.verticalCenter
        // Nerd Font: filled speech bubble when unread, outline when quiet,
        // slashed when the bridge is down.
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

  // Fixed cyan rather than the theme accent: several Omarchy themes use red for
  // accents, and red must stay reserved for genuine alerts (see larry.status).
  // Follows the Omarchy theme accent (falls back to cyan if the theme has none).
  readonly property color blipAccent:
    Color.accent.toString() !== Color.foreground.toString() ? Color.accent : "#5fd7ff"
}
