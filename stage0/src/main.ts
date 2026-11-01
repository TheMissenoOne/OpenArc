#!/usr/bin/env node
// `openarc` CLI entry point. Hand-written: the real ports plus command dispatch.
import { mkdir, open, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { existsSync, watch } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import type { CompileRequest, Diagnostic, Ports } from "./types.ts";
import { parseArgv } from "./cli.ts";
import { run } from "./compile.ts";
import { commit, planJournal, recover } from "./txn.ts";
import * as engine from "./engine.ts";
import { DEFAULT_CONFIG, hostOf, parseConfig, presetConfig, type OpenArcConfig } from "./config.ts";
import { describeBackend, testBackend } from "./backends.ts";
import { clearStaleLock, releaseOwnLock } from "./lock.ts";
import { createWatcher, regionKey, type RegionKey } from "./watcher.ts";
import { watchDirs } from "./dirwatch.ts";
import { migrate } from "./migrate.ts";
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
  "OARC-W042": "block held back: its function can't be verified until all its blocks exist (kept in the cache, committed by a later run)",
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
  "OARC-E070": "type error (detail test:TS<code>: in a test that runs for the region; sketch:TS<code>: in a sketch)",
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
      async postJson(url, body, headers) {
        const r = await fetch(url, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body) });
        const text = await r.text();
        if (!r.ok) throw new Error(`HTTP ${r.status}: ${text.slice(0, 200)}`);
        return text;
      },
      async get(url) {
        const r = await fetch(url);
        const text = await r.text();
        if (!r.ok) throw new Error(`HTTP ${r.status}: ${text.slice(0, 200)}`);
        return text;
      },
    },
    proc: {
      run(argv, timeoutMs) {
        return new Promise((done) => {
          const child = spawn(argv[0]!, argv.slice(1), { stdio: ["ignore", "pipe", "pipe"] });
          let stdout = "", stderr = "", timedOut = false;
          child.stdout.on("data", (b) => (stdout += b));
          child.stderr.on("data", (b) => (stderr += b));
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

const USAGE = `usage: openarc init [--example|--no-example] [--backend <preset> [--model <id>] [--base-url <url>]] | backends [test [name]] | scaffold | compile [--keep-going] [ids...] | watch [--debounce <ms>] | graph | inspect <id>
       openarc freeze|release <id> | resolve <id> --keep|--regen|--unlink
       openarc extract <file> [--function <name>] [--id <id>] [--style code|region]
       openarc migrate <id>
       openarc check <id> --oracle <module>#<export>
       openarc doctor`;

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

/** `openarc check <id> --oracle <module>#<export>`: differential test against a reference implementation (engine.oracleCheck). */
async function check(root: string, ports: Ports, args: string[]): Promise<number> {
  const [id, flag, oracle] = args;
  if (!id || flag !== "--oracle" || !oracle || args.length !== 3) {
    console.error(`openarc: bad-flag\n\n${USAGE}`);
    return 2;
  }
  const diagnostics: Diagnostic[] = [];
  const project = await analyzeOffline(ports, root, diagnostics);
  if (!isolationNotice(project.config)) return 1;
  const res = await engine.oracleCheck(ports, request(root, project, [id]), project, id, oracle);
  if (res.error && !res.inputs) {
    console.error(`check ${id}: ${res.error}`);
    return 1;
  }
  for (const d of res.disagreements.slice(0, 20)) console.log(`  ${engine.showDisagreement(d)}`);
  if (res.disagreements.length > 20) console.log(`  … ${res.disagreements.length - 20} more`);
  console.log(`check ${id} against ${oracle}: ${res.agreed}/${res.inputs} inputs agree (seed 1)${res.error ? `; ${res.error}` : ""}`);
  return res.disagreements.length || res.error ? 1 : 0;
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

async function main(argv: string[]): Promise<number> {
  const root = findRoot(process.cwd());
  const ports = realPorts(root);
  // ponytail: `check` is parsed here, not in the cli.parseArgv region, so the self-hosted tree keeps its generated body.
  // Move it into cli.parseArgv's spec at the next self-compile.
  if (argv[0] === "check") return check(root, ports, argv.slice(1));
  // Same for `backends` and init's --backend flags (cli.parseArgv returns {cmd: "init"} whatever follows).
  if (argv[0] === "backends") return backends(ports, argv.slice(1));
  if (argv[0] === "doctor") return doctor(root, ports);
  if (argv[0] === "migrate") return migrateCmd(root, ports, argv.slice(1));
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
      const ignore = ["lock", "sandbox/", "txn/", "watch-history.jsonl", "attempts/"];
      const had = await ports.fs.read(".openarc/.gitignore");
      const missing = ignore.filter((l) => !(had ?? "").split("\n").includes(l));
      if (missing.length) {
        await ports.fs.write(".openarc/.gitignore", (had ?? "") + (had && !had.endsWith("\n") ? "\n" : "") + missing.join("\n") + "\n");
        wrote.push(".openarc/.gitignore");
      }
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
      const res = await run(ports, { ...request(root, project, cmd.ids.filter((a) => !a.startsWith("--"))), keepGoing });
      res.diagnostics.forEach((d) => console.error(fmt(d)));
      const stale = res.diagnostics.filter((d) => d.code === "OARC-W043").map((d) => d.id);
      if (stale.length) console.error(`stale: ${stale.join(", ")} keep${stale.length === 1 ? "s" : ""} a body that does not satisfy the current spec`);
      if (res.diagnostics.some((d) => d.code === "OARC-E080" && d.detail === "stopped:3-consecutive"))
        console.error("stopped early: the model backend failed 3 times in a row, so the remaining regions were skipped. Is it running (Ollama OOM-killed?)");
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
