#!/usr/bin/env node
// Dependency-suggestion benchmark (issue #50). For each task: a fresh project with one pending region, then
// `openarc deps suggest <id> --json --keep`, which compiles the region without a new dependency and with each candidate
// that passes the fact filter, and proposes one or none. Records, per task: whether a dep was proposed (and whether that
// was right: tasks/*.heldout.mjs meta.expectLib), and for the arm without and the arm with the proposed dep: verified,
// attempts, tokens, wall time, mutant score, held-out pass rate. See ../README.md, "Dependency suggestions".
//
// node bench/deps/run.mjs --base-url http://127.0.0.1:8080/v1 --model <id> [--tasks a,b] [--max 2] [--out <dir>]
//   [--work <dir>] [--oa <openarc main.ts or .js>] [--backend-json '{"maxContextTokens":16384}']
import { spawnSync } from "node:child_process";
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";

const HERE = dirname(new URL(import.meta.url).pathname);
const STAGE0 = resolve(HERE, "../../stage0");
const { values: a } = parseArgs({ options: {
  "base-url": { type: "string" }, model: { type: "string" }, tasks: { type: "string" }, max: { type: "string", default: "2" },
  out: { type: "string" }, work: { type: "string", default: join(tmpdir(), "openarc-bench-deps") },
  oa: { type: "string", default: join(STAGE0, "src/main.ts") }, "backend-json": { type: "string" },
} });
if (!a["base-url"] || !a.model) throw new Error("--base-url <OpenAI-compatible /v1 URL> and --model <id> are required");
const all = readdirSync(join(HERE, "tasks")).filter((f) => f.endsWith(".heldout.mjs")).map((f) => f.replace(".heldout.mjs", "")).sort();
const tasks = a.tasks ? a.tasks.split(",") : all;
const out = a.out ?? join(HERE, "../results", `${new Date().toISOString().slice(0, 10)}-deps`);
mkdirSync(out, { recursive: true });
const jsonl = join(out, "tasks.jsonl");

const oa = (args, cwd) => {
  const r = spawnSync(process.execPath, ["--no-warnings", a.oa, ...args], { cwd, encoding: "utf8", maxBuffer: 64 << 20 });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
};
// The held-out importer loads candidate package code: the node tier `check` uses (reads limited to the copy, this
// directory and open-arc's core; no writes, children or network on node >= 25), and an empty environment.
// ponytail: no bwrap here; run the bench on node >= 25 or inside a container if candidates are untrusted.
const heldOut = (dir, task) => {
  const reads = [dir, HERE, join(STAGE0, "core")].map((p) => `--allow-fs-read=${realpathSync(p)}`);
  const r = spawnSync(process.execPath, ["--no-warnings", "--permission", ...reads, join(HERE, "heldout.mjs"), dir, task], { encoding: "utf8", timeout: 60_000, env: {} });
  try { return JSON.parse(r.stdout); } catch { return { passed: 0, total: null, error: (r.stderr || "no output").slice(0, 300) }; }
};
const armRow = (arm, task) => arm && { verified: arm.verified, attempts: arm.attempts, tokens: arm.tokens, modelCalls: arm.modelCalls, ms: arm.ms, mutants: arm.mutants, usesPkg: arm.usesPkg, heldOut: arm.dir ? heldOut(arm.dir, task) : null };

for (const task of tasks) {
  const { meta } = await import(join(HERE, "tasks", `${task}.heldout.mjs`));
  const spec = readFileSync(join(HERE, "tasks", `${task}.ts`), "utf8");
  const id = /id: "([^"]+)"/.exec(spec)[1];
  const root = join(a.work, task), proj = join(root, "project");
  rmSync(root, { recursive: true, force: true });
  mkdirSync(join(proj, "src"), { recursive: true });
  mkdirSync(join(proj, "node_modules"));
  // open-arc from this checkout; listed in package.json so `npm install <candidate>` in a trial copy keeps it
  writeFileSync(join(proj, "package.json"), JSON.stringify({ name: `deps-bench-${task}`, private: true, type: "module", devDependencies: { "open-arc": `file:${join(STAGE0, "core")}` } }, null, 2) + "\n");
  symlinkSync(join(STAGE0, "core"), join(proj, "node_modules", "open-arc"));
  const init = oa(["init", "--backend", "local", "--model", a.model, "--base-url", a["base-url"], "--no-example"], proj);
  if (init.code !== 0) throw new Error(`init failed: ${init.stderr}`);
  if (a["backend-json"]) {
    const cfg = JSON.parse(readFileSync(join(proj, "openarc.config.json"), "utf8"));
    Object.assign(cfg.backends.local, JSON.parse(a["backend-json"]));
    writeFileSync(join(proj, "openarc.config.json"), JSON.stringify(cfg, null, 2) + "\n");
  }
  writeFileSync(join(proj, "src", `${task}.ts`), spec);
  oa(["scaffold"], proj);

  const t0 = Date.now();
  const s = oa(["deps", "suggest", id, "--json", "--keep", "--max", a.max], proj);
  const suggestMs = Date.now() - t0;
  let rep;
  try { rep = JSON.parse(s.stdout); } catch { rep = { error: `deps suggest exit ${s.code}: ${(s.stderr || s.stdout).slice(-500)}` }; }
  let without = rep.without;
  if (!without) { // nothing was trialled (declined before the trial, or suggest failed): compile the plain arm here
    const w = join(root, "without");
    cpSync(proj, w, { recursive: true, verbatimSymlinks: true });
    const t1 = Date.now();
    const c = oa(["compile", id], w);
    const e = JSON.parse(readFileSync(join(w, ".openarc/manifest.json"), "utf8")).regions[id];
    const tk = e?.provenance?.tokens;
    without = { verified: c.code === 0 && e?.ownership === "compiler", attempts: e?.provenance?.attempts ?? null, tokens: tk ? tk.prompt + tk.completion : null, modelCalls: Number(/(\d+) model call/.exec(c.stderr)?.[1] ?? NaN), ms: Date.now() - t1, mutants: null, usesPkg: false, dir: w };
  }
  const p = rep.proposal ?? null;
  const withArm = p ? rep.candidates.find((c) => c.name === p.name)?.trial?.with : null;
  const row = {
    ts: new Date().toISOString(), task, id, model: a.model, baseUrl: a["base-url"], expectLib: meta.expectLib,
    proposed: p ? `${p.name}@${p.version}` : null, correct: !!p === meta.expectLib,
    query: rep.query ?? null, querySource: rep.querySource ?? null, declined: rep.declined ?? null, error: rep.error ?? null,
    candidates: (rep.candidates ?? []).map((c) => ({ name: c.name, rejected: c.rejected, verdict: c.verdict })),
    suggestMs, without: armRow(without, task), with: armRow(withArm, task),
  };
  appendFileSync(jsonl, JSON.stringify(row) + "\n");
  for (const d of [rep.without?.dir, ...(rep.candidates ?? []).map((c) => c.trial?.with?.dir)]) if (d) rmSync(d, { recursive: true, force: true }); // --keep copies, in the OS temp dir
  const ho = (x) => (x?.heldOut ? `${x.heldOut.passed}/${x.heldOut.total}` : "-");
  console.log(`${task.padEnd(18)} expect ${meta.expectLib ? "lib " : "none"} proposed ${(row.proposed ?? "-").padEnd(22)} ${row.correct ? "ok   " : "WRONG"} held-out without ${ho(row.without)} with ${ho(row.with)} tokens ${row.without?.tokens ?? "?"} -> ${row.with?.tokens ?? "-"} ${(suggestMs / 1000).toFixed(0)}s${row.error ? ` ERROR ${row.error.split("\n")[0]}` : ""}`);
}
console.log(`results: ${jsonl}`);
