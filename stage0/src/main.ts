#!/usr/bin/env node
// `openarc` CLI entry point. Hand-written: the real ports plus command dispatch.
import { mkdir, open, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import type { CompileRequest, Diagnostic, Ports } from "./types.ts";
import { parseArgv } from "./cli.ts";
import { run } from "./compile.ts";
import * as engine from "./engine.ts";
import { DEFAULT_CONFIG, hostOf } from "./config.ts";

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
          await (await open(p(rel), "wx")).close();
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

async function main(argv: string[]): Promise<number> {
  const root = findRoot(process.cwd());
  const ports = realPorts(root);
  const cmd = parseArgv(argv);
  const diagnostics: Diagnostic[] = [];
  const print = () => diagnostics.forEach((d) => console.error(fmt(d)));
  const manifestPath = ".openarc/manifest.json";
  const loadManifest = async () => JSON.parse((await ports.fs.read(manifestPath)) ?? '{"schema":1,"regions":{}}') as engine.Manifest;
  const saveManifest = (m: engine.Manifest) => ports.fs.write(manifestPath, JSON.stringify(m, null, 2) + "\n");

  switch (cmd.cmd) {
    case "usage":
      console.error(`openarc: ${cmd.reason}\n\nusage: openarc init | scaffold | compile [--keep-going] [ids...] | graph | inspect <id>\n       openarc freeze|release <id> | resolve <id> --keep|--regen|--unlink`);
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
      await put(".openarc/harness.mjs", 'import { main } from "openarc/harness";\nawait main("/work", process.argv[2]);\n');
      await put(".openarc/.gitignore", "lock\nsandbox/\ntxn/\n");
      console.log(wrote.length ? `created: ${wrote.join(", ")}` : "already initialised");
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
      const pre: Diagnostic[] = [];
      const project = await engine.parse(ports, request(root, null, []), pre);
      const t0 = Date.now();
      const keepGoing = cmd.ids.includes("--keep-going");
      const res = await run(ports, { ...request(root, project, cmd.ids.filter((a) => !a.startsWith("--"))), keepGoing });
      res.diagnostics.forEach((d) => console.error(fmt(d)));
      console.error(`done: exit ${res.exit} · ${res.modelCalls} model call(s) · ${((Date.now() - t0) / 1000).toFixed(1)}s`);
      return res.exit;
    }
    case "graph":
    case "inspect": {
      const project = await analyzeOffline(ports, root, diagnostics);
      print();
      if (cmd.cmd === "graph") {
        const show = (parent: string | null, depth: number) => {
          for (const r of project.regions.filter((x) => x.parent === parent)) {
            console.log(`${"  ".repeat(depth)}${r.id.padEnd(34 - depth * 2)} ${r.kind === "function" ? "F" : "B"} ${r.state.padEnd(10)} ${r.spec.examples.length} ex  ${r.file}`);
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
      console.log(JSON.stringify({ id: r.id, kind: r.kind, file: r.file, parent: r.parent, state: r.state, intent: r.spec.intent, examples: r.spec.examples.length, manifest: project.manifest.regions[r.id] ?? null }, null, 2));
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
