import fs from "node:fs";
import path from "node:path";

import { extractJson, sessionPrompt } from "./acpx.js";
import { renderEvidenceForPrompt } from "./fold.js";
import { renderInstructionIndex } from "./memory.js";
import { renderPrompt } from "./prompts.js";
import { buildProposal, ProposalViolation } from "./proposal.js";
import { loadSkills, renderSkillIndex, resolveOverflowTarget } from "./skills.js";
import { isSuppressedByRejection } from "./state.js";
import { emitProgress } from "./progress.js";
import { color, info, warn } from "./logger.js";

/**
 * Stage 3 of the pipeline (design section 3): one big high-reasoning call that turns
 * folded evidence into concrete edits.
 *
 * This is the expensive half of the two-tier design - cheap analysis, smart synthesis -
 * so it runs exactly once per run, plus at most one re-prompt when the mechanical gates
 * catch a violation. If the second attempt also violates, backpass fails loudly and
 * saves the rejected proposal rather than quietly trimming it (design section 6).
 */

function budgetRule(memoryFile, config) {
  const remaining = config.budgetTokens - memoryFile.tokens;
  if (remaining <= 0) {
    return (
      `This file is ALREADY ${Math.abs(remaining)} tokens OVER budget, so this run is a SHRINK ` +
      `PLAN. You are NOT expected to reach ${config.budgetTokens} tokens in one run - the ` +
      `${config.maxEditsPerRun}-edit cap makes that impossible and later runs continue the work. ` +
      `What is required is real progress: the edit set MUST be net-negative, so lead with the ` +
      `highest-cost instructions that have no positive evidence, and with skill extractions of ` +
      `long narrow sections. Any addition must name the removal that pays for it. Make the ` +
      `largest honest reduction you can justify from the evidence.`
    );
  }
  if (remaining < config.budgetTokens * 0.15) {
    return (
      `Only ${remaining} tokens of headroom remain. Treat this as zero-sum: every addition must ` +
      `name its offsetting removal or skill extraction. The post-edit file must stay at or below ` +
      `${config.budgetTokens} tokens.`
    );
  }
  return `The post-edit file must stay at or below ${config.budgetTokens} tokens (${remaining} tokens of headroom today).`;
}

function budgetState(memoryFile, config) {
  const ratio = memoryFile.tokens / config.budgetTokens;
  if (ratio > 1) return "OVER BUDGET";
  if (ratio > 0.85) return "near budget";
  return "within budget";
}

function renderRejections(rejections) {
  const entries = Object.values(rejections.entries || {});
  if (!entries.length) return "(none)";
  return entries
    .map(
      (e) =>
        `- [${e.kind}] ${e.title} (rejected ${e.rejectedAt.slice(0, 10)} with ${e.transcripts} session(s) of evidence)`,
    )
    .join("\n");
}

function harnessCountsOf(transcripts) {
  const counts = {};
  for (const t of transcripts) counts[t.harness] = (counts[t.harness] || 0) + 1;
  return counts;
}

export async function synthesizeProposal({ memoryFile, summary, config, repo, transcripts, runNote = "" }) {
  const state = config.state;
  const rejections = state.readRejections();
  const overflow = resolveOverflowTarget(repo.root, config.skillsDir);
  const skillFiles = loadSkills(repo.root, overflow.dir);
  const harnessCounts = harnessCountsOf(transcripts);

  const values = {
    REPO_NAME: repo.name,
    TRANSCRIPT_COUNT: String(summary.analyzedSessions),
    RUN_NOTE: runNote,
    HARNESS_SUMMARY:
      Object.entries(harnessCounts)
        .map(([h, n]) => `${h} ${n}`)
        .join(" · ") || "none",
    MEMORY_PATH: memoryFile.path,
    CURRENT_TOKENS: String(memoryFile.tokens),
    BUDGET_TOKENS: String(config.budgetTokens),
    BUDGET_STATE: budgetState(memoryFile, config),
    BUDGET_RULE: budgetRule(memoryFile, config),
    INSTRUCTION_INDEX: renderInstructionIndex(memoryFile),
    SKILLS_DIR: overflow.dir,
    SKILL_INDEX: renderSkillIndex(skillFiles),
    EVIDENCE: renderEvidenceForPrompt(summary),
    REJECTIONS: renderRejections(rejections),
    MAX_EDITS: String(config.maxEditsPerRun),
    MIN_GAP_EVIDENCE: String(config.minGapEvidence),
  };

  const context = {
    memoryFile,
    config: { ...config, skillsDir: overflow.dir },
    repo,
    summary,
    harnessCounts,
    rejections,
    isSuppressed: isSuppressedByRejection,
    skillFiles,
  };

  const promptDir = path.join(state.root, "prompts");
  fs.mkdirSync(promptDir, { recursive: true });

  let prompt = renderPrompt("synthesis", values);
  const usage = [];
  const notes = [];
  let lastViolations = [];

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const promptFile = path.join(promptDir, `synthesis-${attempt}.md`);
    fs.writeFileSync(promptFile, prompt);

    const pick = await config.agents.resolve("synthesis");
    info(
      `${color.cyan("·")} synthesizing with ${pick.agent}` +
        `${pick.model ? ` (${pick.model})` : ""}` +
        `${pick.effort ? ` effort=${pick.effort}` : ""}` +
        `${attempt > 1 ? " [re-prompt]" : ""}`,
    );
    emitProgress("synth:start", {
      agent: pick.agent,
      model: pick.model,
      effort: pick.effort,
      attempt,
      sessionName: `backpass-synth-${process.pid}`,
      gapClusters: summary.totals.gapClusters,
      instructions: summary.instructions.length,
      suppressed: Object.keys(rejections.entries || {}).length,
    });

    // A classifiable failure (not logged in, model rejected, adapter missing) falls
    // through to the next ladder candidate; the switch is recorded in the notes so the
    // proposal's provenance is visible.
    const result = await config.agents.withFallthrough("synthesis", async (current) => {
      if (current !== pick) notes.push(`synthesis fell through to ${current.agent} (${current.model})`);
      return sessionPrompt({
        agent: current.agent,
        model: current.model,
        effort: current.effort,
        sessionName: `backpass-synth-${process.pid}`,
        promptFile,
        cwd: repo.root,
        timeoutSeconds: Math.max(config.timeoutSeconds, 900),
      });
    });

    if (result.usage) usage.push(result.usage);
    // The same adapter limitation is reported on every attempt; say it once.
    for (const note of result.notes || []) {
      if (notes.includes(note)) continue;
      notes.push(note);
      warn(note);
    }

    const parsed = extractJson(result.text);
    if (!parsed) {
      lastViolations = ["synthesis returned no parseable JSON object"];
    } else {
      const { proposal, violations } = buildProposal(parsed, context);
      if (!violations.length) {
        proposal.notes = [...proposal.notes, ...notes];
        proposal.usage = usage;
        proposal.overflowTarget = overflow;
        emitProgress("synth:done", { edits: proposal.edits.length, attempt });
        return { proposal, violations: [] };
      }
      lastViolations = violations;
      proposal.notes = [...proposal.notes, ...notes];
      proposal.usage = usage;
      proposal.overflowTarget = overflow;
      proposal.violations = violations;
      // Keep the rejected proposal so a loud failure is still inspectable.
      state.writeProposal(proposal);
    }

    if (attempt === 1) {
      warn(`synthesis violated ${lastViolations.length} gate(s); re-prompting once with the exact violations`);
      emitProgress("synth:violations", { attempt, violations: lastViolations });
      prompt = `${renderPrompt("synthesis", values)}\n\n## Your previous answer was rejected\n\nIt violated these hard rules. Fix every one of them and return the corrected JSON object only.\n\n${lastViolations
        .map((v) => `- ${v}`)
        .join("\n")}\n`;
    }
  }

  throw new ProposalViolation(
    `synthesis could not produce a valid proposal after one re-prompt (${lastViolations.length} violation(s))`,
    lastViolations,
  );
}
