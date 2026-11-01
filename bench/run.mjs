#!/usr/bin/env node
// OpenArc benchmark runner. One task at a time; see README.md.
// node run.mjs --dataset <ts-bench clone> [--pilot | --exercises a,b] [--out results/<dir>] [--work <dir>] [--oa <tgz>] [--models m1,m2] [--matrix <file>] [--configs A,D] [--seed n]
import { createServer } from "node:http";
import { readFileSync, readdirSync, existsSync, appendFileSync, mkdirSync, writeFileSync } from "node:fs";

import { join, basename, dirname } from "node:path";
import { tmpdir } from "node:os";
import { parseArgs } from "node:util";
import { BENCH, EXERCISES, split, run, killTree } from "./lib/common.mjs";
import { runOpenArc } from "./lib/adapter.mjs";
import { runBaseline } from "./lib/baseline.mjs";

const { values: a } = parseArgs({ options: {
  dataset: { type: "string", default: process.env.TS_BENCH_DIR }, work: { type: "string", default: join(tmpdir(), "openarc-bench") },
  out: { type: "string" }, oa: { type: "string" }, pilot: { type: "boolean" }, exercises: { type: "string" }, models: { type: "string" },
  configs: { type: "string" }, matrix: { type: "string", default: join(BENCH, "matrix.json") }, port: { type: "string", default: "18435" }, seed: { type: "string", default: "1" },
} });
if (!a.dataset) throw new Error("--dataset <ts-bench clone> (or TS_BENCH_DIR) is required; see fetch-dataset.sh");

const GB = 1024 * 1024; // kB per GB
const matrix = JSON.parse(readFileSync(a.matrix, "utf8"));
const MIN_START_KB = (matrix.memory?.minStartGb ?? 6) * GB, ABORT_KB = (matrix.memory?.abortGb ?? 1) * GB;
/** The backend of a run: matrix.backend, overridden field by field by run.backend. */
const backendFor = (r) => ({ ...matrix.backend, ...r.backend, openarc: { ...matrix.backend?.openarc, ...r.backend?.openarc }, info: { ...matrix.backend?.info, ...r.backend?.info } });
const isOllama = (b) => b.provider === "ollama" || b.info?.engine === "ollama";
let backend = backendFor(matrix.runs[0]);
const upstream = () => new URL(backend.baseUrl).origin;
const exercises = a.exercises ? a.exercises.split(",") : a.pilot ? matrix.pilot : matrix.exercises ?? Object.keys(EXERCISES.functions);
const port = +a.port;
const seed = +a.seed; // backend seed for every arm (OpenArc config `seed`, baseline request `seed`); part of the resume key

// --- OpenArc package: newest open-arc-*.tgz unless --oa given
const buildDir = join(BENCH, "../stage0/build");
const ver = (f) => f.match(/(\d+)\.(\d+)\.(\d+)/).slice(1).map(Number);
const tgz = a.oa ?? join(buildDir, readdirSync(buildDir).filter((f) => /^open-arc-\d+\.\d+\.\d+\.tgz$/.test(f))
  .sort((x, y) => { const [p, q] = [ver(x), ver(y)]; return p[0] - q[0] || p[1] - q[1] || p[2] - q[2]; }).at(-1));
const oaVersion = basename(tgz).match(/\d+\.\d+\.\d+/)[0];
const oaDir = join(a.work, basename(tgz, ".tgz")); // by file name: a locally patched build (bench/patches) gets its own install
if (!existsSync(join(oaDir, "node_modules/.bin/openarc"))) {
  mkdirSync(oaDir, { recursive: true });
  writeFileSync(join(oaDir, "package.json"), JSON.stringify({ private: true, type: "module" }));
  const r = await run(["npm", "i", "--no-audit", "--no-fund", tgz], { cwd: oaDir });
  if (r.code !== 0) throw new Error(`npm i ${tgz} failed: ${r.stderr}`);
}
const oaModules = join(oaDir, "node_modules");

const date = new Date().toISOString().slice(0, 10);
const out = a.out ?? join(BENCH, "results", `${date}${a.pilot ? "-pilot" : ""}`);
mkdirSync(out, { recursive: true });
const jsonl = join(out, "tasks.jsonl");
const done = new Set(existsSync(jsonl) ? readFileSync(jsonl, "utf8").split("\n").filter(Boolean).map((l) => { const j = JSON.parse(l); return `${j.exercise}|${j.config}|${j.model}|${j.seed ?? 1}`; }) : []);
const note = (msg) => { const line = `${new Date().toISOString()} ${msg}`; console.log(line); appendFileSync(join(out, "run.log"), line + "\n"); };

// --- token-counting proxy in front of the backend (OpenArc records no token counts; both arms go through this).
// Understands Ollama /api/chat (prompt_eval_count/eval_count) and OpenAI-compatible /chat/completions (usage).
let promptLog = null; // every chat request body of the current task: <out>/prompts/s<seed>/<config>/<exercise>.jsonl
let meter = { calls: 0, prompt: 0, eval: 0, evalMs: 0, loadMs: 0 };
createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  try {
    const headers = { "content-type": "application/json" };
    if (req.headers.authorization) headers.authorization = req.headers.authorization;
    const t0 = Date.now();
    if (promptLog && /\/api\/chat|\/chat\/completions/.test(req.url)) appendFileSync(promptLog, Buffer.concat(chunks).toString("utf8").replace(/\n/g, " ") + "\n");
    const up = await fetch(upstream() + req.url, { method: req.method, headers, body: req.method === "GET" ? undefined : Buffer.concat(chunks) });
    // stream through: a slow upstream sends headers early and keep-alive whitespace, which must reach the client before
    // its fetch() 300 s headers/body timeout fires (ported from the live harness; the model screen lost a gemma task to it)
    res.writeHead(up.status, { "content-type": up.headers.get("content-type") ?? "application/json" });
    const buf = [];
    for await (const c of up.body ?? []) { buf.push(c); res.write(c); }
    res.end();
    const text = Buffer.concat(buf).toString("utf8");
    if (/\/api\/chat|\/chat\/completions/.test(req.url)) {
      try {
        const j = JSON.parse(text);
        meter.calls++;
        if (j.usage) { meter.prompt += j.usage.prompt_tokens ?? 0; meter.eval += j.usage.completion_tokens ?? 0; meter.evalMs += Date.now() - t0; }
        else { meter.prompt += j.prompt_eval_count ?? 0; meter.eval += j.eval_count ?? 0; meter.evalMs += (j.total_duration ?? 0) / 1e6; meter.loadMs += (j.load_duration ?? 0) / 1e6; }
      } catch {}
    }
  } catch (e) { if (res.headersSent) res.end(); else res.writeHead(502).end(String(e)); }
}).listen(port, "127.0.0.1");

// --- memory: /proc sampling every 2 s
const memAvailKb = () => +readFileSync("/proc/meminfo", "utf8").match(/MemAvailable:\s+(\d+)/)[1];
const procs = () => readdirSync("/proc").filter((p) => /^\d+$/.test(p)).map((pid) => { try { return { pid, argv: readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean) }; } catch { return null; } }).filter(Boolean);
// the process holding the model: Ollama's runner (`ollama runner` or its bundled llama-server) or a standalone llama-server
const runnerRssKb = () => procs().filter((p) => /llama-server/.test(basename(p.argv[0] ?? "")) || (/ollama/.test(p.argv[0] ?? "") && p.argv.includes("runner")))
  .reduce((s, p) => { try { return s + +readFileSync(`/proc/${p.pid}/status`, "utf8").match(/VmRSS:\s+(\d+)/)[1]; } catch { return s; } }, 0);
const foreignOpenarc = () => procs().filter((p) => p.pid !== String(process.pid) && /^(node|npm|npx)/.test(basename(p.argv[0] ?? "")) && p.argv.some((x) => /openarc|open-arc/.test(x)) && p.argv.some((x) => x === "compile" || x === "watch"));
let sample = { peakRss: 0, minAvail: Infinity };
let currentLabel = null;
async function abort(why) {
  note(`ABORT: ${why}`);
  if (run.current && run.current.exitCode === null) killTree(run.current);
  await unloadAll();
  appendFileSync(jsonl, JSON.stringify({ aborted: true, why, during: currentLabel, ts: new Date().toISOString() }) + "\n");
  process.exit(2);
}
setInterval(() => {
  const av = memAvailKb();
  sample.minAvail = Math.min(sample.minAvail, av);
  sample.peakRss = Math.max(sample.peakRss, runnerRssKb());
  if (av < ABORT_KB) abort(`MemAvailable ${Math.round(av / 1024)} MB < ${matrix.memory?.abortGb ?? 1} GB`);
}, 2000).unref();

// ponytail: only Ollama can unload on request; a llama-server holds one model for its lifetime (the operator owns it).
async function unloadAll() {
  if (!isOllama(backend)) return;
  try {
    const o = upstream();
    const ps = await (await fetch(`${o}/api/ps`)).json();
    for (const m of ps.models ?? []) await fetch(`${o}/api/generate`, { method: "POST", body: JSON.stringify({ model: m.name, keep_alive: 0 }) });
    for (let i = 0; i < 30 && ((await (await fetch(`${o}/api/ps`)).json()).models ?? []).length; i++) await new Promise((r) => setTimeout(r, 1000));
  } catch (e) { note(`unload failed: ${e}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function gate() {
  for (let i = 0; foreignOpenarc().length; i++) {
    if (i === 0) note(`waiting: another openarc compile/watch is running (pid ${foreignOpenarc().map((p) => p.pid).join(",")})`);
    if (i >= 120) await abort("another openarc compile/watch kept running for 60 min");
    await sleep(30_000);
  }
  const lim = `${MIN_START_KB / GB} GB`;
  if (memAvailKb() < MIN_START_KB) { note(`MemAvailable ${Math.round(memAvailKb() / 1024)} MB < ${lim}: unloading models`); await unloadAll(); }
  for (let i = 0; memAvailKb() < MIN_START_KB; i++) {
    if (i >= 30) await abort(`MemAvailable stayed under ${lim} for 15 min (${Math.round(memAvailKb() / 1024)} MB)`);
    await sleep(30_000);
  }
}

// --- main loop
const runs = matrix.runs.filter((r) => !a.models || a.models.split(",").includes(r.model));
note(`start: open-arc ${oaVersion} (${tgz}), exercises ${exercises.join(",")}, out ${out}`);
for (const r of runs) {
  await unloadAll(); // before each model switch (unloads from the previous run's backend)
  backend = backendFor(r);
  note(`run: model ${r.model}, backend ${JSON.stringify(backend)}`);
  for (const ex of exercises) {
    const splitInfo = await split(a.dataset, ex, a.work);
    for (const c of r.configs.filter((c) => !a.configs || a.configs.split(",").includes(c))) {
      const key = `${ex}|${c}|${r.model}|${seed}`;
      if (done.has(key)) continue;
      await gate();
      const cfg = matrix.configs[c];
      currentLabel = key;
      meter = { calls: 0, prompt: 0, eval: 0, evalMs: 0, loadMs: 0 };
      sample = { peakRss: runnerRssKb(), minAvail: memAvailKb() };
      const t0 = Date.now();
      const dir = join(a.work, "tasks", `${r.model.replace(/[^\w.-]/g, "_")}`, `s${seed}`, c, ex);
      promptLog = join(out, "prompts", `s${seed}`, c, `${ex}.jsonl`);
      mkdirSync(dirname(promptLog), { recursive: true });
      writeFileSync(promptLog, "");
      let res;
      try {
        res = cfg.kind === "openarc"
          ? await runOpenArc({ dataset: a.dataset, ex, splitInfo, model: r.model, cfg, dir, oaModules, port, backend, seed })
          : await runBaseline({ dataset: a.dataset, ex, splitInfo, model: r.model, cfg, dir, port, backend, seed });
      } catch (e) { res = { error: String(e?.stack ?? e).slice(0, 1000) }; }
      const rec = {
        ts: new Date().toISOString(), exercise: ex, config: c, seed, configDef: cfg, model: r.model, openarcVersion: oaVersion, backend,
        wallMs: Date.now() - t0, modelCalls: meter.calls, promptTokens: meter.prompt, evalTokens: meter.eval, modelMs: Math.round(meter.evalMs), modelLoadMs: Math.round(meter.loadMs),
        peakRunnerRssKb: sample.peakRss, minMemAvailableKb: sample.minAvail,
        split: { public: Object.fromEntries(Object.entries(splitInfo.examples).map(([f, e]) => [f, e.length])), heldOut: splitInfo.heldOut.length },
        ...res,
      };
      promptLog = null;
      appendFileSync(jsonl, JSON.stringify(rec) + "\n");
      note(`${key}: held-out ${res.heldOut?.passed ?? "?"}/${res.heldOut?.total ?? "?"} public ${res.publicPass} attempts ${res.attempts} tokens ${meter.prompt}+${meter.eval} ${(rec.wallMs / 1000).toFixed(0)}s rss ${Math.round(sample.peakRss / 1024)}MB minAvail ${Math.round(sample.minAvail / 1024)}MB${res.error ? " ERROR " + res.error.split("\n")[0] : ""}`);
    }
  }
}
await unloadAll();
note("done");
process.exit(0);
