// Watch and sibling context (issue #15). In-memory ports, no model.
// Run: node tests/watch-context.check.ts
// 1. watch queues .tsx edits like .ts ones (UI specs and components are .tsx).
// 2. Analyses in one process reuse parse work (marker scans memoised by text, the previous TypeScript program), and
//    still see every edit.
// 3. A pending sibling (failed, or not compiled yet) is shown by signature with its intent and a pending note, so a
//    caller can be written against it; the fingerprint hashes every sibling's intent but not the note, so a sibling's
//    intent change re-fingerprints the caller and its commit doesn't.
import assert from "node:assert/strict";
import type { CompileRequest, Ports } from "../src/types.ts";
import fakePorts from "./fakes/ports.memory.ts";
import { memoryFs } from "./fakes/fs.memory.ts";
import * as engine from "../src/engine.ts";
import { scanMarkers } from "../src/implicit.ts";
import { classifyPath } from "../src/watch.ts";
import { parseConfig } from "../src/config.ts";
import { createWatcher } from "../src/watcher.ts";

const root = process.cwd(); // the stage0 checkout, so "open-arc" and "typescript" resolve for the type checker
const req: CompileRequest = { root, ids: [], model: { host: "http://h", model: "m", seed: 1, numCtx: 8192 }, sandbox: { nodeBin: "/n/bin/node", nodePrefix: "/n", heapMb: 256, addressSpaceBytes: 2 ** 32, cpuSeconds: 10 } };
const TAGS = JSON.stringify({ models: [{ name: "qwen3.5:9b", digest: "d1" }] });

// ── 1. .tsx edits are queued
{
  assert.equal(classifyPath("src/ui/LoginPage.spec.tsx"), "source");
  assert.equal(classifyPath("src/node_modules/x.tsx"), "ignore");
  let analyses = 0;
  const w = createWatcher({
    fs: memoryFs({ files: {} }).fs,
    print: () => {},
    debounceMs: 2,
    backendProblem: async () => null,
    analyze: async () => (analyses++, { targets: [], keys: {}, examples: {} }),
    compile: async () => ({ exit: 0, diagnostics: [], modelCalls: 0 }),
  });
  await w.start();
  await w.idle();
  const before = analyses;
  w.onChange("src/ui/LoginPage.tsx");
  await new Promise((r) => setTimeout(r, 10));
  await w.idle();
  assert.equal(analyses, before + 1, "a .tsx edit triggers an analysis");
  await w.stop();
}

// ── 2 + 3. one file, a caller and its callee
const src = (verse: string, verseIntent = "the verse for n bottles") => [
  'import * as arc from "open-arc";',
  "type Verse = (n: number) => string;",
  "type Verses = (from: number, to: number) => string;",
  `export const verseSpec = arc.defineRegion<Verse>({ id: "song.verse", intent: "${verseIntent}" });`,
  'export const versesSpec = arc.defineRegion<Verses>({ id: "song.verses", intent: "verses from..to, joined by a blank line" });',
  "// @openarc:begin song.verse",
  verse,
  "// @openarc:end song.verse",
  "// @openarc:begin song.verses",
  'export const verses: Verses = (from, to) => arc.todo("song.verses");',
  "// @openarc:end song.verses",
  "",
].join("\n");
const PENDING = 'export const verse: Verse = (n) => arc.todo("song.verse");';
const DONE = "export const verse: Verse = (n) => {\n  return `${n} bottles`;\n};";
const caller = async (text: string) => {
  const ports = fakePorts({ files: { "src/song.ts": text }, http: [TAGS] }).instance as Ports;
  const p = await engine.parse(ports, req, []);
  await engine.analyze(ports, req, p, []);
  return p.regions.find((r) => r.id === "song.verses")!;
};

{
  const t = src(PENDING);
  assert.equal(scanMarkers(t), scanMarkers(t), "one scan per text");
  const pending = await caller(t);
  assert.match(pending.context0, /\nconst verse: Verse \/\/ pending: no body yet [^\n]*; intent: the verse for n bottles\n/, "the pending callee: signature, note, intent");
  const done = await caller(src(DONE));
  assert.match(done.context0, /\nconst verse: Verse\n/, "an implemented callee: signature only");
  assert.equal(done.fingerprint, pending.fingerprint, "the callee's commit leaves the caller's fingerprint alone");
  const edited = await caller(src(PENDING, "the verse for n bottles, plural"));
  assert.match(edited.context0, /intent: the verse for n bottles, plural\n/, "the next analysis sees the edit");
  assert.notEqual(edited.fingerprint, pending.fingerprint, "the callee's intent is part of the caller's fingerprint");
}
// ── 4. compilation.context options (experimental): pendingSiblings and previousBody change the prompt, never the fingerprint
const withCfg = async (text: string, context: object) => {
  const cfg = { version: 1, backends: { local: { provider: "ollama", model: "qwen3.5:9b", maxContextTokens: 8192 } }, compilation: { defaultBackend: "local", context } };
  const ports = fakePorts({ files: { "src/song.ts": text, "openarc.config.json": JSON.stringify(cfg) }, http: [TAGS] }).instance as Ports;
  const p = await engine.parse(ports, req, []);
  await engine.analyze(ports, req, p, []);
  return p;
};
{
  const at = async (mode: string) => (await withCfg(src(PENDING), { pendingSiblings: mode })).regions.find((r) => r.id === "song.verses")!;
  const [full, intent, sig] = [await at("full"), await at("intent"), await at("signature")];
  assert.match(full.context0, /\nconst verse: Verse \/\/ pending: no body yet [^\n]*; intent: the verse for n bottles\n/);
  assert.match(intent.context0, /\nconst verse: Verse \/\/ intent: the verse for n bottles\n/, "intent: no pending note");
  assert.match(sig.context0, /\nconst verse: Verse\n/, "signature: the line alone");
  assert.equal(new Set([full.fingerprint, intent.fingerprint, sig.fingerprint]).size, 1, "the mode is not in the fingerprint");

  // previousBody: a compiler-owned body whose spec changed is shown; an unchanged spec or the option off shows nothing
  const p = await withCfg(src(DONE), { previousBody: true });
  const r = p.regions.find((x) => x.id === "song.verse")!;
  const heading = "Previous body (it passed the previous version";
  r.state = "compiler";
  p.manifest.regions[r.id] = { ...p.manifest.regions[r.id], specHash: r.specHash } as never;
  assert.ok(!engine.buildContext(p, r, 0, p.config.backends.local!).includes(heading), "spec unchanged: no previous body");
  p.manifest.regions[r.id] = { ...p.manifest.regions[r.id], specHash: "sha256:old" } as never;
  const shown = engine.buildContext(p, r, 0, p.config.backends.local!);
  assert.ok(shown.includes(heading) && shown.includes("return `${n} bottles`;"), "spec changed: the old body is shown");
  assert.ok(!engine.buildContext(p, r, 0, p.config.backends.local!, { stable: true }).includes(heading), "never in the stable view");
  const off = await withCfg(src(DONE), {});
  const r2 = off.regions.find((x) => x.id === "song.verse")!;
  r2.state = "compiler";
  off.manifest.regions[r2.id] = { specHash: "sha256:old" } as never;
  assert.ok(!engine.buildContext(off, r2, 0, off.config.backends.local!).includes(heading), "off by default");
}
const cfgOf = (context: object) => parseConfig(JSON.stringify({ version: 1, backends: { l: { provider: "ollama", model: "m", maxContextTokens: 8192 } }, compilation: { context } }));
assert.match(cfgOf({ pendingSiblings: "some" }).error ?? "", /pendingSiblings must be one of full, intent, signature/);
assert.match(cfgOf({ previousBody: "yes" }).error ?? "", /previousBody must be true or false/);
assert.deepStrictEqual([cfgOf({}).config.compilation.context.pendingSiblings, cfgOf({}).config.compilation.context.previousBody], ["full", false]);
console.log("watch-context: .tsx queued, reused analyses see edits, pending siblings by contract, context options ok");
