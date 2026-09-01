# Privacy — what Blip touches, and where

Blip has no server, no telemetry, no accounts. Everything runs between your
Linux machine and a Mac you own, over your own ssh. This is the complete
inventory of what lands on disk.

## On the Linux machine

| Path | Contains | Never contains |
|---|---|---|
| `~/.config/blip/bridge.conf` (0600) | Mac ssh target, remote tool dir | credentials (ssh keys stay in `~/.ssh`) |
| `~/.config/blip/allowlist.json` | handles allowed to raise desktop toasts | message text |
| `~/.local/state/blip/state.json` (0600, atomic) | poll watermark, read marks, per-chat unread counts and oldest-unread timestamps, self-chat ids, group names/members, opaque SHA-256 toast keys | **message bodies — ever** |
| `~/.local/state/blip/window.json` | whether the app window was open, its size | anything else |
| `~/.cache/blip/att/` (0700, files 0600, 500 MB LRU) | attachments you viewed (photos, PDFs…), fetched on demand; HEIC arrives converted to JPEG | attachments you did not open |
| `$XDG_RUNTIME_DIR/blip/` (tmpfs, 0700) | images pasted into the compose box, until sent; swept after an hour and gone at logout | — |
| `~/bin/imsg`, `~/bin/imsg-send`, `~/bin/contacts` | the bridge shim (a bash script) | — |

Message text lives only in memory while the panel or window is open. Desktop
toasts show a sender name and a preview through your notification daemon,
gated by the allowlist. Nothing is logged.

## On the Mac

| Path | Contains |
|---|---|
| `~/.blip/bin/` | the bridge tools (`imsg`, `imsg-send`, `contacts`, `tcc-check`, `blip-check`) |
| `~/.blip/src/` | the installer's copy of the same files |
| `~/Pictures/.blip-outbox/<id>/` | a file you are sending, for the seconds until Messages copies it into its own store; then deleted (leftovers older than an hour are swept) |

The tools read `~/Library/Messages/chat.db` and the AddressBook database
read-only, and drive Messages.app through AppleScript. They write nothing
else. Messages.app itself keeps your conversation history exactly as it
always has.

## Permissions the Mac asks for

- **Full Disk Access** for `/usr/libexec/sshd-keygen-wrapper` — so an ssh
  session can read `chat.db`.
- **Automation → Messages** for the same — so an ssh session can send.

Both are one-time grants in System Settings; `blip-check` reports which are
missing. Blip never asks for Contacts, Camera, Microphone, or Location.

## What crosses the network

Only ssh between the two machines: message queries and previews, attachment
bytes you request, and files you send. Push notifications use a
content-free "something changed" ping — a watcher on the Mac emits a
timestamp when `chat.db` changes; the client then fetches privately.

## What Blip cannot do

Send read receipts, send tapbacks, edit or unsend, see typing indicators.
Those need Apple private APIs that Blip deliberately does not use.
