<p align="center">
  <img src="docs/hero.svg" alt="Blip — iMessage in the Omarchy bar" width="920">
</p>

<h1 align="center">Blip</h1>

<p align="center">
  <b>iMessage. On Linux. For real.</b><br>
  Read, send, group chats, blue dots, desktop toasts — from an Omarchy bar widget.<br>
  Your Mac does the talking. Your Linux box does the living.
</p>

<p align="center">
  <img alt="Omarchy" src="https://img.shields.io/badge/Omarchy-plugin-5fd7ff?style=flat-square">
  <img alt="QuickShell" src="https://img.shields.io/badge/QuickShell-QML-0a84ff?style=flat-square">
  <img alt="bun" src="https://img.shields.io/badge/bun-TypeScript-f9f1e1?style=flat-square">
  <img alt="tests" src="https://img.shields.io/badge/tests-113%20passing-2ea043?style=flat-square">
  <img alt="license" src="https://img.shields.io/badge/license-MIT-lightgrey?style=flat-square">
</p>

---

> ### ⚠️ You need a Mac. That is the whole trick.
> Blip does **not** reimplement iMessage. Apple's protocol only runs on Apple
> hardware, so Blip uses a Mac you already own — any Mac signed into your
> Apple ID, awake and reachable over SSH — as the gateway. The Linux side is a
> thin client. **No Mac, no Blip.** When the Mac sleeps, Blip dims and waits.

## Why this exists

iMessage is macOS-only. Everyone who lives on Linux and owns an iPhone knows the
dance: pick up the phone, unlock it, type on glass, put it down, lose the
thread. BlueBubbles wants SIP off. AirMessage wants a server and a prayer.

Blip does something simpler. **The Mac you already own is the gateway.** It
holds `chat.db` and it can drive Messages.app with AppleScript. Everything else
is one multiplexed SSH socket and a bar widget that looks like it belongs.

No SIP disabled. No daemon on the Mac. No private API. No message cache on the
Linux side. If the Mac is asleep, the widget dims and says so.

## What you get

<table>
<tr>
<td width="50%" valign="top">

**In the bar**
- unread count across every thread
- dims with a slashed glyph when the Mac is unreachable
- left-click panel · **double-click opens the app window** · middle-click refresh · right-click mark all read

**Thread list**
- avatar initials, name, preview, time
- **blue dot** that stays until you open *that* conversation — iMessage semantics, not "I glanced at the list"
- groups titled the way Messages.app titles them: the group's name, else its members

</td>
<td width="50%" valign="top">

**Conversation**
- real bubbles — yours blue on the right, theirs grey on the left
- grouped into runs with one timestamp per run, day dividers, squared "tail" corner
- sender names above each run in a group
- **tapbacks** — ❤️👍😂 pills on the bubble corner, custom emoji included
- **"Read 4:42 PM"** under the last message of yours they've read (display only — Blip never sends receipts)
- **inline replies** quoted above the bubble · **Edited** tags · "unsent a message" tombstones
- **photos render inline** — images ≤5MB auto-fetch over SSH (HEIC converted on the Mac); click opens full-size. PDFs/videos are chips — click fetches and opens them
- **send files** — Ctrl+V an image into the compose box, type `/attach <path>`, or drag-and-drop; a caption rides along
- select text and Ctrl+C · right-click a bubble to copy it whole
- compose box at the bottom, Enter sends — **DMs and groups**

**Toasts**
- desktop notification only for senders on your allowlist
- everything else still counts and still shows; it just doesn't interrupt you

**Toast actions**
- click a toast and the panel opens ON that conversation with the compose
  box focused (the Omarchy daemon renders no action buttons, so click IS
  the reply path)

**The app**
- double-click the bar icon (or IPC `window`) for a Messages-style window:
  sidebar of every conversation + the open thread + compose, tiled by
  Hyprland like any app, sharing the bar widget's live data

**Real-time**
- a push watcher on the Mac pings when chat.db changes — messages land in
  ~2 s, the open conversation refreshes itself, and the poll drops to a
  60 s safety net (`status` shows `push=true`)

</td>
</tr>
</table>

## How it works

<p align="center">
  <img src="docs/architecture.svg" alt="architecture" width="920">
</p>

```
Linux                                         Mac
─────                                         ───
BarWidget.qml  ── every 6 s ──▶ collector.ts ──▶ ssh ──▶ imsg --json recent 150+
                                                          (sqlite, read-only)
Panel.qml      ── open thread ─▶ thread.ts   ──▶ ssh ──▶ imsg --json thread <id> 80
Panel.qml      ── Enter ───────────────────────▶ ssh ──▶ imsg-send --to <id> --yes -- "text"
                                                          imsg-send --chat-id "any;+;<guid>" …
                                                          (AppleScript → Messages.app)
```

The trick that makes it possible: **`sshd` on macOS inherits both Full Disk
Access and Automation consent.** `cron` gets neither. So a plain SSH session can
read `chat.db` and tell Messages.app to send, where every scheduled approach
dies at a TCC prompt nobody is there to click.

With `ControlMaster` in `~/.ssh/config`, a round trip is ~47 ms warm. Fast
enough to poll, fast enough that the panel feels local.

## Install

Blip's entire Mac side is **[claude-on-mac](https://github.com/nixfred/claude-on-mac)** —
a small toolkit that teaches an AI agent (or a shell) to read `chat.db` and drive
Messages.app with per-message consent. Blip doesn't fork it or vendor it; it
calls `imsg` and `imsg-send` and nothing else. Install that first.

**Requirements**

- A Mac signed into Messages with your Apple ID (a Mac mini in a closet is
  perfect), reachable from the Linux box over SSH — Tailscale recommended.
- *Messages in iCloud* on, so the Mac's `chat.db` mirrors your phone.
- claude-on-mac **≥ 1.6.0** (`imsg --rich` + `imsg attachment` streaming +
  `imsg-send --file-stdin`; plus `imsg groups` and the Recently-Deleted filter).
- Linux: [Omarchy](https://omarchy.org), `bun`, `notify-send`, `wl-copy`.

**1. On the Mac** — follow claude-on-mac's README (it's one paste into Claude
Code), then its [`docs/remote-ssh.md`](https://github.com/nixfred/claude-on-mac/blob/main/docs/remote-ssh.md):
enable Remote Login, grant Full Disk Access to `/usr/libexec/sshd-keygen-wrapper`,
and warm the Messages Automation grant once from an SSH session.

**2. On Linux** — claude-on-mac's remote shims, per the same doc:

```sh
export CLAUDE_ON_MAC_TARGET=you@your-mac.tail1234.ts.net   # in your shell rc
ln -s ~/claude-on-mac/bin/remote/imsg      ~/bin/imsg
ln -s ~/claude-on-mac/bin/remote/imsg-send ~/bin/imsg-send
imsg recent 5                                   # if this prints messages, the bridge is up
imsg --json groups 3                            # needs ≥ 1.4.0
```

**3. Blip**

```sh
git clone https://github.com/nixfred/blip ~/.config/omarchy/plugins/nixfred.blip
omarchy-restart-shell
```

Add `{ "id": "nixfred.blip" }` to `bar.layout.right` in
`~/.config/omarchy/shell.json`, restart the shell again, and the speech bubble
is in your bar.

**Toasts**

```jsonc
// ~/.config/blip/allowlist.json — re-read every poll, no restart
{ "allow": ["+15551234567", "them@icloud.com"] }
```

## Keyboard

| where | key | does |
|---|---|---|
| list | `j` / `k` · `↑` / `↓` | move |
| list | `Enter` · `1`–`9` | open thread |
| list | `r` | refresh |
| list | `a` · *mark all read* link | clear every badge and dot (local only — iMessage itself is not told) |
| list | `/` | search every message ever — Enter runs it, click a hit to open its conversation, Esc backs out |
| list | `n` · *＋ new* link | start a conversation with anyone — search contacts by name, or type a number/email directly |
| thread | `Enter` | send (text, or the queued file with the text as caption) |
| thread | `Ctrl+V` | paste — an image on the clipboard becomes a queued file, text pastes normally |
| thread | `/attach <path>` + `Enter` | queue any file on this machine; drag-and-drop works too |
| thread | `Esc` | back to list (or clear a text selection first) |
| anywhere | `Esc` | close |

IPC, for scripts and other plugins:

```sh
qs -p /usr/share/omarchy/shell ipc call nixfred.blip status
qs -p /usr/share/omarchy/shell ipc call nixfred.blip goto 15551234567   # bare digits
qs -p /usr/share/omarchy/shell ipc call nixfred.blip read               # mark all read
```

## Design notes worth knowing

**Two read marks, not one.** The collector keeps `watermark` (highest timestamp
it has *seen* — drives toasts) separate from `readMark` and per-thread
`readMarks` (highest timestamp *you* have looked at — drives the badge and the
dots). Fold them together and the badge flashes to 1 and resets on the next
poll. Yes, that shipped once.

**Unread is a ledger, not a window.** The latest 150 rows are enough for normal
previews, but unread counts and oldest-unread timestamps live in a metadata-only
per-chat ledger. Blip expands the fetch to cover new arrivals and the oldest
outstanding unread, then rebuilds exact counts from that range. An unread cannot
fall off the preview window or remain counted after deletion.

**Groups send by GUID.** Message rows carry a group as a bare
`chat_identifier` (32 hex, or `chat<digits>`); AppleScript's `chat id` wants
the full `any;+;<id>`. A group's `handle` field is whichever member spoke last
— send to *that* and you DM one person while the panel shows the group.
`imsg groups` supplies the real GUID; a group whose GUID isn't cached yet is
read-only rather than guessed.

**The self-thread lies.** A message you send yourself lands twice: once
`from_me=true`, once `from_me=false`, same timestamp and text. Every counter and
every bubble runs through `dedupeSelfEcho()` first or your own notes light the
badge forever.

**Deleted means deleted.** macOS keeps deleted messages in a 30-day "Recently
Deleted" bin that is still in `chat.db`. claude-on-mac's `imsg` hides those rows, so
a conversation you delete on the phone disappears from Blip within one poll of
the iCloud sync. `IMSG_INCLUDE_DELETED=1` shows them again.

**No message bodies are stored on Linux.** `~/.local/state/blip/state.json`
holds timestamps, unread counts, SHA-256 toast-dedupe keys, inferred self-chat
ids, and group metadata. It is written atomically with mode `0600`; legacy
plaintext toast keys are hashed on migration. No message text is persisted.
The 273,000-message history stays on the Mac where it lives.

## What it can't do

- **Send read receipts.** Tested: opening the conversation on the Mac via
  `open imessage://…` does not flip `is_read`. Needs Apple's private API.
  (Showing *their* receipts on your messages works fine — that's in.)
- **Send tapbacks, edits, or threaded replies.** AppleScript can't; Blip
  *displays* all three. If you need to send them,
  [BlueBubbles](https://bluebubbles.app) is the right tool and requires
  disabling SIP.
- **Work without a Mac, or while the Mac sleeps.** Inherent to the approach.
  The widget dims and tells you.

## Development

```sh
bun test                                     # 113 tests, ~50 ms
bun collector.ts --deep | jq '.unread, (.threads|length)'
bun thread.ts +15551234567 40 | jq '.bubbles[-1]'
```

Logic lives in TypeScript where it can be tested; QML only renders. Every
layout bug so far was found with `grim` and eyeballs, not by reading code —
screenshot your changes. See [CLAUDE.md](CLAUDE.md) for the invariants.

## Credits

Built by Fred Nix and Larry (his Claude Code collaborator) in one evening on
[Omarchy](https://omarchy.org). The Mac side is entirely
[claude-on-mac](https://github.com/nixfred/claude-on-mac) — it predates Blip,
and it's the reason this took an evening, not a week.

MIT.
