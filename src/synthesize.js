import fs from "node:fs";
import path from "node:path";

import { extractJson, openSession, usageRecord } from "./acpx.js";
import { renderEvidenceForPrompt } from "./fold.js";
import { renderInstructionIndex } from "./memory.js";
import { renderPrompt, render, loadPrompt } from "./prompts.js";
import { buildProposal, effectiveMaxEdits, ProposalViolation, renderChangesForPrompt } from "./proposal.js";
import { loadSkills, renderSkillIndex, resolveOverflowTarget } from "./skills.js";
import { isSuppressedByRejection } from "./state.js";
import { emitProgress } from "./progress.js";
import { measureWorkspace, prepareWorkspace, repoFingerprint } from "./workspace.js";
import { UserError, color, info, warn } from "./logger.js";

/**
 * Stage 3 of the pipeline (design section 3): high-reasoning synthesis that turns folded
 * evidence into concrete edits.
 *
 * The agent never describes an edit for backpass to locate - it makes the edit, with its
 * harness's own file tools, in a staging copy of the memory file (`src/workspace.js`).
 * A run starts in one session with two kinds of turn:
 *
 *   edit      the synthesis prompt; the agent edits `./AGENTS.md` in the staging copy
 *   annotate  backpass measures the copy against the original (`src/diff.js`) and shows
 *             the changes by id; the agent attaches kind, title, rationale, and evidence
 *
 * An empty annotation turn is retried once in a fresh session, as described below.
 *
 * The annotation is what the mechanical gates validate (`buildProposal`). A parseable
 * gate-rejected answer is saved before the agent is re-prompted with the exact breaches;
 * judged answers are bounded by ANNOTATE_TURNS, then backpass fails loudly rather than
 * quietly trimming the result (design section 6). The repo is fingerprinted around each
 * turn; a harness that wrote past the staging copy is an error, never a silent apply.
 *
 * Three things an annotate turn can be are deliberately kept apart, because they call for
 * different responses and produce different advice at the end of a failed run:
 *
 *   the files moved      the ids the agent was asked about no longer exist. It is shown the
 *                        fresh measurement and answers again; this is not a failed
 *                        annotation and never costs an annotation attempt (REMEASURE_TURNS
 *                        bounds it instead).
 *   the turn was empty   the adapter returned success with no text at all. The model never
 *                        spoke, so there is nothing to correct - the annotation is retried
 *                        once in a NEW session, since the accumulated context of the old
 *                        one is the likeliest reason it collapsed.
 *   the answer was judged the model spoke and the gates ruled. Only this consumes an
 *                        annotation attempt, and only this writes a rejected proposal.
 */

/** Annotation attempts per run: the first answer plus re-prompts with the exact violations. */
export const ANNOTATE_TURNS = 3;
/**
 * Turns per run the agent may spend re-editing instead of answering. Counted for the whole
 * run, not consecutively: an agent that alternates editing and answering is still an agent
 * that never finishes, and the loop has to end.
 */
export const REMEASURE_TURNS = 3;
/** Fresh-session retries for an adapter turn that produced no text at all. */
export const EMPTY_TURN_RETRIES = 1;

const EMPTY_TURN_VIOLATION =
  "the synthesis harness ended its turn with no output at all - no JSON, no prose, no tool call";
const UNPARSEABLE_VIOLATION = "synthesis answered with text, but not with a JSON object";
const KEPT_EDITING_VIOLATION = "synthesis kept editing the staging copy instead of annotating the measured changes";

function budgetRule(memoryFile, config, maxEdits) {
  const remaining = config.budgetTokens - memoryFile.tokens;
  if (remaining <= 0) {
    return (
      `This file is ALREADY ${Math.abs(remaining)} tokens OVER budget, so this run is a SHRINK ` +
      `PLAN. You are NOT expected to reach ${config.budgetTokens} tokens in one run - the ` +
      `${maxEdits}-edit cap for this run makes that impossible and later runs continue the work. ` +
      `What is required is real progress: the edit set MUST be net-negative, so lead with skill ` +
      `extractions of long, narrow, crisply-triggered sections - extraction frees the same ` +
      `always-loaded tokens and loses nothing, and it never needs removal evidence. Deleting an ` +
      `instruction outright still needs its harm-evidence floor; the budget never lowers that ` +
      `bar. Any addition must name the removal or extraction that pays for it. Make the largest ` +
      `honest reduction you can justify from the evidence.`
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

/**
 * Everything the edit and annotation turns need: prompt values, the `buildProposal`
 * context, and the overflow target.
 */
function synthesisSetup({ memoryFile, summary, config, repo, harnessCounts }) {
  const state = config.state;
  const rejections = state.readRejections();
  const overflow = resolveOverflowTarget(repo.root, config.skillsDir);
  for (const w of overflow.warnings) warn(w);
  const skillFiles = loadSkills(repo.root, overflow.dir);
  const maxEdits = effectiveMaxEdits(memoryFile, config);

  const common = {
    MEMORY_PATH: memoryFile.path,
    BUDGET_RULE: budgetRule(memoryFile, config, maxEdits),
    MAX_EDITS: String(maxEdits),
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

  return { state, rejections, overflow, skillFiles, maxEdits, common, context, promptDir };
}

/**
 * The header a fresh annotation session needs. An in-session annotate turn inherits the
 * repository, the budget, and the evidence from the editing turn that preceded it; the
 * fresh session used after an empty reply would otherwise be asked to quote evidence it
 * has never been shown.
 */
function prefaceFor({ memoryFile, summary, config, repo, workspaceRoot }) {
  return render(loadPrompt("annotate-preface"), {
    MEMORY_PATH: memoryFile.path,
    REPO_NAME: repo.name,
    REPO_ROOT: repo.root,
    WORKSPACE_ROOT: workspaceRoot,
    CURRENT_TOKENS: String(memoryFile.tokens),
    BUDGET_STATE: budgetState(memoryFile, config),
    TRANSCRIPT_COUNT: String(summary.analyzedSessions),
    EVIDENCE: renderEvidenceForPrompt(summary),
  });
}

const REMEASURE_NOTICE =
  `\n\n## The files moved after they were measured\n\nYou changed the files again during your last turn, so the ids you were given no longer ` +
  `describe them. Nothing is wrong with the shape of your answer - annotate the re-measured ` +
  `changes above instead. This did not use up an annotation attempt.\n`;

const rejectionBlock = (violations) =>
  `\n\n## Your previous answer was rejected\n\nIt violated these hard rules. Fix every one of them ` +
  `(edit the files first if a change must go or move) and return the corrected JSON object only.\n\n` +
  `${violations.map((v) => `- ${v}`).join("\n")}\n`;

/** The headline of a failed run, named after the condition it actually ended on. */
function terminalMessage(reason, attempts, violations) {
  if (reason === "empty") {
    return "synthesis ended its turn with no output, in the run's session and again in a fresh one";
  }
  if (reason === "editing") {
    return `synthesis kept editing the staging copy instead of annotating it (${REMEASURE_TURNS} re-measurements)`;
  }
  return (
    `synthesis could not produce a valid proposal after ${Math.max(attempts - 1, 0)} re-prompt(s) ` +
    `(${violations.length} violation(s))`
  );
}

/**
 * Drive the annotate turns to a valid proposal, or throw a `ProposalViolation` describing
 * the condition the run actually ended on.
 *
 * `holder.session` is the live session; the loop replaces it when it needs a fresh one and
 * the caller closes whatever is in the holder at the end.
 */
async function annotateLoop({
  holder,
  freshSession,
  workspace,
  fingerprint,
  repo,
  context,
  common,
  promptDir,
  timeoutSeconds,
  promptRetries,
  usage,
  notes,
  noteOnce,
  overflow,
  progress,
  renderPreface,
  startFresh = false,
}) {
  const { memoryFile, config } = context;
  const state = config.state;

  let attempts = 0;
  let remeasures = 0;
  let emptyTurns = 0;
  let violationsToShow = [];
  let justRemeasured = false;
  let owePreface = startFresh;
  /** @type {{ attempt: number, violations: string[] } | null} */
  let saved = null;
  /** @type {{ reason: string, violations: string[] }} */
  let terminal;

  for (let turn = 1; ; turn += 1) {
    assertRepoUntouched(repo, fingerprint, workspace.root);
    const measured = measureWorkspace(workspace);

    let prompt = renderPrompt("annotate", {
      ...common,
      PREFACE: owePreface ? renderPreface() : "",
      CHANGES: renderChangesForPrompt(measured, memoryFile),
    });
    owePreface = false;
    if (justRemeasured) prompt += REMEASURE_NOTICE;
    else if (violationsToShow.length) prompt += rejectionBlock(violationsToShow);

    const promptFile = path.join(promptDir, `synthesis-annotate-${turn}.md`);
    fs.writeFileSync(promptFile, prompt);
    progress("annotate", { attempt: attempts + 1, turn, changes: measured.changes.length });

    const result = await holder.prompt({
      promptFile,
      approveAll: true,
      timeoutSeconds,
      promptRetries,
    });
    usage.push(usageRecord(holder.ranWith, result));
    for (const note of result.notes || []) noteOnce(note);

    // The agent may keep editing during an annotate turn; the ids it was answering about
    // are then stale, so the answer is dropped and the fresh measurement shown instead.
    // That is a measurement problem, not a failed annotation: it costs no attempt.
    assertRepoUntouched(repo, fingerprint, workspace.root);
    if (measureWorkspace(workspace).signature !== measured.signature) {
      remeasures += 1;
      justRemeasured = true;
      violationsToShow = [];
      if (remeasures >= REMEASURE_TURNS) {
        terminal = { reason: "editing", violations: [KEPT_EDITING_VIOLATION] };
        break;
      }
      warn(
        `synthesis edited the staging copy again; re-measuring and re-annotating ` +
          `(annotation attempt ${attempts + 1} of ${ANNOTATE_TURNS} is still unspent)`,
      );
      emitProgress("synth:remeasure", { turn, attempt: attempts + 1, remeasures });
      continue;
    }
    justRemeasured = false;

    // An empty turn is not a bad answer; it is no answer. Retry it once in a new session,
    // because the accumulated context of this one is the likeliest reason it collapsed.
    if (!(result.text || "").trim()) {
      emptyTurns += 1;
      if (emptyTurns > EMPTY_TURN_RETRIES) {
        terminal = { reason: "empty", violations: [EMPTY_TURN_VIOLATION] };
        break;
      }
      warn("synthesis ended its turn with no output; retrying the annotation once in a fresh session");
      emitProgress("synth:empty", { turn, attempt: attempts + 1, emptyTurns });
      await holder.session.close();
      holder.session = await freshSession();
      // The new session knows nothing, so it is given the preface; `violationsToShow` is
      // kept because those gates are still what the run's annotation has to satisfy.
      owePreface = true;
      continue;
    }

    attempts += 1;
    const parsed = extractJson(result.text);
    if (!parsed) {
      violationsToShow = [UNPARSEABLE_VIOLATION];
      if (attempts >= ANNOTATE_TURNS) {
        terminal = { reason: "unparseable", violations: violationsToShow };
        break;
      }
      warn(`synthesis violated 1 gate(s); re-prompting with the exact violations`);
      emitProgress("synth:violations", { attempt: attempts, violations: violationsToShow });
      continue;
    }

    const { proposal, violations } = buildProposal(parsed, { ...context, measured });
    proposal.notes = [...proposal.notes, ...notes];
    proposal.usage = usage;
    proposal.overflowTarget = overflow;
    proposal.attempt = attempts;
    if (!violations.length) {
      emitProgress("synth:done", { edits: proposal.edits.length, attempt: attempts });
      return { proposal, violations: [] };
    }

    violationsToShow = violations;
    proposal.violations = violations;
    // Keep the rejected proposal so a loud failure is still inspectable. It records which
    // attempt produced it, so a later empty turn cannot be reported as its author.
    state.writeProposal(proposal);
    saved = { attempt: attempts, violations };
    if (attempts >= ANNOTATE_TURNS) {
      terminal = { reason: "gates", violations };
      break;
    }
    warn(`synthesis violated ${violations.length} gate(s); re-prompting with the exact violations`);
    emitProgress("synth:violations", { attempt: attempts, violations });
  }

  throw new ProposalViolation(terminalMessage(terminal.reason, attempts, terminal.violations), terminal.violations, {
    reason: terminal.reason,
    attempts,
    saved,
    proposalPath: saved ? state.proposalPath : null,
  });
}

export async function synthesizeProposal({ memoryFile, summary, config, repo, transcripts, runNote = "" }) {
  config.state.clearProposal();
  const harnessCounts = harnessCountsOf(transcripts);
  const { state, rejections, overflow, skillFiles, maxEdits, common, context, promptDir } = synthesisSetup({
    memoryFile,
    summary,
    config,
    repo,
    harnessCounts,
  });

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
  let chosen = pick;
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
  /** @type {{ session: Awaited<ReturnType<typeof openSession>> | null, ranWith: string, prompt: Function }} */
  const holder = {
    session: null,
    ranWith,
    prompt(args) {
      if (!this.session) throw new Error("synthesis session is not open");
      return this.session.prompt(args);
    },
  };
  /** @type {ReturnType<typeof prepareWorkspace>} */
  let workspace = null;
  const editResult = await config.agents.withFallthrough("synthesis", async (current) => {
    ranWith = current.agent;
    holder.ranWith = current.agent;
    chosen = current;
    if (current !== pick) notes.push(`synthesis fell through to ${current.agent} (${current.model})`);
    workspace = prepareWorkspace({ state, repo, memoryFile, skillsDir: overflow.dir });
    progress("edit", { attempt: 1 });
    holder.session = await openSession({
      agent: current.agent,
      model: current.model,
      effort: current.effort,
      sessionName,
      cwd: workspace.root,
    });
    try {
      return await holder.session.prompt({
        promptFile: editPromptFile,
        approveAll: true,
        timeoutSeconds,
        promptRetries: config.promptRetries,
      });
    } catch (err) {
      await holder.session.close();
      holder.session = null;
      throw err;
    }
  });
  usage.push(usageRecord(ranWith, editResult));
  for (const note of editResult.notes || []) noteOnce(note);

  let serial = 1;
  const freshSession = () =>
    openSession({
      agent: chosen.agent,
      model: chosen.model,
      effort: chosen.effort,
      sessionName: `${sessionName}-r${(serial += 1)}`,
      cwd: workspace.root,
    });

  try {
    return await annotateLoop({
      holder,
      freshSession,
      workspace,
      fingerprint,
      repo,
      context,
      common,
      promptDir,
      timeoutSeconds,
      promptRetries: config.promptRetries,
      usage,
      notes,
      noteOnce,
      overflow,
      progress,
      renderPreface: () => prefaceFor({ memoryFile, summary, config, repo, workspaceRoot: workspace.root }),
    });
  } finally {
    await holder.session.close();
  }
}
