#!/usr/bin/env node
// `openarc` CLI entry point. Hand-written: the real ports plus command dispatch.
import { appendFile, mkdir, mkdtemp, open, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { appendFileSync, mkdirSync, cpSync, existsSync, lstatSync, readFileSync, realpathSync, rmSync, watch, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as http from "node:http";
import * as https from "node:https";
import { brotliDecompressSync, unzipSync } from "node:zlib";
import type { CompileRequest, Diagnostic, Ports } from "./types.ts";
import { parseArgv } from "./cli.ts";
import { run } from "./compile.ts";
import { commit, planJournal, recover } from "./txn.ts";
import * as engine from "./engine.ts";
import { DEFAULT_CONFIG, hostOf, parseConfig, presetConfig, type OpenArcConfig } from "./config.ts";
import { complete, describeBackend, testBackend } from "./backends.ts";
import { PHRASE_SYSTEM, parsePhrase, phrasePrompt, reportLines, suggest, type RegionView } from "./deps.ts";
import { clearStaleLock, releaseOwnLock } from "./lock.ts";
import { createWatcher, regionKey, type RegionKey } from "./watcher.ts";
import { watchDirs } from "./dirwatch.ts";
import { testFile } from "./tests-plan.ts";
import { migrate } from "./migrate.ts";
import { adopt, brief, syncOnce, type SyncCtx, type SyncStatus } from "./sync.ts";
import { SHEET_FILE } from "./sheet.ts";
import { STATE_FILE, decompile, report, todo, type DecompileState } from "./decompile.ts";
import { parseArc, type ArcModule } from "./arc.ts";
import { missingLine, rollUp, formatStatus, statusDetail } from "./levels.ts";
import { ARCH_FILE, CONCEPT_FILE, checkArch, checkConcept, deriveArch, formatReport, importsOf, parseArch, parseConcept, printArch, printConcept, projectName, sources, updateArch, type Arch, type Concept } from "./levels.ts";
import { LINT_USAGE, lintCommand } from "./lint.ts";
import { HARNESS_ENTRY, chooseTier, nodeBlocksNetwork, nodeVersionOf, probeTools, type TierChoice } from "./isolation.ts";

const MESSAGES: Record<string, string> = {
  "OARC-W001": "'@openarc:' text that is not a valid marker",
  "OARC-E010": "spec is not statically evaluable",
  "OARC-E011": "duplicate region id (or concept id)",
  "OARC-E012": "marker id has no spec",
  "OARC-E013": "region configured twice: a field set in more than one of JSDoc @arc tags, arc.configure and defineRegion (detail: field:layers)",
  "OARC-W013": "block spec has no markers: place // @openarc:begin/end around the statements by hand",
  "OARC-E020": "implementation not assignable to spec type F",
  "OARC-E022": "a code-first region needs an explicit return type (arc.todo() would infer never)",
  "OARC-E030": "unmatched marker",
  "OARC-E031": "crossed marker nesting",
  "OARC-E032": "block region outside a function region",
  "OARC-E033": "illegal region body",
  "OARC-E034": "nested function region",
  "OARC-E035": "unsupported construct in a block region",
  "OARC-W040": "block region verified indirectly (through its function's examples)",
  "OARC-W041": "block region has no behavioral verification (its function has no examples)",
  "OARC-W042": "held back: it can't be verified until the regions it waits on exist (a block: its sibling blocks, kept in the cache and committed by a later run; detail waiting:<ids>: pending callees its examples end in)",
  "OARC-W043": "region keeps a body that does not satisfy its current spec (its recompile failed; shown as stale)",
  "OARC-W023": "code-first region has no intent: no JSDoc of its own or inherited (its signature and tests are the only guidance)",
  "OARC-W044": "thin examples: fewer than 3, or none with an edge case (empty, zero, negative, null); passing them proves little (openarc check <id> --oracle)",
  "OARC-W045": "region unverified: no passing example or test reaches it (not cached as verified, not committed; add one that does)",
  "OARC-E041": "refine: \"next\" is unsupported in v0",
  "OARC-E050": "unknown manifest schema",
  "OARC-E051": "invalid openarc.config.json",
  "OARC-W060": "manual edit detected; region is developer-managed and will not be regenerated (openarc release <id> to hand it back)",
  "OARC-E061": "spec changed on a developer-managed region (openarc resolve <id> --keep|--regen)",
  "OARC-E062": "region markers removed (openarc resolve <id> --unlink)",
  "OARC-E063": "region moved to a different parent",
  "OARC-E064": "@arc id disagrees with the region's markers (the markers are its identity after the first commit)",
  "OARC-E070": "type error (detail test:TS<code>: in a test that runs for the region; sketch:TS<code>: in a sketch; spec:TS<code>: outside the regions, so no body can fix it)",
  "OARC-E080": "model backend unavailable",
  "OARC-E082": "repair attempts exhausted",
  "OARC-E090": "example failed",
  "OARC-E091": "sandbox timeout or resource limit",
  "OARC-E092": "sandbox unavailable",
  "OARC-W046": "weaker isolation: Node permission model only (no OS sandbox)",
  "OARC-W047": "NO SANDBOX: sandbox.isolation is \"unsafe-none\"; generated code runs with your full user permissions",
  "OARC-W094": "recovered an interrupted transaction",
  "OARC-E095": "another openarc process holds .openarc/lock",
  "OARC-E096": "the file changed on disk during the compile; nothing was written (run again)",
  "OARC-E097": "write-scope violation: generated code may only change its own region (specs, tests and other code are compiler-protected)",
  "OARC-E098": "call not allowed by spec (its `calls` list)",
};

const fmt = (d: Diagnostic) =>
  `${d.code.startsWith("OARC-E") ? "error  " : "warning"} ${d.code} ${[d.id, d.file && `${d.file}${d.line ? `:${d.line}` : ""}`].filter(Boolean).join(" ")}  ${MESSAGES[d.code] ?? ""}${d.detail ? ` [${d.detail}]` : ""}`;

function findRoot(start: string): string {
  for (let d = start; ; d = dirname(d)) {
    if (existsSync(`${d}/openarc.config.json`) || existsSync(`${d}/package.json`)) return d;
    if (dirname(d) === d) return start;
  }
}

export function realPorts(root: string): Ports {
  const p = (rel: string) => resolve(root, rel);
  return {
    fs: {
      async read(rel) {
        try {
          return await readFile(p(rel), "utf8");
        } catch {
          return null;
        }
      },
      async write(rel, data) {
        await mkdir(dirname(p(rel)), { recursive: true });
        await writeFile(p(rel), data);
      },
      async append(rel, data) {
        await mkdir(dirname(p(rel)), { recursive: true });
        await appendFile(p(rel), data);
      },
      async rename(from, to) {
        await mkdir(dirname(p(to)), { recursive: true });
        await rename(p(from), p(to));
      },
      async remove(rel) {
        await rm(p(rel), { recursive: true, force: true, maxRetries: 5 }); // Windows: a just-exited sandbox can hold a handle briefly
      },
      async list(rel) {
        try {
          return (await readdir(p(rel))).sort();
        } catch {
          return [];
        }
      },
      async createExclusive(rel) {
        await mkdir(dirname(p(rel)), { recursive: true });
        try {
          const h = await open(p(rel), "wx");
          try {
            await h.writeFile(String(process.pid)); // lock.ts tells a held lock from one left by a crash
          } catch {
            await h.close().catch(() => {});
            await rm(p(rel), { force: true }); // ours, created a moment ago: don't leave an empty lock behind
            return false;
          }
          await h.close();
          return true;
        } catch {
          return false;
        }
      },
    },
    http: {
      // node:http, not fetch: fetch drops a request whose response headers take over 300 s (undici headersTimeout),
      // and a non-streamed completion sends none until it is done, so a slow model (~8 tokens/s, e.g. a 14B partly on
      // the CPU) failed every long reply as "fetch failed". What fetch did besides is kept: same-origin 307/308
      // redirects (the body re-sent; another origin would get the API key, so it is an error) and gzip/deflate/br bodies.
      // ponytail: a fixed 30 min of silence ends a request; a config knob if a model ever needs longer.
      async postJson(url, body, headers) {
        const data = JSON.stringify(body);
        for (let u = new URL(url), hops = 0; ; hops++) {
          const res = await new Promise<http.IncomingMessage>((ok, no) => {
            const req = (u.protocol === "https:" ? https : http).request(u, { method: "POST", timeout: 30 * 60_000, headers: { ...headers, "content-type": "application/json", "content-length": Buffer.byteLength(data) } }, ok);
            req.on("timeout", () => req.destroy(new Error("no response from the model server in 30 min")));
            req.on("error", no);
            req.end(data);
          });
          const chunks: Buffer[] = [];
          for await (const c of res) chunks.push(c as Buffer);
          const status = res.statusCode ?? 0;
          if ((status === 307 || status === 308) && res.headers.location) {
            const next = new URL(res.headers.location, u);
            if (next.origin !== u.origin || hops >= 5) throw new Error(`HTTP ${status}: ${next.origin !== u.origin ? "redirect to another origin" : "too many redirects"} (${next.href}); set the backend's baseUrl to the final URL`);
            u = next;
            continue;
          }
          const raw = Buffer.concat(chunks);
          const enc = res.headers["content-encoding"]?.toLowerCase();
          const text = (enc === "br" ? brotliDecompressSync(raw) : enc === "gzip" || enc === "deflate" ? unzipSync(raw) : raw).toString("utf8");
          if (status < 200 || status > 299) throw new Error(`HTTP ${status}: ${text.slice(0, 200)}`);
          return text;
        }
      },
      async get(url) {
        const r = await fetch(url);
        const text = await r.text();
        if (!r.ok) throw new Error(`HTTP ${r.status}: ${text.slice(0, 200)}`);
        return text;
      },
    },
    proc: {
      run(argv, timeoutMs, opts) {
        return new Promise((done) => {
          const child = spawn(argv[0]!, argv.slice(1), { stdio: [opts?.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"], ...(opts?.cwd ? { cwd: opts.cwd } : {}) });
          if (opts?.stdin !== undefined) {
            child.stdin!.on("error", () => {}); // a CLI that exits early: its code says so
            child.stdin!.end(opts.stdin);
          }
          let stdout = "", stderr = "", timedOut = false;
          child.stdout!.on("data", (b) => (stdout += b));
          child.stderr!.on("data", (b) => (stderr += b));
          const t = setTimeout(() => {
            timedOut = true;
            child.kill("SIGKILL");
          }, timeoutMs);
          child.on("error", (e) => {
            clearTimeout(t);
            done({ code: null, stdout: `${stdout}\n${e.message}`, timedOut });
          });
          child.on("close", (code) => {
            clearTimeout(t);
            done({ code, stdout: code === 0 ? stdout : `${stdout}\n${stderr}`, timedOut });
          });
        });
      },
    },
    now: () => new Date().toISOString(),
    newTxId: () => `${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`,
    log: (line) => process.stderr.write(line + "\n"),
  };
}

/** The Node version the harness runs under: sandbox.nodeBin's own, not this CLI's. */
const harnessNodeVersion = (cfg: OpenArcConfig): string => nodeVersionOf(cfg.sandbox?.nodeBin ?? process.execPath);

const tierOf = (cfg: OpenArcConfig): TierChoice => chooseTier(cfg.sandbox?.isolation ?? "auto", process.platform, probeTools());

/** The sandbox notice for this run, printed once by every command that runs examples: W046 for the node tier, W047 at
 *  error level for unsafe-none (every run), E092 when the configured tier is unavailable (the caller then stops). */
function isolationNotice(cfg: OpenArcConfig): boolean {
  const t = tierOf(cfg);
  if ("error" in t) {
    console.error(fmt({ code: "OARC-E092", detail: t.error }));
    return false;
  }
  if (t.tier === "node") {
    const v = harnessNodeVersion(cfg);
    console.error(fmt({ code: "OARC-W046", detail: nodeBlocksNetwork(v) ? "node" : `node-${v}:network-not-blocked` }));
  }
  if (t.tier === "unsafe-none") console.error(`error   ${fmt({ code: "OARC-W047" }).slice(8)}`);
  return true;
}

function request(root: string, project: { config: OpenArcConfig } | null, ids: string[]): CompileRequest {
  const cfg = project?.config ?? DEFAULT_CONFIG;
  const tier = tierOf(cfg);
  const b = cfg.backends[cfg.compilation.defaultBackend]!;
  const nodeBin = cfg.sandbox?.nodeBin ?? process.execPath; // execPath is the resolved binary, never a version-manager shim
  return {
    root,
    ids,
    model: { host: hostOf(b), model: b.model, seed: b.seed ?? 1, numCtx: b.maxContextTokens },
    sandbox: {
      nodeBin,
      nodePrefix: dirname(dirname(nodeBin)),
      heapMb: cfg.sandbox?.heapMb ?? 512,
      addressSpaceBytes: cfg.sandbox?.addressSpaceBytes ?? 32 * 1024 ** 3, // virtual, not RAM: Node's WASM type stripper reserves ~10 GiB
      cpuSeconds: cfg.sandbox?.cpuSeconds ?? 20,
      ...("error" in tier ? { unavailable: tier.error } : { isolation: tier.tier }),
      ...(cfg.sandbox?.containerImage ? { containerImage: cfg.sandbox.containerImage } : {}),
    },
  };
}

/** `openarc init`'s code-first starter (only in a project with no src/ yet): an interface, a class with one pending
 *  method, and its tests. */
const STARTER: Record<string, string> = {
  "src/hello.ts": `import * as arc from "open-arc";

/** Greets people by name. */
export interface Greeter {
  /**
   * "Hello, <name>!" with the name trimmed of surrounding spaces;
   * "Hello, world!" when the name is empty or only spaces.
   */
  greet(name: string): string;
}

export class FriendlyGreeter implements Greeter {
  greet(name: string): string {
    return arc.todo();
  }
}
`,
  "src/hello.test.ts": `import * as arc from "open-arc";
import { FriendlyGreeter } from "./hello.ts";

arc.test(FriendlyGreeter, "greets by name", (G, expect) => {
  const g = new G();
  expect(g.greet("Ada")).toBe("Hello, Ada!");
  expect(g.greet("  Bob ")).toBe("Hello, Bob!");
});

arc.test(FriendlyGreeter, "an empty name greets the world", (G, expect) => {
  expect(new G().greet("")).toBe("Hello, world!");
  expect(new G().greet("   ")).toBe("Hello, world!");
});
`,
};

const TSCONFIG = {
  compilerOptions: {
    target: "es2023", module: "nodenext", moduleResolution: "nodenext", strict: true, noEmit: true,
    erasableSyntaxOnly: true, verbatimModuleSyntax: true, allowImportingTsExtensions: true, skipLibCheck: true,
  },
  include: ["src", "tests"],
};

async function analyzeOffline(ports: Ports, root: string, diagnostics: Diagnostic[]) {
  const project = await engine.parse(ports, request(root, null, []), diagnostics);
  await engine.analyze(ports, request(root, project, []), project, diagnostics, { offline: true });
  return project;
}

const USAGE = `usage: openarc init [--example|--no-example] [--backend <preset> [--model <id>] [--base-url <url>]] | backends [test [name]] | scaffold | compile [--keep-going] [--timings] [--retry-failed] [ids...] | watch [--debounce <ms>] | graph | inspect <id>
       openarc freeze|release <id> | resolve <id> --keep|--regen|--unlink
       openarc extract <file> [--function <name>] [--id <id>] [--style code|region]
       openarc migrate <id>
       openarc check <id> --oracle <module>#<export> [--runs <n>] [--seed <n>] | check <ids...> --mutants [--operators trivial,boundary,comparison,constant,logical,guard,swap]
       openarc doctor
       openarc adopt [--brief] [--json] [--no-model] | sync [--watch] [--brief] [--json] [--no-model]
       openarc decompile [dirs...] [--out=<dir>] [--run-tests[=<command>]] [--fresh] [--json] | decompile --report|--todo [--json]
       openarc arch [dirs...] [--check] [--json] | concept [--check] [--json]
       openarc status [--json] [--part <name>] [--goal <name>]
       openarc deps suggest <id> [--max <n>] [--json] [--no-trial] [--query <text>] [--keep]
       ${LINT_USAGE}`;

/** What git doesn't need from .openarc/: adds the lines that are missing. True when it wrote. */
async function ensureIgnored(ports: Ports): Promise<boolean> {
  const ignore = ["lock", "sandbox/", "txn/", "watch-history.jsonl", "attempts/", "traces.jsonl", "sheet-state.json", "sync-status.json", "sync-watch.pid", "usage.jsonl"];
  const had = await ports.fs.read(".openarc/.gitignore");
  const missing = ignore.filter((l) => !(had ?? "").split("\n").includes(l));
  if (!missing.length) return false;
  await ports.fs.write(".openarc/.gitignore", (had ?? "") + (had && !had.endsWith("\n") ? "\n" : "") + missing.join("\n") + "\n");
  return true;
}

/** `openarc decompile [dirs...]`: code to `.arc` specs, nothing in the code changes. `--report` and `--todo` read the last run. */
async function decompileCmd(root: string, ports: Ports, argv: string[]): Promise<number> {
  const flags = argv.filter((a) => a.startsWith("--")), dirs = argv.filter((a) => !a.startsWith("--")).map((d) => d.replace(/\/+$/, ""));
  const known = /^--(report|todo|json|fresh|run-tests(=.+)?|out=.+)$/;
  if (flags.some((f) => !known.test(f)) || dirs.some((d) => d.startsWith("/") || d.split("/").includes(".."))) {
    console.error(`openarc: bad-flag\n\n${USAGE}`);
    return 2;
  }
  const has = (f: string) => flags.includes(f);
  let state: DecompileState;
  if (has("--report") || has("--todo")) {
    const text = await ports.fs.read(STATE_FILE);
    if (text === null) return console.error("openarc: nothing decompiled yet; run `openarc decompile` first"), 1;
    state = JSON.parse(text) as DecompileState;
  } else {
    await ensureIgnored(ports);
    const testCmd = flags.find((f) => f.startsWith("--run-tests"));
    state = await decompile({
      ports, root, request: (p, ids) => request(root, p, ids), log: (l) => !has("--json") && console.log(l),
      dirs: dirs.length ? dirs : ["src"], out: flags.find((f) => f.startsWith("--out="))?.slice(6) ?? "arc/spec", fresh: has("--fresh"),
      ...(testCmd ? { testCmd: testCmd.includes("=") ? testCmd.slice(testCmd.indexOf("=") + 1).split(" ") : [process.execPath, "--test"] } : {}),
    });
  }
  if (has("--todo")) {
    const arcs = new Map<string, ArcModule>();
    for (const m of Object.values(state.modules)) {
      const t = await ports.fs.read(m.arc);
      try { if (t !== null) arcs.set(m.arc, parseArc(t)); } catch { /* reported by the next decompile */ }
    }
    const list = todo(state, arcs);
    console.log(has("--json") ? JSON.stringify(list) : list.join("\n") || "every function has an intent");
    return 0;
  }
  const r = report(state);
  if (has("--json")) return console.log(JSON.stringify({ totals: r.totals, modules: state.modules })), 0;
  if (has("--report")) for (const l of r.lines) console.log(l);
  console.log(`decompiled ${Object.keys(state.modules).length} modules: tested ${r.totals.tested}, failing ${r.totals.failing}, examples ${r.totals.examples}, described ${r.totals.described}, bare ${r.totals.bare}, skipped ${r.totals.skipped}`);
  return 0;
}

/** `openarc arch [dirs...] [--check] [--json]`: the parts, which part uses which, and the packages, derived from the real
 *  imports and checked against them (src/levels.ts). A later derive only adds. */
async function archCmd(root: string, ports: Ports, argv: string[]): Promise<number> {
  const flags = argv.filter((a) => a.startsWith("--")), dirs = argv.filter((a) => !a.startsWith("--")).map((d) => d.replace(/\/+$/, ""));
  if (flags.some((f) => f !== "--check" && f !== "--json") || dirs.some((d) => d.startsWith("/") || d.split("/").includes(".."))) {
    console.error(`openarc: bad-flag\n\n${USAGE}`);
    return 2;
  }
  const json = flags.includes("--json"), code = await sources(ports, dirs.length ? dirs : ["src"]), files = [...code.keys()], edges = importsOf(code);
  const text = await ports.fs.read(ARCH_FILE);
  let a: Arch | null;
  try { a = text === null ? null : parseArch(text); } catch (e) { return console.error(`${ARCH_FILE}: ${(e as Error).message}`), 1; }
  if (flags.includes("--check")) {
    if (!a) return console.error(`openarc: no ${ARCH_FILE} yet; run \`openarc arch\` first`), 1;
    const r = checkArch(a, files, edges);
    return console.log(formatReport(r, json)), r.ok ? 0 : 1;
  }
  const added = a ? updateArch(a, files, edges) : [];
  a ??= deriveArch(await projectName(ports, root), files, edges);
  const out = printArch(a);
  if (out !== text) await ports.fs.write(ARCH_FILE, out);
  if (json) return console.log(JSON.stringify({ added, parts: a.parts.length, modules: files.length, externals: a.externals.length })), 0;
  for (const l of added) console.log(`added ${l}`);
  console.log(`${ARCH_FILE}: ${a.parts.length} parts, ${files.length} modules, ${a.externals.length} externals`);
  return 0;
}

/** `openarc concept [--check] [--json]`: what the project is for, its goals traced to the architecture's parts. Without a
 *  file it writes a minimal one; with one it reprints it in canonical form. */
async function conceptCmd(root: string, ports: Ports, argv: string[]): Promise<number> {
  if (argv.some((f) => f !== "--check" && f !== "--json")) {
    console.error(`openarc: bad-flag\n\n${USAGE}`);
    return 2;
  }
  const json = argv.includes("--json"), [archText, text] = await Promise.all([ports.fs.read(ARCH_FILE), ports.fs.read(CONCEPT_FILE)]);
  let parts: string[] = [], c: Concept;
  try { if (archText !== null) parts = parseArch(archText).parts.map((p) => p.name); } catch (e) { return console.error(`${ARCH_FILE}: ${(e as Error).message}`), 1; }
  try { c = text === null ? { name: await projectName(ports, root), intent: [], goals: [], nongoals: [], terms: [] } : parseConcept(text); } catch (e) { return console.error(`${CONCEPT_FILE}: ${(e as Error).message}`), 1; }
  if (argv.includes("--check")) {
    const r = checkConcept(c, parts);
    return console.log(formatReport(r, json)), r.ok ? 0 : 1;
  }
  const out = printConcept(c);
  if (out !== text) await ports.fs.write(CONCEPT_FILE, out);
  if (json) return console.log(JSON.stringify({ goals: c.goals.length, parts })), 0;
  console.log(`${CONCEPT_FILE}: ${c.goals.length} goals, ${c.nongoals.length} nongoals, ${c.terms.length} terms`);
  console.log(archText === null ? `no ${ARCH_FILE} yet; run \`openarc arch\` for the parts goals trace to` : `parts goals can trace to: ${parts.join(", ")}`);
  return 0;
}

/** `openarc status [--json] [--part <name>] [--goal <name>]`: what backs each goal and part, read from the level files
 *  and the last decompile (src/levels.ts). Runs nothing, writes nothing. */
async function statusCmd(ports: Ports, argv: string[]): Promise<number> {
  const only: { part?: string; goal?: string } = {};
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const f = argv[i]!, v = argv[i + 1];
    if (f === "--json") json = true;
    else if ((f === "--part" || f === "--goal") && v && !v.startsWith("--") && !only.part && !only.goal) (only[f === "--part" ? "part" : "goal"] = v), i++;
    else return console.error(`openarc: bad-flag\n\n${USAGE}`), 2;
  }
  const [st, at, ct] = await Promise.all([STATE_FILE, ARCH_FILE, CONCEPT_FILE].map((f) => ports.fs.read(f)));
  let a: Arch | null, c: Concept | null, s: DecompileState;
  try { a = at === null ? null : parseArch(at); } catch (e) { return console.error(`${ARCH_FILE}: ${(e as Error).message}`), 1; }
  try { c = ct === null ? null : parseConcept(ct); } catch (e) { return console.error(`${CONCEPT_FILE}: ${(e as Error).message}`), 1; }
  if (st === null) return console.error([STATE_FILE, ...(c ? [] : [CONCEPT_FILE]), ...(a ? [] : [ARCH_FILE])].map(missingLine).join("\n")), 1;
  try { s = JSON.parse(st) as DecompileState; } catch (e) { return console.error(`${STATE_FILE}: ${(e as Error).message}`), 1; }
  const r = rollUp(s, a, c);
  if (!only.part && !only.goal) return console.log(json ? JSON.stringify(r) : formatStatus(r)), 0;
  const x = only.part ? r.parts.find((p) => p.name === only.part) : r.goals.find((g) => g.name === only.goal);
  if (!x) return console.error(only.part ? `openarc: no part ${only.part} in ${ARCH_FILE}` : `openarc: no goal ${only.goal} in ${CONCEPT_FILE}`), 1;
  return console.log(json ? JSON.stringify(x) : statusDetail(x, s)), 0;
}

/** `openarc adopt` and `openarc sync [--watch] [--brief] [--json] [--no-model]` (src/sync.ts). */
async function syncCmd(root: string, ports: Ports, argv: string[]): Promise<number> {
  const [cmd, ...flags] = argv;
  const known = new Set(["--watch", "--brief", "--json", "--no-model"]);
  if (flags.some((f) => !known.has(f)) || (cmd === "adopt" && flags.includes("--watch"))) {
    console.error(`openarc: bad-flag\n\n${USAGE}`);
    return 2;
  }
  if ((await ports.fs.read("openarc.config.json")) === null) {
    await ports.fs.write("openarc.config.json", JSON.stringify(DEFAULT_CONFIG, null, 2) + "\n");
    console.log("created openarc.config.json");
  }
  await ensureIgnored(ports);
  clearStaleLock(root, (l) => console.error(l));
  const ctx: SyncCtx = { ports, root, request: (p, ids) => request(root, p, ids), run, noModel: flags.includes("--no-model"), log: (l) => console.log(l) };
  const show = (s: SyncStatus) => {
    if (flags.includes("--json")) return console.log(JSON.stringify(s));
    console.log(brief(s));
    if (!flags.includes("--brief")) for (const a of s.attention) console.log(`  ${a.id}: ${a.what}`);
  };
  /** The lock covers this pass's own writes; compile takes it itself, so it is held only around a pass with no compile running. */
  const pass = async () => {
    for (const txid of await recover(ports.fs)) console.error(fmt({ code: "OARC-W094", detail: txid }));
    return syncOnce(ctx);
  };
  if (cmd === "adopt") {
    const r = await adopt(ctx);
    if (r.extracted.length) console.log(`adopted ${r.extracted.length} functions, bodies unchanged, developer-owned`);
    for (const x of r.refused) console.log(`  not adopted ${x.name}: ${x.reason}`);
    console.log(`spec sheet: ${SHEET_FILE}`);
    show(r.status);
    return r.status.error ? 1 : 0;
  }
  if (!flags.includes("--watch")) {
    const s = await pass();
    show(s);
    return s.error ? 1 : 0;
  }
  // One watcher per project, however many agent sessions ask for it: its status is .openarc/sync-status.json.
  const pidFile = ".openarc/sync-watch.pid";
  const other = Number(await ports.fs.read(pidFile));
  if (other && other !== process.pid) {
    try {
      process.kill(other, 0);
      console.log(`[sync] already watching (pid ${other})`);
      const seen = await ports.fs.read(".openarc/sync-status.json");
      if (seen && flags.includes("--json")) console.log(JSON.stringify(JSON.parse(seen)));
      return 0;
    } catch {
      // that process is gone: this one takes over
    }
  }
  await ports.fs.write(pidFile, String(process.pid));
  // Started by an agent session: when that session dies, so does the watcher, whatever signal it did or didn't get.
  const parent = process.ppid;
  setInterval(() => {
    if (process.ppid !== parent) process.exit(0);
  }, 5000).unref();
  // One worker, like openarc watch: changes during a pass only mark it dirty. A pass that wrote triggers one more, which
  // finds nothing and writes nothing, so the loop stops by itself.
  let busy = false, dirty = false, timer: ReturnType<typeof setTimeout> | null = null;
  const tick = async () => {
    if (busy) return void (dirty = true);
    busy = true;
    try {
      const s = await pass();
      show(s);
      // A backend that was down or still loading isn't the region's fault: try again without waiting for a save.
      if (s.attention.some((x) => x.what.includes("OARC-E080") || x.what.includes("backend not ready"))) setTimeout(schedule, 30_000);
    } catch (e) {
      console.error(`[sync] ${(e as Error).message}`);
    }
    busy = false;
    dirs.rewatch();
    if (dirty) (dirty = false), schedule();
  };
  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void tick(), 500);
  };
  // tests/ too: a code-first test is part of its regions' context, as in openarc watch.
  const dirs = watchDirs(root, ["src", "tests"], (rel) => {
    if (testFile(rel)) schedule();
  });
  watch(root, (_e, name) => {
    if (name === SHEET_FILE || name === "openarc.config.json") schedule();
  });
  console.log(`[sync] watching ${SHEET_FILE}, src/ and tests/ (Ctrl+C to stop)`);
  schedule();
  await new Promise(() => {});
  return 0;
}

/** `openarc backends [test [name]]`: list the configured backends, or send one tiny request through one of them. */
async function backends(ports: Ports, args: string[]): Promise<number> {
  const text = await ports.fs.read("openarc.config.json");
  const { config, error } = parseConfig(text);
  if (error) {
    console.error(error);
    return 1;
  }
  if (args.length === 0) {
    if (text === null) console.log("no openarc.config.json: the built-in default (run `openarc init`)");
    for (const [name, b] of Object.entries(config.backends)) console.log(describeBackend(name, b, name === config.compilation.defaultBackend));
    return 0;
  }
  if (args[0] !== "test" || args.length > 2) {
    console.error(`openarc: bad-flag\n\n${USAGE}`);
    return 2;
  }
  const name = args[1] ?? config.compilation.defaultBackend;
  const b = config.backends[name];
  if (!b) {
    console.error(`no backend "${name}" (configured: ${Object.keys(config.backends).join(", ")})`);
    return 2;
  }
  console.log(describeBackend(name, b, name === config.compilation.defaultBackend));
  const r = await testBackend(ports, b);
  console.log(`${name}: ${r.ok ? "OK" : "FAIL"} ${(r.ms / 1000).toFixed(1)}s · ${r.detail}`);
  return r.ok ? 0 : 1;
}

/** `openarc init` flags: --backend <preset> [--model <id>] [--base-url <url>] -> the config to write, or a usage error. */
function initConfig(args: string[]): OpenArcConfig | string {
  if (args.length === 0) return DEFAULT_CONFIG;
  const o: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    const v = args[i + 1];
    if (!["--backend", "--model", "--base-url"].includes(args[i]!) || v === undefined) return "bad-flag";
    o[args[i]!] = v;
  }
  return o["--backend"] ? presetConfig(o["--backend"], o["--model"], o["--base-url"]) : "init --model/--base-url need --backend <preset>";
}

/** `--runs <n> --seed <n>`: a positive integer, and an integer the 32-bit PRNG tells apart. null: a bad flag. */
function oracleFlags(args: string[]): { count?: number; seed?: number } | null {
  const o: { count?: number; seed?: number } = {};
  for (let i = 0; i < args.length; i += 2) {
    const n = /^\d+$/.test(args[i + 1] ?? "") ? Number(args[i + 1]) : NaN;
    if (args[i] === "--runs" && n >= 1 && Number.isSafeInteger(n)) o.count = n;
    else if (args[i] === "--seed" && n <= 0xffffffff) o.seed = n;
    else return null;
  }
  return o;
}

/** `openarc check <id> --oracle <module>#<export> [--runs <n>] [--seed <n>]`: differential test against a reference implementation (engine.oracleCheck). */
async function check(root: string, ports: Ports, args: string[]): Promise<number> {
  if (args.includes("--mutants")) return mutantsCmd(root, ports, args);
  const [id, flag, oracle, ...rest] = args;
  const opts = oracleFlags(rest);
  if (!id || flag !== "--oracle" || !oracle || !opts) {
    console.error(`openarc: bad-flag\n\n${USAGE}`);
    return 2;
  }
  const diagnostics: Diagnostic[] = [];
  const project = await analyzeOffline(ports, root, diagnostics);
  if (!isolationNotice(project.config)) return 1;
  const res = await engine.oracleCheck(ports, request(root, project, [id]), project, id, oracle, opts);
  if (res.error && !res.inputs) {
    console.error(`check ${id}: ${res.error}`);
    return 1;
  }
  for (const d of res.disagreements.slice(0, 20)) console.log(`  ${engine.showDisagreement(d)}`);
  if (res.disagreements.length > 20) console.log(`  … ${res.disagreements.length - 20} more`);
  console.log(`check ${id} against ${oracle}: ${res.agreed}/${res.inputs} inputs agree (seed ${opts.seed ?? 1})${res.error ? `; ${res.error}` : ""}`);
  return res.disagreements.length || res.error ? 1 : 0;
}

/** `openarc check <ids...> --mutants [--operators a,b]`: how many mutants each region's examples/tests kill
 *  (engine.mutantCheck). A report: exit 0 whatever survives, 2 on a bad flag. */
async function mutantsCmd(root: string, ports: Ports, args: string[]): Promise<number> {
  const at = args.indexOf("--operators");
  const ops = at < 0 ? [...engine.MUTANT_OPS] : (args[at + 1] ?? "").split(",");
  const ids = args.filter((a, i) => a !== "--mutants" && (at < 0 || (i !== at && i !== at + 1)));
  if (!ids.length || ids.some((a) => a.startsWith("--")) || ops.some((o) => !(engine.MUTANT_OPS as readonly string[]).includes(o))) {
    console.error(`openarc: bad-flag\n\n${USAGE}`);
    return 2;
  }
  const project = await analyzeOffline(ports, root, []);
  if (!isolationNotice(project.config)) return 1;
  for (const id of ids) {
    const rep = await engine.mutantCheck(ports, request(root, project, [id]), project, id, ops as engine.MutantOp[]);
    for (const line of engine.mutantLines(rep)) console.log(line);
  }
  return 0;
}

/** `openarc migrate <id>`: one classic function region to code-first (src/migrate.ts), locked and transactional. */
async function migrateCmd(root: string, ports: Ports, args: string[]): Promise<number> {
  if (args.length !== 1) {
    console.error(`openarc: ${args.length ? "bad-flag" : "missing-id"}\n\n${USAGE}`);
    return 2;
  }
  clearStaleLock(root, (l) => console.error(l));
  if (!(await ports.fs.createExclusive(".openarc/lock"))) {
    console.error(fmt({ code: "OARC-E095" }));
    return 1;
  }
  try {
    for (const txid of await recover(ports.fs)) console.error(fmt({ code: "OARC-W094", detail: txid }));
    const project = await engine.parse(ports, request(root, null, []), []);
    const res = await migrate(ports, request(root, project, []), project, args[0]!);
    if (res.refused) {
      console.error(`refused ${args[0]}: ${res.refused}`);
      return 1;
    }
    const txid = ports.newTxId();
    for (const [i, f] of res.files.entries()) await ports.fs.write(`.openarc/txn/${txid}/stage/${i}`, f.text);
    await commit(ports.fs, planJournal(txid, res.files.map((f, i) => ({ target: f.target, staged: `.openarc/txn/${txid}/stage/${i}` }))));
    console.log(`migrated ${args[0]} to code-first (${res.files[0]!.target}); id, ownership and provenance kept`);
    return 0;
  } finally {
    await ports.fs.remove(".openarc/lock");
  }
}

/** `openarc doctor`: the selected isolation tier, then one example through it that must also fail to write a file, start
 *  a process and reach the network. No model. Exit 1 if the sandbox is unavailable or lets something through. */
async function doctor(root: string, ports: Ports): Promise<number> {
  const { config, error } = parseConfig(await ports.fs.read("openarc.config.json"));
  if (error) {
    console.error(error);
    return 1;
  }
  const tools = probeTools();
  const t = tierOf(config);
  console.log(`node ${process.versions.node} (${process.execPath}) on ${process.platform}-${process.arch}`);
  console.log(`tools: bwrap ${tools.bwrap ? "works" : "no"} · sandbox-exec ${tools.sandboxExec ? "yes" : "no"} · container ${tools.container ?? "no"}`);
  console.log(`isolation: ${config.sandbox?.isolation ?? "auto"} -> ${"error" in t ? `unavailable (${t.error})` : `${t.tier} (${t.reason})`}`);
  if (!isolationNotice(config)) return 1;
  const res = await engine.sandboxProbe(ports, request(root, { config }, []));
  const tier = "error" in t ? "" : t.tier;
  const r = engine.doctorReport(res, tier, tier === "node" && !nodeBlocksNetwork(harnessNodeVersion(config)));
  for (const line of r.lines) (line.startsWith("sandbox:") ? console.error : console.log)(line);
  return r.ok ? 0 : 1;
}

/** `openarc deps suggest <id>`: search npm, filter on facts, trial in scratch copies, propose (src/deps.ts). Never writes
 *  the project: the scratch copies live under the OS temp dir and are removed unless --keep. Exit 0 (a report), 1 on an
 *  unknown region or a registry failure, 2 on a bad flag. */
const DEPS_CHILD_MS = 60 * 60_000; // ponytail: one fixed deadline per npm/compile/check child, above a slow local-model compile
async function depsCmd(root: string, ports: Ports, args: string[]): Promise<number> {
  const o = { max: 2, trial: true, json: false, keep: false, query: undefined as string | undefined };
  const [sub, id, ...flags] = args;
  let bad = false;
  for (let i = 0; i < flags.length; i++) {
    const f = flags[i]!, v = flags[i + 1];
    if (f === "--json") o.json = true;
    else if (f === "--no-trial") o.trial = false;
    else if (f === "--keep") o.keep = true;
    else if (f === "--max" && v && /^[1-9]\d?$/.test(v)) (o.max = +v), i++;
    else if (f === "--query" && v !== undefined && !v.startsWith("--")) (o.query = v), i++;
    else bad = true;
  }
  if (bad || sub !== "suggest" || !id || id.startsWith("--")) {
    console.error(`openarc: ${sub === "suggest" && !id ? "missing-id" : "bad-flag"}\n\n${USAGE}`);
    return 2;
  }
  const project = await analyzeOffline(ports, root, []);
  const r = project.regions.find((x) => x.id === id && x.kind === "function");
  if (!r) {
    console.error(`no function region ${id}`);
    return 1;
  }
  const view: RegionView = { id, file: r.file, specFile: r.spec.file, intent: r.spec.intent, signature: r.spec.signature, deps: r.spec.deps, codeFirst: !!r.spec.codeFirst, ownership: r.state };
  const backend = engine.backendFor(project, id, 0); // the region's backend, as compile picks it: the intent goes nowhere else
  const scratch: string[] = [];
  const NOISE = new Set([".git", ".openarc/sandbox", ".openarc/txn", ".openarc/lock", ".openarc/attempts", ".openarc/watch-history.jsonl", ".openarc/traces.jsonl"]);
  try {
    const rep = await suggest({
      http: ports.http,
      run: (argv, cwd) => new Promise((done) => {
        const child = spawn(argv[0]!, argv.slice(1), { cwd, stdio: ["ignore", "pipe", "pipe"] });
        // a hung npm or compile must not block forever (and keep the scratch copies): killed, code null = a failed arm
        const timer = setTimeout(() => child.kill("SIGKILL"), DEPS_CHILD_MS).unref();
        child.on("close", () => clearTimeout(timer));
        let out = "";
        child.stdout.on("data", (b) => (out += b));
        child.stderr.on("data", (b) => (out += b));
        child.on("error", (e) => done({ code: null, out: `${out}\n${e.message}` }));
        child.on("close", (code) => done({ code, out }));
      }),
      read: (abs) => readFile(abs, "utf8").catch(() => null),
      write: (abs, text) => writeFile(abs, text),
      async copyProject() {
        const dir = await mkdtemp(`${tmpdir()}/openarc-deps-`);
        scratch.push(dir);
        cpSync(root, dir, { recursive: true, verbatimSymlinks: true, filter: (src) => !NOISE.has(relative(root, src).split(sep).join("/")) });
        // a symlinked node_modules (a shared install) is copied for real, so npm install can't write through the link
        if (existsSync(`${root}/node_modules`) && lstatSync(`${root}/node_modules`).isSymbolicLink()) {
          rmSync(`${dir}/node_modules`);
          cpSync(realpathSync(`${root}/node_modules`), `${dir}/node_modules`, { recursive: true, verbatimSymlinks: true });
        }
        // the trial and the compile write the region's files: a symlinked one is copied for real, so no write reaches the
        // project through it; a symlinked directory above it is refused
        for (const f of new Set([view.file, view.specFile])) {
          const at = `${dir}/${f}`, up = relative(realpathSync(dir), realpathSync(dirname(at)));
          if (up.startsWith("..") || isAbsolute(up)) throw new Error(`${f} is under a symlinked directory: the trial would write through it into the project`);
          if (lstatSync(at).isSymbolicLink()) {
            const text = readFileSync(at);
            rmSync(at);
            writeFileSync(at, text);
          }
        }
        return dir;
      },
      cli: [process.execPath, ...process.execArgv, process.argv[1]!],
      now: new Date(),
      log: (l) => console.error(l),
    }, view, {
      max: o.max, trial: o.trial, keep: o.keep, ...(o.query !== undefined ? { query: o.query } : {}),
      // ponytail: one plain-text request; any failure falls back to the intent's words (suggest catches it)
      phrase: async (v) => parsePhrase(await complete(ports, { ...backend, outputFormat: "code", outputReserveTokens: 64 }, PHRASE_SYSTEM, phrasePrompt(v), process.env, 0)),
    });
    console.log(o.json ? JSON.stringify(rep, null, 2) : reportLines(rep).join("\n"));
    return 0;
  } catch (e) {
    console.error(`deps suggest ${id}: ${(e as Error).message}`);
    return 1;
  } finally {
    if (!o.keep) for (const d of scratch) rmSync(d, { recursive: true, force: true });
  }
}

async function main(argv: string[]): Promise<number> {
  const root = findRoot(process.cwd());
  const ports = realPorts(root);
  // Every command's requests are counted, not just sync's: sync's hosted budget reads this file, and compile spends too.
  ports.usage = (u) => {
    mkdirSync(`${root}/.openarc`, { recursive: true });
    appendFileSync(`${root}/.openarc/usage.jsonl`, JSON.stringify({ at: ports.now(), ...u }) + "\n");
  };
  // ponytail: `check` is parsed here, not in the cli.parseArgv region, so the self-hosted tree keeps its generated body.
  // Move it into cli.parseArgv's spec at the next self-compile.
  if (argv[0] === "check") return check(root, ports, argv.slice(1));
  // Same for `backends` and init's --backend flags (cli.parseArgv returns {cmd: "init"} whatever follows).
  if (argv[0] === "backends") return backends(ports, argv.slice(1));
  if (argv[0] === "doctor") return doctor(root, ports);
  if (argv[0] === "deps") return depsCmd(root, ports, argv.slice(1));
  if (argv[0] === "migrate") return migrateCmd(root, ports, argv.slice(1));
  if (argv[0] === "adopt" || argv[0] === "sync") return syncCmd(root, ports, argv);
  if (argv[0] === "decompile") return decompileCmd(root, ports, argv.slice(1));
  if (argv[0] === "arch" || argv[0] === "concept") return (argv[0] === "arch" ? archCmd : conceptCmd)(root, ports, argv.slice(1));
  if (argv[0] === "status") return statusCmd(ports, argv.slice(1));
  if (argv[0] === "lint") { // spec rules, offline: no model, no sandbox (src/lint.ts)
    const args = argv.slice(1).map((a, i, all) => (/[/\\]|\.tsx?$/.test(a) && all[i - 1] !== "--profile" && all[i - 1] !== "--format" ? relative(root, resolve(process.cwd(), a)).split(sep).join("/") : a));
    return lintCommand(ports, request(root, null, []), args, { out: (l) => console.log(l), err: (l) => console.error(l), message: (c) => MESSAGES[c] ?? "" });
  }
  // init's code-first starter: with --example, or by default at a terminal; --no-example skips it. ponytail: a script
  // (CI, the checks) gets no starter unless it asks, so an existing `init && write src/` flow is unchanged.
  const example = argv[0] === "init" && !argv.includes("--no-example") && (argv.includes("--example") || process.stdout.isTTY === true);
  if (argv[0] === "init") argv = argv.filter((a) => a !== "--example" && a !== "--no-example");
  const initWith = argv[0] === "init" ? initConfig(argv.slice(1)) : DEFAULT_CONFIG;
  if (typeof initWith === "string") {
    console.error(`openarc: ${initWith}\n\n${USAGE}`);
    return 2;
  }
  // code-first: `extract --style code|region` is parsed here (cli.parseArgv is a region; same note as `check` above).
  // The default is code-first: markers inside the body, `@arc id` in the JSDoc; `region` writes a defineRegion spec.
  let style: "code" | "region" = "code";
  const si = argv[0] === "extract" ? argv.indexOf("--style") : -1;
  if (si > 0) {
    const v = argv[si + 1];
    if (v !== "code" && v !== "region") {
      console.error(`openarc: bad-flag\n\n${USAGE}`);
      return 2;
    }
    style = v;
    argv = [...argv.slice(0, si), ...argv.slice(si + 2)];
  }
  const cmd = parseArgv(argv);
  const diagnostics: Diagnostic[] = [];
  const print = () => diagnostics.forEach((d) => console.error(fmt(d)));
  const manifestPath = ".openarc/manifest.json";
  const loadManifest = async () => JSON.parse((await ports.fs.read(manifestPath)) ?? '{"schema":1,"regions":{}}') as engine.Manifest;
  const saveManifest = (m: engine.Manifest) => ports.fs.write(manifestPath, JSON.stringify(m, null, 2) + "\n");

  switch (cmd.cmd) {
    case "usage":
      console.error(`openarc: ${cmd.reason}\n\n${USAGE}`);
      return 2;
    case "init": {
      const wrote: string[] = [];
      const put = async (rel: string, text: string) => {
        if ((await ports.fs.read(rel)) === null) {
          await ports.fs.write(rel, text);
          wrote.push(rel);
        }
      };
      const hadConfig = (await ports.fs.read("openarc.config.json")) !== null;
      await put("openarc.config.json", JSON.stringify(initWith, null, 2) + "\n");
      if (hadConfig && argv.length > 1) console.log("note: openarc.config.json already exists and was not changed; add the backend to it by hand (see `openarc backends`)");
      await put("tsconfig.json", JSON.stringify(TSCONFIG, null, 2) + "\n");
      await put(manifestPath, '{\n  "schema": 1,\n  "regions": {}\n}\n');
      await put(".openarc/harness.mjs", HARNESS_ENTRY);
      if (example && (await ports.fs.list("src")).length === 0) for (const [rel, text] of Object.entries(STARTER)) await put(rel, text); // code-first starter
      if (await ensureIgnored(ports)) wrote.push(".openarc/.gitignore");
      console.log(wrote.length ? `created: ${wrote.join(", ")}` : "already initialised");
      // `npm init -y` writes "type": "commonjs" now; tsc then fails with TS1295. The user's file: say so, don't edit it.
      const pkg = await ports.fs.read("package.json");
      let type: unknown = "module";
      try {
        if (pkg !== null) type = (JSON.parse(pkg) as { type?: unknown }).type;
      } catch {
        // not JSON: npm reports that itself
      }
      if (type !== "module") console.log(`note: package.json ${type === undefined ? 'has no "type"' : `has "type": ${JSON.stringify(type)}`}; OpenArc projects are ES modules (tsc fails with TS1295 otherwise): run \`npm pkg set type=module\``);
      if (initWith !== DEFAULT_CONFIG) console.log(`backend: ${initWith.compilation.defaultBackend}; check it with \`npx openarc backends test\``);
      console.log("next: write code in src/*.ts with `return arc.todo();` where the compiler should write the body, and arc.test cases\n(src/hello.ts is a start), then `npx tsc -p .`, then `npx openarc compile` (or `npx openarc watch`).\ndefineRegion specs work too: `npx openarc scaffold` adds their exported symbols");
      return 0;
    }
    case "scaffold": {
      const project = await engine.parse(ports, request(root, null, []), diagnostics);
      const ids = await engine.scaffoldProject(ports, project, diagnostics);
      print();
      console.log(ids.length ? `scaffolded: ${ids.join(", ")}` : "nothing to scaffold");
      return diagnostics.some((d) => d.code.startsWith("OARC-E")) ? 1 : 0;
    }
    case "compile": {
      clearStaleLock(root, (l) => console.error(l));
      const pre: Diagnostic[] = [];
      const project = await engine.parse(ports, request(root, null, []), pre);
      if (!isolationNotice(project.config)) return 1;
      const t0 = Date.now();
      const keepGoing = cmd.ids.includes("--keep-going");
      const timings = cmd.ids.includes("--timings");
      const retryFailed = cmd.ids.includes("--retry-failed");
      const res = await run(ports, { ...request(root, project, cmd.ids.filter((a) => !a.startsWith("--"))), keepGoing, ...(timings ? { timings } : {}), ...(retryFailed ? { retryFailed } : {}) });
      res.diagnostics.forEach((d) => console.error(fmt(d)));
      const stale = res.diagnostics.filter((d) => d.code === "OARC-W043").map((d) => d.id);
      if (stale.length) console.error(`stale: ${stale.join(", ")} keep${stale.length === 1 ? "s" : ""} a body that does not satisfy the current spec`);
      if (res.diagnostics.some((d) => d.code === "OARC-E080" && d.detail === "stopped:3-consecutive"))
        console.error("stopped early: the model backend failed 3 times in a row, so the remaining regions were skipped. Is it running (llama-server stopped, or Ollama OOM-killed?)");
      const exit = stale.length ? 1 : res.exit;
      console.error(`done: exit ${exit} · ${res.modelCalls} model call(s) · ${((Date.now() - t0) / 1000).toFixed(1)}s`);
      return exit;
    }
    case "extract": {
      const rel = relative(root, resolve(process.cwd(), cmd.file)).split(sep).join("/");
      // Locked from before the read to after the commit, like compile: an interrupted transaction is recovered first
      // (else a later compile would restore its backups over this extraction), and no other openarc writes meanwhile.
      clearStaleLock(root, (l) => console.error(l));
      if (!(await ports.fs.createExclusive(".openarc/lock"))) {
        console.error(fmt({ code: "OARC-E095" }));
        return 1;
      }
      let res: Awaited<ReturnType<typeof engine.extract>>;
      try {
        for (const txid of await recover(ports.fs)) diagnostics.push({ code: "OARC-W094", detail: txid });
        const project = await engine.parse(ports, request(root, null, []), diagnostics);
        res = await engine.extract(ports, request(root, project, []), project, rel, { fn: cmd.fn, id: cmd.id, style });
        if (res.files.length) {
          const txid = ports.newTxId();
          for (const [i, f] of res.files.entries()) await ports.fs.write(`.openarc/txn/${txid}/stage/${i}`, f.text);
          await commit(ports.fs, planJournal(txid, res.files.map((f, i) => ({ target: f.target, staged: `.openarc/txn/${txid}/stage/${i}` }))));
        }
      } finally {
        await ports.fs.remove(".openarc/lock");
      }
      print();
      for (const n of res.skipped) console.log(`already a region: ${n}`);
      for (const r of res.refused) console.error(`refused ${r.name}: ${r.reason}`);
      if (res.files.length) {
        console.log(`extracted (developer-owned): ${res.extracted.join(", ")}\n${style === "code" ? "review the JSDoc (the intent), add arc.test cases" : "review the [inferred] intents, add examples"}, then \`openarc release <id>\` to hand a region to the compiler`);
      } else if (!res.refused.length) console.log("nothing to extract");
      return res.refused.length ? 1 : 0;
    }
    case "watch": {
      // spec §15. One worker: analysis never overlaps a compile, so at most one model is resident.
      let config = DEFAULT_CONFIG;
      if (!isolationNotice(parseConfig(await ports.fs.read("openarc.config.json")).config)) return 1;
      const w = createWatcher({
        fs: ports.fs,
        print: (l) => console.log(l),
        debounceMs: cmd.debounceMs,
        backendProblem: (id) => engine.backendProblem(ports, config, id),
        async analyze() {
          const ds: Diagnostic[] = [];
          const project = await engine.parse(ports, request(root, null, []), ds);
          config = project.config;
          const req = request(root, project, []);
          await engine.analyze(ports, req, project, ds); // fingerprints when the backend answers /api/tags (no model load)
          // Backend down: no fingerprints, so fall back to the spec hash to notice edited specs of compiler regions.
          for (const r of project.regions)
            if (r.state === "compiler" && !r.fingerprint && project.manifest.regions[r.id]?.specHash !== r.specHash) r.stale = true;
          const rootOf = (id: string) => project.regions.find((r) => r.id === id)!.root; // blocks are verified with their function
          const targets = [...new Set(engine.plan(project, req, ds).map(rootOf))];
          const keys: Record<string, RegionKey> = {};
          const examples: Record<string, number> = {};
          for (const id of targets) {
            const tree = project.regions.filter((r) => r.root === id);
            keys[id] = regionKey(tree);
            examples[id] = project.specs.get(id)?.examples.length ?? 0;
          }
          return { targets, keys, examples };
        },
        async compile(id) {
          clearStaleLock(root, (l) => console.error(`[watch] ${l}`));
          const project = await engine.parse(ports, request(root, null, []), []);
          const res = await run(ports, { ...request(root, project, [id]), keepGoing: true });
          // The commit replaced files by rename. ponytail: every watched directory is re-created, not just the
          // committed files' ones (CompileResult doesn't list them); a handful of directories.
          dirWatch.rewatch();
          return res;
        },
      });
      clearStaleLock(root, (l) => console.error(`[watch] ${l}`));
      // src/ and tests/ (fakes, and code-first tests) one directory at a time (dirwatch.ts: a recursive fs.watch goes
      // blind to a file replaced by rename, which is how commits write), plus the root, non-recursively, for the config.
      // Not the whole tree: that would watch node_modules. ponytail: a src/ created after start needs a restart.
      const dirs = ["src", "tests"].filter((d) => existsSync(`${root}/${d}`));
      const dirWatch = watchDirs(root, dirs, (p) => w.onChange(p));
      const rootWatch = watch(root, (_e, f) => f && w.onChange(f));
      console.log(`[watch] watching ${[...dirs.map((d) => `${d}/`), "openarc.config.json"].join(", ")} (debounce ${cmd.debounceMs} ms, Ctrl+C to stop)`);
      return await new Promise<number>((done) => {
        let sigints = 0;
        process.on("SIGINT", () => {
          if (++sigints > 1) {
            console.log("[watch] aborted");
            releaseOwnLock(root); // the transaction journal makes the half-done compile safe; the lock must not linger
            process.exit(130);
          }
          void w.stop().then(() => {
            dirWatch.close();
            rootWatch.close();
            console.log("[watch] stopped");
            done(0);
          });
        });
        void w.start();
      });
    }
    case "graph":
    case "inspect": {
      const project = await analyzeOffline(ports, root, diagnostics);
      print();
      if (cmd.cmd === "graph") {
        const show = (parent: string | null, depth: number) => {
          for (const r of project.regions.filter((x) => x.parent === parent)) {
            console.log(`${"  ".repeat(depth)}${r.id.padEnd(34 - depth * 2)} ${r.kind === "function" ? "F" : "B"} ${engine.displayState(project, r).padEnd(10)} ${r.spec.examples.length} ex${r.spec.codeFirst ? ` ${r.spec.codeFirst.tests.length} tests` : ""}  ${r.file}`);
            show(r.id, depth + 1);
          }
        };
        show(null, 0);
        return 0;
      }
      const r = project.regions.find((x) => x.id === cmd.id);
      if (!r) {
        console.error(`no region ${cmd.id}`);
        return 1;
      }
      const state = engine.displayState(project, r);
      const note = state === "stale" ? { stale: "the spec changed since this body was verified; it may not satisfy the current examples (openarc compile)" } : {};
      console.log(JSON.stringify({ id: r.id, kind: r.kind, file: r.file, parent: r.parent, state, ownership: r.state, ...note, intent: r.spec.intent, examples: r.spec.examples.length, ...(r.spec.codeFirst ? { declaration: r.spec.codeFirst.declaration, tests: r.spec.codeFirst.tests.map((t) => `${t.kind}${t.hidden ? " (hidden)" : ""}: ${t.name}`) } : {}), tokens: project.manifest.regions[r.id]?.provenance.tokens ?? null, manifest: project.manifest.regions[r.id] ?? null }, null, 2));
      return 0;
    }
    case "freeze":
    case "release":
    case "resolve": {
      const project = await analyzeOffline(ports, root, diagnostics);
      const m = await loadManifest();
      const r = project.regions.find((x) => x.id === cmd.id);
      const entry = m.regions[cmd.id];
      if (cmd.cmd === "resolve" && cmd.mode === "unlink") {
        if (r) {
          console.error(`${cmd.id}: markers still present; remove them first`);
          return 1;
        }
        delete m.regions[cmd.id];
        await saveManifest(m);
        return 0;
      }
      if (!r) {
        console.error(`no region ${cmd.id}`);
        return 1;
      }
      const base = entry ?? { kind: r.kind, parent: r.parent, file: r.file, ownership: "developer" as const, hash: r.hash, specHash: r.specHash, fingerprint: null, provenance: { source: "extracted" } };
      if (cmd.cmd === "freeze" || (cmd.cmd === "resolve" && cmd.mode === "keep")) {
        m.regions[cmd.id] = { ...base, ownership: "developer", hash: r.hash, specHash: r.specHash };
      } else {
        // release / resolve --regen: back up the body, then hand it to the compiler (fingerprint null forces regeneration)
        await ports.fs.write(`.openarc/backup/${cmd.id}.${r.hash.slice(7, 19)}.ts`, r.bodyLines.join("\n") + "\n");
        m.regions[cmd.id] = { ...base, ownership: "compiler", hash: r.hash, specHash: r.specHash, fingerprint: null };
      }
      await saveManifest(m);
      console.log(`${cmd.id}: ${m.regions[cmd.id]!.ownership}`);
      return 0;
    }
  }
}

process.exitCode = await main(process.argv.slice(2));
