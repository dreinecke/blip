import { describe, expect, test } from "bun:test";
import {
  Waha, attachmentsOf, bodyText, chatId, chatName, chatOf, contactJid, explain,
  fromStamp, handleFromJid, isSkippableChat, isWhatsAppChat, isWhatsAppGroup,
  loadConfig, onOff, parseConf, parseKeyFile, readFlag, recent, senderHandle,
  senderName, toChatInfo, toMessage, toStamp,
} from "./waha";
import type { WaChatSummary, WaMessage } from "./waha";

// A direct message of Dave's own, shaped as WAHA 2026.8.1/GOWS returns it.
const OUTBOUND: WaMessage = {
  id: "true_234483840237696@lid_3AF6279616443EED54A8",
  timestamp: 1789226152,
  from: "234483840237696@lid",
  fromMe: true,
  body: "😊",
  hasMedia: false,
  ack: 3,
  ackName: "READ",
  _data: { Info: { Chat: "234483840237696@lid", PushName: "Dave", IsFromMe: true } },
};

// An inbound photo in a group: `from` is the ROOM, the person is in _data.
const GROUP_PHOTO: WaMessage = {
  id: "false_27716059553-1461139805@g.us_ACF8_37838728990786@lid",
  timestamp: 1789214999,
  from: "27716059553-1461139805@g.us",
  participant: "37838728990786@lid",
  fromMe: false,
  body: null,
  hasMedia: true,
  ack: 3,
  ackName: "READ",
  _data: {
    Info: {
      Chat: "27716059553-1461139805@g.us", SenderAlt: "447879205953@s.whatsapp.net",
      PushName: "Frik Reinecke", IsGroup: true, Type: "media", MediaType: "image",
    },
    Message: { imageMessage: { mimetype: "image/jpeg", fileLength: 129108, caption: null } },
  },
};

const UNREAD: WaMessage = { ...GROUP_PHOTO, ack: 2, ackName: "DEVICE" };
const UNKNOWN_ACK: WaMessage = { ...GROUP_PHOTO, ack: null, ackName: "UNKNOWN" };

describe("config", () => {
  test("bridge.conf is parsed as data, comments and quotes stripped", () => {
    const conf = parseConf([
      "# a comment",
      "host=anotherdave@discovery",
      "remote_bin='$HOME/.blip/bin'   # trailing note",
      'waha_url="http://127.0.0.1:3010"',
      "malformed",
      "=nokey",
    ].join("\n"));
    expect(conf["host"]).toBe("anotherdave@discovery");
    expect(conf["remote_bin"]).toBe("$HOME/.blip/bin");
    expect(conf["waha_url"]).toBe("http://127.0.0.1:3010");
    expect(conf["malformed"]).toBeUndefined();
    expect(conf[""]).toBeUndefined();
  });

  test("the API key comes out of WAHA's own env file", () => {
    expect(parseKeyFile("WAHA_PRINT_QR=false\nWHATSAPP_API_KEY=abc123\n")).toBe("abc123");
    expect(parseKeyFile("nothing here")).toBe("");
  });

  test("on/off keys", () => {
    expect(onOff("on")).toBe(true);
    expect(onOff("YES")).toBe(true);
    expect(onOff("off")).toBe(false);
    expect(onOff(undefined)).toBe(false);
    expect(onOff("nonsense", true)).toBe(true);
  });

  test("sending is off unless bridge.conf asks for it by name", () => {
    const read = (p: string) => p.endsWith("bridge.conf")
      ? "waha_session=dave\nwaha_key=k\n" : "";
    expect(loadConfig(read).send).toBe(false);
    const on = (p: string) => p.endsWith("bridge.conf")
      ? "waha_session=dave\nwaha_key=k\nwaha_send=on\n" : "";
    expect(loadConfig(on).send).toBe(true);
  });

  test("a missing bridge.conf leaves working defaults", () => {
    const conf = loadConfig(() => { throw new Error("ENOENT"); });
    expect(conf.url).toBe("http://127.0.0.1:3010");
    expect(conf.key).toBe("");
    expect(conf.send).toBe(false);
  });

  test("a trailing slash on waha_url never doubles up", () => {
    const conf = loadConfig((p) => p.endsWith("bridge.conf") ? "waha_url=http://h:3010///" : "");
    expect(conf.url).toBe("http://h:3010");
  });
});

describe("ids", () => {
  test("a JID's suffix says what it is", () => {
    expect(isWhatsAppChat("27823734046@c.us")).toBe(true);
    expect(isWhatsAppChat("27716059553-1461139805@g.us")).toBe(true);
    expect(isWhatsAppChat("234483840237696@lid")).toBe(true);
    expect(isWhatsAppGroup("27716059553-1461139805@g.us")).toBe(true);
    expect(isWhatsAppGroup("27823734046@c.us")).toBe(false);
    expect(isSkippableChat("status@broadcast")).toBe(true);
  });

  test("no iMessage identity can be mistaken for a WhatsApp one", () => {
    for (const id of ["+353861234567", "dave@example.com", "chat123456", "a".repeat(32), ""]) {
      expect(isWhatsAppChat(id)).toBe(false);
    }
  });

  test("whatsmeow's @s.whatsapp.net and WAHA's @c.us are the same person", () => {
    expect(contactJid("447879205953@s.whatsapp.net")).toBe("447879205953@c.us");
    expect(contactJid("447879205953@c.us")).toBe("447879205953@c.us");
    expect(contactJid("234483840237696@lid")).toBe("234483840237696@lid");
  });

  test("a JID renders as a number only where a name is missing", () => {
    expect(handleFromJid("353861234567@c.us")).toBe("+353861234567");
    expect(handleFromJid("234483840237696@lid")).toBe("234483840237696@lid");
  });
});

describe("timestamps", () => {
  test("unix seconds become the sortable local stamp Blip compares", () => {
    const stamp = toStamp(1789226152);
    expect(stamp).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(fromStamp(stamp)).toBe(1789226152);
  });

  test("a missing timestamp is an empty stamp, never 1970", () => {
    expect(toStamp(0)).toBe("");
    expect(toStamp(NaN)).toBe("");
    expect(fromStamp("")).toBe(0);
    expect(fromStamp("not a date")).toBe(0);
  });

  test("stamps sort lexically in timestamp order", () => {
    const a = toStamp(1789226152);
    const b = toStamp(1789226153);
    expect(a < b).toBe(true);
  });
});

describe("message mapping", () => {
  test("a group message is attributed to the person, never to the room", () => {
    const m = toMessage(GROUP_PHOTO, "27716059553-1461139805@g.us", "Reinecke Kinders");
    expect(m.name).toBe("Frik Reinecke");
    expect(m.handle).toBe("447879205953@c.us");
    expect(m.chat).toBe("27716059553-1461139805@g.us");
  });

  test("the LID in `from` never reaches a field a person reads", () => {
    expect(senderHandle(GROUP_PHOTO)).toBe("447879205953@c.us");
    expect(senderName(GROUP_PHOTO)).toBe("Frik Reinecke");
  });

  test("a DM takes its name from the conversation, a group does not", () => {
    expect(senderName({ ...GROUP_PHOTO, _data: { Info: {} } }, "Scott Field", "27823734046@c.us"))
      .toBe("Scott Field");
    expect(senderName({ ...GROUP_PHOTO, _data: { Info: {} } }, "Reinecke Kinders", "27716059553-1461139805@g.us"))
      .toBe(null);
  });

  test("Dave's own message is addressed to the conversation, not to himself", () => {
    const m = toMessage(OUTBOUND, "27823734046@c.us", "Scott Field");
    expect(m.from_me).toBe(true);
    expect(m.handle).toBe("27823734046@c.us");
    expect(m.name).toBe(null);
  });

  test("the conversation list's id wins over _data.Info.Chat", () => {
    // Info.Chat is the @lid addressing form of the same conversation; taking
    // it would split one thread in two.
    expect(chatOf(OUTBOUND, "27823734046@c.us")).toBe("27823734046@c.us");
    expect(toMessage(OUTBOUND, "27823734046@c.us").chat).toBe("27823734046@c.us");
  });

  test("read state is only claimed where WhatsApp actually says", () => {
    expect(readFlag(GROUP_PHOTO)).toBe(true);      // ack 3 — read on some device
    expect(readFlag(UNREAD)).toBe(false);          // ack 2 — delivered, not read
    expect(readFlag(UNKNOWN_ACK)).toBeUndefined(); // no receipt: local marks decide
    expect(readFlag(OUTBOUND)).toBe(true);         // our own is never unread
  });

  test("an absent receipt leaves `read` off the record entirely", () => {
    expect("read" in toMessage(UNKNOWN_ACK, "x@g.us")).toBe(false);
    expect(toMessage(UNREAD, "x@g.us").read).toBe(false);
  });

  test("media is metadata only, and the caption is the text", () => {
    const att = attachmentsOf(GROUP_PHOTO)!;
    expect(att[0]!.mime).toBe("image/jpeg");
    expect(att[0]!.bytes).toBe(129108);
    expect(att[0]!.name).toBe("Photo");
    expect(attachmentsOf(OUTBOUND)).toBe(null);
    expect(bodyText(GROUP_PHOTO)).toBe("");
    const captioned = {
      ...GROUP_PHOTO,
      _data: { ...GROUP_PHOTO._data, Message: { imageMessage: { caption: "on the beach" } } },
    };
    expect(bodyText(captioned)).toBe("on the beach");
  });

  test('a literal "null" body is not a message that says null', () => {
    expect(bodyText({ ...OUTBOUND, body: "null" })).toBe("");
    expect(bodyText({ ...OUTBOUND, body: "hello" })).toBe("hello");
  });
});

describe("chat mapping", () => {
  const ROW: WaChatSummary = {
    id: "27823734046@c.us",
    name: "Scott Field",
    lastMessage: OUTBOUND,
    _chat: { id: "27823734046@c.us", name: "Scott Field", conversationTimestamp: 1789226152 },
  };

  test("a conversation becomes the ChatInfo the collector merges", () => {
    const info = toChatInfo(ROW)!;
    expect(info.id).toBe("27823734046@c.us");
    expect(info.name).toBe("Scott Field");
    expect(info.service).toBe("WhatsApp");
    expect(info.last_from_me).toBe(true);
    expect(info.pinned).toBe(false);
    expect(info.pin_order).toBe(null);
  });

  test("an unnamed conversation falls back to the number, not the JID", () => {
    const info = toChatInfo({ ...ROW, name: null, _chat: null })!;
    expect(info.name).toBe("+27823734046");
  });

  test("the story feed is not a conversation", () => {
    expect(toChatInfo({ ...ROW, id: "status@broadcast", _chat: null })).toBe(null);
    expect(toChatInfo({ ...ROW, id: "", _chat: null })).toBe(null);
  });

  test("id has shipped as a string and as an object; both are read", () => {
    expect(chatId({ id: "1@c.us" })).toBe("1@c.us");
    expect(chatId({ id: { user: "1", server: "c.us" } as any })).toBe("1@c.us");
    expect(chatId({ id: { _serialized: "1@c.us" } as any })).toBe("1@c.us");
    expect(chatId({ id: null as any, _chat: { id: "2@c.us" } })).toBe("2@c.us");
    expect(chatId({})).toBe("");
    expect(chatName({ name: "  " })).toBe(null);
  });

  test("a photo in the preview becomes a named attachment, so it reads as Photo", () => {
    const info = toChatInfo({ ...ROW, lastMessage: GROUP_PHOTO })!;
    expect(info.last_attachment).toEqual({ name: "Photo", mime: "image/jpeg" });
  });
});

// --------------------------------------------------------------- transport

/** A fetch stub: route → body. Records what was asked for. */
function stubFetch(routes: Record<string, unknown>, calls: string[] = []) {
  return async (url: string, init?: any) => {
    calls.push(`${init?.method || "GET"} ${url.replace(/^https?:\/\/[^/]+/, "")}`);
    const path = url.replace(/^https?:\/\/[^/]+/, "");
    const key = Object.keys(routes).find((r) => path.startsWith(r));
    if (key === undefined) {
      return { ok: false, status: 404, json: async () => ({ message: "not found" }) };
    }
    return { ok: true, status: 200, json: async () => routes[key] };
  };
}

const CONF = { url: "http://127.0.0.1:3010", session: "dave", key: "k", send: false };

describe("transport", () => {
  test("every call carries the API key, and never in the URL", async () => {
    const calls: string[] = [];
    const waha = new Waha(CONF, stubFetch({ "/api/sessions/dave": { status: "WORKING" } }, calls));
    expect(await waha.status()).toBe("WORKING");
    expect(calls[0]).toBe("GET /api/sessions/dave");
    expect(calls[0]).not.toContain("key");
  });

  test("a rejected key says which file to fix", async () => {
    const waha = new Waha(CONF, async () => ({
      ok: false, status: 401, json: async () => ({ message: "Unauthorized" }),
    }));
    try { await waha.status(); expect(true).toBe(false); }
    catch (e) { expect(explain(e)).toContain("waha_key_file"); }
  });

  test("a failure names the fix rather than the stack", () => {
    expect(explain(new Error("fetch failed"))).toContain("container is down");
    expect(explain(new Error("SCAN_QR_CODE"))).toContain("link it by QR");
  });

  test("marking read reaches WhatsApp's unscoped sendSeen", async () => {
    const calls: string[] = [];
    const waha = new Waha(CONF, stubFetch({ "/api/sendSeen": { ok: true } }, calls));
    await waha.sendSeen("1@c.us");
    // The session-scoped path does not exist on this API and 404s every time.
    expect(calls).toEqual(["POST /api/sendSeen"]);
  });

  test("a conversation's rows can be bounded by the read mark", async () => {
    const calls: string[] = [];
    const waha = new Waha(CONF, stubFetch({ "/api/dave/chats/": [] }, calls));
    await waha.messages("1@c.us", 50, { sinceStamp: toStamp(1789000000), inboundOnly: true });
    expect(calls[0]).toContain("filter.timestamp.gte=1789000000");
    expect(calls[0]).toContain("filter.fromMe=false");
    expect(calls[0]).toContain("downloadMedia=false");
  });

  test("group members come back as handles with the names WhatsApp has", async () => {
    const waha = new Waha(CONF, stubFetch({
      "/api/dave/groups/": [
        { JID: "1@lid", PhoneNumber: "447879205953@s.whatsapp.net", DisplayName: "Frik" },
        { JID: "2@lid", PhoneNumber: "", DisplayName: "" },
      ],
    }));
    expect(await waha.participants("g@g.us")).toEqual([
      { handle: "447879205953@c.us", name: "Frik" },
      { handle: "2@lid", name: "" },
    ]);
  });
});

describe("recent", () => {
  const rows: WaChatSummary[] = [
    { id: "a@c.us", name: "A", lastMessage: { ...OUTBOUND, timestamp: 1789226152 } },
    { id: "b@c.us", name: "B", lastMessage: { ...UNREAD, from: "b@c.us", participant: null, timestamp: 1789226100, _data: { Info: { SenderAlt: "b@s.whatsapp.net" } } } },
    { id: "status@broadcast", name: null, lastMessage: { ...OUTBOUND, timestamp: 1789226199 } },
  ];

  test("the story feed never enters the model", async () => {
    const waha = new Waha(CONF, stubFetch({ "/api/dave/chats/overview": rows, "/api/dave/chats/": [] }));
    const out = await recent(waha, 150, "");
    expect(out.map((m) => m.chat)).not.toContain("status@broadcast");
  });

  test("only a conversation that MOVED and is inbound costs a second call", async () => {
    const calls: string[] = [];
    const waha = new Waha(CONF, stubFetch(
      { "/api/dave/chats/overview": rows, "/api/dave/chats/": [] }, calls));
    // A mark newer than everything: nothing moved, so one call and no more.
    await recent(waha, 150, toStamp(1789300000));
    expect(calls.filter((c) => c.includes("/messages"))).toHaveLength(0);

    calls.length = 0;
    await recent(waha, 150, toStamp(1789000000));
    // "a" is Dave's own and is never chased; only the inbound "b" is.
    const chased = calls.filter((c) => c.includes("/messages"));
    expect(chased).toHaveLength(1);
    expect(chased[0]).toContain("b%40c.us");
  });

  test("rows come back oldest-first and de-duplicated", async () => {
    const dup = { ...UNREAD, from: "b@c.us", participant: null, timestamp: 1789226100, _data: { Info: { SenderAlt: "b@s.whatsapp.net" } } };
    const waha = new Waha(CONF, stubFetch({
      "/api/dave/chats/overview": rows,
      "/api/dave/chats/": [dup],
    }));
    const out = await recent(waha, 150, toStamp(1789000000));
    expect(out.filter((m) => m.id === dup.id)).toHaveLength(1);
    for (let i = 1; i < out.length; i++) expect(out[i - 1]!.ts <= out[i]!.ts).toBe(true);
  });

  test("one conversation failing does not lose the poll", async () => {
    const waha = new Waha(CONF, async (url: string) => {
      if (url.includes("/messages")) throw new Error("boom");
      if (url.includes("overview")) return { ok: true, status: 200, json: async () => rows };
      return { ok: false, status: 500, json: async () => ({}) };
    });
    const out = await recent(waha, 150, toStamp(1789000000));
    expect(out.length).toBeGreaterThan(0);
  });
});
