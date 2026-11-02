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
import { createServer } from "node:http";
import { readFileSync, existsSync, appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { readFile, writeFile, rm, mkdir } from "node:fs/promises";
import { join, basename } from "node:path";
import { parseArgs } from "node:util";
import { EXERCISES, instructions, split, run, heldOut, runTests, prepareTestDir } from "./lib/common.mjs";
import { specSource, configFor, sketchFile } from "./lib/adapter.mjs";
import { chat, extractCode } from "./lib/baseline.mjs";

const { values: a } = parseArgs({ options: {
  dataset: { type: "string" }, work: { type: "string" }, oa: { type: "string" }, matrix: { type: "string" }, out: { type: "string" },
  seed: { type: "string", default: "1" }, port: { type: "string", default: "18442" }, configs: { type: "string" },
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
createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  try {
    const up = await fetch(new URL(backend.baseUrl).origin + req.url, { method: req.method, headers: { "content-type": "application/json" }, body: req.method === "GET" ? undefined : Buffer.concat(chunks) });
    const text = await up.text();
    res.writeHead(up.status, { "content-type": up.headers.get("content-type") ?? "application/json" }).end(text);
    if (/\/chat\/completions/.test(req.url)) try { const j = JSON.parse(text); meter.calls++; meter.prompt += j.usage?.prompt_tokens ?? 0; meter.eval += j.usage?.completion_tokens ?? 0; } catch {}
  } catch (e) { if (!res.headersSent) res.writeHead(502); res.end(String(e)); }
}).listen(port, "127.0.0.1");
const memAvailMb = () => +readFileSync("/proc/meminfo", "utf8").match(/MemAvailable:\s+(\d+)/)[1] / 1024;

// --- the scenario
const INTENT_CHANGE = "Return a new value and never mutate the input.";
const HAND = `// hand-written: fill ring by ring
  const m: number[][] = Array.from({ length: size }, () => new Array<number>(size).fill(0));
  let n = 1;
  for (let ring = 0; ring < Math.ceil(size / 2); ring++) {
    const last = size - 1 - ring;
    for (let c = ring; c <= last; c++) m[ring]![c] = n++;
    for (let r = ring + 1; r <= last; r++) m[r]![last] = n++;
    for (let c = last - 1; c >= ring && last > ring; c--) m[last]![c] = n++;
    for (let r = last - 1; r > ring && last > ring; r--) m[r]![ring] = n++;
  }
  return m;`;
const STEPS = [
  { name: "create text.ts and arrays.ts", add: { text: ["acronym", "diamond"], arrays: ["flatten-array", "binary-search"] } },
  { name: "add codec.ts", add: { codec: ["variable-length-quantity"] } },
  { name: "add transpose to arrays.ts", add: { arrays: ["transpose"] } },
  { name: "change flatten intent", intent: "flatten-array" },
  { name: "add grid.ts", add: { grid: ["spiral-matrix"] } },
  { name: "hand-edit ofSize, add rectangles", hand: true, add: { grid: ["rectangles"] } },
  { name: "add wordy to text.ts", add: { text: ["wordy"] } },
  { name: "change binary-search intent", intent: "binary-search" },
  { name: "no change", none: true },
];
const fnsOf = (ex) => Object.keys(EXERCISES.functions[ex].fns);
const all = STEPS.flatMap((s) => Object.values(s.add ?? {}).flat());
const splits = {};
for (const ex of new Set(all)) splits[ex] = await split(a.dataset, ex, a.work);
const fileOf = (layout, ex) => Object.keys(layout).find((f) => layout[f].includes(ex));
/** files the step touches: the files it adds to, the file of a changed intent, the file of the hand edit */
const touched = (st, layout) => [...new Set([...Object.keys(st.add ?? {}), ...(st.intent ? [fileOf(layout, st.intent)] : [])])];

/** OpenArc spec part of one file (specSource per exercise, one open-arc import), intent changes applied. */
function specs(exs, changed, cfg = {}) {
  let s = exs.map((ex) => specSource(a.dataset, ex, splits[ex], { sketch: cfg.sketch }).replace('import * as arc from "open-arc";\n\n', "")).join("");
  for (const ex of changed) for (const f of fnsOf(ex)) s = s.replace(`"Exercise \\"${ex}\\": implement \`${f}\`."`, `"Exercise \\"${ex}\\": implement \`${f}\`. ${INTENT_CHANGE}"`);
  return `import * as arc from "open-arc";\n\n${s}`;
}
/** Keep generated bodies: rebuild the spec part, keep every region already in the file. */
const respec = (file, exs, changed, cfg) => specs(exs, changed, cfg) + [...file.matchAll(/\/\/ @openarc:begin [\s\S]*?\/\/ @openarc:end \S+\n/g)].map((m) => m[0]).join("\n");
const handPresent = (src) => src.replace(/\s+/g, " ").includes(HAND.replace(/\s+/g, " "));

/** held-out per exercise, against its file through a re-export */
async function score(dir, layout, path) {
  const out = {};
  for (const [f, exs] of Object.entries(layout)) for (const ex of exs) {
    const h = await heldOut(a.dataset, ex, join(dir, "heldout", ex), `export * from ${JSON.stringify(path(f))};\n`, splits[ex], { "open-arc": join(oaModules, "open-arc") });
    out[ex] = { passed: h.passed, total: h.total, allPass: h.allPass, publicPass: h.publicPass, loadError: h.loadError?.slice(0, 300) };
  }
  return out;
}
const grow = (layout, add) => { for (const [f, exs] of Object.entries(add ?? {})) layout[f] = [...(layout[f] ?? []), ...exs]; };

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
    const grid = existsSync(path("grid")) ? await readFile(path("grid"), "utf8") : "";
    steps.push({ step: st.name, wallMs: Date.now() - t0, compileMs, ...meter, scaffoldExit: sc.code, compileExit: comp.code, compileTail: (comp.stdout + comp.stderr).slice(-1500), hand: handApplied ? handPresent(grid) : undefined, heldOut: await score(dir, layout, path) });
  }
  return steps;
}

const SYSTEM = "You are an expert TypeScript programmer. Reply with the complete TypeScript file in a single ```ts code block and nothing else.";
const show = (v) => JSON.stringify(v);
const examplesOf = (ex) => fnsOf(ex).flatMap((f) => splits[ex].examples[f].map((e) => `- ${f}(${e.args.map(show).join(", ")}) returns ${show(e.expected)}`)).join("\n");
const sigOf = (ex) => { const e = EXERCISES.functions[ex]; return `${e.types ? e.types + "\n\n" : ""}${fnsOf(ex).map((f) => { const [, p, r] = e.fns[f].match(/^\((.*)\) => (.*)$/); return `export function ${f}(${p}): ${r}`; }).join("\n")}`; };
function changeText(st, f, layout, cfg = {}) {
  const parts = [];
  for (const ex of st.add?.[f] ?? []) parts.push(`Add ${fnsOf(ex).map((x) => `\`${x}\``).join(" and ")} (exercise "${ex}"):\n\n${instructions(a.dataset, ex)}\n\nSignature:\n\n\`\`\`ts\n${sigOf(ex)}\n\`\`\`\n\nExamples that must hold:\n${examplesOf(ex)}${cfg.sketch ? outline(ex) : ""}`);
  if (st.intent && fileOf(layout, st.intent) === f) parts.push(`Change ${fnsOf(st.intent).map((x) => `\`${x}\``).join(" and ")}: ${INTENT_CHANGE}`);
  return parts.join("\n\n");
}
// the C-sketch outline for the plain prompt: the same sketch file, arc.hole("...") read as "fill in: ..."
const outline = (ex) => { const s = fnsOf(ex).filter((f) => existsSync(sketchFile(ex, f))).map((f) => `\`${f}\` = ${readFileSync(sketchFile(ex, f), "utf8").trim()}`); return s.length ? `\n\nImplementation outline (each arc.hole("...") is a gap you fill as described):\n\n\`\`\`ts\n${s.join("\n\n")}\n\`\`\`` : ""; };
const publicTests = (f, exs) => {
  const dec = `const d = (v: any): any => v === "$undefined" ? undefined : v === "$NaN" ? NaN : v === "$Infinity" ? Infinity : v === "$-Infinity" ? -Infinity : Array.isArray(v) ? v.map(d) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, d(x)])) : v;\n`;
  let s = `import { it, expect } from '@jest/globals'\nimport * as m from './${f}.ts'\n${dec}`;
  for (const ex of exs) for (const fn of fnsOf(ex)) for (const e of splits[ex].examples[fn]) s += `it(${show(`${fn}: ${e.name}`)}, () => { expect((m as any).${fn}(...d(${show(e.args)}))).toEqual(d(${show(e.expected)})) })\n`;
  return s;
};

async function armD(dir, cfg = {}) {
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  await prepareTestDir(dir);
  const path = (f) => join(dir, `${f}.ts`);
  const layout = {}, code = {}, steps = [];
  for (const st of STEPS) {
    const t0 = Date.now(); meter = { calls: 0, prompt: 0, eval: 0 };
    grow(layout, st.add);
    if (st.hand) code.grid = code.grid.replace(/export (?:function ofSize\([^)]*\)[^{]*|const ofSize[^=]*=\s*\([^)]*\)[^{]*)\{[\s\S]*?\n\}/, `export function ofSize(size: number): number[][] {\n  ${HAND}\n}`);
    let attempts = 0, publicPass = true;
    if (!st.none) for (const f of touched(st, layout)) {
      const ask = code[f]
        ? `Current file \`${f}.ts\`:\n\n\`\`\`ts\n${code[f]}\n\`\`\`\n\n${changeText(st, f, layout, cfg)}\n\nKeep everything else unchanged. Return the complete file.`
        : `Write the TypeScript file \`${f}.ts\`.\n\n${changeText(st, f, layout, cfg)}\n\nReturn the complete file.`;
      const messages = [{ role: "system", content: SYSTEM }, { role: "user", content: ask }];
      await writeFile(join(dir, `${f}.public.test.ts`), publicTests(f, layout[f]));
      const total = layout[f].reduce((n, ex) => n + fnsOf(ex).reduce((k, fn) => k + splits[ex].examples[fn].length, 0), 0);
      let ok = false;
      for (let i = 1; i <= 3 && !ok; i++) {
        attempts++;
        const reply = await chat(backend, port, model, messages, { seed, temperature: 0 });
        const next = extractCode(reply);
        await writeFile(path(f), next);
        const pt = await runTests(join(dir, `${f}.public.test.ts`));
        const failed = pt.lines.filter((l) => !l.ok);
        ok = pt.lines.length === total && !failed.length;
        if (ok || i === 3) code[f] = next;
        if (!ok) messages.push({ role: "assistant", content: reply }, { role: "user", content: `The file fails these examples:\n${pt.lines.length ? failed.map((l) => `- ${l.name}: ${l.msg}`).join("\n").slice(0, 3000) : `The file did not load:\n${pt.stderr.split("\n").filter(Boolean).slice(-8).join("\n")}`}\n\nFix it and return the complete corrected file.` });
      }
      publicPass &&= ok;
    }
    for (const [f, c] of Object.entries(code)) await writeFile(path(f), c);
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
  for (const s of steps) note(`s${seed} ${c} ${s.step ?? "ERROR " + s.error?.split("\n")[0]}: calls ${s.calls} tokens ${s.prompt}+${s.eval} ${((s.wallMs ?? 0) / 1000).toFixed(1)}s ${s.correct ? "CORRECT" : "held-out " + Object.entries(s.heldOut ?? {}).filter(([, h]) => !h.allPass).map(([ex, h]) => `${ex} ${h.passed}/${h.total}`).join(", ")}${s.hand !== undefined ? ` hand-edit ${s.hand ? "kept" : "LOST"}` : ""}${s.regressions?.length ? ` REGRESSED ${s.regressions.join(",")}` : ""}`);
}
process.exit(0);
