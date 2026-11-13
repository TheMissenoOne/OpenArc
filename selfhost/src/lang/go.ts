// Go behind the language seam (lang/lang.ts). A small helper (lang-go/arcgo, standard library only, built into
// .openarc/go/ on first use) reads a module with go/types: exported functions, methods and struct types, doc comments,
// literal calls and which _test.go files use what. Examples run in a staged copy of the module: a generated in-package
// test file (lang-go/harness.go) decodes each input into the real parameter types, calls, and prints the JavaScript
// harness's JSON lines; `go test` runs it in the bwrap or sandbox-exec tier, network off. Accept splices a body by the helper's byte
// offsets and checks the staged package with `go build` and `go vet`. docs/wiki/Languages.md has the type mapping.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Ports } from "../types.ts";
import type { ArcFn, ArcType } from "../arc.ts";
import * as engine from "../engine.ts";
import { inputsFor } from "../sync.ts";
import { readHarnessOutput } from "../sandbox.ts";
import { goBwrapArgv, goSandboxExecArgv } from "../isolation.ts";
import { walk, type DecompileCtx } from "../decompile.ts";
import type { Edge } from "../levels.ts";
import type { Call, FoundFn, Json, Lang, Located, Read, ReadModule, Runner } from "./lang.ts";

type Ctx = Omit<DecompileCtx, "dirs">;
interface GoType { k: "int" | "float" | "string" | "bool" | "slice" | "ptr" | "struct" | "any" | "native"; elem?: GoType; name?: string; fields?: { name: string; type: GoType; optional?: boolean }[]; text?: string }
interface GoFunc { name: string; recv?: string; doc: string[]; params: { name: string; type: GoType; go: string }[]; variadic?: boolean; results: GoType[]; error?: boolean; generic?: boolean; imports?: Record<string, string>; decl: number; start: number; end: number }
interface GoFile { package: string; imports: string[]; funcs: GoFunc[]; types: GoType[]; tests: string[] }
interface GoRead { module: string; files: Record<string, GoFile>; uses: Record<string, { tests: string[]; calls: Call[] }>; lits: Record<string, Call[]>; error?: string }

const HERE = fileURLToPath(new URL("../../lang-go/", import.meta.url)); // the same relative place in the npm build
export const NO_GO = "Go code needs the Go toolchain: set OPENARC_GO to the go binary (OPENARC_GO=/usr/local/go/bin/go) or put go on PATH";

// ── the toolchain ──
let toolchain: Promise<{ go: string; root: string; modCache: string; env: Record<string, string> }> | undefined;
/** OPENARC_GO, else go on PATH. Its GOROOT and module cache; env: what every go command here gets on top of the
 *  user's environment (this go first on PATH, no toolchain download, no cgo). */
function goTool(ports: Ports) {
  return (toolchain ??= (async () => {
    const found = process.env.OPENARC_GO || (process.env.PATH ?? "").split(delimiter).map((d) => join(d, process.platform === "win32" ? "go.exe" : "go")).find((p) => p && existsSync(p));
    if (!found || !existsSync(found)) throw Object.assign(new Error(NO_GO), { name: "OpenArcSetup" });
    const go = realpathSync(found);
    const env = { PATH: [join(go, ".."), process.env.PATH].filter(Boolean).join(delimiter), GOTOOLCHAIN: "local", CGO_ENABLED: "0" };
    const r = await ports.proc.run([go, "env", "-json", "GOROOT", "GOMODCACHE"], 60_000, { env });
    if (r.code !== 0) throw Object.assign(new Error(`${NO_GO} (\`${go} env\` failed: ${r.stdout.trim().split("\n")[0]})`), { name: "OpenArcSetup" });
    const e = JSON.parse(r.stdout) as { GOROOT: string; GOMODCACHE: string };
    return { go, root: realpathSync(e.GOROOT), modCache: e.GOMODCACHE, env };
  })());
}

const helpers = new Map<string, Promise<string>>();
/** The helper binary, built once per source version into the project's .openarc/go/. */
function helper(ctx: Ctx): Promise<string> {
  const key = ctx.root;
  if (!helpers.has(key)) helpers.set(key, (async () => {
    const { go, env } = await goTool(ctx.ports);
    const src = join(HERE, "arcgo");
    const hash = createHash("sha256").update(readFileSync(join(src, "main.go"))).update(readFileSync(join(src, "go.mod"))).update(go).digest("hex").slice(0, 12);
    const bin = join(ctx.root, ".openarc", "go", `arcgo-${hash}${process.platform === "win32" ? ".exe" : ""}`); // Windows: go build adds .exe
    if (!existsSync(bin)) {
      const r = await ctx.ports.proc.run([go, "build", "-o", bin, "."], 300_000, { cwd: src, env: { ...env, GOFLAGS: "-mod=mod", GOPROXY: "off" } });
      if (r.code !== 0) throw new Error(`building the Go helper failed: ${r.stdout.trim()}`);
    }
    return bin;
  })());
  return helpers.get(key)!;
}

// ── modules ──
const dirOf = (f: string) => f.slice(0, Math.max(0, f.lastIndexOf("/")));
const under = (mod: string, rel: string) => (mod ? `${mod}/${rel}` : rel);
const relTo = (mod: string, f: string) => (mod ? f.slice(mod.length + 1) : f);

/** The directory of the go.mod nearest above `file` ("" for the project root), null when there is none. */
async function moduleOf(ports: Ports, file: string): Promise<string | null> {
  for (let d = dirOf(file); ; d = dirOf(d)) {
    if ((await ports.fs.read(under(d, "go.mod"))) !== null) return d;
    if (!d) return null;
  }
}

/** What the last read saw, per project file: the runner and runTest need the package, the parameter types and the tests. */
const seen = new Map<string, { mod: string; module: string; file: GoFile }>();

// ── types as `.arc` text, and the inputs they allow ──
const IDENT = /^[A-Za-z_$][\w$]*$/;
const opaque = (text: string) => (text.length > 100 ? "Any" : `\`${text.replaceAll("`", "'")}\``);
function arcOf(t: GoType): string {
  switch (t.k) {
    case "int": return "Int";
    case "float": return "Float";
    case "string": return "Str";
    case "bool": return "Bool";
    case "any": return "Any";
    case "slice": return `[${arcOf(t.elem!)}]`;
    case "ptr": { const e = arcOf(t.elem!); return e.endsWith("?") ? e : `${e}?`; }
    case "struct": return t.name!;
    default: return opaque(t.text ?? "?");
  }
}
const record = (t: GoType) => `{ ${t.fields!.map((f) => `${IDENT.test(f.name) ? f.name : JSON.stringify(f.name)}${f.optional ? "?" : ""}: ${f.optional ? arcOf(f.type).replace(/\?$/, "") : arcOf(f.type)}`).join(", ")} }`;
/** Several results: an array of them. */
const returns = (f: GoFunc) => (!f.results.length ? "Void" : f.results.length === 1 ? arcOf(f.results[0]!) : `[${[...new Set(f.results.map(arcOf))].join(" | ")}]`);

function valuesOf(t: GoType, depth = 0): Json[] | null {
  if (depth > 3) return null;
  switch (t.k) {
    case "int": return [0, 1, -1, 42];
    case "float": return [0, 1.5, -1, 42];
    case "string": return ["", "a", "Hello World"];
    case "bool": return [true, false];
    case "slice": { const v = valuesOf(t.elem!, depth + 1); return v && [[], [v[0]!], v.slice(0, 3)]; }
    case "ptr": { const v = valuesOf(t.elem!, depth + 1); return v && [...v.slice(0, 2), null]; }
    case "struct": {
      const out: Record<string, Json> = {};
      for (const f of t.fields!) {
        if (f.optional) continue;
        const v = valuesOf(f.type, depth + 1);
        if (!v) return null;
        out[f.name] = v[0]!;
      }
      return [out];
    }
    default: return null;
  }
}

function found(mod: string, r: GoRead, rel: string, f: GoFunc): FoundFn {
  const fn: ArcFn = {
    name: f.name,
    params: f.params.map((p, i) => ({ name: p.name, type: arcOf(p.type), ...(f.variadic && i === f.params.length - 1 ? { rest: true } : {}) })),
    returns: returns(f), intent: f.doc, examples: [], rules: [],
  };
  const fixed = f.variadic ? f.params.slice(0, -1) : f.params;
  const at = (c: Call): Call => ({ args: c.args, at: under(mod, c.at) });
  const use = r.uses[`${rel}\0${f.name}`];
  // a method's receivers: the zero value (`new ()`), and the composite literals of its type with literal fields
  const lits = f.recv ? Object.entries(r.lits).find(([k]) => k.endsWith(`\0${f.recv}`) && dirOf(k.split("\0")[0]!) === dirOf(rel))?.[1] ?? [] : [];
  return {
    fn, inputs: inputsFor(fixed.map((p) => valuesOf(p.type)), 8), tests: (use?.tests ?? []).map((t) => under(mod, t)), calls: (use?.calls ?? []).map(at),
    ...(f.recv ? { cls: { name: f.recv, bare: true, calls: lits.map(at) } } : {}),
  };
}

async function read(ctx: DecompileCtx, sources: string[], tests: string[]): Promise<Read> {
  const modules = new Map<string, ReadModule>(), byMod = new Map<string, string[]>();
  for (const f of sources) {
    const mod = await moduleOf(ctx.ports, f);
    if (mod === null) { ctx.log(`${f}: no go.mod in its directory or above; not read`); continue; }
    (byMod.get(mod) ?? byMod.set(mod, []).get(mod)!).push(f);
  }
  void tests; // the helper reads each package's _test.go files itself
  const { env } = await goTool(ctx.ports);
  const bin = await helper(ctx);
  for (const [mod, files] of byMod) {
    const abs = mod ? join(ctx.root, mod) : ctx.root;
    const dirs = [...new Set(files.map((f) => dirOf(relTo(mod, f)) || "."))];
    const res = await ctx.ports.proc.run([bin, "read", abs, ...dirs], 300_000, { cwd: abs, env: { ...env, GOFLAGS: "-mod=mod", GOPROXY: "off" } });
    let r: GoRead;
    try { r = JSON.parse(res.stdout) as GoRead; } catch { throw new Error(`${under(mod, "go.mod")}: the Go helper failed: ${res.stdout.trim().slice(0, 500)}`); }
    if (r.error) throw new Error(`${under(mod, "go.mod")}: ${r.error}`);
    for (const [rel, file] of Object.entries(r.files)) seen.set(under(mod, rel), { mod, module: r.module, file });
    for (const f of files) {
      const rel = relTo(mod, f), file = r.files[rel];
      if (!file) continue;
      const skipped: Record<string, string> = {};
      const types: ArcType[] = file.types.map((t) => ({ name: t.name!, type: record(t) }));
      const fns = file.funcs.filter((x) => (x.generic ? ((skipped[x.name] = "generic: type parameters are not run yet"), false) : true));
      modules.set(f, { types, found: fns.map((x) => found(mod, r, rel, x)), skipped });
    }
  }
  return { modules, instrumented: new Map() };
}

// ── staging and running ──
/** A copy of the module at `mod` under the project's .openarc/sandbox: go.mod, go.sum and every non-test .go file, as
 *  ports.fs reads them (an accept overlay included). Returns the stage, relative to the project root. */
async function stage(ports: Ports, mod: string, name: string): Promise<string> {
  const dir = `.openarc/sandbox/${name}`;
  await ports.fs.remove(dir);
  const files = (await walk(ports, mod || ".", [], (n) => n.endsWith(".go") || n === "go.mod" || n === "go.sum")).map((f) => f.replace(/^\.\//, ""));
  for (const f of files) {
    const rel = relTo(mod, f);
    if (rel.endsWith("_test.go") || /(^|\/)(vendor|testdata)\//.test(rel)) continue;
    await ports.fs.write(`${dir}/${rel}`, (await ports.fs.read(f)) ?? "");
  }
  return dir;
}

/** The generated test file for one function: harness.go with the package, the imports and oaCall filled in. */
function harness(pkg: string, f: GoFunc): string {
  const rest = f.variadic ? f.params.length - 1 : -1;
  const vars = f.params.map((p, i) => `\tvar oaA${i} ${i === rest ? "[]" : ""}${p.go}`);
  const args = f.params.map((_, i) => `oaA${i}${i === rest ? "..." : ""}`).join(", ");
  const results = f.results.map((_, i) => `oaR${i}`);
  const lhs = [...results, ...(f.error ? ["oaErr"] : [])];
  const callee = f.recv ? `oaRecv.${f.name.split(".")[1]}` : f.name;
  const got = !results.length ? "oaJSON.RawMessage(`\"$undefined\"`)" : results.length === 1 ? "oaEncode(oaR0)" : `oaEncode([]any{${results.join(", ")}})`;
  const call = [
    "const oaHasRecv = " + String(!!f.recv),
    "",
    "func oaCall(in []oaJSON.RawMessage) (oaJSON.RawMessage, []any, int, []oaJSON.RawMessage) {",
    ...(f.recv ? [`\tvar oaRecv ${f.recv}`] : []),
    ...vars,
    `\tvars := []any{${f.params.map((_, i) => `&oaA${i}`).join(", ")}}`,
    `\tif msg := oaDecode(in, ${f.recv ? "&oaRecv" : "nil"}, vars, ${rest}); msg != "" {`,
    `\t\treturn oaThrows(msg), nil, -1, nil`,
    "\t}",
    `\tbefore := oaSnap(vars, ${rest})`,
    `\t${lhs.length ? `${lhs.join(", ")} := ` : ""}${callee}(${args})`,
    ...(f.error ? [`\tif oaErr != nil {`, `\t\treturn oaThrows(oaErr.Error()), vars, ${rest}, before`, "\t}"] : []),
    `\treturn ${got}, vars, ${rest}, before`,
    "}",
    "",
  ];
  const imports = Object.entries(f.imports ?? {}).map(([path, name]) => `\t${name} ${JSON.stringify(path)}`).join("\n");
  return readFileSync(join(HERE, "harness.go"), "utf8").replace(/^package PACKAGE$/m, `package ${pkg}`).replace("\t// openarc:imports", imports) + "\n" + call.join("\n");
}

/** The lines of a failed go command worth showing: the compiler's `file:line:col: message` lines, else its first line. */
const goErrors = (out: string): string[] => {
  const lines = out.split("\n").map((l) => l.trim().replace(/^vet: /, "")).filter(Boolean);
  const located = lines.filter((l) => /\.go:\d+(:\d+)?: /.test(l));
  return located.length ? located : lines.slice(0, 1);
};

let stages = 0;
function open(ctx: DecompileCtx, _texts: Map<string, string>): Runner {
  const staged = new Map<string, Promise<string>>(); // per module
  let req: Promise<ReturnType<DecompileCtx["request"]>> | undefined, refused = false;
  return {
    observe: async (file, fn, inputs) => {
      const r = await (req ??= engine.parse(ctx.ports, ctx.request(null, []), []).then((p) => ctx.request(p, [])));
      if (r.sandbox.unavailable) return { error: `OARC-E092 sandbox unavailable: ${r.sandbox.unavailable}` };
      const tier = r.sandbox.isolation ?? "bwrap";
      // the node tier cannot confine a Go binary, and the container tier has no Go toolchain; said once per run, since
      // decompile only records each function's reason
      if (tier !== "bwrap" && tier !== "sandbox-exec" && tier !== "unsafe-none") {
        const why = `Go code needs bwrap (Linux) or sandbox-exec (macOS), not ${tier}`;
        if (!refused) (refused = true), ctx.log(`OARC-E092 sandbox unavailable: ${why}, so no Go function ran. To run Go code with no sandbox at all, as you, with your files and your network, set "sandbox": { "isolation": "unsafe-none" } in openarc.config.json`);
        // the reason decompile keeps (200 characters at most)
        return { error: `OARC-E092 sandbox unavailable: ${why}; or sandbox.isolation "unsafe-none" (no sandbox)` };
      }
      const info = seen.get(file), f = info?.file.funcs.find((x) => x.name === fn.name);
      if (!info || !f) return { error: `${file}: ${fn.name} is not an exported Go function here` };
      const tool = await goTool(ctx.ports);
      const dir = await (staged.get(info.mod) ?? staged.set(info.mod, stage(ctx.ports, info.mod, `go-${Date.now().toString(36)}-${++stages}`)).get(info.mod)!);
      const pkg = dirOf(relTo(info.mod, file));
      await ctx.ports.fs.write(`${dir}/${pkg ? `${pkg}/` : ""}zz_openarc_test.go`, harness(info.file.package, f));
      await ctx.ports.fs.write(`${dir}/.openarc/plan.json`, JSON.stringify(inputs));
      const cache = join(ctx.root, ".openarc", "go-build"); // the sandbox's own build cache: what runs there never writes the user's
      // HOME, GOPATH and TMPDIR: bwrap's private /tmp, else a fresh one per run, removed after it (absolute on every OS)
      mkdirSync(join(ctx.root, ".openarc", "go-tmp"), { recursive: true });
      mkdirSync(cache, { recursive: true });
      const tmp = tier === "bwrap" ? "/tmp" : mkdtempSync(join(ctx.root, ".openarc", "go-tmp", "r-")); // unique across processes too
      const stageAbs = join(ctx.root, dir);
      const work = tier === "bwrap" ? "/work" : stageAbs;
      const env = { PATH: [join(tool.root, "bin"), "/usr/bin", "/bin"].join(delimiter), HOME: tmp, TMPDIR: tmp, GOPATH: join(tmp, "gopath"), GOCACHE: cache, GOMODCACHE: tool.modCache, GOPROXY: "off", GOFLAGS: "-mod=readonly", GOTOOLCHAIN: "local", CGO_ENABLED: "0", GOENV: "off", GOTELEMETRY: "off", OPENARC_PLAN: `${work}/.openarc/plan.json` };
      const args = ["test", "-count=1", "-vet=off", "-v", "-run", "^TestOpenarcRun$", `./${pkg}`]; // -vet=off: a vet finding in the code is no reason not to run it
      const sb = { stageDir: stageAbs, goRoot: tool.root, modCache: existsSync(tool.modCache) ? tool.modCache : null, buildCache: cache, cpuSeconds: r.sandbox.cpuSeconds, addressSpaceBytes: r.sandbox.addressSpaceBytes, env, args: [join(tool.root, "bin", "go"), ...args] };
      const argv = tier === "bwrap" ? goBwrapArgv(sb) : tier === "sandbox-exec" ? goSandboxExecArgv({ ...sb, tmpDir: tmp }) : sb.args;
      // the wall clock: a cold build cache compiles the standard library's test dependencies first; each timeout costs 5 s
      const ran = await ctx.ports.proc.run(argv, (r.sandbox.cpuSeconds + 120) * 1000 + 6000 * inputs.length, tier === "bwrap" ? {} : { cwd: stageAbs, env });
      if (tier !== "bwrap") rmSync(tmp, { recursive: true, force: true });
      if (ran.timedOut) return { error: "OARC-E091 sandbox timed out" };
      const mark = "\x1eopenarc ";
      const out = ran.stdout.split("\n").flatMap((l) => (l.includes(mark) ? [l.slice(l.indexOf(mark) + mark.length)] : [])).join("\n");
      const res = readHarnessOutput(out);
      if (!res.complete) return { error: `OARC-E090 harness crashed (exit ${ran.code}): ${goErrors(ran.stdout).join("; ")}` };
      const byName = new Map(res.failed.map((x) => [x.name, x.actual as { args: Json[]; got: Json; gotAfter?: Json[] }]));
      return inputs.map((args, i) => {
        const a = byName.get(`#${i + 1}`);
        return a ? { args: a.args, got: a.got, ...(a.gotAfter !== undefined ? { after: a.gotAfter } : {}) } : { args, got: "__openarc_observe__" };
      });
    },
    close: async () => { for (const d of staged.values()) await ctx.ports.fs.remove(await d); },
  };
}

// ── --run-tests: `go test -json ./...` once per module, a test file failing when one of its tests does ──
const testRuns = new WeakMap<object, Map<string, Promise<{ failed: Set<string>; broken: Set<string>; whole?: string }>>>();
const TEST_MS = 300_000;
async function runTest(ctx: DecompileCtx, file: string): Promise<{ ok: boolean; why?: string }> {
  const mod = await moduleOf(ctx.ports, file);
  const info = seen.get(file);
  if (mod === null || !info) return { ok: false };
  const runs = testRuns.get(ctx) ?? testRuns.set(ctx, new Map()).get(ctx)!;
  const run = runs.get(mod) ?? runs.set(mod, (async () => {
    const { go, env } = await goTool(ctx.ports);
    const r = await ctx.ports.proc.run([go, "test", "-json", "./..."], TEST_MS, { cwd: mod ? join(ctx.root, mod) : ctx.root, env });
    // failed: "<package>\0<test>"; broken: a package that failed with no test failing (it did not build)
    const failed = new Set<string>(), pkgs = new Set<string>(), broken = new Set<string>();
    for (const line of r.stdout.split("\n")) {
      try {
        const e = JSON.parse(line) as { Action?: string; Package?: string; Test?: string };
        if (e.Action !== "fail" || !e.Package) continue;
        if (e.Test) failed.add(`${e.Package}\0${e.Test.split("/")[0]}`), pkgs.add(e.Package);
        else broken.add(e.Package);
      } catch { /* not a test event */ }
    }
    for (const p of pkgs) broken.delete(p);
    // the run failed as a whole: it timed out, or it exited non-zero with no test or package failing (go.mod unreadable,
    // a toolchain error). Every test file of the module fails, with the reason: the first plain-text line
    const whole = r.timedOut ? `timed out after ${TEST_MS / 1000} s`
      : r.code !== 0 && !failed.size && !broken.size ? r.stdout.split("\n").map((l) => l.trim()).find((l) => l && !l.startsWith("{")) ?? `go test exited with code ${r.code}` : undefined;
    return { failed, broken, ...(whole ? { whole } : {}) };
  })()).get(mod)!;
  const { failed, broken, whole } = await run;
  if (whole) return { ok: false, why: whole };
  const dir = dirOf(relTo(mod, file)), pkg = dir ? `${info.module}/${dir}` : info.module;
  return { ok: !broken.has(pkg) && !info.file.tests.some((t) => failed.has(`${pkg}\0${t}`)) };
}

// ── accept ──
async function locate(ctx: Ctx, _file: string, text: string, name: string): Promise<Located | undefined> {
  const bin = await helper(ctx);
  const r = await ctx.ports.proc.run([bin, "funcs"], 60_000, { stdin: text });
  let spans: { name: string; decl: number; start: number; end: number }[];
  try { spans = (JSON.parse(r.stdout) as { funcs?: typeof spans }).funcs ?? []; } catch { return undefined; }
  const s = spans.find((x) => x.name === name);
  if (!s) return undefined;
  const bytes = Buffer.from(text, "utf8"), at = (b: number) => bytes.subarray(0, b).toString("utf8").length; // byte offsets to string indices
  const decl = at(s.decl);
  return { start: at(s.start), end: at(s.end), indent: /^[ \t]*/.exec(text.slice(text.lastIndexOf("\n", decl) + 1))![0], code: text.slice(decl, at(s.end)) };
}

/** `go build` and `go vet` on the package of `file` in a staged copy of its module holding `after`; only the errors the
 *  new text adds (the same check on the file as it is first, when the new text fails). Packages that import it are not
 *  built: a Go signature is declared, never inferred from the body, so a new body cannot change what a caller compiles
 *  against. */
async function problems(ctx: Ctx, file: string, after: string): Promise<string[]> {
  const mod = await moduleOf(ctx.ports, file);
  if (mod === null) return [`${file}: no go.mod in its directory or above`];
  const { go, env } = await goTool(ctx.ports);
  const pkg = `./${dirOf(relTo(mod, file))}`;
  const check = async (text: string | null): Promise<string[]> => {
    const ports: Ports = text === null ? ctx.ports : { ...ctx.ports, fs: { ...ctx.ports.fs, read: (rel) => (rel === file ? Promise.resolve(text) : ctx.ports.fs.read(rel)) } };
    const dir = await stage(ports, mod, `go-check-${Date.now().toString(36)}-${++stages}`);
    try {
      const opts = { cwd: join(ctx.root, dir), env: { ...env, GOFLAGS: "-mod=readonly", GOPROXY: "off" } };
      const build = await ctx.ports.proc.run([go, "build", "-o", process.platform === "win32" ? "NUL" : "/dev/null", pkg], 300_000, opts);
      if (build.code !== 0) return goErrors(build.stdout);
      const vet = await ctx.ports.proc.run([go, "vet", pkg], 300_000, opts);
      return vet.code === 0 ? [] : goErrors(vet.stdout);
    } finally {
      await ctx.ports.fs.remove(dir);
    }
  };
  const now = await check(after);
  if (!now.length) return now;
  const strip = (l: string) => l.replace(/^[^:]*\.go:\d+(:\d+)?: /, "");
  const had = new Set((await check(null)).map(strip));
  return now.filter((l) => !had.has(strip(l)));
}

// ── imports: the architecture level ──
const goModOf = async (ports: Ports, mod: string) => {
  const text = (await ports.fs.read(under(mod, "go.mod"))) ?? "";
  const path = /^module\s+(\S+)/m.exec(text)?.[1] ?? "";
  const requires = [...text.matchAll(/^(?:require\s+)?\s*([\w.~-]+(?:\/[\w.~-]+)+)\s+v\S+/gm)].map((m) => m[1]!);
  return { path, requires };
};
/** A file's imports: `import "p"`, `import x "p"` and `import ( ... )` blocks. */
const importsIn = (text: string): string[] =>
  [...text.matchAll(/^import\s*(?:\(([^)]*)\)|[\w.]*\s*("[^"]+"))/gm)].flatMap((m) => [...(m[1] ?? m[2]!).replace(/\/\/.*$/gm, "").matchAll(/"([^"]+)"/g)].map((x) => x[1]!));

async function imports(ports: Ports, files: Map<string, string>): Promise<Edge[]> {
  const seenEdges = new Map<string, Edge>();
  for (const [from, text] of files) {
    const mod = await moduleOf(ports, from);
    if (mod === null) continue;
    const { path, requires } = await goModOf(ports, mod);
    for (const p of importsIn(text)) {
      let e: Edge | undefined;
      if (path && (p === path || p.startsWith(`${path}/`))) {
        const dir = under(mod, p.slice(path.length + 1));
        const to = [...files.keys()].sort().find((f) => dirOf(f) === (dir.endsWith("/") ? dir.slice(0, -1) : dir));
        if (to && dirOf(to) !== dirOf(from)) e = { from, to, external: false };
      } else if (!p.split("/")[0]!.includes(".")) e = { from, to: `go:${p}`, external: true }; // the standard library
      else e = { from, to: requires.filter((r) => p === r || p.startsWith(`${r}/`)).sort((a, b) => b.length - a.length)[0] ?? p, external: true };
      if (e) seenEdges.set(`${e.from}\0${e.to}`, e);
    }
  }
  return [...seenEdges.values()];
}

export const goLang: Lang = {
  code: /\.go$/,
  isTest: (rel) => rel.endsWith("_test.go"),
  label: () => "Go",
  forms: "func F or func (r T) M, exported",
  indent: "\t",
  read,
  open,
  runTest: (ctx, file) => runTest(ctx, file),
  locate,
  notBody: (_file, body, name) => new RegExp(`^\\s*func\\s*(\\([^)]*\\)\\s*)?${name.split(".").at(-1)}\\s*[(\\[]`, "m").test(body),
  problems,
  imports,
};
