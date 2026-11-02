#!/usr/bin/env node
// Evolution benchmark (issue #19): one module, src/toolkit.ts, changed over 5 steps. Arms:
//   A  OpenArc: edit the specs, `openarc scaffold`, `openarc compile --keep-going` (regenerates only what changed)
//   D  plain prompt: a fresh chat per step with the current file and the change, the complete file back, up to 3
//      attempts with the failing public examples as feedback (the same loop as run.mjs's D, per step)
// Per step: model calls, tokens, wall time, held-out tests of every function so far, regressions (a function that
// passed its held-out tests at the previous step and fails now), and whether the step-4 hand edit is still in the file.
// node evolve.mjs --dataset <ts-bench> --work <dir> --oa <open-arc-x.y.z.tgz> --matrix matrix-evolve.json --out <dir> --seed n
import { createServer } from "node:http";
import { readFileSync, existsSync, appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { readFile, writeFile, rm, mkdir } from "node:fs/promises";
import { join, basename } from "node:path";
import { parseArgs } from "node:util";
import { EXERCISES, instructions, split, run, heldOut, runTests, prepareTestDir, proxyBase } from "./lib/common.mjs";
import { specSource, configFor } from "./lib/adapter.mjs";
import { chat, extractCode } from "./lib/baseline.mjs";

const { values: a } = parseArgs({ options: {
  dataset: { type: "string" }, work: { type: "string" }, oa: { type: "string" }, matrix: { type: "string" }, out: { type: "string" },
  seed: { type: "string", default: "1" }, port: { type: "string", default: "18441" }, configs: { type: "string", default: "A,D" },
} });
const matrix = JSON.parse(readFileSync(a.matrix, "utf8"));
const backend = matrix.backend, model = matrix.runs[0].model, seed = +a.seed, port = +a.port;
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

// --- token meter (OpenAI-compatible usage), same as run.mjs
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
const camel = (s) => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
const INTENT_CHANGE = "Return a new array and never mutate the input.";
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
  { name: "create", add: ["flatten-array", "spiral-matrix"] },
  { name: "add binary-search", add: ["binary-search"] },
  { name: "change flatten intent", intent: "flatten-array" },
  { name: "hand-edit ofSize, add transpose", hand: true, add: ["transpose"] },
  { name: "no change", none: true },
];
const fnOf = (ex) => Object.keys(EXERCISES.functions[ex].fns)[0];
const splits = {};
for (const ex of new Set(STEPS.flatMap((s) => s.add ?? []))) splits[ex] = await split(a.dataset, ex, a.work);

/** OpenArc spec file for the exercises so far (specSource per exercise, one open-arc import), intent change applied. */
function specs(exs, changed) {
  let s = exs.map((ex) => specSource(a.dataset, ex, splits[ex]).replace('import * as arc from "open-arc";\n\n', "")).join("");
  for (const ex of changed) s = s.replace(`"Exercise \\"${ex}\\": implement \`${fnOf(ex)}\`."`, `"Exercise \\"${ex}\\": implement \`${fnOf(ex)}\`. ${INTENT_CHANGE}"`);
  return `import * as arc from "open-arc";\n\n${s}`;
}
/** Keep generated bodies: rebuild the spec part, keep every region already in the file. */
function respec(file, exs, changed) {
  const regions = [...file.matchAll(/\/\/ @openarc:begin [\s\S]*?\/\/ @openarc:end \S+\n/g)].map((m) => m[0]);
  return specs(exs, changed) + regions.join("\n");
}
const handPresent = (src) => src.replace(/\s+/g, " ").includes(HAND.replace(/\s+/g, " "));

/** held-out per exercise, against the file through a re-export */
async function score(dir, file, exs) {
  const out = {};
  for (const ex of exs) {
    const h = await heldOut(a.dataset, ex, join(dir, "heldout", ex), `export * from ${JSON.stringify(file)};\n`, splits[ex], { "open-arc": join(oaModules, "open-arc") });
    out[ex] = { passed: h.passed, total: h.total, allPass: h.allPass, loadError: h.loadError?.slice(0, 300) };
  }
  return out;
}

async function armA(dir) {
  await rm(dir, { recursive: true, force: true });
  await mkdir(join(dir, "src"), { recursive: true });
  await writeFile(join(dir, "package.json"), JSON.stringify({ name: "bench-evolve", private: true, type: "module" }));
  await run(["cp", "-al", oaModules, join(dir, "node_modules")]);
  const bin = join(oaModules, ".bin/openarc");
  await run([bin, "init"], { cwd: dir, timeoutMs: 60_000 });
  await writeFile(join(dir, "openarc.config.json"), JSON.stringify(configFor({ model, level: 0, port, backend, seed }), null, 2));
  const file = join(dir, "src/toolkit.ts");
  let exs = [], changed = [];
  const steps = [];
  for (const st of STEPS) {
    if (st.add) exs = [...exs, ...st.add];
    if (st.intent) changed = [...changed, st.intent];
    const t0 = Date.now(); meter = { calls: 0, prompt: 0, eval: 0 };
    let src = existsSync(file) ? await readFile(file, "utf8") : "";
    if (st.hand) src = src.replace(/(\/\/ @openarc:begin spiralMatrix\.ofSize\nexport const ofSize: OfSizeFn = \(size\) => \{\n)[\s\S]*?(\n\};\n\/\/ @openarc:end spiralMatrix\.ofSize)/, `$1  ${HAND}$2`);
    if (!st.none) await writeFile(file, respec(src, exs, changed));
    await run([bin, "scaffold"], { cwd: dir, timeoutMs: 120_000 });
    const comp = await run([bin, "compile", "--keep-going"], { cwd: dir, timeoutMs: 45 * 60_000 });
    const after = await readFile(file, "utf8");
    steps.push({ step: st.name, wallMs: Date.now() - t0, ...meter, compileExit: comp.code, compileTail: (comp.stdout + comp.stderr).slice(-1500), hand: st.hand || steps.some((s) => s.hand !== undefined) ? handPresent(after) : undefined, heldOut: await score(dir, file, exs), source: after.slice(0, 20000) });
  }
  return steps;
}

const SYSTEM = "You are an expert TypeScript programmer. Reply with the complete TypeScript file in a single ```ts code block and nothing else.";
const show = (v) => JSON.stringify(v);
const examplesOf = (ex) => splits[ex].examples[fnOf(ex)].map((e) => `- ${fnOf(ex)}(${e.args.map(show).join(", ")}) returns ${show(e.expected)}`).join("\n");
const sigOf = (ex) => { const e = EXERCISES.functions[ex]; const f = fnOf(ex); const [, p, r] = e.fns[f].match(/^\((.*)\) => (.*)$/); return `${e.types ? e.types + "\n\n" : ""}export function ${f}(${p}): ${r}`; };
function changeText(st) {
  const parts = [];
  for (const ex of st.add ?? []) parts.push(`Add the function \`${fnOf(ex)}\` (exercise "${ex}"):\n\n${instructions(a.dataset, ex)}\n\nSignature:\n\n\`\`\`ts\n${sigOf(ex)}\n\`\`\`\n\nExamples that must hold:\n${examplesOf(ex)}`);
  if (st.intent) parts.push(`Change \`${fnOf(st.intent)}\`: ${INTENT_CHANGE}`);
  return parts.join("\n\n");
}
const publicTests = (exs) => {
  const dec = `const d = (v: any): any => v === "$undefined" ? undefined : v === "$NaN" ? NaN : v === "$Infinity" ? Infinity : v === "$-Infinity" ? -Infinity : Array.isArray(v) ? v.map(d) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, d(x)])) : v;\n`;
  let s = `import { it, expect } from '@jest/globals'\nimport * as m from './toolkit.ts'\n${dec}`;
  for (const ex of exs) for (const e of splits[ex].examples[fnOf(ex)]) s += `it(${show(`${fnOf(ex)}: ${e.name}`)}, () => { expect((m as any).${fnOf(ex)}(...d(${show(e.args)}))).toEqual(d(${show(e.expected)})) })\n`;
  return s;
};

async function armD(dir) {
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  await prepareTestDir(dir);
  const file = join(dir, "toolkit.ts");
  let exs = [], code = "";
  const steps = [];
  for (const st of STEPS) {
    const t0 = Date.now(); meter = { calls: 0, prompt: 0, eval: 0 };
    if (st.add) exs = [...exs, ...st.add];
    if (st.hand) code = code.replace(/export (?:function ofSize\([^)]*\)[^{]*|const ofSize[^=]*=\s*\([^)]*\)[^{]*)\{[\s\S]*?\n\}/, `export function ofSize(size: number): number[][] {\n  ${HAND}\n}`);
    let ok = true, attempts = 0;
    if (!st.none) {
      const ask = code
        ? `Current file \`toolkit.ts\`:\n\n\`\`\`ts\n${code}\n\`\`\`\n\n${changeText(st)}\n\nKeep everything else unchanged. Return the complete file.`
        : `Write the TypeScript file \`toolkit.ts\`.\n\n${changeText(st)}\n\nReturn the complete file.`;
      const messages = [{ role: "system", content: SYSTEM }, { role: "user", content: ask }];
      await writeFile(join(dir, "public.test.ts"), publicTests(exs));
      ok = false;
      for (let i = 1; i <= 3 && !ok; i++) {
        attempts = i;
        const reply = await chat(backend, port, model, messages, { seed, temperature: 0 });
        const next = extractCode(reply);
        await writeFile(file, next);
        const pt = await runTests(join(dir, "public.test.ts"));
        const failed = pt.lines.filter((l) => !l.ok);
        const total = exs.reduce((n, ex) => n + splits[ex].examples[fnOf(ex)].length, 0);
        ok = pt.lines.length === total && !failed.length;
        if (ok || i === 3) code = next;
        if (!ok) messages.push({ role: "assistant", content: reply }, { role: "user", content: `The file fails these examples:\n${pt.lines.length ? failed.map((l) => `- ${l.name}: ${l.msg}`).join("\n").slice(0, 3000) : `The file did not load:\n${pt.stderr.split("\n").filter(Boolean).slice(-8).join("\n")}`}\n\nFix it and return the complete corrected file.` });
      }
    }
    await writeFile(file, code);
    steps.push({ step: st.name, wallMs: Date.now() - t0, ...meter, attempts, publicPass: ok, hand: st.hand || steps.some((s) => s.hand !== undefined) ? handPresent(code) : undefined, heldOut: await score(dir, file, exs), source: code.slice(0, 20000) });
  }
  return steps;
}

const jsonl = join(a.out, "evolve.jsonl");
for (const c of a.configs.split(",")) {
  if (memAvailMb() < 1536) { note(`MemAvailable ${memAvailMb() | 0} MB < 1.5 GB: stop`); process.exit(4); }
  const dir = join(a.work, "evolve", `s${seed}`, c);
  const t0 = Date.now();
  let steps;
  try { steps = c === "A" ? await armA(dir) : await armD(dir); } catch (e) { steps = [{ error: String(e?.stack ?? e).slice(0, 1000) }]; }
  // regressions: a function whose held-out tests all passed at the previous step and not now
  steps.forEach((s, i) => { if (i && s.heldOut) s.regressions = Object.keys(steps[i - 1].heldOut ?? {}).filter((ex) => steps[i - 1].heldOut[ex].allPass && !s.heldOut[ex]?.allPass); });
  appendFileSync(jsonl, JSON.stringify({ config: c, seed, model, oa: basename(a.oa), wallMs: Date.now() - t0, steps }) + "\n");
  for (const s of steps) note(`s${seed} ${c} ${s.step ?? "ERROR " + s.error?.split("\n")[0]}: calls ${s.calls} tokens ${s.prompt}+${s.eval} ${((s.wallMs ?? 0) / 1000).toFixed(1)}s held-out ${Object.entries(s.heldOut ?? {}).map(([ex, h]) => `${ex} ${h.passed}/${h.total}`).join(", ")}${s.hand !== undefined ? ` hand-edit ${s.hand ? "kept" : "LOST"}` : ""}${s.regressions?.length ? ` REGRESSED ${s.regressions.join(",")}` : ""}`);
}
process.exit(0);
