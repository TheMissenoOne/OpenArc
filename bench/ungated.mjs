#!/usr/bin/env node
// Counterfactual for ablation F: OpenArc "ungated", i.e. shipping its LAST attempt for every region it could not verify,
// the way the baseline ships its last file even when public examples fail. Splices each failed region's last attempt
// body (from <work>/tasks/.../.openarc/attempts) into the compiled file and runs the held-out tests on it.
// node ungated.mjs <results dir> <work dir> <ts-bench clone>  -> <results dir>/ungated.jsonl
import { readFileSync, readdirSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { heldOut, split } from "./lib/common.mjs";

const [res, work, dataset] = process.argv.slice(2);
const recs = readFileSync(join(res, "tasks.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.regions);
const oaModules = join(work, readdirSync(work).find((d) => d.startsWith("open-arc-")), "node_modules");
const rows = [];
for (const r of recs) {
  const dir = join(work, "tasks", r.model.replace(/[^\w.-]/g, "_"), `s${r.seed ?? 1}`, r.config, r.exercise);
  let src = r.finalSource;
  for (const g of r.regions.filter((g) => !g.ok)) {
    const ad = join(dir, ".openarc/attempts", g.id);
    if (!existsSync(ad)) continue;
    const last = JSON.parse(readFileSync(join(ad, readdirSync(ad).sort((a, b) => parseInt(a) - parseInt(b)).at(-1)), "utf8"));
    if (typeof last.body !== "string") continue; // unparseable output: nothing to ship
    const esc = g.id.replace(/\./g, "\\.");
    src = src.replace(new RegExp(`(export const \\w+: \\w+ = \\(([^)]*)\\)) => arc\\.todo\\("${esc}"\\);`), (_, head) => `${head} => {\n${last.body}\n};`);
  }
  const splitInfo = await split(dataset, r.exercise, work);
  const h = await heldOut(dataset, r.exercise, join(dir, "heldout-ungated"), src, splitInfo, { "open-arc": join(oaModules, "open-arc") });
  rows.push({ exercise: r.exercise, config: r.config, seed: r.seed, model: r.model, gated: r.heldOut.passed, ungated: h.passed, total: h.total, ungatedAllPass: h.allPass });
  console.log(r.config, r.seed, r.exercise, `${r.heldOut.passed} -> ${h.passed}/${h.total}`);
}
writeFileSync(join(res, "ungated.jsonl"), rows.map((x) => JSON.stringify(x)).join("\n") + "\n");
