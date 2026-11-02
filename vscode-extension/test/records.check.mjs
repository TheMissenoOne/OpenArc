// Plain-Node check of src/records.ts (via out/records.js). Run: npm test.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const { lastPerRegion, parseGraph, parseLint, codeOf, safeArg } = createRequire(import.meta.url)("../out/records.js");

// watch history: last record per region wins; a torn line (crash mid-write) is skipped
const h = lastPerRegion([
  '{"at":"t1","id":"a","state":"running","ms":0,"detail":""}',
  '{"at":"t2","id":"a","state":"failed","ms":900,"detail":"OARC-E098 engine.parse"}',
  '{"at":"t3","id":"b","state":"running","ms":0,"detail":""}',
  '{"at":"t4","id":"c","sta',
  "",
].join("\n"));
assert.deepEqual([...h].map(([id, e]) => [id, e.state, e.detail]), [["a", "failed", "OARC-E098 engine.parse"], ["b", "running", ""]]);

// `openarc graph`: indented blocks, display state
const g = parseGraph([
  "cli.parseArgv                      F stale      22 ex  src/cli.ts",
  "  compile.run.lock                 B pending    0 ex  src/compile.ts",
  "warning OARC-W001 src/engine.ts:1173  '@openarc:' text that is not a valid marker",
].join("\n"));
assert.deepEqual([...g], [["cli.parseArgv", "stale"], ["compile.run.lock", "pending"]]);

// `openarc lint --format json`, and an older CLI without lint
assert.deepEqual(parseLint('[{"rule":"spec/thin-examples","severity":"warn","id":"t.n","file":"src/t.ts","line":5,"message":"m"}]').map((f) => f.rule), ["spec/thin-examples"]);
assert.deepEqual(parseLint("openarc: unknown-command"), []);

assert.equal(codeOf("OARC-W045 unreached:x"), "OARC-W045");
assert.equal(codeOf("failed"), undefined);
assert.ok(safeArg("src/a.ts") && safeArg("../ref/x.ts#add") && !safeArg("a b.ts") && !safeArg("x;rm") && !safeArg('a"b'));

console.log("records.check: ok");
