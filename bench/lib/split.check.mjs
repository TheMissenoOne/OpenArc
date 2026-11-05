// The split rule and public throw tests, no model and no dataset. Run: node --no-warnings bench/lib/split.check.mjs
// (the last part runs a test file in the bwrap sandbox, as every bench run does)
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exampleLine, exampleTest, exDir, prepareTestDir, runTests, splitTests } from "./common.mjs";
import { specSource } from "./adapter.mjs";
import { baselinePrompt, publicTest } from "./baseline.mjs";
import { expect } from "./jest-shim.mjs";

// the recorder keeps what toThrow says, as the example's `throws`
const recorded = (fn) => {
  const r = (globalThis.__record = { calls: [], unusable: false, encode: (v) => v });
  fn(() => r.calls.push({ fn: "f", args: [1] }));
  delete globalThis.__record;
  return r;
};
const thrown = (want) => recorded((call) => expect(() => call()).toThrow(want)).calls[0].throws;
assert.equal(thrown("Invalid codon"), "Invalid codon");
assert.equal(thrown(new Error("Invalid codon")), "Invalid codon");
for (const want of [undefined, "", /Invalid/, RangeError]) assert.equal(thrown(want), true, String(want));
assert.equal(recorded((call) => expect(() => call()).not.toThrow()).unusable, true, ".not stays unusable");

// the split: value tests as before, throw tests by the same rule on their own
const value = (name, fn = "f") => ({ name, unusable: false, calls: [{ fn, args: [name], expected: name }] });
const raises = (name, msg = true, fn = "f") => ({ name, unusable: false, calls: [{ fn, args: [name], throws: msg }] });
const lines = [
  raises("t1", "bad"), value("v1"), value("v2"), raises("t2"), value("v3"), raises("t3"),
  value("v4"), value("v5"), value("v6"), value("v7"), value("v8"), raises("t4"), raises("t5"), raises("t6"), raises("t7"), raises("t8"),
  raises("lone", "x", "g"), value("g1", "g"),
  { name: "two calls", unusable: false, calls: [{ fn: "f", args: [1], throws: true }, { fn: "f", args: [2], throws: true }] },
  { ...raises("unencodable"), unusable: true },
];
const s = splitTests("ex", ["f", "g"], lines);
assert.deepEqual(s.examples.f.filter((e) => "expected" in e).map((e) => e.name), ["v1", "v2", "v3"], "at most 3 value examples, file order");
assert.deepEqual(s.examples.f.filter((e) => "throws" in e), [{ name: "t1", args: ["t1"], throws: "bad" }, { name: "t2", args: ["t2"], throws: true }, { name: "t3", args: ["t3"], throws: true }]);
assert.deepEqual(s.examples.g, [], "floor(1/2) of each kind: a lone test stays hidden");
assert.deepEqual(s.tests.filter((t) => t.public).map((t) => t.name), ["t1", "v1", "v2", "t2", "v3", "t3"]);
assert.ok(s.heldOut.includes("two calls") && s.heldOut.includes("unencodable") && s.heldOut.includes("t4"));
assert.deepEqual(s.tests.filter((t) => !t.eligible).map((t) => t.name), ["two calls", "unencodable"]);

// both arms see the same examples
const ex = "binary-search";
const examples = { find: [{ name: "hit", args: [[1, 2], 2], expected: 1 }, { name: "miss", args: [[1, 2], 7], throws: "Value not in array" }, { name: "any", args: [[], 1], throws: true }] };
const splitInfo = { examples };
assert.equal(exampleLine("find", examples.find[0]), "- find([1,2], 2) returns 1");
assert.equal(exampleLine("find", examples.find[1]), '- find([1,2], 7) throws an error whose message contains "Value not in array"');
assert.equal(exampleLine("find", examples.find[2]), "- find([], 1) throws");
assert.match(exampleTest("find", examples.find[2]), /toThrow\(\)/);

const dir = mkdtempSync(join(tmpdir(), "openarc-split-"));
try {
  mkdirSync(join(exDir(dir, ex), ".docs"), { recursive: true });
  writeFileSync(join(exDir(dir, ex), ".docs/instructions.md"), "Find a value.");
  assert.match(baselinePrompt(dir, ex, splitInfo), /- find\(\[1,2\], 7\) throws an error whose message contains "Value not in array"/);
  const spec = specSource(dir, ex, splitInfo);
  assert.match(spec, /"throws": "Value not in array"/, "the OpenArc spec form");
  assert.match(spec, /"throws": true/);

  // the plain arm's public test file really checks them
  const work = join(dir, "work");
  mkdirSync(work);
  await prepareTestDir(work);
  writeFileSync(join(work, "public.test.ts"), publicTest(ex, splitInfo));
  const outcome = async (src) => {
    writeFileSync(join(work, `${ex}.ts`), src);
    const r = await runTests(join(work, "public.test.ts"));
    return r.lines.map((l) => l.ok);
  };
  assert.deepEqual(await outcome('export const find = (a: number[], v: number) => { const i = a.indexOf(v); if (i < 0) throw new Error("Value not in array"); return i; };'), [true, true, true]);
  assert.deepEqual(await outcome("export const find = (a: number[], v: number) => a.indexOf(v);"), [true, false, false], "no throw");
  assert.deepEqual(await outcome('export const find = (a: number[], v: number) => { const i = a.indexOf(v); if (i < 0) throw new Error("nope"); return i; };'), [true, false, true], "the wrong message");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log("split.check: ok");
