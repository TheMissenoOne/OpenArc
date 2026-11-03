// `openarc deps suggest <id>` (issue #50): search npm for a package that would help a region, filter candidates on
// registry facts, trial the survivors in scratch copies of the project, and PROPOSE the `deps` and package.json change.
// Hand-written. Nothing here writes to the project: every write goes to a scratch copy made by io.copyProject.
// Network: the registry (search, manifests) and `npm install` only; compile/verify in the scratch copy is sandboxed as usual.
import type { HttpPort } from "./types.ts";

export const REGISTRY = "https://registry.npmjs.org";
const DOWNLOADS = "https://api.npmjs.org/downloads/point/last-week";

// ── fact filter thresholds. ponytail: constants, not config; make them `deps.*` config keys if users need to tune them.
export const LICENSES = ["MIT", "ISC", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "0BSD", "Unlicense", "BlueOak-1.0.0", "CC0-1.0"];
export const MIN_WEEKLY = 10_000;
export const MAX_DEPS = 5; // direct dependencies; ponytail: transitive count needs a resolve, add when an install tells us
export const STALE_YEARS = 5; // last publish older than this AND under STALE_EXEMPT weekly downloads: abandoned
const STALE_EXEMPT = 1_000_000; // finished, widely used libraries (fast-deep-equal: 2020) are not abandoned
const INSTALL_SCRIPTS = ["preinstall", "install", "postinstall"];
/** Names a typosquat would imitate. ponytail: a short static list plus the other search hits; a download-ranked list later. */
export const POPULAR = [
  "lodash", "react", "express", "chalk", "commander", "debug", "axios", "moment", "uuid", "semver", "request", "async",
  "underscore", "yargs", "glob", "minimist", "mkdirp", "rimraf", "colors", "dotenv", "typescript", "webpack", "eslint",
  "prettier", "jest", "mocha", "ws", "bluebird", "classnames", "cross-env", "date-fns", "dayjs", "luxon", "zod", "ajv",
  "nanoid", "slugify", "papaparse", "csv-parse", "fast-deep-equal", "deep-equal", "ms", "qs", "node-fetch", "rxjs", "vue",
  "jquery", "inquirer", "ora", "fs-extra", "body-parser", "cookie", "yaml", "js-yaml", "marked", "validator",
];

export interface Hit { name: string; version: string; description: string; license: string | null; date: string; weekly: number | null }
export interface Facts extends Hit {
  types: "bundled" | "@types" | null;
  deps: number;
  installScripts: string[];
  deprecated: string | null;
}
export interface Arm {
  verified: boolean;
  attempts: number | null;
  tokens: number | null; // prompt + completion of the body's attempts (provenance), null when not reported
  modelCalls: number | null;
  mutants: { killed: number; scored: number } | null;
  usesPkg: boolean;
  ms: number;
  dir?: string; // with --keep
}
export interface Candidate extends Partial<Facts> { name: string; version: string; rejected?: string; trial?: { with: Arm }; verdict?: string }
export interface Proposal { name: string; version: string; types: "bundled" | "@types"; specChange: string; packageJson: { dependencies: Record<string, string>; devDependencies?: Record<string, string> }; install: string }
export interface Report {
  id: string;
  query: string | null;
  querySource: "flag" | "model" | "intent";
  declined?: string; // why nothing was searched or proposed
  candidates: Candidate[];
  without?: Arm;
  proposal: Proposal | null;
}

export interface RegionView { id: string; file: string; intent: string; signature: string; deps: string[]; codeFirst: boolean; ownership: string }
export interface SuggestIO {
  http: HttpPort;
  /** argv run with cwd; out is stdout and stderr together. */
  run(argv: string[], cwd: string): Promise<{ code: number | null; out: string }>;
  read(abs: string): Promise<string | null>;
  write(abs: string, text: string): Promise<void>;
  /** A fresh scratch copy of the project (never the user's tree); returns its absolute path. */
  copyProject(): Promise<string>;
  cli: string[]; // argv prefix that runs this openarc
  now: Date;
  log(line: string): void;
}
export interface SuggestOpts { max: number; trial: boolean; query?: string; keep?: boolean; phrase?: (r: RegionView) => Promise<string | null> }

// ── query
const STOP = new Set("the a an and or of to in on for with from by is are be as at it its this that each every into than then when which who return returns given string strings number numbers array arrays true false null value values function should must".split(" "));
/** Deterministic fallback query: the intent's first five distinct content words. */
export const queryFromIntent = (intent: string): string =>
  [...new Set(intent.toLowerCase().match(/[a-z][a-z0-9]+/g) ?? [])].filter((w) => w.length > 2 && !STOP.has(w)).slice(0, 5).join(" ");

export const PHRASE_SYSTEM = "You choose npm registry search keywords. Answer with one line only.";
export const phrasePrompt = (r: RegionView): string =>
  `A TypeScript function must do this:\n${r.intent}\nSignature: ${r.signature}\n\nIf the JavaScript standard library does this correctly in a few lines, answer exactly NONE.\nOtherwise answer with 2 to 5 npm search keywords for a well-known library that does it, nothing else.`;
/** The model's reply -> a query, "" for NONE, null when unusable (the caller falls back to the intent). */
export function parsePhrase(reply: string): string | null {
  const line = reply.trim().split("\n")[0]!.replace(/["'`*]/g, "").trim();
  if (/^none\b/i.test(line)) return "";
  const q = line.toLowerCase().replace(/[^a-z0-9 .\-]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
  return q.length >= 2 ? q : null;
}

// ── facts
export function levenshtein(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length]!;
}
/** The popular name this one imitates (one or two edits away), or null. */
export function typosquatOf(name: string, popular: string[]): string | null {
  const bare = name.replace(/^@[^/]+\//, "");
  return popular.find((p) => p !== name && p !== bare && levenshtein(bare, p) <= (bare.length >= 6 ? 2 : 1)) ?? null;
}

/** A reason to reject on search-hit facts alone (no extra request), or null. */
export function hitReject(h: Hit, popular: string[], now: Date): string | null {
  if (h.name.startsWith("@types/")) return "types-only package";
  if (!h.license || !LICENSES.includes(h.license)) return `license ${h.license ?? "missing"} not in the allowlist`;
  if (h.weekly !== null && h.weekly < MIN_WEEKLY) return `${h.weekly} weekly downloads < ${MIN_WEEKLY}`;
  const years = (now.getTime() - Date.parse(h.date)) / (365.25 * 864e5);
  if (years > STALE_YEARS && (h.weekly ?? 0) < STALE_EXEMPT) return `last publish ${h.date.slice(0, 10)} (> ${STALE_YEARS} years) and < ${STALE_EXEMPT} weekly downloads`;
  const sq = typosquatOf(h.name, popular);
  if (sq) return `name close to "${sq}" (typosquat signal)`;
  return null;
}
/** A reason to reject on the version manifest, or null. */
export function factsReject(f: Facts): string | null {
  if (f.deprecated) return `deprecated: ${f.deprecated.slice(0, 80)}`;
  if (f.installScripts.length) return `install scripts: ${f.installScripts.join(", ")}`;
  if (!f.types) return "no TypeScript types (bundled or @types)";
  if (f.deps > MAX_DEPS) return `${f.deps} dependencies > ${MAX_DEPS}`;
  return null;
}

const enc = (name: string) => name.replace("/", "%2f");
export const typesName = (name: string) => `@types/${name.startsWith("@") ? name.slice(1).replace("/", "__") : name}`;

export async function search(http: HttpPort, query: string, size = 20): Promise<Hit[]> {
  const j = JSON.parse(await http.get(`${REGISTRY}/-/v1/search?text=${encodeURIComponent(query)}&size=${size}`)) as {
    objects?: { package: { name: string; version: string; description?: string; license?: string; date: string }; downloads?: { weekly?: number } }[];
  };
  return (j.objects ?? []).map((o) => ({ name: o.package.name, version: o.package.version, description: o.package.description ?? "", license: o.package.license ?? null, date: o.package.date, weekly: o.downloads?.weekly ?? null }));
}

export async function facts(http: HttpPort, h: Hit): Promise<Facts> {
  const m = JSON.parse(await http.get(`${REGISTRY}/${enc(h.name)}/${h.version}`)) as {
    types?: string; typings?: string; exports?: unknown; dependencies?: Record<string, string>; scripts?: Record<string, string>; gypfile?: boolean; deprecated?: string; license?: unknown;
  };
  let types: Facts["types"] = m.types || m.typings || JSON.stringify(m.exports ?? "").includes('"types"') ? "bundled" : null;
  if (!types) types = await http.get(`${REGISTRY}/${enc(typesName(h.name))}/latest`).then(() => "@types" as const, () => null);
  let weekly = h.weekly;
  if (weekly === null) weekly = await http.get(`${DOWNLOADS}/${h.name}`).then((t) => (JSON.parse(t) as { downloads?: number }).downloads ?? null, () => null);
  return {
    ...h, weekly, types,
    deps: Object.keys(m.dependencies ?? {}).length,
    installScripts: [...INSTALL_SCRIPTS.filter((s) => m.scripts?.[s]), ...(m.gypfile ? ["gypfile"] : [])],
    deprecated: typeof m.deprecated === "string" ? m.deprecated : null,
  };
}

// ── the spec change
/** The spec text with `pkg` added to region `id`'s deps, or null when the spec can't be edited mechanically. */
export function editSpecDeps(text: string, r: RegionView, pkg: string): string | null {
  const esc = r.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (r.codeFirst) { // JSDoc: `@arc deps a b` (extend it), else a new line after `@arc id <id>`
    const idLine = new RegExp(`^([ \\t]*\\*[ \\t]*)@arc id ${esc}[ \\t]*$`, "m").exec(text);
    if (!idLine) return null;
    const depsLine = /^([ \t]*\*[ \t]*@arc deps)([^\n]*)$/m;
    const block = text.slice(text.lastIndexOf("/**", idLine.index), text.indexOf("*/", idLine.index));
    if (depsLine.test(block)) {
      const start = text.lastIndexOf("/**", idLine.index);
      return text.slice(0, start) + block.replace(depsLine, (_m, head: string, rest: string) => `${head} ${rest.trim() === "none" ? "" : `${rest.trim()} `}${pkg}`.replace(/  +/g, " ")) + text.slice(start + block.length);
    }
    const at = idLine.index + idLine[0].length;
    return `${text.slice(0, at)}\n${idLine[1]}@arc deps ${pkg}${text.slice(at)}`;
  }
  const m = new RegExp(`\\bid:\\s*(["'])${esc}\\1(\\s*,)?`).exec(text);
  if (!m) return null;
  const after = text.slice(m.index);
  const d = /\bdeps:\s*\[/.exec(after);
  // an existing deps array of THIS spec: before the next defineRegion
  if (r.deps.length && d && !after.slice(0, d.index).includes("defineRegion")) {
    const at = m.index + d.index + d[0].length;
    return `${text.slice(0, at)}${JSON.stringify(pkg)}, ${text.slice(at)}`;
  }
  if (r.deps.length) return null;
  const at = m.index + m[0].length;
  return m[2] ? `${text.slice(0, at)} deps: [${JSON.stringify(pkg)}],${text.slice(at)}` : `${text.slice(0, at)}, deps: [${JSON.stringify(pkg)}]${text.slice(at)}`;
}
export const specChangeText = (r: RegionView, pkg: string): string =>
  r.codeFirst ? `@arc deps ${[...r.deps, pkg].join(" ")}` : `deps: [${[...r.deps, pkg].map((d) => JSON.stringify(d)).join(", ")}]`;

// ── trial
const pct = (a: Arm) => (a.mutants && a.mutants.scored ? a.mutants.killed / a.mutants.scored : 0);
/** Does the arm with the package beat the one without? It must verify and actually import the package, and then do better
 *  on something measured: the baseline failed, fewer attempts, a higher mutant score, or at most 80% of the tokens at an
 *  equal or better mutant score. ponytail: a heuristic; bench/deps measures it against held-out tests. */
export function verdict(without: Arm, w: Arm): string | null {
  if (!w.verified) return "not verified with the package";
  if (!w.usesPkg) return "verified, but the body does not import the package";
  if (!without.verified) return null;
  if ((w.attempts ?? Infinity) < (without.attempts ?? Infinity)) return null;
  if (pct(w) > pct(without)) return null;
  if (pct(w) >= pct(without) && w.tokens !== null && without.tokens !== null && w.tokens <= 0.8 * without.tokens) return null;
  return "no measured gain over the body without it";
}

async function armOf(io: SuggestIO, dir: string, r: RegionView, pkg: string | null, keep: boolean): Promise<Arm> {
  const t0 = Date.now();
  const c = await io.run([...io.cli, "compile", r.id], dir);
  const ms = Date.now() - t0;
  const modelCalls = Number(/(\d+) model call/.exec(c.out)?.[1] ?? NaN);
  const manifest = JSON.parse((await io.read(`${dir}/.openarc/manifest.json`)) ?? '{"regions":{}}') as { regions: Record<string, { ownership?: string; provenance?: { attempts?: number; tokens?: { prompt: number; completion: number } } }> };
  const e = manifest.regions[r.id];
  const verified = c.code === 0 && e?.ownership === "compiler" && !/OARC-W04[35]/.test(c.out);
  let mutants: Arm["mutants"] = null;
  if (verified) {
    const m = /killed (\d+)\/(\d+)/.exec((await io.run([...io.cli, "check", r.id, "--mutants"], dir)).out);
    if (m) mutants = { killed: +m[1]!, scored: +m[2]! };
  }
  const file = (await io.read(`${dir}/${r.file}`)) ?? "";
  const tk = e?.provenance?.tokens;
  return {
    verified, attempts: e?.provenance?.attempts ?? null, tokens: tk ? tk.prompt + tk.completion : null,
    modelCalls: Number.isFinite(modelCalls) ? modelCalls : null, mutants,
    usesPkg: pkg !== null && new RegExp(`from\\s+["']${pkg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(/[^"']*)?["']`).test(file),
    ms, ...(keep ? { dir } : {}),
  };
}

export async function suggest(io: SuggestIO, r: RegionView, o: SuggestOpts): Promise<Report> {
  let query: string | null = o.query ?? null;
  let querySource: Report["querySource"] = "flag";
  if (query === null && o.phrase) {
    query = await o.phrase(r).catch(() => null);
    querySource = "model";
  }
  if (query === "") return { id: r.id, query: null, querySource, declined: "the model answered NONE: the standard library suffices", candidates: [], proposal: null };
  if (query === null) [query, querySource] = [queryFromIntent(r.intent), "intent"];
  if (!query) return { id: r.id, query: null, querySource, declined: "no query: the intent has no content words", candidates: [], proposal: null };
  const rep: Report = { id: r.id, query, querySource, candidates: [], proposal: null };
  const hits = await search(io.http, query);
  const passed: Facts[] = [];
  for (const h of hits) {
    if (passed.length >= o.max) break;
    if (r.deps.includes(h.name)) continue;
    // imitated names: the static list, plus hits with 100x this one's downloads
    const bigger = [...POPULAR, ...hits.filter((x) => (x.weekly ?? 0) >= 100 * Math.max(h.weekly ?? 0, 1)).map((x) => x.name)];
    const why = hitReject(h, bigger, io.now);
    if (why) {
      rep.candidates.push({ ...h, rejected: why });
      continue;
    }
    const f = await facts(io.http, h).catch((e: Error) => ({ ...h, error: e.message }));
    const why2 = "error" in f ? `manifest unavailable (${f.error.slice(0, 80)})` : factsReject(f);
    rep.candidates.push({ ...f, ...(why2 ? { rejected: why2 } : {}) } as Candidate);
    if (!why2) passed.push(f as Facts);
  }
  if (!passed.length) return { ...rep, declined: "no candidate passed the fact filter" };
  if (!o.trial) return { ...rep, declined: "--no-trial: candidates listed, nothing measured" };
  if (r.ownership === "developer" || r.ownership === "conflicted") return { ...rep, declined: `region is ${r.ownership}-owned: the compiler would not regenerate it (openarc release ${r.id} first)` };
  io.log(`deps ${r.id}: baseline compile without a new dependency`);
  const base = await io.copyProject();
  rep.without = await armOf(io, base, r, null, !!o.keep);
  let best: { f: Facts; arm: Arm } | null = null;
  for (const f of passed) {
    const c = rep.candidates.find((x) => x.name === f.name)!;
    const dir = await io.copyProject();
    io.log(`deps ${r.id}: trial ${f.name}@${f.version} in ${dir}`);
    const pins = [`${f.name}@${f.version}`, ...(f.types === "@types" ? [typesName(f.name)] : [])];
    const inst = await io.run(["npm", "install", "--ignore-scripts", "--no-audit", "--no-fund", "--save-exact", ...pins], dir);
    if (inst.code !== 0) {
      c.verdict = `install failed: ${inst.out.trim().split("\n").at(-1)?.slice(0, 120)}`;
      continue;
    }
    const text = await io.read(`${dir}/${r.file}`);
    const edited = text === null ? null : editSpecDeps(text, r, f.name);
    if (edited === null) {
      c.verdict = `could not add the dep to the spec mechanically (add ${specChangeText(r, f.name)} by hand to trial it)`;
      continue;
    }
    await io.write(`${dir}/${r.file}`, edited);
    const arm = await armOf(io, dir, r, f.name, !!o.keep);
    c.trial = { with: arm };
    c.verdict = verdict(rep.without, arm) ?? "better";
    if (c.verdict === "better" && (!best || (arm.tokens ?? Infinity) < (best.arm.tokens ?? Infinity))) best = { f, arm };
  }
  if (!best) return { ...rep, declined: "no candidate measurably helped" };
  const { f } = best;
  rep.proposal = {
    name: f.name, version: f.version, types: f.types!, specChange: specChangeText(r, f.name),
    packageJson: { dependencies: { [f.name]: f.version }, ...(f.types === "@types" ? { devDependencies: { [typesName(f.name)]: "latest" } } : {}) },
    install: `npm install --save-exact ${f.name}@${f.version}${f.types === "@types" ? ` && npm install -D ${typesName(f.name)}` : ""}`,
  };
  return rep;
}

const armLine = (a: Arm) =>
  `${a.verified ? "verified" : "NOT verified"}, attempts ${a.attempts ?? "?"}, tokens ${a.tokens ?? "?"}, mutants ${a.mutants ? `${a.mutants.killed}/${a.mutants.scored}` : "-"}, ${(a.ms / 1000).toFixed(1)}s${a.dir ? ` (${a.dir})` : ""}`;
export function reportLines(rep: Report): string[] {
  const out = [`deps suggest ${rep.id}: query ${rep.query === null ? "-" : JSON.stringify(rep.query)} (${rep.querySource})`];
  for (const c of rep.candidates) {
    const facts = c.license !== undefined ? ` [${c.license ?? "no license"}, ${c.weekly ?? "?"}/wk, ${c.date?.slice(0, 10)}${c.types !== undefined ? `, types ${c.types ?? "none"}, ${c.deps} deps` : ""}]` : "";
    out.push(`  ${c.rejected ? "rejected" : "candidate"} ${c.name}@${c.version}${facts}${c.rejected ? `: ${c.rejected}` : ""}`);
    if (c.trial) out.push(`    with:    ${armLine(c.trial.with)}${c.trial.with.usesPkg ? "" : ", does not import it"}`);
    if (c.verdict) out.push(`    verdict: ${c.verdict}`);
  }
  if (rep.without) out.splice(1, 0, `  without: ${armLine(rep.without)}`);
  if (!rep.proposal) {
    out.push(`proposal: none (${rep.declined})`);
    return out;
  }
  const p = rep.proposal;
  out.push(`proposal: ${p.name}@${p.version} (not applied; nothing was installed in this project)`, `  spec:         ${p.specChange}`, `  package.json: ${JSON.stringify(p.packageJson)}`, `  install:      ${p.install}`);
  return out;
}
