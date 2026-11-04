#!/usr/bin/env node
// MultiPL-E (HumanEval + MBPP, TypeScript) -> a TRAINING task pool in ts-bench's layout, so run.mjs compiles it
// unchanged (dataset adapter, not a second harness). Training only: see train-pool.md.
// node train-pool.mjs --src <fetch-multipl-e.sh dir> --out <pool dir>
// then: BENCH_EXERCISES=<pool>/exercises.json node run.mjs --dataset <pool> --matrix matrix-train.json ...
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

const { values: a } = parseArgs({ options: { src: { type: "string" }, out: { type: "string" } } });
if (!a.src || !a.out) throw new Error("usage: node train-pool.mjs --src <multipl-e dir> --out <pool dir>");

// Decontamination: drop anything whose name or intent touches a bench exercise (exercises.json functions, sets and
// skipped, which include evolve-multi's nine). Generous on purpose: a false drop costs one training task, a miss
// leaks a benchmark answer into the fine-tune.
const DECON = [
  [/roman/, "roman-numerals"], [/prime|sieve/, "prime-factors, sieve"], [/factor/, "prime-factors"],
  [/run.?length|encod|decod|compress/, "run-length-encoding, atbash, variable-length-quantity"],
  [/cipher|encrypt|decrypt|caesar|rot13|rotat|shift/, "atbash-cipher, rotational-cipher, simple-cipher"],
  [/anagram/, "anagram"], [/acronym|abbreviat/, "acronym"], [/search/, "binary-search, word-search"],
  [/binary/, "binary-search, variable-length-quantity, secret-handshake"], [/transpos/, "transpose"],
  [/bracket|paren/, "matching-brackets"], [/\bbase\b|base \d|_base|radix/, "all-your-base"],
  [/pig.?latin/, "pig-latin"], [/palindrom/, "palindrome-products"], [/pascal/, "pascals-triangle"],
  [/triangle|pythagor|triplet/, "triangle, pythagorean-triplet"], [/squares?\b/, "difference-of-squares"],
  [/multiple/, "sum-of-multiples"], [/perfect/, "perfect-numbers"], [/armstrong|narcissist/, "armstrong-numbers"],
  [/flatten|nested/, "flatten-array"], [/matrix|matrices|spiral|saddle|grid/, "spiral-matrix, saddle-points, matrix"],
  [/word.?count|count.{0,20}words|frequen|histogram/, "word-count"], [/series|consecutive|adjacent/, "largest-series-product, series"],
  [/knapsack/, "knapsack"], [/number.{0,20}words|in words|to words|spell/, "say"], [/luhn|isbn|credit card|check digit/, "luhn, isbn-verifier"],
  [/phone/, "phone-number"], [/dna|rna|nucleotide|protein|codon/, "nucleotide-count, protein-translation"],
  [/resistor|colou?r/, "resistor-color-trio"], [/diamond/, "diamond"], [/minesweeper|mine/, "minesweeper"],
  [/clock|gigasecond|date|time/, "clock, gigasecond"], [/sub.?list|sub.?array|sub.?sequence/, "sublist"],
  [/chess|grains|queen/, "grains, queen-attack"], [/bucket/, "two-bucket"], [/tournament/, "tournament"],
  [/garden/, "kindergarten-garden"], [/fraction|rational/, "rational-numbers"], [/complex/, "complex-numbers"],
  [/allerg/, "allergies"], [/handshake/, "secret-handshake"], [/verse|song|lyric|twelve days/, "twelve-days, house, food-chain"],
  [/wordy|evaluat|algebra|expression/, "wordy"], [/rectangle/, "rectangles"], [/relative|family|ancestor/, "relative-distance"],
  [/scrabble|letter score/, "etl"], [/alphametic|cryptarithm/, "alphametics"], [/ocr/, "ocr-numbers"],
  [/divisor|divisib|amicable|aliquot/, "perfect-numbers, prime-factors"], [/power.{0,4}(of.)?(2|two)\b|\bbits?\b|bitwise/, "grains, secret-handshake, variable-length-quantity"],
  [/same.?char|shuffle/, "anagram"], [/'one'|numberal/, "say"],
  [/bowling/, "bowling"], [/bank/, "bank-account"], [/linked list/, "linked-list"], [/circular/, "circular-buffer"],
  [/game of life/, "game-of-life"], [/robot/, "robot-name, robot-simulator"], [/\bset\b/, "custom-set"],
];

const pool = join(a.out, "repos/exercism-typescript/exercises/practice");
for (const d of ["repos", "splits", "record"]) rmSync(join(a.out, d), { recursive: true, force: true }); // only what this script writes
const functions = {}, skipped = {}, decontaminated = {};
for (const file of ["humaneval-ts", "mbpp-ts"]) {
  for (const line of readFileSync(join(a.src, `${file}.jsonl`), "utf8").split("\n").filter(Boolean)) {
    const p = JSON.parse(line);
    const [, set, num, rest] = p.name.match(/^(HumanEval|mbpp)_(\d+)_(.*)$/);
    const ex = `${set === "mbpp" ? "mbpp" : "he"}${num}-${rest.toLowerCase().replace(/_+/g, "-").replace(/^-|-$/g, "")}`;
    const sig = p.prompt.match(/^function (\w+)\((.*)\)\s*:\s*(.+?)\s*\{\s*$/m);
    if (!sig) { skipped[ex] = "no single-line `function f(...): T {` declaration in the prompt"; continue; }
    const [, snake, params, ret] = sig;
    // OpenArc region ids (and so the compiled export) are camelCase: rename the function everywhere, doc comment included
    const fn = snake.replace(/_+([a-zA-Z0-9])/g, (_, c) => c.toUpperCase()).replace(/^[A-Z]/, (c) => c.toLowerCase());
    const intent = p.prompt.slice(0, sig.index).split("\n").filter(Boolean).map((l) => l.replace(/^\/\/ ?/, "")).join("\n")
      .replace(/tsthon/gi, "TypeScript").trim(); // ponytail: MultiPL-E's blind "py" -> "ts" rename
    if (!intent) { skipped[ex] = "no doc comment"; continue; }
    const hit = DECON.find(([re]) => re.test(`${rest.replace(/_/g, " ")}\n${intent}`.toLowerCase()));
    if (hit) { decontaminated[ex] = `matches /${hit[0].source}/ (${hit[1]})`; continue; }
    if (ret === "any") { skipped[ex] = "return type is `any`: no contract, and OpenArc rejects the spec (TS2322 on the expectation)"; continue; }
    const asserts = [...p.tests.matchAll(/^\s*assert\.deepEqual\((candidate\(.*\)),\s*(.*)\);\s*$/gm)];
    if (asserts.length !== p.tests.split("\n").filter((l) => /assert/.test(l) && !/require\('node:assert'\)/.test(l)).length) { skipped[ex] = "an assert is not a one-line `assert.deepEqual(candidate(...), v)`"; continue; }
    // ponytail: each assert becomes one jest test; the harness's recorder then decides JSON-ability and the public/held-out split
    const test = `import { it, expect } from "@jest/globals";\nimport * as m from "./${ex}.ts";\nconst assert = { deepEqual: (a: unknown, e: unknown) => expect(a).toEqual(e) };\n`
      + `const candidate = (...args: any[]) => (m as any).${fn}(...args);\n\n`
      + p.tests.split("\n").filter((l) => /^\s*assert\.deepEqual/.test(l)).map((l, i) => `it("assert ${i + 1}", () => { ${l.trim()} });\n`).join("");
    mkdirSync(join(pool, ex, ".docs"), { recursive: true });
    writeFileSync(join(pool, ex, `${ex}.test.ts`), test);
    writeFileSync(join(pool, ex, ".docs/instructions.md"), intent.replaceAll(snake, fn) + "\n");
    functions[ex] = { fns: { [fn]: `(${params}) => ${ret}` }, source: p.name };
  }
}
const revision = readFileSync(join(a.src, "REVISION"), "utf8").trim();
const write = () => writeFileSync(join(a.out, "exercises.json"), JSON.stringify({ _note: `TRAINING ONLY. MultiPL-E (nuprl/MultiPL-E @ ${revision}) humaneval-ts + mbpp-ts, converted by bench/train-pool.mjs; see bench/train-pool.md`, revision, functions, sets: {}, skipped, decontaminated }, null, 2));
write();

// Record every converted task once (sandboxed, as run.mjs would) and skip those without a usable public example.
process.env.BENCH_EXERCISES = join(a.out, "exercises.json");
const { split } = await import("./lib/common.mjs");
for (const ex of Object.keys(functions)) {
  const s = await split(a.out, ex, a.out);
  const n = Object.values(s.examples)[0].length;
  if (!n) { skipped[ex] = !s.tests.length ? "test file does not load (syntax error in the MultiPL-E translation)" : `${s.tests.filter((t) => t.eligible).length} of ${s.tests.length} asserts JSON-encodable: no public example under the split rule (needs 2)`; delete functions[ex]; rmSync(join(pool, ex), { recursive: true }); rmSync(join(a.out, "splits", `${ex}.json`)); }
}
write();
const count = (re) => Object.keys(functions).filter((k) => re.test(k)).length;
console.log(`converted ${Object.keys(functions).length} (humaneval ${count(/^he/)}, mbpp ${count(/^mbpp/)}), skipped ${Object.keys(skipped).length}, decontaminated ${Object.keys(decontaminated).length} -> ${a.out}`);
