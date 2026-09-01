#!/usr/bin/env bun
/**
 * Blip attachment fetcher — pulls one attachment's bytes from the Mac into
 * the local media cache and prints {ok, path, url} JSON for QML.
 *
 *   bun fetch.ts <attachment-id> <name> <mime>
 *
 * The cache DELIBERATELY relaxes the "no message content on disk" invariant,
 * scoped to media (Fred's call, 2026-08-31): the disk is LUKS-encrypted at
 * rest, so plain files under ~/.cache/blip/att (dir 0700, files 0600) are
 * acceptable. state.json still never holds content.
 *
 * Cache key = <id>-<transform>-<sanitized name>: the transform distinguishes
 * a sips-converted JPEG from the original so the two never collide. LRU by
 * mtime (touched on every hit — atime is unreliable under relatime), capped
 * at 500 MB, evicted after each write.
 */

import { spawnSync } from "node:child_process";
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const HOME = process.env.HOME ?? "/home/pi";
export const CACHE_DIR = join(process.env.XDG_CACHE_HOME ?? join(HOME, ".cache"), "blip", "att");
export const CACHE_CAP_BYTES = 500 * 1024 * 1024;
export const FETCH_MAX_BYTES = 100 * 1024 * 1024;

/** HEIC needs converting on the Mac (sips) — Linux has no decoder. */
export function wantsJpeg(mime: string): boolean {
  return mime === "image/heic" || mime === "image/heif";
}

export function sanitizeName(name: string): string {
  const base = (name || "file").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 100);
  return base.replace(/^[._]+/, "") || "file";
}

export function cacheFileName(id: string, name: string, mime: string): string {
  const transform = wantsJpeg(mime) ? "jpg" : "orig";
  let file = `${id}-${transform}-${sanitizeName(name)}`;
  if (transform === "jpg" && !/\.jpe?g$/i.test(file)) file += ".jpg";
  return file;
}

/** Oldest-mtime files to delete so the cache fits the cap. Pure for tests. */
export function lruEvictions(
  entries: { name: string; bytes: number; mtimeMs: number }[],
  cap: number,
  keep: string,
): string[] {
  let total = entries.reduce((s, e) => s + e.bytes, 0);
  const out: string[] = [];
  for (const e of [...entries].sort((a, b) => a.mtimeMs - b.mtimeMs)) {
    if (total <= cap) break;
    if (e.name === keep) continue;
    out.push(e.name);
    total -= e.bytes;
  }
  return out;
}

function evict(keep: string): void {
  let entries: { name: string; bytes: number; mtimeMs: number }[] = [];
  try {
    entries = readdirSync(CACHE_DIR).map((name) => {
      const st = statSync(join(CACHE_DIR, name));
      return { name, bytes: st.size, mtimeMs: st.mtimeMs };
    });
  } catch {
    return;
  }
  for (const name of lruEvictions(entries, CACHE_CAP_BYTES, keep)) {
    try { unlinkSync(join(CACHE_DIR, name)); } catch { /* viewer may hold it; next pass */ }
  }
}

export interface FetchResult {
  ok: boolean;
  online: boolean;
  path: string;
  url: string;
  error: string;
}

export function fetchAttachment(
  id: string,
  name: string,
  mime: string,
  runner = spawnSync,
): FetchResult {
  const fail = (error: string, online = true): FetchResult =>
    ({ ok: false, online, path: "", url: "", error });

  if (!/^[0-9]{1,18}$/.test(id)) return fail("bad attachment id");
  mkdirSync(CACHE_DIR, { recursive: true, mode: 0o700 });

  const file = join(CACHE_DIR, cacheFileName(id, name, mime));
  try {
    const st = statSync(file);
    if (st.size > 0) {
      const now = new Date();
      utimesSync(file, now, now); // mtime is the LRU clock
      return { ok: true, online: true, path: file, url: pathToFileURL(file).href, error: "" };
    }
  } catch { /* not cached */ }

  const args = ["attachment", id, ...(wantsJpeg(mime) ? ["--jpeg"] : [])];
  const res = runner(`${HOME}/bin/imsg`, args, {
    timeout: 120000,
    maxBuffer: FETCH_MAX_BYTES + (1 << 20),
  });
  if (res.status === 69 || res.status === 255) return fail("Mac unreachable", false);
  if (res.status !== 0) {
    const err = (res.stderr || "").toString().trim().split("\n")[0] || `imsg exit ${res.status}`;
    return fail(err);
  }
  const bytes = res.stdout as Buffer;
  if (!bytes || bytes.length === 0) return fail("empty attachment stream");
  if (bytes.length > FETCH_MAX_BYTES) return fail("attachment exceeds the fetch ceiling");

  // tmp + fsync + rename: a killed fetch must never leave a cache hit that
  // looks complete.
  const tmp = `${file}.tmp-${process.pid}`;
  const fd = openSync(tmp, "wx", 0o600);
  try {
    writeSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, file);
  evict(cacheFileName(id, name, mime));
  return { ok: true, online: true, path: file, url: pathToFileURL(file).href, error: "" };
}

if (import.meta.main) {
  const [id, name, mime] = [process.argv[2] ?? "", process.argv[3] ?? "file", process.argv[4] ?? ""];
  try {
    console.log(JSON.stringify(fetchAttachment(id, name, mime)));
  } catch (e) {
    console.log(JSON.stringify({ ok: false, online: true, path: "", url: "", error: String(e) }));
  }
}
