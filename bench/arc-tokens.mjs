#!/usr/bin/env node
// Pre-registered token experiment on the evolve-multi scenario (experiments/arc-tokens.md). Two arms, same model, sampling,
// output cap, retry budget and scoring:
//   B  the evolve-multi plain-prompt arm D (lib/multi.mjs stepD): per touched file, the whole current file + the change,
//      the complete file back, up to 3 attempts with that file's failing public examples as feedback
//   A  per target function, the module's `.arc` (`openarc decompile` on the current code, no model) + that function's
//      current code + the change for its exercise, the body back (arc prompt's contract), up to 3 attempts with that
//      function's failing public examples as feedback
// One results row per (arm, step), appended to <out>/arc-tokens.jsonl; a rerun skips the rows already there.
//
// node arc-tokens.mjs --dataset <ts-bench> [--matrix matrix-evolve-multi.json] [--seed 1] [--out <dir>] [--work <dir>] [--port n] [--oa <openarc main.ts>]
// node arc-tokens.mjs --dataset <ts-bench> --dry-run      every first-attempt prompt of both arms, no model
// node arc-tokens.mjs --report <out>/arc-tokens.jsonl     the per-step table and the pre-registered verdict
// --steps <json>: another scenario (the check uses it); --set test is refused
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { spawnSync } from "node:child_process";
import { BENCH, EXERCISES, prepareTestDir, run, runTests, split, typedStub } from "./lib/common.mjs";
import { chat, extractCode } from "./lib/baseline.mjs";
import { SCENARIO, SYSTEM, applyHand, askD, changeText, fileOf, fnsOf, grow, handPresent, memAvailMb, meterProxy, publicTests, score, stepD, touched } from "./lib/multi.mjs";

const { values: a } = parseArgs({ options: {
  dataset: { type: "string", default: process.env.TS_BENCH_DIR }, matrix: { type: "string", default: join(BENCH, "matrix-evolve-multi.json") },
  seed: { type: "string", default: "1" }, out: { type: "string" }, work: { type: "string" }, port: { type: "string", default: "18443" },
  oa: { type: "string", default: join(BENCH, "../stage0/src/main.ts") }, steps: { type: "string" }, set: { type: "string", default: "dev" },
  "dry-run": { type: "boolean" }, report: { type: "string" },
} });
const die = (m, code = 3) => { console.error(m); process.exit(code); };

// ── the pre-registered decision rule (experiments/arc-tokens.md) ──
function verdict(rows) {
  const by = {};
  for (const r of rows) (by[r.i] ??= {})[r.arm] = r;
  const steps = Object.values(by).sort((x, y) => (x.A ?? x.B).i - (y.A ?? y.B).i);
  const missing = steps.filter((s) => !s.A || !s.B).map((s) => (s.A ?? s.B).step);
  const excluded = steps.filter((s) => s.A?.arcError).map((s) => ({ step: s.A.step, why: s.A.arcError }));
  const kept = steps.filter((s) => s.A && s.B && !s.A.arcError);
  const t = (arm) => kept.reduce((n, s) => n + s[arm].prompt + s[arm].eval, 0);
  const c = (arm) => kept.filter((s) => s[arm].correct).length; // secondary, outside the rule
  // a function-step: one exercise present after a step (row.heldOut has one entry per exercise added so far); correct if it passes all its held-out tests
  const fsOk = (r) => Object.values(r.heldOut).filter((h) => h.allPass).length;
  const f = (arm) => kept.reduce((n, s) => n + fsOk(s[arm]), 0);
  // tolerance from the scenario: every step's function-steps, excluded ones included, 10% rounded down, at least 1
  const fnSteps = steps.reduce((n, s) => n + Object.keys((s.B ?? s.A).heldOut).length, 0), tolerance = Math.max(1, Math.floor(fnSteps / 10));
  const tokensA = t("A"), tokensB = t("B"), correctA = c("A"), correctB = c("B"), fnA = f("A"), fnB = f("B");
  const computable = !missing.length && kept.length > 0 && tokensB > 0;
  const tokenOk = 10 * tokensA <= 7 * tokensB, correctOk = fnA >= fnB - tolerance; // integers: A <= 0.7 B
  return { steps, kept, missing, excluded, tokensA, tokensB, correctA, correctB, fnA, fnB, fnSteps, tolerance, ratio: tokensB ? tokensA / tokensB : null, tokenOk, correctOk,
    result: !computable ? "not computable" : tokenOk && correctOk ? "supported" : "not supported" };
}

if (a.report) {
  const rows = readFileSync(a.report, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const v = verdict(rows);
  const cell = (r) => r ? `${r.prompt} | ${r.eval} | ${r.calls} | ${Object.values(r.heldOut).filter((h) => h.allPass).length}/${Object.keys(r.heldOut).length} | ${r.correct ? "yes" : "no"} | ${(r.wallMs / 1000).toFixed(1)}` : "- | - | - | - | - | -";
  console.log("| # | step | B in | B out | B calls | B fns correct | B step correct | B s | A in | A out | A calls | A fns correct | A step correct | A s |\n|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const s of v.steps) console.log(`| ${(s.A ?? s.B).i} | ${(s.A ?? s.B).step}${s.A?.arcError ? " (excluded)" : ""} | ${cell(s.B)} | ${cell(s.A)} |`);
  console.log(`\nsteps counted ${v.kept.length}; missing ${v.missing.length ? v.missing.join(", ") : "none"}; excluded ${v.excluded.length ? v.excluded.map((e) => `${e.step}: ${e.why}`).join("; ") : "none"}`);
  console.log(`tokens (input + output): B ${v.tokensB}, A ${v.tokensA}, A/B ${v.ratio === null ? "-" : v.ratio.toFixed(3)}`);
  console.log(`correct function-steps: B ${v.fnB}, A ${v.fnA} (tolerance ${v.tolerance}: 10% of ${v.fnSteps} function-steps, rounded down, at least 1)`);
  console.log(`correct steps (cumulative, secondary, not in the rule): B ${v.correctB}, A ${v.correctA}`);
  console.log(`rule: A/B <= 0.70 ${v.tokenOk ? "yes" : "no"}; A function-steps >= B function-steps - ${v.tolerance} ${v.correctOk ? "yes" : "no"}`);
  console.log(`verdict: ${v.result}`);
  process.exit(v.result === "not computable" ? 1 : 0);
}

// ── setup ──
if (a.set !== "dev") die(`--set ${a.set}: refused. This experiment runs on the dev split only; the test split (exercises.json sets.test) is held out for the final check of the project and must not be used here.`);
if (!a.dataset) die("--dataset <ts-bench clone> (or TS_BENCH_DIR) is required; see fetch-dataset.sh", 2);
const STEPS = a.steps ? JSON.parse(readFileSync(a.steps, "utf8")) : SCENARIO;
const all = [...new Set(STEPS.flatMap((s) => Object.values(s.add ?? {}).flat()))];
const dev = EXERCISES.sets?.dev ?? [];
const outside = all.filter((ex) => !dev.includes(ex));
if (outside.length) die(`refused: ${outside.join(", ")} not in the dev split (exercises.json sets.dev). The test split is held out for the final check.`);

const matrix = JSON.parse(readFileSync(a.matrix, "utf8"));
const backend = matrix.backend, model = matrix.runs[0].model, seed = +a.seed, port = +a.port, dry = a["dry-run"];
const out = resolve(a.out ?? join(BENCH, "results/arc-tokens", `${model}-s${seed}`));
const work = resolve(a.work ?? join(out, "work")); // absolute: the test runner gets paths relative to nothing
mkdirSync(out, { recursive: true });
const jsonl = join(out, "arc-tokens.jsonl");
const note = (m) => { const l = `${new Date().toISOString()} ${m}`; console.log(l); if (!dry) appendFileSync(join(out, "run.log"), l + "\n"); };
const git = (...x) => spawnSync("git", ["-C", BENCH, ...x], { encoding: "utf8" }).stdout?.trim();
const commit = (git("rev-parse", "HEAD") || "unknown") + (git("status", "--porcelain", "--", ".", "../stage0/src") ? "+dirty" : ""); // dirty: uncommitted harness or openarc changes
const splits = {};
for (const ex of all) {
  splits[ex] = await split(a.dataset, ex, work);
  if (!splits[ex].tests.length) die(`the split of ${ex} recorded no tests (sandbox or dataset problem); delete ${join(work, "splits", ex + ".json")} after fixing it`, 2);
}
const ctx = { dataset: a.dataset, splits, backend, port, model, seed, oaModules: join(BENCH, "../stage0/node_modules") };
let meter = { calls: 0, prompt: 0, eval: 0 };
if (!dry) meterProxy(backend, port, (j) => { meter.calls++; meter.prompt += j.usage?.prompt_tokens ?? 0; meter.eval += j.usage?.completion_tokens ?? 0; });

// ── arm A ──
// arc prompt's system line (stage0/src/arcsync.ts), made plural: a step can target several functions of one file
const SYSTEM_A = "You write function bodies. For each function asked for, in the order asked, you output exactly one fenced code block holding that body's statements only: no signature, no outer braces, no imports.";
// A's files are typedStub output with bodies filled in, every body line indented: `\n}\n` ends a function and nothing else
const fnRe = (fn) => new RegExp(`(export function ${fn}\\([^\\n]*\\{\\n)([\\s\\S]*?)(\\n\\}\\n)`);
const splice = (src, fn, body) => src.replace(fnRe(fn), (_, head, _old, tail) => head + body.split("\n").map((l) => (l.trim() ? "  " + l : "")).join("\n") + tail);
// ponytail: a block that repeats the signature is unwrapped (arc accept would refuse it); D's extractCode is lenient too
const bodyOf = (code, fn) => (code.match(new RegExp(`^\\s*(?:export\\s+)?function\\s+${fn}\\s*\\([^)]*\\)[^{]*\\{([\\s\\S]*)\\}\\s*$`))?.[1] ?? code).replace(/^\s*\n|\s+$/g, "");
/** one body per target, in order: the reply's code blocks in order (one target: extractCode, as D) */
const bodiesOf = (reply, fns) => {
  const text = reply.replace(/<think>[\s\S]*?<\/think>/g, "");
  const blocks = fns.length === 1 ? [extractCode(text)] : [...text.matchAll(/```(?:ts|typescript|js|javascript)?\s*\n([\s\S]*?)```/g)].map((m) => m[1]);
  return fns.map((fn, k) => bodyOf(blocks[k] ?? "", fn));
};
const names = (fns) => fns.map((fn) => `\`${fn}\``).join(fns.length > 2 ? ", " : " and ");
const askA = (arc, f, fns, current, change) => `\`.arc\` spec of \`${f}.ts\` (written by \`openarc decompile\` from the current code):\n\n\`\`\`\n${arc.trim()}\n\`\`\`\n\nWrite the bod${fns.length > 1 ? `ies of ${names(fns)} in \`${f}.ts\` (TypeScript), in that order` : `y of ${names(fns)} in \`${f}.ts\` (TypeScript)`}.\nCurrent code:\n\n\`\`\`ts\n${current}\n\`\`\`\n\n${change}\n\nReturn ${fns.length > 1 ? "one code block per function, each holding the body only" : "the body only"}.`;
/** the functions a step changes in file f: those of the exercises it adds there, and of a changed intent there */
const targets = (st, f, layout) => [...(st.add?.[f] ?? []), ...(st.intent && fileOf(layout, st.intent) === f ? [st.intent] : [])].flatMap((ex) => fnsOf(ex).map((fn) => [ex, fn]));

async function decompile(f, src) {
  const d = join(work, "decompile");
  await rm(d, { recursive: true, force: true });
  await mkdir(join(d, "src"), { recursive: true });
  await writeFile(join(d, "package.json"), JSON.stringify({ name: "arc-tokens", private: true, type: "module" }));
  await writeFile(join(d, "src", `${f}.ts`), src);
  const r = await run([process.execPath, "--no-warnings", a.oa, "decompile", "src", "--out=arc/spec"], { cwd: d, timeoutMs: 300_000 });
  const p = join(d, "arc/spec", `${f}.arc`);
  if (r.code !== 0 || !existsSync(p)) return { error: `decompile exit ${r.code}${r.timedOut ? " (timeout)" : ""}: ${(r.stderr || r.stdout).trim().split("\n").slice(-3).join(" ").slice(0, 300)}` };
  return { arc: await readFile(p, "utf8") };
}

// ── dry run: earlier steps' code is stand-in code a model wrote before (config D finalSource in results/*/tasks.jsonl) ──
let pool;
function standin(ex) {
  pool ??= readdirSync(join(BENCH, "results")).sort().flatMap((d) => { const p = join(BENCH, "results", d, "tasks.jsonl"); return existsSync(p) ? readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => { try { return { ...JSON.parse(l), dir: d }; } catch { return null; } }) : []; }).filter((r) => r?.config === "D" && r.finalSource);
  // the one passing the most held-out tests, the latest of those (results dirs sort by date)
  const rows = pool.filter((r) => r.exercise === ex), best = Math.max(...rows.map((x) => x.heldOut?.passed ?? 0)), r = rows.filter((x) => (x.heldOut?.passed ?? 0) === best).at(-1);
  if (!r) throw new Error(`no stand-in code for ${ex} in results/*/tasks.jsonl`);
  return { src: r.finalSource.replace(/^import .*\n/gm, "").trim(), from: `${r.dir} ${r.model} held-out ${r.heldOut?.passed}/${r.heldOut?.total}` };
}
const standinBody = (ex, fn) => { const [, p] = EXERCISES.functions[ex].fns[fn].match(/^\((.*)\) => /); return `${standin(ex).src.replace(/^export (default )?/gm, "")}\nreturn ${fn}(${p.split(",").map((x) => x.split(":")[0].trim()).filter(Boolean).join(", ")});`; };

async function stepA(dir, st, layout, code, rec) {
  const path = (f) => join(dir, `${f}.ts`);
  let attempts = 0, publicPass = true;
  if (!st.none) for (const f of touched(st, layout)) {
    for (const ex of st.add?.[f] ?? []) code[f] = (code[f] ? code[f] + "\n" : "") + typedStub(ex);
    await writeFile(path(f), code[f]);
    const t0 = Date.now(), dc = await decompile(f, code[f]);
    rec.decompileMs += Date.now() - t0;
    const tg = targets(st, f, layout), fns = tg.map(([, fn]) => fn);
    const lost = dc.error ?? (fns.filter((fn) => !new RegExp(`^(async )?fn ${fn}\\(`, "m").test(dc.arc)).map((fn) => `decompile listed no fn ${fn}`).join("; ") || undefined);
    if (lost) { rec.arcError = [rec.arcError, `${f}.ts: ${lost}`].filter(Boolean).join("; "); publicPass = false; continue; } // no call: excluded in the report
    rec.arcChars += dc.arc.length;
    // the change request is D's, word for word
    const messages = [{ role: "system", content: SYSTEM_A }, { role: "user", content: askA(dc.arc, f, fns, fns.map((fn) => code[f].match(fnRe(fn))[0].trim()).join("\n\n"), changeText(ctx, st, f, layout)) }];
    rec.inputChars += messages[0].content.length + messages[1].content.length;
    rec.prompts.push({ file: f, fns, chars: messages[0].content.length + messages[1].content.length, ...(dry ? { messages } : {}) });
    if (dry) { for (const [ex, fn] of tg) code[f] = splice(code[f], fn, standinBody(ex, fn)); continue; }
    await writeFile(join(dir, `${f}.public.test.ts`), publicTests(ctx, f, layout[f]));
    const total = tg.reduce((n, [ex, fn]) => n + splits[ex].examples[fn].length, 0);
    let ok = false;
    for (let i = 1; i <= 3 && !ok; i++) {
      attempts++;
      const reply = await chat(backend, port, model, messages, { seed, temperature: 0 });
      const bodies = bodiesOf(reply, fns), next = fns.reduce((src, fn, k) => splice(src, fn, bodies[k]), code[f]);
      await writeFile(path(f), next);
      const pt = await runTests(join(dir, `${f}.public.test.ts`));
      const mine = pt.lines.filter((l) => fns.some((fn) => l.name.startsWith(`${fn}: `))), failed = mine.filter((l) => !l.ok);
      ok = mine.length === total && !failed.length;
      if (ok || i === 3) code[f] = next;
      if (!ok) messages.push({ role: "assistant", content: reply }, { role: "user", content: `The code fails these examples:\n${pt.lines.length ? (failed.length ? failed.map((l) => `- ${l.name}: ${l.msg}`).join("\n").slice(0, 3000) : `- no result for ${total - mine.length} of the examples (crash or timeout)`) : `The file did not load:\n${pt.stderr.split("\n").filter(Boolean).slice(-8).join("\n")}`}\n\nFix it and return the corrected ${fns.length > 1 ? "bodies, one code block per function" : "body only"}.` });
    }
    publicPass &&= ok;
  }
  for (const [f, c] of Object.entries(code)) await writeFile(path(f), c);
  return { attempts, publicPass };
}

// ── B in the dry run: the prompt D would send, the stand-in file as its reply ──
function dryB(st, layout, code, rec) {
  if (st.none) return;
  for (const f of touched(st, layout)) {
    const messages = [{ role: "system", content: SYSTEM }, { role: "user", content: askD(ctx, st, f, layout, code) }];
    const chars = messages[0].content.length + messages[1].content.length;
    rec.inputChars += chars; rec.prompts.push({ file: f, chars, messages });
    for (const ex of st.add?.[f] ?? []) code[f] = (code[f] ? code[f] + "\n\n" : "") + standin(ex).src;
  }
}

// ── the run ──
const done = !dry && existsSync(jsonl) ? readFileSync(jsonl, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.model === model && r.seed === seed) : [];
const handFrom = STEPS.findIndex((s) => s.hand);
const est = (c) => Math.round(c / 4);
const dryRows = [];
const state = {};
for (const arm of ["B", "A"]) {
  const dir = join(work, `s${seed}`, arm);
  await mkdir(dir, { recursive: true });
  await prepareTestDir(dir);
  state[arm] = { dir, layout: {}, code: {}, prev: null };
}
for (const [i, st] of STEPS.entries()) {
  for (const arm of ["B", "A"]) {
    const s = state[arm];
    grow(s.layout, st.add);
    const had = done.find((r) => r.arm === arm && r.i === i);
    if (had) { s.code = { ...had.code }; s.prev = had; continue; }
    if (!dry && memAvailMb() < 1536) { note(`MemAvailable ${memAvailMb() | 0} MB < 1.5 GB: stop`); process.exit(4); }
    if (st.hand && s.code.grid) s.code.grid = applyHand(s.code.grid); // A's ofSize keeps its shape: typedStub's `export function`, HAND indented
    const rec = { inputChars: 0, prompts: [], decompileMs: 0, arcChars: 0 };
    if (dry) {
      if (arm === "B") dryB(st, s.layout, s.code, rec); else await stepA(s.dir, st, s.layout, s.code, rec);
      dryRows.push({ i, arm, step: st.name, exercises: [...new Set(Object.values(st.add ?? {}).flat().concat(st.intent ?? []))], ...rec });
      continue;
    }
    for (const [f, c] of Object.entries(s.code)) await writeFile(join(s.dir, `${f}.ts`), c);
    meter = { calls: 0, prompt: 0, eval: 0 };
    const t0 = Date.now();
    let res;
    try {
      res = arm === "B" ? await stepD(ctx, s.dir, st, s.layout, s.code) : await stepA(s.dir, st, s.layout, s.code, rec);
    } catch (e) { note(`s${seed} ${arm} step ${i} "${st.name}": ${String(e?.message ?? e).slice(0, 300)}; nothing written for this step, rerun to resume`); process.exit(5); }
    const wallMs = Date.now() - t0;
    const heldOut = await score(ctx, s.dir, s.layout, (f) => join(s.dir, `${f}.ts`));
    const row = {
      arm, i, step: st.name, seed, model, commit, backend: backend.info, ...meter, ...res, wallMs,
      ...(arm === "A" ? { decompileMs: rec.decompileMs, arcChars: rec.arcChars, arcError: rec.arcError } : {}),
      hand: handFrom >= 0 && i >= handFrom ? handPresent(s.code.grid ?? "") : undefined,
      heldOut, correct: Object.values(heldOut).every((h) => h.allPass),
      regressions: s.prev ? Object.keys(s.prev.heldOut).filter((ex) => s.prev.heldOut[ex].allPass && !heldOut[ex]?.allPass) : [],
      code: s.code,
    };
    appendFileSync(jsonl, JSON.stringify(row) + "\n");
    s.prev = row;
    note(`s${seed} ${arm} ${i} ${st.name}: calls ${row.calls} tokens ${row.prompt}+${row.eval} ${(wallMs / 1000).toFixed(1)}s ${row.correct ? "CORRECT" : "held-out " + Object.entries(heldOut).filter(([, h]) => !h.allPass).map(([ex, h]) => `${ex} ${h.passed}/${h.total}`).join(", ")}${row.arcError ? ` arcError ${row.arcError}` : ""}`);
  }
}

if (dry) {
  console.log(`arc-tokens dry run: ${STEPS.length} steps (dev split), first-attempt INPUT of each arm (system + user message), no model called.`);
  console.log("Tokens are an ESTIMATE: characters / 4 (the repo has no tokenizer). Repairs (attempts 2-3) and output are not included.");
  console.log(`Earlier steps' code is stand-in code from earlier runs (config D finalSource): ${all.map((ex) => `${ex} <- ${standin(ex).from}`).join("; ")}\n`);
  console.log("| # | step | exercises | B prompts | B chars | B est tok | A prompts | A chars | A est tok | .arc chars | A/B |\n|---|---|---|---|---|---|---|---|---|---|---|");
  let tb = 0, ta = 0, nb = 0, na = 0;
  const errs = [];
  for (const [i, st] of STEPS.entries()) {
    const b = dryRows.find((r) => r.i === i && r.arm === "B"), x = dryRows.find((r) => r.i === i && r.arm === "A");
    tb += b.inputChars; ta += x.inputChars; nb += b.prompts.length; na += x.prompts.length;
    if (x.arcError) errs.push(`${st.name}: ${x.arcError}`);
    console.log(`| ${i} | ${st.name} | ${b.exercises.join(", ")} | ${b.prompts.length} | ${b.inputChars} | ${est(b.inputChars)} | ${x.prompts.length} | ${x.inputChars} | ${est(x.inputChars)} | ${x.arcChars} | ${b.inputChars ? (x.inputChars / b.inputChars).toFixed(2) : "-"} |`);
  }
  console.log(`| | total | | ${nb} | ${tb} | ${est(tb)} | ${na} | ${ta} | ${est(ta)} | | ${(ta / tb).toFixed(2)} |`);
  writeFileSync(join(out, "dry-run.jsonl"), dryRows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  console.log(`\nevery prompt: ${join(out, "dry-run.jsonl")}`);
  console.log(`decompile failures: ${errs.length}${errs.length ? "\n" + errs.map((e) => `- ${e}`).join("\n") : ""}`);
}
process.exit();
