// Exercise -> fresh OpenArc project, compile it, run the held-out tests against the compiled file.
import { mkdir, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { EXERCISES, instructions, heldOut, run, proxyBase } from "./common.mjs";

const camel = (s) => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());

/** The spec file. Types are written out by hand in exercises.json; intent is the trimmed instructions. */
export function specSource(dataset, ex, splitInfo) {
  const e = EXERCISES.functions[ex];
  const intro = instructions(dataset, ex).split(/\n\s*\n/).map((p) => p.replace(/\s*\n\s*/g, " ").trim()).filter(Boolean);
  let s = `import * as arc from "open-arc";\n\n${e.types ? e.types + "\n\n" : ""}`;
  for (const [f, t] of Object.entries(e.fns)) {
    const T = f[0].toUpperCase() + f.slice(1) + "Fn";
    s += `export type ${T} = ${t};\n\n`;
    s += `export const ${f}Spec = arc.defineRegion<${T}>(${JSON.stringify({
      id: `${camel(ex)}.${f}`,
      intent: [`Exercise "${ex}": implement \`${f}\`.`, ...intro],
      examples: splitInfo.examples[f],
    }, null, 2)});\n\n`;
  }
  return s;
}

/** The OpenArc backend block for one run: provider/model/context from matrix.json, `backend.openarc` merged verbatim. */
export function configFor({ model, level, port, backend }) {
  const local = { provider: backend.provider, model, maxContextTokens: backend.maxContextTokens, outputReserveTokens: backend.outputReserveTokens };
  if (backend.provider === "ollama") Object.assign(local, { host: proxyBase(backend, port), think: false, keepAlive: "2m" });
  else Object.assign(local, { baseUrl: proxyBase(backend, port) },
    backend.apiKeyEnv ? { apiKeyEnv: backend.apiKeyEnv } : {},
    // OpenArc spots Ollama's /v1 by port 11434, which the proxy hides: say it explicitly
    backend.info?.engine === "ollama" ? { ollamaCompat: true } : {});
  Object.assign(local, backend.openarc);
  return {
    version: 1,
    backends: { local },
    compilation: { defaultBackend: "local", maxAttempts: 3, context: { initialLevel: level, expandOnFailure: false } },
  };
}

/** Returns the per-task record (minus tokens/RSS, which the runner adds). */
export async function runOpenArc({ dataset, ex, splitInfo, model, level, dir, oaModules, port, backend }) {
  await rm(dir, { recursive: true, force: true });
  await mkdir(join(dir, "src"), { recursive: true });
  await writeFile(join(dir, "package.json"), JSON.stringify({ name: `bench-${ex}`, private: true, type: "module" }));
  // ponytail: hard-linked copy, not a symlink: the OpenArc sandbox mounts only the project at /work, so a symlinked
  // node_modules dangles inside it (see README, "OpenArc findings").
  await run(["cp", "-al", oaModules, join(dir, "node_modules")]);
  const bin = join(oaModules, ".bin/openarc");
  const log = [];
  const step = async (args, timeoutMs) => {
    const r = await run([bin, ...args], { cwd: dir, timeoutMs });
    log.push({ cmd: args.join(" "), code: r.code, ms: r.ms, timedOut: r.timedOut, out: (r.stdout + r.stderr).slice(-6000) });
    return r;
  };
  await step(["init"], 60_000);
  await writeFile(join(dir, "openarc.config.json"), JSON.stringify(configFor({ model, level, port, backend }), null, 2));
  const file = join(dir, "src", `${ex}.ts`);
  await writeFile(file, specSource(dataset, ex, splitInfo));
  await step(["scaffold"], 120_000);
  const comp = await step(["compile", "--keep-going"], 45 * 60_000);
  const out = comp.stdout + comp.stderr;

  const manifest = existsSync(join(dir, ".openarc/manifest.json")) ? JSON.parse(await readFile(join(dir, ".openarc/manifest.json"), "utf8")) : { regions: {} };
  const regions = [];
  for (const f of Object.keys(EXERCISES.functions[ex].fns)) {
    const id = `${camel(ex)}.${f}`;
    const esc = id.replace(/\./g, "\\.");
    const attemptLines = [...out.matchAll(new RegExp(`${esc}: attempt (\\d+) via [^,]*, context L(\\d) (\\d+) chars`, "g"))];
    const m = manifest.regions[id];
    let failedAttempts = [];
    const ad = join(dir, ".openarc/attempts", id);
    if (existsSync(ad)) for (const n of (await readdir(ad)).sort()) {
      try { const a = JSON.parse(await readFile(join(ad, n), "utf8")); failedAttempts.push({ problems: (a.problems ?? []).map((p) => String(p).slice(0, 240)).slice(0, 4), level: a.contextLevel, sampling: a.sampling ?? undefined }); } catch {}
    }
    regions.push({
      id,
      ok: m?.ownership === "compiler" && m?.provenance?.source === "generated",
      attempts: attemptLines.length,
      contextChars: attemptLines.map((x) => +x[3]),
      levels: attemptLines.map((x) => +x[2]),
      verifiedBy: m?.provenance?.verifiedBy,
      failedAttempts,
    });
  }
  const src = await readFile(file, "utf8");
  const held = await heldOut(dataset, ex, join(dir, "heldout"), src, splitInfo, { "open-arc": join(oaModules, "open-arc") });
  return {
    publicPass: regions.every((r) => r.ok),
    attempts: regions.reduce((a, r) => a + r.attempts, 0),
    maxAttemptsPerUnit: Math.max(...regions.map((r) => r.attempts)),
    regions,
    heldOut: held,
    compileExit: comp.code,
    compileTimedOut: comp.timedOut || undefined,
    log: log.map((l) => ({ ...l, out: l.cmd.startsWith("compile") ? l.out : l.out.slice(-800) })),
  };
}
