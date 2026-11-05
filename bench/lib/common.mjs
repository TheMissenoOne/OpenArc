import { spawn } from "node:child_process";
import { mkdir, writeFile, readFile, copyFile, symlink } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const BENCH = dirname(dirname(fileURLToPath(import.meta.url)));
// BENCH_EXERCISES: another task list in the same shape (the MultiPL-E training pool, train-pool.mjs)
export const EXERCISES = JSON.parse(readFileSync(process.env.BENCH_EXERCISES ?? join(BENCH, "exercises.json"), "utf8"));
export const PUBLIC_PER_FN = +(process.env.BENCH_PUBLIC ?? 3); // more public examples: use a separate --work (splits are cached there)

/** Where a client should send requests for `backend`: our token-counting proxy, keeping the upstream path (e.g. /v1). */
export const proxyBase = (backend, port) => `http://127.0.0.1:${port}${new URL(backend.baseUrl).pathname.replace(/\/$/, "")}`;

export const exDir = (dataset, ex) => join(dataset, "repos/exercism-typescript/exercises/practice", ex);

/** Kill a detached child and its whole process group. */
export function killTree(child) {
  try { process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch {} }
}

/** Run a process; resolves {code, stdout, stderr, timedOut, ms}. */
export function run(argv, { cwd, timeoutMs = 600_000, env } = {}) {
  return new Promise((done) => {
    const t0 = Date.now();
    const child = spawn(argv[0], argv.slice(1), { cwd, env: env ?? process.env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    let stdout = "", stderr = "", timedOut = false;
    child.stdout.on("data", (b) => (stdout += b));
    child.stderr.on("data", (b) => (stderr += b));
    const timer = setTimeout(() => { timedOut = true; killTree(child); }, timeoutMs);
    child.on("close", (code) => { clearTimeout(timer); done({ code, stdout, stderr, timedOut, ms: Date.now() - t0 }); });
    run.current = child;
  });
}

/** Make `dir` able to run Exercism tests: '@jest/globals' resolves to our shim. */
export async function prepareTestDir(dir, links = {}) {
  const g = join(dir, "node_modules/@jest/globals");
  await mkdir(g, { recursive: true });
  await writeFile(join(g, "package.json"), JSON.stringify({ name: "@jest/globals", type: "module", main: "index.mjs" }));
  await writeFile(join(g, "index.mjs"), `export * from ${JSON.stringify(join(BENCH, "lib/jest-shim.mjs"))};\n`);
  for (const [name, target] of Object.entries(links)) await symlink(target, join(dir, "node_modules", name)).catch(() => {});
}

/**
 * Run a test file in a read-only, network-less bwrap sandbox (generated code is untrusted), 512 MB heap, 60 s CPU.
 * Returns per-test lines; tests that never reported (crash, timeout, infinite loop) are absent: callers count them as failures.
 */
export async function runTests(testFile, { record = false, timeoutMs = 90_000 } = {}) {
  const argv = [
    "bwrap", "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--unshare-all", "--die-with-parent",
    "prlimit", "--cpu=60", "--",
    process.execPath, "--max-old-space-size=512", "--experimental-transform-types", "--no-warnings",
    join(BENCH, "lib/run-tests.mjs"), testFile, ...(record ? ["--record"] : []),
  ];
  const r = await run(argv, { cwd: dirname(testFile), timeoutMs });
  const lines = [];
  let done = null;
  for (const l of r.stdout.split("\n")) {
    if (!l.trim()) continue;
    try { const j = JSON.parse(l); if ("done" in j) done = j.done; else lines.push(j); } catch {}
  }
  return { lines, done, stderr: r.stderr.slice(-2000), timedOut: r.timedOut };
}

/** The exercise instructions (+ append), headings and HTML comments removed. `cap: false` (A-same-info) skips the 2500-char cap. */
export function instructions(dataset, ex, { cap = true } = {}) {
  const d = join(exDir(dataset, ex), ".docs");
  let s = readFileSync(join(d, "instructions.md"), "utf8");
  if (existsSync(join(d, "instructions.append.md"))) s += "\n" + readFileSync(join(d, "instructions.append.md"), "utf8");
  s = s.replace(/^# Instructions( append)?\s*$/gim, "").replace(/<!--[\s\S]*?-->/g, "").replace(/\n{3,}/g, "\n\n").trim();
  return cap && s.length > 2500 ? s.slice(0, 2500) + " [...]" : s; // ponytail: hard cap; food-chain (2525 chars) hits it, losing only its trailing link
}

export const SPLIT_RULE = `per function and per kind (value, throw), first min(${PUBLIC_PER_FN}, floor(eligible/2)) eligible tests public (file order), rest held out`;

/**
 * Deterministic split. Tests in file order. A test is eligible for function f if it makes exactly one call, to f, with
 * a value or a throw expectation (no `.not`, JSON-encodable). For each f and each of those two kinds, the first
 * min(PUBLIC_PER_FN, floor(eligible / 2)) eligible tests are public examples, so at least half of each kind stay hidden.
 * Every other test is held out.
 */
export function splitTests(ex, fns, lines) {
  const pub = Object.fromEntries(fns.map((f) => [f, []]));
  const kindOf = (t) => {
    const c = t.calls[0];
    if (t.unusable || t.calls.length !== 1 || c.args === undefined) return null;
    return c.throws ? "throws" : "expected" in c ? "expected" : null;
  };
  const eligible = (f, kind) => lines.filter((t) => kindOf(t) === kind && t.calls[0].fn === f).length;
  const cap = (f, kind) => Math.min(PUBLIC_PER_FN, Math.floor(eligible(f, kind) / 2));
  const tests = lines.map((t) => {
    const kind = kindOf(t);
    let isPublic = false;
    if (kind && pub[t.calls[0].fn].filter((e) => kind in e).length < cap(t.calls[0].fn, kind)) {
      const c = t.calls[0];
      pub[c.fn].push({ name: t.name, args: c.args, [kind]: c[kind] });
      isPublic = true;
    }
    return { name: t.name, public: isPublic, eligible: !!kind };
  });
  return { exercise: ex, rule: SPLIT_RULE, examples: pub, tests, heldOut: tests.filter((t) => !t.public).map((t) => t.name) };
}

/** One public example, as the plain-prompt arms see it. */
export const exampleLine = (f, e) => {
  const call = `${f}(${e.args.map((v) => JSON.stringify(v)).join(", ")})`;
  if (e.throws === undefined) return `- ${call} returns ${JSON.stringify(e.expected)}`;
  return `- ${call} throws${e.throws === true ? "" : ` an error whose message contains ${JSON.stringify(e.throws)}`}`;
};

/** One public example as a jest test, for a file with `m` (the module) and `d` (decodes the value tokens) in scope. */
export const exampleTest = (f, e) => {
  const call = `(m as any).${f}(...d(${JSON.stringify(e.args)}))`;
  const check = e.throws === undefined
    ? `expect(${call}).toEqual(d(${JSON.stringify(e.expected)}))`
    : `expect(() => ${call}).toThrow(${e.throws === true ? "" : JSON.stringify(e.throws)})`;
  return `it(${JSON.stringify(`${f}: ${e.name}`)}, () => { ${check} })\n`;
};

/** The split of one exercise (splitTests on a recording of its test file), cached in <work>/splits/<ex>.json while the rule is the same. */
export async function split(dataset, ex, work) {
  const cache = join(work, "splits", `${ex}.json`);
  if (existsSync(cache)) {
    const cached = JSON.parse(await readFile(cache, "utf8"));
    if (cached.rule === SPLIT_RULE) return cached;
  }
  const fns = Object.keys(EXERCISES.functions[ex].fns);
  const dir = join(work, "record", ex);
  await mkdir(dir, { recursive: true });
  await prepareTestDir(dir);
  await copyFile(join(exDir(dataset, ex), `${ex}.test.ts`), join(dir, `${ex}.test.ts`));
  await writeFile(join(dir, `${ex}.ts`), fns.map((f) => `export const ${f} = (...a: unknown[]) => (globalThis as any).__rec(${JSON.stringify(f)}, a);\n`).join(""));
  const { lines } = await runTests(join(dir, `${ex}.test.ts`), { record: true });
  const res = splitTests(ex, fns, lines);
  await mkdir(dirname(cache), { recursive: true });
  await writeFile(cache, JSON.stringify(res, null, 2));
  return res;
}

/** The typed stub both arms start from: shared types + one throwing export per function. */
export function typedStub(ex) {
  const e = EXERCISES.functions[ex];
  const types = e.types ? e.types + "\n\n" : "";
  return types + Object.entries(e.fns).map(([f, t]) => {
    const [, params, ret] = t.match(/^\((.*)\) => (.*)$/);
    return `export function ${f}(${params}): ${ret} {\n  throw new Error("Remove this line and implement the function");\n}\n`;
  }).join("\n");
}

/** Run held-out tests against a solution file. Writes <dir>/<ex>.ts and the test file. */
export async function heldOut(dataset, ex, dir, solutionSrc, splitInfo, links = {}) {
  await prepareTestDir(dir, links);
  await writeFile(join(dir, `${ex}.ts`), solutionSrc);
  await copyFile(join(exDir(dataset, ex), `${ex}.test.ts`), join(dir, `${ex}.test.ts`));
  const r = await runTests(join(dir, `${ex}.test.ts`));
  const byName = new Map(r.lines.map((l) => [l.name, l]));
  const held = splitInfo.heldOut;
  const failed = held.filter((n) => !byName.get(n)?.ok);
  return {
    passed: held.length - failed.length,
    total: held.length,
    allPass: failed.length === 0,
    publicPass: splitInfo.tests.filter((t) => t.public).every((t) => byName.get(t.name)?.ok), // its own examples too
    failed: failed.map((n) => ({ name: n, msg: byName.get(n)?.msg?.slice(0, 200) ?? "no result (crash/timeout/load error)" })),
    loadError: r.lines.length === 0 ? r.stderr.slice(-600) : undefined,
    timedOut: r.timedOut || undefined,
  };
}

/** Deterministic layout for evolve-multi --pack: shuffle by seed, deal into files of `size` functions with no function name twice in a file (both would export it).
 *  rounds: step k adds each file's k-th function, so every prompt is one region with a growing list of siblings. Otherwise `perStep` whole files per step, which compile in batches. */
export function packSteps(fnNames, size, perStep, seed, rounds = false) {
  const ids = Object.keys(fnNames).sort();
  let x = seed >>> 0;
  const rnd = () => (x = (x + 0x6d2b79f5) >>> 0, Math.imul(x ^ (x >>> 15), 1 | x) >>> 0) / 2 ** 32; // ponytail: a small PRNG, only has to be reproducible
  for (let i = ids.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [ids[i], ids[j]] = [ids[j], ids[i]]; }
  const files = [];
  for (const id of ids) {
    let f = files.find((g) => g.length < size && !g.some((o) => fnNames[o].some((n) => fnNames[id].includes(n))));
    if (!f) files.push(f = []);
    f.push(id);
  }
  const steps = [];
  if (rounds) files.forEach((exs, i) => exs.forEach((ex, k) => { (steps[k] ??= { name: `round ${k + 1}`, add: {} }).add[`pack${i}`] = [ex]; }));
  else files.forEach((exs, i) => { const k = Math.floor(i / perStep); (steps[k] ??= { name: `pack step ${k + 1}`, add: {} }).add[`pack${i}`] = exs; });
  return steps;
}
