import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addToMutelist, hide, isObjectShaped, removeFromMutelist, serializeMutelist, unhide,
  writeMutelist,
} from "./mute";
import { loadMutelist, matchesMute, dropMutedChats, mutedChats } from "./collector";
import type { ChatInfo, ImsgMessage } from "./collector";

const scratch = () => join(mkdtempSync(join(tmpdir(), "blip-mute-")), "mutelist.json");

const inbound = (chat: string, text = "hi"): ImsgMessage =>
  ({ ts: "2026-09-13 09:00:00", from_me: false, handle: chat, name: null, service: "WhatsApp", chat, text });

describe("adding a conversation to the list", () => {
  test("once, at the end, order untouched", () => {
    expect(addToMutelist(["a", "b"], "c")).toEqual(["a", "b", "c"]);
    // The file is hand-edited as often as it is written here, and a list that
    // reshuffles itself is one nobody trusts to edit.
    expect(addToMutelist(["b", "a"], "c")).toEqual(["b", "a", "c"]);
  });

  test("a conversation already hidden is not added twice", () => {
    const list = ["a", "b"];
    expect(addToMutelist(list, "a")).toBe(list);
    expect(addToMutelist(list, "  ")).toBe(list);
  });

  test("removing takes every copy out", () => {
    expect(removeFromMutelist(["a", "b", "a"], "a")).toEqual(["b"]);
    expect(removeFromMutelist(["a"], "z")).toEqual(["a"]);
  });
});

describe("what counts as a conversation id", () => {
  test("a WhatsApp room's hyphen is not a reason to refuse it", () => {
    const path = scratch();
    expect(hide("27716059553-1461139805@g.us", path).ok).toBe(true);
    expect(loadMutelist(path)).toEqual(["27716059553-1461139805@g.us"]);
  });

  test("every real id shape is accepted", () => {
    const path = scratch();
    for (const id of [
      "353861234567@c.us", "+353861234567", "dave@example.com",
      "chat123456", "0123456789abcdef0123456789abcdef", "99123",
    ]) expect(hide(id, path).ok).toBe(true);
    expect(loadMutelist(path)).toHaveLength(6);
  });

  test("a phrase is refused: it is message text, and this call site is argv", () => {
    const path = scratch();
    for (const bad of ["", "  ", "Reply STOP2END", "a b", "a\tb", "x".repeat(321)]) {
      expect(hide(bad, path).ok).toBe(false);
      expect(hide(bad, path).error).toBe("not a conversation id");
    }
    expect(loadMutelist(path)).toEqual([]);
  });
});

describe("writing the file", () => {
  test("a list stays a list, an object stays an object", () => {
    expect(serializeMutelist(["a"], false)).toBe('[\n  "a"\n]\n');
    expect(serializeMutelist(["a"], true)).toBe('{\n  "mute": [\n    "a"\n  ]\n}\n');
    expect(isObjectShaped('{"mute":[]}')).toBe(true);
    expect(isObjectShaped('["a"]')).toBe(false);
    expect(isObjectShaped("not json")).toBe(false);
  });

  test("an existing {mute:[…]} file keeps its shape when a row is hidden", () => {
    const path = scratch();
    writeFileSync(path, '{"mute":["already"]}');
    expect(hide("1@c.us", path).ok).toBe(true);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ mute: ["already", "1@c.us"] });
  });

  test("the file is written where it can be read back", () => {
    const path = scratch();
    expect(writeMutelist(["a", "b"], path)).toBe(true);
    expect(loadMutelist(path)).toEqual(["a", "b"]);
  });

  test("an unwritable path fails rather than throwing", () => {
    expect(writeMutelist(["a"], "/proc/nope/mutelist.json")).toBe(false);
    expect(hide("1@c.us", "/proc/nope/mutelist.json").ok).toBe(false);
  });

  test("unhide puts a conversation back", () => {
    const path = scratch();
    hide("1@c.us", path);
    hide("2@c.us", path);
    expect(unhide("1@c.us", path).ok).toBe(true);
    expect(loadMutelist(path)).toEqual(["2@c.us"]);
  });
});

describe("what hiding actually does", () => {
  test("the hidden conversation is cut before anything counts it", () => {
    const path = scratch();
    hide("27716059553-1461139805@g.us", path);
    const mute = loadMutelist(path);
    const msgs = [inbound("27716059553-1461139805@g.us"), inbound("1@c.us")];
    expect(matchesMute(msgs[0]!, mute)).toBe(true);
    expect(matchesMute(msgs[1]!, mute)).toBe(false);
    expect(mutedChats(msgs, mute)).toEqual(["27716059553-1461139805@g.us"]);
  });

  test("and cut from the conversation list too, so it cannot come back on a deep run", () => {
    const path = scratch();
    hide("1@c.us", path);
    const chats: ChatInfo[] = [
      { id: "1@c.us", aliases: ["1@c.us"], name: "Spam", service: "WhatsApp", last: "2026-09-13 09:00:00",
        last_text: "hi", last_from_me: false, last_handle: "1@c.us", last_name: null,
        pinned: false, pin_order: null, pin_name: null },
      { id: "2@c.us", aliases: ["2@c.us"], name: "Real", service: "WhatsApp", last: "2026-09-13 09:00:00",
        last_text: "hi", last_from_me: false, last_handle: "2@c.us", last_name: null,
        pinned: false, pin_order: null, pin_name: null },
    ];
    const mute = loadMutelist(path);
    expect(dropMutedChats(chats, mute, mutedChats([], mute))!.map((c) => c.id)).toEqual(["2@c.us"]);
  });
});
