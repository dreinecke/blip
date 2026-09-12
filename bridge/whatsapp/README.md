# The WhatsApp bridge

Blip reads iMessage by shelling out to `~/bin/imsg` and parsing its JSON. This
directory reads **WhatsApp** and answers in exactly the same argv and the same
JSON, so the collector, the thread loader, search, avatars and attachments call
it without knowing there are two messengers.

Nothing above the bridge branches on the source except one file,
[`source-id.ts`](../../source-id.ts), which decides from the conversation id
alone which of the two answers.

## Where the messages come from

[WAHA](https://waha.devlike.pro) — the WhatsApp HTTP API — running in a
container on the same machine, on the **GOWS** engine, reached over loopback
with an `X-Api-Key` header.

> ⚠️ **Never stop or recreate the container to make something here work.** A
> restart comes back demanding a QR scan from the phone, and repeated failed
> scans earn a temporary block from WhatsApp itself. Everything the bridge
> needs is a read or a send against the running session.

## Configuration

In `~/.config/blip/bridge.conf`, parsed as data like every other key there:

| Key | Default | Meaning |
|---|---|---|
| `waha_url` | `http://127.0.0.1:3010` | where the container answers |
| `waha_session` | `default` | the linked session's name |
| `waha_key_file` | `~/.config/waha/.env` | the file holding `WHATSAPP_API_KEY` |
| `waha_key` | — | the key itself, if you would rather not point at a file |
| `waha_send` | `off` | `on` lets the composer send WhatsApp messages |

The key is read from WAHA's **own** env file by default rather than copied into
`bridge.conf`, so there is no second copy to go stale.

## The tools

```sh
bun wa.ts --json chats 300              # the conversation list  → ChatInfo[]
bun wa.ts --json recent 150             # the poll window        → ImsgMessage[]
bun wa.ts --json --rich thread --chat <jid> 80
bun wa.ts --json groups                 # rooms and their members
bun wa.ts --json search --stdin 80      # needle on STDIN, never argv
bun wa.ts avatar --chat <jid>           # image bytes on stdout
bun wa.ts attachment <message id>       # media bytes on stdout
bun wa.ts watch                         # an invalidation channel
bun wa.ts send --to <jid> --yes --text-stdin
bun wa.ts read --chat <jid> | read --all
bun wa.ts status
```

Exit 0 fine, **69** the container is unreachable or the session is not linked,
1 anything else — the same codes the Mac shim uses, so the collector's existing
offline handling applies unchanged.

## Things that are true here and not on the Mac

- **A conversation id is a JID.** `…@c.us` is a person, `…@g.us` a room,
  `…@lid` a person addressed by their WhatsApp-internal id. The suffix is the
  whole routing rule, and it is also why the two messengers share
  `state.json`'s per-chat maps without a compound key: no phone number, email,
  32-hex id or `chat<digits>` can be read as a JID.

- **⚠️ A message's `from` names nobody.** On this engine it is a `@lid` integer
  for almost every direct message and the ROOM's id inside a group. The person
  is `_data.Info.SenderAlt` (their number) and `_data.Info.PushName` (the name
  they chose). Reading `from` is the bug that labelled every row with a number.

- **⚠️ `_data.Info.Chat` is not the conversation's id.** It is the `@lid`
  addressing form of the same conversation, so taking it would split one
  conversation into two threads that never merge. Every caller passes in the
  id it asked for.

- **Read state exists only where WhatsApp has a receipt.** `ack: 3` means read
  on some device of yours — so reading on the phone lands here — and `ack: 2`
  means delivered and not read. It is `null` for most older conversations,
  because GOWS only tracks what it saw live, and an absent `read` is exactly
  what Blip's unread rule expects from a bridge that cannot say: the local
  marks alone decide for that conversation.

- **Marking read reaches the phone**, through `POST /api/sendSeen`. It opens
  nothing and steals no focus, so unlike the Mac's `imsg-read` it is not held
  back by `push_read` — a WhatsApp conversation pushes its read on every open.

- **The poll costs one HTTP call.** `chats/overview` returns every
  conversation with its newest message. Only a conversation that MOVED and is
  inbound costs a second call, to fetch its rows since the read mark — which is
  what keeps Blip's badge an exact count of unread messages rather than of
  unread conversations.

- **`watch` polls rather than listening.** WAHA's webhooks would be better, but
  configuring one is a session write, and a session write risks the QR. Polling
  `chats/overview` on loopback every three seconds costs nothing and prints the
  same content-free invalidation line `imsg watch` prints.

## Not here yet

- **Sending files.** Text only; the composer says so rather than aiming a
  WhatsApp conversation at the Mac's sender.
- **Link preview cards, tapbacks, edits.** The data is in `_data.Message` and
  unmapped.
- **Pins.** WhatsApp has them; WAHA's CORE tier does not report them, and Blip
  never writes a pin, so every WhatsApp conversation is unpinned.
