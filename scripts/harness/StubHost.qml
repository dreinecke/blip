import QtQuick

// C-009 — the host surface BlipView reads (the 16 members inventoried from
// BlipView.qml), with two fixture WhatsApp threads. WhatsApp-shaped chats keep
// every send inside the copy (SourceId.mjs routes them to the stubbed wa.ts);
// iMessage chats would run the Mac's imsg-send, which must never happen here.
// Numbers are the repo's fiction range (+1 555 010 00xx). Every action lands
// on stderr as a STUB marker for the driver's answer.
QtObject {
  id: host

  property bool online: true
  property bool healthy: true
  property string lastError: ""
  property int unread: 2
  property string version: "harness"
  property string timeFormat: "h:mm AP"
  property string dateFormat: "MMM d"
  property string dateFormatWithYear: "MMM d, yyyy"
  property var uiFontSize: null
  property var uiFontTheme: null
  property var draftCache: ({})
  property var threads: [
    {
      chat: "+15550100001@c.us", guid: "FIXTURE-GUID-1", handle: "+15550100001@c.us",
      name: "Atlas Fixture", ts: "2026-11-14 09:00:00", last_ts: "2026-11-14 09:00:00",
      last_text: "hello from the harness fixture", last_from_me: false,
      pinned: true, unread: 2, service: "WhatsApp"
    },
    {
      chat: "+15550100002@c.us", guid: "FIXTURE-GUID-2", handle: "+15550100002@c.us",
      name: "Second Fixture", ts: "2026-11-13 18:20:00", last_ts: "2026-11-13 18:20:00",
      last_text: "an older, already-read thread", last_from_me: true,
      pinned: false, unread: 0, service: "WhatsApp"
    }
  ]

  function refresh() { console.error("STUB host refresh") }
  function showApp() { console.error("STUB host showApp") }
  function markAllRead() { console.error("STUB host markAllRead") }
  function markThreadRead(chat, seen) {
    console.error("STUB host markThreadRead chat=" + chat + " seen=" + seen)
  }
}
