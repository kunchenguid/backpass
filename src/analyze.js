import fs from "node:fs";
import path from "node:path";

import { execOneShot, extractJson, sessionPrompt, usageRecord } from "./acpx.js";
import { distill } from "./distill.js";
import { readTranscript } from "./discovery/index.js";
import { renderInstructionIndex } from "./memory.js";
import { renderPrompt } from "./prompts.js";
import { evidenceKey, isEvidenceFresh, safeFileName } from "./state.js";
import { emitProgress } from "./progress.js";
import { UserError, color, info, warn } from "./logger.js";
import { transcriptIdentity } from "./transcript.js";

/**
 * Stage 1 of the pipeline (design section 3): one cheap model call per transcript,
 * fanned out over a small worker pool.
 *
 * Everything expensive is cached. Evidence is keyed to the transcript's content
 * signature AND the memory-file hash it was judged against, so re-running after an
 * apply correctly re-analyzes against the new weights while an unchanged run is free.
 */

const MIN_ASSISTANT_TURNS = 4;
const MIN_TOOL_CALLS = 3;

let callCounter = 0;
const seenNotes = new Set();

/** The same adapter limitation would repeat once per transcript; say it once per run. */
function noteOnce(note) {
  if (seenNotes.has(note)) return;
  seenNotes.add(note);
  warn(note);
}

/** Evidence items without a verbatim quote are dropped - the rubric's central rule. */
export function sanitizeEvidence(parsed) {
  const clean = { positive: [], negative: [], gaps: [], usedRawTranscript: Boolean(parsed?.usedRawTranscript) };
  if (!parsed || typeof parsed !== "object") return clean;

  const hasQuote = (item) => typeof item?.quote === "string" && item.quote.trim().length >= 8;

  for (const key of ["positive", "negative"]) {
    for (const item of Array.isArray(parsed[key]) ? parsed[key] : []) {
      if (!hasQuote(item) || typeof item.instruction !== "string") continue;
      clean[key].push({
        instruction: item.instruction.trim(),
        moment: String(item.moment ?? "").slice(0, 80),
        effect: String(item.effect ?? "").slice(0, 400),
        quote: item.quote.trim().slice(0, 600),
      });
    }
  }

  for (const item of Array.isArray(parsed.gaps) ? parsed.gaps : []) {
    if (!hasQuote(item) || typeof item.proposedInstruction !== "string") continue;
    clean.gaps.push({
      mistake: String(item.mistake ?? "").slice(0, 400),
      proposedInstruction: item.proposedInstruction.trim().slice(0, 400),
      recurrenceRisk: ["high", "medium", "low"].includes(item.recurrenceRisk) ? item.recurrenceRisk : "medium",
      quote: item.quote.trim().slice(0, 600),
    });
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

async function analyzeOne({ transcript, memoryFile, config, repo, slot = 0 }) {
  const raw = await readTranscript(transcript);
  const distilled = distill(raw.events, {
    ...transcript,
    model: raw.model,
    rawPath: raw.rawPath,
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

  const prompt = renderPrompt("analysis", {
    MEMORY_PATH: memoryFile.path,
    INSTRUCTION_INDEX: renderInstructionIndex(memoryFile),
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
      cwd: repo.root,
      timeoutSeconds: config.timeoutSeconds,
      promptRetries: config.promptRetries,
    };
    // Route effortful calls through a fresh per-transcript session so each harness's
    // invocation-scoped overlay or safe fallback is applied; otherwise one-shot is cheaper.
    if (!pick.effort) return execOneShot(call);
    callCounter += 1;
    return sessionPrompt({
      ...call,
      effort: pick.effort,
      sessionName: `backpass-analysis-${process.pid}-${slot}-${callCounter}`,
    });
  });
  for (const note of result.notes || []) noteOnce(note);

  const parsed = extractJson(result.text);
  if (!parsed) {
    throw new Error("analysis returned no parseable JSON");
  }

  return {
    status: "ok",
    evidence: sanitizeEvidence(parsed),
    usage: usageRecord(ranWith, result),
    distilled,
  };
}

/**
 * Bounded-concurrency worker pool - the design's `--jobs N` fan-out.
 * The worker also receives its runner slot so the progress view can show one
 * lane per job.
 */
async function pool(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async (_, slot) => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index, slot);
    }
  });
  await Promise.all(runners);
  return results;
}

export async function analyzeTranscripts({ transcripts, memoryFile, config, repo, memoryHash, force = false }) {
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
  };
  const priorHashes = new Set();

  for (const transcript of transcripts) {
    const existing = state.readEvidence(transcript);
    if (!force && isEvidenceFresh(existing, transcript, memoryHash)) {
      summary.cached += 1;
      continue;
    }
    // Distinguish "no prior evidence" from "prior evidence exists, but it was judged
    // against a memory-file set that no longer matches" - a re-analysis here, not a miss.
    if (existing?.status === "ok" && existing.memoryHash && existing.memoryHash !== memoryHash) {
      summary.staleMemoryHash += 1;
      priorHashes.add(existing.memoryHash);
    }
    pending.push(transcript);
  }

  if (summary.staleMemoryHash) {
    info(
      `${color.yellow("·")} ${summary.staleMemoryHash} transcript(s) have evidence from a previous ` +
        `memory-file set (${[...priorHashes].join(", ")} -> ${memoryHash}); that evidence is stale, not ` +
        `missing, and reuse resumes once this pass re-judges it against the current memory-file set`,
    );
  }

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

  let done = 0;
  const evidenceTotals = { positive: 0, negative: 0, gaps: 0 };
  await pool(pending, config.jobs, async (transcript, _index, slot) => {
    const base = {
      transcript: {
        harness: transcript.harness,
        id: transcript.id,
        identity: transcriptIdentity(transcript),
        path: transcript.path,
        mtimeMs: transcript.mtimeMs,
        bytes: transcript.bytes,
        startedAt: transcript.startedAt,
        association: transcript.association,
      },
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
      const result = await analyzeOne({ transcript, memoryFile, config, repo, slot });
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

  emitProgress("analyze:done", summary);
  return summary;
}
