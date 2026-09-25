#!/usr/bin/env bun
/**
 * The person fold — one sidebar row per human, not per chat id.
 *
 * A person reaches Blip as up to three conversations that nothing on the Mac
 * joins: an email-keyed iMessage chat, a phone-keyed chat (different
 * chat.db group_id, so the bridge's cluster fold never sees them as one),
 * and a WhatsApp DM (not in chat.db at all). This module joins DM chats to
 * the Mac's merged contact records and emits the same `alias → canonical`
 * shape the bridge cluster map already produces, so every existing fold
 * (ledger, thread list, reads) runs over it unchanged.
 *
 * Phone matching is a port of imsg's rules — `calling_codes.py`'s
 * `split_calling_code`, `_parse_phone`, `_same_number` (libphonenumber's
 * SHORT_NSN_MATCH with Blip's two guards), and the three-step resolution
 * order from `name_for`: a unique exact last-ten key decides when it hits,
 * an AMBIGUOUS exact key refuses and never falls through to a near match
 * (Astra C#2), and only then does a unique region-aware near match win.
 * The Mac stays the source of truth for names and photos; this is the same
 * comparison, run where it can be unit-tested.
 *
 * Pure: contacts, chats, region, and the previous map all arrive as values,
 * and only chat ids ever leave. One deliberate refusal: a handle sitting on
 * two different merged records folds nothing — the Mac's own conflict rule.
 */

import { isGroupChat, isWhatsAppChat, sourceFor } from "./source-id.ts";
import type { RawContact } from "./contacts-dump.ts";

/** Distinct calling codes from bridge/mac/calling_codes.py (which says to
 *  regenerate "about once a decade"). 1–3 digit prefixes, longest-first at
 *  equal match — ported exactly: split_calling_code tries 1, then 2, then 3. */
const CALLING_CODES: ReadonlySet<string> = new Set((
  "1,7,20,27,30,31,32,33,34,36,39,40,41,43,44,45,46,47,48,49,51,52,53,54,55,56,57,58,60,61,62,63,64,65,66,81,82,84,86,90,91,92,93,94,95,98,211,212,213,216,218,220,221,222,223,224,225,226,227,228,229,230,231,232,233,234,235,236,237,238,239,240,241,242,243,244,245,246,247,248,249,250,251,252,253,254,255,256,257,258,260,261,262,263,264,265,266,267,268,269,290,291,297,298,299,350,351,352,353,354,355,356,357,358,359,370,371,372,373,374,375,376,377,378,380,381,382,383,385,386,387,389,420,421,423,500,501,502,503,504,505,506,507,508,509,590,591,592,593,594,595,596,597,598,599,670,672,673,674,675,676,677,678,679,680,681,682,683,685,686,687,688,689,690,691,692,800,808,850,852,853,855,856,870,878,880,881,882,883,886,888,960,961,962,963,964,965,966,967,968,970,971,972,973,974,975,976,977,979,992,993,994,995,996,998"
).split(","));

export interface Phone {
  cc: string;
  nsn: string;
}

/** "353877124958" → {353, 877124958}; null when no calling code fits. */
export function splitCallingCode(digits: string): Phone | null {
  for (const n of [1, 2, 3]) {
    const head = digits.slice(0, n);
    if (head && CALLING_CODES.has(head)) return { cc: head, nsn: digits.slice(n) };
  }
  return null;
}

function digitsOf(s: string): string {
  return (s || "").replace(/\D/g, "");
}

/** contacts' normalize_phone: digits-only suffix (last 10), the exact key. */
export function last10Key(raw: string): string {
  const digits = digitsOf(raw);
  return digits.length >= 10 ? digits.slice(-10) : digits;
}

/** imsg's _parse_phone: "+47…" and "0047…" split on the calling code; a bare
 *  national number takes the configured home region (the Mac's AppleLocale
 *  equivalent is bridge.conf's country_code=). */
export function parsePhone(raw: string, homeCc: string): Phone | null {
  const s = String(raw || "").trim();
  const digits = digitsOf(s);
  if (s.startsWith("+")) return splitCallingCode(digits);
  if (s.startsWith("00")) return splitCallingCode(digits.slice(2));
  return homeCc && digits ? { cc: homeCc, nsn: digits } : null;
}

const LOCAL_NUMBER_DIGITS = 7; // libphonenumber's "a local number" floor

/** imsg's _same_number: equal calling codes, one national number ends with
 *  the other (SHORT_NSN_MATCH), with Blip's guards — a North American card
 *  shorter than ten digits has no area code and matches nothing, and a saved
 *  trunk zero ("087…") is not in the handle. */
export function sameNumber(handle: Phone, card: Phone): boolean {
  if (card.cc !== handle.cc) return false;
  if (card.cc === "1" && card.nsn.length < 10) return false;
  const nsns = new Set([card.nsn, card.nsn.replace(/^0/, "")]);
  for (const nsn of nsns) {
    if (
      Math.min(nsn.length, handle.nsn.length) >= LOCAL_NUMBER_DIGITS &&
      (handle.nsn.endsWith(nsn) || nsn.endsWith(handle.nsn))
    ) return true;
  }
  return false;
}

/** A WhatsApp DM's number: "353877124958@c.us" → "+353877124958". A LID has
 *  no number to show and returns the jid unchanged (caller drops it). Same
 *  rule as waha.ts handleFromJid, kept local so this module stays pure. */
export function waDmPhone(jid: string): string {
  const id = String(jid || "");
  const user = (id.split("@")[0] || "").split(":")[0] || "";
  if (/@(?:c\.us|s\.whatsapp\.net)$/i.test(id) && /^[0-9]{5,}$/.test(user)) return `+${user}`;
  return id;
}

/** Card-less identity: two chats carrying the same number (an iMessage
 *  E.164 id and a WhatsApp jid) are the same person even when no Contacts
 *  card holds the number. Calling code + trunk-zero-stripped national — a
 *  full-equality key, never a suffix match (near matching is what records
 *  are for). Null for anything that is not a phone. */
function phoneIdentity(handle: string, homeCc: string): string | null {
  const parsed = parsePhone(handle, homeCc);
  if (!parsed || !/^[0-9]{5,}$/.test(parsed.nsn)) return null;
  return `${parsed.cc}:${parsed.nsn.replace(/^0/, "")}`;
}

export interface JoinChat {
  id: string;
  service: string;
  /** ChatInfo.last — the conversation's newest message ts, for canonical choice. */
  last: string;
}

export interface PersonFoldInput {
  chats: JoinChat[];
  contacts: RawContact[];
  /** Home calling code for bare national numbers (bridge.conf country_code). */
  homeCc: string;
  /** The bridge cluster map (alias id → bridge canonical), so a canonical is
   *  never chosen that some other chat already folds into. */
  bridgeAliases: Record<string, string>;
  /** The previous person map, for canonical stickiness. */
  previous: Record<string, string>;
  /** Chat ids never to fold (the self-chats — the owner's card names them all). */
  exclude?: string[];
}

const MAX_ENTRIES = 512;
const MAX_GROUP_MEMBERS = 8;

interface RecordIndex {
  exact: Map<string, Set<number>>;
  emails: Map<string, Set<number>>;
  near: { idx: number; phone: Phone }[];
}

function buildIndex(contacts: RawContact[], homeCc: string): RecordIndex {
  const idx: RecordIndex = { exact: new Map(), emails: new Map(), near: [] };
  const put = (m: Map<string, Set<number>>, k: string, v: number) => {
    const s = m.get(k) ?? new Set<number>();
    s.add(v);
    m.set(k, s);
  };
  contacts.forEach((c, i) => {
    for (const p of c.phones ?? []) {
      const raw = String(p?.number || "");
      if (!raw) continue;
      put(idx.exact, last10Key(raw), i);
      const parsed = parsePhone(raw, homeCc);
      if (parsed) idx.near.push({ idx: i, phone: parsed });
    }
    for (const e of c.emails ?? []) {
      const addr = (typeof e === "string" ? e : String(e?.address || "")).trim().toLowerCase();
      if (addr.includes("@")) put(idx.emails, addr, i);
    }
  });
  return idx;
}

/** The Mac's three-step rule, over record indexes instead of name votes. */
function resolveRecord(handle: string, idx: RecordIndex, homeCc: string): number | null {
  if (handle.includes("@")) {
    const hit = idx.emails.get(handle.trim().toLowerCase());
    if (!hit) return null;
    return hit.size === 1 ? [...hit][0]! : null; // ambiguous exact: the answer is "nobody"
  }
  const key = last10Key(handle);
  const exact = idx.exact.get(key);
  if (exact && exact.size > 0) {
    return exact.size === 1 ? [...exact][0]! : null; // never let a near match over it (Astra C#2)
  }
  const parsed = parsePhone(handle, homeCc);
  if (!parsed) return null;
  const near = new Set<number>();
  for (const c of idx.near) if (sameNumber(parsed, c.phone)) near.add(c.idx);
  return near.size === 1 ? [...near][0]! : null;
}

/**
 * member chat id → person canonical chat id. Only ids, never content.
 *
 * Canonical choice is STICKY: the QML side identifies a thread by its chat
 * id, so the row must not change hands every time the newest message lands
 * on another member's channel. When the previous map's canonical for a group
 * is still in it, it stays; a brand-new group picks the newest-activity
 * member that no other chat folds into (a bridge canonical).
 */
export function personAliases(input: PersonFoldInput): Record<string, string> {
  const excluded = new Set(input.exclude ?? []);
  const idx = buildIndex(input.contacts, input.homeCc);

  // person key → the DM chats that resolved to it: a contact record when one
  // claimed the handle, else the card-less number identity.
  const byPerson = new Map<string, JoinChat[]>();
  for (const chat of input.chats) {
    const id = String(chat.id || "");
    if (!id || excluded.has(id) || isGroupChat(id)) continue;
    let handle = id;
    if (sourceFor(id) === "whatsapp") {
      handle = waDmPhone(id);
      if (handle.includes("@")) continue; // a LID carries no number: its own row
    }
    const rec = resolveRecord(handle, idx, input.homeCc);
    const key = rec === null ? phoneIdentity(handle, input.homeCc) : `rec:${rec}`;
    if (key === null) continue;
    const list = byPerson.get(key) ?? [];
    list.push(chat);
    byPerson.set(key, list);
  }

  const out: Record<string, string> = {};
  const newest = (a: JoinChat, b: JoinChat) => (String(b.last || "") > String(a.last || "") ? b : a);
  for (const chats of byPerson.values()) {
    if (chats.length < 2 || chats.length > MAX_GROUP_MEMBERS) continue;
    const candidates = chats.map((c) => c.id);
    const inGroup = new Set(candidates);
    // Sticky: the previous canonical for this group wins while it survives.
    const prevTargets = [...new Set(candidates.map((c) => input.previous[c]).filter((t) => inGroup.has(t)))];
    let canonical: string;
    if (prevTargets.length === 1) {
      canonical = prevTargets[0]!;
    } else {
      // Two old folds merged (the contacts store changed): newest survives.
      const pool = prevTargets.length > 1
        ? chats.filter((c) => prevTargets.includes(c.id))
        : chats.filter((c) => !(c.id in input.bridgeAliases));
      const pick = pool.length ? pool : chats;
      canonical = pick.reduce(newest).id;
    }
    for (const id of candidates) {
      if (id === canonical) continue;
      if (Object.keys(out).length >= MAX_ENTRIES) return out;
      out[id] = canonical;
    }
  }
  return out;
}

/**
 * The map every fold actually runs over: the bridge's cluster aliases and
 * the person aliases made one-step-resolvable. Not a plain union — the
 * bridge says `alias → bridgeCanonical` while the person fold says
 * `bridgeCanonical → personCanonical`, so every target that is itself a
 * person member must be rewritten or the rows split right back apart.
 */
export function effectiveAliasMap(
  chatAliases: Record<string, string>,
  personAliases: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = { ...chatAliases };
  for (const [k, v] of Object.entries(personAliases)) out[k] = v;
  for (const k of Object.keys(out)) {
    const target = personAliases[out[k]!];
    if (target) out[k] = target;
  }
  return out;
}
