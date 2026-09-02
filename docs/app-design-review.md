# BlipView extraction — design review (Codex, 2026-08-31)

Recorded verbatim from the review that preceded the Tier 4 refactor. Execute in the listed migration order; the plugin must stay shippable after every step.

1. Use one public component: `BlipView.qml`. Do not add separate `ThreadList.qml`/`Conversation.qml` yet. Inside it, keep two stable sibling `Item`s—`threadPane` and `conversationPane`—with separate `threadFlick` and `conversationFlick`.

2. Give `BlipView` this host-facing contract:

   - Inputs: `hostWidget`, `splitView`, `surfaceOpen`, `readEnabled`, `foreground`, `urgent`, `fontFamily`, `sidebarWidth`.
   - Outputs: `active`, `inThread`, `loading`, `activeLastTs`, `editorActive`, `composeEditor`, `readEligible`.
   - Methods: `resetToList()`, `openThread(t)`, `pushReload()`, `unwind()`, `moveCursor(dx,dy)`, `activateCursor()`, `handleTextKey(text)`, `focusDefault()`, plus existing IPC helpers.
   - Signals: `closeRequested()`, `navigationFocusRequested()`.

3. Move all conversation/list-domain state from [Panel.qml](Panel.qml:67) into `BlipView`:

   - `active`, bubbles, serialized-load guards, cursor, scroll pinning.
   - Search/new-contact state.
   - Attachment cache/queue and compose draft state.
   - Send/paste ownership fields.
   - All rendering/helper/navigation functions.
   - `threadProc`, `sendProc`, `fileSendProc`, `fetchProc`, `pasteProc`, `contactProc`, `searchProc`, `copyProc`, `openProc`, and their timers.

   Each `BlipView` instance keeps independent navigation and drafts; only the collector/read ledger remains shared.

4. Keep surface concerns outside:

   - `Panel.qml`: `Panel`, `KeyboardPanel`, `controller.show/hide`, bar coordination, `opened`, `switchPanel()`, IPC-compatible proxy properties/functions.
   - `BlipWindow.qml`: `FloatingWindow`, title, visibility, size/position, window-close behavior.
   - `BarWidget.qml`: sole collector, watcher, threads, unread count, optimistic read ledger, IPC loaders. This matches the Tier 4 architecture in [ROADMAP.md](ROADMAP.md:78).

5. Layout without duplicated renderers:

   - `threadPane.visible: splitView || !inThread`
   - `conversationPane.visible: splitView || inThread`
   - In split mode, `threadPane` gets `sidebarWidth` and `conversationPane` fills the remainder.
   - In split mode with no `active`, show a conversation placeholder.
   - In single mode, selecting a thread hides the list; `back()` clears `active`.
   - Keep panes instantiated while hidden. Do not use mutually exclusive `Loader`s: rebuilding the conversation would lose image state, selection, and scroll position.
   - Preserve the conversation-specific scroll compensation and bottom-stick logic from [Panel.qml](Panel.qml:860); the thread list gets its own simpler scroll restoration.

6. Panel focus strategy:

   - Keep `PanelKeyCatcher` in `Panel.qml`, wrapping `BlipView`.
   - Bind exactly: `blocked: view.editorActive`.
   - `editorActive` must include `composeField`, `searchField`, `newField`, and bubble `TextEdit` focus—the current critical rule at [Panel.qml](Panel.qml:803).
   - `KeyboardPanel.focusTarget: view.inThread ? view.composeEditor : keyCatcher`.
   - `navigationFocusRequested` lets the view ask the host to call `keyCatcher.forceActiveFocus()`.
   - Every delayed focus operation must additionally require `surfaceOpen`.

7. Floating-window focus strategy:

   - Wrap `BlipView` in a `FocusScope`; do not use `PanelKeyCatcher` by default.
   - Handle Esc with `Keys.priority: Keys.AfterItem`: call `view.unwind()` first; close the window only when it returns `false`.
   - On `visible: true`, call `view.focusDefault()` via `Qt.callLater`.
   - This preserves normal Tab/editor behavior while the panel retains its keyboard navigation model.

8. Never disable `composeField`. Replace the current [enabled binding](Panel.qml:1643) with:

   - `enabled: true`
   - `readOnly: !online || !isSendable(active)`
   - `send()` remains the authoritative online/sendability/concurrency guard.

   This prevents an online-state change from disabling the focused editor and collapsing panel focus.

9. Make visibility/read ownership explicit:

   - `surfaceOpen` gates `onThreadsChanged`, `pushReload()`, thread-result rendering, autofocus, and all read marking. It replaces direct dependence on `Panel.opened`; preserve the existing late-load guard in [Panel.qml](Panel.qml:566).
   - Panel: `surfaceOpen: root.opened`.
   - Window: `surfaceOpen: win.visible`.
   - Add `readEnabled` so only the foreground surface clears reads; give an open panel priority over a visible window.
   - Fix [BarWidget.activeReadChat()](BarWidget.qml:206) and the panel-only push path at [BarWidget.qml](BarWidget.qml:330). They currently exclude the window despite the roadmap’s shared-read claim.

10. Shared interaction rule: use `TapHandler` or `PanelActionButton` for every action—rows, attachments, draft removal, send, search results. Retain `MouseArea` only for the proven `acceptedButtons: Qt.NoButton` wheel handler. This keeps the component safe inside `KeyboardPanel`’s dismiss layer and also works in `FloatingWindow`.

11. Safe migration order:

   1. Baseline screenshots and behavior checks: list, rich thread, scrolled-up push, search, new contact, selection/Ctrl+C, inline image, draft, paste.
   2. Harden existing `Panel.qml`: convert actionable `MouseArea`s, add always-enabled/read-only compose behavior and explicit visibility guards.
   3. Add unused `BlipView.qml` containing the mechanically moved panel controller and single-pane UI.
   4. Replace `Panel.qml` with the thin host plus compatibility proxies. Verify the panel before touching the window.
   5. Split `BlipView` internally into stable `threadPane`/`conversationPane`; keep `splitView: false` and reverify panel scroll behavior.
   6. Update `BarWidget.qml` for host-neutral read ownership and push reloads.
   7. Replace the duplicate state, processes, and simple renderer in [BlipWindow.qml](BlipWindow.qml:34) with `BlipView { splitView: true }`.
   8. Restart the shell for the new QML file, run `bun test`, and compare panel/window screenshots of the same rich thread.
