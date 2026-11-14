// C-009 canned ThreadOutput — the same shape thread.ts prints, for any chat.
export function threadOutput(chat) {
  const c = String(chat || "");
  return JSON.stringify({
    ok: true, online: true, error: "",
    bubbles: [
      { ts: "2026-11-14 09:00:00", from_me: false, name: "Atlas Fixture",
        text: "hello from the harness fixture", chat: c, service: "WhatsApp",
        day: "Today", groupStart: true, groupEnd: true, time: "9:41 AM",
        receipt: "", tapbacks: [], attachments: [], replyText: "", replyMine: false,
        edited: false, link: null, retracted: false, effect: "", audio: false,
        html: "", failed: false },
      { ts: "2026-11-14 09:00:30", from_me: true, name: "You",
        text: "a reply from me, rendered on the right", chat: c, service: "WhatsApp",
        day: "", groupStart: true, groupEnd: true, time: "9:41 AM",
        receipt: "", tapbacks: [], attachments: [], replyText: "", replyMine: false,
        edited: false, link: null, retracted: false, effect: "", audio: false,
        html: "", failed: false }
    ]
  });
}
