import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

// The renderer moved from Panel.qml into BlipView.qml in 1.8.0 (shared with the app window).
const panel = readFileSync(new URL("./BlipView.qml", import.meta.url), "utf8");
const widget = readFileSync(new URL("./BarWidget.qml", import.meta.url), "utf8");
const settings = readFileSync(new URL("./BlipSettings.qml", import.meta.url), "utf8");
const preferences = readFileSync(new URL("./BlipPreferences.qml", import.meta.url), "utf8");
const popout = readFileSync(new URL("./Panel.qml", import.meta.url), "utf8");
const window = readFileSync(new URL("./BlipWindow.qml", import.meta.url), "utf8");

function handleTextKeySource() {
  const start = panel.indexOf("function handleTextKey");
  const end = panel.indexOf("function unwind");
  return panel.slice(start, end);
}

describe("QML safety invariants", () => {
  test("group sends use the cached AppleScript GUID", () => {
    expect(panel).toContain('["--chat-id", String(root.active.guid)]');
    expect(panel).toContain('["--to", sendChat]');
  });

  test("thread results are accepted only for the active chat", () => {
    expect(panel).toContain('String(root.active.chat) === root.threadRunningChat');
    expect(panel).toContain("if (!belongsHere) return");
  });

  test("the compose field is never disabled by an in-flight send", () => {
    // Disabling the exclusive-keyboard-focus holder dismisses the panel the
    // instant Enter is pressed — the send works but all feedback vanishes.
    expect(panel).not.toContain("!sendProc.running");
  });

  test("send completion owns immutable chat and draft context", () => {
    expect(panel).toContain("var completedChat = root.sendChat");
    expect(panel).toContain("if (composeField.text === completedText) composeField.text = \"\"");
  });

  test("message text leaves this machine on stdin, never in argv (audit #4)", () => {
    expect(panel).toContain('"--text-stdin"');
    expect(panel).toContain("sendProc.write(text)");
    expect(panel).not.toContain('["--yes", "--", text]');
  });

  test("a bare URL asks linkpreview.ts and renders the same card", () => {
    expect(panel).toContain("function requestPreview(url)");
    expect(panel).toContain("root.previewScript");
    expect(panel).toContain("readonly property var fetched:");
    expect(panel).toContain("modelData.link || linkRow.fetched || ({})");
    // an Apple card still comes from the ssh-fetched attachment, ours from disk
    expect(panel).toContain("String((linkRow.fetched && linkRow.fetched.image)");
  });

  test("an arriving link opens the sheet only on a surface already open", () => {
    expect(widget).toContain("function shareArrivingLink(link)");
    expect(widget).toContain("d.links[d.links.length - 1]");          // newest only, never a queue
    expect(widget).toContain("p.opened === true");                    // panel must already be open
    expect(widget).toContain("root.windowVisible");                   // or the app window
  });

  test("a link you SEND opens the sheet too, and the app button asks the host", () => {
    expect(panel).toContain("var sentUrl = root.firstUrl(completedText)");
    expect(panel).toContain("function openApp()");
    expect(panel).toContain('hostWidget.showApp()');
    // the popout gets out of the way, and closes BEFORE the window is shown
    expect(panel).toContain('hostWidget.close()');
    expect(panel.indexOf("hostWidget.close()")).toBeLessThan(panel.indexOf("hostWidget.showApp()"));
    expect(panel).toContain('tooltipText: "Open the app window (SUPER+M)"');
  });

  test("group rows and tiles show the GROUP's photo, never the last speaker's", () => {
    const bind = 'root.isGroupId(String(modelData.chat || "")) ? String(modelData.chat) : String(modelData.handle || modelData.chat || "")';
    expect(panel).toContain(bind);   // chronological row
    expect(panel).toContain('root.isGroupId(String(thread.chat || ""))');   // pinned tile
    expect(panel).toContain('? String(thread.chat)');
    expect(panel).not.toContain('if (!root.isGroupId(String(modelData.chat || ""))) root.requestAvatar(avatarHandle)');
    expect(panel).not.toContain('if (handle === "" || isGroupId(handle)) return');
  });

  test("share sheet: right-click a link, URL on stdin, never argv", () => {
    expect(panel).toContain("function openShare(u)");
    expect(panel).toContain("qrProc.write(u)");
    expect(panel).toContain("sendShareProc.write(u)");
    expect(panel).toContain('localsend --headless send "$2"');
    expect(panel).toContain('onTapped: root.openShare(String(linkCard.link.url || ""))');
    expect(panel).toContain('if (shareUrl !== "") { closeShare(); return true }');
    expect(widget).toContain('function share(url: string): string { if (!root.automationOn) return root.automationOff;');
    // never the URL as an argv element of qrencode / localsend
    expect(panel).not.toContain('qrencode", ');
    expect(panel).not.toContain("localsend --headless send \"$2\" \"$3\"");
  });

  test("IPC goto only E.164-ifies a full number, never a short code", () => {
    expect(widget).toContain('/^[0-9]{10,}$/.test(want)');
    expect(widget).not.toContain('/^[0-9]+$/.test(want)');
  });

  test("message links and grouped bubble corners follow the bubble palette", () => {
    expect(panel).toContain("function richMessageHtml(html, linkColor)");
    expect(panel).toContain('text-decoration: underline;');
    expect(panel).toContain("fillColor: bubble.color");
    expect(panel).toContain("modelData.groupEnd === true && !bubbleRow.mine");
    expect(panel).toContain("modelData.linkOnly !== true");
    expect(panel).toContain("id: tapbackPill");
    expect(panel).toContain("font.pixelSize: root.fontSize(Style.font.heading)");
    expect(panel).toContain("border.width: 0");
    expect(panel).toContain("function opaqueOver(fill, background)");
    expect(panel).toContain("id: tapbackTailLarge");
    expect(panel).toContain("id: tapbackTailSmall");
    expect(panel).toContain("component TapbackReaction: Rectangle");
    expect(panel).toContain("reactions: modelData.link ? [] : (modelData.tapbacks || [])");
    expect(panel).not.toContain("color: bubble.color\n                      anchors.bottom");
  });

  test("standalone emoji use expressive Messages-style sizing without a bubble", () => {
    expect(panel).toContain("readonly property bool expressiveEmoji: modelData.emojiOnly === true");
    expect(panel).toContain("visible: !bubble.expressiveEmoji");
    expect(panel).toContain("root.fontSize(Style.font.bodySmall) * 4.1");
  });

  test("group messages reserve one avatar lane and paint only at run end", () => {
    expect(panel).toContain("component GroupMessageAvatarSlot: Item");
    expect(panel).toContain("readonly property bool runEndsHere: incomingGroup && modelData.groupEnd === true");
    expect(panel).toContain("showAvatar: bubbleRow.runEndsHere && !bubbleRow.hasTextBubble");
    expect(panel).toContain("root.requestAvatar(handle)");
  });

  test("inline media has a logical-width cap on wide and high-DPI windows", () => {
    expect(panel).toContain("Math.round(content.width * 0.6), root.space(380)");
    expect(panel).toContain("Number(chipRow.imageMetrics.pixelWidth) / pixelRatio");
    expect(panel).toContain("metrics[id] = { pixelRatio: ratio, pixelWidth: pixelWidth, pixelHeight: pixelHeight }");
  });

  test("link previews keep portrait artwork and pinned group titles", () => {
    expect(panel).toContain("Math.min(root.space(480)");
    expect(panel).toContain("fillMode: Image.PreserveAspectFit");
    expect(panel).toContain("root.active.pin_name || root.active.name || root.active.chat");
  });

  test("the app sidebar does not duplicate the window's outer left inset", () => {
    expect(panel).toContain("anchors.leftMargin: root.splitView ? root.space(6) : 0");
    expect(panel).toContain("retain the larger right gutter beside the pane divider");
  });

  test("the sidebar header is compact and pinned labels use Messages names", () => {
    expect(panel).toContain('tooltipText: "Settings"');
    expect(panel).toContain("readonly property real splitHeaderHeight");
    expect(panel).toContain("Layout.topMargin: root.splitView ? root.space(6) : 0");
    expect(panel).toContain("spacing: root.splitView\n              ? root.space(10)");
    expect(panel).toContain('root.unread > 0 ? root.unread + " UNREAD" : "ALL CAUGHT UP"');
    expect(panel).toContain("Layout.preferredHeight: root.splitView\n            ? root.splitHeaderHeight");
    expect(panel).toContain("id: splitConversationHero");
    expect(panel).toContain("id: conversationHeaderSpacer");
    expect(panel).toContain("Math.max(root.space(160), conversationPane.width * 0.50)");
    expect(panel).toContain('text: !root.inThread\n                ? ""');
    expect(panel).toContain("Layout.alignment: Qt.AlignVCenter");
    expect(panel).not.toContain('visible: root.splitView && !root.newMode\n            Layout.alignment: Qt.AlignTop');
    expect(panel).toContain("thread.pin_name || thread.name || thread.chat");
    expect(panel.match(/id: pinnedGrid/g)).toHaveLength(1);
    expect(panel).not.toContain('text: "PINNED"');
    expect(panel).not.toContain('? "SEARCH" : "MESSAGES"');
  });

  test("bubble right-clicks copy the message only", () => {
    expect(panel).toContain('text: "Copy message"');
    expect(panel).toContain("id: messageOnlyMenu");
    expect(panel).toContain("function openMessageContext(messageText)");
    expect(panel).toContain("root.openMessageContext(String(modelData.text || \"\"))");
  });

  test("chronological sidebar discussions use post-avatar separators", () => {
    expect(panel).toContain("Messages separates chronological conversations");
    expect(panel).toContain("avatarCircle.width + root.space(8)");
    expect(panel).toContain("index < root.regularThreads.length - 1");
  });

  test("appearance previews the app to scale with real bubble corners and portable list times", () => {
    expect(settings).toContain("component AppearancePreview: Rectangle");
    expect(settings).toContain('text: "LIVE APP PREVIEW"');
    expect(settings).toContain("configuredSidebar");
    expect(settings).toContain("configuredAvatar");
    // one uniform scale transform over REAL app dimensions — the raw-px
    // sidebar and spaceReal avatar formulas, never per-part fudge factors
    expect(settings).toContain("scale: appearancePreview.previewScale");
    expect(settings).toContain("Layout.preferredWidth: appearancePreview.configuredSidebar");
    expect(settings).toContain("Math.round(Style.spaceReal(configuredAvatar) * 1.75), root.liveSpace(48))");
    // fixed 1040×720 reference geometry, capped at an honest 100%
    expect(settings).toContain("readonly property real appWidth: 1040");
    expect(settings).toContain("Math.max(0.05, Math.min(1,");
    expect(settings).not.toContain("previewSidebar");
    expect(settings).not.toContain("* 0.76");
    expect(settings).toContain("component PreviewBubble: Item");
    expect(settings).toContain("previewBubble.mine ? previewBubble.height");
    expect(settings).toContain('label: "12-hour (AM/PM)"');
    expect(settings).toContain('setBoolean("use12HourConversationTimes", true)');
    expect(widget).toContain("preferences.use12HourConversationTimes");
  });

  test("settings opens on the appearance page", () => {
    expect(settings).toContain('property string page: "appearance"');
    expect(settings).toContain('label: "Appearance"');
    expect(panel).toContain('settingsView.showPage("appearance")');
  });

  test("appearance sliders re-lay-out only the preview, never the settings chrome", () => {
    // chrome uses scales frozen at open; the scaled miniature tracks live values
    expect(settings).toContain("function freezeChrome()");
    expect(settings).toContain("onVisibleChanged: if (visible) freezeChrome()");
    expect(settings).toContain("Math.round(value * chromeFontScale)");
    expect(settings).toContain("Style.spaceReal(value) * chromeDensity");
    expect(settings).toContain("function liveSpace(value)");
  });

  test("the settings hint cannot stretch the narrow popout", () => {
    expect(settings).toContain("horizontalAlignment: Text.AlignRight");
    const hint = settings.indexOf('text: "Changes preview and apply live"');
    expect(hint).toBeGreaterThan(0);
    const block = settings.slice(hint - 400, hint);
    expect(block).toContain("Layout.fillWidth: true");
    expect(block).toContain("elide: Text.ElideRight");
  });

  test("chronological rows are contiguous so hover fills up to the separator", () => {
    expect(panel).toContain("root.space(root.splitView ? 30 : 18)");
    expect(panel).not.toContain("root.space(root.splitView ? 20 : 12)");
    expect(panel).toContain("// Chronological rows are CONTIGUOUS");
    // separators touching a highlighted row hide so the hover reads as one block
    expect(panel).toContain("!chronoRows.rowActive(index) && !chronoRows.rowActive(index + 1)");
    expect(panel).toContain("if (hovered) chronoRows.hoveredRow = index");
  });

  test("popout header hosts new/window/settings actions and widens for settings", () => {
    expect(panel).toContain("id: headerActions");
    // ordered by function: content action, surface action, configuration
    const plus = panel.indexOf('tooltipText: "New message (n)"');
    const promote = panel.indexOf('tooltipText: "Open the app window (SUPER+M)"');
    const gear = panel.indexOf('tooltipText: "Settings"');
    expect(plus).toBeGreaterThan(-1);
    expect(promote).toBeGreaterThan(plus);
    expect(gear).toBeGreaterThan(promote);
    // settings double the dropdown: appearance fits preview + controls side by
    // side, and the contacts review/compare workflows get room to function
    expect(panel).toContain("readonly property bool settingsWide: settingsMode");
    expect(settings).toContain("readonly property real wideWidth");
    // two-column threshold sits well below the wide width: space() shrinks with
    // density while the panel padding does not, and a near-equal pair stacked
    expect(settings).toContain("width >= root.space(700) ? 2 : 1");
    expect(popout).toContain("view.settingsWide ? view.settingsWideWidth : Style.space(352)");
    expect(widget).toContain("function panelsettings(page: string): string");
  });

  test("previewable compose drafts show the image, other files show the name", () => {
    expect(panel).toContain("readonly property bool draftIsImage");
    // the pill stays for non-images and while the preview decodes; a decoded
    // image replaces it (and a broken file falls back to the pill)
    expect(panel).toContain("visible: !(root.draftIsImage && draftImage.status === Image.Ready)");
    expect(panel).toContain("visible: root.draftIsImage && draftImage.status === Image.Ready");
    const draftImage = panel.slice(panel.indexOf("id: draftImage"), panel.indexOf("id: draftImage") + 900);
    expect(draftImage).toContain("autoTransform: true");
    expect(draftImage).toContain("fillMode: Image.PreserveAspectFit");
  });

  test("pinned tiles center the avatar and name inside their outline", () => {
    expect(panel).toContain("implicitHeight: pinContent.implicitHeight + root.space(12)");
    expect(panel).toContain("id: pinContent");
    expect(panel).not.toContain("pinAvatarSize + root.space(38)");
  });

  test("coalesced chat aliases load one history and clear one logical unread state", () => {
    expect(panel).toContain("property var threadRunningAliases: []");
    expect(panel).toContain('.concat(threadRunningAliases)');
    expect(panel).toContain("threadContainsChat(threads[i], hit.chat)");
    expect(widget).toContain('args.push("--read-alias", req.readAliases[i])');
    expect(widget).toContain("root.activeReadAliases()");
  });

  test("read marks are queued and only applied after a successful load", () => {
    expect(widget).toContain("property var refreshQueue: []");
    expect(widget).not.toContain("property var queued: null");
    const success = panel.indexOf("if (d.ok === true)");
    const mark = panel.indexOf("markThreadRead(root.threadRunningChat,");
    expect(success).toBeGreaterThan(-1);
    expect(mark).toBeGreaterThan(success);
  });

  test("silent preference refreshes keep stable state", () => {
    expect(preferences).toContain("if (loaded && serialized === lastSerialized) return true");
  });

  test("app window routes n, slash, digits, and Esc through catch helpers", () => {
    expect(window).toContain("view.catchNavText(");
    expect(window).toContain("view.catchEscape()");
    expect(window).toContain("navCatcher.forceActiveFocus()");
    expect(window).toContain("win.navText(");
    const nav = window.slice(window.indexOf("function navText"), window.indexOf("function saveWinState"));
    expect(nav.indexOf("var typed = event.text")).toBeLessThan(nav.indexOf("Qt.Key_1"));
    expect(nav).toContain("Qt.ShiftModifier");
  });

  test("handleTextKey runs slash, n, and 1-9 before the inThread return", () => {
    const fn = handleTextKeySource();
    expect(fn.indexOf('text === "/"')).toBeLessThan(fn.indexOf("inThread"));
    expect(fn.indexOf('text === "n"')).toBeLessThan(fn.indexOf("inThread"));
    expect(fn.indexOf('text >= "1"')).toBeLessThan(fn.indexOf("inThread"));
    expect(fn).toContain("if (i < 0 || i >= navigationThreads.length) return false");
    expect(fn).toContain("openThread(navigationThreads[i])");
  });

  test("1-9 still jumps, with no digit drawn anywhere (Fred, 2.3.1)", () => {
    // The label was a hint, never the mechanism: handleTextKey indexes
    // threads[] directly. Drawing it also cost every conversation row a blank
    // left gutter, because a fixed-width column stayed reserved when the text
    // was empty — which it always is once nine pins own 1-9.
    expect(panel).not.toContain("threadHotkey");
    expect(panel).toContain('if (text >= "1" && text <= "9")');
    expect(panel).toContain("openThread(threads[i])");
    const catcher = panel.slice(panel.indexOf("function catchNavText"), panel.indexOf("function catchEscape"));
    expect(catcher).toContain('text >= "1" && text <= "9"');
    expect(catcher).toContain("root.draftPath");
    expect(catcher).toContain("return handleTextKey(text) === true");
    const fn = handleTextKeySource();
    expect(fn).toContain("if (searching || newMode) return false");
  });

  test("conversation search is scheduled from the field text, people first", () => {
    expect(panel).toContain("if (q !== searchQueryRan) searchSeq++");
    expect(panel).toContain("function scheduleSearch");
    expect(panel).toContain("function conversationHits");
    expect(panel).toContain("id: searchWatch");
    expect(panel).toContain("function threadIdentitiesJson");
    expect(panel).toContain("searchProc.write(threadIdentitiesJson())");
    expect(panel).toContain("onAccepted: root.acceptSearchField()");
  });

  test("new-message contact search is scheduled from the field text, not only Enter", () => {
    expect(panel).toContain("function scheduleContactSearch");
    expect(panel).toContain("function newFieldQuery");
    expect(panel).toContain("id: newSearchWatch");
    expect(panel).toContain("running: root.newMode");
    expect(panel).toContain("newSearchTimer.restart()");
    expect(panel).not.toContain("forceLayout");
    expect(panel.indexOf("onAccepted: root.acceptNewField()")).toBeGreaterThan(-1);
  });

  test("an old toast can still reopen its conversation (omarchy-exec-argv)", () => {
    // --action=default dies with the notify-send process after eight seconds.
    // The hint is what Omarchy persists, so a row in the notification center
    // is still clickable a week later. If this disappears, old iMessage
    // notifications go inert again and nothing else fails.
    expect(widget).toContain('"--hint=string:omarchy-exec-argv:"');
    expect(widget).toContain('root.moduleName, "goto", chatArg');
    // The chat id goes in as its own argv element, never inside a shell
    // string, and only when it is shaped like a handle.
    expect(widget).toContain("JSON.stringify(");
    expect(widget).toContain("/^[A-Za-z0-9._@:;$-]{1,256}$/.test(chatArg)");
    expect(widget).not.toContain('"bash", "-c"');
  });
});
