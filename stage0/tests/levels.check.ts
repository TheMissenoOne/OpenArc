// The architecture and concept files round trip, then `openarc arch` and `openarc concept` end to end on a plain
// JavaScript project: derive, hand edits that survive, new files placed, every violation and warning, --json.
// Run: node --no-warnings tests/levels.check.ts
import assert from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { importsOf, parseArch, parseConcept, printArch, printConcept, type Arch, type Concept } from "../src/levels.ts";

// ── pure: print and parse are inverses, errors name the line
{
  const a: Arch = {
    name: "game", intent: ['A "survival" game.'],
    externals: [{ name: "three", intent: ["3D rendering"] }, { name: "@scope/pkg", intent: [] }, { name: "node:fs", intent: [] }],
    parts: [{ name: "sim", intent: ["Deterministic simulation."], modules: ["src/survival.js", "src/worldos/**"], uses: ["dsl", "three"] }, { name: "dsl", intent: [], modules: ["src/dsl.js"], uses: [] }],
  };
  const text = printArch(a);
  assert.deepStrictEqual(parseArch(text), a);
  assert.strictEqual(printArch(parseArch(text)), text);
  assert.strictEqual(printArch({ name: "x", intent: [], externals: [], parts: [] }), "architecture x\n");
  assert.throws(() => parseArch("part sim\n"), /^Error: line 1: a file starts with `architecture <name>`/);
  assert.throws(() => parseArch(text.replace("  uses dsl\n", "  calls dsl\n")), /^Error: line 13: expected an intent string, module or uses/);
  assert.throws(() => parseArch(text.replace("external three\n", "extern three\n")), /^Error: line 4: expected external or part/);
  assert.throws(() => parseArch(text.replace('  "3D rendering"', "  module x")), /^Error: line 5: only intent strings belong under external/);
  assert.throws(() => parseArch(text + "\npart sim\n"), /^Error: line 19: duplicate part sim/);

  const c: Concept = {
    name: "game", intent: ["What the project is."],
    goals: [{ name: "voice", intent: ["The player talks to the daemon by voice."], parts: ["daemon", "audio"] }],
    nongoals: [["Multiplayer."], ["Mods.", "Not in v1."]],
    terms: [{ name: "Daemon", intent: ["The AI companion."] }, { name: "World OS", intent: [] }],
  };
  const ct = printConcept(c);
  assert.deepStrictEqual(parseConcept(ct), c);
  assert.strictEqual(printConcept(parseConcept(ct)), ct);
  assert.throws(() => parseConcept("goal x\n"), /^Error: line 1: a file starts with `concept <name>`/);
  assert.throws(() => parseConcept(ct.replace("  part audio\n", "  uses audio\n")), /^Error: line 7: expected an intent string or part/);
  assert.throws(() => parseConcept(ct.replace("nongoal\n", "nongoals\n")), /^Error: line 9: expected goal, nongoal or term/);
  assert.throws(() => parseConcept('  "x"\nconcept a\n'), /^Error: line 1: an indented line needs a heading/);

  // imports: relative specifiers resolve to files in the set, packages are named by their root
  const edges = importsOf(new Map([
    ["src/a.js", 'import x from "./b"; import "./c/index.js"; import y from "three/addons/z.js"; import "@s/p/deep"; import fs from "fs/promises"; import "node:path"; import d from "./data.json"; const m = await import("./c");'],
    ["src/b.ts", 'export * from "./a.js";'], ["src/c/index.js", ""],
  ]));
  assert.deepStrictEqual(edges.map((e) => `${e.from} ${e.to} ${e.external}`), ["src/a.js src/b.ts false", "src/a.js src/c/index.js false", "src/a.js three true", "src/a.js @s/p true", "src/a.js node:fs true", "src/a.js node:path true", "src/b.ts src/a.js false"]);
}

if (process.platform === "win32") {
  console.log("levels.check ok (pure checks only on Windows)");
  process.exit(0);
}
const MAIN = resolve("src/main.ts");
const dir = mkdtempSync(join(resolve(".."), ".levels-check-"));
const oa = (...args: string[]) => {
  const r = spawnSync(process.execPath, ["--no-warnings", MAIN, ...args], { cwd: dir, encoding: "utf8" });
  return { code: r.status, out: r.stdout + r.stderr };
};
const write = (f: string, t: string) => (mkdirSync(dirname(join(dir, f)), { recursive: true }), writeFileSync(join(dir, f), t));
const read = (f: string) => readFileSync(join(dir, f), "utf8");
const lines = (out: string) => out.trim().split("\n");
try {
  write("package.json", '{"name":"levels","version":"1.0.0","type":"module","private":true}');
  write("src/main.js", 'import { readFileSync } from "node:fs";\nimport * as THREE from "three";\nimport { step } from "./sim/world.js";\nexport const run = () => step(1);\n');
  write("src/sim/world.js", 'import { rule } from "./rules.js";\nimport { parse } from "../dsl/parse.js";\nexport const step = (n) => rule(parse(String(n)));\n');
  write("src/sim/rules.js", "export const rule = (x) => x;\n");
  write("src/dsl/parse.js", 'import { Parser } from "acorn/dist/acorn.js";\nexport const parse = (s) => s;\n');
  write("src/sim/world.test.js", 'import { step } from "./world.js";\nimport test from "node:test";\n'); // a test belongs to no part

  // first run: one part per directory, uses and externals from the imports, sorted
  let r = oa("arch");
  assert.strictEqual(r.code, 0, r.out);
  assert.strictEqual(r.out, "arc/architecture.arc: 3 parts, 4 modules, 3 externals\n");
  assert.strictEqual(read("arc/architecture.arc"), `architecture levels

external acorn
external node:fs
external three

part src
  module src/main.js
  uses node:fs
  uses src.sim
  uses three

part src.dsl
  module src/dsl/parse.js
  uses acorn

part src.sim
  module src/sim/rules.js
  module src/sim/world.js
  uses src.dsl
`);
  r = oa("arch", "--check");
  assert.deepStrictEqual([r.code, r.out], [0, "ok: 0 violations, 0 warnings\n"]);

  // hand edits survive: intents, a glob for membership, a note on an external, a uses no import needs
  const edited = read("arc/architecture.arc")
    .replace("architecture levels\n", 'architecture levels\n  "A tiny game."\n')
    .replace("external three\n", 'external three\n  "3D rendering"\n')
    .replace("  module src/sim/rules.js\n  module src/sim/world.js\n", '  "Deterministic simulation."\n  module src/sim/**\n')
    .replace("  uses three\n", "  uses three\n  uses src.dsl\n");
  write("arc/architecture.arc", edited);
  r = oa("arch");
  assert.deepStrictEqual([r.code, r.out], [0, "arc/architecture.arc: 3 parts, 4 modules, 3 externals\n"]);
  assert.strictEqual(read("arc/architecture.arc"), edited);
  r = oa("arch", "--check");
  assert.deepStrictEqual([r.code, lines(r.out)], [0, ["warning: part src uses src.dsl, but no import needs it", "ok: 0 violations, 1 warnings"]]);

  // new files: under a glob nothing changes; next to a sibling it joins that part; a new directory is a new part with derived uses
  write("src/sim/physics.js", "export const g = 9.8;\n");
  write("src/dsl/lex.js", "export const lex = (s) => s.split(' ');\n");
  write("src/ui/hud.js", 'import * as THREE from "three";\nimport { step } from "../sim/world.js";\nimport { Pane } from "tweakpane";\n');
  r = oa("arch");
  assert.deepStrictEqual(lines(r.out), [
    "added module src/dsl/lex.js to part src.dsl", "added part src.ui", "added module src/ui/hud.js to part src.ui",
    "added uses three to part src.ui", "added uses src.sim to part src.ui", "added uses tweakpane to part src.ui", "added external tweakpane",
    "arc/architecture.arc: 4 parts, 7 modules, 4 externals",
  ]);
  const grown = read("arc/architecture.arc");
  assert.ok(grown.startsWith(edited.split("\npart src\n")[0]!.trimEnd()), grown); // the person's lines, unchanged
  assert.ok(grown.includes("  module src/dsl/parse.js\n  module src/dsl/lex.js\n  uses acorn\n"), grown);
  assert.ok(grown.endsWith("part src.ui\n  module src/ui/hud.js\n  uses src.sim\n  uses three\n  uses tweakpane\n"), grown);
  assert.ok(grown.includes('external tweakpane\n'), grown);
  assert.strictEqual(oa("arch", "--check").code, 0);

  // every violation kind, each naming its files
  write("arc/architecture.arc", grown
    .replace("  module src/dsl/lex.js\n", "") // no part
    .replace("  module src/main.js\n", "  module src/main.js\n  module src/sim/rules.js\n  module src/gone.js\n") // two parts; matches nothing
    .replace("  uses src.dsl\n", "") // first occurrence: part src's unused one
    .replace("part src.sim\n  \"Deterministic simulation.\"\n  module src/sim/**\n  uses src.dsl\n", "part src.sim\n  \"Deterministic simulation.\"\n  module src/sim/**\n") // A imports B without uses
    .replace("  uses node:fs\n", "") // external not used
    .replace("external acorn\n", "") // external with no line
    .replace("  uses acorn\n", "  uses acorn\n  uses nothing\n")); // unknown name
  r = oa("arch", "--check");
  assert.strictEqual(r.code, 1, r.out);
  assert.deepStrictEqual(lines(r.out), [
    "violation: src/dsl/lex.js belongs to no part",
    "violation: src/sim/rules.js belongs to more than one part: src, src.sim",
    "violation: part src: module src/gone.js matches no file",
    "violation: part src.dsl uses acorn, which is neither a part nor an external",
    "violation: part src.dsl uses nothing, which is neither a part nor an external",
    "violation: src/dsl/parse.js imports acorn, which has no external line",
    "violation: src/main.js imports node:fs, but part src does not use node:fs",
    "violation: src/sim/world.js imports src/dsl/parse.js (part src.dsl), but part src.sim does not use src.dsl",
    "failed: 8 violations, 0 warnings",
  ]);
  const j = JSON.parse(oa("arch", "--check", "--json").out) as { ok: boolean; violations: string[]; warnings: string[] };
  assert.deepStrictEqual([j.ok, j.violations.length, j.warnings], [false, 8, []]);

  // a cycle between parts is a warning, listed once
  write("arc/architecture.arc", grown.replace("  uses acorn\n", "  uses acorn\n  uses src.sim\n"));
  r = oa("arch", "--check");
  assert.strictEqual(r.code, 0, r.out);
  assert.ok(r.out.includes("warning: part src.dsl uses src.sim, but no import needs it\n"), r.out);
  assert.strictEqual(r.out.split("warning: parts src.dsl, src.sim use each other in a cycle\n").length, 2, r.out);
  write("arc/architecture.arc", "architecture x\n  module y\n");
  r = oa("arch");
  assert.deepStrictEqual([r.code, r.out], [1, "arc/architecture.arc: line 2: only intent strings belong under architecture\n"]);
  assert.strictEqual(oa("arch", "../x").code, 2);
  assert.strictEqual(oa("arch", "--bogus").code, 2);
  write("arc/architecture.arc", grown);

  // concept: a minimal file, the parts listed for whoever writes the goals
  r = oa("concept");
  assert.strictEqual(r.code, 0, r.out);
  assert.strictEqual(read("arc/concept.arc"), "concept levels\n");
  assert.deepStrictEqual(lines(r.out), ["arc/concept.arc: 0 goals, 0 nongoals, 0 terms", "parts goals can trace to: src, src.dsl, src.sim, src.ui"]);
  r = oa("concept", "--check");
  assert.deepStrictEqual([r.code, lines(r.out)], [0, ["warning: part src: no goal names it", "warning: part src.dsl: no goal names it", "warning: part src.sim: no goal names it", "warning: part src.ui: no goal names it", "warning: the concept has no intent", "ok: 0 violations, 5 warnings"]]);
  // an existing file is reprinted in canonical form
  write("arc/concept.arc", 'concept levels\n  "A tiny game."\ngoal play\n  part src.sim\n  "Simulate a world."\n\n\nnongoal\n  "Multiplayer."\ngoal look\n  part src.ui\n  part src\n  part src.dsl\nterm Tick\n  "One step."\n');
  r = oa("concept");
  assert.strictEqual(r.code, 0, r.out);
  assert.strictEqual(read("arc/concept.arc"), 'concept levels\n  "A tiny game."\n\ngoal play\n  "Simulate a world."\n  part src.sim\n\ngoal look\n  part src.ui\n  part src\n  part src.dsl\n\nnongoal\n  "Multiplayer."\n\nterm Tick\n  "One step."\n');
  assert.deepStrictEqual(JSON.parse(oa("concept", "--check", "--json").out), { ok: true, violations: [], warnings: [] });
  write("arc/concept.arc", read("arc/concept.arc").replace("  part src.sim\n", "").replace("  part src.dsl\n", "  part src.dsl\n  part audio\n"));
  r = oa("concept", "--check");
  assert.deepStrictEqual([r.code, lines(r.out)], [1, ["violation: goal play names no part", "violation: goal look names part audio, which arc/architecture.arc does not have", "warning: part src.sim: no goal names it", "failed: 2 violations, 1 warnings"]]);
  assert.strictEqual(oa("concept", "x").code, 2);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log("levels.check ok");
