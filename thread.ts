#!/usr/bin/env bun
/**
 * Blip thread loader — fetches one conversation and decorates it for the
 * bubble view.
 *
 * The decoration (day separators, sender grouping, which bubble shows a
 * timestamp) is pure and lives here rather than in QML so it can be tested.
 * QML just renders what it is handed.
 *
 *   bun thread.ts <chat-id> [limit]
 */

import { homedir } from "node:os";
import { spawnSync } from "node:child_process";
import {
  chatKey,
  dedupeSelfEcho,
  isGroupChat,
  loadState,
  type AttachmentMeta,
  type ImsgMessage,
  type LinkCard,
  type Tapback,
} from "./collector";
export { dedupeSelfEcho };

const HOME = process.env.HOME ?? homedir();

/** Only http(s) cards are shown; anything else is not clickable-safe. */
export function normalizeLink(l: ImsgMessage["link"]): LinkCard | null {
  if (!l || typeof l !== "object") return null;
  const url = String(l.url ?? "").trim();
  if (!/^https?:\/\//i.test(url)) return null;
  const image_id = String(l.image_id ?? "");
  return {
    url,
    title: String(l.title ?? "").trim(),
    summary: String(l.summary ?? "").trim(),
    image_id: /^[0-9]{1,18}$/.test(image_id) ? image_id : "",
  };
}

/** "omarchy.org" for a card's footer. */
export function linkHost(url: string): string {
  const m = /^https?:\/\/([^/?#]+)/i.exec(url);
  return (m ? m[1] : url).replace(/^www\./, "").toLowerCase();
}

/** Messages closer together than this belong to the same visual cluster. */
export const GROUP_GAP_MINUTES = 15;

export interface Bubble {
  ts: string;
  from_me: boolean;
  name: string;
  text: string;
  /** Non-empty on the first message of a new calendar day: "Today", "Aug 28". */
  day: string;
  /** First bubble of a run by one sender — gets the rounded outer corner. */
  groupStart: boolean;
  /** Last bubble of a run — carries the timestamp, like iMessage. */
  groupEnd: boolean;
  /** "9:41 PM", shown only on groupEnd. */
  time: string;
  /** "Read 4:42 PM" — only on the NEWEST read from-me bubble, like iMessage. */
  receipt: string;
  /** Reactions folded onto this bubble; [] when none. */
  tapbacks: Tapback[];
  /** Attachment chips ("📷 IMG_4502.png"); metadata only, files stay on the Mac. */
  attachments: AttachmentMeta[];
  /** Inline-reply context: the quoted snippet, "" when not a reply. */
  replyText: string;
  replyMine: boolean;
  edited: boolean;
  /** Rich-link preview card, null when the message has none. */
  link: LinkCard | null;
  /** An unsent message renders as a tombstone, not a bubble. */
  retracted: boolean;
  /** Screen/bubble effect short name ("confetti"), "" when none. */
  effect: string;
  audio: boolean;
  /** Escaped rich text with clickable anchors; "" when the text has no URL
   *  (QML keeps the cheap PlainText path then). */
  html: string;
  /** A message of yours that Messages could not deliver (chat.db error≠0) —
   *  rendered as a red "Not Delivered" tag. */
  failed: boolean;
}

export interface ThreadOutput {
  ok: boolean;
  online: boolean;
  error: string;
  bubbles: Bubble[];
}

// ---------------------------------------------------------------- formatting

/** "2026-08-30 21:08:22" → "9:08 PM". Avoids Date parsing and its TZ surprises. */
export function clockLabel(ts: string): string {
  const m = /^\d{4}-\d{2}-\d{2} (\d{2}):(\d{2})/.exec(ts);
  if (!m) return "";
  let h = Number(m[1]);
  const min = m[2];
  const suffix = h >= 12 ? "PM" : "AM";
  h = h % 12;
  if (h === 0) h = 12;
  return `${h}:${min} ${suffix}`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Today" / "Yesterday" / "Aug 28" / "Aug 28, 2025" for an older year. */
export function dayLabel(ts: string, today: string): string {
  const date = ts.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return "";
  if (date === today) return "Today";

  const d = new Date(`${date}T00:00:00`);
  const t = new Date(`${today}T00:00:00`);
  const diffDays = Math.round((t.getTime() - d.getTime()) / 86400000);
  if (diffDays === 1) return "Yesterday";

  const month = MONTHS[Number(date.slice(5, 7)) - 1] ?? "";
  const dayNum = Number(date.slice(8, 10));
  const year = date.slice(0, 4);
  return year === today.slice(0, 4) ? `${month} ${dayNum}` : `${month} ${dayNum}, ${year}`;
}

/** Minutes between two "YYYY-MM-DD HH:MM:SS" stamps. */
export function minutesBetween(a: string, b: string): number {
  const pa = Date.parse(a.replace(" ", "T"));
  const pb = Date.parse(b.replace(" ", "T"));
  if (Number.isNaN(pa) || Number.isNaN(pb)) return Number.POSITIVE_INFINITY;
  return Math.abs(pb - pa) / 60000;
}

// ---------------------------------------------------------------- decoration

/**
 * Turn a chronological message list into bubbles.
 *
 * A new group starts when the sender changes, the day changes, or more than
 * GROUP_GAP_MINUTES have passed. Only the last bubble of a group shows its
 * timestamp — that is what keeps a long back-and-forth readable instead of
 * stamping every single line.
 */
export function decorate(msgs: ImsgMessage[], today: string): Bubble[] {
  const out: Bubble[] = [];

  // iMessage shows "Read" under only the newest read message you sent.
  let receiptIdx = -1;
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i]!.from_me && msgs[i]!.read_at) { receiptIdx = i; break; }
  }

  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i]!;
    const prev = i > 0 ? msgs[i - 1]! : null;
    const next = i < msgs.length - 1 ? msgs[i + 1]! : null;

    const newDay = !prev || prev.ts.slice(0, 10) !== m.ts.slice(0, 10);
    // In a group, two members' messages must not merge into one run under
    // the first name — so a run breaks on sender (handle) change, not only
    // on the from_me flip.
    const sameSender = (a: ImsgMessage, b: ImsgMessage) =>
      a.from_me === b.from_me && (a.from_me || a.handle === b.handle);
    const groupStart =
      !prev ||
      newDay ||
      !sameSender(prev, m) ||
      minutesBetween(prev.ts, m.ts) > GROUP_GAP_MINUTES;
    const groupEnd =
      !next ||
      next.ts.slice(0, 10) !== m.ts.slice(0, 10) ||
      !sameSender(m, next) ||
      minutesBetween(m.ts, next.ts) > GROUP_GAP_MINUTES;

    out.push({
      ts: m.ts,
      from_me: m.from_me,
      name: m.name ?? m.handle ?? "",
      // U+FFFC is the object-replacement placeholder Messages leaves where an
      // attachment sat; the chip row carries that information instead.
      text: (m.text ?? "").replace(/￼/g, "").trim(),
      day: newDay ? dayLabel(m.ts, today) : "",
      groupStart,
      groupEnd,
      time: groupEnd ? clockLabel(m.ts) : "",
      receipt: i === receiptIdx ? receiptLabel(m.read_at!, today) : "",
      tapbacks: m.tapbacks ?? [],
      // Belt to imsg 1.5.1's suspenders: link-preview payloads are not files.
      attachments: (m.attachments ?? []).filter(
        (a) => !String(a.name || "").endsWith(".pluginPayloadAttachment"),
      ),
      replyText: m.reply_to?.text ?? "",
      replyMine: m.reply_to?.from_me ?? false,
      edited: m.edited === true,
      link: normalizeLink(m.link),
      retracted: m.retracted === true,
      effect: m.effect ?? "",
      audio: m.audio === true,
      html: linkify((m.text ?? "").replace(/￼/g, "").trim()),
      failed: m.from_me && typeof m.error === "number" && m.error !== 0,
    });
  }

  return out;
}

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
};

export function escapeHtml(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]!);
}

const URL_RE = /\bhttps?:\/\/[^\s<>"']+|\bwww\.[^\s<>"']+\.[^\s<>"']+/g;

/**
 * Message text → rich text with clickable anchors. The text is UNTRUSTED
 * (anyone can send "<img src=x>"), so non-URL segments are HTML-escaped and
 * URLs are matched on the RAW string, then escaped separately for href and
 * display — nothing a sender types is ever interpreted as markup.
 * Returns "" when the text holds no URL, so plain messages keep the cheap
 * PlainText render path.
 */
export function linkify(text: string): string {
  const t = String(text ?? "");
  URL_RE.lastIndex = 0;
  if (!URL_RE.test(t)) return "";
  URL_RE.lastIndex = 0;
  let out = "";
  let pos = 0;
  for (let m = URL_RE.exec(t); m !== null; m = URL_RE.exec(t)) {
    out += escapeHtml(t.slice(pos, m.index));
    // Trailing punctuation reads as prose, not URL: "see https://x.com."
    let url = m[0].replace(/[.,;:!?)\]]+$/, "");
    const href = url.startsWith("www.") ? "https://" + url : url;
    out += `<a href="${escapeHtml(href)}">${escapeHtml(url)}</a>`;
    pos = m.index + url.length;
  }
  out += escapeHtml(t.slice(pos));
  return out.replace(/\n/g, "<br>");
}

/** "Read 4:42 PM" today, "Read Yesterday 9:03 AM" otherwise. */
export function receiptLabel(readAt: string, today: string): string {
  const clock = clockLabel(readAt);
  if (!clock) return "Read";
  const day = dayLabel(readAt, today);
  return day === "Today" ? `Read ${clock}` : `Read ${day} ${clock}`;
}

/** Local calendar date — toISOString() is UTC and flips "Today" at 8pm EDT. */
export function localToday(now = new Date()): string {
  const y = now.getFullYear();
  const mo = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${mo}-${d}`;
}

/** How far back to scan `recent` for a group's messages. */
export const GROUP_SCAN_WINDOW = 1500;

/**
 * Normalise a fetched window into this thread's chronological messages.
 * `recent` is newest-first and mixed across chats; `thread` is already
 * oldest-first and single-chat. Both end up oldest-first, last `limit` only.
 */
export function selectThread(
  raw: ImsgMessage[],
  chat: string,
  group: boolean,
  limit: number,
  selfChats: string[] = [],
): ImsgMessage[] {
  // Exact-filter DMs too: `imsg thread` matches the handle by SUBSTRING, so
  // +15551234567 can pull rows from +995551234567 into the wrong conversation
  // (Codex finding #3).
  let msgs = raw.filter((m) => chatKey(m) === chat || (!group && m.handle === chat));
  msgs = [...msgs].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  msgs = dedupeSelfEcho(msgs, selfChats);
  return msgs.length > limit ? msgs.slice(msgs.length - limit) : msgs;
}

// ---------------------------------------------------------------- transport

export function loadThread(
  chat: string,
  limit: number,
  today: string,
  runner = spawnSync,
): ThreadOutput {
  // Groups load by EXACT chat id (imsg ≥1.8.0 `thread --chat`). The old
  // recent-window scan cost ~20× the rows and missed anything older than
  // the window — which made historical search hits open empty threads.
  const group = isGroupChat(chat);
  const args = group
    ? ["--json", "--rich", "thread", "--chat", chat, String(limit)]
    : ["--json", "--rich", "thread", chat, String(limit)];
  const res = runner(`${HOME}/bin/imsg`, args, {
    encoding: "utf8",
    timeout: 15000,
  });

  if (res.status === 69 || res.status === 255) {
    return { ok: false, online: false, error: "Mac unreachable", bubbles: [] };
  }
  if (res.status !== 0) {
    const err = (res.stderr || "").toString().trim().split("\n")[0] || `imsg exit ${res.status}`;
    return { ok: false, online: true, error: err, bubbles: [] };
  }
  try {
    const parsed = JSON.parse(res.stdout as string);
    if (!Array.isArray(parsed)) throw new Error("not an array");
    const msgs = selectThread(parsed as ImsgMessage[], chat, group, limit, loadState().selfChats);
    return { ok: true, online: true, error: "", bubbles: decorate(msgs, today) };
  } catch (e) {
    return { ok: false, online: true, error: `bad JSON from imsg: ${e}`, bubbles: [] };
  }
}

if (import.meta.main) {
  const chat = process.argv[2] ?? "";
  const limit = Number(process.argv[3] ?? 80) || 80;
  const today = localToday();
  try {
    console.log(JSON.stringify(loadThread(chat, limit, today)));
  } catch (e) {
    console.log(JSON.stringify({ ok: false, online: false, error: String(e), bubbles: [] }));
  }
}
