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
- [x] **Audio messages (inbound)** — verified 1.3.0: the 🎤 chip fetches and
  xdg-opens into mpv (vic's audio/x-m4a handler). Nothing more needed.

## Tier 3 — UX parity

- [x] **Search** — shipped 1.0.0: `/` in list view, snippet centered on the
  match, click opens the thread (live thread object preferred, so groups stay
  sendable); IPC `find <query>`. Theme colors landed with it: accents and
  "my" bubbles follow `Color.accent` (luminance-picked text, iMessage-blue
  fallback for accentless themes). Wheel scroll became DIRECT 1:1 after two
  animated schemes failed against hi-res wheel event floods.
- [x] **Historical group hits** — fixed 1.3.0: groups load by EXACT chat id
  (`imsg thread --chat`, claude-on-mac 1.8.0) — full history reachable, and
  ~20× fewer rows per group load than the old recent-window scan.
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
- [x] **Clickable links** — shipped 1.3.0: URLs in bubbles are live anchors
  (escaped-then-linkified in thread.ts, injection-tested; plain messages keep
  the PlainText fast path). Full preview CARDS (title/thumbnail from the
  pluginPayloadAttachment blob) remain open — binary plist parsing.
- [x] **Failed-delivery flags** — shipped 1.4.0 (claude-on-mac 1.10.0):
  `error` on own rows → red bold "⚠ Not Delivered" in the bubble's time row;
  the collector emits `failures` for own sends that died in the last 15 min,
  toasted exactly once ("⚠ Not delivered to <name>"), not allowlist-gated.

## Tier 4 — the actual app

Architecture (decided 2026-08-31): the app is a `FloatingWindow` hosted
INSIDE the Omarchy shell by the plugin itself — exactly how Omarchy's
dev-gallery does it. It shares the bar widget's poller, push watcher, and
read-state ledger, so **no `blipd` daemon is needed** (that item is retired;
a daemon only returns if the app ever has to run outside the shell).

- [x] **Window skeleton** — shipped 1.5.0: `BlipWindow.qml`, Messages-style
  two-pane layout (sidebar of every thread with dots/previews + a read-only
  text conversation + compose), toggled by IPC `window` (keybind next).
  Shares live data with the panel; reads mark through the same ledger.
- [x] **Shared `BlipView`** — DONE 1.8.0 (plan: `docs/app-design-review.md`).
  `BlipView.qml` holds all state/processes/visuals behind the host contract
  with two always-instantiated panes behind `splitView`; `Panel.qml` is a
  97-line popout host, `BlipWindow.qml` a 60-line window host. Both surfaces
  render every feature from one file. Codex found no split-induced bugs.
- [x] **Window persistence** — 1.8.1: `~/.local/state/blip/window.json`
  remembers open/closed + size; the window restores itself (and requests a
  deep list) when the shell comes back. Verified across a real restart.
- [x] **Keybind** — `SUPER+M` on vic (Lua `o.bind` → IPC `window`, 1.8.1;
  documented in README for others). Esc closes (unwinds first). Size
  persisted. Still open: unread count in the window title; sidebar search.
- [ ] ~~`blipd` daemon~~ — retired (see above).

## Release readiness — Omarchy plugin site

Gate: **Fred says "complete."** Nothing ships to the marketplace before that.

**A. One source (blocker).** Blip currently depends on claude-on-mac ≥1.11.0
on the Mac plus hand-made vic shims with `fnix` hardcoded.
- [x] Vendor the Mac tools into `bridge/mac/` — 1.7.0: pinned in
  `bridge/BRIDGE-VERSION` (claude-on-mac f3612e8 / v1.11.0),
  `scripts/sync-bridge.sh <rev>` refreshes; upstream stays the toolkit.
- [x] Generic Linux shim — 1.7.0: `bridge/linux/blip-shim` installed as
  `~/bin/{imsg,imsg-send,contacts}`, reads `~/.config/blip/bridge.conf`
  (host=, remote_bin single-quoted so it expands on the Mac); `ssh -n`.
- [x] `scripts/blip-setup` — 1.7.0: config, ControlMaster block, shims
  (backs up existing), Mac install over ssh (`bridge/mac/install.sh` →
  `~/.blip/bin`), TCC grant walkthrough + `tcc-check`, smoke test. Dogfooded
  on vic. Still open: `blip-setup` should trigger the Automation prompt with
  a self-send, and tcc-check should filter to the Messages-relevant checks.
- [ ] Self-handles: auto-detected from chat.db already (`imsg-send
  --list-self`); allowlist editor still open. De-vic'd all strings (1.7.0).

**B. Finish the app.**
- [ ] Shared `BlipView` (docs/app-design-review.md) so the window has the
  rich renderer: tapbacks, inline photos, replies, search, attachments.
- [ ] Keybind to toggle the window; remembered size/position; Esc closes;
  sidebar search; unread count in the title.

**C. Polish for strangers' machines.**
- [ ] Remove vic assumptions: paths, mpv/xdg handlers, Hyprland-only bits;
  degrade gracefully (older macOS without `date_edited`, no sips, no HEIC).
- [ ] First-run and offline UX: clear "Mac unreachable / grant missing"
  states with the fix spelled out.
- [ ] Contact photos; link preview cards (nice-to-have).

**D. Ship hygiene.**
- [ ] Full Codex audit (security: ssh, stdin file path, cache, drafts) +
  privacy doc (what lands on disk: state.json, ~/.cache/blip, drafts).
- [ ] README rewrite for non-Fred users; screenshots/GIF; manifest fields
  (description, author, screenshots); CHANGELOG; version 2.0.0.
- [ ] Test on a second Mac/Linux pair before publishing.

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
