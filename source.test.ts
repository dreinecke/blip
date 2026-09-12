import { describe, expect, test } from "bun:test";
import {
  alwaysPushesRead, bridgeArgv, isBroadcast, isWhatsAppChat, isWhatsAppGroup, sourceFor,
} from "./source-id";
import { bothChats, isGroupChat, normalizeSendService } from "./collector";
import { keepSilentSources, mergeSources } from "./source";
import type { ChatInfo, FetchResult, ImsgMessage } from "./collector";

const HOME = "/home/someone";
const WA = "/plugins/blip/bridge/whatsapp/wa.ts";

const msg = (chat: string, ts: string, service = "iMessage"): ImsgMessage =>
  ({ ts, from_me: false, handle: chat, name: null, service, chat, text: "hi" });

describe("which messenger a conversation belongs to", () => {
  test("a JID is WhatsApp, and nothing else is", () => {
    expect(sourceFor("353861234567@c.us")).toBe("whatsapp");
    expect(sourceFor("27716059553-1461139805@g.us")).toBe("whatsapp");
    expect(sourceFor("234483840237696@lid")).toBe("whatsapp");
    expect(sourceFor("+353861234567")).toBe("imessage");
    expect(sourceFor("dave@example.com")).toBe("imessage");
    expect(sourceFor("chat123456")).toBe("imessage");
    expect(sourceFor("0123456789abcdef0123456789abcdef")).toBe("imessage");
    expect(sourceFor("")).toBe("imessage");
  });

  test("an email address is never mistaken for a JID", () => {
    for (const id of ["a@b.us", "a@c.usx", "a@g.use", "c.us", "@c.us "]) {
      expect(isWhatsAppChat(id)).toBe(false);
    }
    expect(isWhatsAppChat("x@c.us")).toBe(true);
  });

  test("a WhatsApp room is a group, not an email-shaped DM", () => {
    // Upstream's rule reads anything with an "@" as a DM address, which would
    // have sent a group message to whoever spoke in it last.
    expect(isGroupChat("27716059553-1461139805@g.us")).toBe(true);
    expect(isGroupChat("353861234567@c.us")).toBe(false);
    expect(isWhatsAppGroup("x@g.us")).toBe(true);
    expect(isBroadcast("status@broadcast")).toBe(true);
  });

  test("iMessage's own group shapes are untouched", () => {
    expect(isGroupChat("0123456789abcdef0123456789abcdef")).toBe(true);
    expect(isGroupChat("chat123456")).toBe(true);
    expect(isGroupChat("+353861234567")).toBe(false);
    expect(isGroupChat("dave@example.com")).toBe(false);
  });
});

describe("which bridge is spawned", () => {
  test("iMessage keeps its three programs", () => {
    expect(bridgeArgv("+353861234567", "query", HOME, WA)).toEqual([`${HOME}/bin/imsg`]);
    expect(bridgeArgv("+353861234567", "send", HOME, WA)).toEqual([`${HOME}/bin/imsg-send`]);
    expect(bridgeArgv("+353861234567", "read", HOME, WA)).toEqual([`${HOME}/bin/imsg-read`]);
  });

  test("WhatsApp is one script with subcommands", () => {
    expect(bridgeArgv("1@c.us", "query", HOME, WA)).toEqual(["bun", WA]);
    expect(bridgeArgv("1@c.us", "send", HOME, WA)).toEqual(["bun", WA, "send"]);
    expect(bridgeArgv("1@g.us", "read", HOME, WA)).toEqual(["bun", WA, "read"]);
  });

  test("a read reaches the phone on every WhatsApp open, and only there", () => {
    expect(alwaysPushesRead("1@c.us")).toBe(true);
    expect(alwaysPushesRead("+353861234567")).toBe(false);
  });
});

describe("the send service", () => {
  test("WhatsApp is named rather than falling through to iMessage", () => {
    expect(normalizeSendService("WhatsApp")).toBe("WhatsApp");
    expect(normalizeSendService("whatsapp")).toBe("WhatsApp");
    expect(normalizeSendService("SMS")).toBe("SMS");
    expect(normalizeSendService("RCS")).toBe("RCS");
    expect(normalizeSendService("")).toBe("iMessage");
    expect(normalizeSendService("something new")).toBe("iMessage");
  });
});

describe("merging the two messengers", () => {
  const mac: FetchResult = {
    ok: true, online: true, error: "",
    msgs: [msg("+1", "2026-09-12 10:00:00"), msg("+2", "2026-09-12 12:00:00")],
    fetchedCount: 2,
  };

  test("rows interleave by timestamp, not by source", () => {
    const out = mergeSources(mac, [msg("1@c.us", "2026-09-12 11:00:00", "WhatsApp")]);
    expect(out.msgs.map((m) => m.ts)).toEqual([
      "2026-09-12 10:00:00", "2026-09-12 11:00:00", "2026-09-12 12:00:00",
    ]);
  });

  test("the catch-up loop still widens against the Mac's window alone", () => {
    const out = mergeSources(mac, [msg("1@c.us", "2026-09-12 11:00:00", "WhatsApp")]);
    expect(out.fetchedCount).toBe(2);
  });

  test("a WhatsApp bridge that said nothing leaves the rows alone, and says so", () => {
    expect(mergeSources(mac, null).msgs).toBe(mac.msgs);
    expect(mergeSources(mac, null).answered).toEqual({ imessage: true, whatsapp: false });
    expect(mergeSources(mac, []).msgs).toBe(mac.msgs);
    expect(mergeSources(mac, []).answered).toEqual({ imessage: true, whatsapp: true });
  });

  test("the Mac being unreachable no longer empties the panel, and still says why", () => {
    const down: FetchResult = {
      ok: false, online: false, error: "Mac unreachable", msgs: [], fetchedCount: 0,
    };
    const out = mergeSources(down, [msg("1@c.us", "2026-09-12 11:00:00", "WhatsApp")]);
    expect(out.ok).toBe(true);
    expect(out.online).toBe(true);
    expect(out.msgs).toHaveLength(1);
    // `ok` now means "something answered", so the reason is the only thing
    // left saying the Mac did not.
    expect(out.error).toBe("Mac unreachable");
  });
});

describe("a messenger that did not answer", () => {
  const previous = { "+353861234567": 3, "1@c.us": 2 };

  test("keeps the unread it had, while the one that answered is recomputed", () => {
    // The Mac is asleep: its counts must survive a window with no iMessage
    // rows in it, or a persisted zero loses them for good.
    expect(keepSilentSources({ "1@c.us": 5 }, previous, { imessage: false, whatsapp: true }))
      .toEqual({ "1@c.us": 5, "+353861234567": 3 });
    expect(keepSilentSources({ "+353861234567": 1 }, previous, { imessage: true, whatsapp: false }))
      .toEqual({ "+353861234567": 1, "1@c.us": 2 });
  });

  test("both answering means the fresh count stands, zeros included", () => {
    expect(keepSilentSources({}, previous, { imessage: true, whatsapp: true })).toEqual({});
    expect(keepSilentSources({}, previous, undefined)).toEqual({});
  });
});

describe("the merged conversation list", () => {
  const runner = (bins: Record<string, unknown[] | null>) =>
    ((cmd: string, args: readonly string[]) => {
      const key = cmd === "bun" ? "wa" : "imsg";
      const rows = bins[key];
      return rows === null
        ? { status: 1, stdout: "", stderr: "down" }
        : { status: 0, stdout: JSON.stringify(rows), stderr: "" };
    }) as any;

  const chat = (id: string, service: string): ChatInfo => ({
    id, aliases: [id], name: id, service, last: "2026-09-12 10:00:00",
    last_text: "hi", last_from_me: false, last_handle: id, last_name: null,
    pinned: false, pin_order: null, pin_name: null,
  });

  test("both lists arrive as one", () => {
    const out = bothChats(runner({
      imsg: [chat("+1", "iMessage")], wa: [chat("1@c.us", "WhatsApp")],
    }))!;
    expect(out.map((c) => c.id)).toEqual(["+1", "1@c.us"]);
  });

  test("one messenger down leaves the other's conversations where they were", () => {
    expect(bothChats(runner({ imsg: null, wa: [chat("1@c.us", "WhatsApp")] }))!.map((c) => c.id))
      .toEqual(["1@c.us"]);
    expect(bothChats(runner({ imsg: [chat("+1", "iMessage")], wa: null }))!.map((c) => c.id))
      .toEqual(["+1"]);
  });

  test("null only when NEITHER answered", () => {
    expect(bothChats(runner({ imsg: null, wa: null }))).toBe(null);
  });
});
