#!/usr/bin/env node
// Two evolve-multi arms paired per function on the final step, across seeds. The unit is the function: its pass rate
// over the seeds, because a layout's siblings change between seeds but the task does not.
// node paired-multi.mjs <arm A> <arm B> <evolve-multi.jsonl>...   (B minus A)
import { readFileSync } from "node:fs";

const [A, B, ...files] = process.argv.slice(2);
const rows = files.flatMap((f) => readFileSync(f, "utf8").trim().split("\n").map((l) => JSON.parse(l)));
const sum = (xs) => xs.reduce((x, y) => x + y, 0);
const pass = {}; // function -> seed -> arm -> allPass
const totals = { [A]: {}, [B]: {} };
for (const r of rows) {
  const st = r.steps.filter((s) => s.heldOut);
  for (const [ex, h] of Object.entries(st.at(-1)?.heldOut ?? {})) ((pass[ex] ??= {})[r.seed] ??= {})[r.config] = h.allPass;
  const t = totals[r.config];
  if (!t) continue;
  t.tokens = (t.tokens ?? 0) + sum(st.map((s) => s.prompt + s.eval));
  t.calls = (t.calls ?? 0) + sum(st.map((s) => s.calls));
  t.wall = (t.wall ?? 0) + sum(st.map((s) => s.wallMs));
  t.seeds = (t.seeds ?? 0) + 1;
  // a run that lost its backend scores as a run of bad code: never let that through unnoticed
  t.backendErrors = (t.backendErrors ?? 0) + st.filter((s) => /\b50[23]\b|ECONNREFUSED|fetch failed|Loading model/.test(s.compileTail ?? "")).length + r.steps.filter((s) => s.error).length;
}
const pairs = Object.values(pass).flatMap((seeds) => Object.values(seeds)).filter((p) => A in p && B in p);
const onlyB = pairs.filter((p) => p[B] && !p[A]).length, onlyA = pairs.filter((p) => p[A] && !p[B]).length;
const seeds = rows.length ? [...new Set(rows.map((r) => r.seed))].length : 0;
for (const [arm, t] of Object.entries(totals)) console.log(`${arm}: pass ${pairs.filter((p) => p[arm]).length}/${pairs.length}, ${t.seeds ?? 0} seeds, tokens ${t.tokens}, calls ${t.calls}, ${Math.round((t.wall ?? 0) / 60000)} min, backend errors ${t.backendErrors ?? 0}`);
console.log(`discordant pairs: only ${B} ${onlyB}, only ${A} ${onlyA}`);

// per function: mean (B - A) over its seeds; percentile bootstrap over functions, sign test on the functions that differ
const diffs = Object.values(pass).map((s) => { const ps = Object.values(s).filter((p) => A in p && B in p); return ps.length ? sum(ps.map((p) => +p[B] - +p[A])) / ps.length : null; }).filter((d) => d !== null);
const mean = sum(diffs) / diffs.length;
let x = 1;
const rnd = () => (x = (x * 48271) % 2147483647) / 2147483647;
const boots = Array.from({ length: 10000 }, () => sum(diffs.map(() => diffs[Math.floor(rnd() * diffs.length)])) / diffs.length).sort((a, b) => a - b);
const up = diffs.filter((d) => d > 0).length, down = diffs.filter((d) => d < 0).length, n = up + down;
const choose = (k) => { let c = 1; for (let i = 0; i < k; i++) c = (c * (n - i)) / (i + 1); return c; };
const tail = sum(Array.from({ length: Math.min(up, down) + 1 }, (_, k) => choose(k))) / 2 ** n;
console.log(`functions ${diffs.length} (${seeds} seeds): mean ${B} - ${A} = ${(100 * mean).toFixed(1)} points, 95% CI [${(100 * boots[250]).toFixed(1)}, ${(100 * boots[9750]).toFixed(1)}]`);
console.log(`functions better ${up}, worse ${down}, sign test p = ${Math.min(1, 2 * tail).toFixed(3)}`);
