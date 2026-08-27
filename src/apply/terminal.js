import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";

import { UserError, color } from "../logger.js";
import { editSkills } from "../skills.js";
import { formatTokens } from "../tokens.js";

/**
 * The `--no-ui` fallback: the same ACCEPT/REJECT decision, one edit at a time, for
 * machines with no browser (or reviewers who would rather stay in the terminal).
 */

/** Measured edits carry display lines per hunk; a legacy edit shows its find/replace. */
export function diffLinesOf(edit) {
  if (Array.isArray(edit.hunks)) {
    return edit.hunks.flatMap((hunk, i) => [...(i > 0 ? [{ type: "gap", text: "" }] : []), ...(hunk.lines || [])]);
  }
  return [
    ...(edit.find || "")
      .split("\n")
      .filter(Boolean)
      .map((text) => ({ type: "del", text })),
    ...(edit.replace || "")
      .split("\n")
      .filter(Boolean)
      .map((text) => ({ type: "ins", text })),
  ];
}

function renderDiff(edit) {
  const lines = [];
  for (const line of diffLinesOf(edit)) {
    if (line.type === "del") lines.push(color.red(`  - ${line.text}`));
    else if (line.type === "ins") lines.push(color.green(`  + ${line.text}`));
    else if (line.type === "gap") lines.push(color.dim("  ..."));
    else lines.push(color.dim(`    ${line.text}`));
  }
  return lines.join("\n");
}

export function renderEdit(edit, index, total) {
  const out = [];
  const kind = edit.kind === "extract" ? "EXTRACT -> SKILL" : edit.kind.toUpperCase();
  const delta = edit.deltaTokens || 0;
  const deltaText = `${delta > 0 ? "+" : ""}${formatTokens(delta)} tok${edit.targetsMemoryFile ? "" : " (not always-loaded)"}`;

  out.push("");
  out.push(`${color.bold(`[${index + 1}/${total}] ${kind}`)}  ${color.dim(deltaText)}`);
  out.push(`  ${edit.title}`);
  out.push(`  ${color.dim(`file: ${edit.file}`)}`);
  if (edit.rationale) out.push(`  ${color.dim(edit.rationale)}`);
  out.push("");
  out.push(renderDiff(edit));

  for (const skill of edit.kind === "extract" ? editSkills(edit) : []) {
    out.push("");
    out.push(color.dim(`  new skill: ${skill.path}`));
    out.push(color.dim(`  description: ${skill.description}`));
  }

  if (edit.evidence?.length) {
    out.push("");
    out.push(color.dim(`  evidence (${edit.transcripts} transcript(s)):`));
    for (const quote of edit.evidence.slice(0, 4)) {
      const mark = quote.polarity === "positive" ? color.green("+") : color.red("-");
      out.push(`    ${mark} "${quote.text.replace(/\s+/g, " ").slice(0, 200)}"`);
      out.push(`      ${color.dim(quote.source)}`);
    }
  }

  return out.join("\n");
}

export async function reviewInTerminal(proposal) {
  if (!stdin.isTTY) {
    throw new UserError(
      "terminal review needs an interactive terminal (stdin is not a TTY)",
      "run `backpass apply` without --no-ui to review in the browser, or use --dry-run to see the proposal",
    );
  }

  const rl = readline.createInterface({ input: stdin, output: stdout });
  const decisions = {};
  // Ctrl-D at a prompt closes the interface; treat it as "quit", never as a hang.
  let closed = false;
  rl.on("close", () => {
    closed = true;
  });

  try {
    console.error(
      `\n${color.bold("backpass apply")} ${color.dim(
        `· ${proposal.repo.name} · ${proposal.memoryFile.path} · ${proposal.edits.length} proposed edit(s)`,
      )}`,
    );
    console.error(
      color.dim(
        `budget: ${formatTokens(proposal.budget.current)} -> ${formatTokens(proposal.budget.projected)} / ${formatTokens(
          proposal.budget.capTokens,
        )} tok if all accepted`,
      ),
    );

    for (const [index, edit] of proposal.edits.entries()) {
      console.error(renderEdit(edit, index, proposal.edits.length));
      let answer = "";
      while (!["a", "r", "q"].includes(answer)) {
        const reply = await rl.question(`\n  ${color.cyan("[a]ccept / [r]eject / [q]uit")} > `).catch(() => null);
        if (reply === null || closed) return null;
        answer = reply.trim().toLowerCase().slice(0, 1);
      }
      if (answer === "q") return null;
      decisions[edit.id] = answer === "a" ? "accepted" : "rejected";
    }

    return decisions;
  } finally {
    rl.close();
  }
}
