// `openarc pdl draft` (src/pdldraft.ts) on the real CLI in a temp project: the skeleton for JavaScript, TypeScript, a
// directory, a language with no adapter and (with OPENARC_GO) Go; doc comments with `;` and braces; the refusals and
// --name; and that the result passes `pdl check`, is stable under `pdl format`, and lists every block as new. No model.
// Run: node --no-warnings tests/pdl-draft.check.ts
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { sentence, fileDoc, pascal, kebab } from "../src/pdldraft.ts";

// ── pure parts ──
assert.equal(pascal("pdl-sync.ts"), "PdlSync");
assert.equal(pascal("checkout"), "Checkout");
assert.equal(kebab("PdlSync"), "pdl-sync");
assert.equal(kebab("HTTPServer"), "http-server");
assert.equal(sentence("Adds two numbers. Then more."), "Adds two numbers");
assert.equal(sentence("Returns {a: 1}; never throws."), "Returns (a: 1), never throws");
assert.equal(sentence("See https://x.org/a (and more"), "See https:/x.org/a and more", "a comment opener and an open group go");
assert.equal(sentence("uses cache"), undefined, "a doc that reads as an exact form is not kept");
assert.equal(fileDoc("// Lexer for the thing. More.\n\nimport x from 'y';\n"), "Lexer for the thing. More.");
assert.equal(fileDoc("// The doc of f.\nexport function f() {}\n"), undefined, "a comment attached to a declaration is its doc");
assert.equal(fileDoc("// Copyright 2024 X\n\n// Package calc adds.\npackage calc\n"), "Package calc adds.");
assert.equal(fileDoc('"""Tools for x."""\nimport os\n'), "Tools for x.");

// ── the CLI ──
const MAIN = resolve("src/main.ts");
const dir = mkdtempSync(join(resolve(".."), ".pdl-draft-check-"));
const oa = (args: string[], env: Record<string, string> = {}) => {
  const r = spawnSync(process.execPath, ["--no-warnings", MAIN, ...args], { cwd: dir, encoding: "utf8", env: { ...process.env, ...env } });
  return { code: r.status, out: r.stdout, err: r.stderr };
};
const write = (f: string, t: string) => (mkdirSync(dirname(join(dir, f)), { recursive: true }), writeFileSync(join(dir, f), t));
const read = (f: string) => readFileSync(join(dir, f), "utf8");
const statuses = () => { const r = oa(["pdl", "status", "--json"]); assert.equal(r.code, 0, r.err); return (JSON.parse(r.out) as { blocks: { id: string; status: string; source: string[] }[] }).blocks; };

try {
  write("package.json", '{"name":"shop","version":"1.0.0","private":true,"type":"module"}');
  write("src/cart.js", `// Cart arithmetic for the shop. Kept tiny.

/** Adds a line to the cart; returns {lines, total} as a new object. */
export function add(cart, line) { return { lines: [...cart.lines, line], total: cart.total + line.qty * line.price }; }

export const empty = () => ({ lines: [], total: 0 });

function hidden() { return 1; }

export class Till {
  /** Opens the till. */
  open() { return true; }
  close() { return false; }
  _secret() { return 0; }
}
`);
  write("src/cart.test.js", "import { add } from './cart.js';\n");
  write("src/pricing.ts", `export interface Line { qty: number; price: number }

/** The total of the lines, in cents. */
export function total(lines: Line[], discount?: number): number { return lines.reduce((n, l) => n + l.qty * l.price, 0) - (discount ?? 0); }
`);
  write("src/stock/count.js", "/** Units on hand. */\nexport const count = (sku) => sku.length;\n");
  write("src/stock/reserve.js", "export function reserve(sku, n) { return n; }\n");
  write("src/stock/notes.md", "not code\n");
  write("src/stock/node_modules/x.js", "export const skip = 1;\n");
  write("tools/report.py", "def report():\n    pass\n");

  // a JavaScript file: documented and undocumented functions, a class, a doc comment with ; and braces
  let r = oa(["pdl", "draft", "./src/cart.js"]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^wrote arc\/features\/cart\.arc: feature Cart, 4 function blocks, design \d+% of code$/m);
  assert.match(r.out, /^next: fill the purpose/m);
  assert.equal(read("arc/features/cart.arc"), `// Notes for the agent: what the code does not say (why this exists, limits, plans). Edit or delete.
feature Cart {
  Cart arithmetic for the shop;
  source "src/cart.js";

  add(cart, line): { lines: [Any], total: Any } {
    Adds a line to the cart, returns (lines, total) as a new object;
  }

  empty(): { lines: [Any], total: Num } {}

  Till.open(): Bool {
    Opens the till;
  }

  Till.close(): Bool {}
}
`);

  // a TypeScript file: types, an optional parameter, no file doc
  r = oa(["pdl", "draft", "src/pricing.ts", "--json"]);
  assert.equal(r.code, 0, r.err);
  const j = JSON.parse(r.out) as { drafted: { file: string; feature: string; functions: number; ratio: number }[]; next: string };
  assert.deepEqual([j.drafted[0]!.file, j.drafted[0]!.feature, j.drafted[0]!.functions], ["arc/features/pricing.arc", "Pricing", 1]);
  assert.ok(j.drafted[0]!.ratio > 0 && j.drafted[0]!.ratio < 1);
  assert.match(j.next, /^next: /);
  assert.match(read("arc/features/pricing.arc"), /\n  describe what this is for;\n  source "src\/pricing\.ts";\n\n  total\(lines: \[Line\], discount\?: Num\): Num \{\n    The total of the lines, in cents;\n  \}\n\}\n$/);

  // a directory: per-block source, test files, node_modules and non-code files skipped; a language with no adapter
  r = oa(["pdl", "draft", "src/stock/", "tools/report.py"]);
  assert.equal(r.code, 0, r.err);
  assert.equal(read("arc/features/stock.arc"), `// Notes for the agent: what the code does not say (why this exists, limits, plans). Edit or delete.
feature Stock {
  describe what this is for;
  source "src/stock/";

  count(sku) {
    source "src/stock/count.js";
    Units on hand;
  }

  reserve(sku, n) {
    source "src/stock/reserve.js";
  }
}
`);
  assert.equal(read("arc/features/report.arc"), `// Notes for the agent: what the code does not say (why this exists, limits, plans). Edit or delete.
feature Report {
  describe what this is for;
  source "tools/report.py";

  // tools/report.py: no reader for this language yet; describe its operations here.
}
`);

  // --name
  r = oa(["pdl", "draft", "src/cart.js", "--name", "Basket"]);
  assert.equal(r.code, 0, r.err);
  assert.match(read("arc/features/basket.arc"), /^feature Basket \{$/m);
  rmSync(join(dir, "arc/features/basket.arc"));
  assert.equal(oa(["pdl", "draft", "src/cart.js", "src/pricing.ts", "--name", "Two"]).code, 2, "--name takes one argument");
  assert.equal(oa(["pdl", "draft"]).code, 2);

  // the result: no errors, stable under format, every block new
  r = oa(["pdl", "check"]);
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /^0 errors/m);
  assert.equal(oa(["pdl", "format", "--check"]).code, 0);
  const st = statuses();
  assert.ok(st.length === 11 && st.every((b) => b.status === "new"), JSON.stringify(st));
  assert.deepEqual(st.find((b) => b.id === "Cart.Till.open")!.source, ["src/cart.js"]);
  assert.deepEqual(st.find((b) => b.id === "Stock.count")!.source, ["src/stock/count.js"]);

  // refusals: the file exists, the feature exists elsewhere, a missing path, a test file, the root; nothing written
  const before = read("arc/features/cart.arc");
  r = oa(["pdl", "draft", "src/cart.js"]);
  assert.equal(r.code, 1);
  assert.match(r.err, /^arc\/features\/cart\.arc already exists/m);
  assert.equal(read("arc/features/cart.arc"), before);
  write("arc/features/misc.arc", "feature Shelf {\n  shelves;\n}\n");
  write("src/shelf.js", "export const put = () => 1;\n");
  r = oa(["pdl", "draft", "src/shelf.js", "src/pricing.ts", "--json"]);
  assert.equal(r.code, 1);
  const refused = (JSON.parse(r.out) as { refused: string[] }).refused;
  assert.ok(refused.includes("feature Shelf already exists in arc/features/misc.arc; edit it, or pass --name <Name>"), refused.join("\n"));
  assert.ok(!existsSync(join(dir, "arc/features/shelf.arc")));
  assert.match(oa(["pdl", "draft", "src/nope.js"]).err, /^src\/nope\.js: no such file or directory/m);
  assert.match(oa(["pdl", "draft", "src/cart.test.js"]).err, /^src\/cart\.test\.js: a test file/m);
  assert.match(oa(["pdl", "draft", "."]).err, /not the project itself/);

  // Go, when a toolchain is given
  const go = process.env.OPENARC_GO;
  if (go) {
    write("go.mod", "module example.com/shop\n\ngo 1.22\n");
    write("gosrc/calc.go", "// Package calc does sums; nothing else.\npackage calc\n\n// Add adds {a} and b.\nfunc Add(a int, b int) int { return a + b }\n\nfunc Sub(a, b int) int { return a - b }\n");
    r = oa(["pdl", "draft", "gosrc/calc.go"]);
    assert.equal(r.code, 0, r.out + r.err);
    assert.match(read("arc/features/calc.arc"), /\n  Package calc does sums, nothing else;\n  source "gosrc\/calc\.go";\n\n  Add\(a: Int, b: Int\): Int \{\n    Add adds \(a\) and b;\n  \}\n\n  Sub\(a: Int, b: Int\): Int \{\}\n\}\n$/);
    assert.equal(oa(["pdl", "check"]).code, 0);
  } else console.log("pdl-draft.check: Go part skipped (set OPENARC_GO to the go binary)");
  console.log("pdl-draft.check: ok");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
