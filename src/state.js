import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

import { STATE_DIRNAME } from "./config.js";
import { UserError, warn } from "./logger.js";
import { ensureLocalExclude } from "./repo.js";
import { transcriptIdentity } from "./transcript.js";

/** The line every command writes to the repo's local git exclude for the state dir. */
export const STATE_EXCLUDE_LINE = `${STATE_DIRNAME}/`;

/**
 * All mutable run state lives in a `.backpass/` directory, kept out of git via the
 * repo's local exclude (`.git/info/exclude`, written idempotently by `ensure()` on every
 * command, so a plain `backpass` run with no prior `init` is excluded too) rather than
 * the tracked `.gitignore`:
 *
 *   scan-cache.json        path+mtime+size -> association verdict (design section 2.2)
 *   evidence/<identity>.json per-transcript tier-1 analysis output (design section 3)
 *   evidence-summary.json  folded evidence (stage 2)
 *   proposal.json          latest parseable tier-2 synthesis; absent if none was produced (stage 3)
 *   rejections.json        edits the human rejected, and the evidence weight behind them
 *   gap-ledger.json        gap observations by gap and session, accumulated across runs (src/gap-ledger.js)
 *   agent-probe-cache.json TTL'd availability/auth verdicts per agent|model (src/agents.js)
 *   prompts/               the exact prompts of the last run, one file per model turn
 *   synthesis/             the staging copy the synthesis agent edits natively (src/workspace.js)
 *   apply/                 the rendered Lavish apply surface
 */
export class State {
  /**
   * @param {string} repoRoot project checkout, or ignored when `options.stateDir` is set
   * @param {{ stateDir?: string, mode?: number, exclude?: boolean }} [options]
   */
  constructor(repoRoot, options = {}) {
    this.root = options.stateDir || path.join(repoRoot, STATE_DIRNAME);
    this.dirMode = options.mode;
    this.skipExclude = options.exclude === false;
    this.evidenceDir = path.join(this.root, "evidence");
    this.applyDir = path.join(this.root, "apply");
    this.scanCachePath = path.join(this.root, "scan-cache.json");
    this.summaryPath = path.join(this.root, "evidence-summary.json");
    this.proposalPath = path.join(this.root, "proposal.json");
    this.rejectionsPath = path.join(this.root, "rejections.json");
    this.gapLedgerPath = path.join(this.root, "gap-ledger.json");
    this.probeCachePath = path.join(this.root, "agent-probe-cache.json");
  }

  /**
   * Creates the state dir and excludes it from git in the same step. The exclude is
   * local-only and fail-soft: a non-git directory is silently left alone. User-scope
   * state is created 0700 and is never git-excluded (it does not live in a checkout).
   */
  ensure() {
    fs.mkdirSync(this.root, { recursive: true, ...(this.dirMode ? { mode: this.dirMode } : {}) });
    if (this.dirMode) {
      try {
        fs.chmodSync(this.root, this.dirMode);
      } catch (err) {
        throw new UserError(
          `could not secure state directory ${this.root} as mode ${this.dirMode.toString(8)}: ${err.message}`,
        );
      }
      const actualMode = fs.statSync(this.root).mode & 0o777;
      if (actualMode !== this.dirMode) {
        throw new UserError(
          `could not secure state directory ${this.root} as mode ${this.dirMode.toString(8)} (got ${actualMode.toString(8)})`,
        );
      }
    }
    fs.mkdirSync(this.evidenceDir, { recursive: true });
    fs.mkdirSync(this.applyDir, { recursive: true });
    this.exclude = this.skipExclude
      ? { status: "skipped" }
      : ensureLocalExclude(path.dirname(this.root), STATE_EXCLUDE_LINE);
    return this;
  }

  readJsonFile(file, fallback) {
    if (!fs.existsSync(file)) return fallback;
    try {
      return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (err) {
      warn(`discarding corrupt state file ${path.relative(process.cwd(), file)}: ${err.message}`);
      return fallback;
    }
  }

  writeJsonFile(file, value) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
    fs.renameSync(tmp, file);
  }

  readScanCache() {
    const cache = this.readJsonFile(this.scanCachePath, null);
    return cache && cache.version === 1 ? cache : { version: 1, entries: {} };
  }

  writeScanCache(cache) {
    this.writeJsonFile(this.scanCachePath, cache);
  }

  evidencePath(transcript) {
    const identity = transcript && typeof transcript === "object" ? transcriptIdentity(transcript) : transcript;
    return path.join(this.evidenceDir, `${safeFileName(identity)}.json`);
  }

  readEvidence(transcript) {
    const currentPath = this.evidencePath(transcript);
    const current = this.readJsonFile(currentPath, null);
    if (!transcript || typeof transcript !== "object") return current;

    const identity = transcriptIdentity(transcript);
    const legacyPath = this.evidencePath(transcript.id);
    if (legacyPath === currentPath) return current;
    const legacy = this.readJsonFile(legacyPath, null);
    const legacyMatches = legacy?.transcript && transcriptIdentity(legacy.transcript) === identity;
    if (current) {
      const currentMatches = current.transcript && transcriptIdentity(current.transcript) === identity;
      const migrated = currentMatches ? migrateEvidenceRecord(current, transcript, identity) : current;
      if (migrated !== current) this.writeJsonFile(currentPath, migrated);
      if (legacyMatches) fs.rmSync(legacyPath, { force: true });
      return migrated;
    }
    if (!legacyMatches) return null;

    const migrated = migrateEvidenceRecord(legacy, transcript, identity);
    // Publish the upgraded record atomically before removing the legacy path. If the
    // process stops between these operations, the next read prefers the valid canonical
    // record and merely cleans up the duplicate.
    this.writeJsonFile(currentPath, migrated);
    fs.rmSync(legacyPath, { force: true });
    return migrated;
  }

  writeEvidence(transcript, evidence) {
    this.writeJsonFile(this.evidencePath(transcript), evidence);
  }

  listEvidence() {
    if (!fs.existsSync(this.evidenceDir)) return [];
    const records = fs
      .readdirSync(this.evidenceDir)
      .filter((file) => file.endsWith(".json"))
      .map((file) => ({ file, record: this.readJsonFile(path.join(this.evidenceDir, file), null) }))
      .filter(({ record }) => Boolean(record));
    const unique = new Map();
    for (const item of records) {
      const identity = item.record.transcript ? transcriptIdentity(item.record.transcript) : `file:${item.file}`;
      const canonical = item.record.transcript ? path.basename(this.evidencePath(item.record.transcript)) : item.file;
      const existing = unique.get(identity);
      if (!existing || item.file === canonical) unique.set(identity, item);
    }
    return [...unique.values()].map(({ record }) => record);
  }

  readSummary() {
    return this.readJsonFile(this.summaryPath, null);
  }

  writeSummary(summary) {
    this.writeJsonFile(this.summaryPath, summary);
  }

  readProposal() {
    return this.readJsonFile(this.proposalPath, null);
  }

  writeProposal(proposal) {
    this.writeJsonFile(this.proposalPath, proposal);
  }

  clearProposal() {
    fs.rmSync(this.proposalPath, { force: true });
  }

  readRejections() {
    const value = this.readJsonFile(this.rejectionsPath, null);
    return value && value.version === 1 ? value : { version: 1, entries: {} };
  }

  writeRejections(rejections) {
    this.writeJsonFile(this.rejectionsPath, rejections);
  }

  /** Fail-soft: a missing or corrupt ledger starts empty and is rebuilt from this run's evidence. */
  readGapLedger() {
    const value = this.readJsonFile(this.gapLedgerPath, null);
    return value && value.version === 1 && value.entries && typeof value.entries === "object"
      ? value
      : { version: 1, entries: {} };
  }

  writeGapLedger(ledger) {
    this.writeJsonFile(this.gapLedgerPath, ledger);
  }

  readProbeCache() {
    const value = this.readJsonFile(this.probeCachePath, null);
    return value && value.version === 1 ? value : { version: 1, acpxVersion: null, entries: {} };
  }

  writeProbeCache(cache) {
    this.writeJsonFile(this.probeCachePath, cache);
  }
}

export function safeFileName(id) {
  return String(id)
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .slice(0, 120);
}

export function sha256(text) {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

function migrateEvidenceRecord(record, transcript, identity) {
  if (record.transcript?.identity === identity) return record;
  return {
    ...record,
    transcript: { ...record.transcript, identity },
  };
}

export const ANALYSIS_INDEX_VERSION = 2;

/**
 * Cache key for a transcript's analysis: its content signature, the memory-surface hash,
 * and the analysis index version. Changing any of them invalidates the evidence.
 */
export function evidenceKey(transcript, memoryHash) {
  return (
    `${transcriptIdentity(transcript)}:${transcript.mtimeMs}:${transcript.bytes}:${memoryHash}:` +
    `analysis-index-v${ANALYSIS_INDEX_VERSION}`
  );
}

/**
 * Only a successful analysis is worth caching. A `failed` entry is retried, and a
 * `skipped` entry is re-derived because the skip decision depends on configuration
 * (`minUserTurns`) rather than on the model - recomputing it costs one local file read.
 */
export function isEvidenceFresh(evidence, transcript, memoryHash) {
  if (!evidence || evidence.status !== "ok") return false;
  return evidence.key === evidenceKey(transcript, memoryHash);
}

/**
 * A rejected edit stays rejected until materially new evidence arrives - the design's
 * replacement for a DEFER button (captain tweak 3). "Materially new" means the edit is
 * backed by strictly more transcripts than when it was turned down.
 */
export function rejectionKey(edit) {
  let body;
  if (Array.isArray(edit.hunks)) {
    const files = new Set(edit.hunks.map((hunk) => hunk.file || edit.file).filter(Boolean));
    body = edit.hunks
      .map((hunk) =>
        files.size > 1
          ? `${hunk.file || edit.file}\u0000${hunk.find}\u0000${hunk.replace}`
          : `${hunk.find}\u0000${hunk.replace}`,
      )
      .join("\u0001");
  } else {
    body = `${edit.find || ""}\u0000${edit.replace || ""}`;
  }
  return sha256([edit.kind, edit.file, body].join(" ")).slice(0, 16);
}

export function isSuppressedByRejection(edit, rejections) {
  const prior = rejections.entries[rejectionKey(edit)];
  if (!prior) return false;
  return (edit.transcripts || 0) <= (prior.transcripts || 0);
}

export function recordRejection(edit, rejections, at = new Date().toISOString()) {
  rejections.entries[rejectionKey(edit)] = {
    kind: edit.kind,
    file: edit.file,
    title: edit.title,
    transcripts: edit.transcripts || 0,
    rejectedAt: at,
  };
  return rejections;
}
