import fs from "node:fs";
import path from "node:path";

import { CONFIG_FILENAME, initialConfig, repoConfigPath } from "../config.js";
import { color, info, out, warn } from "../logger.js";
import { loadMemoryFiles } from "../memory.js";
import { ensureLocalExclude } from "../repo.js";
import { STATE_EXCLUDE_LINE as EXCLUDE_LINE } from "../state.js";
import { budgetBar, budgetStatus, formatTokens } from "../tokens.js";

export async function cmdInit({ repo, config, flags }) {
  const target = repoConfigPath(repo.root);
  const existing = fs.existsSync(target);

  const seed = initialConfig();
  // Seed memoryFiles with what this repo actually has, so the first run is correct.
  const present = config.memoryFiles.filter((f) => fs.existsSync(path.join(repo.root, f)));
  if (present.length) seed.memoryFiles = present;

  if (existing && !flags.force) {
    info(`${color.yellow("·")} ${CONFIG_FILENAME} already exists - leaving it alone (use --force to overwrite)`);
  } else {
    fs.writeFileSync(target, `${JSON.stringify(seed, null, 2)}\n`);
    info(`${color.green("·")} wrote ${CONFIG_FILENAME}`);
  }

  const exclude = ensureLocalExclude(repo.root, EXCLUDE_LINE);
  if (exclude.status === "added") {
    info(`${color.green("·")} added ${EXCLUDE_LINE} to .git/info/exclude (local, never committed)`);
  } else if (exclude.status === "no-git") {
    info(`${color.yellow("·")} no git dir found - skipped excluding ${EXCLUDE_LINE}`);
  }

  const gitignore = path.join(repo.root, ".gitignore");
  const gitignoreLines = fs.existsSync(gitignore) ? fs.readFileSync(gitignore, "utf8").split("\n") : [];
  if (gitignoreLines.some((l) => l.trim() === EXCLUDE_LINE)) {
    warn(`.gitignore already lists ${EXCLUDE_LINE} from an older backpass - remove it any time, it's redundant now`);
  }

  const files = loadMemoryFiles(repo.root, seed.memoryFiles);
  out("");
  if (!files.length) {
    out(
      `No memory file found yet. \`backpass\` will bootstrap ${seed.memoryFiles[0]} (+ a CLAUDE.md pointer) from your transcripts and defaults.`,
    );
    return 0;
  }
  for (const file of files) {
    const status = budgetStatus(file.text, null, seed.budgetTokens);
    out(
      `${file.path.padEnd(14)} ${budgetBar(status)} ${formatTokens(status.current)} / ${formatTokens(
        status.capTokens,
      )} tok · ${file.units.length} instructions`,
    );
  }
  out("");
  out("Next: `backpass` to run a backward pass, or `backpass scan` to see what it would read.");
  return 0;
}
