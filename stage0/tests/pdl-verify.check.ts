// `openarc pdl verify` and the sync gate (src/pdlverify.ts) on the real CLI in a temp project with JavaScript and
// TypeScript code: examples that pass, fail and cannot run (a bare name), an instance method, a `check` that holds and
// one that is broken, a `check` with nothing bound to it, the not-checked count, and `pdl sync` refusing a block whose
// lines fail unless --no-verify. No model. Run: node --no-warnings tests/pdl-verify.check.ts
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

if (process.platform === "win32") { console.log("pdl-verify.check: skipped on Windows"); process.exit(0); }
const MAIN = resolve("src/main.ts");
let dir = "";
const oa = (args: string[]) => new Promise<{ code: number | null; out: string; err: string }>((done) => {
  const c = spawn(process.execPath, ["--no-warnings", MAIN, ...args], { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
  let out = "", err = "";
  c.stdout.on("data", (b) => (out += b));
  c.stderr.on("data", (b) => (err += b));
  c.on("close", (code) => done({ code, out, err }));
});
const write = (f: string, t: string) => (mkdirSync(dirname(join(dir, f)), { recursive: true }), writeFileSync(join(dir, f), t));
const read = (f: string) => readFileSync(join(dir, f), "utf8");
type Line = { line: number; text: string; outcome: string; detail?: string };
type Result = { ok: boolean; blocks: { id: string; lines: Line[] }[]; summary: Record<string, number> };

const ARC = `feature Shop {
  a shopper fills a cart;

  total(lines) {
    source "src/cart.js";
    example total([{qty: 2, price: 450}]) => 900;
    example total([]) throws "cart is empty";
    example total(someLines) => 10;
    check result >= 0;
    check threw or len(lines) > 0;
  }

  Cart.add(k) {
    source "src/cart.js";
    adds k units up to the capacity;
    example new Cart(10).add(3) => 3;
    example new Cart(1).add(3) throws "full";
  }

  move(p, dx) {
    source "src/geo.ts";
    example move({x: 1, y: 2}, 3) => {x: 4, y: 2};
  }

  state Flow {
    initial empty;
    empty -> filled : add();
  }

  rule positive { check total >= 0; }
}
`;

dir = mkdtempSync(join(resolve(".."), ".pdl-verify-check-"));
try {
  write("package.json", '{"name":"shop","version":"1.0.0","private":true,"type":"module"}');
  write("tsconfig.json", JSON.stringify({ compilerOptions: { target: "es2023", module: "nodenext", moduleResolution: "nodenext", strict: true, noEmit: true, allowImportingTsExtensions: true } }));
  write("src/cart.js", `export function total(lines) {
  if (!lines.length) throw new Error("cart is empty");
  return lines.reduce((n, l) => n + Math.abs(l.qty * l.price), 0);
}
export class Cart {
  constructor(cap) { this.cap = cap; this.n = 0; }
  add(k) { if (this.n + k > this.cap) throw new Error("full"); this.n += k; return this.n; }
}
`);
  write("src/geo.ts", "export interface Pt { x: number; y: number }\nexport function move(p: Pt, dx: number): Pt {\n  return { x: p.x + dx, y: p.y };\n}\n");
  write("arc/features/shop.arc", ARC);

  // static counts in status and show: no code runs for them
  const st = JSON.parse((await oa(["pdl", "status", "--json"])).out) as { blocks: { id: string; exact: object }[] };
  const exact = Object.fromEntries(st.blocks.map((b) => [b.id, b.exact]));
  assert.deepEqual(exact, {
    Shop: { runnable: 0, notRunnable: 0 }, "Shop.total": { runnable: 4, notRunnable: 1 }, "Shop.Cart.add": { runnable: 2, notRunnable: 0 },
    "Shop.move": { runnable: 1, notRunnable: 0 }, "Shop.Flow": { runnable: 0, notRunnable: 0 }, "Shop.positive": { runnable: 0, notRunnable: 1 },
  });

  // everything holds: exit 0, not runnable is no failure
  let r = await oa(["pdl", "verify", "--json"]);
  assert.equal(r.code, 0, r.out + r.err);
  let v = JSON.parse(r.out) as Result;
  const of = (id: string) => v.blocks.find((b) => b.id === id)!.lines.map((l) => [l.outcome, l.detail ?? ""]);
  assert.deepEqual(of("Shop.total"), [
    ["passed", ""], ["passed", ""], ["not runnable", "someLines is a name, not a literal value"],
    ["passed", of("Shop.total")[3]![1]], ["passed", of("Shop.total")[4]![1]],
  ]);
  assert.match(of("Shop.total")[3]![1], /^held on \d+ inputs$/, "a check runs on the examples and generated inputs");
  assert.deepEqual(of("Shop.Cart.add"), [["passed", ""], ["passed", ""]], "a method: a fresh receiver per example");
  assert.deepEqual(of("Shop.move"), [["passed", ""]], "TypeScript");
  assert.deepEqual(of("Shop.positive"), [["not runnable", "not inside a function"]]);
  assert.ok(!v.blocks.some((b) => b.id === "Shop.Flow"), "a block with no exact lines has no line");
  assert.deepEqual(v.summary, { passed: 7, failed: 0, notRunnable: 2, notChecked: 3 }, "the purpose, a sentence and a transition are not checked");
  r = await oa(["pdl", "verify", "Shop.move"]);
  assert.equal(r.out, "Shop.move: 1 passed\n1 exact lines: passed 1, failed 0, not runnable 0; 0 statements not checked (sentences, transitions, on, visible when)\n");

  // sync records them all
  r = await oa(["pdl", "sync", "--all"]);
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /^synced 6 blocks/);

  // the code drifts: an example and a check fail, naming what the code did
  write("src/cart.js", read("src/cart.js").replace("Math.abs(l.qty * l.price)", "l.qty * l.price").replace("this.n += k; return this.n;", "this.n += k; return this.n + 1;"));
  write("src/geo.ts", read("src/geo.ts").replace("y: p.y }", "y: p.y + 1 }"));
  r = await oa(["pdl", "verify"]);
  assert.equal(r.code, 1, r.out + r.err);
  assert.match(r.out, /^Shop\.total: 3 passed, 1 failed, 1 not runnable$/m);
  assert.match(r.out, /^ {2}arc\/features\/shop\.arc:9: failed: check result >= 0: broken by \(\[\{qty: -?\d+, price: -?\d+\}\]\) -> -\d+$/m);
  assert.match(r.out, /^ {2}arc\/features\/shop\.arc:8: not runnable: example total\(someLines\) => 10: someLines is a name, not a literal value$/m);
  assert.match(r.out, /^Shop\.Cart\.add: 1 passed, 1 failed$/m);
  assert.match(r.out, /^ {2}arc\/features\/shop\.arc:16: failed: example new Cart\(10\)\.add\(3\) => 3: the code returns 4$/m);
  assert.match(r.out, /^ {2}arc\/features\/shop\.arc:22: failed: example move\(\{x: 1, y: 2\}, 3\) => \{x: 4, y: 2\}: the code returns \{x: 4, y: 3\}$/m);
  assert.match(r.out, /^9 exact lines: passed 4, failed 3, not runnable 2; 3 statements not checked/m);

  // sync refuses the blocks whose lines fail, writes the others, exit 1
  const before = JSON.parse(read(".openarc/pdl.json")) as { blocks: Record<string, unknown> };
  write("arc/features/shop.arc", read("arc/features/shop.arc").replace("a shopper fills a cart;", "a shopper fills a cart and pays;"));
  r = await oa(["pdl", "sync", "--all"]);
  assert.equal(r.code, 1, r.out + r.err);
  assert.match(r.out, /^synced 3 blocks: Shop, Shop\.Flow, Shop\.positive$/m);
  assert.match(r.err, /^Shop\.move: not synced: arc\/features\/shop\.arc:22: example move\(\{x: 1, y: 2\}, 3\) => \{x: 4, y: 2\}: the code returns \{x: 4, y: 3\}$/m);
  let after = JSON.parse(read(".openarc/pdl.json")) as { blocks: Record<string, unknown> };
  for (const id of ["Shop.total", "Shop.Cart.add", "Shop.move"]) assert.deepEqual(after.blocks[id], before.blocks[id], `${id}: its entry is left as it was`);
  assert.notDeepEqual(after.blocks["Shop"], before.blocks["Shop"]);
  r = await oa(["pdl", "sync", "Shop.move"]);
  assert.equal(r.code, 1);
  assert.match(r.out, /^synced 0 blocks$/m);
  assert.deepEqual((JSON.parse(read(".openarc/pdl.json")) as { blocks: object }).blocks, after.blocks, "nothing written for it");
  // --no-verify records it anyway
  r = await oa(["pdl", "sync", "Shop.move", "--no-verify"]);
  assert.equal(r.code, 0, r.err);
  after = JSON.parse(read(".openarc/pdl.json")) as { blocks: Record<string, unknown> };
  assert.notDeepEqual(after.blocks["Shop.move"], before.blocks["Shop.move"]);

  // a block with nothing runnable syncs as before, even with no sandbox config to read
  write("openarc.config.json", "{ not json");
  write("arc/features/shop.arc", read("arc/features/shop.arc").replace("rule positive { check total >= 0; }", "rule positive { check total >= 0; never below zero; }"));
  r = await oa(["pdl", "sync", "Shop.positive"]);
  assert.equal(r.code, 0, r.err);
  // and an invalid config stops verify when something would run
  r = await oa(["pdl", "verify", "Shop.move"]);
  assert.equal(r.code, 1);
  assert.equal(r.out, "");
  assert.equal((await oa(["pdl", "verify", "a", "b"])).code, 2);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log("pdl-verify.check: ok");
