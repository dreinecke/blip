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
    expect(splitCallingCode("353877124958")).toEqual({ cc: "353", nsn: "877124958" });
    expect(splitCallingCode("27823815068")).toEqual({ cc: "27", nsn: "823815068" });
    expect(splitCallingCode("15551234567")).toEqual({ cc: "1", nsn: "5551234567" });
    expect(splitCallingCode("447497136325")).toEqual({ cc: "44", nsn: "7497136325" });
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
    expect(sameNumber(h("+353877124958"), h("087 712 4958"))).toBe(true);
  });
  test("South African card with country code and trunk zero joins — the case plain last-10 fails", () => {
    expect(sameNumber(h("+27823815068"), h("+27 082 381 5068"))).toBe(true);
  });
  test("a bare SA national card takes the home region and does NOT join +27 — the faithful port", () => {
    expect(sameNumber(h("+27823815068"), h("082 381 5068"))).toBe(false);
  });
  test("different calling codes never match", () => {
    expect(sameNumber(h("+447497136325"), h("0877124958"))).toBe(false);
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
    expect(waDmPhone("353877124958@c.us")).toBe("+353877124958");
    expect(waDmPhone("353877124958:22@s.whatsapp.net")).toBe("+353877124958");
  });
  test("a LID has no number", () => {
    expect(waDmPhone("266597277122670@lid")).toBe("266597277122670@lid");
  });
});

describe("personAliases", () => {
  test("one person's email chat, phone chat, and WhatsApp DM fold into one row", () => {
    const contacts = [card(["087 712 4958"], ["Ant.Reinecke@gmail.com"])];
    const out = personAliases({
      chats: [dm("ant.reinecke@gmail.com"), dm("+353877124958"), dm("353877124958@c.us", "2026-07-29 10:02:00", "WhatsApp")],
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
    const contacts = [card(["087 712 4958"], ["ant.reinecke@gmail.com"])];
    const chats = [dm("ant.reinecke@gmail.com", "2026-09-23 10:31:06"), dm("+353877124958", "2026-09-15 09:53:47")];
    const first = personAliases({ chats, contacts, homeCc: IE, bridgeAliases: {}, previous: {} });
    const canonical = Object.values(first)[0]!;
    // Now the phone chat is the newer one; the canonical must not flip.
    const flipped = personAliases({
      chats: [dm("ant.reinecke@gmail.com", "2026-09-01 10:00:00"), dm("+353877124958", "2026-09-25 09:00:00")],
      contacts,
      homeCc: IE,
      bridgeAliases: {},
      previous: first,
    });
    expect(Object.values(flipped)[0]).toBe(canonical);
  });

  test("stickiness falls back when the old canonical disappears", () => {
    const contacts = [card(["087 712 4958"], ["ant.reinecke@gmail.com"])];
    const first = personAliases({
      chats: [dm("ant.reinecke@gmail.com"), dm("+353877124958")],
      contacts, homeCc: IE, bridgeAliases: {}, previous: {},
    });
    const survivor = personAliases({
      chats: [dm("+353877124958", "2026-09-25 09:00:00")],
      contacts, homeCc: IE, bridgeAliases: {}, previous: first,
    });
    expect(Object.keys(survivor)).toHaveLength(0); // one chat left: nothing to fold
  });

  test("an ambiguous exact key refuses and never falls through to a near match", () => {
    // Two cards share the last-ten key "0877124958"; the national-form chat
    // would near-match card 0 if the refusal guard were missing.
    const contacts = [
      card(["087 712 4958"], ["x@y.ie"]),
      card(["+44 0877124958"]),
    ];
    const out = personAliases({
      chats: [dm("0877124958"), dm("x@y.ie", "2026-08-01 00:00:00")],
      contacts, homeCc: IE, bridgeAliases: {}, previous: {},
    });
    expect(Object.keys(out)).toHaveLength(0);
  });

  test("groups, LIDs, and excluded chats never join", () => {
    const contacts = [card(["087 712 4958"])];
    const out = personAliases({
      chats: [
        dm("chat123456789"),            // iMessage group shape
        dm("120363400348351015@g.us"),  // WhatsApp group
        dm("266597277122670@lid", "2026-09-01 10:00:00", "WhatsApp"),
        dm("+353877124958"),
      ],
      contacts, homeCc: IE, bridgeAliases: {}, previous: {},
      exclude: ["+353879112913"],
    });
    expect(Object.keys(out)).toHaveLength(0);
  });

  test("self-chats are excluded — the owner's card names their own handles", () => {
    const contacts = [card(["087 911 2913"], ["dave@icloud.com"])];
    const out = personAliases({
      chats: [dm("+353879112913"), dm("dave@icloud.com")],
      contacts, homeCc: IE, bridgeAliases: {}, previous: {},
      exclude: ["+353879112913", "dave@icloud.com"],
    });
    expect(Object.keys(out)).toHaveLength(0);
  });

  test("a canonical is never chosen that another chat already folds into", () => {
    const contacts = [card(["087 712 4958"], ["ant.reinecke@gmail.com"])];
    // The bridge folds the email chat into the phone chat already.
    const bridge = { "ant.reinecke@gmail.com": "+353877124958" };
    const out = personAliases({
      chats: [dm("ant.reinecke@gmail.com"), dm("+353877124958"), dm("353877124958@c.us", "2026-07-29 10:02:00", "WhatsApp")],
      contacts, homeCc: IE, bridgeAliases: bridge, previous: {},
    });
    expect(out["353877124958@c.us"]).toBe("+353877124958");
    expect(out["ant.reinecke@gmail.com"]).toBe("+353877124958");
  });

  test("email matching is exact and case-insensitive", () => {
    const contacts = [card(["081 234 5678"], ["Ant.Reinecke@GMAIL.com"])];
    const out = personAliases({
      chats: [dm("ant.reinecke@gmail.com", "2026-09-01 10:00:00"), dm("+353812345678", "2026-09-02 10:00:00")],
      contacts, homeCc: IE, bridgeAliases: {}, previous: {},
    });
    expect(Object.values(out)[0]).toBe("+353812345678");
  });

  test("card-less number twins fold: an iMessage E.164 chat and its WhatsApp jid", () => {
    const out = personAliases({
      chats: [dm("+27823815068", "2026-09-20 08:00:00"), dm("27823815068@c.us", "2026-09-18 08:00:00", "WhatsApp")],
      contacts: [card(["087 111 2222"])], // nobody holds the SA number
      homeCc: IE, bridgeAliases: {}, previous: {},
    });
    expect(out["27823815068@c.us"]).toBe("+27823815068");
  });

  test("national-format chat ids join their E.164 twin through the card", () => {
    const contacts = [card(["087 712 4958"])];
    const out = personAliases({
      chats: [dm("0877124958"), dm("+353877124958", "2026-09-02 00:00:00")],
      contacts, homeCc: IE, bridgeAliases: {}, previous: {},
    });
    expect(Object.values(out)[0]).toBe("+353877124958");
  });
});

describe("effectiveAliasMap", () => {
  test("collapses the two-step chain a plain union would leave split", () => {
    const chatAliases = { "ant.reinecke@gmail.com": "+353877124958" };
    const persons = { "+353877124958": "353877124958@c.us" };
    const out = effectiveAliasMap(chatAliases, persons);
    expect(out["ant.reinecke@gmail.com"]).toBe("353877124958@c.us");
  });
  test("person entries override bridge entries on the same key", () => {
    const out = effectiveAliasMap(
      { "0877124958": "+353877124958" },
      { "0877124958": "ant.reinecke@gmail.com", "+353877124958": "ant.reinecke@gmail.com" },
    );
    expect(out["0877124958"]).toBe("ant.reinecke@gmail.com");
    expect(out["+353877124958"]).toBe("ant.reinecke@gmail.com");
  });
  test("empty person map leaves the bridge map untouched", () => {
    expect(effectiveAliasMap({ a: "b" }, {})).toEqual({ a: "b" });
  });
});
