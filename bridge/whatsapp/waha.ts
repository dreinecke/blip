/**
 * WAHA → Blip. The WhatsApp half of the bridge, as pure functions plus one
 * fetch.
 *
 * Blip's Linux side speaks exactly one dialect: `~/bin/imsg <cmd> --json` in,
 * `ImsgMessage[]` / `ChatInfo[]` out. Rather than teach the collector a second
 * vocabulary, this module makes WhatsApp answer in that same dialect, and
 * `wa.ts` wraps it in the same argv. Everything above the bridge — threads,
 * the unread ledger, toasts, the renderer — then works unchanged.
 *
 * The source is a WAHA container on this machine (the WhatsApp HTTP API,
 * GOWS engine), reached over loopback with an X-Api-Key header. Nothing here
 * writes message content to disk.
 *
 * ⚠️ WAHA's own session must never be stopped or recreated to make something
 * here work: a restart comes back demanding a QR scan from the phone, and
 * repeated failed scans earn a block from WhatsApp. Everything this module
 * needs is a read or a send against the running container.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { messagePreview } from "../../collector";
import type { AttachmentMeta, ChatInfo, ImsgMessage } from "../../collector";
// The id predicates live with the routing, so there is one definition of what
// a WhatsApp conversation looks like rather than two that can drift apart.
import { isBroadcast as isSkippableChat, isWhatsAppChat, isWhatsAppGroup, WHATSAPP_SERVICE } from "../../source";

export { isSkippableChat, isWhatsAppChat, isWhatsAppGroup };

const HOME = process.env.HOME || homedir();

export const SERVICE = WHATSAPP_SERVICE;

// ------------------------------------------------------------------ config

export interface WahaConfig {
  url: string;
  session: string;
  key: string;
  send: boolean;
}

export const BRIDGE_CONF = `${HOME}/.config/blip/bridge.conf`;
export const DEFAULT_URL = "http://127.0.0.1:3010";
export const DEFAULT_SESSION = "default";
/** WAHA's own env file is the one true copy of the key; a mirror only rots. */
export const DEFAULT_KEY_FILE = `${HOME}/.config/waha/.env`;

/** bridge.conf is DATA, never sourced — same rule as blip-shim. */
export function parseConf(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const body = line.split("#")[0]!.trim();
    const eq = body.indexOf("=");
    if (eq <= 0) continue;
    const key = body.slice(0, eq).trim();
    let value = body.slice(eq + 1).trim();
    if (value.length > 1 && /^(".*"|'.*')$/s.test(value)) value = value.slice(1, -1);
    out[key] = value;
  }
  return out;
}

/** WHATSAPP_API_KEY out of a docker-compose env file. */
export function parseKeyFile(raw: string): string {
  return parseConf(raw)["WHATSAPP_API_KEY"] || "";
}

export function onOff(value: string | undefined, fallback = false): boolean {
  const v = String(value ?? "").trim().toLowerCase();
  if (["on", "yes", "true", "1"].includes(v)) return true;
  if (["off", "no", "false", "0"].includes(v)) return false;
  return fallback;
}

export function loadConfig(
  read: (path: string) => string = (p) => readFileSync(p, "utf8"),
): WahaConfig {
  let conf: Record<string, string> = {};
  try { conf = parseConf(read(BRIDGE_CONF)); } catch { /* no file, all defaults */ }

  let key = conf["waha_key"] || "";
  if (!key) {
    try { key = parseKeyFile(read(conf["waha_key_file"] || DEFAULT_KEY_FILE)); } catch { /* none */ }
  }
  return {
    url: (conf["waha_url"] || DEFAULT_URL).replace(/\/+$/, ""),
    session: conf["waha_session"] || DEFAULT_SESSION,
    key,
    // Sending rides WhatsApp's unofficial protocol, so it stays off until
    // it is asked for by name.
    send: onOff(conf["waha_send"], false),
  };
}

// ----------------------------------------------------------------- ids

/** `353861234567@c.us` → `+353861234567`; a LID has no number to show. */
export function handleFromJid(jid: string): string {
  const id = String(jid || "");
  const local = id.split("@")[0] || "";
  const user = local.split(":")[0] || "";
  if (/@(?:c\.us|s\.whatsapp\.net)$/i.test(id) && /^[0-9]{5,}$/.test(user)) return `+${user}`;
  return id;
}

// --------------------------------------------------------------- timestamps

const pad = (n: number) => String(n).padStart(2, "0");

/**
 * WAHA gives unix seconds; Blip sorts timestamps as STRINGS and compares them
 * against the Mac's local wall clock. So the two sources only interleave
 * correctly if both are rendered in this machine's local time, which is what
 * this does. When upstream moves the whole bridge to epoch/UTC, this follows.
 */
export function toStamp(seconds: number, now = new Date(seconds * 1000)): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "";
  const d = now;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} `
    + `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** The inverse, for handing a read mark back to WAHA as a filter. */
export function fromStamp(stamp: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(String(stamp || ""));
  if (!m) return 0;
  const [, y, mo, d, h, mi, s] = m;
  return Math.floor(new Date(+y!, +mo! - 1, +d!, +h!, +mi!, +s!).getTime() / 1000);
}

// ----------------------------------------------------------- message mapping

/** One WAHA message, as much of it as we read. */
export interface WaMessage {
  id?: string;
  timestamp?: number;
  from?: string;
  to?: string | null;
  participant?: string | null;
  fromMe?: boolean;
  body?: string | null;
  hasMedia?: boolean;
  ack?: number | null;
  ackName?: string | null;
  replyTo?: { body?: string | null; participant?: string | null; fromMe?: boolean } | null;
  _data?: {
    Info?: {
      Chat?: string; Sender?: string; SenderAlt?: string; PushName?: string;
      IsFromMe?: boolean; IsGroup?: boolean; Type?: string; MediaType?: string;
    };
    Message?: Record<string, any>;
  } | null;
}

/**
 * ⚠️ NEVER show a message's top-level `from`. On this engine it is a `@lid`
 * integer for almost every direct message and the GROUP's id inside a group,
 * so it names nobody. The person is `_data.Info.SenderAlt` (their number) with
 * `_data.Info.PushName` as the name they chose.
 *
 * A handle stays a JID rather than becoming `+353…`, because a handle is one
 * of the two things the source router reads (the other is the chat id) and
 * only the `@…` suffix distinguishes a WhatsApp person from an iMessage one.
 * The pretty number is a DISPLAY fallback, applied where a name is missing.
 */
/**
 * ⚠️ The canonical chat id is the one the conversation list uses — never
 * `_data.Info.Chat`. On this engine that field is the `@lid` addressing form
 * of the same conversation ("234483840237696@lid" where the list says
 * "27823734046@c.us"), and taking it would split one conversation into two
 * threads that never merge. Every caller knows which conversation it asked
 * for, so it passes that in.
 */
export function chatOf(m: WaMessage, chat = ""): string {
  return chat || String(m.participant ? m.from : (m.from || m._data?.Info?.Chat || ""));
}

export function senderHandle(m: WaMessage, chat = ""): string {
  const info = m._data?.Info;
  // On a message of Dave's own, chat.db records the RECIPIENT, and the thread
  // takes its handle from whichever row is newest — so a conversation whose
  // last word was his must not come back addressed to himself.
  if (m.fromMe) return contactJid(chatOf(m, chat));
  const alt = info?.SenderAlt || "";
  if (alt) return contactJid(alt);
  const p = m.participant || info?.Sender || m.from || "";
  return contactJid(p);
}

/** WAHA addresses people as `…@c.us`; whatsmeow reports them as
 *  `…@s.whatsapp.net`. Same person, and only the first form is accepted by
 *  the chat endpoints. */
export function contactJid(jid: string): string {
  const id = String(jid || "");
  const local = (id.split("@")[0] || "").split(":")[0] || "";
  if (/@s\.whatsapp\.net$/i.test(id) && local) return `${local}@c.us`;
  return id;
}

export function senderName(m: WaMessage, chatName?: string | null, chat = ""): string | null {
  if (m.fromMe) return null;
  const push = (m._data?.Info?.PushName || "").trim();
  if (push) return push;
  const name = String(chatName ?? "").trim();
  // In a DM the conversation's name IS the other person's name; in a group it
  // is the group's, which would label every bubble with the room.
  if (name && !isWhatsAppGroup(chatOf(m, chat))) return name;
  return null;
}

const MEDIA_MIME: Record<string, string> = {
  imageMessage: "image/jpeg",
  videoMessage: "video/mp4",
  audioMessage: "audio/ogg",
  stickerMessage: "image/webp",
  documentMessage: "application/octet-stream",
};

const MEDIA_NAME: Record<string, string> = {
  imageMessage: "Photo",
  videoMessage: "Video",
  audioMessage: "Audio message",
  stickerMessage: "Sticker",
  documentMessage: "Document",
};

/**
 * Metadata only — the bytes stay in WAHA until the panel asks for them, the
 * same contract `imsg attachment` has with chat.db.
 */
export function attachmentsOf(m: WaMessage): AttachmentMeta[] | null {
  if (!m.hasMedia) return null;
  const msg = m._data?.Message || {};
  const kind = Object.keys(MEDIA_MIME).find((k) => msg[k]) || "";
  const node = kind ? msg[kind] : null;
  const mime = String(node?.mimetype || MEDIA_MIME[kind] || "") || null;
  const bytes = Number(node?.fileLength);
  return [{
    id: m.id ? String(m.id) : undefined,
    name: String(node?.fileName || MEDIA_NAME[kind] || "Attachment"),
    mime,
    bytes: Number.isFinite(bytes) && bytes > 0 ? bytes : null,
  }];
}

/**
 * WhatsApp's read state, where it has one.
 *
 * `ack` is the receipt this device knows about: 3 means the message has been
 * read (on ANY of Dave's devices, so reading on the phone lands here), 2 means
 * delivered and not yet read. On this install it is null for most older
 * conversations — GOWS only tracks what it saw live — and an absent `read` is
 * exactly what Blip's model expects for a bridge that cannot say: the unread
 * rule falls back to the local marks alone for that chat.
 */
export function readFlag(m: WaMessage): boolean | undefined {
  if (m.fromMe) return true;
  if (m.ack === 3) return true;
  if (m.ack === 2 || m.ack === 1 || m.ack === 0) return false;
  return undefined;
}

/** A media message carries no body; let the preview name it from the mime. */
export function bodyText(m: WaMessage): string {
  const b = m.body;
  if (typeof b === "string" && b !== "null") return b;
  const msg = m._data?.Message || {};
  const kind = Object.keys(MEDIA_MIME).find((k) => msg[k]) || "";
  const caption = kind ? msg[kind]?.caption : null;
  return typeof caption === "string" ? caption : "";
}

export function toMessage(m: WaMessage, chat: string, chatName?: string | null): ImsgMessage {
  const read = readFlag(m);
  const reply = m.replyTo;
  const id = chatOf(m, chat);
  const out: ImsgMessage = {
    id: m.id ? String(m.id) : undefined,
    guid: m.id ? String(m.id) : undefined,
    ts: toStamp(Number(m.timestamp)),
    from_me: m.fromMe === true,
    handle: senderHandle(m, id),
    name: senderName(m, chatName, id),
    service: SERVICE,
    chat: id,
    text: bodyText(m),
    attachments: attachmentsOf(m),
  };
  if (read !== undefined) out.read = read;
  if (reply && (reply.body || reply.participant)) {
    out.reply_to = { text: String(reply.body || ""), from_me: reply.fromMe === true };
  }
  return out;
}

// -------------------------------------------------------------- chat mapping

export interface WaChatSummary {
  id?: unknown;
  name?: string | null;
  picture?: string | null;
  lastMessage?: WaMessage | null;
  _chat?: { id?: unknown; name?: string | null; conversationTimestamp?: number } | null;
}

/** WAHA has shipped `id` as both a string and an object; take either. */
export function chatId(row: WaChatSummary): string {
  const id: any = row.id ?? row._chat?.id;
  if (typeof id === "string") return id;
  if (id && typeof id === "object") {
    if (typeof id._serialized === "string") return id._serialized;
    const user = id.user ?? id.serial ?? "";
    const server = id.server ?? "";
    if (user && server) return `${user}@${server}`;
    if (typeof id.serial === "string") return id.serial;
  }
  return "";
}

export function chatName(row: WaChatSummary): string | null {
  const n = String(row.name ?? row._chat?.name ?? "").trim();
  return n || null;
}

export function toChatInfo(row: WaChatSummary): ChatInfo | null {
  const id = chatId(row);
  if (!id || isSkippableChat(id)) return null;
  const last = row.lastMessage || null;
  const att = last ? attachmentsOf(last) : null;
  return {
    id,
    aliases: [id],
    name: chatName(row) || (isWhatsAppGroup(id) ? null : handleFromJid(id)),
    service: SERVICE,
    last: last ? toStamp(Number(last.timestamp)) : "",
    // "Photo" rather than a blank row, through the same namer the Mac's
    // conversation list goes through.
    last_text: last
      ? messagePreview(bodyText(last), att && att[0] ? { name: att[0].name, mime: att[0].mime } : null)
      : "",
    last_from_me: last?.fromMe === true,
    last_handle: last ? senderHandle(last, id) : "",
    last_name: last ? senderName(last, chatName(row), id) : null,
    // WhatsApp pins exist but WAHA's CORE tier does not report them; Blip
    // never writes a pin, so an unpinned row is the honest answer.
    pinned: false,
    pin_order: null,
    last_attachment: att && att[0] ? { name: att[0].name, mime: att[0].mime || "" } : null,
    pin_name: null,
  };
}

// ------------------------------------------------------------------ transport

export type Fetcher = (url: string, init?: any) => Promise<any>;

export class WahaError extends Error {
  constructor(message: string, readonly status = 0) { super(message); }
}

/**
 * One sentence that says what to do, in the shape collector.explainBridgeError
 * already uses for the Mac. The panel shows this verbatim.
 */
export function explain(err: unknown, url = DEFAULT_URL): string {
  const e = err as any;
  const msg = String(e?.message || err || "");
  if (e instanceof WahaError && e.status === 401) {
    return "WhatsApp bridge rejected the API key — check waha_key_file in ~/.config/blip/bridge.conf";
  }
  // Reachability is tested FIRST: "fetch failed" carries the word FAILED, and
  // a container that is down would otherwise be reported as an unlinked phone.
  if (/ECONNREFUSED|fetch failed|Unable to connect|ENOTFOUND|ETIMEDOUT/i.test(msg)) {
    return `WhatsApp bridge is not answering at ${url} — the WAHA container is down`;
  }
  if (/\b(SCAN_QR_CODE|STARTING|STOPPED|FAILED)\b/.test(msg)) {
    return `WhatsApp session is not linked (${msg}) — link it by QR at ${url}`;
  }
  return `WhatsApp bridge: ${msg}`;
}

export class Waha {
  constructor(readonly conf: WahaConfig, private readonly fetcher: Fetcher = fetch as any) {}

  private async call(path: string, init?: any): Promise<any> {
    const res = await this.fetcher(`${this.conf.url}${path}`, {
      ...init,
      headers: { "X-Api-Key": this.conf.key, ...(init?.headers || {}) },
    });
    if (!res.ok) {
      let detail = "";
      try { detail = String((await res.json())?.message || ""); } catch { /* no body */ }
      throw new WahaError(detail || `HTTP ${res.status} on ${path}`, res.status);
    }
    return res.json();
  }

  private get s(): string { return encodeURIComponent(this.conf.session); }

  /** Status first: a session that is not WORKING explains every empty result. */
  async status(): Promise<string> {
    const body = await this.call(`/api/sessions/${this.s}`);
    return String(body?.status || "UNKNOWN");
  }

  async overview(limit: number): Promise<WaChatSummary[]> {
    const rows = await this.call(`/api/${this.s}/chats/overview?limit=${limit}&offset=0`);
    return Array.isArray(rows) ? rows : [];
  }

  async messages(chat: string, limit: number, opts: { sinceStamp?: string; inboundOnly?: boolean; media?: boolean } = {}): Promise<WaMessage[]> {
    const q = new URLSearchParams({
      limit: String(limit),
      downloadMedia: opts.media ? "true" : "false",
      sortBy: "timestamp",
      sortOrder: "desc",
    });
    const since = opts.sinceStamp ? fromStamp(opts.sinceStamp) : 0;
    if (since > 0) q.set("filter.timestamp.gte", String(since));
    if (opts.inboundOnly) q.set("filter.fromMe", "false");
    const rows = await this.call(`/api/${this.s}/chats/${encodeURIComponent(chat)}/messages?${q}`);
    return Array.isArray(rows) ? rows : [];
  }

  async participants(chat: string): Promise<{ handle: string; name: string }[]> {
    const rows = await this.call(`/api/${this.s}/groups/${encodeURIComponent(chat)}/participants`);
    if (!Array.isArray(rows)) return [];
    return rows.map((p: any) => ({
      // A handle stays a JID: the source router reads its suffix.
      handle: contactJid(String(p?.PhoneNumber || p?.LID || p?.JID || "")),
      name: String(p?.DisplayName || "").trim(),
    })).filter((p) => p.handle);
  }

  async groupName(chat: string): Promise<string> {
    const body = await this.call(`/api/${this.s}/groups/${encodeURIComponent(chat)}`);
    return String(body?.Name || body?.subject || "").trim();
  }

  async picture(chat: string): Promise<string> {
    const body = await this.call(`/api/${this.s}/chats/${encodeURIComponent(chat)}/picture`);
    return String(body?.url || body?.profilePictureURL || "");
  }

  /** Mark a conversation read — this is the one that reaches the phone. */
  async sendSeen(chat: string): Promise<void> {
    await this.call(`/api/sendSeen`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chatId: chat, session: this.conf.session }),
    });
  }

  async sendText(chat: string, text: string): Promise<string> {
    const body = await this.call(`/api/sendText`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chatId: chat, text, session: this.conf.session }),
    });
    return String(body?.id || body?._data?.Info?.ID || "");
  }
}

// ------------------------------------------------------------------ recent

/**
 * The newest messages across every conversation, which is what the collector's
 * poll window means — and the one place WAHA's shape and Blip's disagree.
 *
 * The overview gives exactly one message per conversation. That is enough for
 * the list and the previews, but Blip's badge is an exact ledger of unread
 * ROWS: a chat with five unread must yield five. So the overview decides WHICH
 * conversations moved, and only those are asked for their rows since the read
 * mark. On a quiet poll that is no extra calls at all.
 */
export async function recent(
  waha: Waha,
  limit: number,
  sinceStamp = "",
): Promise<ImsgMessage[]> {
  const rows = await waha.overview(Math.max(limit, 200));
  const out: ImsgMessage[] = [];
  const deepen: { chat: string; name: string | null }[] = [];

  for (const row of rows) {
    const id = chatId(row);
    if (!id || isSkippableChat(id) || !row.lastMessage) continue;
    const name = chatName(row);
    out.push(toMessage(row.lastMessage, id, name));
    const moved = !sinceStamp || toStamp(Number(row.lastMessage.timestamp)) > sinceStamp;
    if (moved && row.lastMessage.fromMe !== true) deepen.push({ chat: id, name });
  }

  for (const { chat, name } of deepen) {
    try {
      const more = await waha.messages(chat, Math.min(limit, 100), { sinceStamp, inboundOnly: true });
      for (const m of more) out.push(toMessage(m, chat, name));
    } catch { /* one chat failing must not lose the whole poll */ }
  }

  const seen = new Set<string>();
  return out
    .filter((m) => m.ts && (!m.id || (!seen.has(String(m.id)) && seen.add(String(m.id)) !== undefined)))
    .sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
}
