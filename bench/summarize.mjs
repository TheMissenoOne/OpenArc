#!/usr/bin/env node
// node summarize.mjs results/<dir> [more dirs...]  -> writes <first dir>/tables.md, prints it
// Every arm gets both gates (F): RAW (held-out tests on whatever the arm shipped) and ACCEPTED-AND-CORRECT (counted only
// when the arm's own acceptance gate passed: OpenArc every region verified, baseline every public example passing).
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dirs = process.argv.slice(2);
const recs = dirs.flatMap((d) => readFileSync(join(d, "tasks.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))).filter((r) => !r.aborted);
// rows without `backend` predate the backend block: they ran on stock Ollama 0.40.5 (untuned); rows without `seed` used seed 1
const label = (r) => r.backend?.info?.label ?? "untuned-ollama";
const seedOf = (r) => r.seed ?? 1;
const armKey = (r) => `${label(r)}|${r.model}|${r.config}`;
const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const mean = (xs) => (xs.length ? sum(xs) / xs.length : NaN);
const f1 = (x) => (Number.isFinite(x) ? x.toFixed(1) : "-");
const p0 = (x) => (Number.isFinite(x) ? `${(100 * x).toFixed(0)}%` : "-");
const pct = (a, b) => (b ? `${((100 * a) / b).toFixed(0)}% (${a}/${b})` : "-");

const ok = (r) => !!r.heldOut;
const rawEx = (r) => (ok(r) && r.heldOut.allPass ? 1 : 0);
const accEx = (r) => (ok(r) && r.heldOut.allPass && r.publicPass ? 1 : 0);
const failCounts = (r) => r.failCounts ?? {
  // rows written before failCounts existed: derive from what they recorded
  compile: (r.regions ?? []).flatMap((g) => g.failedAttempts).filter((a) => a.problems.some((p) => /OARC-E070|OARC-E097|output was not valid/.test(p))).length + (r.tries ?? []).filter((t) => !t.publicPassed && t.feedback?.startsWith("The file did not load")).length,
  public: (r.regions ?? []).flatMap((g) => g.failedAttempts).filter((a) => a.problems.every((p) => /OARC-E09[01]/.test(p))).length + (r.tries ?? []).filter((t) => t.feedback && !t.feedback.startsWith("The file did not load")).length,
  constraint: 0,
};

// ---- per arm x seed
const bySeed = Map.groupBy(recs, (r) => `${armKey(r)}|${seedOf(r)}`);
let md = `Tasks: ${recs.length} from ${dirs.join(", ")}. OpenArc ${[...new Set(recs.map((r) => r.openarcVersion))].join(", ")}. Backends: ${[...new Set(recs.map(label))].join(", ")}.\n\n`;
md += "Raw = held-out tests on whatever the arm shipped. Accepted-and-correct = counted only when the arm's own gate passed (OpenArc: every region verified on the public examples; baseline: every public example passes). Fail rates are per model attempt: compile = type/syntax error or unparseable output (baseline: the file did not load; it is not type-checked), public = a public example failed, constraint = an OpenArc static rule (imports, forbidden names, effects, calls, sketch containment).\n\n";
md += "## Per arm and seed\n\n";
md += "| backend | model | config | seed | n | held-out tests (raw) | exercise pass (raw) | accepted-and-correct exercises | accepted held-out tests | public gate passed | attempts | compile-fail / attempt | public-fail / attempt | constraint violations | mean calls | mean prompt tok | mean output tok | mean wall s |\n";
md += "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|\n";
for (const [k, rs] of [...bySeed].sort()) {
  const [bk, model, config, seed] = k.split("|");
  const v = rs.filter(ok);
  const hp = sum(v.map((r) => r.heldOut.passed)), ht = sum(v.map((r) => r.heldOut.total));
  const accHp = sum(v.filter((r) => r.publicPass).map((r) => r.heldOut.passed));
  const att = sum(rs.map((r) => r.attempts ?? 0));
  const fc = rs.map(failCounts);
  md += `| ${bk} | ${model} | ${config} | ${seed} | ${rs.length} | ${pct(hp, ht)} | ${pct(sum(rs.map(rawEx)), rs.length)} | ${pct(sum(rs.map(accEx)), rs.length)} | ${pct(accHp, ht)} | ${pct(rs.filter((r) => r.publicPass).length, rs.length)} | ${att} | ${p0(sum(fc.map((c) => c.compile)) / att)} | ${p0(sum(fc.map((c) => c.public)) / att)} | ${sum(fc.map((c) => c.constraint))} | ${f1(mean(rs.map((r) => r.modelCalls)))} | ${f1(mean(rs.map((r) => r.promptTokens)))} | ${f1(mean(rs.map((r) => r.evalTokens)))} | ${f1(mean(rs.map((r) => r.wallMs / 1000)))} |\n`;
}

// ---- mean over seeds, task-level bootstrap (resample exercises with replacement; each exercise's score is its mean over seeds)
let state = 1;
const rand = () => { state |= 0; state = (state + 0x6d2b79f5) | 0; let t = Math.imul(state ^ (state >>> 15), 1 | state); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const B = 10000;
/** per-exercise vectors -> [point, lo, hi]; stat(idx) computes the statistic on a resample of exercise indices */
function boot(n, stat) {
  state = 1; // same resamples for every arm, so paired comparisons line up
  const all = Array.from({ length: n }, (_, i) => i);
  const xs = [];
  for (let b = 0; b < B; b++) xs.push(stat(all.map(() => Math.floor(rand() * n))));
  xs.sort((a, b) => a - b);
  return [stat(all), xs[Math.floor(0.025 * B)], xs[Math.floor(0.975 * B)]];
}
const ci = ([p, lo, hi], f = p0) => `${f(p)} [${f(lo)}, ${f(hi)}]`;
const byArm = Map.groupBy(recs, armKey);
const exercises = [...new Set(recs.map((r) => r.exercise))];
/** exercise -> mean over seeds of fn(record), for one arm */
const perEx = (rs, fn) => exercises.map((ex) => { const xs = rs.filter((r) => r.exercise === ex); return xs.length ? mean(xs.map(fn)) : NaN; });
const heldRate = (rs) => exercises.map((ex) => { const xs = rs.filter((r) => r.exercise === ex && ok(r)); return [mean(xs.map((r) => r.heldOut.passed)), mean(xs.map((r) => r.heldOut.total))]; });

md += `\n## Mean over seeds, with 95% task-level bootstrap CIs (${B} resamples of the ${exercises.length} exercises)\n\n`;
md += "| backend | model | config | seeds | exercise pass (raw) | accepted-and-correct | held-out tests (raw, pooled) | held-out tests (accepted) | mean tokens/task | mean wall s/task |\n|---|---|---|---|---|---|---|---|---|---|\n";
const arms = [...byArm.keys()].sort();
for (const k of arms) {
  const rs = byArm.get(k);
  const [bk, model, config] = k.split("|");
  const raw = perEx(rs, rawEx), acc = perEx(rs, accEx);
  const hr = heldRate(rs), hra = exercises.map((ex) => { const xs = rs.filter((r) => r.exercise === ex && ok(r)); return mean(xs.map((r) => (r.publicPass ? r.heldOut.passed : 0))); });
  const pooled = (num) => (idx) => sum(idx.map((i) => num[i])) / sum(idx.map((i) => hr[i][1]));
  md += `| ${bk} | ${model} | ${config} | ${[...new Set(rs.map(seedOf))].sort().join(",")} | ${ci(boot(exercises.length, (idx) => mean(idx.map((i) => raw[i]))))} | ${ci(boot(exercises.length, (idx) => mean(idx.map((i) => acc[i]))))} | ${ci(boot(exercises.length, pooled(hr.map((x) => x[0]))))} | ${ci(boot(exercises.length, pooled(hra)))} | ${f1(mean(rs.map((r) => r.promptTokens + r.evalTokens)))} | ${f1(mean(rs.map((r) => r.wallMs / 1000)))} |\n`;
}

// ---- paired differences against the controls (A = OpenArc, D = baseline), same backend/model
for (const ref of ["A", "D"]) {
  const refs = arms.filter((k) => k.endsWith(`|${ref}`));
  if (!refs.length) continue;
  md += `\n## Paired difference vs ${ref} (exercise pass, percentage points; mean over seeds, 95% bootstrap CI over exercises)\n\n| backend | model | config | raw diff | accepted-and-correct diff |\n|---|---|---|---|---|\n`;
  for (const rk of refs) {
    const [bk, model] = rk.split("|");
    const R = byArm.get(rk);
    for (const k of arms.filter((x) => x.startsWith(`${bk}|${model}|`) && x !== rk)) {
      const rs = byArm.get(k);
      const d = (fn) => { const a = perEx(rs, fn), b = perEx(R, fn); return (idx) => mean(idx.map((i) => a[i] - b[i])); };
      const pp = (x) => (Number.isFinite(x) ? `${x >= 0 ? "+" : ""}${(100 * x).toFixed(1)}` : "-");
      md += `| ${bk} | ${model} | ${k.split("|")[2]} | ${ci(boot(exercises.length, d(rawEx)), pp)} | ${ci(boot(exercises.length, d(accEx)), pp)} |\n`;
    }
  }
}

// ---- per exercise
md += "\n## Per exercise: seeds with all held-out tests passing, raw / accepted (mean held-out tests passed)\n\n";
const multiModel = new Set(arms.map((k) => k.split("|").slice(0, 2).join("|"))).size > 1;
md += `| exercise | ${arms.map((k) => (multiModel ? `${k.split("|")[1]} ${k.split("|")[2]}` : k.split("|")[2])).join(" | ")} |\n|---|${arms.map(() => "---").join("|")}|\n`;
for (const ex of exercises) {
  md += `| ${ex} | ${arms.map((k) => {
    const xs = byArm.get(k).filter((r) => r.exercise === ex);
    if (!xs.length) return "skipped";
    const v = xs.filter(ok);
    return `${sum(xs.map(rawEx))}/${sum(xs.map(accEx))} of ${xs.length} (${f1(mean(v.map((r) => r.heldOut.passed)))}/${v[0]?.heldOut.total ?? "?"})${v.length < xs.length ? " error" : ""}`;
  }).join(" | ")} |\n`;
}
writeFileSync(join(dirs[0], "tables.md"), md);
console.log(md);
