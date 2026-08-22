import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { readMemoryFile } from "../../src/memory.js";
import { State } from "../../src/state.js";
import { measureWorkspace, prepareWorkspace } from "../../src/workspace.js";

/**
 * Test-side stand-in for the synthesis harness: stage the memory file exactly as
 * `synthesizeProposal` does, change the staging copy with plain file writes (which is
 * all a harness's own edit/write tools amount to), and measure the result. Tests then
 * annotate the measured changes the way the model does.
 */

export function makeRepo(files = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "backpass-stage-")));
  for (const [name, text] of Object.entries(files)) {
    const absolute = path.join(dir, name);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, text);
  }
  return { root: dir, realRoot: dir, name: path.basename(dir), worktrees: [dir], remotes: [] };
}

/** Write a file inside a directory tree, creating parents; `fn` maps the current text. */
export function writeIn(root, relative, textOrFn) {
  const absolute = path.join(root, relative);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  const current = fs.existsSync(absolute) ? fs.readFileSync(absolute, "utf8") : "";
  fs.writeFileSync(absolute, typeof textOrFn === "function" ? textOrFn(current) : textOrFn);
}

/**
 * @param {{ repo: any, memoryPath?: string, skillsDir?: string, edit: (workspaceRoot: string) => void }} options
 */
export function stageAndMeasure({ repo, memoryPath = "AGENTS.md", skillsDir = ".agents/skills", edit }) {
  const memoryFile = readMemoryFile(repo.root, memoryPath);
  const state = new State(repo.root).ensure();
  const workspace = prepareWorkspace({ state, repo, memoryFile, skillsDir });
  edit(workspace.root);
  return { memoryFile, state, workspace, measured: measureWorkspace(workspace) };
}
