import { discoverTranscripts } from "../discovery/index.js";
import { color, info, json, out } from "../logger.js";

/** Shared by every command that needs the transcript set. */
export async function discoverForRun(ctx) {
  const { repo, config, strict } = ctx;
  const result = await discoverTranscripts({ repo, config, strict });
  if (ctx.limit && result.transcripts.length > ctx.limit) {
    result.truncated = result.transcripts.length - ctx.limit;
    result.transcripts = result.transcripts.slice(0, ctx.limit);
  }
  return result;
}

function ago(ms) {
  if (!ms) return "-";
  const days = Math.floor((Date.now() - ms) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "1d ago";
  return `${days}d ago`;
}

export async function cmdScan(ctx) {
  const { transcripts, perHarness, truncated } = await discoverForRun(ctx);

  if (ctx.flags.json) {
    json({ repo: ctx.repo.name, perHarness, transcripts });
    return 0;
  }

  out(`${ctx.repo.name} · ${ctx.repo.worktrees.length} worktree(s) · since ${ctx.config.discovery.since}`);
  out("");

  const rows = [["HARNESS", "SCANNED", "MATCHED", "SELF", "CACHED", "NOTE"]];
  for (const [harness, stats] of Object.entries(perHarness)) {
    rows.push([
      harness,
      String(stats.scanned),
      String(stats.matched),
      String(stats.self || 0),
      String(stats.cached),
      stats.error ? `unreadable: ${stats.error}` : "",
    ]);
  }
  out(table(rows));
  const selfTotal = Object.values(perHarness).reduce((n, s) => n + (s.self || 0), 0);
  if (selfTotal) out(color.dim(`  SELF = backpass's own loss / gradient-descent sessions, excluded from the corpus`));
  out("");

  const byTier = { 1: 0, 2: 0, 3: 0 };
  for (const t of transcripts) byTier[t.association.tier] += 1;
  out(
    `${transcripts.length} transcript(s) associated with this repo · ` +
      `tier1 ${byTier[1]} (exact) · tier2 ${byTier[2]} (remote) · tier3 ${byTier[3]} (best-effort)`,
  );
  if (byTier[3] && !ctx.strict) out(color.dim("  re-run with --strict to exclude the best-effort tier"));
  if (truncated) out(color.dim(`  --limit ${ctx.limit} is hiding ${truncated} more transcript(s)`));
  out("");

  const preview = transcripts.slice(0, 25);
  const detail = [["HARNESS", "SESSION", "WHEN", "SIZE", "TIER", "HOW"]];
  for (const t of preview) {
    detail.push([
      t.harness,
      t.nativeId.slice(0, 12),
      ago(t.mtimeMs),
      t.bytes ? `${Math.round(t.bytes / 1024)}KB` : "-",
      `t${t.association.tier}`,
      t.association.reason,
    ]);
  }
  out(table(detail));
  if (transcripts.length > preview.length) {
    info(color.dim(`  ... and ${transcripts.length - preview.length} more`));
  }
  return 0;
}

export function table(rows) {
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => String(r[i] ?? "").length)));
  return rows
    .map((row, rowIndex) => {
      const line = row
        .map((cell, i) => String(cell ?? "").padEnd(widths[i]))
        .join("  ")
        .trimEnd();
      return rowIndex === 0 ? color.dim(line) : line;
    })
    .join("\n");
}
