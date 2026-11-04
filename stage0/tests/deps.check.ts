// `openarc deps suggest <id>` (src/deps.ts, issue #50) with a fake registry, a fake model reply and a fake process runner:
// no network, no model, no npm. Run: node tests/deps.check.ts
// 1. Query: the model's keywords, NONE declines, a failure falls back to the intent's words.
// 2. Fact filter: license, downloads, recency, typosquat, types, install scripts, deprecated, dependency count.
// 3. The spec edit: defineRegion (with and without deps) and code-first JSDoc.
// 4. Trial: install pinned with --ignore-scripts in scratch copies only; the proposal needs a measured gain and an import.
import assert from "node:assert/strict";
import type { HttpPort } from "../src/types.ts";
import * as d from "../src/deps.ts";

const now = new Date("2026-11-03T00:00:00Z");
const hit = (name: string, x: Partial<d.Hit> = {}): d.Hit => ({ name, version: "1.0.0", description: "", license: "MIT", date: "2026-01-01T00:00:00Z", weekly: 50_000, ...x });

// ── 1. query
assert.equal(d.queryFromIntent("Compare two Semantic Versioning version strings by precedence"), "compare two semantic versioning version");
assert.equal(d.parsePhrase("semver compare versions\n(extra)"), "semver compare versions");
assert.equal(d.parsePhrase("NONE"), "");
assert.equal(d.parsePhrase("`None.` the stdlib does it"), "");
assert.equal(d.parsePhrase("  "), null);

// ── 2. facts
assert.equal(d.levenshtein("lodash", "lodahs"), 2);
assert.equal(d.typosquatOf("lodahs", d.POPULAR), "lodash");
assert.equal(d.typosquatOf("expres", d.POPULAR), "express");
assert.equal(d.typosquatOf("semver", d.POPULAR), null, "the real name is not a squat of itself");
assert.equal(d.typosquatOf("@evil/semver", d.POPULAR), null, "same bare name: scope is not an edit");
assert.equal(d.typosquatOf("csv-parse", ["csv-parser"]), "csv-parser", "one edit away");
assert.equal(d.hitReject(hit("ok-lib"), d.POPULAR, now), null);
assert.match(d.hitReject(hit("@types/semver"), d.POPULAR, now)!, /types-only/);
assert.match(d.hitReject(hit("gpl-lib", { license: "GPL-3.0" }), d.POPULAR, now)!, /license GPL-3\.0/);
assert.match(d.hitReject(hit("nolicense", { license: null }), d.POPULAR, now)!, /license missing/);
assert.match(d.hitReject(hit("tiny", { weekly: 12 }), d.POPULAR, now)!, /12 weekly downloads/);
assert.match(d.hitReject(hit("old", { date: "2014-01-01T00:00:00Z" }), d.POPULAR, now)!, /last publish 2014-01-01/);
assert.equal(d.hitReject(hit("old-but-everywhere", { date: "2014-01-01T00:00:00Z", weekly: 20_000_000 }), d.POPULAR, now), null, "finished and widely used");
assert.match(d.hitReject(hit("semvr"), d.POPULAR, now)!, /close to "semver"/);
const f = (x: Partial<d.Facts> = {}): d.Facts => ({ ...hit("x"), types: "bundled", deps: 0, installScripts: [], deprecated: null, ...x });
assert.equal(d.factsReject(f()), null);
assert.match(d.factsReject(f({ deprecated: "use y" }))!, /deprecated: use y/);
assert.match(d.factsReject(f({ installScripts: ["postinstall"] }))!, /install scripts: postinstall/);
assert.match(d.factsReject(f({ types: null }))!, /no TypeScript types/);
assert.match(d.factsReject(f({ deps: 9 }))!, /9 dependencies/);
assert.match(d.factsReject(f({ weekly: 40 }))!, /40 weekly downloads/, "the count backfilled from the downloads endpoint");
assert.equal(d.typesName("@scope/pkg"), "@types/scope__pkg");

// ── 3. spec edits
const view = (x: Partial<d.RegionView> = {}): d.RegionView => ({ id: "semver.compare", file: "src/v.ts", specFile: "src/v.ts", intent: "Compare two semver versions", signature: "(a: string, b: string) => -1 | 0 | 1", deps: [], codeFirst: false, ownership: "pending", ...x });
assert.equal(d.editSpecDeps('arc.defineRegion<F>({\n  id: "semver.compare",\n  intent: "x",\n});', view(), "semver"), 'arc.defineRegion<F>({\n  id: "semver.compare", deps: ["semver"],\n  intent: "x",\n});');
assert.equal(d.editSpecDeps('arc.defineRegion<F>({ intent: "x", id: "semver.compare" });', view(), "semver"), 'arc.defineRegion<F>({ intent: "x", id: "semver.compare", deps: ["semver"] });');
assert.equal(d.editSpecDeps('arc.defineRegion<F>({ id: "semver.compare", deps: ["./a.ts"], intent: "x" });', view({ deps: ["./a.ts"] }), "semver"), 'arc.defineRegion<F>({ id: "semver.compare", deps: ["semver", "./a.ts"], intent: "x" });');
assert.equal(d.editSpecDeps('arc.defineRegion<F>({ id: "semver.compare", deps: [], intent: "x" });', view(), "semver"), 'arc.defineRegion<F>({ id: "semver.compare", deps: ["semver"], intent: "x" });', "an empty deps array is filled, not duplicated");
assert.equal(d.editSpecDeps('arc.defineRegion<F>({ id: "semver.compare" });\narc.defineRegion<G>({ id: "next", deps: [] });', view(), "semver"), 'arc.defineRegion<F>({ id: "semver.compare", deps: ["semver"] });\narc.defineRegion<G>({ id: "next", deps: [] });', "another spec's deps are not this one's");
assert.equal(d.editSpecDeps('arc.defineRegion<F>({ id: "other" });', view(), "semver"), null, "no such spec");
const cf = "/**\n * Compare.\n * @arc id semver.compare\n */\nexport function compare(a: string, b: string): number {";
assert.equal(d.editSpecDeps(cf, view({ codeFirst: true }), "semver"), "/**\n * Compare.\n * @arc id semver.compare\n * @arc deps semver\n */\nexport function compare(a: string, b: string): number {");
assert.equal(d.editSpecDeps(cf.replace(" */", " * @arc deps ./a.ts\n */"), view({ codeFirst: true, deps: ["./a.ts"] }), "semver"), cf.replace(" */", " * @arc deps ./a.ts semver\n */"));
assert.equal(d.editSpecDeps(cf.replace(" * @arc id semver.compare\n", ""), view({ codeFirst: true }), "semver"), null, "code-first without @arc id: by hand");
assert.equal(d.editSpecDeps(cf, view({ codeFirst: true, deps: ["./a.ts"] }), "semver"), null, "deps from arc.configure: a JSDoc @arc deps too is OARC-E013");
assert.equal(d.specChangeText(view({ deps: ["./a.ts"] }), "semver"), 'deps: ["./a.ts", "semver"]');
assert.equal(d.specChangeText(view({ codeFirst: true }), "semver"), "@arc deps semver");

// ── 4. suggest, end to end on fakes
const arm = (x: Partial<d.Arm> = {}): d.Arm => ({ verified: true, attempts: 1, tokens: 1000, modelCalls: 1, mutants: { killed: 5, scored: 5 }, usesPkg: true, ms: 1, ...x });
assert.equal(d.verdict(arm({ verified: false }), arm()), null, "the baseline failed");
assert.equal(d.verdict(arm({ attempts: 3 }), arm()), null, "fewer attempts");
assert.equal(d.verdict(arm({ mutants: { killed: 3, scored: 5 } }), arm()), null, "higher mutant score");
assert.equal(d.verdict(arm({ tokens: 2000 }), arm()), null, "<= 80% of the tokens");
assert.match(d.verdict(arm(), arm())!, /no measured gain/);
assert.match(d.verdict(arm({ mutants: null }), arm())!, /no measured gain/, "an unmeasured baseline mutant score is not 0");
const B = (body: string, imports: string) => `${imports}\nexport function f() {\n// @openarc:begin semver.compare\n${body}\n// @openarc:end semver.compare\n}\nconst other = 1;\n`;
assert.equal(d.bodyUsesPkg(B("return c(a, b);", 'import { compare as c } from "semver";'), "semver.compare", "semver"), true);
assert.equal(d.bodyUsesPkg(B("return 0;", 'import type { SemVer } from "semver";'), "semver.compare", "semver"), false, "type-only import");
assert.equal(d.bodyUsesPkg(B("let v: SemVer; return 0;", 'import { type SemVer } from "semver";'), "semver.compare", "semver"), false, "inline type specifier");
assert.equal(d.bodyUsesPkg(B("return 0;", 'import semver from "semver";'), "semver.compare", "semver"), false, "imported, but the body does not use it");
assert.equal(d.bodyUsesPkg(B("return semver.compare(a, b);", 'import semver from "semver";'), "semver.compare", "semver"), true);
assert.equal(d.bodyUsesPkg(B("return S.compare(a, b);", 'import * as S from "semver/functions";'), "semver.compare", "semver"), true);
assert.match(d.verdict(arm(), arm({ usesPkg: false }))!, /does not import/);
assert.match(d.verdict(arm({ verified: false }), arm({ verified: false }))!, /not verified/);

const SPEC = 'import * as arc from "open-arc";\nexport const s = arc.defineRegion<F>({ id: "semver.compare", intent: "Compare two semver versions" });\n';
const search = (...hs: d.Hit[]) => JSON.stringify({ objects: hs.map((h) => ({ package: { name: h.name, version: h.version, license: h.license, date: h.date, description: "" }, downloads: { weekly: h.weekly } })) });
function world(registry: Record<string, string>, arms: Record<string, { code: number; out: string; attempts?: number; tokens?: number; body?: string; mutants?: string }>) {
  const files = new Map<string, string>([["/proj/src/v.ts", SPEC], ["/proj/package.json", "{}"]]);
  const urls: string[] = [], runs: { argv: string[]; cwd: string }[] = [], writes: string[] = [], logs: string[] = [];
  let n = 0;
  const http: HttpPort = {
    async postJson() { throw new Error("no POST expected"); },
    async get(url) {
      urls.push(url);
      if (!(url in registry)) throw new Error("HTTP 404: not found");
      return registry[url]!;
    },
  };
  // a scratch dir's arm: "without" for the first copy, else the package installed in it
  const installed = new Map<string, string>();
  const io: d.SuggestIO = {
    http,
    async run(argv, cwd) {
      runs.push({ argv, cwd });
      if (argv[0] === "npm") {
        installed.set(cwd, argv.find((x) => x.includes("@") && !x.startsWith("@types") && !x.startsWith("--"))!.split("@")[0]!);
        return { code: 0, out: "added 1 package" };
      }
      const a = arms[installed.get(cwd) ?? "without"]!;
      if (argv.includes("check")) return { code: 0, out: a.mutants ?? "mutants semver.compare: killed 5/5 (100%)" };
      files.set(`${cwd}/.openarc/manifest.json`, JSON.stringify({ regions: { "semver.compare": { ownership: a.code === 0 ? "compiler" : "pending", provenance: { attempts: a.attempts ?? 1, ...(a.tokens ? { tokens: { prompt: a.tokens - 100, completion: 100 } } : {}) } } } }));
      if (a.body) files.set(`${cwd}/src/v.ts`, a.body + files.get(`${cwd}/src/v.ts`));
      return { code: a.code, out: a.out };
    },
    async read(p) { return files.get(p) ?? null; },
    async write(p, t) { writes.push(p); files.set(p, t); },
    async copyProject() {
      const dir = `/scratch${++n}`;
      for (const [k, v] of [...files]) if (k.startsWith("/proj/")) files.set(dir + k.slice(5), v);
      return dir;
    },
    cli: ["node", "openarc"],
    now,
    log: (l) => logs.push(l),
  };
  return { io, files, urls, runs, writes, logs };
}
const R = d.REGISTRY;
const q = (s: string) => `${R}/-/v1/search?text=${encodeURIComponent(s)}&size=20`;

{ // a: the model's query; a typosquat, a GPL package and a deprecated one are rejected; semver (types from @types) helps
  const w = world({
    [q("semver compare")]: search(hit("semvr"), hit("gpl-semver", { license: "GPL-3.0" }), hit("old-semver"), hit("semver", { version: "7.7.3", weekly: 400_000_000 })),
    [`${R}/old-semver/1.0.0`]: JSON.stringify({ deprecated: "use semver" }),
    [`${R}/semver/7.7.3`]: JSON.stringify({ license: "ISC", scripts: { test: "tap" } }),
    [`${R}/@types%2fsemver/latest`]: '{"version":"7.7.1"}',
  }, {
    without: { code: 1, out: "error OARC-E082 semver.compare\ndone: exit 1 · 3 model call(s) · 9.0s", attempts: 3 },
    semver: { code: 0, out: "done: exit 0 · 1 model call(s) · 2.0s", attempts: 1, tokens: 900, body: 'import { compare as c } from "semver";\n// @openarc:begin semver.compare\nreturn c(a, b);\n// @openarc:end semver.compare\n', mutants: "mutants semver.compare: killed 4/4 (100%)" },
  });
  const phrased: string[] = [];
  const rep = await d.suggest(w.io, view(), { max: 2, trial: true, phrase: async (r) => (phrased.push(r.intent), "semver compare") });
  assert.deepEqual(phrased, ["Compare two semver versions"]);
  assert.equal(rep.query, "semver compare");
  assert.equal(rep.querySource, "model");
  assert.deepEqual(rep.candidates.map((c) => [c.name, c.rejected ?? c.verdict]), [
    ["semvr", 'name close to "semver" (typosquat signal)'],
    ["gpl-semver", "license GPL-3.0 not in the allowlist"],
    ["old-semver", "deprecated: use semver"],
    ["semver", "better"],
  ]);
  assert.equal(rep.without?.verified, false);
  assert.equal(rep.without?.modelCalls, 3);
  assert.deepEqual(rep.candidates[3]!.trial?.with, { verified: true, attempts: 1, tokens: 900, modelCalls: 1, mutants: { killed: 4, scored: 4 }, usesPkg: true, ms: rep.candidates[3]!.trial!.with.ms });
  assert.deepEqual(rep.proposal, {
    name: "semver", version: "7.7.3", types: "@types", specChange: 'deps: ["semver"]',
    packageJson: { dependencies: { semver: "7.7.3" }, devDependencies: { "@types/semver": "7.7.1" } },
    install: "npm install --save-exact semver@7.7.3 && npm install -D --save-exact @types/semver@7.7.1",
  });
  // propose, never apply: npm ran only in a scratch copy, pinned, without scripts; nothing written under /proj
  const npm = w.runs.filter((r) => r.argv[0] === "npm");
  assert.deepEqual(npm, [{ argv: ["npm", "install", "--ignore-scripts", "--no-audit", "--no-fund", "--save-exact", "semver@7.7.3", "@types/semver@7.7.1"], cwd: "/scratch2" }]);
  assert.ok(w.runs.every((r) => r.cwd.startsWith("/scratch")));
  assert.deepEqual(w.writes, ["/scratch2/src/v.ts"]);
  assert.equal(w.files.get("/proj/src/v.ts"), SPEC);
  assert.match(w.files.get("/scratch2/src/v.ts")!, /id: "semver.compare", deps: \["semver"\]/);
  assert.equal(w.files.get("/scratch1/src/v.ts"), SPEC, "the baseline copy keeps the spec");
  assert.deepEqual(w.runs.filter((r) => r.argv[0] === "node").map((r) => `${r.cwd} ${r.argv.slice(2).join(" ")}`), [
    "/scratch1 compile semver.compare", // the baseline failed: no mutant run
    "/scratch2 compile semver.compare",
    "/scratch2 check semver.compare --mutants",
  ]);
  const lines = d.reportLines(rep);
  assert.equal(lines[0], 'deps suggest semver.compare: query "semver compare" (model)');
  assert.match(lines[1]!, /^ {2}without: NOT verified, attempts 3, tokens \?, mutants -/);
  assert.ok(lines.includes("proposal: semver@7.7.3 (not applied; nothing was installed in this project)"));
  assert.ok(lines.includes('  spec:         deps: ["semver"]'));
}

{ // b: the model says the standard library suffices: no search at all
  const w = world({}, {});
  const rep = await d.suggest(w.io, view(), { max: 2, trial: true, phrase: async () => "" });
  assert.deepEqual([rep.proposal, rep.declined, w.urls.length, w.runs.length], [null, "the model answered NONE: the standard library suffices", 0, 0]);
  assert.equal(d.reportLines(rep).at(-1), "proposal: none (the model answered NONE: the standard library suffices)");
}

{ // c: the model is down: the intent's words; the package verifies but the body never imports it -> declined
  const w = world({
    [q("compare two semver versions")]: search(hit("cmp-ver")),
    [`${R}/cmp-ver/1.0.0`]: JSON.stringify({ types: "index.d.ts", dependencies: { a: "1" } }),
  }, {
    without: { code: 0, out: "done: exit 0 · 1 model call(s)", tokens: 500 },
    "cmp-ver": { code: 0, out: "done: exit 0 · 1 model call(s)", tokens: 400 },
  });
  const rep = await d.suggest(w.io, view(), { max: 2, trial: true, phrase: async () => { throw new Error("E080"); } });
  assert.deepEqual([rep.query, rep.querySource], ["compare two semver versions", "intent"]);
  assert.equal(rep.candidates[0]!.verdict, "verified, but the body does not import the package");
  assert.deepEqual([rep.proposal, rep.declined], [null, "no candidate measurably helped"]);
  assert.equal(w.urls.filter((u) => u.includes("@types")).length, 0, "bundled types: no @types lookup");
}

{ // d: --no-trial lists the filtered candidates and measures nothing; --max stops the manifest fetches
  const w = world({
    [q("semver")]: search(hit("a-lib"), hit("b-lib"), hit("c-lib")),
    [`${R}/a-lib/1.0.0`]: JSON.stringify({ scripts: { postinstall: "node evil.js" } }),
    [`${R}/b-lib/1.0.0`]: JSON.stringify({ typings: "x.d.ts" }),
  }, {});
  const rep = await d.suggest(w.io, view(), { max: 1, trial: false, query: "semver" });
  assert.deepEqual(rep.candidates.map((c) => [c.name, c.rejected ?? "ok"]), [["a-lib", "install scripts: postinstall"], ["b-lib", "ok"]]);
  assert.deepEqual([rep.querySource, rep.declined, w.runs.length], ["flag", "--no-trial: candidates listed, nothing measured", 0]);
}

{ // e: a developer-owned region is not trialled (the compiler would not regenerate it)
  const w = world({ [q("semver")]: search(hit("b-lib")), [`${R}/b-lib/1.0.0`]: JSON.stringify({ types: "x.d.ts" }) }, {});
  const rep = await d.suggest(w.io, view({ ownership: "developer" }), { max: 2, trial: true, query: "semver" });
  assert.match(rep.declined!, /developer-owned/);
  assert.equal(w.runs.length, 0);
}

console.log("deps: ok");
