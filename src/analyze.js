import fs from "node:fs";
import path from "node:path";

import { execOneShot, extractJson } from "./acpx.js";
import { distill } from "./distill.js";
import { readTranscript } from "./discovery/index.js";
import { renderInstructionIndex } from "./memory.js";
import { renderPrompt } from "./prompts.js";
import { evidenceKey, isEvidenceFresh, safeFileName } from "./state.js";
import { color, info, warn } from "./logger.js";

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

function promptPathFor(state, transcript) {
  return path.join(state.applyDir, "..", "prompts", `${safeFileName(transcript.id)}.md`);
}

async function analyzeOne({ transcript, memoryFile, config, repo }) {
  const raw = await readTranscript(transcript);
  const distilled = distill(raw.events, {
    ...transcript,
    model: raw.model,
    rawPath: raw.rawPath,
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

  const result = await execOneShot({
    agent: config.analysis.agent,
    model: config.analysis.model,
    promptFile,
    cwd: repo.root,
    timeoutSeconds: config.timeoutSeconds,
    promptRetries: config.promptRetries,
  });

  const parsed = extractJson(result.text);
  if (!parsed) {
    throw new Error("analysis returned no parseable JSON");
  }

  return {
    status: "ok",
    evidence: sanitizeEvidence(parsed),
    usage: result.usage,
    distilled,
  };
}

/** Bounded-concurrency worker pool - the design's `--jobs N` fan-out. */
async function pool(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

export async function analyzeTranscripts({ transcripts, memoryFile, config, repo, memoryHash, force = false }) {
  const state = config.state;
  const pending = [];
  const summary = { total: transcripts.length, cached: 0, analyzed: 0, skipped: 0, failed: 0, usage: [] };

  for (const transcript of transcripts) {
    const existing = state.readEvidence(transcript.id);
    if (!force && isEvidenceFresh(existing, transcript, memoryHash)) {
      summary.cached += 1;
      continue;
    }
    pending.push(transcript);
  }

  if (!pending.length) return summary;

  info(
    `${color.cyan("·")} analyzing ${pending.length} transcript(s) with ${config.analysis.agent}` +
      `${config.analysis.model ? ` (${config.analysis.model})` : ""} at jobs=${config.jobs}`,
  );

  let done = 0;
  await pool(pending, config.jobs, async (transcript) => {
    const base = {
      transcript: {
        harness: transcript.harness,
        id: transcript.id,
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

    try {
      const result = await analyzeOne({ transcript, memoryFile, config, repo });
      if (result.status === "skipped") {
        summary.skipped += 1;
        state.writeEvidence(transcript.id, { ...base, status: "skipped", reason: result.reason });
      } else {
        summary.analyzed += 1;
        summary.usage.push(result.usage);
        state.writeEvidence(transcript.id, {
          ...base,
          status: "ok",
          stats: result.distilled.stats,
          ...result.evidence,
        });
      }
    } catch (err) {
      // Per-transcript fail-soft: recorded, listed by `backpass status`, retried next run.
      summary.failed += 1;
      warn(`${transcript.harness} ${transcript.nativeId}: ${err.message}`);
      state.writeEvidence(transcript.id, { ...base, status: "failed", error: err.message });
    } finally {
      done += 1;
      if (done % 10 === 0 || done === pending.length) {
        info(`${color.dim(`  ${done}/${pending.length} analyzed`)}`);
      }
    }
  });

  return summary;
}
