#!/usr/bin/env bun
/**
 * Hide a conversation.
 *
 * Blip already silences conversations through `~/.config/blip/mutelist.json`,
 * re-read on every poll and applied upstream of everything: a hidden
 * conversation is absent from the list, from the unread ledger, from the badge
 * and from the toasts, as though it had never arrived. What it lacked was a
 * way to put one there without opening a text editor.
 *
 *   bun mute.ts add <chat id>       → {"ok":true,"hidden":"…"}
 *   bun mute.ts remove <chat id>
 *   bun mute.ts list
 *
 * A chat id, never message text — the mute list also matches phrases, and a
 * phrase is body text, which does not belong on argv.
 */

import {
  closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync,
} from "node:fs";
import { dirname } from "node:path";
import { MUTELIST_PATH, loadMutelist } from "./collector";

/** The file is an array or `{mute:[…]}`; whichever it already is, it stays. */
export function serializeMutelist(list: string[], wasObject: boolean): string {
  return JSON.stringify(wasObject ? { mute: list } : list, null, 2) + "\n";
}

export function isObjectShaped(raw: string): boolean {
  try {
    const parsed = JSON.parse(raw);
    return !!parsed && typeof parsed === "object" && !Array.isArray(parsed);
  } catch { return false; }
}

/**
 * A conversation id is added exactly once, at the end.
 *
 * Order is kept because the list is hand-edited as often as it is written
 * here, and a file that reshuffles itself is a file nobody trusts to edit.
 */
export function addToMutelist(list: string[], entry: string): string[] {
  const id = String(entry || "").trim();
  if (id === "" || list.includes(id)) return list;
  return [...list, id];
}

export function removeFromMutelist(list: string[], entry: string): string[] {
  const id = String(entry || "").trim();
  return list.filter((e) => e !== id);
}

/** Written the way state.json is: a private temp file, fsynced, renamed. */
export function writeMutelist(list: string[], path = MUTELIST_PATH): boolean {
  const tmp = `${path}.${process.pid}.tmp`;
  let wasObject = false;
  try { wasObject = isObjectShaped(readFileSync(path, "utf8")); } catch { /* new file */ }
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const fd = openSync(tmp, "wx", 0o600);
    try {
      writeSync(fd, serializeMutelist(list, wasObject));
      fsyncSync(fd);
    } finally { closeSync(fd); }
    renameSync(tmp, path);
    return true;
  } catch {
    try { unlinkSync(tmp); } catch { /* nothing to clean */ }
    return false;
  }
}

export interface MuteResult { ok: boolean; hidden: string; error: string }

export function hide(chat: string, path = MUTELIST_PATH): MuteResult {
  const id = String(chat || "").trim();
  // A conversation id, not a phrase: length-capped, printable ASCII, no
  // spaces. Whitespace and control characters would make the file unreadable
  // to the next hand edit, and a PHRASE entry \u2014 which the mute list also
  // accepts \u2014 is message text, which belongs nowhere near argv.
  // A hyphen is fine and must be: every WhatsApp room id carries one
  // ("27716059553-1461139805@g.us").
  if (id === "" || id.length > 320 || /[^\x21-\x7e]/.test(id)) {
    return { ok: false, hidden: "", error: "not a conversation id" };
  }
  const next = addToMutelist(loadMutelist(path), id);
  if (!writeMutelist(next, path)) return { ok: false, hidden: "", error: "could not write the list" };
  return { ok: true, hidden: id, error: "" };
}

export function unhide(chat: string, path = MUTELIST_PATH): MuteResult {
  const id = String(chat || "").trim();
  if (!writeMutelist(removeFromMutelist(loadMutelist(path), id), path)) {
    return { ok: false, hidden: "", error: "could not write the list" };
  }
  return { ok: true, hidden: id, error: "" };
}

if (import.meta.main) {
  const [cmd, chat] = process.argv.slice(2);
  try {
    if (cmd === "add") console.log(JSON.stringify(hide(String(chat ?? ""))));
    else if (cmd === "remove") console.log(JSON.stringify(unhide(String(chat ?? ""))));
    else if (cmd === "list") console.log(JSON.stringify(loadMutelist()));
    else {
      console.log(JSON.stringify({ ok: false, hidden: "", error: `unknown command '${cmd ?? ""}'` }));
      process.exit(64);
    }
  } catch (e) {
    console.log(JSON.stringify({ ok: false, hidden: "", error: String(e) }));
  }
}
