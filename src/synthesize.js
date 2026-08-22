import fs from "node:fs";
import path from "node:path";

import { extractJson, openSession, usageRecord } from "./acpx.js";
import { renderEvidenceForPrompt } from "./fold.js";
import { renderInstructionIndex } from "./memory.js";
import { renderPrompt } from "./prompts.js";
import { buildProposal, effectiveMaxEdits, ProposalViolation, renderChangesForPrompt } from "./proposal.js";
import { loadSkills, renderSkillIndex, resolveOverflowTarget } from "./skills.js";
import { isSuppressedByRejection } from "./state.js";
import { emitProgress } from "./progress.js";
import { measureWorkspace, prepareWorkspace, repoFingerprint } from "./workspace.js";
import { UserError, color, info, warn } from "./logger.js";

/**
 * Stage 3 of the pipeline (design section 3): one high-reasoning session that turns
 * folded evidence into concrete edits.
 *
 * The agent never describes an edit for backpass to locate - it makes the edit, with its
 * harness's own file tools, in a staging copy of the memory file (`src/workspace.js`).
 * One session, two kinds of turn:
 *
 *   edit      the synthesis prompt; the agent edits `./AGENTS.md` in the staging copy
 *   annotate  backpass measures the copy against the original (`src/diff.js`) and shows
 *             the changes by id; the agent attaches kind, title, rationale, and evidence
 *
 * The annotation is what the mechanical gates validate (`buildProposal`); on a violation
 * the agent is re-prompted with the exact breaches, at most ANNOTATE_TURNS times in all,
 * then backpass fails loudly and saves the rejected proposal rather than quietly trimming
 * it (design section 6). The repo is fingerprinted before and checked after: a harness
 * that wrote past the staging copy is an error, never a silent apply.
 */

/** Annotation turns per run: the first answer plus re-prompts with the exact violations. */
export const ANNOTATE_TURNS = 3;

function budgetRule(memoryFile, config, maxEdits) {
  const remaining = config.budgetTokens - memoryFile.tokens;
  if (remaining <= 0) {
    return (
      `This file is ALREADY ${Math.abs(remaining)} tokens OVER budget, so this run is a SHRINK ` +
      `PLAN. You are NOT expected to reach ${config.budgetTokens} tokens in one run - the ` +
      `${maxEdits}-edit cap for this run makes that impossible and later runs continue the work. ` +
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

/** The repo must be exactly as fingerprinted; the staging copy is the only place to write. */
function assertRepoUntouched(repo, before, workspaceRoot) {
  const after = repoFingerprint(repo, Object.keys(before));
  const moved = Object.keys(before).filter((file) => before[file] !== after[file]);
  if (!moved.length) return;
  throw new UserError(
    `synthesis changed ${moved.join(", ")} in the repository directly instead of the staging copy ` +
      `(${workspaceRoot}); nothing was proposed`,
    `inspect the change with \`git diff\`, restore the file, and re-run - a harness that edits outside its cwd cannot be trusted with the synthesis role`,
  );
}

export async function synthesizeProposal({ memoryFile, summary, config, repo, transcripts, runNote = "" }) {
  const state = config.state;
  const rejections = state.readRejections();
  const overflow = resolveOverflowTarget(repo.root, config.skillsDir);
  for (const w of overflow.warnings) warn(w);
  const skillFiles = loadSkills(repo.root, overflow.dir);
  const harnessCounts = harnessCountsOf(transcripts);
  const maxEdits = effectiveMaxEdits(memoryFile, config);

  const common = {
    MEMORY_PATH: memoryFile.path,
    BUDGET_RULE: budgetRule(memoryFile, config, maxEdits),
    MAX_EDITS: String(maxEdits),
    MIN_GAP_EVIDENCE: String(config.minGapEvidence),
  };
  const editValues = {
    ...common,
    REPO_NAME: repo.name,
    REPO_ROOT: repo.root,
    TRANSCRIPT_COUNT: String(summary.analyzedSessions),
    RUN_NOTE: runNote,
    HARNESS_SUMMARY:
      Object.entries(harnessCounts)
        .map(([h, n]) => `${h} ${n}`)
        .join(" · ") || "none",
    CURRENT_TOKENS: String(memoryFile.tokens),
    BUDGET_TOKENS: String(config.budgetTokens),
    BUDGET_STATE: budgetState(memoryFile, config),
    INSTRUCTION_INDEX: renderInstructionIndex(memoryFile),
    SKILLS_DIR: overflow.dir,
    SKILL_INDEX: renderSkillIndex(skillFiles),
    EVIDENCE: renderEvidenceForPrompt(summary),
    REJECTIONS: renderRejections(rejections),
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
  const editPromptFile = path.join(promptDir, "synthesis-edit.md");
  fs.writeFileSync(editPromptFile, renderPrompt("synthesis", editValues));

  const fingerprint = repoFingerprint(repo, [memoryFile.path, ...skillFiles.map((s) => s.path)]);
  const sessionName = `backpass-synth-${process.pid}`;
  const timeoutSeconds = Math.max(config.timeoutSeconds, 900);
  const usage = [];
  const notes = [];
  const noteOnce = (note) => {
    // The same adapter limitation is reported on every turn; say it once.
    if (notes.includes(note)) return;
    notes.push(note);
    warn(note);
  };

  const pick = await config.agents.resolve("synthesis");
  info(
    `${color.cyan("·")} synthesizing with ${pick.agent}` +
      `${pick.model ? ` (${pick.model})` : ""}` +
      `${pick.effort ? ` effort=${pick.effort}` : ""}`,
  );
  let ranWith = pick.agent;
  const progress = (phase, extra = {}) =>
    emitProgress("synth:start", {
      agent: ranWith,
      model: pick.model,
      effort: pick.effort,
      phase,
      maxEdits,
      sessionName,
      gapClusters: summary.totals.gapClusters,
      instructions: summary.instructions.length,
      suppressed: Object.keys(rejections.entries || {}).length,
      ...extra,
    });

  // A classifiable failure (not logged in, model rejected, adapter missing) falls
  // through to the next ladder candidate; the switch is recorded in the notes so the
  // proposal's provenance is visible. Once the editing turn has run, later turns stay
  // on the same candidate - a run never silently switches models after real work.
  /** @type {Awaited<ReturnType<typeof openSession>> | null} */
  let session = null;
  /** @type {ReturnType<typeof prepareWorkspace>} */
  let workspace = null;
  const editResult = await config.agents.withFallthrough("synthesis", async (current) => {
    ranWith = current.agent;
    if (current !== pick) notes.push(`synthesis fell through to ${current.agent} (${current.model})`);
    workspace = prepareWorkspace({ state, repo, memoryFile, skillsDir: overflow.dir });
    progress("edit", { attempt: 1 });
    session = await openSession({
      agent: current.agent,
      model: current.model,
      effort: current.effort,
      sessionName,
      cwd: workspace.root,
    });
    try {
      return await session.prompt({
        promptFile: editPromptFile,
        approveAll: true,
        timeoutSeconds,
        promptRetries: config.promptRetries,
      });
    } catch (err) {
      await session.close();
      session = null;
      throw err;
    }
  });
  usage.push(usageRecord(ranWith, editResult));
  for (const note of editResult.notes || []) noteOnce(note);

  const turn = session;
  try {
    let lastViolations = [];
    for (let attempt = 1; attempt <= ANNOTATE_TURNS; attempt += 1) {
      assertRepoUntouched(repo, fingerprint, workspace.root);
      const measured = measureWorkspace(workspace);

      let prompt = renderPrompt("annotate", {
        ...common,
        CHANGES: renderChangesForPrompt(measured, memoryFile),
      });
      if (lastViolations.length) {
        prompt +=
          `\n\n## Your previous answer was rejected\n\nIt violated these hard rules. Fix every one of them ` +
          `(edit the files first if a change must go or move) and return the corrected JSON object only.\n\n` +
          `${lastViolations.map((v) => `- ${v}`).join("\n")}\n`;
      }
      const promptFile = path.join(promptDir, `synthesis-annotate-${attempt}.md`);
      fs.writeFileSync(promptFile, prompt);
      progress("annotate", { attempt, changes: measured.changes.length });

      const result = await turn.prompt({
        promptFile,
        approveAll: true,
        timeoutSeconds,
        promptRetries: config.promptRetries,
      });
      usage.push(usageRecord(ranWith, result));
      for (const note of result.notes || []) noteOnce(note);

      // The agent may keep editing during an annotate turn; ids are then stale, so the
      // answer is discarded and the fresh measurement is shown instead.
      assertRepoUntouched(repo, fingerprint, workspace.root);
      const remeasured = measureWorkspace(workspace);
      if (remeasured.signature !== measured.signature) {
        lastViolations = [
          "the files changed after the changes were measured; annotate the re-measured changes shown above",
        ];
      } else {
        const parsed = extractJson(result.text);
        if (!parsed) {
          lastViolations = ["synthesis returned no parseable JSON object"];
        } else {
          const { proposal, violations } = buildProposal(parsed, { ...context, measured });
          proposal.notes = [...proposal.notes, ...notes];
          proposal.usage = usage;
          proposal.overflowTarget = overflow;
          if (!violations.length) {
            emitProgress("synth:done", { edits: proposal.edits.length, attempt });
            return { proposal, violations: [] };
          }
          lastViolations = violations;
          proposal.violations = violations;
          // Keep the rejected proposal so a loud failure is still inspectable.
          state.writeProposal(proposal);
        }
      }

      if (attempt < ANNOTATE_TURNS) {
        warn(`synthesis violated ${lastViolations.length} gate(s); re-prompting with the exact violations`);
        emitProgress("synth:violations", { attempt, violations: lastViolations });
      }
    }

    throw new ProposalViolation(
      `synthesis could not produce a valid proposal after ${ANNOTATE_TURNS - 1} re-prompt(s) (${lastViolations.length} violation(s))`,
      lastViolations,
    );
  } finally {
    await turn.close();
  }
}
