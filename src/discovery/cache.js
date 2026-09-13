import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * The fetch cache for remote transcripts (design section 6.7).
 *
 * Only sessions that are associated, sampled, and lacking fresh evidence ever cross the
 * wire, and what crosses is kept here so a re-run costs nothing: the raw transcript file
 * for file-backed stores - which is also what the trace footer names, so the analysis
 * agent's raw-transcript escape hatch still opens a real file - and the adapter's
 * normalized events for SQLite stores, which have no per-session file to copy.
 *
 * It lives inside the run's state directory (`<repo>/.backpass/hosts/`, or the user
 * scope's own `hosts/`), created 0700, so user-scope state still never enters a repo.
 * Entry names are a hash of (host, harness, key): a remote path is untrusted input and
 * must never be able to steer a write out of this directory. Writes are tmp + rename,
 * so an interrupted fetch leaves no half file behind.
 */

export const PRUNE_MAX_AGE_MS = 30 * 86_400_000;
const INDEX_VERSION = 1;

function entryName(host, harness, key) {
  return crypto.createHash("sha256").update(`${host}\n${harness}\n${key}`, "utf8").digest("hex");
}

export class HostCache {
  /** @param {string} stateDir the run's state directory */
  constructor(stateDir) {
    this.root = path.join(stateDir, "hosts");
    this.indexPath = path.join(this.root, "index.json");
  }

  ensure() {
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
    try {
      fs.chmodSync(this.root, 0o700);
    } catch {
      // A filesystem that cannot carry the mode still caches; the state dir above it is
      // already the security boundary.
    }
    return this;
  }

  readIndex() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.indexPath, "utf8"));
      if (parsed?.version === INDEX_VERSION && parsed.entries) return parsed;
    } catch {
      // A missing or corrupt index only costs a refetch.
    }
    return { version: INDEX_VERSION, entries: {} };
  }

  writeIndex(index) {
    this.ensure();
    const tmp = `${this.indexPath}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(index, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, this.indexPath);
  }

  filePath(host, harness, key) {
    return path.join(this.root, entryName(host, harness, key));
  }

  /**
   * The cached copy for a descriptor, or null when it is absent or stale. Staleness is
   * the descriptor's own `mtimeMs` + `bytes`, so a session that grew since the last run
   * is refetched rather than analyzed from a prefix of itself.
   */
  lookup(index, { host, harness, key, mtimeMs, bytes }) {
    const name = entryName(host, harness, key);
    const entry = index.entries[name];
    if (!entry) return null;
    if (entry.mtimeMs !== (mtimeMs ?? null) || entry.bytes !== (bytes ?? null)) return null;
    const file = path.join(this.root, name);
    if (!fs.existsSync(file)) return null;
    return { ...entry, name, path: file };
  }

  /** @returns {{ name: string, path: string, kind: string, bytes: number }} */
  write(index, { host, harness, key, kind, mtimeMs, bytes, model = null }, body) {
    this.ensure();
    const name = entryName(host, harness, key);
    const file = path.join(this.root, name);
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, body, { mode: 0o600 });
    fs.renameSync(tmp, file);
    index.entries[name] = {
      host,
      harness,
      key,
      kind,
      mtimeMs: mtimeMs ?? null,
      bytes: bytes ?? null,
      model,
      cachedBytes: body.length,
      usedAt: new Date().toISOString(),
    };
    return { name, path: file, kind, bytes: body.length };
  }

  /** Mark an entry as still in use, so pruning measures disuse rather than age. */
  touch(index, name) {
    if (index.entries[name]) index.entries[name].usedAt = new Date().toISOString();
  }

  /** Drop entries unused for `maxAgeMs`, and any file the index no longer claims. */
  prune(index, { maxAgeMs = PRUNE_MAX_AGE_MS, now = Date.now() } = {}) {
    let removed = 0;
    for (const [name, entry] of Object.entries(index.entries)) {
      const usedAt = Date.parse(entry.usedAt || "");
      if (Number.isFinite(usedAt) && now - usedAt < maxAgeMs) continue;
      delete index.entries[name];
      removed += 1;
      try {
        fs.rmSync(path.join(this.root, name), { force: true });
      } catch {
        // A file we cannot remove is reported by the next status, not a failed run.
      }
    }
    return removed;
  }

  /** Entry count and bytes per host, for `backpass status`. */
  stats(index = this.readIndex()) {
    const perHost = {};
    for (const entry of Object.values(index.entries)) {
      const row = (perHost[entry.host] ||= { entries: 0, bytes: 0 });
      row.entries += 1;
      row.bytes += entry.cachedBytes || 0;
    }
    return perHost;
  }
}
