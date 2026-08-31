# Blip — agent notes

Blip is an Omarchy (QuickShell/QML) bar plugin that puts iMessage on Linux by
treating a Mac as the gateway. Read this before touching anything.

## Shape

```
(Mac side)    imsg, imsg-send      from github.com/nixfred/claude-on-mac ≥ 1.5.1 — sqlite read of chat.db;
                                    `--rich` adds tapbacks/read_at/reply_to/attachments to thread JSON.
                                    AppleScript send; `imsg --json groups`; Recently Deleted hidden.
(Linux side)  ~/bin/imsg, imsg-send claude-on-mac's bin/remote/ ssh shims (CLAUDE_ON_MAC_TARGET), or any
                                    equivalent that execs the Mac tool over ssh. Blip only calls ~/bin/imsg*.
collector.ts                        poll → {threads, unread, toast}. Pure functions + one spawn.
thread.ts                           one conversation → decorated bubbles. Pure + one spawn.
fetch.ts                            attachment id → ~/.cache/blip/att (0700/0600, 500MB LRU).
send-file.ts                        local file + caption → imsg-send --file-stdin. Resolves
                                    group guid from state; REFUSES unknown groups.
paste.ts                            clipboard snapshot → draft image in $XDG_RUNTIME_DIR/blip or text.
BarWidget.qml                       the single poller, badge, toasts, IPC.
Panel.qml                           list view + conversation view + compose. Renders only.
manifest.json                       plugin id nixfred.blip
```

Logic lives in TypeScript where it can be unit-tested (`bun test`). QML renders
what it is handed. Keep it that way.

## Invariants — do not break

- **Never send to a handle for a group.** A group thread's `handle` is whichever
  member spoke last. `isSendable()` tests the *chat* id; groups send
  `--chat-id <full guid>` (`any;+;<32hex>`), DMs send `--to <chat>`.
- **Two read marks.** `watermark` = what the collector has seen (drives toasts).
  `readMark` / `readMarks[chat]` = what the user has looked at (drives the badge
  and the blue dots). Collapsing them makes the badge flash and reset.
- **Reads are optimistic-with-suppression.** Persistent read state moves only
  via collector runs (~1 s), so BarWidget applies reads to the local model
  IMMEDIATELY and remembers them in `localReads[chat]` (thread last_ts at
  read time, 60 s TTL). Every collector result is filtered through that
  ledger — a poll in flight when the user opened a thread must not resurrect
  the dot for one round-trip. A chat only shows unread again when a NEWER
  inbound exists. Refreshes carry `activeReadChat()` so a message landing in
  the conversation being READ is counted read in the same run — never
  flashed. Same-chat read refreshes coalesce in the queue.
- **Unread is ledger-backed.** `unreadCounts` and `unreadOldest` persist per-chat
  metadata without message bodies. Catch-up fetches cover new arrivals and the
  oldest outstanding unread so deletions are reconciled; never derive the total
  badge solely from the preview window.
- **Dedupe the self-thread before counting.** A message you send yourself lands
  twice (`from_me` true and false, same ts+text). `dedupeSelfEcho()` runs before
  `buildThreads()` and before `decorate()`.
- **`PanelKeyCatcher` eats keys before focused children.** Any editor that
  should receive typing must be covered by its `blocked:` binding.
- **Pass `--` before message text** to both `imsg-send` and `notify-send`.
- **No message content in state.json.** `~/.local/state/blip/state.json` holds
  timestamps, counts, opaque SHA-256 toast keys, self-chat ids, and group
  metadata. It is atomic and `0600`; no message bodies are allowed. EXCEPTION
  (Fred, 2026-08-31): fetched MEDIA caches as plain files in
  `~/.cache/blip/att` (0700/0600, 500 MB LRU) — vic's disk is LUKS-encrypted
  at rest. Message text still never lands on disk.
- **The vic shims' ssh preflight must use `ssh -n`.** A bare
  `ssh fnix true` connectivity probe EATS STDIN, which silently empties
  `imsg-send --file-stdin` payloads. Fixed 2026-08-31 in ~/.claude/bin shims.
- **`chat:null` exists.** Use `chatKey()`; never `String(m.chat)`.
- **Group ids come in two shapes**: 32 hex, or `chat<digits>`. `isGroupChat()` is
  "not a phone/email" — never a positive regex on one shape.
- **Deleted messages stay in chat.db for 30 days** (`chat_recoverable_message_join`).
  claude-on-mac's `imsg` hides them (1.4.0+); Blip assumes that.
- **Never let one delegate's implicit width exceed the panel.** A single
  RowLayout of N attachment chips summed implicit widths and silently
  stretched the whole conversation column to 2× panel width — every
  right-aligned element rendered off-panel, invisible, with no QML warning.
  Attachment chips are one per row for this reason. Debug trick: log
  `bubbleRow.width` per delegate; 1136 in a 560 panel = this bug.

## Working on it

```
bun test                                   # 90+ tests, ~40 ms
bun collector.ts --deep | jq .unread       # live against the Mac
bun thread.ts <chat-id> 40 | jq .bubbles   # one conversation
cp *.qml *.ts manifest.json ~/.config/omarchy/plugins/nixfred.blip/
omarchy-restart-shell                      # new QML files need a restart; edits hot-reload
qs -p /usr/share/omarchy/shell ipc call nixfred.blip status
qs -p /usr/share/omarchy/shell ipc call nixfred.blip goto 15550100001   # bare digits: qs rejects a leading "+"
```

IPC function names must not collide with `qs ipc` subcommands (`show` did).

## Verifying UI changes

Screenshot it: `grim -g "1300,40 620x860" out.png` with the panel open, then
look at the image. QML has no unit tests; every layout bug so far was found
that way, not by reading code.

Never inject keystrokes (`wtype`) unless the panel is confirmed open — they go
to whatever has focus otherwise.

## Things that are not possible

- Read receipts. `open imessage://<handle>` on the Mac does not flip `is_read`.
- Tapbacks, edits, typing indicators out. Needs SIP-off code injection; rejected.

## Things that ARE possible (verified 2026-08-31)

- **Attachments out.** `send POSIX file` works on Sequoia IF the file is staged
  in `~/Pictures/` — from anywhere else Messages fails silently (`error=25`,
  "Not Delivered"). Verified delivered for PNG and PDF. See ROADMAP.md.
