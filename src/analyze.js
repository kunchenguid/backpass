import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { extractJson, runModelCall, usageRecord } from "./acpx.js";
import { distill } from "./distill.js";
import { classifyInteraction } from "./interaction.js";
import { getAdapter, readTranscript } from "./discovery/index.js";
import { instructionUnits, renderInstructionIndex } from "./memory.js";
import { renderSkillIndexForAnalysis } from "./skills.js";
import { renderPrompt } from "./prompts.js";
import { renderOpenGapIndex } from "./gap-ledger.js";
import { evidenceKey, isEvidenceFresh, safeFileName } from "./state.js";
import { emitProgress } from "./progress.js";
import { UserError, color, info, warn } from "./logger.js";
import { corroborationIdentityOf, transcriptIdentity } from "./transcript.js";

/**
 * Stage 1 of the pipeline (design section 3): one cheap model call per transcript,
 * fanned out over a small worker pool.
 *
 * Everything expensive is cached. Evidence is keyed to the transcript's content
 * signature AND the memory-surface hash it was judged against, so re-running after a
 * memory-file or skill-description change correctly re-analyzes against the new weights
 * while an unchanged surface is free.
 */

const MIN_ASSISTANT_TURNS = 4;
const MIN_TOOL_CALLS = 3;

let callCounter = 0;
const seenNotes = new Set();
const activeRawFiles = new Set();

/**
 * A raw file is leased rather than owned by a PID: while its call runs, this process renews
 * the file's modification time every minute. Reclaim only after 24 hours without renewal,
 * allowing hours of clock skew between hosts sharing state while making SIGKILL leftovers
 * eligible for cleanup after a day. PIDs cannot prove liveness across hosts or namespaces.
 */
const RAW_LEASE_RENEW_MS = 60_000;
const RAW_LEASE_MS = 24 * 60 * 60_000;
const RAW_FILE_NAME = /^[0-9a-f-]{36}\.jsonl$/;
let leaseTimer = null;

process.once("exit", () => {
  for (const file of activeRawFiles) {
    try {
      fs.rmSync(file, { force: true });
    } catch (err) {
      warn(`could not remove raw transcript ${file}: ${err.message}`);
    }
  }
});

function renewRawLeases() {
  const now = new Date();
  for (const file of activeRawFiles) {
    try {
      fs.utimesSync(file, now, now);
    } catch {
      // Not written yet, or already removed; either way there is no lease to renew.
    }
  }
}

function holdRawFile(file) {
  activeRawFiles.add(file);
  if (!leaseTimer) {
    leaseTimer = setInterval(renewRawLeases, RAW_LEASE_RENEW_MS);
    leaseTimer.unref();
  }
}

function releaseRawFile(file) {
  activeRawFiles.delete(file);
  if (!activeRawFiles.size && leaseTimer) {
    clearInterval(leaseTimer);
    leaseTimer = null;
  }
  fs.rmSync(file, { force: true });
}

/** Housekeeping is best-effort: skip an inaccessible directory with one warning. */
function rawCleanupEntries(dir) {
  try {
    const stat = fs.lstatSync(dir, { throwIfNoEntry: false });
    if (!stat) return []; // Optional directory has not been created.
    if (!stat.isDirectory()) throw new Error("not a directory");
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    warn(`could not reclaim raw transcripts in ${dir}: ${err.message}`);
    return [];
  }
}

/**
 * Removes raw files whose lease expired - what an uncatchable exit such as SIGKILL leaves
 * behind - from the state root and its nested state directories.
 */
export function reclaimExpiredRawFiles(stateRoot) {
  if (!stateRoot) return;
  const now = Date.now();
  const roots = [stateRoot];
  const nested = path.join(stateRoot, "nested");
  for (const entry of rawCleanupEntries(nested)) {
    if (entry.isDirectory()) roots.push(path.join(nested, entry.name));
  }
  for (const root of roots) {
    const dir = path.resolve(root, "raw");
    for (const entry of rawCleanupEntries(dir)) {
      const file = path.join(dir, entry.name);
      if (!entry.isFile() || !RAW_FILE_NAME.test(entry.name)) continue;
      try {
        if (now - fs.statSync(file).mtimeMs > RAW_LEASE_MS) fs.rmSync(file, { force: true });
      } catch {
        // Removed by its own run in the meantime.
      }
    }
  }
}

/** The same adapter limitation would repeat once per transcript; say it once per run. */
function noteOnce(note) {
  if (seenNotes.has(note)) return;
  seenNotes.add(note);
  warn(note);
}

/** Negative evidence carries one of these classes; anything else is dropped as unjudged. */
export const NEGATIVE_CLASSES = ["harm", "non-compliance", "irrelevant"];

/** Whitespace-insensitive form used to check a quote against the trace it claims to come from. */
function foldSpace(text) {
  return String(text).replace(/\s+/g, " ").trim();
}

/**
 * Evidence items without a verbatim quote are dropped - the rubric's central rule.
 *
 * When `trace` is supplied and the model did not open the raw transcript, a quote must
 * also appear in that trace (whitespace folded). A quote that is long enough but not in
 * the trace is a paraphrase, and a paraphrase is a claim without evidence. When the model
 * reports `usedRawTranscript`, the quote may come from text the distiller truncated or
 * elided, so the substring check is skipped rather than punishing the honest path. Only
 * the literal boolean opts out: a model that answers `"false"` must still anchor its
 * quotes, or a stringly-typed reply would disable the check it is meant to fail.
 *
 * `quotesNotInTrace` counts what the trace check rejected, so a run whose analysis model
 * paraphrases everything reads as that rather than as a clean repo.
 */
export function sanitizeEvidence(parsed, memoryFile = null, trace = null) {
  const clean = {
    positive: [],
    negative: [],
    gaps: [],
    usedRawTranscript: parsed?.usedRawTranscript === true,
    quotesNotInTrace: 0,
  };
  if (!parsed || typeof parsed !== "object") return clean;

  const validInstructions = memoryFile ? new Set(instructionUnits(memoryFile).map((unit) => unit.id)) : null;
  const foldedTrace = typeof trace === "string" && !clean.usedRawTranscript ? foldSpace(trace) : null;
  const hasQuote = (item) => {
    if (typeof item?.quote !== "string" || item.quote.trim().length < 8) return false;
    if (foldedTrace === null || foldedTrace.includes(foldSpace(item.quote))) return true;
    clean.quotesNotInTrace += 1;
    return false;
  };

  for (const key of ["positive", "negative"]) {
    for (const item of Array.isArray(parsed[key]) ? parsed[key] : []) {
      if (!hasQuote(item) || typeof item.instruction !== "string") continue;
      const instruction = item.instruction.trim();
      if (validInstructions && !validInstructions.has(instruction)) continue;
      const entry = {
        instruction,
        moment: String(item.moment ?? "").slice(0, 80),
        effect: String(item.effect ?? "").slice(0, 400),
        quote: item.quote.trim().slice(0, 600),
      };
      // The class is what keeps "the agent skipped the rule" from being read as "the
      // rule caused harm" downstream. Only an explicit judged value is kept; records
      // from before the field existed simply carry none, and none never counts as harm.
      if (key === "negative" && NEGATIVE_CLASSES.includes(item.class)) entry.class = item.class;
      clean[key].push(entry);
    }
  }

  for (const item of Array.isArray(parsed.gaps) ? parsed.gaps : []) {
    if (!hasQuote(item) || typeof item.proposedInstruction !== "string") continue;
    const gap = {
      mistake: String(item.mistake ?? "").slice(0, 400),
      proposedInstruction: item.proposedInstruction.trim().slice(0, 400),
      recurrenceRisk: ["high", "medium", "low"].includes(item.recurrenceRisk) ? item.recurrenceRisk : "medium",
      quote: item.quote.trim().slice(0, 600),
      domain: item.domain === "orchestration" ? "orchestration" : "project",
    };
    if (typeof item.matchesGap === "string" && /^[0-9a-f]{16}$/.test(item.matchesGap.trim())) {
      gap.matchesGap = item.matchesGap.trim();
    }
    // A failed trigger: an existing skill's content would have prevented the mistake,
    // but the skill was not in play. Kept as a judged citation so the fold can count
    // failed triggers per skill; an absent or empty value simply means "no skill covers
    // this" and records nothing.
    if (typeof item.coveredBySkill === "string" && item.coveredBySkill.trim()) {
      gap.coveredBySkill = item.coveredBySkill.trim().slice(0, 120);
    }
    clean.gaps.push(gap);
  }

  return clean;
}

/**
 * Human-facing label for a transcript in progress output. Never a raw session ID: a
 * transcript with no title falls back to its session date/time, then to "(untitled)".
 */
export function transcriptLabel(transcript) {
  if (transcript.title) return transcript.title;
  const at = Number(transcript.startedAt);
  if (Number.isFinite(at) && at > 0) {
    const d = new Date(at);
    const pad = (n) => String(n).padStart(2, "0");
    return `session ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  return "(untitled)";
}

function promptPathFor(state, transcript) {
  return path.join(state.applyDir, "..", "prompts", `${safeFileName(transcriptIdentity(transcript))}.md`);
}

/**
 * The raw-transcript escape hatch must open one session, not expose a shared database
 * or require queries against an undocumented schema. File-backed sessions and remote
 * cached copies already have session-specific paths; local SQLite sessions need a
 * temporary export here. See README.md's Distill section for its lifecycle.
 *
 * @returns {string | null}
 */
function sessionRawPath(transcript, state) {
  if (transcript.host || !getAdapter(transcript.harness)?.sqliteBacked || !state?.root) return null;
  return path.resolve(state.root, "raw", `${randomUUID()}.jsonl`);
}

async function analyzeOne({
  transcript,
  memoryFile,
  config,
  repo,
  modelCwd = null,
  slot = 0,
  openGapIndex = "(none yet)",
  skillIndex = "(this repo has no skills)",
  alsoLoaded = "",
}) {
  const raw = await readTranscript(transcript);
  const rawFile = sessionRawPath(transcript, config.state);
  const distilled = distill(raw.events, {
    ...transcript,
    model: raw.model,
    rawPath: rawFile ?? raw.rawPath,
  });

  emitProgress("analyze:lane", {
    slot,
    harness: transcript.harness,
    id: transcript.nativeId,
    title: transcriptLabel(transcript),
    phase: "model",
    // Measure the input distill actually consumed, not `transcript.bytes`: that is a
    // discovery stat() size, which is a directory or 0 for several harnesses.
    rawBytes: Buffer.byteLength(JSON.stringify(raw.events), "utf8"),
    distilledBytes: Buffer.byteLength(distilled.trace, "utf8"),
  });

  // Triviality filter. `minUserTurns` is the knob, but a session is only truly trivial
  // when the agent barely did anything either: an autonomous run has exactly one user
  // turn (the brief) followed by hundreds of agent turns, and it carries plenty of
  // signal. Skipping those would discard most of a real corpus.
  const { userTurns, assistantTurns, toolCalls } = distilled.stats;
  if (userTurns < config.discovery.minUserTurns && assistantTurns < MIN_ASSISTANT_TURNS && toolCalls < MIN_TOOL_CALLS) {
    return {
      status: "skipped",
      reason: `trivial session (${userTurns} user turn(s), ${assistantTurns} agent turn(s), ${toolCalls} tool call(s))`,
      distilled,
    };
  }

  try {
    if (rawFile) {
      fs.mkdirSync(path.dirname(rawFile), { recursive: true, mode: 0o700 });
      const lines = [
        JSON.stringify({ harness: transcript.harness, session: transcript.nativeId, model: raw.model || null }),
        ...raw.events.map((event) => JSON.stringify(event)),
      ];
      holdRawFile(rawFile);
      fs.writeFileSync(rawFile, `${lines.join("\n")}\n`, { mode: 0o600, flag: "wx" });
    }

    const prompt = renderPrompt("analysis", {
      MEMORY_PATH: memoryFile.path,
      INSTRUCTION_INDEX: renderInstructionIndex(memoryFile),
      ALSO_LOADED: alsoLoaded,
      SKILLS: skillIndex,
      OPEN_GAPS: openGapIndex,
      TRACE: distilled.trace,
    });

    const promptFile = promptPathFor(config.state, transcript);
    fs.mkdirSync(path.dirname(promptFile), { recursive: true });
    fs.writeFileSync(promptFile, prompt);

    let ranWith = null;
    const result = await config.agents.withFallthrough("analysis", async (pick) => {
      ranWith = pick.agent;
      const call = {
        agent: pick.agent,
        model: pick.model,
        promptFile,
        cwd: modelCwd || repo.root,
        timeoutSeconds: config.timeoutSeconds,
        promptRetries: config.promptRetries,
      };
      // Route effortful calls through a fresh per-transcript session so each harness's
      // invocation-scoped overlay or safe fallback is applied; otherwise one-shot is cheaper.
      return runModelCall(call, pick, {
        sessionName: () => `backpass-analysis-${process.pid}-${slot}-${++callCounter}`,
      });
    });
    for (const note of result.notes || []) noteOnce(note);

    const parsed = extractJson(result.text);
    if (!parsed) {
      throw new Error("analysis returned no parseable JSON");
    }

    return {
      status: "ok",
      evidence: sanitizeEvidence(parsed, memoryFile, distilled.trace),
      usage: usageRecord(ranWith, result),
      distilled,
    };
  } finally {
    if (rawFile) releaseRawFile(rawFile);
  }
}

/**
 * Bounded-concurrency worker pool - the design's `--jobs N` fan-out.
 * The worker also receives its runner slot so the progress view can show one
 * lane per job.
 *
 * A worker error is fatal to the run (per-transcript failures never reach here), so the
 * first one stops the pool from handing out more items: without that, the other runners
 * kept taking transcripts and making model calls after the run had already reported the
 * failure. Calls already in flight finish and keep their results; the first error is
 * rethrown once every runner has stopped, so nothing is still running when it surfaces.
 */
async function pool(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  /** @type {{ err: unknown } | null} */
  let failure = null;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async (_, slot) => {
    while (!failure) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      try {
        results[index] = await worker(items[index], index, slot);
      } catch (err) {
        failure ??= { err };
        return;
      }
    }
  });
  await Promise.all(runners);
  if (failure) throw failure.err;
  return results;
}

export async function analyzeTranscripts({
  transcripts,
  memoryFile,
  skills = [],
  config,
  repo,
  modelCwd = null,
  memoryHash,
  force = false,
  prefetch = null,
  alsoLoaded = "",
}) {
  const state = config.state;
  const pending = [];
  const summary = {
    total: transcripts.length,
    cached: 0,
    analyzed: 0,
    skipped: 0,
    failed: 0,
    usage: [],
    staleMemoryHash: 0,
    quotesNotInTrace: 0,
  };
  const priorHashes = new Set();
  const transcriptMetadata = (transcript) => ({
    harness: transcript.harness,
    id: transcript.id,
    identity: transcriptIdentity(transcript),
    parentSessionId: transcript.parentSessionId || null,
    corroborationIdentity: corroborationIdentityOf(transcript),
    corroborationNativeId: transcript.corroborationNativeId || null,
    corroborationStartedAt: transcript.corroborationStartedAt ?? null,
    path: transcript.path,
    mtimeMs: transcript.mtimeMs,
    bytes: transcript.bytes,
    startedAt: transcript.startedAt,
    association: transcript.association,
    interaction: classifyInteraction(transcript),
    cwd: transcript.cwd || null,
    project: transcript.project || null,
    projectRoot: transcript.projectRoot || null,
    host: transcript.host || null,
  });

  for (const transcript of transcripts) {
    const existing = state.readEvidence(transcript);
    if (!force && isEvidenceFresh(existing, transcript, memoryHash)) {
      const updatedTranscript = { ...existing.transcript, ...transcriptMetadata(transcript) };
      if (JSON.stringify(existing.transcript) !== JSON.stringify(updatedTranscript)) {
        state.writeEvidence(transcript, { ...existing, transcript: updatedTranscript });
      }
      summary.cached += 1;
      continue;
    }
    // Distinguish "no prior evidence" from "prior evidence exists, but it was judged
    // against a memory surface that no longer matches" - a re-analysis here, not a miss.
    if (existing?.status === "ok" && existing.memoryHash && existing.memoryHash !== memoryHash) {
      summary.staleMemoryHash += 1;
      priorHashes.add(existing.memoryHash);
    }
    pending.push(transcript);
  }

  if (summary.staleMemoryHash) {
    info(
      `${color.yellow("·")} ${summary.staleMemoryHash} transcript(s) have evidence from a previous ` +
        `memory surface (${[...priorHashes].join(", ")} -> ${memoryHash}); that evidence is stale, not ` +
        `missing, and reuse resumes once this pass re-judges it against the current memory file and skill descriptions`,
    );
  }

  // Remote sessions have no content here yet. Fetch exactly the pending ones, before the
  // pool, so a cached or skipped transcript never costs an ssh call - and so an
  // unreachable host fails one transcript at a time rather than mid-fan-out.
  if (prefetch) await prefetch(pending);

  if (!pending.length) {
    emitProgress("analyze:start", { pending: 0, cached: summary.cached, total: transcripts.length, jobs: config.jobs });
    emitProgress("analyze:done", summary);
    return summary;
  }

  // Resolve (and, on the first run, probe) before the fan-out so the pick is announced once.
  const pick = await config.agents.resolve("analysis");
  emitProgress("analyze:start", {
    pending: pending.length,
    cached: summary.cached,
    total: transcripts.length,
    jobs: config.jobs,
    agent: pick.agent,
    model: pick.model,
  });

  info(
    `${color.cyan("·")} analyzing ${pending.length} transcript(s) with ${pick.agent}` +
      `${pick.model ? ` (${pick.model})` : ""}${pick.effort ? ` effort=${pick.effort}` : ""} at jobs=${config.jobs}`,
  );

  // Rendered once per run: the ledger's open gaps, so each analysis can cite an existing
  // gap id instead of coining a paraphrase of it (`matchesGap` in the reply schema), and
  // the skill index, so a mistake an existing skill's content covers is reported as a
  // failed trigger (`coveredBySkill`) instead of a brand-new gap.
  const openGapIndex = renderOpenGapIndex(state.readGapLedger(), memoryFile.path);
  const skillIndex = renderSkillIndexForAnalysis(
    modelCwd && path.resolve(modelCwd) !== path.resolve(repo.root)
      ? skills.map((skill) => ({
          ...skill,
          path: path.isAbsolute(skill.path) ? skill.path : path.join(repo.root, skill.path),
        }))
      : skills,
  );

  let done = 0;
  const evidenceTotals = { positive: 0, negative: 0, gaps: 0 };
  await pool(pending, config.jobs, async (transcript, _index, slot) => {
    const base = {
      transcript: transcriptMetadata(transcript),
      memoryHash,
      memoryPath: memoryFile.path,
      key: evidenceKey(transcript, memoryHash),
      analyzedAt: new Date().toISOString(),
    };

    emitProgress("analyze:lane", {
      slot,
      harness: transcript.harness,
      id: transcript.nativeId,
      title: transcriptLabel(transcript),
      phase: "distill",
    });

    try {
      const result = await analyzeOne({
        transcript,
        memoryFile,
        config,
        repo,
        modelCwd,
        slot,
        openGapIndex,
        skillIndex,
        alsoLoaded,
      });
      if (result.status === "skipped") {
        summary.skipped += 1;
        state.writeEvidence(transcript, { ...base, status: "skipped", reason: result.reason });
      } else {
        summary.analyzed += 1;
        summary.usage.push(result.usage);
        state.writeEvidence(transcript, {
          ...base,
          status: "ok",
          stats: result.distilled.stats,
          ...result.evidence,
        });
        evidenceTotals.positive += result.evidence.positive.length;
        evidenceTotals.negative += result.evidence.negative.length;
        evidenceTotals.gaps += result.evidence.gaps.length;
        summary.quotesNotInTrace += result.evidence.quotesNotInTrace;
        emitProgress("analyze:evidence", { ...evidenceTotals });
      }
    } catch (err) {
      if (err instanceof UserError) throw err;
      // Per-transcript fail-soft: recorded, listed by `backpass status`, retried next run.
      summary.failed += 1;
      warn(`${transcript.harness} ${transcriptLabel(transcript)}: ${err.message}`);
      state.writeEvidence(transcript, { ...base, status: "failed", error: err.message });
    } finally {
      done += 1;
      emitProgress("analyze:tick", {
        slot,
        done,
        ok: summary.analyzed,
        skipped: summary.skipped,
        failed: summary.failed,
      });
      if (done % 10 === 0 || done === pending.length) {
        info(`${color.dim(`  ${done}/${pending.length} analyzed`)}`);
      }
    }
  });

  if (summary.quotesNotInTrace) {
    warn(
      `${summary.quotesNotInTrace} quote(s) were discarded because they do not appear in the ` +
        `distilled trace they claim to come from; a model that paraphrases instead of copying ` +
        `produces fewer findings, not cleaner ones - consider a stronger analysis model`,
    );
  }

  emitProgress("analyze:done", summary);
  return summary;
}
