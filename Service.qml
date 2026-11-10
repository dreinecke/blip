import QtQuick
import Quickshell
import Quickshell.Io
import Quickshell.Hyprland

// blip — the always-on half of the plugin (C-006).
//
// iMessage is macOS-only: chat.db and the AppleScript send path both live on
// the Mac. This Linux box is a thin client over a multiplexed SSH socket (~47ms warm).
// This service owns the single poller, the push watchers, toasts, security-code
// handling, the app window and IPC. Omarchy loads it as a singleton whenever
// the plugin is enabled (shell.json plugins[]), INDEPENDENT of the bar widget:
// hiding Blip's bar icon must never switch off iMessage (9 Nov 2026, Q-047).
//
// The bar popout is bar-anchored, so it stays in BarWidget.qml, which registers
// itself here as panelHost. Everything that used to touch the popout directly
// goes through that reference, with the app window as the fallback surface when
// no bar widget exists (icon hidden): a toast click then opens the window.
//
// Left-click = panel · double-click = the app window · middle-click = refresh · right-click = mark all read.
Item {
  id: root
  visible: false
  width: 0
  height: 0

  // Injected by Omarchy's service loader (shell.qml ensureService): the scoped
  // PluginShellApi, the public manifest, and the registries. Declared so the
  // injections land; the machinery below does not need to read them.
  property var shell: null
  property var manifest: null
  property var pluginRegistry: null
  property var barWidgetRegistry: null

  readonly property string moduleName: "nixfred.blip"
  readonly property string home: Quickshell.env("HOME")
  readonly property string collectorPath:
    decodeURIComponent(Qt.resolvedUrl("collector.ts").toString().replace(/^file:\/\//, ""))

  // The bar widget that owns the popout (the leader screen's BarWidget). Set
  // via registerPanel(); null while the icon is hidden or before the first
  // bar widget completes. All popout access in this file goes through it.
  property var panelHost: null
  function registerPanel(host) { panelHost = host }
  function unregisterPanel(host) { if (panelHost === host) panelHost = null }
  readonly property var popout: panelHost ? panelHost.panel : null

  // Clock and date patterns, pushed from the bar widget's shell.json entry by
  // formatsFromBar() — the service has no bar settings of its own. Defaults
  // follow the locale, exactly as the old bar-side fallback did, so a hidden
  // icon (no bar widget) still renders sensible times in the app window.
  readonly property string localeTimeFormat:
    /ap/i.test(Qt.locale().timeFormat(Locale.ShortFormat)) ? "h:mm AP" : "HH:mm"
  property string timeFormat: localeTimeFormat
  property string dateFormat: "MMM d"
  property string dateFormatWithYear: "MMM d, yyyy"
  function formatsFromBar(t, d, dy) {
    if (t) timeFormat = String(t)
    if (d) dateFormat = String(d)
    if (dy) dateFormatWithYear = String(dy)
  }

  // ---- collector state
  property var threads: []           // [{chat,name,handle,service,last_ts,last_text,last_from_me,count,unread,pinned,pin_order}]
  property string threadsJson: ""    // last assigned list, for no-op detection
  property int unread: 0
  property bool online: false        // the Mac is reachable
  property bool healthy: false       // last collector run parsed cleanly
  // Which reads reach the Mac, straight from the collector (bridge.conf's
  // push_read). "all" is the default and pushes ONLY on the mark-all gesture,
  // so reading a conversation clears it here and leaves the phone's badge —
  // by design, and indistinguishable from a broken push until status said so.
  property string readPush: ""
  property string lastError: ""
  property string lastRun: ""
  // Unsent compose text per chat id, shared by the panel and the app window.
  // In memory only: message text never lands on disk.
  property var draftCache: ({})

  readonly property bool hasUnread: unread > 0

  /** Open a conversation by chat id. Returns false when the id is not one —
   *  `goto ""` used to open a nameless thread with no header that nothing
   *  could send to, and a script with an unset variable is how you get there.
   *  The shape test is the one the toast's argv guard already uses; an id that
   *  LOOKS like a handle but is unknown still opens, on purpose, so you can
   *  start a conversation with a number you have never messaged. */
  function show(chat) {
    var raw = String(chat === undefined || chat === null ? "" : chat).trim()
    if (raw === "" || !/^[A-Za-z0-9._@:;$-]{1,256}$/.test(raw)) return false
    // `qs ipc call` rejects a leading "+" as a flag, so accept the bare digits too.
    // Exact match FIRST, alias second: when both variants exist as threads,
    // the alias must never shadow the exact one (Codex HIGH, 1.2.0).
    var want = raw
    var t = null
    for (var i = 0; i < threads.length; i++) {
      if (String(threads[i].chat) === want) { t = threads[i]; break }
    }
    if (!t) for (var j = 0; j < threads.length; j++) {
      if (String(threads[j].chat) === "+" + want) { t = threads[j]; break }
    }
    // Third pass, still before the synthetic fallback: a toast or `goto` may
    // name a MEMBER of a person-folded conversation (her WhatsApp jid while
    // the row's canonical is an iMessage id). Without this it opened an
    // ad-hoc single-channel thread and the fold looked broken.
    if (!t) for (var k = 0; k < threads.length; k++) {
      var members = threads[k].aliases || []
      if (members.indexOf(want) >= 0 || members.indexOf("+" + want) >= 0) { t = threads[k]; break }
    }
    // Only a FULL number gets a "+": short codes (99123) are their own chat id.
    if (!t && /^[0-9]{10,}$/.test(want)) want = "+" + want
    // Unknown to the current window: still open it, with the id as the name.
    var target = t || { chat: want, handle: want, name: want }
    // The popout when a bar widget exists; the app window otherwise (icon
    // hidden) — a toast click or `goto` must still land somewhere.
    if (popout) {
      popout.open()
      popout.openThread(target)
      return true
    }
    if (panelHost) return false    // a bar widget exists but its popout is not ready
    ensureWindow()
    var w = windowLoader.item
    if (!w) return false
    w.openThread(target)
    return true
  }

  /** Newest arriving link → the share sheet on whichever surface is open. */
  function shareArrivingLink(link) {
    if (!link || !link.url) return
    // Every link of the message: the sheet steps through them.
    var urls = Array.isArray(link.urls) && link.urls.length > 0 ? link.urls.map(String) : [String(link.url)]
    var w = windowLoader.item
    if (w && root.windowVisible && typeof w.shareLink === "function") { w.shareLink(urls); return }
    if (popout && popout.opened === true && typeof popout.shareLink === "function") popout.shareLink(urls)
  }

  // Popout control, used by IPC and the toast click-through. With no bar
  // widget (icon hidden) `open` falls back to the app window, so SUPER+M and
  // restored-notification clicks keep working; `close`/`toggle` follow suit.
  function open() {
    if (popout) { popout.open(); return }
    if (panelHost) return
    ensureWindow()
  }
  function close() {
    if (popout) { popout.close(); return }
    if (windowVisible) hideWindow()
  }
  function toggle() {
    if (popout) { popout.toggle(); return }
    if (panelHost) return
    toggleWindow()
  }

  // The app: a Messages-style FloatingWindow living in the same shell process,
  // sharing this service's poller/push/read ledger (no daemon needed).
  // Quickshell never re-maps a FloatingWindow after it has been hidden once
  // (visible flips true, no client appears — found 2026-08-31 when SUPER+M
  // "did nothing"). So the window is RECREATED on every show and destroyed
  // on hide; it persists its own state to ~/.local/state/blip/window.json
  // and restores size + "was open" on creation.
  Loader {
    id: windowLoader
    active: true                       // created at start so it can self-restore
    source: Qt.resolvedUrl("BlipWindow.qml")
    onLoaded: item.hostWidget = root
  }
  readonly property bool windowVisible: windowLoader.item ? windowLoader.item.visible === true : false
  function hideWindow() {
    if (!windowLoader.item) return
    windowLoader.item.visible = false  // writes visible:false to state
    windowLoader.active = false
  }
  function ensureWindow() {
    // An existing-but-hidden FloatingWindow is never re-mapped by Quickshell
    // (setting visible=true shows nothing). Recreate it instead — this also
    // covers a window the compositor closed (SUPER+M hide path).
    if (windowLoader.item && !windowLoader.item.visible) windowLoader.active = false
    if (!windowLoader.active) {
      windowLoader.active = true
      root.refresh(true, false)          // full list, like the panel
    }
    // A fresh BlipWindow honours window.json (which may say hidden) — this
    // call means SHOW, so make it so once its restore pass has run.
    Qt.callLater(function() { if (windowLoader.item) windowLoader.item.requestShow() })
  }
  /** Toggle the app window. Returns what it just DID, not what windowVisible
   *  says: ensureWindow() defers the actual `visible = true` to a callLater
   *  (a fresh BlipWindow has to run its restore pass first), so reading the
   *  property straight after showing still says hidden — IPC `window` reported
   *  "window hidden" on both paths and could never say it had shown one. */
  function toggleWindow() {
    if (root.windowVisible) { hideWindow(); return false }
    ensureWindow()
    return true
  }
  // Show AND focus: a window restored on another workspace is invisible to
  // the user, and a plain toggle would HIDE it ("SUPER+M doesn't load the
  // app"). Hyprland ≥0.56 dispatch takes Lua; classic focuswindow is rejected.
  function showApp() {
    // The popout gets out of the way first: the window is the same view,
    // larger. Here, once, so double-click, the ⇱ button and IPC `app` (a
    // SUPER+M bind) all agree — `app` used to leave the popout open.
    if (popout) popout.close()
    ensureWindow()
    if (!windowLoader.item) return
    // Fire-and-forget on purpose: a Process object silently ignores
    // `running = true` while it thinks a previous run is alive, which left
    // showApp() "succeeding" without ever focusing (SUPER+M "nothing at all").
    Quickshell.execDetached(["sh", "-c",
      'for i in 1 2 3 4 5 6 7 8; do a=$(hyprctl clients -j | jq -r \'.[] | select(.title | startswith("Blip")) | .address\' | head -1); [ -n "$a" ] && break; sleep 0.15; done; ' +
      '[ -n "$a" ] && hyprctl dispatch "hl.dsp.focus({ window = \\"address:$a\\" })" >/dev/null'])
  }
  /** Either surface open → keep the deep (complete) thread list. */
  function anySurfaceOpen() {
    return (popout && popout.opened === true) || root.windowVisible
  }

  // ------------------------------------------------------------ collector
  // `deep` widens the fetch window for the panel; `markRead` clears the badge.
  // `readChat` clears one thread's blue dot — iMessage semantics: the dot
  // survives viewing the list and only goes when that conversation is opened.
  property var refreshQueue: []        // stateful requests are never overwritten
  // The complete conversation list (quiet chats, pins) only comes from a deep
  // run (`imsg chats`); a shallow poll returns the window's rows. Kept so a
  // shallow result can be overlaid rather than replacing the model.
  property var deepThreads: []
  function dropMutedThreads(threads, muted) {
    if (!Array.isArray(muted) || muted.length === 0) return threads
    var gone = {}
    for (var i = 0; i < muted.length; i++) gone[String(muted[i])] = true
    return threads.filter(function(t) {
      if (gone[String(t.chat)]) return false
      var a = t.aliases || []
      for (var j = 0; j < a.length; j++) if (gone[String(a[j])]) return false
      return true
    })
  }
  function overlayThreads(deep, shallow) {
    var byChat = {}
    for (var i = 0; i < shallow.length; i++) byChat[String(shallow[i].chat)] = shallow[i]
    var out = []
    for (var j = 0; j < deep.length; j++) {
      var t = deep[j], c = String(t.chat)
      if (byChat[c] !== undefined) { out.push(byChat[c]); delete byChat[c]; continue }
      // Every unread conversation is inside the poll window (the ledger's
      // catch-up fetch guarantees it), so a row the poll did not return has
      // been read since the deep run.
      out.push(t.unread > 0 ? Object.assign({}, t, { unread: 0 }) : t)
    }
    for (var k in byChat) out.push(byChat[k])
    out.sort(root.compareThreads)   // mirrors collector.ts compareThreads
    return out
  }
  // FORK (Dave, 2026-09-19): the badge counts conversations with unread, not
  // messages — three conversations of five messages each read 3.
  function countUnreadThreads(list) {
    var n = 0
    for (var i = 0; i < list.length; i++) if ((Number(list[i].unread) || 0) > 0) n++
    return n
  }
  function compareThreads(a, b) {
    var ap = a.pinned === true, bp = b.pinned === true
    if (ap !== bp) return ap ? -1 : 1
    if (ap && bp) {
      var ao = a.pin_order, bo = b.pin_order
      var an = ao === null || ao === undefined, bn = bo === null || bo === undefined
      if (!an && !bn && ao !== bo) return ao - bo
      if (!an && bn) return -1
      if (an && !bn) return 1
    }
    // FORK (Dave, 2026-09-19): unread conversations sort above read ones,
    // mirroring collector.ts — a shallow overlay must not reshuffle the list.
    var au = (Number(a.unread) || 0) > 0, bu = (Number(b.unread) || 0) > 0
    if (au !== bu) return au ? -1 : 1
    var at = String(a.last_ts || ""), bt = String(b.last_ts || "")
    return at < bt ? 1 : at > bt ? -1 : 0
  }
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

  /** `seen` = the newest ts the surface actually rendered. Without it the
   *  mark went through the sidebar's last_ts, which can be a message that
   *  arrived after the snapshot the user is looking at (Astra A#3). */
  function markThreadRead(chat, seen) {
    var c = String(chat)
    var lastTs = seen ? String(seen) : ""
    var list = threads.map(function(t) {
      if (String(t.chat) !== c) return t
      if (lastTs === "") lastTs = String(t.last_ts || "")
      return t.unread > 0 ? Object.assign({}, t, { unread: 0 }) : t
    })
    noteLocalRead(c, lastTs)
    threads = list
    unread = countUnreadThreads(list)
    refresh(true, false, c, lastTs)
  }

  function markAllRead() {
    for (var i = 0; i < threads.length; i++)
      noteLocalRead(String(threads[i].chat), String(threads[i].last_ts || ""))
    threads = threads.map(function(t) {
      return t.unread > 0 ? Object.assign({}, t, { unread: 0 }) : t
    })
    unread = 0
    // deep when a surface shows the full list: a shallow result would replace
    // it with the 150-row window's chats (war room #17)
    refresh(anySurfaceOpen(), true)
  }

  /** The open conversation's chat, "" when the panel is closed or listing —
   *  refreshes carry it so a message arriving in the thread the user is
   *  LOOKING AT is counted read in the same collector run, not flashed
   *  unread and cleared a round-trip later. */
  /** The surface currently showing a conversation: the popout wins when open
   *  (it is in front), else the window when visible, else none. Both hosts
   *  expose the same proxies (inThread/active/loading/activeLastTs). */
  function readingSurface() {
    if (popout && popout.opened === true && popout.inThread === true) return popout
    var w = windowLoader.item
    // the window must be FOCUSED to count as being read (war room #25), and
    // a thread merely peeked from the sidebar cursor is not being read either
    if (w && w.visible === true && w.focused === true && w.inThread === true && w.peeking !== true) return w
    return null
  }
  function activeReadChat() {
    var s = readingSurface()
    // a still-LOADING conversation is not yet read (Codex #4), and neither is
    // one whose load FAILED — nothing was seen (Astra A#2)
    return (s && s.loading !== true && s.rendered === true) ? String(s.active.chat) : ""
  }
  function activeSeenTs() {
    var s = readingSurface()
    // the newest ts that RENDERED, not the sidebar's (Astra A#3)
    return s ? String(s.seenTs || "") : ""
  }

  Process {
    id: collector
    command: ["bun", root.collectorPath]
    // A Process that FAILS TO START (bun not on the shell's PATH) emits only
    // runningChanged — no exited, no stream end — and the icon would say
    // "Mac unreachable" forever (war room #18). Detect the missing exit.
    property bool sawExit: false
    onRunningChanged: {
      if (running) { sawExit = false; return }
      Qt.callLater(function() {
        if (!collector.sawExit && !collector.running) {
          root.online = false; root.healthy = false
          root.lastError = "cannot start `bun` — install it (pacman -S bun) and restart the shell"
        }
      })
    }
    stdout: StdioCollector {
      onStreamFinished: {
        // A garbled run keeps the last good thread list rather than flashing
        // the bar empty — same discipline as larry.status's session collector.
        try {
          var d = JSON.parse(text.trim())
          root.online = d.online === true
          root.lastError = String(d.error || "")
          root.lastRun = String(d.ts || "")
          if (typeof d.readPush === "string") root.readPush = d.readPush
          if (d.ok === true) {
            // Filter through the optimistic-read ledger: a poll that was
            // already in flight when the user opened a thread must not
            // resurrect its dot for one round-trip (the double-flash).
            var list = root.applyLocalReads(Array.isArray(d.threads) ? d.threads : [])
            // A shallow poll carries only the message window's rows. Overlay
            // it on the last complete list so the panel never opens onto a
            // dozen rows that grow (and re-pin) a deep run later.
            if (d.deep === true) root.deepThreads = list
            else if (root.deepThreads.length > 0) {
              if (Array.isArray(d.muted) && d.muted.length > 0)
                root.deepThreads = root.dropMutedThreads(root.deepThreads, d.muted)
              list = root.overlayThreads(root.deepThreads, list)
            }
            // Reassigning `threads` rebuilds the panel's list Repeater and
            // resets its scroll — with push, that was every few seconds.
            // Skip the assignment when nothing actually changed.
            var j = JSON.stringify(list)
            if (j !== root.threadsJson) {
              root.threadsJson = j
              root.threads = list
            }
            root.unread = root.countUnreadThreads(list)
            root.healthy = d.persisted !== false
            // A message that carries a security code gets the code toast only:
            // its ordinary preview would put the digits into the daemon's
            // on-disk history like any other body (Astra #1).
            var codeKeys = {}
            if (Array.isArray(d.codes)) d.codes.forEach(function(c) { codeKeys[String(c.chat) + " " + String(c.ts)] = true })
            if (Array.isArray(d.toast)) root.fireToasts(d.toast.filter(function(t) { return !codeKeys[String(t.chat) + " " + String(t.ts)] }))
            // A link that just arrived opens the share sheet (Fred, 2.3.0).
            // Only onto a surface that is ALREADY open: Omarchy runs
            // focus_on_activate=false and Blip never steals focus, so a bank
            // alert must not throw a panel over full-screen work. When Blip is
            // closed the desktop toast is still the notification.
            if (Array.isArray(d.links) && d.links.length > 0) root.shareArrivingLink(d.links[d.links.length - 1])
            // A security code that just arrived: hold the newest, toast it.
            if (Array.isArray(d.codes) && d.codes.length > 0) root.noteCode(d.codes[d.codes.length - 1])
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
      collector.sawExit = true
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
    // (Mac down, watcher restarting) it is the old 6 s poll.
    // offline: back off to 30 s — a Mac that is off for the night must not
    // eat a bun + ssh probe every 6 s (war room #19); "ready" restores 6 s
    // Stretches only when BOTH messengers have a live change-channel.
    // One of them pushing is not enough: the other would then be a minute
    // late instead of six seconds.
    interval: (root.watchAlive && root.waWatchAlive) ? 60000 : (root.online ? 6000 : 30000)
    running: true                       // the service is the single poller, icon or no icon
    repeat: true
    triggeredOnStart: true
    // While the panel is open keep the wide window, or the list would shrink
    // from 40 threads to 14 on the next tick. Until ONE deep run has landed
    // (startup, or after a garbled one) go deep regardless, so the first
    // open finds the complete, pinned list already in memory.
    onTriggered: root.refresh(root.anySurfaceOpen() || root.deepThreads.length === 0, false,
                              root.activeReadChat(), root.activeSeenTs())
  }

  // ------------------------------------------------- real-time push
  // `imsg watch` blocks on the Mac and emits one line per chat.db change — an
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
    // arm liveness at START: a watcher that hangs before "ready" was never
    // killed or restarted (war room #20)
    onStarted: watchLiveness.restart()
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
      // Carrying the open thread's chat means a message landing in the
      // conversation the user is READING is counted read in this same run —
      // no badge flash, no second round-trip.
      root.refresh(root.anySurfaceOpen(), false, root.activeReadChat(), root.activeSeenTs())
      // Reload the OPEN conversation in parallel — waiting for the collector
      // and then reloading serially added a visible second of latency.
      // Both surfaces: each gates itself on its own surfaceOpen.
      if (popout && popout.opened === true && typeof popout.pushReload === "function")
        popout.pushReload()
      var w = windowLoader.item
      if (w && w.visible === true && typeof w.pushReload === "function")
        w.pushReload()
    }
  }
  // The same invalidation channel for WhatsApp: `wa watch` polls the WAHA
  // container on loopback and prints a bare timestamp when the newest message
  // changes. It is a separate Process because the two can fail independently —
  // the Mac asleep must not silence WhatsApp, and vice versa.
  property bool waWatchAlive: false
  property int waWatchFails: 0
  readonly property string waScript:
    decodeURIComponent(Qt.resolvedUrl("bridge/whatsapp/wa.ts").toString().replace(/^file:\/\//, ""))
  Process {
    id: waWatchProc
    command: ["bun", root.waScript, "watch"]
    running: true
    onStarted: waWatchLiveness.restart()
    stdout: SplitParser {
      onRead: function(line) {
        var l = String(line).trim()
        waWatchLiveness.restart()
        if (l === "ready") { root.waWatchAlive = true; root.waWatchFails = 0; return }
        if (l === "hb") return
        pingDebounce.restart()
      }
    }
    onExited: {
      root.waWatchAlive = false
      waWatchLiveness.stop()
      root.waWatchFails = Math.min(root.waWatchFails + 1, 5)
      waWatchRestart.restart()
    }
  }
  Timer {
    id: waWatchLiveness
    interval: 90000
    onTriggered: { waWatchProc.running = false }
  }
  Timer {
    id: waWatchRestart
    interval: 8000 * Math.pow(2, root.waWatchFails)
    onTriggered: waWatchProc.running = true
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
        if (action === "default" && notifyProc.toastCode !== "") { root.copyCode(notifyProc.toastCode); return }
        if ((action === "default" || action === "reply") && notifyProc.toastChat !== "")
          root.show(notifyProc.toastChat)
      }
    }
    property string toastChat: ""
    property string toastCode: ""    // set for a code toast: click = copy, not open
    property double toastCodeAt: 0   // when that code was toasted — expiry applies here too (Astra A#9)
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
    // A code toast that waited out its five minutes in the queue is stale: the
    // code it would offer has expired (Astra A#9).
    while (q.length > 0 && q[0].code && Date.now() - Number(q[0].at || 0) > 300000) q.shift()
    if (q.length === 0) { toastQueue = q; return }
    var t = q.shift()
    toastQueue = q
    var body = String(t.text || "")
    if (body.length > 220) body = body.substring(0, 217) + "…"
    notifyProc.toastChat = String(t.chat || "")
    notifyProc.toastCode = String(t.code || "")
    notifyProc.toastCodeAt = Number(t.at || 0)
    // Where this toast came from, in a form that outlives it.
    //
    // --action=default lives inside this notify-send process and dies with it
    // after eight seconds, so an old row in the notification center could
    // never reach Blip. Omarchy also reads a hint, `omarchy-exec-argv`, which
    // it persists with the notification, and that is the supported way for a
    // restored notification to stay clickable. The value is built here and
    // never contains anything a sender chose: the chat id is a handle Blip
    // already resolved, it travels as its own argv element rather than inside
    // a shell string, and a leading "+" is dropped because `qs ipc call` would
    // read it as a flag (show() matches the bare digits as an alias).
    var reopen = []
    var chatArg = notifyProc.toastChat.replace(/^\+/, "")
    if (notifyProc.toastCode !== "")
      // popup only: the daemon must not write the code into its on-disk
      // history (~/.local/state/omarchy/notifications/history). It expires
      // from memory in five minutes; there is nothing to restore.
      reopen = ["--hint=boolean:transient:true"]
    else if (chatArg !== "" && /^[A-Za-z0-9._@:;$-]{1,256}$/.test(chatArg))
      reopen = ["--hint=string:omarchy-exec-argv:" + JSON.stringify(
        ["qs", "-p", "/usr/share/omarchy/shell", "ipc", "call",
         root.moduleName, "goto", chatArg])]

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
      notifyProc.toastCode !== "" ? "--action=default=Copy" : "--action=default=Open",
    ].concat(reopen).concat([
      "--",                                   // a name or text starting with "-" is data, not a flag
      String(t.name || t.chat || "iMessage"),
      body
    ])
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

  // ------------------------------------------------------ security codes
  // macOS reads a 2FA code out of an SMS and offers it to the browser. Blip's
  // version: the collector spots the code, the widget holds it IN MEMORY for
  // five minutes (never state.json — it is message text), toasts it, and on
  // request copies it (click the toast, or `copycode`) or types it into
  // whatever has keyboard focus (`typecode`, bound to a hotkey). The code
  // reaches wl-copy through an environment variable and stdin, and the
  // focused window as key events over Hyprland's socket — never argv, where
  // any process could read it from /proc.
  //
  // NOT wtype. A virtual keyboard's key presses are merged with the physical
  // keyboard's modifier state, so the digits typed while the user's fingers
  // are still on Super+Shift became Super+Shift+<digit> — workspace binds.
  // `send_key_state` (what Omarchy's universal paste uses) hands the key
  // straight to the focused window without consulting binds.
  property var pendingCode: null         // {code, name, domain, ts} or null
  Timer {
    id: codeExpiry
    interval: 300000
    onTriggered: root.pendingCode = null
  }
  function noteCode(c) {
    if (!c || !c.code) return
    pendingCode = { code: String(c.code), name: String(c.name || c.chat || ""), domain: String(c.domain || ""), ts: String(c.ts || "") }
    codeExpiry.restart()
    var who = pendingCode.name !== "" ? pendingCode.name : "a message"
    // The digits are NOT in the body. Omarchy's daemon persists every displayed
    // toast's body to ~/.local/state/omarchy/notifications/history — its own
    // Service.qml says the transient hint only decides whether a DND-silenced
    // one is recorded — so a body with the code put the code on disk (Astra
    // #1). The toast says a code arrived; click copies it from memory.
    var body = (pendingCode.domain !== "" ? "For " + pendingCode.domain + " · " : "")
             + "Click to copy"
    fireToasts([{ chat: "", name: "Security code from " + who, text: body, ts: pendingCode.ts, key: "", code: pendingCode.code, at: Date.now() }])
  }
  // sh reads the code from its environment, hands it to the tool on stdin.
  property string copyValue: ""          // what the NEXT copy hands to wl-copy
  Process {
    id: codeCopyProc
    environment: ({ BLIP_CODE: root.copyValue })
    command: ["sh", "-c", "printf %s \"$BLIP_CODE\" | wl-copy"]
    onExited: root.copyValue = ""
  }
  /** Copy a code. A toast passes the code it DISPLAYED, so clicking an older
   *  toast after a newer code arrived copies what was on the card, not the
   *  newer one (Astra #14). IPC `copycode` passes nothing: the newest. */
  function copyCode(code) {
    if (!pendingCode) return "no code pending"
    // An older toast's code is copied only within ITS five minutes (Astra A#9).
    if (code && String(code) !== pendingCode.code && Date.now() - notifyProc.toastCodeAt > 300000) return "code expired"
    copyValue = String(code || pendingCode.code)
    codeCopyProc.running = true
    return "copied"
  }
  // One key event per tick: down, then up, 20 ms apart (Omarchy's paste
  // helper uses 50 between the two). A single dispatch per event keeps the
  // socket write small and the order guaranteed.
  property var keyQueue: []
  Timer {
    id: keyPump
    interval: 20
    repeat: true
    onTriggered: {
      if (root.keyQueue.length === 0) { stop(); return }
      var q = root.keyQueue.slice()
      var k = q.shift()
      root.keyQueue = q
      Hyprland.dispatch('hl.dsp.send_key_state({ mods = "' + k.mods + '", key = "' + k.key + '", state = "' + k.state + '" })')
    }
  }
  /** xkb key name + modifiers for one character of a code, or null. */
  function keyFor(ch) {
    if (/^[0-9a-z]$/.test(ch)) return { key: ch, mods: "" }
    if (/^[A-Z]$/.test(ch)) return { key: ch.toLowerCase(), mods: "SHIFT" }
    if (ch === "-") return { key: "minus", mods: "" }
    return null
  }
  function typeCode() {
    if (!pendingCode) return "no code pending"
    var q = []
    var code = String(pendingCode.code)
    for (var i = 0; i < code.length; i++) {
      var k = keyFor(code.charAt(i))
      if (!k) continue
      q.push({ key: k.key, mods: k.mods, state: "down" })
      q.push({ key: k.key, mods: k.mods, state: "up" })
    }
    keyQueue = q
    keyPump.start()
    return "typed"
  }

  // ------------------------------------------------------------ IPC
  // IPC that sends or reads message content is a deputy for any local
  // process (Codex audit #3). It is opt-in: automation=on in bridge.conf.
  // status/open/close/toggle/window/app stay available — they expose nothing.
  // The handler lives on the service (a singleton), so it answers exactly once
  // no matter how many bar widgets exist, and even with the icon hidden.
  property bool automationOn: false
  /** `ui_font=theme` in bridge.conf: never use SF Pro even when it is present. */
  property bool uiFontTheme: false
  /** `ui_font_size=N` in bridge.conf: bubble text in px (9–24). 0 = Omarchy default. */
  property int uiFontSize: 0
  // The version, read from THIS plugin's manifest.json — the one place it is
  // written, so a release bump is the only thing that ever updates what the
  // header shows (Fred, 2.3.3: "keep it there forever updated"). Both surfaces
  // take it from here through BlipView, so they can never disagree.
  property string version: ""
  FileView {
    id: manifestFile
    path: Qt.resolvedUrl("manifest.json").toString().replace(/^file:\/\//, "")
    watchChanges: true
    printErrors: false
    onFileChanged: reload()
    onLoaded: {
      try { root.version = String(JSON.parse(text()).version || "") } catch (e) { root.version = "" }
    }
    onLoadFailed: root.version = ""
  }
  readonly property string automationOff: "blip: automation=off — set automation=on in ~/.config/blip/bridge.conf to allow ipc send/read"
  FileView {
    id: bridgeConf
    path: root.home + "/.config/blip/bridge.conf"
    watchChanges: true
    printErrors: false
    onFileChanged: {
      reload()
      if (root.deepThreads.length > 0) root.refresh(true, false)
    }
    onLoaded: {
      var t = text()
      root.automationOn = /^\s*automation\s*=\s*['"]?(on|true|1|yes)\b/mi.test(t)
      // ui_font=theme keeps Omarchy's family even where SF Pro is installed.
      root.uiFontTheme = /^\s*ui_font\s*=\s*['"]?theme\b/mi.test(t)
      var sm = t.match(/^\s*ui_font_size\s*=\s*['"]?(\d+)/mi)
      var n = sm ? parseInt(sm[1], 10) : 0
      root.uiFontSize = (!isFinite(n) || n <= 0) ? 0 : Math.min(24, Math.max(9, n))
    }
    onLoadFailed: { root.automationOn = false; root.uiFontTheme = false; root.uiFontSize = 0 }
  }
  FileView {
    id: mutelistFile
    path: root.home + "/.config/blip/mutelist.json"
    watchChanges: true
    printErrors: false
    onFileChanged: if (root.deepThreads.length > 0) root.refresh(true, false)
  }
  IpcHandler {
    target: root.moduleName
    enabled: true
    function status(): string {
      var w = windowLoader.item
      return "online=" + root.online + " unread=" + root.unread + " leader=true"
        + " window=" + (w && w.visible ? (w.focused ? "focused" : "unfocused") : "hidden")
        + " threads=" + root.threads.length + " healthy=" + root.healthy
        + " watch=" + root.watchAlive + " wawatch=" + root.waWatchAlive
        + " read_push=" + (root.readPush !== "" ? root.readPush : "?")
        + (root.lastError !== "" ? " error=" + root.lastError : "")
    }
    function threads(): string { return root.automationOn ? JSON.stringify(root.threads) : root.automationOff }
    function refresh(): void { root.refresh(root.anySurfaceOpen(), false) }
    function read(): string { if (!root.automationOn) return root.automationOff; root.markAllRead(); return "read" }
    function open(): void { root.open() }
    function close(): void { root.close() }
    function toggle(): void { root.toggle() }
    function goto(chat: string): string { if (!root.automationOn) return root.automationOff; return root.show(chat) ? "shown" : "not a conversation id" }
    function copycode(): string { if (!root.automationOn) return root.automationOff; return root.copyCode() }
    function typecode(): string { if (!root.automationOn) return root.automationOff; return root.typeCode() }
    function share(url: string): string {
      if (!root.automationOn) return root.automationOff
      if (popout) { root.open(); return popout.shareLink(url) }
      root.ensureWindow()
      var w = windowLoader.item
      return w ? w.shareLink(url) : "no surface"
    }
    function compose(text: string): string {
      if (!root.automationOn) return root.automationOff
      if (popout) return popout.composeAndSend(text)
      // C-006: no popout (icon hidden) — the app window is the surface, with
      // the same blind-send guard. A closed window must be opened first.
      var w = windowLoader.item
      if (!w) { root.ensureWindow(); return "window closed — open the conversation first" }
      return w.composeAndSend(text)
    }
    function bubbles(): string {
      if (!root.automationOn) return root.automationOff
      if (popout) return popout.bubbleModel()
      var w = windowLoader.item
      return w ? w.bubbleModel() : "[]"
    }
    function find(query: string): string {
      if (!root.automationOn) return root.automationOff
      if (popout) return popout.searchFor(query)
      root.ensureWindow()
      var w = windowLoader.item
      return w ? w.searchFor(query) : "no surface"
    }
    function newchat(query: string): string {
      if (!root.automationOn) return root.automationOff
      if (popout) return popout.newChatFor(query)
      root.ensureWindow()
      var w = windowLoader.item
      return w ? w.newChatFor(query) : "no surface"
    }
    function window(): string { return root.toggleWindow() ? "window shown" : "window hidden" }
    function app(): string { root.showApp(); return "app shown + focused" }
    function windowgoto(chat: string): string {
      if (!root.automationOn) return root.automationOff
      root.ensureWindow()
      var w = windowLoader.item
      if (!w) return "no window"
      var want = String(chat)
      for (var i = 0; i < root.threads.length; i++) {
        var c = String(root.threads[i].chat)
        if (c === want || c === "+" + want) { w.openThread(root.threads[i]); return "opened " + c }
      }
      // A member id of a person-folded row opens the folded conversation.
      for (var j = 0; j < root.threads.length; j++) {
        var members = root.threads[j].aliases || []
        if (members.indexOf(want) >= 0 || members.indexOf("+" + want) >= 0) {
          w.openThread(root.threads[j])
          return "opened " + String(root.threads[j].chat)
        }
      }
      return "unknown chat"
    }
  }
}
