#!/usr/bin/env bun
/**
 * Shared `contacts --json dump` loader (AddressBook via the Mac bridge).
 *
 * One cache file at $XDG_RUNTIME_DIR/blip/contacts-dump.json (tmpfs, 0700/0600,
 * contact summaries only) serves every caller; each passes its own TTL and
 * whoever misses first refreshes it, so a 10-minute person-fold join and a
 * 60-second search never fight over the Mac.
 */

import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";

const HOME = process.env.HOME ?? homedir();

export interface RawContact {
  name?: string;
  org?: string;
  nick?: string;
  phones?: { number?: string; label?: string }[];
  emails?: { address?: string; label?: string }[] | string[];
}

export function slimContact(c: RawContact): RawContact {
  return { name: c.name, org: c.org, nick: c.nick, phones: c.phones, emails: c.emails };
}

export function contactDumpPath(): string {
  const cacheDir = join(process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid?.() ?? 1000}`, "blip");
  return join(cacheDir, "contacts-dump.json");
}

/** Cached dump, or "offline" (Mac unreachable), or an error string. */
export function loadContactDump(
  runner: typeof spawnSync,
  ttlMs: number,
  home: string = HOME,
): RawContact[] | "offline" | string {
  const cachePath = contactDumpPath();
  try {
    if (Date.now() - statSync(cachePath).mtimeMs < ttlMs) {
      const parsed = JSON.parse(readFileSync(cachePath, "utf8"));
      if (Array.isArray(parsed)) return (parsed as RawContact[]).map(slimContact);
    }
  } catch { /* miss */ }
  const res = runner(join(home, "bin", "contacts"), ["--json", "dump"], {
    encoding: "utf8",
    timeout: 15000, maxBuffer: 64 * 1024 * 1024,
  });
  if (res.status === 69 || res.status === 255) return "offline";
  if (res.status !== 0) {
    const err = (res.stderr || "").toString().trim().split("\n")[0] || `contacts exit ${res.status}`;
    return err;
  }
  try {
    const parsed = JSON.parse(res.stdout as string);
    if (!Array.isArray(parsed)) throw new Error("not an array");
    const slim = (parsed as RawContact[]).map(slimContact);
    try {
      mkdirSync(join(cachePath, ".."), { mode: 0o700, recursive: true });
      writeFileSync(cachePath, JSON.stringify(slim), { mode: 0o600 });
    } catch { /* cache is optional */ }
    return slim;
  } catch (e) {
    return `bad JSON from contacts: ${e}`;
  }
}
