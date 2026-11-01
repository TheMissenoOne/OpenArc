#!/usr/bin/env node
// node compare.mjs <out.md> <results dir> [more dirs...]
// Arms are keyed config@openarcVersion (so 0.8.0 A and 0.9.1 A stay apart; baseline rows carry the run's version too).
// Per arm: means per task and 95% bootstrap CIs over exercises (each exercise's value is its mean over seeds), and
// paired differences for the pairs in PAIRS, with the same resamples for every statistic (summarize.mjs's PRNG).
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [out, ...dirs] = process.argv.slice(2);
const recs = dirs.flatMap((d) => readFileSync(join(d, "tasks.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))).filter((r) => !r.aborted);
const key = (r) => `${r.config}@${r.openarcVersion}`;
const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const mean = (xs) => (xs.length ? sum(xs) / xs.length : NaN);
const exercises = [...new Set(recs.map((r) => r.exercise))].sort();
const byArm = Map.groupBy(recs, key);

let state = 1;
const rand = () => { state |= 0; state = (state + 0x6d2b79f5) | 0; let t = Math.imul(state ^ (state >>> 15), 1 | state); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const B = 10000;
function boot(stat) {
  state = 1;
  const n = exercises.length, all = Array.from({ length: n }, (_, i) => i), xs = [];
  for (let b = 0; b < B; b++) xs.push(stat(all.map(() => Math.floor(rand() * n))));
  xs.sort((a, b) => a - b);
  return [stat(all), xs[Math.floor(0.025 * B)], xs[Math.floor(0.975 * B)]];
}

// metrics: per-exercise vector (mean over seeds) and how to aggregate a resample of exercise indices
const perEx = (rs, fn) => exercises.map((ex) => mean(rs.filter((r) => r.exercise === ex).map(fn)));
const held = (r) => r.heldOut ?? { passed: 0, total: 0, allPass: false };
const M = {
  "tokens/task": { fn: (r) => r.promptTokens + r.evalTokens, f: (x) => x.toFixed(0) },
  "prompt tok/task": { fn: (r) => r.promptTokens, f: (x) => x.toFixed(0) },
  "s/task": { fn: (r) => r.wallMs / 1000, f: (x) => x.toFixed(1) },
  "calls/task": { fn: (r) => r.modelCalls, f: (x) => x.toFixed(2) },
  "exercise pass (raw)": { rate: true, fn: (r) => (held(r).allPass ? 1 : 0), f: (x) => `${(100 * x).toFixed(0)}%` },
  "accepted-and-correct": { rate: true, fn: (r) => (held(r).allPass && r.publicPass ? 1 : 0), f: (x) => `${(100 * x).toFixed(0)}%` },
  "held-out (raw)": { fn: (r) => held(r).passed, pooled: true },
  "held-out (accepted)": { fn: (r) => (r.publicPass ? held(r).passed : 0), pooled: true },
};
const totals = exercises.map((ex) => recs.find((r) => r.exercise === ex && r.heldOut)?.heldOut.total ?? 0);
const stat = (vec, m) => (m.pooled ? (idx) => sum(idx.map((i) => vec[i])) / sum(idx.map((i) => totals[i])) : (idx) => mean(idx.map((i) => vec[i])));
const fmt = (m) => m.f ?? ((x) => `${(100 * x).toFixed(0)}%`);
const ci = ([p, lo, hi], f) => `${f(p)} [${f(lo)}, ${f(hi)}]`;

const arms = [...byArm.keys()].sort();
let md = `Tasks: ${recs.length} (${dirs.join(", ")}). Arms are config@open-arc version; baseline arms (D, D-resample) don't use OpenArc, the version only tells the run apart. 95% bootstrap CIs over the ${exercises.length} exercises (${B} resamples, each exercise's value is its mean over seeds; held-out rates pooled over tests).\n\n`;
md += `| arm | n | ${Object.keys(M).join(" | ")} |\n|---|---|${Object.keys(M).map(() => "---").join("|")}|\n`;
for (const k of arms) {
  const rs = byArm.get(k);
  md += `| ${k} | ${rs.length} | ${Object.values(M).map((m) => ci(boot(stat(perEx(rs, m.fn), m)), fmt(m))).join(" | ")} |\n`;
}

const PAIRS = [["A@0.9.2", "A@0.9.1"], ["A@0.9.2", "D@0.9.2"], ["A@0.9.2", "D@0.9.1"], ["E-resample@0.9.2", "E-resample@0.9.1"], ["E-resample@0.9.2", "D@0.9.2"], ["D@0.9.2", "D@0.9.1"], ["A@0.9.1", "A@0.8.0"], ["A@0.9.1", "D@0.9.1"], ["A@0.9.1", "D@0.8.0"], ["E-resample@0.9.1", "E-resample@0.8.0"], ["E-resample@0.9.1", "D-resample@0.9.1"], ["A@0.8.0", "D@0.8.0"], ["D@0.9.1", "D@0.8.0"]];
const sign = (f) => (x) => `${x >= 0 ? "+" : ""}${f(x)}`;
md += `\n## Paired differences (first arm minus second; 95% bootstrap CI over exercises)\n\n| pair | ${Object.keys(M).join(" | ")} |\n|---|${Object.keys(M).map(() => "---").join("|")}|\n`;
for (const [a, b] of PAIRS) {
  if (!byArm.has(a) || !byArm.has(b)) continue;
  md += `| ${a} - ${b} | ${Object.values(M).map((m) => {
    const va = perEx(byArm.get(a), m.fn), vb = perEx(byArm.get(b), m.fn);
    const d = m.pooled ? (idx) => (sum(idx.map((i) => va[i] - vb[i])) / sum(idx.map((i) => totals[i]))) : (idx) => mean(idx.map((i) => va[i] - vb[i]));
    return ci(boot(d), sign(m.f && !m.rate ? m.f : (x) => `${(100 * x).toFixed(1)} pp`));
  }).join(" | ")} |\n`;
}

// cost per accepted-and-correct task with CIs: a ratio of sums over the resampled exercises (seed means), and its
// paired difference with the same resamples; resamples with no accepted-and-correct exercise (in either arm) are dropped
const ratio = (num, den) => (idx) => { const d = sum(idx.map((i) => den[i])); return d ? sum(idx.map((i) => num[i])) / d : NaN; };
function bootFinite(f) {
  state = 1;
  const n = exercises.length, all = Array.from({ length: n }, (_, i) => i), xs = [];
  for (let b = 0; b < B; b++) xs.push(f(all.map(() => Math.floor(rand() * n))));
  const ok = xs.filter(Number.isFinite).sort((a, b) => a - b);
  return [f(all), ok[Math.floor(0.025 * ok.length)], ok[Math.floor(0.975 * ok.length)]];
}
const COST = { "tokens per accepted-and-correct task": (r) => r.promptTokens + r.evalTokens, "s per accepted-and-correct task": (r) => r.wallMs / 1000 };
const fx = (x) => x.toFixed(Math.abs(x) >= 100 ? 0 : 1);
md += `\n## Cost per accepted-and-correct task (95% bootstrap CI over exercises; ratio of sums; resamples without an accepted-and-correct exercise dropped)\n\n| arm or pair | ${Object.keys(COST).join(" | ")} |\n|---|${Object.keys(COST).map(() => "---").join("|")}|\n`;
const accVec = (k) => perEx(byArm.get(k), M["accepted-and-correct"].fn);
for (const k of arms) md += `| ${k} | ${Object.values(COST).map((fn) => ci(bootFinite(ratio(perEx(byArm.get(k), fn), accVec(k))), fx)).join(" | ")} |\n`;
for (const [a, b] of PAIRS) {
  if (!byArm.has(a) || !byArm.has(b)) continue;
  md += `| ${a} - ${b} | ${Object.values(COST).map((fn) => { const ra = ratio(perEx(byArm.get(a), fn), accVec(a)), rb = ratio(perEx(byArm.get(b), fn), accVec(b)); return ci(bootFinite((idx) => ra(idx) - rb(idx)), (x) => `${x >= 0 ? "+" : ""}${fx(x)}`); }).join(" | ")} |\n`;
}

// efficiency per accepted-and-correct exercise, and OpenArc attempt diagnostics
md += `\n## Cost per accepted-and-correct exercise, and attempt diagnostics\n\n| arm | accepted-and-correct tasks | tokens per accepted-and-correct task | s per accepted-and-correct task | attempts | repeats not re-verified | whole-function TS2322 (void) | compile-fail / attempt |\n|---|---|---|---|---|---|---|---|\n`;
for (const k of arms) {
  const rs = byArm.get(k);
  const acc = rs.filter((r) => held(r).allPass && r.publicPass).length;
  const fa = rs.flatMap((r) => (r.regions ?? []).flatMap((g) => g.failedAttempts ?? []));
  const att = sum(rs.map((r) => r.attempts ?? 0));
  const rep = fa.filter((a) => a.problems.some((p) => /^repeat of an earlier attempt/.test(p))).length;
  const voidFn = fa.filter((a) => a.problems.some((p) => /TS2322.*=> void/.test(p))).length;
  const comp = fa.filter((a) => a.problems.some((p) => /OARC-E070|OARC-E097|output was not valid/.test(p))).length + rs.flatMap((r) => r.tries ?? []).filter((t) => !t.publicPassed && t.feedback?.startsWith("The file did not load")).length;
  const tok = sum(rs.map((r) => r.promptTokens + r.evalTokens)), s = sum(rs.map((r) => r.wallMs / 1000));
  md += `| ${k} | ${acc}/${rs.length} | ${acc ? (tok / acc).toFixed(0) : "-"} | ${acc ? (s / acc).toFixed(1) : "-"} | ${att} | ${rep} | ${voidFn} | ${att ? `${((100 * comp) / att).toFixed(0)}%` : "-"} |\n`;
}
md += `\n## Per exercise (mean over seeds): accepted-and-correct / tokens / calls\n\n| exercise | ${arms.join(" | ")} |\n|---|${arms.map(() => "---").join("|")}|\n`;
for (const ex of exercises) md += `| ${ex} | ${arms.map((k) => { const xs = byArm.get(k).filter((r) => r.exercise === ex); return `${sum(xs.map(M["accepted-and-correct"].fn))}/${xs.length} · ${mean(xs.map(M["tokens/task"].fn)).toFixed(0)} · ${mean(xs.map((r) => r.modelCalls)).toFixed(1)}`; }).join(" | ")} |\n`;
writeFileSync(out, md);
console.log(md);
