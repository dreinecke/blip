import { describe, expect, test } from "bun:test";

import { cacheFileName, fetchAttachment, lruEvictions, sanitizeName, wantsJpeg } from "./fetch";
import { extFor, pickImageType } from "./paste";
import { resolveTarget } from "./send-file";

describe("fetch cache", () => {
  test("HEIC wants a Mac-side JPEG conversion, others stream raw", () => {
    expect(wantsJpeg("image/heic")).toBe(true);
    expect(wantsJpeg("image/heif")).toBe(true);
    expect(wantsJpeg("image/png")).toBe(false);
    expect(wantsJpeg("application/pdf")).toBe(false);
  });

  test("cache names separate the jpeg transform from the original", () => {
    const orig = cacheFileName("42", "IMG_1.png", "image/png");
    const conv = cacheFileName("42", "IMG_1.heic", "image/heic");
    expect(orig).toBe("42-orig-IMG_1.png");
    expect(conv).toBe("42-jpg-IMG_1.heic.jpg");
    expect(orig).not.toBe(conv);
  });

  test("sanitizeName strips traversal and hidden-file tricks", () => {
    expect(sanitizeName("../../etc/passwd")).toBe("etc_passwd");
    expect(sanitizeName(".hidden")).toBe("hidden");
    expect(sanitizeName("")).toBe("file");
    expect(sanitizeName("ok name.png")).toBe("ok_name.png");
  });

  test("LRU evicts oldest first, never the just-written file", () => {
    const entries = [
      { name: "old", bytes: 60, mtimeMs: 1 },
      { name: "keepme", bytes: 60, mtimeMs: 2 },
      { name: "new", bytes: 60, mtimeMs: 3 },
    ];
    expect(lruEvictions(entries, 130, "keepme")).toEqual(["old"]);
    expect(lruEvictions(entries, 70, "keepme")).toEqual(["old", "new"]);
    expect(lruEvictions(entries, 500, "keepme")).toEqual([]);
  });

  test("rejects a non-decimal id before ever spawning", () => {
    let spawned = false;
    const runner = (() => { spawned = true; return { status: 0, stdout: Buffer.from("x") }; }) as never;
    const r = fetchAttachment("1 OR 1=1", "x", "image/png", runner);
    expect(r.ok).toBe(false);
    expect(spawned).toBe(false);
  });

  test("offline exit codes report online:false", () => {
    const runner = (() => ({ status: 69, stdout: Buffer.alloc(0), stderr: "" })) as never;
    const r = fetchAttachment("123456789012345", "x.png", "image/png", runner);
    expect(r.ok).toBe(false);
    expect(r.online).toBe(false);
  });
});

describe("send-file target resolution", () => {
  test("DM sends --to the chat handle", () => {
    expect(resolveTarget("+15551234567", {})).toEqual({ args: ["--to", "+15551234567"], error: "" });
  });

  test("group with a cached guid sends --chat-id", () => {
    const groups = { abcdef0123456789abcdef0123456789: { guid: "any;+;abcdef0123456789abcdef0123456789" } };
    expect(resolveTarget("abcdef0123456789abcdef0123456789", groups).args[0]).toBe("--chat-id");
  });

  test("group WITHOUT a guid is refused — never falls back to a handle", () => {
    const r = resolveTarget("abcdef0123456789abcdef0123456789", {});
    expect(r.args).toEqual([]);
    expect(r.error).toContain("refusing");
  });

  test("chat<digits> group shape is also refused without a guid", () => {
    expect(resolveTarget("chat16857519591879963", {}).error).toContain("refusing");
  });
});

describe("search shaping", () => {
  const { snippet, shapeResults } = require("./search") as typeof import("./search");

  test("short text passes through untrimmed", () => {
    expect(snippet("hello there", "hello")).toBe("hello there");
  });

  test("long text centers the snippet on the match", () => {
    const long = "x".repeat(200) + " birthday cake " + "y".repeat(200);
    const s = snippet(long, "birthday");
    expect(s).toContain("birthday");
    expect(s.length).toBeLessThanOrEqual(100);
    expect(s.startsWith("…")).toBe(true);
  });

  test("attachment-only rows (placeholder char) are dropped", () => {
    const rows = [
      { ts: "2026-08-31 10:00:00", from_me: false, handle: "+15551234567", name: "A",
        service: "iMessage", chat: "+15551234567", text: "￼" },
      { ts: "2026-08-31 10:01:00", from_me: true, handle: "+15551234567", name: "A",
        service: "iMessage", chat: "+15551234567", text: "real match" },
    ] as never[];
    const out = shapeResults(rows, "match", 10);
    expect(out.length).toBe(1);
    expect(out[0]!.text).toBe("real match");
    expect(out[0]!.from_me).toBe(true);
  });

  test("group hits are flagged and limit respected", () => {
    const rows = Array.from({ length: 5 }, (_, i) => ({
      ts: `2026-08-31 10:0${i}:00`, from_me: false, handle: "+15551234567", name: "G",
      service: "iMessage", chat: "abcdef0123456789abcdef0123456789", text: `hit ${i}`,
    })) as never[];
    const out = shapeResults(rows, "hit", 3);
    expect(out.length).toBe(3);
    expect(out[0]!.group).toBe(true);
  });
});

describe("contact search shaping", () => {
  const { directHandle, normalizeHandle, shapeContacts } =
    require("./contact-search") as typeof import("./contact-search");

  test("US numbers normalize to E.164 like chat.db handles", () => {
    expect(normalizeHandle("(555) 010-0098")).toBe("+15550100098");
    expect(normalizeHandle("865.803.2122")).toBe("+15550100098");
    expect(normalizeHandle("1 865 803 2122")).toBe("+15550100098");
    expect(normalizeHandle("+44 20 7946 0958")).toBe("+442079460958");
    expect(normalizeHandle("Mom@iCloud.COM")).toBe("mom@icloud.com");
  });

  test("ambiguous numbers are DROPPED, never rewritten (wrong-recipient guard)", () => {
    expect(normalizeHandle("404-555-0100 ext 4")).toBe("");
    expect(normalizeHandle("865 803 2122 x12")).toBe("");
    expect(normalizeHandle("555-0100")).toBe("");          // 7 digits: ambiguous
    expect(normalizeHandle("12345678901234567")).toBe(""); // absurd length
  });

  test("a query that IS a handle gets a direct-entry row first", () => {
    const out = shapeContacts([], "404-555-0100");
    expect(out[0]).toEqual({ name: "+14045550100", handle: "+14045550100", kind: "direct entry" });
    expect(directHandle("somebody@example.com")).toBe("somebody@example.com");
    expect(directHandle("mom")).toBe("");
  });

  test("each phone and email becomes its own row; Apple labels unwrap", () => {
    const out = shapeContacts(
      [{ name: "Mom", phones: [{ number: "(555) 010-0098", label: "_$!<Mobile>!$_" }],
         emails: ["mom@example.com"] }],
      "mom",
    );
    expect(out).toEqual([
      { name: "Mom", handle: "+15550100098", kind: "mobile" },
      { name: "Mom", handle: "mom@example.com", kind: "email" },
    ]);
  });

  test("duplicate handles across contacts collapse", () => {
    const out = shapeContacts(
      [{ name: "A", phones: [{ number: "4045550100", label: "" }] },
       { name: "B", phones: [{ number: "+14045550100", label: "" }] }],
      "x",
    );
    expect(out.length).toBe(1);
  });
});

describe("paste type picking", () => {
  test("png preferred over other image types", () => {
    expect(pickImageType(["text/plain", "image/jpeg", "image/png"])).toBe("image/png");
  });
  test("first image type when no png", () => {
    expect(pickImageType(["text/html", "image/webp"])).toBe("image/webp");
  });
  test("no image offered → empty (text path)", () => {
    expect(pickImageType(["text/plain", "text/html"])).toBe("");
  });
  test("extensions map sanely", () => {
    expect(extFor("image/png")).toBe("png");
    expect(extFor("image/tiff")).toBe("img");
  });
});
