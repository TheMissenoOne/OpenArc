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
  assert.match(pending.context0, /\nconst verse: Verse\n/, "the pending callee: signature only (a note and intent cost tokens, no correctness)");
  const done = await caller(src(DONE));
  assert.match(done.context0, /\nconst verse: Verse\n/, "an implemented callee: signature only");
  assert.equal(done.fingerprint, pending.fingerprint, "the callee's commit leaves the caller's fingerprint alone");
  const edited = await caller(src(PENDING, "the verse for n bottles, plural"));
  assert.notEqual(edited.fingerprint, pending.fingerprint, "the callee's intent is part of the caller's fingerprint");
}
console.log("watch-context: .tsx queued, reused analyses see edits, pending siblings by signature ok");
