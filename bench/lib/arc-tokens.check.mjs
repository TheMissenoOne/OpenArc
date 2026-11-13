// arc-tokens.mjs end to end against a stub OpenAI-compatible server, on two tiny exercises; no model, no dataset.
// Run: node --no-warnings bench/lib/arc-tokens.check.mjs   (runs tests in the bwrap sandbox and `openarc decompile` from ../stage0)
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BENCH, run } from "./common.mjs";

const dir = mkdtempSync(join(tmpdir(), "openarc-arc-tokens-"));
const ex = (name, fn, sig, cases) => {
  const d = join(dir, "ts-bench/repos/exercism-typescript/exercises/practice", name);
  mkdirSync(join(d, ".docs"), { recursive: true });
  writeFileSync(join(d, ".docs/instructions.md"), `# Instructions\n\nImplement ${fn}.`);
  writeFileSync(join(d, `${name}.test.ts`), `import { describe, it, expect } from '@jest/globals'\nimport { ${fn} } from './${name}.ts'\ndescribe('${name}', () => {\n${cases.map(([i, o], k) => `  it('case ${k}', () => { expect(${fn}(${JSON.stringify(i)})).toEqual(${JSON.stringify(o)}) })\n`).join("")}})\n`);
  return [name, { fns: { [fn]: sig } }];
};
const exercises = {
  functions: Object.fromEntries([
    ex("twice", "twice", "(n: number) => number", [[1, 2], [2, 4], [3, 6], [4, 8]]),
    ex("shout", "shout", "(s: string) => string", [["a", "A"], ["b", "B"], ["hi", "HI"], ["ok", "OK"]]),
    ex("held", "held", "(n: number) => number", [[1, 1], [2, 2]]),
  ]),
  sets: { dev: ["twice", "shout"], test: ["held"] },
};
writeFileSync(join(dir, "exercises.json"), JSON.stringify(exercises));
writeFileSync(join(dir, "steps.json"), JSON.stringify([
  { name: "create m.ts", add: { m: ["twice"] } },
  { name: "add shout", add: { m: ["shout"] } },
  { name: "change twice intent", intent: "twice" },
]));

// the stub: arm A (the body prompt) gets a right twice and a wrong shout; arm B always the right complete file
const calls = { A: 0, B: 0 };
const BODY = { twice: "return n * 2;", shout: "return s;" };
const stub = createServer(async (req, res) => {
  let b = "";
  for await (const c of req) b += c;
  const { messages } = JSON.parse(b);
  const armA = messages[0].content.startsWith("You write function bodies");
  calls[armA ? "A" : "B"]++;
  const content = armA
    ? [...messages[1].content.match(/Write the bod(?:y|ies) of (.*) in `/)[1].matchAll(/`(\w+)`/g)].map((m) => "```ts\n" + BODY[m[1]] + "\n```").join("\n")
    : "```ts\nexport function twice(n: number): number { return n * 2; }\nexport function shout(s: string): string { return s.toUpperCase(); }\n```";
  res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ choices: [{ message: { content } }], usage: armA ? { prompt_tokens: 100, completion_tokens: 10 } : { prompt_tokens: 300, completion_tokens: 50 } }));
}).listen(0, "127.0.0.1");
await new Promise((r) => stub.once("listening", r));
writeFileSync(join(dir, "matrix.json"), JSON.stringify({ backend: { provider: "openai", baseUrl: `http://127.0.0.1:${stub.address().port}/v1`, maxContextTokens: 8192, outputReserveTokens: 512, info: { label: "stub" } }, runs: [{ model: "stub-model", configs: [] }] }));

const out = join(dir, "out"), jsonl = join(out, "arc-tokens.jsonl");
const harness = (...extra) => run([process.execPath, "--no-warnings", join(BENCH, "arc-tokens.mjs"), "--dataset", join(dir, "ts-bench"), "--matrix", join(dir, "matrix.json"), "--steps", join(dir, "steps.json"), "--out", out, "--port", String(18600 + (process.pid % 300)), ...extra], { env: { ...process.env, BENCH_EXERCISES: join(dir, "exercises.json") }, timeoutMs: 300_000 });
const rows = () => readFileSync(jsonl, "utf8").trim().split("\n").map((l) => JSON.parse(l));
const report = async (file) => { const r = await run([process.execPath, "--no-warnings", join(BENCH, "arc-tokens.mjs"), "--report", file]); return { code: r.code, out: r.stdout + r.stderr }; };

try {
  // both arms scored
  let r = await harness();
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const first = rows();
  assert.equal(first.length, 6);
  const row = (arm, i, rs = first) => rs.find((x) => x.arm === arm && x.i === i);
  for (const i of [0, 1, 2]) assert.equal(row("B", i).correct, true, `B step ${i}`);
  assert.equal(row("A", 0).correct, true);
  assert.deepEqual([row("A", 0).calls, row("A", 0).prompt, row("A", 0).eval], [1, 100, 10], "usage from the backend");
  assert.equal(row("A", 1).heldOut.shout.allPass, false, "A's wrong shout is scored as wrong");
  assert.equal(row("A", 1).heldOut.twice.allPass, true);
  assert.deepEqual([row("A", 1).calls, row("A", 1).attempts, row("A", 1).publicPass], [3, 3, false], "3 attempts on failing public examples");
  assert.deepEqual([row("B", 1).calls, row("B", 1).prompt], [1, 300]);
  assert.ok(row("A", 0).arcChars > 0 && !row("A", 0).arcError, "A got a .arc");
  assert.match(row("A", 2).code.m, /return n \* 2;/);
  assert.deepEqual(calls, { A: 5, B: 3 });

  // resume: finished steps are skipped, the rest continue from the stored code
  r = await harness();
  assert.equal(r.code, 0);
  assert.equal(rows().length, 6, "a full rerun adds nothing");
  assert.deepEqual(calls, { A: 5, B: 3 }, "and calls nothing");
  writeFileSync(jsonl, first.filter((x) => x.i === 0).map((x) => JSON.stringify(x)).join("\n") + "\n");
  r = await harness();
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.deepEqual(calls, { A: 9, B: 5 }, "only steps 1 and 2 ran again");
  const again = rows();
  assert.equal(again.length, 6);
  for (const x of first) assert.equal(row(x.arm, x.i, again).correct, x.correct, `${x.arm} ${x.i} same outcome after resume`);

  // the test split is refused
  r = await harness("--set", "test");
  assert.equal(r.code, 3);
  assert.match(r.stderr, /refused.*dev split only.*held out/s);
  writeFileSync(join(dir, "steps-held.json"), JSON.stringify([{ name: "x", add: { m: ["held"] } }]));
  r = await run([process.execPath, "--no-warnings", join(BENCH, "arc-tokens.mjs"), "--dataset", join(dir, "ts-bench"), "--matrix", join(dir, "matrix.json"), "--steps", join(dir, "steps-held.json"), "--out", join(dir, "out2")], { env: { ...process.env, BENCH_EXERCISES: join(dir, "exercises.json") } });
  assert.equal(r.code, 3);
  assert.match(r.stderr, /refused: held not in the dev split/);
  assert.deepEqual(calls, { A: 9, B: 5 }, "refused runs call nothing");

  // --report on the real file, and the decision rule on hand-made files
  let rep = await report(jsonl);
  assert.equal(rep.code, 0);
  assert.match(rep.out, /tokens \(input \+ output\): B 1050, A 550/);
  assert.match(rep.out, /correct steps: B 3, A 1/);
  assert.match(rep.out, /verdict: not supported/);
  const made = (name, a, b) => {
    const f = join(dir, `${name}.jsonl`);
    writeFileSync(f, [0, 1, 2].flatMap((i) => [["A", a], ["B", b]].map(([arm, [tok, ok]]) => JSON.stringify({ arm, i, step: `s${i}`, prompt: tok[i], eval: 0, calls: 1, correct: ok[i], wallMs: 1000 }))).join("\n") + "\n");
    return f;
  };
  const B = [[400, 300, 300], [true, true, true]];
  rep = await report(made("win", [[200, 200, 200], [true, true, false]], B));
  assert.match(rep.out, /A\/B 0\.600/);
  assert.match(rep.out, /verdict: supported/);
  rep = await report(made("edge", [[300, 200, 200], [true, true, false]], B));
  assert.match(rep.out, /A\/B 0\.700[\s\S]*verdict: supported/, "exactly 30% fewer is enough");
  rep = await report(made("loss-tokens", [[300, 250, 250], [true, true, true]], B));
  assert.match(rep.out, /A\/B <= 0\.70 no[\s\S]*verdict: not supported/);
  rep = await report(made("loss-correct", [[100, 100, 100], [true, false, false]], B));
  assert.match(rep.out, /A correct >= B correct - 1 no[\s\S]*verdict: not supported/);
  writeFileSync(join(dir, "partial.jsonl"), JSON.stringify({ arm: "B", i: 0, step: "s0", prompt: 1, eval: 1, calls: 1, correct: true, wallMs: 1 }) + "\n");
  rep = await report(join(dir, "partial.jsonl"));
  assert.equal(rep.code, 1);
  assert.match(rep.out, /verdict: not computable/);
} finally {
  stub.close();
  rmSync(dir, { recursive: true, force: true });
}
console.log("arc-tokens.check: ok");
