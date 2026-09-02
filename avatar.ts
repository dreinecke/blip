#!/usr/bin/env bun
/**
 * Blip contact photo fetcher — `imsg avatar <handle>` on the Mac streams the
 * Contacts thumbnail (JPEG); this caches it under ~/.cache/blip/avatars keyed
 * by a hash of the handle, with a negative marker so contacts without a
 * photo are not re-asked every poll. Seven-day TTL either way.
 *
 *   bun avatar.ts <handle>   → {"ok":true,"url":"file://…"} | {"ok":false,…}
 */
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, renameSync, utimesSync, writeSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const HOME = process.env.HOME ?? homedir();
export const AVATAR_DIR = join(process.env.XDG_CACHE_HOME ?? join(HOME, ".cache"), "blip", "avatars");
export const AVATAR_TTL_MS = 7 * 24 * 3600 * 1000;
export const AVATAR_MAX_BYTES = 2 * 1024 * 1024;

export interface AvatarResult { ok: boolean; url: string; error: string }

export function avatarKey(handle: string): string {
  return createHash("sha256").update(handle.trim().toLowerCase()).digest("hex").slice(0, 32);
}

function fresh(path: string): boolean {
  try {
    const st = lstatSync(path);
    return st.isFile() && Date.now() - st.mtimeMs < AVATAR_TTL_MS;
  } catch { return false; }
}

export function fetchAvatar(handle: string, runner = spawnSync): AvatarResult {
  const h = handle.trim();
  if (h === "" || h.length > 320 || /[\s\x00-\x1f]/.test(h)) return { ok: false, url: "", error: "bad handle" };
  mkdirSync(AVATAR_DIR, { recursive: true, mode: 0o700 });
  const base = join(AVATAR_DIR, avatarKey(h));
  const file = `${base}.jpg`;
  const none = `${base}.none`;
  if (fresh(file)) return { ok: true, url: pathToFileURL(file).href, error: "" };
  if (fresh(none)) return { ok: false, url: "", error: "no photo" };

  const res = runner(`${HOME}/bin/imsg`, ["avatar", "--", h], { timeout: 20000, maxBuffer: AVATAR_MAX_BYTES + (1 << 20) });
  if (res.status === 69 || res.status === 255) return { ok: false, url: "", error: "Mac unreachable" };
  const bytes = res.stdout as Buffer;
  // Only a real JPEG/PNG is cached; anything else (an error string, a
  // Core Data reference) becomes a negative marker instead of a broken file.
  const isImage = !!bytes && bytes.length > 4 && ((bytes[0] === 0xff && bytes[1] === 0xd8) || (bytes[0] === 0x89 && bytes[1] === 0x50));
  if (res.error || res.status === null || res.status === 69 || res.status === 255) {
    return { ok: false, url: "", error: "Mac unreachable" };   // transient: no negative marker
  }
  if (res.status !== 0 || !isImage || bytes.length > AVATAR_MAX_BYTES) {
    const fd = openSync(none, "w", 0o600); closeSync(fd);
    const now = new Date(); utimesSync(none, now, now);
    return { ok: false, url: "", error: "no photo" };
  }
  const tmp = `${file}.tmp-${process.pid}`;
  const fd = openSync(tmp, "wx", 0o600);
  try { writeSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, file);
  return { ok: true, url: pathToFileURL(file).href, error: "" };
}

if (import.meta.main) {
  try {
    console.log(JSON.stringify(fetchAvatar(process.argv[2] ?? "")));
  } catch (e) {
    console.log(JSON.stringify({ ok: false, url: "", error: String(e) }));
  }
}
