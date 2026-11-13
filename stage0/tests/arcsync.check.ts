// `openarc arc status|prompt|accept|compile` end to end on the real CLI: a plain JavaScript project and a TypeScript one,
// decompiled, then the `.arc` file edited ahead of the code. Accept changes a file only inside the function's body, and
// a rejected body leaves it byte-identical. compile talks to a stub model server; no real model runs.
// Run: node --no-warnings tests/arcsync.check.ts
import assert from "node:assert";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { parseArc, printArc, type ArcExample } from "../src/arc.ts";

if (process.platform === "win32") {
  console.log("arcsync.check skipped on Windows");
  process.exit(0);
}
const MAIN = resolve("src/main.ts");
let dir = "";
let onAsk: (() => void) | null = null; // runs once, while the model "works"
const oa = (args: string[], stdin = "") => new Promise<{ code: number | null; out: string; err: string }>((done) => {
  const c = spawn(process.execPath, ["--no-warnings", MAIN, ...args], { cwd: dir, stdio: ["pipe", "pipe", "pipe"] });
  let out = "", err = "";
  c.stdout.on("data", (b) => (out += b));
  c.stderr.on("data", (b) => (err += b));
  c.on("close", (code) => done({ code, out, err }));
  c.stdin.end(stdin);
});
const write = (f: string, t: string) => (mkdirSync(dirname(join(dir, f)), { recursive: true }), writeFileSync(join(dir, f), t));
const read = (f: string) => readFileSync(join(dir, f), "utf8");
/** Set a function's `example` lines in an `.arc` file, keeping its observations. */
const specify = (arc: string, fn: string, examples: ArcExample[]) => {
  const m = parseArc(read(arc));
  const f = m.fns.find((x) => x.name === fn)!;
  f.examples = [...examples, ...f.examples.filter((e) => e.observed)];
  write(arc, printArc(m));
};
const status = (fn: string) => (JSON.parse(read(".openarc/decompile.json")) as { modules: Record<string, { fns: Record<string, { status: string; why?: string }> }> }).modules["src/calc.js"]!.fns[fn]!;

// a stub OpenAI-compatible model server: replies in order, records each request's user message
const replies: string[] = [], asked: string[] = [];
const server = createServer((req, res) => {
  let body = "";
  req.on("data", (b) => (body += b));
  req.on("end", () => {
    asked.push(JSON.stringify(JSON.parse(body)));
    onAsk?.(), (onAsk = null);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: replies.shift() ?? "return 0;" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
  });
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const port = (server.address() as { port: number }).port;

const dirs: string[] = [];
try {
  // ── plain JavaScript ──
  dir = mkdtempSync(join(resolve(".."), ".arcsync-check-js-"));
  dirs.push(dir);
  write("package.json", '{"name":"plain","version":"1.0.0","private":true,"type":"module"}');
  write("src/calc.js", `// Adds two numbers.
export function add(a, b) {
  return a + b;
}

export const double = (n) => n * 2;

export function push(list, x) { list.push(x); }

export function need(x) {
  if (x == null) throw new Error("x is required");
  return x;
}

export function same(z) { return z; }
`);
  write("tests/calc.test.js", `import { add, double, push, need, same } from "../src/calc.js";
add(2, 3); double(3); push([1], 2); need(4); same(1);
`);
  let r = await oa(["decompile"]);
  assert.strictEqual(r.code, 0, r.out + r.err);
  const ARC = "arc/spec/calc.arc";
  r = await oa(["arc", "status"]);
  assert.strictEqual(r.code, 0, r.out + r.err);
  assert.match(r.out, /calc\.add: no examples\n[\s\S]*5 functions: ok 0, stale 0, unrunnable 0, no examples 5\n$/);

  // the spec moves ahead: double now triples. add's example holds; push and need state `after` and `throws`
  specify(ARC, "add", [{ args: [2, 3], expected: 5 }]);
  specify(ARC, "double", [{ args: [3], expected: 9 }, { args: [0], expected: 0 }]);
  specify(ARC, "push", [{ args: [[1], 2], expected: "$undefined", after: [[1, 2], 2] }]);
  specify(ARC, "need", [{ args: [null], throws: "required" }, { args: [4], expected: 4 }]);
  const arcBefore = read(ARC);
  r = await oa(["arc", "status"]);
  assert.strictEqual(r.code, 1, r.out + r.err);
  assert.ok(r.out.includes("calc.double: stale: example (3) => 9: the code returns 6\n"), r.out);
  assert.ok(r.out.includes("calc.add: ok\ncalc.double"), r.out);
  assert.match(r.out, /5 functions: ok 3, stale 1, unrunnable 0, no examples 1\n$/);
  r = await oa(["arc", "status", "calc.double", "--json"]);
  const st = JSON.parse(r.out) as { ok: boolean; fns: { id: string; status: string; failing: { example: string; got: string }[] }[] };
  assert.deepStrictEqual([r.code, st.ok, st.fns], [1, false, [{ id: "calc.double", file: "src/calc.js", status: "stale", failing: [{ example: "example (3) => 9", got: "6" }] }]]);
  r = await oa(["arc", "status", "calc.add"]);
  assert.deepStrictEqual([r.code, r.out], [0, "calc.add: ok\n1 functions: ok 1, stale 0, unrunnable 0, no examples 0\n"]);
  assert.strictEqual((await oa(["arc", "status", "calc.nope"])).code, 1);
  assert.strictEqual(read(ARC), arcBefore, "status writes nothing");

  // prompt: signature, examples, current code, and what fails now
  r = await oa(["arc", "prompt", "calc.double"]);
  assert.strictEqual(r.code, 0, r.err);
  assert.ok(r.out.startsWith("Pipe your reply to `openarc arc accept calc.double`"), r.out);
  for (const s of ["fn double(n: Any): Num", "  example (3) => 9\n  example (0) => 0\n", "Current code:\nexport const double = (n) => n * 2;\n", "Failing now:\n  example (3) => 9: the code returns 6"]) assert.ok(r.out.includes(s), `${s}\n---\n${r.out}`);
  r = await oa(["arc", "prompt", "calc.double", "--json"]);
  assert.deepStrictEqual(Object.keys(JSON.parse(r.out)), ["id", "file", "signature", "outputFormat", "system", "prompt"]);

  // a wrong body is rejected and the file is byte-identical; a right one changes only the body
  const src = read("src/calc.js");
  r = await oa(["arc", "accept", "calc.double"], "return n * 4;\n");
  assert.deepStrictEqual([r.code, r.out], [1, "example (3) => 9: the code returns 12\n"]);
  assert.strictEqual(read("src/calc.js"), src);
  r = await oa(["arc", "accept", "calc.double", "--json"], "```js\nreturn n * 3;\n```\n");
  assert.deepStrictEqual([r.code, JSON.parse(r.out)], [0, { ok: true, file: "src/calc.js", id: "calc.double" }], r.err);
  assert.strictEqual(read("src/calc.js"), src.replace("(n) => n * 2;", "(n) => {\n  return n * 3;\n};"));
  assert.deepStrictEqual([status("double").status, status("double").why], ["specified", undefined]);
  r = await oa(["arc", "status", "calc.double"]);
  assert.strictEqual(r.code, 0, r.out);
  assert.ok(r.out.includes("calc.double: observed (3) changed: was 6, now 9"), r.out);

  // a rule is a requirement too: a body that passes the examples and breaks a rule on a generated input is rejected
  {
    const m = parseArc(read("arc/spec/calc.arc"));
    m.fns.find((x) => x.name === "double")!.rules.push({ name: "tripled", text: "result == n * 3" });
    write("arc/spec/calc.arc", printArc(m));
    const kept = read("src/calc.js");
    r = await oa(["arc", "accept", "calc.double"], "return n === 3 ? 9 : 0;");
    assert.strictEqual(r.code, 1, r.out + r.err);
    assert.match(r.out, /^rule tripled: broken by \(.+\) -> 0\n$/);
    assert.strictEqual(read("src/calc.js"), kept);
    r = await oa(["arc", "status", "calc.double"]);
    assert.strictEqual(r.code, 0, r.out);
    const back = parseArc(read("arc/spec/calc.arc"));
    for (const f of back.fns) f.rules = [];
    write("arc/spec/calc.arc", printArc(back));
  }

  // `after` and `throws` examples verify
  const src2 = read("src/calc.js");
  r = await oa(["arc", "accept", "calc.push"], "list.push(x, x);");
  assert.deepStrictEqual([r.code, r.out], [1, 'example ([1], 2) => "$undefined" after ([1, 2], 2): the code returns "$undefined" after ([1, 2, 2], 2)\n']);
  r = await oa(["arc", "accept", "calc.need"], "return x;");
  assert.deepStrictEqual([r.code, r.out], [1, 'example (null) throws "required": the code returns null\n']);
  assert.strictEqual(read("src/calc.js"), src2);
  r = await oa(["arc", "accept", "calc.push"], "list[list.length] = x;");
  assert.strictEqual(r.code, 0, r.out + r.err);
  r = await oa(["arc", "accept", "calc.need"], '  if (x === null || x === undefined) {\n    throw new Error("x is required!");\n  }\n  return x;\n');
  assert.strictEqual(r.code, 0, r.out + r.err);
  assert.strictEqual(read("src/calc.js"), src2.replace("{ list.push(x); }", "{\n  list[list.length] = x;\n}").replace('if (x == null) throw new Error("x is required");', 'if (x === null || x === undefined) {\n    throw new Error("x is required!");\n  }'));

  // refusals: not in any .arc, no example lines, a body with the signature, a body reaching outside the function
  const src3 = read("src/calc.js");
  for (const [args, body, why] of [
    [["calc.nope"], "return 1;", /calc\.nope is not in any \.arc file/],
    [["calc.same"], "return z;", /calc\.same has no `example` lines.*Promote an `observed` line/],
    [["calc.add"], "export function add(a, b) { return a + b; }", /repeats the signature/],
    [["calc.add"], "function add(a, b) { return a + b; }", /repeats the signature/],
    [["calc.add"], "return a + b; }\nfunction add2(a, b) {\n  return 0;", /changes the signature or code outside the body/],
    [["calc.add"], 'import x from "y";\nreturn a + b;', /import lines/],
  ] as [string[], string, RegExp][]) {
    r = await oa(["arc", "accept", ...args], body);
    assert.strictEqual(r.code, 1, body);
    assert.match(r.err, why, r.err);
  }
  assert.strictEqual((await oa(["arc", "accept"])).code, 2);
  assert.strictEqual((await oa(["arc", "prompt", "calc.same"])).code, 1);
  assert.strictEqual(read("src/calc.js"), src3);

  // guard: marker-free code is the developer's, so edits to its functions pass
  r = await oa(["guard", "--hook"], JSON.stringify({ tool_name: "Edit", tool_input: { file_path: join(dir, "src/calc.js"), old_string: "return a + b;", new_string: "return b + a;" } }));
  assert.deepStrictEqual([r.code, r.err], [0, ""]);
  assert.strictEqual((await oa(["guard"])).code, 0);

  // compile: a stub model that fails once, then succeeds; the retry carries the failure
  write("openarc.config.json", JSON.stringify({ version: 1, backends: { local: { provider: "local", baseUrl: `http://127.0.0.1:${port}/v1`, model: "stub", maxContextTokens: 8192 } }, compilation: { defaultBackend: "local", maxAttempts: 2 } }));
  r = await oa(["arc", "compile", "--stale"]);
  assert.deepStrictEqual([r.code, r.out, asked.length], [0, "nothing is stale\n", 0]);
  specify(ARC, "double", [{ args: [3], expected: 12 }]);
  replies.push("```js\nreturn n * 5;\n```", "```js\nreturn n * 4;\n```");
  r = await oa(["arc", "compile", "calc"]);
  assert.deepStrictEqual([r.code, r.out], [0, "compiled calc.double (attempt 2)\n"], r.err);
  assert.strictEqual(asked.length, 2);
  assert.ok(asked[0]!.includes("the code returns 9") && asked[1]!.includes("example (3) => 12: the code returns 15"), asked[1]);
  assert.ok(read("src/calc.js").includes("(n) => {\n  return n * 4;\n};"));
  // a model that never gets it right: the file stays as it was
  specify(ARC, "double", [{ args: [3], expected: 13 }]);
  const src4 = read("src/calc.js");
  replies.push("return 1;", "return 2;");
  r = await oa(["arc", "compile", "calc.double"]);
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /^calc\.double: not compiled after 2 attempts\n  example \(3\) => 13: the code returns 2\n$/);
  assert.deepStrictEqual([asked.length, read("src/calc.js")], [4, src4]);
  // the file edited while the model works: the reply is not spliced into the earlier text, the edit stays
  onAsk = () => write("src/calc.js", `${src4}// mine\n`);
  replies.push("return 13;");
  r = await oa(["arc", "compile", "calc.double"]);
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /src\/calc\.js changed while the model worked/);
  assert.deepStrictEqual([asked.length, read("src/calc.js")], [5, `${src4}// mine\n`]);
  write("src/calc.js", src4);

  // ── TypeScript ──
  dir = mkdtempSync(join(resolve(".."), ".arcsync-check-ts-"));
  dirs.push(dir);
  write("package.json", '{"name":"typed","version":"1.0.0","private":true,"type":"module"}');
  write("tsconfig.json", JSON.stringify({ compilerOptions: { target: "es2023", module: "nodenext", moduleResolution: "nodenext", strict: true, noEmit: true, allowImportingTsExtensions: true } }));
  write("src/geo.ts", `export interface Pt { x: number; y: number }

/** Moves a point right. */
export function move(p: Pt, dx: number): Pt {
  return { x: p.x + dx, y: p.y };
}
`);
  r = await oa(["decompile"]);
  assert.strictEqual(r.code, 0, r.out + r.err);
  specify("arc/spec/geo.arc", "move", [{ args: [{ x: 1, y: 2 }, 3], expected: { x: 4, y: 5 } }]);
  r = await oa(["arc", "status"]);
  assert.deepStrictEqual([r.code, r.out.split("\n")[0]], [1, "geo.move: stale: example ({x: 1, y: 2}, 3) => {x: 4, y: 5}: the code returns {x: 4, y: 2}"]);
  r = await oa(["arc", "prompt", "geo.move"]);
  assert.ok(r.out.includes("fn move(p: Pt, dx: Num): Pt\ntype Pt = { x: Num, y: Num }\nIntent:\n  Moves a point right.\n"), r.out);
  const ts0 = read("src/geo.ts");
  r = await oa(["arc", "accept", "geo.move"], 'return { x: "a", y: p.y + dx };');
  assert.strictEqual(r.code, 1);
  assert.match(r.out, /^TS2322 line 5: Type 'string' is not assignable to type 'number'\.\n$/);
  assert.strictEqual(read("src/geo.ts"), ts0);
  r = await oa(["arc", "accept", "geo.move"], "return { x: p.x + dx, y: p.y + dx };");
  assert.strictEqual(r.code, 0, r.out + r.err);
  assert.strictEqual(read("src/geo.ts"), ts0.replace("{\n  return { x: p.x + dx, y: p.y };\n}", "{\n  return { x: p.x + dx, y: p.y + dx };\n}"));
  assert.strictEqual((await oa(["arc", "status"])).code, 0);

  // ── methods: an instance and a static method (`fn Class.m`, `fn static Class.m`), `export default class` as
  // `default.m`, and `module.exports = { f() {} }`, in plain JavaScript; then TypeScript, where a body that breaks a
  // caller in another file is rejected naming it, and a broken rule shows in decompile's state and in `openarc status`
  dir = mkdtempSync(join(resolve(".."), ".arcsync-check-methods-"));
  dirs.push(dir);
  write("package.json", '{"name":"methods","version":"1.0.0","private":true,"type":"module"}');
  write("src/shop.js", `// A cart.
export class Cart {
  constructor(n = 0) { this.n = n; }

  // Adds k to the count.
  add(k) {
    return this.n + k;
  }

  static of(n) {
    return n * 2;
  }
}
`);
  write("src/tally.js", "export default class {\n  half(n) {\n    return n / 2;\n  }\n}\n");
  write("src/legacy.cjs", "function inc() {\n  return 0;\n}\nmodule.exports = {\n  inc(n) {\n    return n + 1 + inc();\n  },\n};\n");
  r = await oa(["decompile"]);
  assert.strictEqual(r.code, 0, r.out + r.err);
  {
    const m = parseArc(read("arc/spec/shop.arc"));
    assert.deepStrictEqual(m.fns.map((f) => [f.name, !!f.static]), [["Cart.add", false], ["Cart.of", true]]);
  }
  specify("arc/spec/shop.arc", "Cart.add", [{ receiver: [1], args: [2], expected: 5 }]);
  specify("arc/spec/shop.arc", "Cart.of", [{ args: [3], expected: 9 }]);
  specify("arc/spec/tally.arc", "default.half", [{ receiver: [], args: [8], expected: 2 }]);
  specify("arc/spec/legacy.arc", "inc", [{ args: [1], expected: 3 }]);
  r = await oa(["arc", "status"]);
  assert.match(r.out, /4 functions: ok 0, stale 4, unrunnable 0, no examples 0\n$/, r.out);
  r = await oa(["arc", "prompt", "shop.Cart.add"]);
  assert.ok(r.out.includes("Current code:\nexport class Cart {\n  ...\n  add(k) {\n    return this.n + k;\n  }\n  ...\n}\nFailing now:\n  example new (1) . (2) => 5: the code returns 3"), r.out);
  const shop = read("src/shop.js");
  r = await oa(["arc", "accept", "shop.Cart.add"], "return this.n + k * 3;");
  assert.deepStrictEqual([r.code, r.out], [1, "example new (1) . (2) => 5: the code returns 7\n"]);
  for (const [id, body] of [["shop.Cart.add", "add(k) { return this.n + 2 * k; }"], ["shop.Cart.of", "static of(n) {\n  return n * 3;\n}"]]) {
    r = await oa(["arc", "accept", id!], body);
    assert.match(r.err, /repeats the signature/, r.err);
  }
  assert.strictEqual(read("src/shop.js"), shop);
  for (const [id, body] of [["shop.Cart.add", "return this.n + 2 * k;"], ["shop.Cart.of", "return n * 3;"], ["tally.default.half", "return n / 4;"], ["legacy.inc", "return n + 2;"]]) {
    r = await oa(["arc", "accept", id!], body);
    assert.strictEqual(r.code, 0, `${id}: ${r.out}${r.err}`);
  }
  assert.strictEqual(read("src/shop.js"), shop.replace("return this.n + k;", "return this.n + 2 * k;").replace("return n * 2;", "return n * 3;"));
  assert.strictEqual(read("src/tally.js"), "export default class {\n  half(n) {\n    return n / 4;\n  }\n}\n");
  assert.strictEqual(read("src/legacy.cjs"), "function inc() {\n  return 0;\n}\nmodule.exports = {\n  inc(n) {\n    return n + 2;\n  },\n};\n"); // the exported one, not the private function
  assert.match((await oa(["arc", "status"])).out, /4 functions: ok 4, stale 0/);

  dir = mkdtempSync(join(resolve(".."), ".arcsync-check-tsmethods-"));
  dirs.push(dir);
  write("package.json", '{"name":"typed2","version":"1.0.0","private":true,"type":"module"}');
  write("tsconfig.json", JSON.stringify({ compilerOptions: { target: "es2023", module: "nodenext", moduleResolution: "nodenext", strict: true, noEmit: true, allowImportingTsExtensions: true } }));
  write("src/geo.ts", `export class Counter {
  n = 0;
  inc(by: number): number {
    return this.n + by;
  }
  static zero(x: number): number {
    return x * 0;
  }
}

/** A label for n. */
export function label(n: number) {
  return n > 0 ? "pos" : "neg";
}
`);
  write("src/use.ts", `import { label } from "./geo.ts";

export function shout(n: number): string {
  const l: "pos" | "neg" = label(n);
  return l.toUpperCase();
}
`);
  r = await oa(["decompile"]);
  assert.strictEqual(r.code, 0, r.out + r.err);
  specify("arc/spec/geo.arc", "Counter.inc", [{ receiver: [], args: [1], expected: 2 }]);
  specify("arc/spec/geo.arc", "Counter.zero", [{ args: [2], expected: 4 }]);
  specify("arc/spec/geo.arc", "label", [{ args: [1], expected: "pos" }, { args: [0], expected: "neg" }]);
  const geo = read("src/geo.ts");
  // the examples hold, but the inferred return type widens to string and the caller in src/use.ts no longer type checks
  r = await oa(["arc", "accept", "geo.label"], 'const s: string = n > 0 ? "pos" : "neg";\nreturn s;');
  assert.deepStrictEqual([r.code, r.out], [1, "TS2322 src/use.ts line 4: Type 'string' is not assignable to type '\"pos\" | \"neg\"'.\n"]);
  r = await oa(["arc", "accept", "geo.Counter.zero"], 'return x + "";');
  assert.deepStrictEqual([r.code, r.out], [1, "TS2322 line 7: Type 'string' is not assignable to type 'number'.\n"]);
  r = await oa(["arc", "accept", "geo.Counter.inc"], "return this.n + by * 3;");
  assert.deepStrictEqual([r.code, r.out], [1, "example new () . (1) => 2: the code returns 3\n"]);
  assert.strictEqual(read("src/geo.ts"), geo);
  for (const [id, body] of [["geo.Counter.inc", "return this.n + by * 2;"], ["geo.Counter.zero", "return x * 2;"]]) {
    r = await oa(["arc", "accept", id!], body);
    assert.strictEqual(r.code, 0, `${id}: ${r.out}${r.err}`);
  }
  assert.strictEqual(read("src/geo.ts"), geo.replace("return this.n + by;", "return this.n + by * 2;").replace("return x * 0;", "return x * 2;"));

  // a rule the code breaks: `openarc decompile` checks it on the calls it makes, records the function as failing in the
  // words `--check` prints, and `openarc status` counts it
  {
    const m = parseArc(read("arc/spec/geo.arc"));
    m.fns.find((x) => x.name === "label")!.rules.push({ name: "positive", text: 'result == "pos"' });
    write("arc/spec/geo.arc", printArc(m));
  }
  r = await oa(["decompile"]);
  assert.match(r.out, /decompiled 2 modules: tested 0, failing 1,/, r.out);
  const label = (JSON.parse(read(".openarc/decompile.json")) as { modules: Record<string, { fns: Record<string, { status: string; why?: string }> }> }).modules["src/geo.ts"]!.fns.label!;
  assert.deepStrictEqual([label.status, label.why], ["failing", 'rule positive: broken by (0) -> "neg"']);
  assert.ok((await oa(["decompile", "--check"])).out.includes('src/geo.ts: label: rule positive: broken by (0) -> "neg"\n'));
  r = await oa(["status"]);
  assert.match(r.out, /^total: 2 modules, 4 functions \(.*failing 1.*\); weakest failing$/m, r.out);
} finally {
  server.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
}
console.log("arcsync.check ok");
