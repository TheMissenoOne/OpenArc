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
import { DEFAULT_CONFIG, hostOf } from "./config.ts";
import { clearStaleLock, releaseOwnLock } from "./lock.ts";
import { createWatcher, regionKey, type RegionKey } from "./watcher.ts";
import { watchDirs } from "./dirwatch.ts";

const MESSAGES: Record<string, string> = {
  "OARC-W001": "'@openarc:' text that is not a valid marker",
  "OARC-E010": "spec is not statically evaluable",
  "OARC-E011": "duplicate region id",
  "OARC-E012": "marker id has no spec",
  "OARC-W013": "block spec has no markers: place // @openarc:begin/end around the statements by hand",
  "OARC-E020": "implementation not assignable to spec type F",
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
  "OARC-W044": "thin examples: fewer than 3, or none with an edge case (empty, zero, negative, null); passing them proves little (openarc check <id> --oracle)",
  "OARC-E041": "refine: \"next\" is unsupported in v0",
  "OARC-E050": "unknown manifest schema",
  "OARC-E051": "invalid openarc.config.json",
  "OARC-W060": "manual edit detected; region is developer-managed and will not be regenerated (openarc release <id> to hand it back)",
  "OARC-E061": "spec changed on a developer-managed region (openarc resolve <id> --keep|--regen)",
  "OARC-E062": "region markers removed (openarc resolve <id> --unlink)",
  "OARC-E063": "region moved to a different parent",
  "OARC-E080": "model backend unavailable",
  "OARC-E082": "repair attempts exhausted",
  "OARC-E090": "example failed",
  "OARC-E091": "sandbox timeout or resource limit",
  "OARC-E092": "sandbox unavailable",
  "OARC-W094": "recovered an interrupted transaction",
  "OARC-E095": "another openarc process holds .openarc/lock",
  "OARC-E096": "the file changed on disk during the compile; nothing was written (run again)",
  "OARC-E097": "write-scope violation: generated code may only change its own region (specs, tests and other code are compiler-protected)",
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
        await rm(p(rel), { recursive: true, force: true });
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

function request(root: string, project: engine.Project | null, ids: string[]): CompileRequest {
  const cfg = project?.config ?? DEFAULT_CONFIG;
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
    },
  };
}

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

const USAGE = `usage: openarc init | scaffold | compile [--keep-going] [ids...] | watch [--debounce <ms>] | graph | inspect <id>
       openarc freeze|release <id> | resolve <id> --keep|--regen|--unlink
       openarc extract <file> [--function <name>] [--id <id>]
       openarc check <id> --oracle <module>#<export>`;

/** `openarc check <id> --oracle <module>#<export>`: differential test against a reference implementation (engine.oracleCheck). */
async function check(root: string, ports: Ports, args: string[]): Promise<number> {
  const [id, flag, oracle] = args;
  if (!id || flag !== "--oracle" || !oracle || args.length !== 3) {
    console.error(`openarc: bad-flag\n\n${USAGE}`);
    return 2;
  }
  const diagnostics: Diagnostic[] = [];
  const project = await analyzeOffline(ports, root, diagnostics);
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

async function main(argv: string[]): Promise<number> {
  const root = findRoot(process.cwd());
  const ports = realPorts(root);
  // ponytail: `check` is parsed here, not in the cli.parseArgv region, so the self-hosted tree keeps its generated body.
  // Move it into cli.parseArgv's spec at the next self-compile.
  if (argv[0] === "check") return check(root, ports, argv.slice(1));
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
      await put("openarc.config.json", JSON.stringify(DEFAULT_CONFIG, null, 2) + "\n");
      await put("tsconfig.json", JSON.stringify(TSCONFIG, null, 2) + "\n");
      await put(manifestPath, '{\n  "schema": 1,\n  "regions": {}\n}\n');
      await put(".openarc/harness.mjs", 'import { main } from "open-arc/harness";\nawait main("/work", process.argv[2]);\n');
      const ignore = ["lock", "sandbox/", "txn/", "watch-history.jsonl", "attempts/"];
      const had = await ports.fs.read(".openarc/.gitignore");
      const missing = ignore.filter((l) => !(had ?? "").split("\n").includes(l));
      if (missing.length) {
        await ports.fs.write(".openarc/.gitignore", (had ?? "") + (had && !had.endsWith("\n") ? "\n" : "") + missing.join("\n") + "\n");
        wrote.push(".openarc/.gitignore");
      }
      console.log(wrote.length ? `created: ${wrote.join(", ")}` : "already initialised");
      console.log("next: write defineRegion specs in src/*.ts, then `npx openarc scaffold` (adds the exported symbols other files import),\nthen `npx tsc -p .`, then `npx openarc compile`");
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
        res = await engine.extract(ports, request(root, project, []), project, rel, { fn: cmd.fn, id: cmd.id });
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
        console.log(`extracted (developer-owned): ${res.extracted.join(", ")}\nreview the [inferred] intents, add examples, then \`openarc release <id>\` to hand a region to the compiler`);
      } else if (!res.refused.length) console.log("nothing to extract");
      return res.refused.length ? 1 : 0;
    }
    case "watch": {
      // spec §15. One worker: analysis never overlaps a compile, so at most one model is resident.
      let config = DEFAULT_CONFIG;
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
      // src/ and tests/fakes/ one directory at a time (dirwatch.ts: a recursive fs.watch goes blind to a file replaced by
      // rename, which is how commits write), plus the root, non-recursively, for the config. Not the whole tree: that
      // would watch node_modules. ponytail: a src/ created after start needs a restart.
      const dirs = ["src", "tests/fakes"].filter((d) => existsSync(`${root}/${d}`));
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
            console.log(`${"  ".repeat(depth)}${r.id.padEnd(34 - depth * 2)} ${r.kind === "function" ? "F" : "B"} ${engine.displayState(project, r).padEnd(10)} ${r.spec.examples.length} ex  ${r.file}`);
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
      console.log(JSON.stringify({ id: r.id, kind: r.kind, file: r.file, parent: r.parent, state, ownership: r.state, ...note, intent: r.spec.intent, examples: r.spec.examples.length, manifest: project.manifest.regions[r.id] ?? null }, null, 2));
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
