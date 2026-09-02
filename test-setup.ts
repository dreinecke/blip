// Tests must never touch the developer's real caches: point XDG_CACHE_HOME at
// a scratch dir before any module computes CACHE_DIR / AVATAR_DIR.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "blip-test-cache-"));
