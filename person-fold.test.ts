import { describe, expect, test } from "bun:test";

import {
  effectiveAliasMap,
  parsePhone,
  personAliases,
  sameNumber,
  splitCallingCode,
  waDmPhone,
  type JoinChat,
} from "./person-fold.ts";
import type { RawContact } from "./contacts-dump.ts";

const IE = "353";

const card = (phones: string[], emails: string[] = []): RawContact => ({
  name: "Test Person",
  phones: phones.map((number) => ({ number })),
  emails: emails.map((address) => ({ address })),
});

const dm = (id: string, last = "2026-09-01 10:00:00", service = "iMessage"): JoinChat => ({ id, service, last });

describe("splitCallingCode", () => {
  test("E.164 splits on the real code, not a shorter prefix", () => {
    expect(splitCallingCode("353850000000")).toEqual({ cc: "353", nsn: "850000000" });
    expect(splitCallingCode("27830000000")).toEqual({ cc: "27", nsn: "830000000" });
    expect(splitCallingCode("15551234567")).toEqual({ cc: "1", nsn: "5551234567" });
    expect(splitCallingCode("447700900211")).toEqual({ cc: "44", nsn: "7700900211" });
  });
  test("no code fits; a leading 1 is NANP exactly as on the Mac", () => {
    expect(splitCallingCode("9999")).toBe(null);
    expect(splitCallingCode("")).toBe(null);
    expect(splitCallingCode("1234")).toEqual({ cc: "1", nsn: "234" }); // Python parity: 1 wins
  });
});

describe("sameNumber (imsg's SHORT_NSN_MATCH with guards)", () => {
  const h = (raw: string) => parsePhone(raw, IE)!;
  test("Irish card saved with a trunk zero joins its E.164 handle", () => {
    expect(sameNumber(h("+353850000000"), h("085 000 0000"))).toBe(true);
  });
  test("South African card with country code and trunk zero joins — the case plain last-10 fails", () => {
    expect(sameNumber(h("+27830000000"), h("+27 083 000 0000"))).toBe(true);
  });
  test("a bare SA national card takes the home region and does NOT join +27 — the faithful port", () => {
    expect(sameNumber(h("+27830000000"), h("083 000 0000"))).toBe(false);
  });
  test("different calling codes never match", () => {
    expect(sameNumber(h("+447700900211"), h("0850000000"))).toBe(false);
  });
  test("a North American card shorter than ten digits has no area code and matches nothing", () => {
    const us = (raw: string) => parsePhone(raw, "1")!;
    expect(sameNumber(us("+15551234567"), us("555 123 4567"))).toBe(true); // 10-digit card is fine
    expect(sameNumber(us("+15551234567"), us("5551234"))).toBe(false); // 7-digit NANP card refuses
  });
  test("shorter than a local number (7 digits) never matches", () => {
    expect(sameNumber(h("+353123456"), h("+35312345"))).toBe(false);
  });
});

describe("waDmPhone", () => {
  test("c.us jid to E.164, device suffix dropped", () => {
    expect(waDmPhone("353850000000@c.us")).toBe("+353850000000");
    expect(waDmPhone("353850000000:22@s.whatsapp.net")).toBe("+353850000000");
  });
  test("a LID has no number", () => {
    expect(waDmPhone("266597277122670@lid")).toBe("266597277122670@lid");
  });
});

describe("personAliases", () => {
  test("one person's email chat, phone chat, and WhatsApp DM fold into one row", () => {
    const contacts = [card(["085 000 0000"], ["ant.reinecke@example.com"])];
    const out = personAliases({
      chats: [dm("ant.reinecke@example.com"), dm("+353850000000"), dm("353850000000@c.us", "2026-07-29 10:02:00", "WhatsApp")],
      contacts,
      homeCc: IE,
      bridgeAliases: {},
      previous: {},
    });
    const canonicals = new Set(Object.values(out));
    expect(canonicals.size).toBe(1);
    expect(Object.keys(out).length).toBe(2); // canonical itself is not a key
  });

  test("canonical sticks across a newer message on the other channel", () => {
    const contacts = [card(["085 000 0000"], ["ant.reinecke@example.com"])];
    const chats = [dm("ant.reinecke@example.com", "2026-09-23 10:31:06"), dm("+353850000000", "2026-09-15 09:53:47")];
    const first = personAliases({ chats, contacts, homeCc: IE, bridgeAliases: {}, previous: {} });
    const canonical = Object.values(first)[0]!;
    // Now the phone chat is the newer one; the canonical must not flip.
    const flipped = personAliases({
      chats: [dm("ant.reinecke@example.com", "2026-09-01 10:00:00"), dm("+353850000000", "2026-09-25 09:00:00")],
      contacts,
      homeCc: IE,
      bridgeAliases: {},
      previous: first,
    });
    expect(Object.values(flipped)[0]).toBe(canonical);
  });

  test("stickiness falls back when the old canonical disappears", () => {
    const contacts = [card(["085 000 0000"], ["ant.reinecke@example.com"])];
    const first = personAliases({
      chats: [dm("ant.reinecke@example.com"), dm("+353850000000")],
      contacts, homeCc: IE, bridgeAliases: {}, previous: {},
    });
    const survivor = personAliases({
      chats: [dm("+353850000000", "2026-09-25 09:00:00")],
      contacts, homeCc: IE, bridgeAliases: {}, previous: first,
    });
    expect(Object.keys(survivor)).toHaveLength(0); // one chat left: nothing to fold
  });

  test("an ambiguous exact key refuses and never falls through to a near match", () => {
    // Two cards share the last-ten key "0850000000"; the national-form chat
    // would near-match card 0 if the refusal guard were missing.
    const contacts = [
      card(["085 000 0000"], ["x@y.ie"]),
      card(["+44 0850000000"]),
    ];
    const out = personAliases({
      chats: [dm("0850000000"), dm("x@y.ie", "2026-08-01 00:00:00")],
      contacts, homeCc: IE, bridgeAliases: {}, previous: {},
    });
    expect(Object.keys(out)).toHaveLength(0);
  });

  test("groups, LIDs, and excluded chats never join", () => {
    const contacts = [card(["085 000 0000"])];
    const out = personAliases({
      chats: [
        dm("chat123456789"),            // iMessage group shape
        dm("120363400348351015@g.us"),  // WhatsApp group
        dm("266597277122670@lid", "2026-09-01 10:00:00", "WhatsApp"),
        dm("+353850000000"),
      ],
      contacts, homeCc: IE, bridgeAliases: {}, previous: {},
      exclude: ["+353860000000"],
    });
    expect(Object.keys(out)).toHaveLength(0);
  });

  test("self-chats are excluded — the owner's card names their own handles", () => {
    const contacts = [card(["086 000 0000"], ["you@icloud.com"])];
    const out = personAliases({
      chats: [dm("+353860000000"), dm("you@icloud.com")],
      contacts, homeCc: IE, bridgeAliases: {}, previous: {},
      exclude: ["+353860000000", "you@icloud.com"],
    });
    expect(Object.keys(out)).toHaveLength(0);
  });

  test("a canonical is never chosen that another chat already folds into", () => {
    const contacts = [card(["085 000 0000"], ["ant.reinecke@example.com"])];
    // The bridge folds the email chat into the phone chat already.
    const bridge = { "ant.reinecke@example.com": "+353850000000" };
    const out = personAliases({
      chats: [dm("ant.reinecke@example.com"), dm("+353850000000"), dm("353850000000@c.us", "2026-07-29 10:02:00", "WhatsApp")],
      contacts, homeCc: IE, bridgeAliases: bridge, previous: {},
    });
    expect(out["353850000000@c.us"]).toBe("+353850000000");
    expect(out["ant.reinecke@example.com"]).toBe("+353850000000");
  });

  test("email matching is exact and case-insensitive", () => {
    const contacts = [card(["081 234 5678"], ["ant.reinecke@example.com"])];
    const out = personAliases({
      chats: [dm("ant.reinecke@example.com", "2026-09-01 10:00:00"), dm("+353812345678", "2026-09-02 10:00:00")],
      contacts, homeCc: IE, bridgeAliases: {}, previous: {},
    });
    expect(Object.values(out)[0]).toBe("+353812345678");
  });

  test("card-less number twins fold: an iMessage E.164 chat and its WhatsApp jid", () => {
    const out = personAliases({
      chats: [dm("+27830000000", "2026-09-20 08:00:00"), dm("27830000000@c.us", "2026-09-18 08:00:00", "WhatsApp")],
      contacts: [card(["087 111 2222"])], // nobody holds the SA number
      homeCc: IE, bridgeAliases: {}, previous: {},
    });
    expect(out["27830000000@c.us"]).toBe("+27830000000");
  });

  test("national-format chat ids join their E.164 twin through the card", () => {
    const contacts = [card(["085 000 0000"])];
    const out = personAliases({
      chats: [dm("0850000000"), dm("+353850000000", "2026-09-02 00:00:00")],
      contacts, homeCc: IE, bridgeAliases: {}, previous: {},
    });
    expect(Object.values(out)[0]).toBe("+353850000000");
  });
});

describe("effectiveAliasMap", () => {
  test("collapses the two-step chain a plain union would leave split", () => {
    const chatAliases = { "ant.reinecke@example.com": "+353850000000" };
    const persons = { "+353850000000": "353850000000@c.us" };
    const out = effectiveAliasMap(chatAliases, persons);
    expect(out["ant.reinecke@example.com"]).toBe("353850000000@c.us");
  });
  test("person entries override bridge entries on the same key", () => {
    const out = effectiveAliasMap(
      { "0850000000": "+353850000000" },
      { "0850000000": "ant.reinecke@example.com", "+353850000000": "ant.reinecke@example.com" },
    );
    expect(out["0850000000"]).toBe("ant.reinecke@example.com");
    expect(out["+353850000000"]).toBe("ant.reinecke@example.com");
  });
  test("empty person map leaves the bridge map untouched", () => {
    expect(effectiveAliasMap({ a: "b" }, {})).toEqual({ a: "b" });
  });
});
