#!/usr/bin/env node
// node summarize.mjs results/<dir> [more dirs...]  -> writes <first dir>/tables.md, prints it
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dirs = process.argv.slice(2);
const recs = dirs.flatMap((d) => readFileSync(join(d, "tasks.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))).filter((r) => !r.aborted);
// rows without `backend` predate the backend block: they ran on stock Ollama 0.40.5 (untuned)
const label = (r) => r.backend?.info?.label ?? "untuned-ollama";
const key = (r) => `${label(r)}|${r.model}|${r.config}`;
const groups = Map.groupBy(recs, key);
const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const mean = (xs) => (xs.length ? sum(xs) / xs.length : NaN);
const f1 = (x) => (Number.isFinite(x) ? x.toFixed(1) : "-");
const pct = (a, b) => (b ? `${((100 * a) / b).toFixed(0)}% (${a}/${b})` : "-");

let md = `Tasks: ${recs.length} from ${dirs.join(", ")}. OpenArc ${[...new Set(recs.map((r) => r.openarcVersion))].join(", ")}. Backends: ${[...new Set(recs.map(label))].join(", ")}.\n\n`;
md += "| backend | model | config | n | held-out tests passed | exercise pass@1 (all held-out pass) | D gated pass@1 | public examples all pass | mean model calls | mean prompt tok | mean output tok | mean wall s | mean wall s excl. load | peak runner RSS MB | successes per 1M tok | held-out tests per 1M tok | mean context chars/attempt |\n";
md += "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|\n";
for (const [k, rs] of [...groups].sort()) {
  const [bk, model, config] = k.split("|");
  const ok = rs.filter((r) => r.heldOut);
  const hp = sum(ok.map((r) => r.heldOut.passed)), ht = sum(ok.map((r) => r.heldOut.total));
  const allPass = ok.filter((r) => r.heldOut.allPass).length;
  const gated = ok.filter((r) => r.heldOut.allPass && r.publicPass).length;
  const tok = sum(rs.map((r) => r.promptTokens + r.evalTokens));
  const ctx = rs.flatMap((r) => (r.regions ?? []).flatMap((g) => g.contextChars));
  md += `| ${bk} | ${model} | ${config} | ${rs.length} | ${pct(hp, ht)} | ${pct(allPass, rs.length)} | ${config === "D" ? pct(gated, rs.length) : "same"} | ${pct(rs.filter((r) => r.publicPass).length, rs.length)} | ${f1(mean(rs.map((r) => r.modelCalls)))} | ${f1(mean(rs.map((r) => r.promptTokens)))} | ${f1(mean(rs.map((r) => r.evalTokens)))} | ${f1(mean(rs.map((r) => r.wallMs / 1000)))} | ${f1(mean(rs.map((r) => (r.wallMs - (r.modelLoadMs ?? 0)) / 1000)))} | ${Math.round(Math.max(...rs.map((r) => r.peakRunnerRssKb)) / 1024)} | ${f1(allPass / (tok / 1e6))} | ${f1(hp / (tok / 1e6))} | ${ctx.length ? f1(mean(ctx)) : "-"} |\n`;
}

md += "\n## Per exercise: held-out tests passed (calls, tokens)\n\n";
const cols = [...groups.keys()].sort();
md += `| exercise | ${cols.join(" | ")} |\n|---|${cols.map(() => "---").join("|")}|\n`;
for (const ex of [...new Set(recs.map((r) => r.exercise))]) {
  md += `| ${ex} | ${cols.map((c) => {
    const r = groups.get(c).find((x) => x.exercise === ex);
    if (!r) return "";
    if (!r.heldOut) return `error`;
    return `${r.heldOut.passed}/${r.heldOut.total}${r.publicPass ? "" : " (pub fail)"} (${r.modelCalls}, ${r.promptTokens + r.evalTokens})`;
  }).join(" | ")} |\n`;
}
writeFileSync(join(dirs[0], "tables.md"), md);
console.log(md);
