// Exercise -> fresh OpenArc project, compile it, run the held-out tests against the compiled file.
import { mkdir, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { BENCH, EXERCISES, instructions, heldOut, run, proxyBase, exDir } from "./common.mjs";

const camel = (s) => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());

// Comments of the original Exercism stub file (line and block comments), for the A-same-info arm.
export const stubComments = (dataset, ex) =>
  [...readFileSync(join(exDir(dataset, ex), `${ex}.ts`), "utf8").matchAll(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g)].map((m) => m[0].trim());

/**
 * The spec file. Types are written out by hand in exercises.json. Intent, per arm (matrix config):
 * - default: the instructions split into paragraphs, as an array (OpenArc joins the array with single spaces, so line
 *   breaks inside a paragraph are lost);
 * - `intent: "full"` (A-same-info): ONE string, the instructions verbatim as the baseline sees them (line breaks kept),
 *   plus the original stub file's comments;
 * - `gold: true` (B-oracle): the default intent plus bench/gold/<ex>.md as one more string (line breaks kept);
 * - `sketch: true` (C-sketch): the default intent plus `sketch:` from bench/sketches/<ex>.<fn>.ts.
 */
export function specSource(dataset, ex, splitInfo, cfg = {}) {
  const e = EXERCISES.functions[ex];
  const text = instructions(dataset, ex);
  const intro = text.split(/\n\s*\n/).map((p) => p.replace(/\s*\n\s*/g, " ").trim()).filter(Boolean);
  let s = `import * as arc from "open-arc";\n\n${e.types ? e.types + "\n\n" : ""}`;
  for (const [f, t] of Object.entries(e.fns)) {
    const T = f[0].toUpperCase() + f.slice(1) + "Fn";
    const head = `Exercise "${ex}": implement \`${f}\`.`;
    let intent = [head, ...intro];
    if (cfg.intent === "full") {
      const comments = stubComments(dataset, ex);
      intent = `${head}\n\n${instructions(dataset, ex, { cap: false })}${comments.length ? `\n\nComments in the stub file:\n${comments.join("\n")}` : ""}`;
    }
    if (cfg.gold) intent.push(readFileSync(join(BENCH, "gold", `${ex}.md`), "utf8").trim());
    let spec = JSON.stringify({ id: `${camel(ex)}.${f}`, intent, examples: splitInfo.examples[f] }, null, 2);
    if (cfg.sketch && existsSync(sketchFile(ex, f))) spec = spec.replace(/\n\}$/, `,\n  sketch: ${readFileSync(sketchFile(ex, f), "utf8").trim().replace(/\n/g, "\n  ")}\n}`);
    s += `export type ${T} = ${t};\n\n`;
    s += `export const ${f}Spec = arc.defineRegion<${T}>(${spec});\n\n`;
  }
  return s;
}
export const sketchFile = (ex, f) => join(BENCH, "sketches", `${ex}.${f}.ts`);

/**
 * The OpenArc backend block for one run: provider/model/context from matrix.json, `backend.openarc` merged verbatim,
 * `seed` from --seed. With `resample` (E-resample) there is one backend per round: round 1 is the default (temperature
 * 0, the run's seed), rounds 2 and 3 use RESAMPLE_TEMPERATURE and seed + round - 1; regions are pointed at a round's
 * backend through `regions.<id>.backend`, and each round allows a single attempt.
 */
export const RESAMPLE_TEMPERATURE = 0.7;
export function configFor({ model, level, port, backend, seed = 1, resample = false }) {
  const local = { provider: backend.provider, model, maxContextTokens: backend.maxContextTokens, outputReserveTokens: backend.outputReserveTokens };
  if (backend.provider === "ollama") Object.assign(local, { host: proxyBase(backend, port), think: false, keepAlive: "2m" });
  else Object.assign(local, { baseUrl: proxyBase(backend, port) },
    backend.apiKeyEnv ? { apiKeyEnv: backend.apiKeyEnv } : {},
    // OpenArc spots Ollama's /v1 by port 11434, which the proxy hides: say it explicitly
    backend.info?.engine === "ollama" ? { ollamaCompat: true } : {});
  Object.assign(local, backend.openarc, { seed });
  const backends = { local };
  if (resample) for (const k of [2, 3]) backends[`round${k}`] = { ...local, seed: seed + k - 1, temperature: RESAMPLE_TEMPERATURE };
  return {
    version: 1,
    backends,
    compilation: { defaultBackend: "local", maxAttempts: resample ? 1 : 3, context: { initialLevel: level, expandOnFailure: false } },
  };
}

/** Classify one failed attempt by its problems: compile (type/syntax/unparseable output), constraint (OpenArc static
 *  rules: imports, forbidden names, effects, calls, sketch containment), or public (an example failed or timed out). */
export function failKind(problems) {
  const codes = problems.map((p) => String(p).match(/OARC-E\d+/)?.[0] ?? (/^output was not valid/.test(p) ? "OARC-E081" : "other"));
  if (codes.some((c) => ["OARC-E070", "OARC-E097", "OARC-E081"].includes(c))) return "compile";
  if (codes.some((c) => !["OARC-E090", "OARC-E091", "other"].includes(c))) return "constraint";
  return "public";
}

/** Returns the per-task record (minus tokens/RSS, which the runner adds). */
export async function runOpenArc({ dataset, ex, splitInfo, model, cfg, dir, oaModules, port, backend, seed = 1 }) {
  const level = cfg.level ?? 0;
  await rm(dir, { recursive: true, force: true });
  await mkdir(join(dir, "src"), { recursive: true });
  await writeFile(join(dir, "package.json"), JSON.stringify({ name: `bench-${ex}`, private: true, type: "module" }));
  // ponytail: hard-linked copy, not a symlink: the OpenArc sandbox mounts only the project at /work, so a symlinked
  // node_modules dangles inside it (see README, "OpenArc findings").
  await run(["cp", "-al", oaModules, join(dir, "node_modules")]);
  const bin = join(oaModules, ".bin/openarc");
  const env = { ...process.env, ...cfg.env };
  const log = [];
  const step = async (args, timeoutMs) => {
    const r = await run([bin, ...args], { cwd: dir, timeoutMs, env });
    log.push({ cmd: args.join(" "), code: r.code, ms: r.ms, timedOut: r.timedOut, out: (r.stdout + r.stderr).slice(-6000) });
    return r;
  };
  await step(["init"], 60_000);
  const config = configFor({ model, level, port, backend, seed, resample: cfg.resample });
  const writeConfig = () => writeFile(join(dir, "openarc.config.json"), JSON.stringify(config, null, 2));
  await writeConfig();
  const file = join(dir, "src", `${ex}.ts`);
  await writeFile(file, specSource(dataset, ex, splitInfo, cfg));
  await step(["scaffold"], 120_000);
  const ids = Object.keys(EXERCISES.functions[ex].fns).map((f) => `${camel(ex)}.${f}`);
  const readManifest = async () => existsSync(join(dir, ".openarc/manifest.json")) ? JSON.parse(await readFile(join(dir, ".openarc/manifest.json"), "utf8")) : { regions: {} };
  const verified = (m, id) => m.regions[id]?.ownership === "compiler" && m.regions[id]?.provenance?.source === "generated";
  let comp, out = "";
  // Repair (default): one compile, up to 3 attempts per region, each retry carries the diagnostics.
  // Resample (E-resample): up to 3 compiles of one attempt each, no feedback; a region still unverified after a round
  // moves to the next round's backend (new seed, temperature RESAMPLE_TEMPERATURE). Verified regions keep theirs.
  for (let round = 1; round <= (cfg.resample ? 3 : 1); round++) {
    if (round > 1) {
      const m = await readManifest();
      const todo = ids.filter((id) => !verified(m, id));
      if (!todo.length) break;
      config.regions = { ...config.regions, ...Object.fromEntries(todo.map((id) => [id, { backend: `round${round}` }])) };
      await writeConfig();
    }
    comp = await step(["compile", "--keep-going", ...(cfg.timings ? ["--timings"] : [])], 45 * 60_000);
    out += comp.stdout + comp.stderr;
  }

  const manifest = await readManifest();
  const regions = [];
  for (const id of ids) {
    const esc = id.replace(/\./g, "\\.");
    const attemptLines = [...out.matchAll(new RegExp(`${esc}: attempt (\\d+) via [^,]*, context L(\\d) (\\d+) chars`, "g"))];
    const m = manifest.regions[id];
    let failedAttempts = [];
    const ad = join(dir, ".openarc/attempts", id);
    if (existsSync(ad)) for (const n of (await readdir(ad)).sort((a, b) => parseInt(a) - parseInt(b))) {
      try {
        const a = JSON.parse(await readFile(join(ad, n), "utf8"));
        const problems = (a.problems ?? []).map((p) => String(p).slice(0, 240)).slice(0, 4);
        failedAttempts.push({ kind: failKind(a.problems ?? []), problems, level: a.contextLevel, backend: a.backend, sampling: a.sampling ?? undefined });
      } catch {}
    }
    regions.push({
      id,
      ok: verified(manifest, id),
      attempts: attemptLines.length,
      contextChars: attemptLines.map((x) => +x[3]),
      levels: attemptLines.map((x) => +x[2]),
      verifiedBy: m?.provenance?.verifiedBy,
      failedAttempts,
    });
  }
  const src = await readFile(file, "utf8");
  const held = await heldOut(dataset, ex, join(dir, "heldout"), src, splitInfo, { "open-arc": join(oaModules, "open-arc") });
  const fails = regions.flatMap((r) => r.failedAttempts);
  return {
    publicPass: regions.every((r) => r.ok),
    attempts: regions.reduce((a, r) => a + r.attempts, 0),
    maxAttemptsPerUnit: Math.max(...regions.map((r) => r.attempts)),
    failCounts: { compile: fails.filter((f) => f.kind === "compile").length, public: fails.filter((f) => f.kind === "public").length, constraint: fails.filter((f) => f.kind === "constraint").length },
    regions,
    heldOut: held,
    compileExit: comp.code,
    compileTimedOut: comp.timedOut || undefined,
    finalSource: src.slice(0, 20000),
    // --timings: one {id, stages} per attempt, plus the commit time(s)
    ...(cfg.timings ? { timings: [...out.matchAll(/^  (\S+): timings (.*)$/gm)].map((m) => ({ id: m[1], stages: Object.fromEntries(m[2].split(" · ").map((kv) => { const [k, v] = kv.split(" "); return [k, +v]; })) })), commitMs: [...out.matchAll(/^timings commit (\d+)$/gm)].map((m) => +m[1]) } : {}),
    log: log.map((l) => ({ ...l, out: l.cmd.startsWith("compile") ? l.out : l.out.slice(-800) })),
  };
}
