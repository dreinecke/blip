#!/usr/bin/env bun
/**
 * Blip contact search — powers the new-conversation composer.
 *
 *   bun contact-search.ts <query>   →  {ok, online, error, results}
 *
 * Backed by `contacts --json find` on the Mac (AddressBook). Every phone and
 * email of a matching contact becomes its own row, because each is its own
 * iMessage handle. A query that already LOOKS like a handle (phone/email)
 * gets a direct "message this" row first — you can text a number that is in
 * nobody's contacts.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";

const HOME = process.env.HOME ?? homedir();

export interface ContactHit {
  /** "Mom" / "Tim McClusky" / the raw handle for direct entry. */
  name: string;
  /** The sendable handle: +1404… or an email. */
  handle: string;
  /** "mobile" label, "email", or "direct entry". */
  kind: string;
}

/** "(404) 555-0123" → "+14045550123"; keeps +intl and emails untouched.
 *  Bare 10-digit numbers are assumed US (+1) — that matches how chat.db
 *  stores handles for a US user. Anything AMBIGUOUS returns "" and the row
 *  is dropped: a number with an extension ("… ext 4") or an odd digit count
 *  must never be silently rewritten into a DIFFERENT dialable number
 *  (Codex HIGH, 1.2.0 review). */
/** Country calling code for bare national numbers: `country_code=` in
 *  ~/.config/blip/bridge.conf (default 1 — NANP). Read once; tests pass it. */
export function defaultCountryCode(): string {
  try {
    const conf = readFileSync(join(process.env.XDG_CONFIG_HOME ?? join(HOME, ".config"), "blip", "bridge.conf"), "utf8");
    const m = /^\s*country_code\s*=\s*['"]?(\d{1,3})/m.exec(conf);
    if (m) return m[1];
  } catch { /* no conf: NANP */ }
  return "1";
}

export function normalizeHandle(s: string, cc: string = defaultCountryCode()): string {
  const t = String(s || "").trim();
  if (t.includes("@")) return t.toLowerCase();
  // Extensions can't be messaged; stripping them would change the number.
  if (/(ext|x)\.?\s*\d+\s*$/i.test(t)) return "";
  if (t.startsWith("+")) return "+" + t.slice(1).replace(/\D/g, "");
  const digits = t.replace(/\D/g, "");
  if (cc === "1") {
    if (digits.length === 10) return "+1" + digits;
    if (digits.length === 11 && digits.startsWith("1")) return "+" + digits;
    return "";
  }
  // Outside NANP: a national number with a leading trunk 0 dropped, or
  // already prefixed with the country code. Lengths vary; accept 6–12 digits.
  if (digits.startsWith(cc) && digits.length >= cc.length + 6) return "+" + digits;
  const national = digits.replace(/^0/, "");
  if (national.length >= 6 && national.length <= 12) return "+" + cc + national;
  return "";
}

/** Does the query itself already name a sendable handle? */
export function directHandle(q: string): string {
  const t = String(q || "").trim();
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t)) return t.toLowerCase();
  const digits = t.replace(/[()\s.-]/g, "");
  if (/^\+?[0-9]{7,15}$/.test(digits)) return normalizeHandle(digits);
  return "";
}

interface RawContact {
  name?: string;
  phones?: { number?: string; label?: string }[];
  emails?: { address?: string; label?: string }[] | string[];
}

export function shapeContacts(raw: RawContact[], query: string, limit = 30): ContactHit[] {
  const out: ContactHit[] = [];
  const seen = new Set<string>();
  const direct = directHandle(query);
  if (direct !== "") {
    out.push({ name: direct, handle: direct, kind: "direct entry" });
    seen.add(direct);
  }
  for (const c of raw) {
    const name = String(c.name || "").trim() || "(unnamed)";
    for (const p of c.phones ?? []) {
      const h = normalizeHandle(String(p.number || ""));
      if (h.length < 8 || seen.has(h)) continue;
      seen.add(h);
      // Apple stores labels as "_$!<Mobile>!$_" — unwrap them.
      const label = String(p.label || "").replace(/^_\$!<|>!\$_$/g, "").trim();
      out.push({ name, handle: h, kind: label.toLowerCase() || "phone" });
    }
    for (const e of c.emails ?? []) {
      const addr = typeof e === "string" ? e : String(e.address || "");
      const h = normalizeHandle(addr);
      if (!h.includes("@") || seen.has(h)) continue;
      seen.add(h);
      out.push({ name, handle: h, kind: "email" });
    }
    if (out.length >= limit) break;
  }
  return out.slice(0, limit);
}

export interface ContactSearchOutput {
  ok: boolean;
  online: boolean;
  error: string;
  results: ContactHit[];
}

export function searchContacts(query: string, runner = spawnSync): ContactSearchOutput {
  const fail = (error: string, online = true): ContactSearchOutput =>
    ({ ok: false, online, error, results: [] });
  const q = String(query || "").trim();
  if (q === "") return fail("empty query");

  const res = runner(`${HOME}/bin/contacts`, ["--json", "find", "--", q], {
    encoding: "utf8",
    timeout: 15000, maxBuffer: 64 * 1024 * 1024,
  });
  if (res.status === 69 || res.status === 255) return fail("Mac unreachable", false);
  if (res.status !== 0) {
    // No contact match is not an error when the query is itself a handle.
    const direct = directHandle(q);
    if (direct !== "") return { ok: true, online: true, error: "", results: shapeContacts([], q) };
    const err = (res.stderr || "").toString().trim().split("\n")[0] || `contacts exit ${res.status}`;
    return fail(err);
  }
  try {
    const parsed = JSON.parse(res.stdout as string);
    if (!Array.isArray(parsed)) throw new Error("not an array");
    return { ok: true, online: true, error: "", results: shapeContacts(parsed, q) };
  } catch (e) {
    return fail(`bad JSON from contacts: ${e}`);
  }
}

if (import.meta.main) {
  try {
    console.log(JSON.stringify(searchContacts(process.argv[2] ?? "")));
  } catch (e) {
    console.log(JSON.stringify({ ok: false, online: true, error: String(e), results: [] }));
  }
}
