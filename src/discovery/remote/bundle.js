import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export { createFrameReader, encodeEndFrame, encodeFrameHeader, PROTOCOL } from "./frames.js";

/**
 * The stdin program that carries backpass's adapters to a remote host.
 *
 * Nothing is installed over there and nothing persists: the program is one loader plus
 * a base64 payload holding the probe's source files and this run's request. The loader
 * writes the files into a fresh temp directory, imports `probe.js` from it, runs the
 * request, and removes the directory in `finally`. Because every variable - store
 * paths, harness list, cutoff, env overrides - travels inside the payload, the only
 * thing the remote shell ever sees is a constant command, so quoting cannot bite.
 *
 * `PROBE_MANIFEST` is the closed set of files that ship. It is a manifest rather than a
 * bundler because the adapters already are the contract: a stray import would silently
 * break a host, so `test/remote-bundle.test.js` runs the probe from a directory holding
 * only these files. Paths are relative to `src/` and keep their layout, so the modules'
 * own relative imports resolve unchanged over there.
 */
export const PROBE_MANIFEST = [
  "sentinel.js",
  "interaction.js",
  "discovery/self.js",
  "discovery/adapters/shared.js",
  "discovery/adapters/sqlite.js",
  "discovery/adapters/claude.js",
  "discovery/adapters/codex.js",
  "discovery/adapters/pi.js",
  "discovery/adapters/grok.js",
  "discovery/adapters/opencode.js",
  "discovery/adapters/hermes.js",
  "discovery/adapters/cursor-cli.js",
  "discovery/adapters/cursor-ide.js",
  "discovery/remote/frames.js",
  "discovery/remote/git-facts.js",
  "discovery/remote/runtime.js",
  "discovery/remote/probe.js",
];

export const PROBE_ENTRY = "discovery/remote/probe.js";

/**
 * Store-relocation variables the probe may be given. A non-interactive ssh session does
 * not load the user's shell profile, so a relocated store is unreachable without them;
 * the list is closed so a host entry can never set arbitrary environment on the remote.
 */
export const REMOTE_ENV_ALLOWLIST = [
  "CLAUDE_CONFIG_DIR",
  "CODEX_HOME",
  "HERMES_HOME",
  "PI_CODING_AGENT_DIR",
  "PI_CODING_AGENT_SESSION_DIR",
  "BB_DATA_DIR",
  "BB_PI_BRIDGE_SESSION_DIR",
];

const SRC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** @returns {Record<string, string>} manifest path -> source text */
export function probeSources(root = SRC_DIR) {
  /** @type {Record<string, string>} */
  const files = {};
  for (const rel of PROBE_MANIFEST) files[rel] = fs.readFileSync(path.join(root, rel), "utf8");
  return files;
}

/**
 * The loader. Written without a single quote, a backslash, or a `!` so that it stays
 * embeddable in any shell quoting a future transport might need - the same posture the
 * remote command constants keep. It is the owned half of the wire contract, so
 * `test/remote-bundle.test.js` asserts that property on the generated program.
 */
function loader(payloadBase64) {
  return [
    "(async () => {",
    '  const fs = await import("node:fs");',
    '  const os = await import("node:os");',
    '  const path = await import("node:path");',
    '  const url = await import("node:url");',
    "  const nl = String.fromCharCode(10);",
    "  let dir = null;",
    "  try {",
    `    const payload = JSON.parse(Buffer.from("${payloadBase64}", "base64").toString("utf8"));`,
    "    for (const key of Object.keys(payload.env || {})) {",
    "      const value = payload.env[key];",
    '      process.env[key] = value.slice(0, 2) === "~/" ? path.join(os.homedir(), value.slice(2)) : value;',
    "    }",
    '    dir = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-probe-"));',
    '    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ type: "module" }));',
    "    for (const rel of Object.keys(payload.files)) {",
    "      const file = path.join(dir, rel);",
    "      fs.mkdirSync(path.dirname(file), { recursive: true });",
    "      fs.writeFileSync(file, payload.files[rel]);",
    "    }",
    "    const entry = url.pathToFileURL(path.join(dir, payload.entry)).href;",
    "    const mod = await import(entry);",
    "    await mod.main(payload.request);",
    "  } catch (err) {",
    '    process.stderr.write("backpass-probe-error: " + String((err && err.stack) || err) + nl);',
    "    process.exitCode = 1;",
    "  } finally {",
    "    if (dir) {",
    "      try {",
    "        fs.rmSync(dir, { recursive: true, force: true });",
    "      } catch {",
    '        process.stderr.write("backpass-probe-warning: temp dir not removed" + nl);',
    "      }",
    "    }",
    "  }",
    "})();",
    "",
  ].join("\n");
}

/**
 * @param {object} request the probe request (`op: "discover" | "fetch"`)
 * @param {{ env?: Record<string, string>, root?: string }} [options]
 * @returns {string} the program to pipe into `node -` on the remote
 */
export function buildProbeProgram(request, { env = {}, root = SRC_DIR } = {}) {
  const payload = {
    entry: PROBE_ENTRY,
    files: probeSources(root),
    env: filterEnv(env),
    request,
  };
  return loader(Buffer.from(JSON.stringify(payload), "utf8").toString("base64"));
}

function filterEnv(env) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const key of REMOTE_ENV_ALLOWLIST) {
    const value = env?.[key];
    if (typeof value === "string" && value) out[key] = value;
  }
  return out;
}
