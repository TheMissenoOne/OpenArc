#!/usr/bin/env node
// Multi-file evolution benchmark: four modules changed over 9 steps (new files, functions added to existing files, intent
// changes, a hand edit, a no-op step). Arms (matrix-evolve-multi.json configs):
//   openarc arms  edit the specs, `openarc scaffold`, `openarc compile --keep-going`; `strategy` is merged into
//                 compilation.strategy (A: none, R: routed repair, P1: plan after a failure, P: plan always)
//   D             plain prompt, file by file: for each file the step touches, a fresh chat with the current file and the
//                 change, the complete file back, up to 3 attempts with that file's failing public examples as feedback
// Per step: model calls, tokens, wall time, held-out tests of every function so far, regressions, the hand edit, and
// `correct` (every function so far passes all its held-out tests). The headline metric is cumulative tokens and time
// per correct project state.
// node evolve-multi.mjs --dataset <ts-bench> --work <dir> --oa <open-arc-x.y.z.tgz> --matrix matrix-evolve-multi.json --out <dir> --seed n
// --pack <n>: instead of the scenario above, every exercise of BENCH_EXERCISES dealt by seed into files of n functions, 5 files per step;
//             with --rounds, one function added to every file per step instead (single-region prompts, no batches)
import { readFileSync, existsSync, appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { readFile, writeFile, rm, mkdir } from "node:fs/promises";
import { join, basename } from "node:path";
import { parseArgs } from "node:util";
import { EXERCISES, packSteps, split, run, prepareTestDir } from "./lib/common.mjs";
import { specSource, configFor } from "./lib/adapter.mjs";
import { INTENT_CHANGE, HAND, SCENARIO, fnsOf, touched, grow, handPresent, applyHand, memAvailMb, meterProxy, score as scoreIn, stepD } from "./lib/multi.mjs";

const { values: a } = parseArgs({ options: {
  dataset: { type: "string" }, work: { type: "string" }, oa: { type: "string" }, matrix: { type: "string" }, out: { type: "string" },
  seed: { type: "string", default: "1" }, port: { type: "string", default: "18442" }, configs: { type: "string" }, pack: { type: "string" }, rounds: { type: "boolean" },
} });
const matrix = JSON.parse(readFileSync(a.matrix, "utf8"));
const backend = matrix.backend, model = matrix.runs[0].model, seed = +a.seed, port = +a.port;
const configs = (a.configs ?? matrix.runs[0].configs.join(",")).split(",");
mkdirSync(a.out, { recursive: true });
const note = (m) => { const l = `${new Date().toISOString()} ${m}`; console.log(l); appendFileSync(join(a.out, "run.log"), l + "\n"); };

// --- OpenArc package
const oaDir = join(a.work, basename(a.oa, ".tgz"));
if (!existsSync(join(oaDir, "node_modules/.bin/openarc"))) {
  mkdirSync(oaDir, { recursive: true });
  writeFileSync(join(oaDir, "package.json"), JSON.stringify({ private: true, type: "module" }));
  const r = await run(["npm", "i", "--no-audit", "--no-fund", a.oa], { cwd: oaDir });
  if (r.code !== 0) throw new Error(`npm i failed: ${r.stderr}`);
}
const oaModules = join(oaDir, "node_modules");

// --- token meter (OpenAI-compatible usage)
let meter;
meterProxy(backend, port, (j) => { meter.calls++; meter.prompt += j.usage?.prompt_tokens ?? 0; meter.eval += j.usage?.completion_tokens ?? 0; });

// --- the scenario
const STEPS = a.pack ? packSteps(Object.fromEntries(Object.entries(EXERCISES.functions).map(([ex, e]) => [ex, Object.keys(e.fns)])), +a.pack, 5, seed, a.rounds) : SCENARIO;
const all = STEPS.flatMap((s) => Object.values(s.add ?? {}).flat());
const splits = {};
for (const ex of new Set(all)) splits[ex] = await split(a.dataset, ex, a.work);
const ctx = { dataset: a.dataset, splits, backend, port, model, seed, oaModules };

/** OpenArc spec part of one file (specSource per exercise, one open-arc import), intent changes applied. */
function specs(exs, changed, cfg = {}) {
  let s = exs.map((ex) => specSource(a.dataset, ex, splits[ex], { sketch: cfg.sketch }).replace('import * as arc from "open-arc";\n\n', "")).join("");
  for (const ex of changed) for (const f of fnsOf(ex)) s = s.replace(`"Exercise \\"${ex}\\": implement \`${f}\`."`, `"Exercise \\"${ex}\\": implement \`${f}\`. ${INTENT_CHANGE}"`);
  return `import * as arc from "open-arc";\n\n${s}`;
}
/** Keep generated bodies: rebuild the spec part, keep every region already in the file. */
const respec = (file, exs, changed, cfg) => specs(exs, changed, cfg) + [...file.matchAll(/\/\/ @openarc:begin [\s\S]*?\/\/ @openarc:end \S+\n/g)].map((m) => m[0]).join("\n");
const score = (dir, layout, path) => scoreIn(ctx, dir, layout, path);

async function armOpenArc(dir, cfg) {
  await rm(dir, { recursive: true, force: true });
  await mkdir(join(dir, "src"), { recursive: true });
  await writeFile(join(dir, "package.json"), JSON.stringify({ name: "bench-evolve-multi", private: true, type: "module" }));
  await run(["cp", "-al", oaModules, join(dir, "node_modules")]);
  const bin = join(oaModules, ".bin/openarc");
  await run([bin, "init"], { cwd: dir, timeoutMs: 60_000 });
  const config = configFor({ model, level: 0, port, backend, seed });
  if (cfg.strategy) config.compilation.strategy = cfg.strategy;
  if (cfg.context) Object.assign(config.compilation.context, cfg.context); // pendingSiblings, previousBody (0.10.0+ context-variants)
  await writeFile(join(dir, "openarc.config.json"), JSON.stringify(config, null, 2));
  const path = (f) => join(dir, "src", `${f}.ts`);
  const layout = {}, changed = [], steps = [];
  let handApplied = false; // the edit needs a compiled ofSize; while it is still pending there is nothing to hand-edit
  for (const st of STEPS) {
    grow(layout, st.add);
    if (st.intent) changed.push(st.intent);
    const t0 = Date.now(); meter = { calls: 0, prompt: 0, eval: 0 };
    if (st.hand) {
      const g = await readFile(path("grid"), "utf8");
      const edited = g.replace(/(\/\/ @openarc:begin spiralMatrix\.ofSize\nexport const ofSize: OfSizeFn = \(size\) => \{\n)[\s\S]*?(\n\};\n\/\/ @openarc:end spiralMatrix\.ofSize)/, `$1  ${HAND}$2`);
      handApplied = edited !== g;
      await writeFile(path("grid"), edited);
    }
    if (!st.none) for (const f of touched(st, layout)) await writeFile(path(f), respec(existsSync(path(f)) ? await readFile(path(f), "utf8") : "", layout[f], changed.filter((ex) => layout[f].includes(ex)), cfg));
    const sc = await run([bin, "scaffold"], { cwd: dir, timeoutMs: 120_000 });
    const tc = Date.now();
    const comp = await run([bin, "compile", "--keep-going"], { cwd: dir, timeoutMs: 45 * 60_000 });
    const compileMs = Date.now() - tc;
    // a project-wide spec error or a dead backend must not score as "the model failed": new functions always need a call
    if (st.add && !meter.calls) throw new Error(`step "${st.name}" added functions but made no model call: ${(comp.stdout + comp.stderr).slice(-600)}`);
    const grid = existsSync(path("grid")) ? await readFile(path("grid"), "utf8") : "";
    steps.push({ step: st.name, wallMs: Date.now() - t0, compileMs, ...meter, scaffoldExit: sc.code, compileExit: comp.code, compileTail: (comp.stdout + comp.stderr).slice(-1500), hand: handApplied ? handPresent(grid) : undefined, heldOut: await score(dir, layout, path) });
  }
  return steps;
}

async function armD(dir, cfg = {}) {
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  await prepareTestDir(dir);
  const path = (f) => join(dir, `${f}.ts`);
  const layout = {}, code = {}, steps = [];
  for (const st of STEPS) {
    const t0 = Date.now(); meter = { calls: 0, prompt: 0, eval: 0 };
    grow(layout, st.add);
    if (st.hand) code.grid = applyHand(code.grid);
    const { attempts, publicPass } = await stepD(ctx, dir, st, layout, code, cfg);
    steps.push({ step: st.name, wallMs: Date.now() - t0, ...meter, attempts, publicPass, hand: steps.some((s) => s.hand !== undefined) || st.hand ? handPresent(code.grid ?? "") : undefined, heldOut: await score(dir, layout, path) });
  }
  return steps;
}

const jsonl = join(a.out, "evolve-multi.jsonl");
for (const c of configs) {
  if (memAvailMb() < 1536) { note(`MemAvailable ${memAvailMb() | 0} MB < 1.5 GB: stop`); process.exit(4); }
  const cfg = matrix.configs[c];
  const dir = join(a.work, "evolve-multi", `s${seed}`, c);
  const t0 = Date.now();
  let steps;
  try { steps = cfg.kind === "baseline" ? await armD(dir, cfg) : await armOpenArc(dir, cfg); } catch (e) { steps = [{ error: String(e?.stack ?? e).slice(0, 1000) }]; }
  steps.forEach((s, i) => {
    if (!s.heldOut) return;
    s.correct = Object.values(s.heldOut).every((h) => h.allPass);
    if (i) s.regressions = Object.keys(steps[i - 1].heldOut ?? {}).filter((ex) => steps[i - 1].heldOut[ex].allPass && !s.heldOut[ex]?.allPass);
  });
  appendFileSync(jsonl, JSON.stringify({ config: c, seed, model, oa: basename(a.oa), wallMs: Date.now() - t0, steps }) + "\n");
  if (steps.some((s) => s.error)) process.exitCode = 5; // the queue must not mark this arm done
  for (const s of steps) note(`s${seed} ${c} ${s.step ?? "ERROR " + s.error?.split("\n")[0]}: calls ${s.calls} tokens ${s.prompt}+${s.eval} ${((s.wallMs ?? 0) / 1000).toFixed(1)}s ${s.correct ? "CORRECT" : "held-out " + Object.entries(s.heldOut ?? {}).filter(([, h]) => !h.allPass).map(([ex, h]) => `${ex} ${h.passed}/${h.total}`).join(", ")}${s.hand !== undefined ? ` hand-edit ${s.hand ? "kept" : "LOST"}` : ""}${s.regressions?.length ? ` REGRESSED ${s.regressions.join(",")}` : ""}`);
}
process.exit();
