// Plain-Node check of src/parse.ts (via out/parse.js). Run: npm test. Lines below are 1-based.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const { parse, positionAt } = createRequire(import.meta.url)("../out/parse.js");
const SRC = new URL("../../selfhost/src/", import.meta.url);
const load = (f) => parse(readFileSync(new URL(f, SRC), "utf8"), f);
const pairs = (p) => p.regions.map((r) => [r.id, r.begin.line + 1, r.end.line + 1, r.parent, r.placeholder]);
const specs = (p) => p.specs.map((s) => [s.id, s.kind, s.line + 1, s.examples]);

const compile = load("compile.ts");
assert.deepEqual(pairs(compile), [
  ["compile.run", 78, 150, null, false],
  ["compile.run.lock", 90, 95, "compile.run", false],
  ["compile.run.recover", 99, 101, "compile.run", true],
  ["compile.run.parse", 103, 108, "compile.run", false],
  ["compile.run.analyze", 111, 113, "compile.run", false],
  ["compile.run.plan", 116, 118, "compile.run", false],
  ["compile.run.generate", 123, 127, "compile.run", false],
  ["compile.run.stage", 135, 137, "compile.run", false],
  ["compile.run.commit", 140, 142, "compile.run", false],
  ["compile.run.unlock", 145, 147, "compile.run", false],
]);
assert.deepEqual(specs(compile), [
  ["compile.run", "function", 17, 2],
  ...["lock", "recover", "parse", "analyze", "plan", "generate", "stage", "commit", "unlock"]
    .map((s, i) => [`compile.run.${s}`, "block", 42 + 4 * i, 0]),
]);
assert.deepEqual(compile.problems, []);

const ids = load("ids.ts");
assert.deepEqual(pairs(ids), [["ids.isValidId", 24, 26, null, true], ["ids.findDuplicateIds", 51, 64, null, false]]);
assert.deepEqual(specs(ids), [["ids.isValidId", "function", 8, 9], ["ids.findDuplicateIds", "function", 32, 3]]);
assert.deepEqual(ids.problems, []);

// markers.ts: its examples hold marker text inside strings, which must be ignored.
const markers = load("markers.ts");
assert.deepEqual(pairs(markers).map((p) => p.slice(0, 3)), [["markers.scanMarkers", 51, 53], ["markers.buildRegionTree", 103, 105]]);
assert.deepEqual(markers.problems, []);

// id offsets point at the id text, for go-to-definition.
const text = readFileSync(new URL("ids.ts", SRC), "utf8");
for (const x of [...ids.specs, ...ids.markers]) assert.equal(text.slice(x.idStart, x.idEnd), x.id);

// Pairing rules (mirrors markers.buildRegionTree examples) and W001.
const codes = (src) => parse(src).problems.map((p) => [p.code, p.line + 1]);
assert.deepEqual(codes("// @openarc:begin a\n// @openarc:begin b\n// @openarc:end a\n// @openarc:end b\n"), [["OARC-E031", 3]]);
assert.deepEqual(codes("// @openarc:begin a\n"), [["OARC-E030", 1]]);
assert.deepEqual(codes("x;\n\n\n// @openarc:end a\n"), [["OARC-E030", 4]]);
assert.deepEqual(codes("const s = 1; // @openarc:begin x\n"), [["OARC-W001", 1]]);
assert.deepEqual(codes("/* @openarc:begin x */\n"), [["OARC-W001", 1]]);
assert.deepEqual(codes("// @openarc:begin Bad.Id\n"), [["OARC-W001", 1]]);
assert.deepEqual(codes("const s = `${1}// @openarc:begin x`; const r = /\\/\\/ @openarc:begin x/;\n"), []);
assert.deepEqual(pairs(parse("function f() {\n  // @openarc:begin a\n  x();\n  // @openarc:end a\n}\n")), [["a", 2, 4, null, false]]);

const run = compile.specs[0];
assert.deepEqual(positionAt(compile.lineStarts, run.idStart), { line: 16, character: 7 });

console.log("markers.check: ok");
