#!/usr/bin/env bun
/**
 * `wa` — the WhatsApp bridge, wearing `imsg`'s clothes.
 *
 * Every subcommand takes the argv `imsg` takes and prints what `imsg` prints,
 * so the collector, the thread loader, search, avatars and attachments can
 * call it through `source.ts` without learning anything new.
 *
 *   bun wa.ts --json chats 300
 *   bun wa.ts --json recent 150
 *   bun wa.ts --json --rich thread --chat <jid> 80
 *   bun wa.ts --json groups
 *   bun wa.ts --json search --stdin 80        (query on STDIN, never argv)
 *   bun wa.ts avatar --chat <jid> | avatar -- <jid>
 *   bun wa.ts attachment <message id> [--jpeg] [--max-dim N]
 *   bun wa.ts watch
 *   bun wa.ts send --to <jid> --yes --text-stdin        (text on STDIN)
 *   bun wa.ts read --chat <jid> [--seen <stamp>] | read --all
 *
 * Exit codes follow the shim: 0 fine, 69 the bridge is unreachable or the
 * session is not linked, 1 anything else. Message text never rides argv.
 */

import { loadState } from "../../collector";
import type { ChatInfo, ImsgMessage } from "../../collector";
import {
  Waha, chatId, chatName, contactJid, explain, isSkippableChat, isWhatsAppChat,
  isWhatsAppGroup, loadConfig, recent, toChatInfo, toMessage,
} from "./waha";
import type { WaChatSummary } from "./waha";

const OFFLINE = 69;

function argOf(argv: string[], flag: string): string {
  const i = argv.indexOf(flag);
  return i >= 0 ? String(argv[i + 1] ?? "") : "";
}

function firstNumber(argv: string[], fallback: number): number {
  for (const a of argv) if (/^[0-9]+$/.test(a)) return Number(a);
  return fallback;
}

function die(err: unknown, url: string): never {
  const message = explain(err, url);
  process.stderr.write(message + "\n");
  process.exit(/not answering|not linked|rejected the API key/.test(message) ? OFFLINE : 1);
}

async function readStdin(): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks);
}

/** Bytes for a picture or an attachment, straight through to stdout. */
async function pipe(url: string, max = 16 * 1024 * 1024): Promise<boolean> {
  const res = await fetch(url);
  if (!res.ok) return false;
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length === 0 || buf.length > max) return false;
  process.stdout.write(buf);
  return true;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const conf = loadConfig();
  const waha = new Waha(conf);
  const cmd = argv.find((a) => !a.startsWith("-")) || "";

  try {
    switch (cmd) {
      // ---------------------------------------------------------- chats
      case "chats": {
        const rows = await waha.overview(Math.max(firstNumber(argv, 300), 50));
        const out = rows.map(toChatInfo).filter((c): c is ChatInfo => c !== null);
        console.log(JSON.stringify(out));
        return;
      }

      // --------------------------------------------------------- recent
      case "recent": {
        // The read mark bounds how far back a moved conversation is asked to
        // go; without it every poll would walk each chat's whole history.
        const mark = loadState().readMark || "";
        console.log(JSON.stringify(await recent(waha, firstNumber(argv, 150), mark)));
        return;
      }

      // --------------------------------------------------------- groups
      case "groups": {
        const rows = await waha.overview(300);
        const out: Record<string, unknown>[] = [];
        for (const row of rows) {
          const id = chatId(row);
          if (!isWhatsAppGroup(id)) continue;
          const participants: string[] = [];
          const participantNames: Record<string, string> = {};
          try {
            for (const p of await waha.participants(id)) {
              participants.push(p.handle);
              if (p.name) participantNames[p.handle] = p.name;
            }
          } catch { /* a group we cannot enumerate still gets its name */ }
          out.push({
            chat: id,
            name: chatName(row) || "",
            // WhatsApp has no AppleScript chat guid; the JID IS the send
            // target, and source.ts sends a group by --chat-id.
            guid: id,
            participants,
            participant_names: participantNames,
          });
        }
        console.log(JSON.stringify(out));
        return;
      }

      // --------------------------------------------------------- thread
      case "thread": {
        const chat = argOf(argv, "--chat") || argv.find((a) => a.includes("@")) || "";
        if (!chat) { console.log("[]"); return; }
        const limit = firstNumber(argv, 80);
        const rows = await waha.messages(chat, limit);
        let name: string | null = null;
        if (!isWhatsAppGroup(chat)) {
          try {
            const found = (await waha.overview(300)).find((r: WaChatSummary) => chatId(r) === chat);
            name = found ? chatName(found) : null;
          } catch { /* an unnamed thread still renders */ }
        }
        console.log(JSON.stringify(rows.map((m) => toMessage(m, chat, name))));
        return;
      }

      // --------------------------------------------------------- search
      case "search": {
        const needle = (argv.includes("--stdin")
          ? (await readStdin()).toString("utf8")
          : argOf(argv, "--query")).trim().toLowerCase();
        if (!needle) { console.log("[]"); return; }
        const limit = firstNumber(argv, 80);
        const rows = await waha.overview(300);
        const hits: ImsgMessage[] = [];
        for (const row of rows) {
          const id = chatId(row);
          if (!id || isSkippableChat(id) || hits.length >= limit) continue;
          const name = chatName(row);
          try {
            for (const m of await waha.messages(id, 200)) {
              const msg = toMessage(m, id, name);
              if (msg.text.toLowerCase().includes(needle)) hits.push(msg);
              if (hits.length >= limit) break;
            }
          } catch { /* skip a chat that will not load */ }
        }
        console.log(JSON.stringify(hits));
        return;
      }

      // --------------------------------------------------------- avatar
      case "avatar": {
        const target = argOf(argv, "--chat")
          || argv[argv.lastIndexOf("--") + 1]
          || argv[argv.length - 1] || "";
        const url = await waha.picture(contactJid(target));
        if (!url || !(await pipe(url, 2 * 1024 * 1024))) process.exit(1);
        return;
      }

      // ----------------------------------------------------- attachment
      case "attachment": {
        const id = argv[argv.indexOf("attachment") + 1] || "";
        // A WhatsApp media id names its chat, which is what the download
        // endpoint keys on: `<fromMe>_<chat jid>_<message id>[…]`.
        const chat = id.split("_")[1] || "";
        if (!chat) process.exit(1);
        const rows = await waha.messages(chat, 200, { media: true });
        const hit: any = rows.find((m) => String(m.id) === id);
        const url = hit?.mediaUrl || hit?.media?.url || "";
        if (!url || !(await pipe(url))) process.exit(1);
        return;
      }

      // ---------------------------------------------------------- watch
      case "watch": {
        // An invalidation channel, exactly like `imsg watch`: a line means
        // "something changed, come and look", never what changed.
        process.stdout.write("ready\n");
        let newest = "";
        let beat = Date.now();
        for (;;) {
          try {
            const rows = await waha.overview(50);
            let max = "";
            for (const r of rows) {
              const ts = String(r.lastMessage?.timestamp ?? "");
              if (ts > max) max = ts;
            }
            if (max && max !== newest) {
              if (newest) process.stdout.write(`${Math.floor(Date.now() / 1000)}\n`);
              newest = max;
            }
          } catch { /* a blip in the container is not a reason to exit */ }
          if (Date.now() - beat > 30000) { process.stdout.write("hb\n"); beat = Date.now(); }
          await new Promise((r) => setTimeout(r, 3000));
        }
      }

      // ----------------------------------------------------------- send
      case "send": {
        if (!conf.send) {
          process.stderr.write(
            "WhatsApp sending is off — set waha_send=on in ~/.config/blip/bridge.conf\n");
          process.exit(1);
        }
        const chat = argOf(argv, "--to") || argOf(argv, "--chat-id");
        if (!chat) { process.stderr.write("no recipient\n"); process.exit(1); }
        const text = argv.includes("--text-stdin")
          ? (await readStdin()).toString("utf8")
          : "";
        if (!text.trim()) { process.stderr.write("no message text\n"); process.exit(1); }
        const id = await waha.sendText(contactJid(chat), text);
        console.log(JSON.stringify({ ok: true, id }));
        return;
      }

      // ----------------------------------------------------------- read
      case "read": {
        // sendSeen reaches the PHONE, which is the whole point of routing
        // reads here; it opens no window and steals no focus, so unlike the
        // Mac's imsg-read there is nothing to hold it back.
        const chat = argOf(argv, "--chat");
        if (chat) { await waha.sendSeen(contactJid(chat)); console.log('{"ok":true}'); return; }
        if (argv.includes("--all")) {
          // Blip's OWN ledger decides which conversations this touches, not
          // WhatsApp's receipts. Most of the older ones carry no receipt at
          // all (ack null — unknown, which is not the same as unread), and
          // marking those would send read receipts to people whose messages
          // were never outstanding. "Mark all read" means the ones the badge
          // is counting, which is a handful rather than forty.
          const counts = loadState().unreadCounts || {};
          const outstanding = Object.entries(counts)
            .filter(([id, n]) => Number(n) > 0 && isWhatsAppChat(id) && !isSkippableChat(id))
            .map(([id]) => id)
            .slice(0, 40);
          let n = 0;
          for (const id of outstanding) {
            try { await waha.sendSeen(contactJid(id)); n++; } catch { /* one chat is not the batch */ }
          }
          console.log(JSON.stringify({ ok: true, marked: n }));
          return;
        }
        console.log('{"ok":true}');
        return;
      }

      // --------------------------------------------------------- status
      case "status": {
        console.log(JSON.stringify({ ok: true, status: await waha.status(), url: conf.url, send: conf.send }));
        return;
      }

      default:
        process.stderr.write(`wa: unknown command '${cmd}'\n`);
        process.exit(64);
    }
  } catch (e) {
    die(e, conf.url);
  }
}

if (import.meta.main) void main();
