#!/usr/bin/env node
// Summary of evolve-multi.jsonl, mean per seed for each arm. A "correct function-step" is one function passing all its
// held-out tests at one step; the headline is tokens and seconds per correct function-step (lower is better).
// node summarize-multi.mjs <results dir>   (writes summary-table.md there)
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2];
const rows = readFileSync(join(dir, "evolve-multi.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
const arms = [...new Set(rows.map((r) => r.config))];
const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const mean = (xs) => (xs.length ? sum(xs) / xs.length : NaN);
const f1 = (x) => (Number.isFinite(x) ? x.toFixed(1) : "-");
const f0 = (x) => (Number.isFinite(x) ? Math.round(x).toString() : "-");

const per = (r) => {
  const st = r.steps.filter((s) => s.heldOut);
  const tokens = sum(st.map((s) => s.prompt + s.eval));
  const wall = sum(st.map((s) => s.wallMs)) / 1000;
  const good = sum(st.map((s) => Object.values(s.heldOut).filter((h) => h.allPass).length));
  // strict: also passes its own public examples (rows before 2026-11-02 evening lack publicPass)
  const strict = st.every((s) => Object.values(s.heldOut).every((h) => h.publicPass !== undefined)) ? sum(st.map((s) => Object.values(s.heldOut).filter((h) => h.allPass && h.publicPass).length)) : NaN;
  const last = st.at(-1)?.heldOut ?? {};
  return {
    tokens, wall, calls: sum(st.map((s) => s.calls)), good, strict,
    first: st[0] ? st[0].prompt + st[0].eval : NaN, later: sum(st.slice(1).map((s) => s.prompt + s.eval)),
    finalOk: Object.values(last).filter((h) => h.allPass).length, finalN: Object.keys(last).length,
    heldPassed: sum(Object.values(last).map((h) => h.passed)), heldTotal: sum(Object.values(last).map((h) => h.total)),
    states: st.filter((s) => s.correct).length, regress: sum(st.map((s) => s.regressions?.length ?? 0)),
    handLost: st.some((s) => s.hand === false), errors: r.steps.some((s) => s.error),
  };
};
const lines = [
  "| Arm | Seeds | Tokens | Wall s | Calls | Initial step tokens | Later steps tokens | Correct function-steps | Strict (public too) | Tokens per correct fn-step | Seconds per correct fn-step | Final functions passing | Final held-out tests | Regressions | Hand edit |",
  "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|",
];
for (const c of arms) {
  const ps = rows.filter((r) => r.config === c).map(per);
  const m = (k) => mean(ps.map((p) => p[k]));
  lines.push(`| ${c} | ${ps.length} | ${f0(m("tokens"))} | ${f1(m("wall"))} | ${f1(m("calls"))} | ${f0(m("first"))} | ${f0(m("later"))} | ${f1(m("good"))} | ${f1(m("strict"))} | ${f0(m("tokens") / m("good"))} | ${f1(m("wall") / m("good"))} | ${f1(m("finalOk"))}/${f0(m("finalN"))} | ${f1(m("heldPassed"))}/${f0(m("heldTotal"))} | ${f1(m("regress"))} | ${ps.some((p) => p.handLost) ? "LOST" : "kept"}${ps.some((p) => p.errors) ? " (errors)" : ""} |`);
}
const perSeed = ["", "Per seed: tokens / wall s / correct function-steps", "", `| Arm | ${[...new Set(rows.map((r) => r.seed))].map((s) => `s${s}`).join(" | ")} |`, `|---|${[...new Set(rows.map((r) => r.seed))].map(() => "---").join("|")}|`];
for (const c of arms) perSeed.push(`| ${c} | ${[...new Set(rows.map((r) => r.seed))].map((s) => { const r = rows.find((x) => x.config === c && x.seed === s); if (!r) return "-"; const p = per(r); return `${p.tokens} / ${f1(p.wall)} / ${p.good}`; }).join(" | ")} |`);
// ---- function-level bootstrap: resample the functions with replacement; a function's score is its correct steps, mean
// over seeds. Same resamples for every arm (seeded), so the paired differences line up. ponytail: copied from summarize.mjs.
let state = 1;
const rand = () => { state |= 0; state = (state + 0x6d2b79f5) | 0; let t = Math.imul(state ^ (state >>> 15), 1 | state); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const B = 10000;
function boot(n, stat) {
  state = 1;
  const all = Array.from({ length: n }, (_, i) => i);
  const xs = [];
  for (let b = 0; b < B; b++) xs.push(stat(all.map(() => Math.floor(rand() * n))));
  xs.sort((a, b) => a - b);
  return [stat(all), xs[Math.floor(0.025 * B)], xs[Math.floor(0.975 * B)]];
}
const fns = [...new Set(rows.flatMap((r) => r.steps.flatMap((s) => Object.keys(s.heldOut ?? {}))))].sort();
/** arm -> per-function correct steps (mean over seeds); strict also needs the function's own public examples */
const perFn = (c, strict) => fns.map((f) => mean(rows.filter((r) => r.config === c).map((r) => r.steps.filter((s) => s.heldOut?.[f]?.allPass && (!strict || s.heldOut[f].publicPass)).length)));
const ciTxt = ([p, lo, hi]) => `${f1(p)} [${f1(lo)}, ${f1(hi)}]`;
const hasStrict = rows.every((r) => r.steps.every((s) => Object.values(s.heldOut ?? {}).every((h) => h.publicPass !== undefined)));
const cis = ["", `Correct function-steps with 95% bootstrap CIs (${B} resamples of the ${fns.length} functions)${hasStrict ? "" : "; strict needs rows with publicPass"}`, "", "| Arm | Correct | Strict | Correct diff vs A | Strict diff vs A |", "|---|---|---|---|---|"];
const ref = arms.includes("A") ? "A" : arms[0];
for (const c of arms) {
  const g = perFn(c, false), st = perFn(c, true), g0 = perFn(ref, false), st0 = perFn(ref, true);
  const tot = (v) => (idx) => sum(idx.map((i) => v[i]));
  const diff = (v, w) => (idx) => sum(idx.map((i) => v[i] - w[i]));
  cis.push(`| ${c} | ${ciTxt(boot(fns.length, tot(g)))} | ${hasStrict ? ciTxt(boot(fns.length, tot(st))) : "-"} | ${c === ref ? "-" : ciTxt(boot(fns.length, diff(g, g0)))} | ${c === ref || !hasStrict ? "-" : ciTxt(boot(fns.length, diff(st, st0)))} |`);
}
const out = [...lines, ...perSeed, ...cis].join("\n") + "\n";
writeFileSync(join(dir, "summary-table.md"), out);
console.log(out);
