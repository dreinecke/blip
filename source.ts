/**
 * Which bridge answers for a conversation, and how the two are collected
 * together.
 *
 * Blip reads one messenger through one pair of tools (`~/bin/imsg`,
 * `imsg-send`, `imsg-read`, all of them ssh to a Mac). This fork reads a
 * second — WhatsApp, through the WAHA container on this machine — and every
 * branch between the two lives here. Everywhere else a call site asks
 * `bridgeFor(chat, …)` and keeps its argv exactly as it was.
 *
 * Keeping the whole decision in one file is deliberate: upstream's files then
 * differ by one line each, so merging Fred's releases stays cheap.
 *
 * The id predicates themselves live in `source-id.ts`, which QML imports as
 * `SourceId.mjs` — so the renderer and the collector cannot drift apart about
 * what a WhatsApp conversation looks like.
 */

import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import type { ChatInfo, FetchResult, ImsgMessage } from "./collector";
import { bridgeArgv, sourceFor } from "./source-id";

export {
  alwaysPushesRead, bridgeArgv, isBroadcast, isWhatsAppChat, isWhatsAppGroup,
  sourceFor, WHATSAPP_SERVICE,
} from "./source-id";
export type { Tool } from "./source-id";

const HOME = process.env.HOME ?? homedir();

export type Source = "imessage" | "whatsapp";

/** Where `wa.ts` sits, relative to this file at the plugin root. */
export const WA_SCRIPT = `${import.meta.dir}/bridge/whatsapp/wa.ts`;

export interface Bridge {
  /** The program to spawn. */
  cmd: string;
  /** Argv that must precede the caller's own, so a call site keeps its args. */
  args: string[];
  source: Source;
}

export function bridgeFor(chat: string, tool: "query" | "send" | "read" = "query"): Bridge {
  const argv = bridgeArgv(chat, tool, HOME, WA_SCRIPT);
  return { cmd: argv[0]!, args: argv.slice(1), source: sourceFor(chat) };
}

// ---------------------------------------------------------------- collecting

/**
 * Ask the WhatsApp bridge for an array. `null` means it could not answer at
 * all — the caller then carries on with whatever the Mac returned, because one
 * messenger being unreachable must never empty the other.
 */
export function runWhatsApp<T>(args: string[], runner = spawnSync, timeout = 20000): T[] | null {
  const b = bridgeFor("@c.us", "query");
  const res = runner(b.cmd, [...b.args, ...args], {
    encoding: "utf8", timeout, maxBuffer: 64 * 1024 * 1024,
  });
  if (res.status !== 0) return null;
  try {
    const parsed = JSON.parse(String(res.stdout ?? ""));
    return Array.isArray(parsed) ? parsed as T[] : null;
  } catch { return null; }
}

/** The WhatsApp half of the poll window. */
export function whatsAppMessages(limit: number, runner = spawnSync): ImsgMessage[] | null {
  return runWhatsApp<ImsgMessage>(["--json", "recent", String(limit)], runner);
}

/** The WhatsApp half of the conversation list. */
export function whatsAppChats(runner = spawnSync): ChatInfo[] | null {
  return runWhatsApp<ChatInfo>(["--json", "chats", "300"], runner);
}

/** The WhatsApp half of the group metadata, in `imsg groups`' own shape. */
export function whatsAppGroups(runner = spawnSync): Record<string, unknown>[] | null {
  return runWhatsApp<Record<string, unknown>>(["--json", "groups"], runner, 30000);
}

/** Which messengers answered this poll. A source that did not must keep the
 *  unread ledger it had rather than have it recomputed away. */
export interface Answered { imessage: boolean; whatsapp: boolean }

/**
 * Carry forward the ledger entries belonging to a source that did not answer.
 *
 * Without this, a Mac asleep behind a working WhatsApp bridge recomputes the
 * unread counts from a window with no iMessage rows in it, which zeroes every
 * iMessage count — and once that is persisted the next window is too short to
 * find the older ones again, so the badge loses them for good rather than for
 * the outage. Upstream never had to think about this: a failed fetch returned
 * early and wrote nothing.
 */
export function keepSilentSources<T>(
  fresh: Record<string, T>,
  previous: Record<string, T>,
  answered: Answered | undefined,
): Record<string, T> {
  if (!answered || (answered.imessage && answered.whatsapp)) return fresh;
  const out = { ...fresh };
  for (const [chat, value] of Object.entries(previous)) {
    const src = sourceFor(chat);
    if (answered[src] === false) out[chat] = value;
  }
  return out;
}

/** The WhatsApp half of a search. The needle travels on stdin, never argv. */
export function whatsAppSearch(query: string, limit: number, runner = spawnSync): ImsgMessage[] | null {
  const b = bridgeFor("@c.us", "query");
  const res = runner(b.cmd, [...b.args, "--json", "search", "--stdin", String(limit * 2)], {
    encoding: "utf8", timeout: 30000, maxBuffer: 64 * 1024 * 1024, input: query,
  });
  if (res.status !== 0) return null;
  try {
    const parsed = JSON.parse(String(res.stdout ?? ""));
    return Array.isArray(parsed) ? parsed as ImsgMessage[] : null;
  } catch { return null; }
}

/**
 * Both messengers in one window.
 *
 * `online` is true while EITHER answers, so the Mac being asleep no longer
 * blanks the panel — the WhatsApp conversations stay, and the Mac's own
 * reason is still the error on screen. `fetchedCount` stays the Mac's alone:
 * it is what the catch-up loop widens against, and WhatsApp's rows are
 * already bounded by the read mark.
 */
export function mergeSources(mac: FetchResult, wa: ImsgMessage[] | null): FetchResult {
  const answered = { imessage: mac.ok, whatsapp: wa !== null };
  if (wa === null || wa.length === 0) return { ...mac, answered };
  return {
    ...mac,
    answered,
    ok: true,
    online: true,
    // `error` is deliberately kept: `ok` now means "something answered", so
    // the Mac's own reason is the only thing left saying it did not.
    msgs: [...mac.msgs, ...wa].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0)),
  };
}
