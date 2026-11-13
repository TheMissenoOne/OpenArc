// `openarc decompile`: read a project's code (TypeScript or JavaScript) into `.arc` specs without changing a byte of it.
// No markers, no model. Per exported function and public method of an exported class (`Class.method`, an instance
// method run on a receiver built fresh per input): the signature from the type checker (inference and JSDoc for JavaScript),
// the intent from its comment, examples by running it in the sandbox on inputs taken from its parameter types and from
// literal calls found in the project (its tests above all), and the test files that use it.
// What it records is `observed`: what the code did, not what it should do. An `example` line is a requirement a person
// confirmed; a later run checks it and never rewrites it. `--check` (checkSpecs below) re-runs both kinds and writes nothing.
// Resumable: a module whose source is unchanged since the last run is not run again.
// With `--run-tests`, the arguments the exported functions receive while the mapped tests run are recorded too
// (core/record.mjs) and become inputs: inputs only, results still come from the sandbox.
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import type { CompileRequest, Ports } from "./types.ts";
import * as engine from "./engine.ts";
import { parseArc, printArc, printExample, printOutcome, printValue, type ArcExample, type ArcFn, type ArcModule, type ArcType } from "./arc.ts";
import { argsFit, checkRules } from "./rules.ts";
import { LANGS, langOf, type FoundFn, type Lang, type ReadModule, type Runner } from "./lang/lang.ts";

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

export interface DecompileCtx {
  ports: Ports;
  root: string;
  request: (p: engine.Project | null, ids: string[]) => CompileRequest;
  log: (line: string) => void;
  /** Source directories, relative to the root. */
  dirs: string[];
  /** Where the `.arc` files go, relative to the root. */
  out: string;
  /** Run the mapped test files with this command (the file is appended), e.g. ["node", "--test"]. Unsandboxed: it is the
   *  project's own test run. Without it, mapped tests are listed and not run. */
  testCmd?: string[];
  /** Run every module again, also unchanged ones. */
  fresh?: boolean;
  /** With testCmd: record the arguments the exported functions receive while the tests run (core/record.mjs). */
  record?: boolean;
  /** `--check`: at most this many generated inputs per function with rules (default 50). */
  ruleInputs?: number;
}

/** tested: its test files ran and passed. failing: one of them fails, or an `example` line does not hold. specified: it has
 *  `example` lines and all hold. observed: only recorded observations. described: an intent only. bare: a signature only.
 *  A state file from before `observed` says `examples` for observed: report() reads it as such. */
export type FnStatus = "tested" | "failing" | "specified" | "observed" | "described" | "bare";
/** origins: per observed line (JSON of its args), where the input came from: `call <file>:<line>`, `recorded <test file>`,
 *  `types` or `kept`. comment: when the intent lines are the code's own comment, their hash (else the intent was written
 *  in the .arc file, or is unknown). */
export interface FnState { status: FnStatus; tests: string[]; why?: string; origins?: Record<string, string>; comment?: string }
export interface ModuleState { hash: string; arc: string; fns: Record<string, FnState>; skipped: Record<string, string> }
export interface DecompileState { version: 1; modules: Record<string, ModuleState> }
export const STATE_FILE = ".openarc/decompile.json";

/** The files some language reads (lang/lang.ts LANGS), and whether one is a test, by its language. */
export const CODE = new RegExp(LANGS.map((l) => l.code.source).join("|"));
export const isTest = (rel: string) => !!langOf(rel)?.isTest(rel);
const inDir = (dir: string, file: string) => dir === "." || file.startsWith(`${dir}/`);
const sha = (t: string) => createHash("sha256").update(t).digest("hex").slice(0, 16);

const codeOrJson = (name: string) => CODE.test(name) || name.endsWith(".json");
/** The files under `dir` (relative to the root; `.` is the root itself) that `keep` accepts, as root-relative paths. */
export async function walk(ports: Ports, dir: string, out: string[] = [], keep = codeOrJson): Promise<string[]> {
  for (const name of (await ports.fs.list(dir)).sort()) {
    const rel = dir === "." ? name : `${dir}/${name}`;
    if (name === "node_modules" || name.startsWith(".")) continue;
    if (keep(name)) { if (!name.endsWith(".d.ts")) out.push(rel); }
    else if (!name.includes(".")) await walk(ports, rel, out, keep);
  }
  return out;
}

// The language-specific reading (signatures, intent, uses, the sandbox run) is behind the seam: src/lang/lang.ts.
export { instrument } from "./lang/ts.ts";

const isThrown = (v: Json): v is { throws: string } => v !== null && typeof v === "object" && !Array.isArray(v) && typeof v.throws === "string" && Object.keys(v).length === 1;
const key = (args: Json[]) => JSON.stringify(args);
const firstLine = (s: string) => s.split("\n")[0]!.slice(0, 200);

/** One call as the code made it: `stable` when a second run gave the same result and changed arguments. receiver: an
 *  instance method's constructor arguments. */
interface Ran { receiver?: Json[]; args: Json[]; got: Json; after?: Json[]; stable: boolean }

/** An instance method: `Class.method` without `static`. Its inputs are `[constructor args, ...method args]`. */
const isInstance = (f: Pick<ArcFn, "name" | "static">) => f.name.includes(".") && !f.static;
/** A call as a log line prints it: `f(1, 2)`, `new Inventory(10).add("apple", 2)`. */
const callText = (name: string, args: Json[], receiver?: Json[]) => {
  const list = (a: Json[]) => a.map(printValue).join(", "), [cls, method] = name.split(".");
  return receiver ? `new ${cls}(${list(receiver)}).${method}(${list(args)})` : `${name}(${list(args)})`;
};
/** An example's input as the sandbox takes it. */
const flat = (e: ArcExample): Json[] => (e.receiver ? [e.receiver, ...e.args] : e.args);

/** One sandbox per language for a whole run, opened on its first call (lang/lang.ts Runner). Each input runs twice. */
function sandbox(ctx: DecompileCtx, texts: Map<string, string>) {
  const runners = new Map<Lang, Runner>();
  return {
    run: async (file: string, fn: Pick<ArcFn, "name" | "static">, inputs: Json[][]): Promise<Ran[] | { error: string }> => {
      const lang = langOf(file)!;
      const runner = runners.get(lang) ?? runners.set(lang, lang.open(ctx, texts)).get(lang)!;
      const got = await runner.observe(file, fn, [...inputs, ...inputs]);
      if ("error" in got) return got;
      const inst = isInstance(fn);
      return inputs.map((_, i) => {
        const a = got[i]!, b = got[i + inputs.length]!, stable = JSON.stringify([a.got, a.after]) === JSON.stringify([b.got, b.after]);
        if (!inst) return { args: a.args, got: a.got, ...(a.after ? { after: a.after } : {}), stable };
        // the receiver's constructor arguments are not the method's: `after` lists the method's arguments only
        const args = a.args.slice(1), after = a.after?.slice(1);
        return { receiver: a.args[0] as Json[], args, got: a.got, ...(after && !isDeepStrictEqual(after, args) ? { after } : {}), stable };
      });
    },
    close: async () => { for (const r of runners.values()) await r.close(); },
  };
}

/** A call's outcome as an `observed` line. */
const recorded = (r: Ran): ArcExample => ({ ...(r.receiver ? { receiver: r.receiver } : {}), args: r.args, ...(isThrown(r.got) ? { throws: r.got.throws } : { expected: r.got, ...(r.after ? { after: r.after } : {}) }), observed: true });

/** The observations worth keeping: repeatable, distinct results, at most 4 returns and 1 throw. An observation of a
 *  function that changes its arguments states them with `after`. */
function observations(ran: Ran[]): ArcExample[] | { error: string } {
  const seen = new Set<string>();
  const distinct = ran.filter((x) => { const k = JSON.stringify([x.got, x.after]); return x.stable && k.length <= 600 && !seen.has(k) && !!seen.add(k); }); // ponytail: a long result is no readable example
  const returned = distinct.filter((x) => !isThrown(x.got)), thrown = distinct.filter((x) => isThrown(x.got));
  if (!returned.length) return thrown.length ? { error: `every input throws: ${(thrown[0]!.got as { throws: string }).throws}` } : [];
  return [...returned.slice(0, 4), ...thrown.slice(0, 1)].map(recorded);
}

/** Why the code does not satisfy requirement `e`, given what the call did (`example (3) => 6: the code returns 4`). */
function unmet(e: ArcExample, r: Ran): string | undefined {
  const now = recorded(r);
  const ok = e.throws !== undefined
    ? now.throws !== undefined && (e.throws === true || (now.throws as string).includes(e.throws))
    : now.throws === undefined && isDeepStrictEqual(now.expected, e.expected) && (e.after === undefined || isDeepStrictEqual(r.after ?? e.args, e.after));
  return ok ? undefined : `${printExample({ ...e, name: undefined })}: the code ${now.throws !== undefined ? printOutcome(now) : `returns ${printOutcome(now)}`}`;
}

/** The project as decompile and check read it: source modules with their exported functions and their uses, each
 *  file read by its language (lang/lang.ts), in the order the directories list them. `just`: read only these source
 *  files, and no tests (their uses are not needed); the texts are still every file's, for the sandbox. */
async function scan(ctx: DecompileCtx, just?: Set<string>) {
  const { ports } = ctx;
  const all = [...new Set((await Promise.all(ctx.dirs.map((d) => walk(ports, d)))).flat())]; // `.` and `src` overlap
  const code = all.filter((f) => CODE.test(f));
  const sources = code.filter((f) => !isTest(f) && (!just || just.has(f)));
  // tests may live outside the source directories
  const tests = just ? [] : [...new Set([...code.filter(isTest), ...(await Promise.all(["tests", "test", "__tests__"].map((d) => walk(ports, d)))).flat().filter((f) => CODE.test(f))])];
  const byFile = new Map<string, ReadModule>(), instrumented = new Map<string, string>();
  for (const lang of LANGS) {
    const src = sources.filter((f) => lang.code.test(f));
    if (!src.length) continue;
    const r = await lang.read(ctx, src, tests.filter((f) => lang.code.test(f)));
    for (const [f, m] of r.modules) byFile.set(f, m);
    for (const [f, t] of r.instrumented) instrumented.set(f, t);
  }
  const read = new Map(sources.flatMap((f) => (byFile.has(f) ? [[f, byFile.get(f)!] as const] : [])));
  const texts = new Map<string, string>();
  for (const f of all) if (!isTest(f)) texts.set(f, (await ports.fs.read(f)) ?? "");
  return { read, texts, instrumented };
}

const RECORDED = ".openarc/recorded";
const RECORDER = fileURLToPath(new URL("../core/record.mjs", import.meta.url)); // the same relative place in the npm build

/** Recording: the instrumented texts under .openarc/recorded/src/ (the sources stay as they are) and their manifest.
 *  Returns the environment a test process gets, and how to collect what it recorded: per "<file>\0<name>", the
 *  argument lists (plain JSON, at most 600 characters each). Recorded files are read as JSON lines only, at most 1 MB
 *  per file; a malformed line, or one naming no exported function, is ignored. */
async function recorder(ctx: DecompileCtx, instrumented: Map<string, string>, wanted: Set<string>) {
  const { ports } = ctx, abs = `${ctx.root}/${RECORDED}`, manifest: Record<string, string> = {};
  await ports.fs.remove(RECORDED); // left by an interrupted run
  for (const [f, text] of instrumented) {
    await ports.fs.write(`${RECORDED}/src/${f}`, text);
    manifest[`${ctx.root}/${f}`] = `${abs}/src/${f}`;
  }
  await ports.fs.write(`${RECORDED}/manifest.json`, JSON.stringify(manifest));
  const env = (test: string) => ({
    NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import=${pathToFileURL(RECORDER).href}`].filter(Boolean).join(" "),
    OPENARC_RECORD_MANIFEST: `${abs}/manifest.json`, OPENARC_RECORD_OUT: abs, OPENARC_RECORD_TEST: test,
  });
  const collect = async (): Promise<Map<string, Json[][]>> => {
    const got = new Map<string, Json[][]>();
    for (const name of (await ports.fs.list(RECORDED)).filter((n) => /^calls-\d+\.jsonl$/.test(n))) {
      const text = (await ports.fs.read(`${RECORDED}/${name}`)) ?? "";
      await ports.fs.remove(`${RECORDED}/${name}`);
      if (text.length > 1_000_000) continue;
      for (const line of text.split("\n")) {
        try {
          const r = JSON.parse(line) as { file: unknown; name: unknown; args: unknown };
          const k = `${r.file}\0${r.name}`;
          if (typeof r.file !== "string" || typeof r.name !== "string" || !wanted.has(k) || !Array.isArray(r.args)) continue;
          const lists = got.get(k) ?? got.set(k, []).get(k)!;
          for (const a of r.args) if (Array.isArray(a) && key(a).length <= 600) lists.push(a as Json[]);
        } catch { /* a malformed line */ }
      }
    }
    return got;
  };
  return { env, collect };
}

/** A module's requirement lines as its `.arc` file has them, per function: `example` and `rule` lines (not intent, not
 *  `observed`). Part of the reuse key: editing one re-runs the module. */
const requirements = (m: ArcModule | null): string =>
  (m?.fns ?? []).map((f) => [f.name, ...f.examples.filter((e) => !e.observed).map(printExample), ...f.rules.map((r) => `rule ${r.name}: ${r.text}`)])
    .filter((l) => l.length > 1).map((l) => l.join("\n")).sort().join("\0");

/** The project files each source imports, directly or through others, from the imports its language reads (lang/lang.ts).
 *  ponytail: what a language's `imports` resolves only: dynamic `import()`, tsconfig `paths` aliases and files outside the
 *  scanned dirs are not followed, and a Go import names one file of the imported package (and none of the importer's own
 *  package), so a change elsewhere in a Go package does not re-run its importers. */
async function importClosure(ports: Ports, texts: Map<string, string>): Promise<(file: string) => string[]> {
  const edges = (await Promise.all(LANGS.map((l) => { const mine = new Map([...texts].filter(([f]) => l.code.test(f))); return mine.size ? l.imports(ports, mine) : []; }))).flat().filter((e) => !e.external);
  return (file) => {
    const seen = new Set([file]);
    for (let grew = true; grew;) { grew = false; for (const e of edges) if (seen.has(e.from) && !seen.has(e.to)) seen.add(e.to), grew = true; }
    seen.delete(file);
    return [...seen].sort();
  };
}

/** Each source's `.arc` file. A source that an existing `.arc` file names on its module line keeps that file (the module
 *  line is the authority). The others get `<out>/<path in its dir, no extension>.arc`; when sources would share a file,
 *  or one would take a file another module's line claims, each of them gets a longer path: its dir in front
 *  (`lib/index`), then also its extension (`a.js`), then both. Depends on the sources and the `.arc` files, not on the
 *  order they are listed in. owner: per existing `.arc` file, the source its module line names. */
function arcPaths(ctx: DecompileCtx, files: string[], owner: Map<string, string>): Map<string, string> {
  const own = new Map<string, string>();
  for (const [arc, src] of [...owner].sort()) if (!own.has(src)) own.set(src, arc);
  const tries = new Map(files.filter((f) => !own.has(f)).map((f) => {
    const dir = ctx.dirs.find((d) => inDir(d, f))!, rel = dir === "." ? f : f.slice(dir.length + 1), stem = rel.replace(CODE, "");
    return [f, [...new Set([stem, `${dir}/${stem}`, rel, `${dir}/${rel}`].map((x) => `${ctx.out}/${x.replace(/^\.\//, "")}.arc`))]];
  }));
  const level = new Map([...tries.keys()].map((f) => [f, 0]));
  const at = (f: string) => tries.get(f)![level.get(f)!]!;
  for (let bumped = true; bumped;) {
    bumped = false;
    const n = new Map<string, number>();
    for (const f of tries.keys()) n.set(at(f), (n.get(at(f)) ?? 0) + 1);
    for (const f of [...tries.keys()].filter((f) => (n.get(at(f))! > 1 || owner.has(at(f))) && level.get(f)! < tries.get(f)!.length - 1)) level.set(f, level.get(f)! + 1), bumped = true;
  }
  for (const [f, l] of level) if (l) ctx.log(`${f}: its .arc file is ${at(f)}: ${tries.get(f)![0]} would be another module's too`);
  return new Map(files.map((f) => [f, own.get(f) ?? at(f)]));
}

/** The state, and how many re-recorded observations differ from the line that was in the file. */
export async function decompile(ctx: DecompileCtx): Promise<DecompileState & { changed: number }> {
  const { ports } = ctx;
  const { read, texts, instrumented } = await scan(ctx);
  const prev = JSON.parse((await ports.fs.read(STATE_FILE)) ?? "null") as DecompileState | null;
  const state: DecompileState = { version: 1, modules: {} };
  const box = sandbox(ctx, texts), importsOf = await importClosure(ports, texts);
  // the existing .arc files, and the source each one's module line names
  const arcTexts = new Map<string, string>(), owner = new Map<string, string>();
  for (const f of await walk(ports, ctx.out, [], (n) => n.endsWith(".arc"))) {
    const t = (await ports.fs.read(f)) ?? "", line = /^module\s+[\w$.-]+\s+from\s+(".*")$/m.exec(t);
    arcTexts.set(f, t);
    try { if (line) owner.set(f, JSON.parse(line[1]!) as string); } catch { /* parseArc says what is wrong with it */ }
  }
  const arcOf = arcPaths(ctx, [...read.keys()], owner);
  let changed = 0;
  const testRuns = new Map<string, { ok: boolean; why?: string }>();
  let rec: Awaited<ReturnType<typeof recorder>> | null = null;
  const fromTests = new Map<string, { args: Json[]; test: string }[]>(); // per "<file>\0<name>", in the order the tests ran
  /** Runs a test file once per decompile. With recording, a file that fails runs again without it, and that run decides:
   *  when the two disagree, what was recorded from it is dropped. */
  const passes = async (file: string): Promise<{ ok: boolean; why?: string }> => {
    if (testRuns.has(file)) return testRuns.get(file)!;
    const run = (env?: Record<string, string>) => langOf(file)!.runTest(ctx, file, env);
    let ok = await run(rec?.env(file));
    const got = rec ? await rec.collect() : new Map<string, Json[][]>();
    if (rec && !ok.ok && (ok = await run()).ok) ctx.log(`${file}: recording changed the outcome of this test file; its result without recording counts, and nothing recorded from it is used`);
    else for (const [k, lists] of got) (fromTests.get(k) ?? fromTests.set(k, []).get(k)!).push(...lists.map((args) => ({ args, test: file })));
    testRuns.set(file, ok);
    return ok;
  };
  try {
    if (ctx.testCmd && ctx.record) rec = await recorder(ctx, instrumented, new Set([...read].flatMap(([f, m]) => m.found.flatMap((x) => [`${f}\0${x.fn.name}`, ...(x.cls ? [`${f}\0new ${x.cls.name}`] : [])]))));
    for (const [file, m] of read) {
      const text = texts.get(file) ?? "";
      const arcFile = arcOf.get(file)!, before = arcTexts.get(arcFile) ?? null;
      if (owner.has(arcFile) && owner.get(arcFile) !== file) { // every longer path is taken too: never another module's file
        ctx.log(`${arcFile}: it is ${owner.get(arcFile)}'s .arc file; ${file} left out`);
        if (prev?.modules[file]) state.modules[file] = prev.modules[file];
        continue;
      }
      let old: ArcModule | null = null;
      try { old = before === null ? null : parseArc(before); } catch (e) { ctx.log(`${arcFile}: ${(e as Error).message}; left as it is`); state.modules[file] = prev?.modules[file] ?? { hash: "", arc: arcFile, fns: {}, skipped: {} }; continue; }
      const testsOf = (x: FoundFn) => x.tests;
      // the reuse key: the module's text, its test mapping and command, its requirement lines, the files it imports
      const hash = sha([text, m.found.map((x) => testsOf(x).join(",")).join(";"), ctx.testCmd?.join(" ") ?? "", requirements(old), ...importsOf(file).map((f) => `${f}\n${texts.get(f)}`)].join("\0"));
      const known = prev?.modules[file];
      const reuse = !ctx.fresh && !!old && known?.hash === hash;
      const fns: Record<string, FnState> = {};
      // the module's test files run first: what they record feeds its inputs
      if (ctx.testCmd) for (const t of new Set(m.found.flatMap(testsOf).sort())) await passes(t);
      for (const x of m.found) {
        const name = x.fn.name, was = old?.fns.find((f) => f.name === name), had = known?.fns[name];
        // what a person (or the host agent) wrote in the .arc file stays: intent, rules, hold, and its `example` lines
        const comment = x.fn.intent.length ? sha(x.fn.intent.join("\n")) : undefined;
        if (was?.intent.length) x.fn.intent = was.intent;
        if (was) Object.assign(x.fn, { rules: was.rules, ...(was.hold ? { hold: true } : {}) });
        const reqs = (was?.examples ?? []).filter((e) => !e.observed), olds = (was?.examples ?? []).filter((e) => e.observed);
        let why: string | undefined, failed: string | undefined, origins: Record<string, string> | undefined;
        if (reuse && had) {
          x.fn.examples = was?.examples ?? [];
          why = had.why;
          origins = had.origins;
          if (/^(example|rule) /.test(why ?? "")) failed = why; // an `example` or rule that failed then fails now: nothing changed
        } else {
          // inputs: recorded from the tests first (real usage), then literal calls, then the types. An input's origin: a
          // literal call (it names the line), else the test it was recorded from, else the types, else its observed line
          const calls = x.calls.slice(0, 6), from = new Map<string, string>();
          const seen = [...new Map((fromTests.get(`${file}\0${name}`) ?? []).map((r) => [key(r.args), r])).values()].slice(0, 6);
          // an instance method: each input on every receiver (constructor arguments from `new X(...)` with literals, then
          // recorded from the tests, then none when the constructor needs none). ponytail: at most 3 receivers
          const receivers = !x.cls ? [] : [...new Map([...x.cls.calls.map((c) => c.args), ...(fromTests.get(`${file}\0new ${x.cls.name}`) ?? []).map((r) => r.args), ...(x.cls.bare ? [[]] : [])].map((a) => [key(a), a])).values()].slice(0, 3);
          const widen = (a: Json[]): Json[][] => (x.cls ? receivers.map((rv) => [rv, ...a]) : [a]);
          const origin = (a: Json[], o: string) => { for (const w of widen(a)) if (!from.has(key(w))) from.set(key(w), o); };
          for (const c of calls) origin(c.args, `call ${c.at}`);
          for (const r of seen) origin(r.args, `recorded ${r.test}`);
          for (const a of x.inputs ?? []) origin(a, "types");
          for (const e of olds) if (!from.has(key(flat(e)))) from.set(key(flat(e)), had?.origins?.[key(flat(e))] ?? "kept");
          const required = new Set(reqs.map((e) => key(flat(e))));
          let inputs = [...new Map([...olds.map(flat), ...[...seen.map((r) => r.args), ...calls.map((c) => c.args), ...(x.inputs ?? [])].flatMap(widen)].map((a) => [key(a), a])).values()].filter((a) => !required.has(key(a))).slice(0, 18);
          x.fn.examples = [...reqs, ...olds];
          if (!inputs.length && !reqs.length) why = x.cls && !receivers.length ? `no way to construct ${x.cls.name} found` : "no inputs: the parameter types say too little and no call passes literals";
          else {
            let ran = await box.run(file, x.fn, [...reqs.map(flat), ...inputs]);
            if ("error" in ran && inputs.length && !ran.error.startsWith("OARC-E092")) { // E092: no sandbox to run in, which no input caused
              // the batch failed as a whole (an input that exits the process or hits the CPU limit): the requirements run
              // alone and decide the status; then each other input runs on its own, so one bad input cannot take the rest
              // down. What brought a lone input down is no throw a caller would see: it is dropped, with a line.
              // ponytail: one sandbox run per input after a failed batch, at most the 18 inputs a function gets
              const batch = ran.error, req = reqs.length ? await box.run(file, x.fn, reqs.map(flat)) : [];
              if ("error" in req) ran = req;
              else {
                const each: Ran[] = [], good: Json[][] = [];
                for (const a of inputs) {
                  const one = await box.run(file, x.fn, [a]);
                  if (!("error" in one)) good.push(a), each.push(one[0]!);
                  else ctx.log(`${file}: ${isInstance(x.fn) ? callText(name, a.slice(1), a[0] as Json[]) : callText(name, a)} left out: ${firstLine(one.error)}`);
                }
                ran = good.length || reqs.length ? [...req, ...each] : { error: batch };
                if (good.length || reqs.length) inputs = good;
              }
            }
            if ("error" in ran) { why = firstLine(ran.error); if (reqs.length) failed = `${printExample({ ...reqs[0]!, name: undefined })}: ${why}`; }
            else {
              failed = reqs.map((e, i) => unmet(e, ran[i]!)).find(Boolean);
              // the rules, on the calls this run made (no generated inputs: `--check` is the thorough pass); a broken or
              // unreadable one fails the function, in the words `--check` prints without the file and function
              const bad = failed || !x.fn.rules.length ? undefined : ruleItems(file, x.fn, m.types, ran.map(runOf)).find((i) => i.kind !== "held");
              if (bad) failed = checkLine(bad).slice(`${file}: ${name}: `.length);
              const now = ran.slice(reqs.length);
              for (const e of olds) {
                const r = now[inputs.findIndex((a) => key(a) === key(flat(e)))];
                if (r && printOutcome(e) !== printOutcome(recorded(r))) {
                  changed++;
                  ctx.log(`${file}: ${callText(name, e.args, e.receiver)} changed: was ${printOutcome(e)}, now ${printOutcome(recorded(r))}`);
                }
              }
              const obs = observations(now);
              if ("error" in obs) why = firstLine(obs.error);
              else if (!obs.length && inputs.length) why = "no repeatable result";
              const names = new Map(olds.flatMap((e) => (e.name ? [[key(flat(e)), e.name] as const] : [])));
              x.fn.examples = [...reqs, ...("error" in obs ? [] : obs.map((e) => (names.has(key(flat(e))) ? { ...e, name: names.get(key(flat(e)))! } : e)))];
            }
          }
          const obsArgs = x.fn.examples.filter((e) => e.observed).map((e) => key(flat(e)));
          if (obsArgs.length) origins = Object.fromEntries(obsArgs.map((k) => [k, from.get(k) ?? had?.origins?.[k] ?? "kept"]));
        }
        const mapped = testsOf(x);
        let ran: "tested" | "failing" | null = null, testWhy: string | undefined;
        if (ctx.testCmd && mapped.length) {
          ran = "tested";
          for (const t of mapped) { const got = await passes(t); if (!got.ok) { ran = "failing"; testWhy = `${t} fails${got.why ? `: ${got.why}` : ""}`; } }
        }
        why = failed ?? testWhy ?? why;
        const status: FnStatus = failed || ran === "failing" ? "failing" : ran ?? (reqs.length ? "specified" : x.fn.examples.length ? "observed" : x.fn.intent.length ? "described" : "bare");
        fns[name] = { status, tests: mapped, ...(why ? { why } : {}), ...(origins ? { origins } : {}), ...(comment && comment === sha(x.fn.intent.join("\n")) ? { comment } : {}) };
      }
      // a function of the .arc file the code no longer has (unexported, renamed, skipped): its block stays when it holds
      // anything written by hand, an intent that is not the code's comment included; one with observations only goes
      const inCode = new Set(m.found.map((x) => x.fn.name));
      const kept = (old?.fns ?? []).filter((f) => {
        if (inCode.has(f.name)) return false;
        const hand = f.examples.some((e) => !e.observed) || !!f.rules.length || !!f.hold || (!!f.intent.length && known?.fns[f.name]?.comment !== sha(f.intent.join("\n")));
        ctx.log(`${file}: ${f.name} is not in the code; ${hand ? "its block stays in the .arc file: it has lines written by hand" : "its block is dropped from the .arc file: it had observations only"}`);
        return hand;
      });
      const next: ArcModule = { name: arcFile.slice(ctx.out.length + 1, -".arc".length).replaceAll("/", "."), file, intent: old?.intent ?? [], types: m.types, fns: [...m.found.map((x) => x.fn), ...kept] };
      const out = printArc(next);
      if (out !== before) await ports.fs.write(arcFile, out);
      state.modules[file] = { hash, arc: arcFile, fns, skipped: m.skipped };
      await ports.fs.write(STATE_FILE, JSON.stringify({ ...state, modules: { ...prev?.modules, ...state.modules } }, null, 1) + "\n"); // a checkpoint: an interrupted run resumes here
      ctx.log(`${file}: ${m.found.length} functions${reuse ? " (unchanged)" : ""}`);
    }
  } finally {
    await box.close();
    if (ctx.testCmd && ctx.record) await ports.fs.remove(RECORDED);
  }
  // the modules of other dirs stay while their source exists; in the scanned dirs only this run's
  const others: Record<string, ModuleState> = {};
  for (const [f, m] of Object.entries(prev?.modules ?? {})) if (!state.modules[f] && !ctx.dirs.some((d) => inDir(d, f)) && (await ports.fs.read(f)) !== null) others[f] = m;
  await ports.fs.write(STATE_FILE, JSON.stringify({ ...state, modules: { ...others, ...state.modules } }, null, 1) + "\n");
  return { ...state, changed };
}

/** One finding of `decompile --check`. `was`/`now`: outcomes as `.arc` prints them. */
/** Rules: `held` (on `inputs` calls), `broken` (the first call it was false on: `args`, `now`), `unparsable`. */
export interface CheckItem { file: string; fn: string; kind: "changed" | "failing" | "unrunnable" | "removed" | "new" | "held" | "broken" | "unparsable"; args?: Json[]; receiver?: Json[]; was?: string; now?: string; why?: string; rule?: string; inputs?: number }
export interface CheckSummary { functions: number; preserved: number; changed: number; failing: number; unrunnable: number; removed: number; new: number; held: number; broken: number; unparsable: number }

/** `decompile --check`: every `example` and `observed` line in the `.arc` files under `ctx.out` against the code as it is
 *  now. Reads only the `.arc` files and the code (not the state file) and writes nothing. ok: nothing changed, failed or
 *  was removed. `only`: check just the functions of the `.arc` files it accepts, reading only their source files (so no
 *  function is `new`). `parsed`: the `.arc` files, already parsed by the caller. ponytail: finite inputs; agreeing on
 *  them does not prove two versions equal. */
export async function checkSpecs(ctx: DecompileCtx, only?: (file: string, fn: string) => boolean, parsed?: ArcModule[]): Promise<{ ok: boolean; summary: CheckSummary; items: CheckItem[] }> {
  let arcs = parsed;
  if (!arcs) {
    arcs = [];
    for (const f of await walk(ctx.ports, ctx.out, [], (n) => n.endsWith(".arc"))) {
      try { arcs.push(parseArc((await ctx.ports.fs.read(f)) ?? "")); } catch (e) { ctx.log(`${f}: ${(e as Error).message}; not checked`); }
    }
  }
  const { read, texts } = await scan(ctx, only && new Set(arcs.filter((m) => m.fns.some((f) => only(m.file, f.name))).map((m) => m.file)));
  const items: CheckItem[] = [], summary: CheckSummary = { functions: 0, preserved: 0, changed: 0, failing: 0, unrunnable: 0, removed: 0, new: 0, held: 0, broken: 0, unparsable: 0 };
  const add = (i: CheckItem) => { items.push(i); summary[i.kind]++; };
  const box = sandbox(ctx, texts);
  try {
    for (const m of arcs) {
      const exported = new Set(read.get(m.file)?.found.map((x) => x.fn.name));
      for (const f of m.fns) {
        if (only && !only(m.file, f.name)) continue; // openarc arc: one function, or a few
        if (!exported.has(f.name)) { add({ file: m.file, fn: f.name, kind: "removed" }); continue; }
        summary.functions++;
        if (!f.examples.length) continue;
        const ran = await box.run(m.file, f, f.examples.map(flat));
        if ("error" in ran) { add({ file: m.file, fn: f.name, kind: "unrunnable", why: firstLine(ran.error) }); continue; }
        f.examples.forEach((e, i) => {
          const now = printOutcome(recorded(ran[i]!)), why = e.observed ? undefined : unmet(e, ran[i]!);
          if (why) add({ file: m.file, fn: f.name, kind: "failing", args: e.args, ...(e.receiver ? { receiver: e.receiver } : {}), was: printOutcome(e), now, why });
          else if (e.observed && printOutcome(e) !== now) add({ file: m.file, fn: f.name, kind: "changed", args: e.args, ...(e.receiver ? { receiver: e.receiver } : {}), was: printOutcome(e), now });
          else summary.preserved++;
        });
        if (f.rules.length) {
          // the rules, on every call above and on generated inputs: structural edits of these arguments that fit the types
          const seen = new Set(f.examples.map((e) => key(e.args))), cap = ctx.ruleInputs ?? 50;
          // ponytail: an instance method's rules run on its written lines only; generating inputs would need receivers too
          const extra = f.name.includes(".") && !f.static ? [] : engine.oracleInputs(f.examples.map((e) => ({ args: e.args })), seen.size + cap, 1, [], argsFit(f, m.types)).filter((a) => !seen.has(key(a))).slice(0, cap);
          const more = extra.length ? await box.run(m.file, f, extra) : [];
          if ("error" in more) ctx.log(`${m.file}: ${f.name}: generated inputs unrunnable, rules checked on the written lines only: ${firstLine(more.error)}`);
          const runs = [...ran, ...("error" in more ? [] : more)].map(runOf);
          for (const i of ruleItems(m.file, f, m.types, runs)) add(i);
        }
      }
    }
    for (const [file, m] of read) {
      const specified = new Set(arcs.filter((a) => a.file === file).flatMap((a) => a.fns.map((f) => f.name)));
      for (const x of m.found) if (!specified.has(x.fn.name) && (!only || only(file, x.fn.name))) add({ file, fn: x.fn.name, kind: "new" });
    }
  } finally {
    await box.close();
  }
  return { ok: !summary.changed && !summary.failing && !summary.removed && !summary.broken && !summary.unparsable, summary, items };
}

type RuleRun = { args: Json[]; result?: Json; after?: Json[]; threw: boolean };
const runOf = (r: Ran): RuleRun => (isThrown(r.got) ? { args: r.args, threw: true } : { args: r.args, result: r.got, ...(r.after ? { after: r.after } : {}), threw: false });

/** checkRules on `runs`, as findings: held, broken (the first call it was false on) or unparsable. */
function ruleItems(file: string, f: ArcFn, types: ArcType[], runs: RuleRun[]): CheckItem[] {
  return checkRules(f, types, runs).map((r): CheckItem => {
    const at = { file, fn: f.name, rule: r.rule };
    if (r.broken) return { ...at, kind: "broken", args: r.broken.args, now: r.broken.result === undefined ? "throws" : printOutcome({ args: [], expected: r.broken.result, ...(r.broken.after ? { after: r.broken.after } : {}) }), ...(r.error ? { why: r.error } : {}) };
    return r.error ? { ...at, kind: "unparsable", why: r.error } : { ...at, kind: "held", inputs: r.held };
  });
}

/** One line per finding: the text `decompile --check` prints. */
export function checkLine(i: CheckItem): string {
  const call = `${i.file}: ${i.args ? callText(i.fn, i.args, i.receiver) : i.fn}`;
  if (i.rule) return `${i.file}: ${i.fn}: rule ${i.rule}: ${i.kind === "held" ? `held on ${i.inputs} input${i.inputs === 1 ? "" : "s"}` : i.kind === "broken" ? `broken by (${i.args!.map(printValue).join(", ")}) -> ${i.now}${i.why ? `: ${i.why}` : ""}` : i.why}`;
  return i.kind === "changed" ? `${call} changed: was ${i.was}, now ${i.now}`
    : i.kind === "failing" ? `${i.file}: ${i.fn}: ${i.why}`
    : i.kind === "unrunnable" ? `${call} unrunnable: ${i.why}`
    : i.kind === "removed" ? `${call} removed: the code no longer exports it`
    : `${call} new: no entry in the .arc file`;
}

export function report(s: DecompileState): { totals: Record<FnStatus | "skipped", number>; lines: string[] } {
  const totals = { tested: 0, failing: 0, specified: 0, observed: 0, described: 0, bare: 0, skipped: 0 };
  const lines: string[] = [];
  for (const [file, m] of Object.entries(s.modules)) {
    const c = { tested: 0, failing: 0, specified: 0, observed: 0, described: 0, bare: 0 };
    for (const f of Object.values(m.fns)) {
      const st = (f.status as string) === "examples" ? "observed" : f.status; // a state file written before `observed`
      c[st]++, totals[st]++;
    }
    totals.skipped += Object.keys(m.skipped).length;
    lines.push(`${file}: tested ${c.tested}, failing ${c.failing}, specified ${c.specified}, observed ${c.observed}, described ${c.described}, bare ${c.bare}${Object.keys(m.skipped).length ? `, skipped ${Object.keys(m.skipped).length}` : ""}`);
  }
  return { totals, lines };
}

/** Functions with no intent yet, for whoever writes them (the host agent): `<arc file>: <name>`. */
export const todo = (s: DecompileState, arcs: Map<string, ArcModule>): string[] =>
  Object.values(s.modules).flatMap((m) => (arcs.get(m.arc)?.fns ?? []).filter((f) => !f.intent.length).map((f) => `${m.arc}: ${f.name}`));
