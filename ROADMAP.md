# Blip roadmap — toward iMessage parity

Verified against fnix chat.db 2026-08-31: 27,118 tapbacks, 45,979 read receipts
on sent messages, 4,515 inline replies, 819 edits/unsends, 30 audio messages,
and a readable Contacts DB (3,694 records). Everything below Tier 4 needs no
changes to the Mac beyond claude-on-mac updates.

## Tier 1 — display parity (data already in chat.db, read-only)

- [x] **Contact names + avatars** — names + initials circles predated this
  roadmap (imsg resolves Contacts natively). Contact PHOTOS still open —
  needs image transfer + the same cache decision as attachments.
- [x] **Read receipts (inbound)** — shipped 0.8.0 via `imsg --rich` `read_at`;
  "Read 4:42 PM" under the newest read from-me bubble only.
- [x] **Tapbacks on bubbles** — shipped 0.8.0: corner pills, net add/remove
  per sender, custom emoji included; the `Loved "…"` pseudo-rows are folded.
- [x] **Inline replies** — shipped 0.8.0: quoted snippet above the bubble.
- [x] **Edited / unsent markers** — shipped 0.8.0: "· Edited" in the time row,
  "unsent a message" tombstone.
- [x] **Attachment previews (stage 1)** — shipped 0.8.0: one chip per row
  (NEVER one row of N chips — implicit-width inflation, see CLAUDE.md);
  `.pluginPayloadAttachment` link-preview blobs filtered (imsg 1.5.1).
- [x] **Send-effect labels** — shipped 0.8.0: "· sent with confetti" in the
  time row.

## Tier 2 — attachments both directions (SHIPPED 0.9.0, 2026-08-31)

- [x] **Inbound fetch + inline images** — `imsg attachment <id>` streams bytes
  over the existing shim (binary-clean; the vic shims' ssh preflight needed
  `-n` or it ate stdin); HEIC→JPEG via `sips --jpeg`. Images ≤5 MB in the open
  conversation auto-fetch and render inline; everything else is click-to-fetch
  → `xdg-open`. Cache: `~/.cache/blip/att`, 0700/0600, 500 MB LRU by mtime
  (Fred's call: plain files — vic's disk is LUKS-encrypted at rest).
- [x] **Outbound files** — `imsg-send --file-stdin --name X`: file crosses on
  STDIN (never a Mac path — no exfil surface), staged in
  `~/Pictures/.blip-outbox` (subfolder verified OK for the Sequoia quirk),
  deleted post-send (Messages copies into its own store first) + 1 h GC.
  Compose: Ctrl+V image paste (paste.ts snapshots the clipboard ONCE),
  `/attach <path>`, drag-and-drop; draft chip with ✕; caption rides along,
  reported per-part. Verified delivered from vic end-to-end.
- [ ] **Audio messages (inbound)** — fetch path exists; needs a play affordance
  (chips already fetch + xdg-open, so this is polish).

## Tier 3 — UX parity

- [x] **Search** — shipped 1.0.0: `/` in list view, snippet centered on the
  match, click opens the thread (live thread object preferred, so groups stay
  sendable); IPC `find <query>`. Theme colors landed with it: accents and
  "my" bubbles follow `Color.accent` (luminance-picked text, iMessage-blue
  fallback for accentless themes). Wheel scroll became DIRECT 1:1 after two
  animated schemes failed against hi-res wheel event floods.
- [ ] **Historical group hits** — a search hit in a group older than the
  1,500-message scan window opens an empty thread (Codex finding, 1.0.0).
  Needs `imsg thread --chat <id>` on the Mac side to load groups by chat id.
- [x] **New-conversation composer** — shipped 1.2.0: `n` / "＋ new" opens a
  contact picker (`contacts --json find` over the bridge; every phone/email
  is its own row, Apple `_$!<Mobile>!$_` labels unwrapped, bare numbers and
  emails accepted directly); IPC `newchat <query>`.
- [x] **Reply from the toast** — shipped 1.2.0/1.2.1: clicking the toast
  opens the panel on that conversation, compose focused (`--wait` +
  default action; 45 s watchdog since the daemon pauses expiry on hover).
  The daemon renders no action BUTTONS and only invokes `default`, so a
  separate Reply button (and inline text entry) would need a daemon patch.
- [x] **Real-time push** — shipped 1.1.0: `imsg watch` (claude-on-mac 1.7.0)
  emits content-free pings on chat.db/WAL mtime change; Blip debounces 250 ms
  into a refresh AND reloads the open conversation in parallel. Poll stretches
  6 s → 60 s while `push=true` (see `status`); watcher restarts 8 s after any
  exit. Measured ~2 s message-to-screen (was ≤6 s poll + serial reload).
- [ ] **Link previews** — parse rich-link payload attachments for title/image.

## Tier 4 — the actual app

- [ ] **`blipd` daemon** — extract collector/thread/watcher behind a local
  socket; bar plugin becomes a thin client.
- [ ] **Standalone window** — QuickShell window reusing the existing QML,
  Messages.app layout (sidebar + conversation). Tauri v2 only if it ever needs
  to run off-Omarchy.

## Prior art

- **[BlueFerry](https://github.com/erikwb/blueferry)** — iMessage on Linux over
  Bluetooth MAP straight to the iPhone (no Mac). Decision 2026-08-31: fnix
  stays Blip's source (BT gets no attachments, no tapbacks, no history, shaky
  groups), but BlueFerry does two things Blip can't: **mark messages read on
  the phone** and push-latency delivery. Its Quickshell client is worth
  reading; a future hybrid could borrow BT MAP *just* for read-marking.
  Check its license before lifting code.

## Not possible (and why)

- **Outbound tapbacks / edits / typing indicators** — no public API; requires
  BlueBubbles-style code injection into Messages.app, which requires disabling
  SIP (System Integrity Protection) on the Mac. Rejected for fnix: daily
  driver, not worth the security downgrade.
- **Sending read receipts** — `open imessage://` does not flip `is_read`.
- **Group add/rename** — AppleScript cannot.
