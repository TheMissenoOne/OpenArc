// The `.arc` design language (src/pdl.ts) and `openarc pdl` (src/pdlsync.ts): byte-exact round trip on good and broken
// input, format idempotence, statement classification, lint, and the status cycle end to end on the real CLI in a temp
// project. No model. Run: node --no-warnings tests/pdl.check.ts
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { blocks, classify, clean, format, lint, parse, print, stmtsDeep } from "../src/pdl.ts";

const REF = `feature Checkout {
  a customer turns a cart into a paid order;
  the shop never charges for stock it does not have;

  source "src/checkout/", "src/pricing.js";
  uses inventory, pricing, payments;
  uses external stripe, postgres;

  assume {
    money is whole cents, never a float;
    Order has the usual create, read and list-by-customer operations;
  }

  state Order {
    initial cart;
    cart -> reserved : confirm() when every line is in stock;
    reserved -> paid : chargeOk() then email the receipt;
    reserved -> cart : chargeFailed() then release();
    reserved -> cart : after(15 min) then release();
    final paid;
  }

  rule noOversell() {
    stock never goes below zero;
    check all(s in stock, s.qty >= 0);
  }

  confirm(cart: Cart, card: Card): Order {
    source "src/checkout/confirm.js";
    if (a line cannot be reserved) {
      release the ones already reserved;
      fail "out of stock";
    }
    example confirm({lines: [{sku: "tea", qty: 2, price: 450}]}, visa) => {state: "paid", total: 900};
    example confirm(emptyCart, visa) throws "cart is empty";
  }

  applyCoupon() {
    the usual percentage coupon;
    one per order, never below zero, expired ones are refused;
  }

  release() { give the reserved units back; }

  screen CheckoutPage() {
    show the lines, the total, a coupon field and a Pay button;
    on pay.click -> confirm();
    on coupon.apply -> applyCoupon();
    visible when Order in (cart, reserved);
  }
}
`;
const roundTrip = (t: string) => assert.equal(print(parse(t)), t, JSON.stringify(t));
const texts = (t: string) => stmtsDeep(parse(t).items).map((s) => s.text);
const comments = (t: string) => (t.match(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g) ?? []).map((c) => c.trim());

// ── round trip and format ──
roundTrip(REF);
assert.deepEqual(parse(REF).diagnostics, []);
const ODD = `// top comment
feature   Odd{ /* after the brace */
   a sentence   with  "two  spaces" inside;  // trailing
uses a ,b;


   first(x:Num,y) :Num{ step one ; /* inline */ step
      two;
     if(x > 0){ say yes; }   else  if ( x < 0 ) { say no; } else { say zero; }
     for each (line in lines) { count it; }
     while (more) { go on; }
   }
   assume{}
   rule r { check x >= 0; }  // after a block
   a sentence // note
     continued;
}
/* trailing
   block */
`;
roundTrip(ODD);
assert.deepEqual(parse(ODD).diagnostics, []);
for (const t of [REF, ODD]) {
  const f = format(t);
  assert.equal(format(f), f, "format is idempotent");
  roundTrip(f);
  assert.deepEqual(texts(f), texts(t), "format leaves statement content alone");
  assert.deepEqual(comments(f), comments(t), "format keeps every comment");
}
assert.ok(format(REF).includes("  release() {\n    give the reserved units back;\n  }\n"));
assert.ok(format(ODD).includes("    if(x > 0) {\n      say yes;\n    } else if ( x < 0 ) {\n      say no;\n    } else {\n      say zero;\n    }\n"), format(ODD));
assert.ok(format(ODD).includes(`a sentence with "two  spaces" inside; // trailing`), "a string keeps its spaces; a trailing comment stays on its line");
assert.ok(format(ODD).includes("  a sentence // note\n    continued;"), "a line comment inside a statement keeps its line break");
assert.ok(format(ODD).includes("  assume {}\n"));
assert.ok(format(ODD).startsWith("// top comment\nfeature Odd { /* after the brace */\n"));
assert.equal(format("feature F {\n  x;\n  // doc\n  g() { y; }\n}\n"), "feature F {\n  x;\n\n  // doc\n  g() {\n    y;\n  }\n}\n", "a comment right above a block stays with it");
assert.equal(format(""), "");
assert.equal(format("// only\n"), "// only\n");

// ── broken input: never throws, round trips, structural diagnostics with lines ──
const broken: [string, string, number[]][] = [
  ["unbalanced: missing }", "feature A {\n  x;\n  f() {\n    y;\n}\n", [1]],
  ["unbalanced: extra }", "feature A {\n  x;\n}\n}\n", [4]],
  ["unterminated string", 'feature A {\n  fail "oops;\n  y;\n}\n', [2]],
  ["missing ; before }", "feature A {\n  x;\n  y\n}\n", [3]],
  ["missing ; at the end", "x", [1]],
  ["unterminated block comment", "feature A { x; /* never\n}\n", [1, 1]],
  ["empty file", "", []],
  ["only comments", "// one\n/* two */\n  // three", []],
  ["nested unknown blocks", "whatever this is {\n  more of it {\n    and { deeper; }\n  }\n}\n", []],
  ["stray characters", ";;; } { ( [ \"", [1, 1, 1, 1]],
];
for (const [name, text, lines] of broken) {
  const t = parse(text);
  assert.equal(print(t), text, name);
  assert.deepEqual(t.diagnostics.map((d) => d.line), lines, `${name}: ${JSON.stringify(t.diagnostics)}`);
  assert.equal(format(format(text)), format(text), name);
}
assert.equal(format("feature A {\n  y\n}\n"), "feature A {\n  y\n}\n", "a file with structural problems is left as it is");
const missing = stmtsDeep(parse("feature A {\n  x;\n  y\n}\n").items).at(-1)!;
assert.deepEqual([missing.kind, missing.text, missing.terminated], ["sentence", "y", false]);
assert.deepEqual(blocks(parse(broken[8]![1])).length, 0, "unknown blocks have no id");
assert.equal((parse(broken[8]![1]).items[0] as { kind: string }).kind, "unknown");

// ── blocks ──
assert.deepEqual(blocks(parse(REF)).map((b) => [b.id, b.kind, b.line]), [
  ["Checkout", "feature", 1], ["Checkout.assume", "assume", 9], ["Checkout.Order", "state", 14], ["Checkout.noOversell", "rule", 23],
  ["Checkout.confirm", "function", 28], ["Checkout.applyCoupon", "function", 38], ["Checkout.release", "function", 43], ["Checkout.CheckoutPage", "screen", 45],
]);
const confirmBlock = blocks(parse(REF)).find((b) => b.id === "Checkout.confirm")!.node;
assert.deepEqual([confirmBlock.params, confirmBlock.paramList, confirmBlock.type], ["cart: Cart, card: Card", [{ name: "cart", type: "Cart" }, { name: "card", type: "Card" }], "Order"]);
assert.deepEqual(blocks(parse("feature F { g() { x; } h(a, b: [Int]) { y; } }")).map((b) => [b.id, b.node.paramList, b.node.type]), [["F", undefined, undefined], ["F.g", [], undefined], ["F.h", [{ name: "a" }, { name: "b", type: "[Int]" }], undefined]]);
assert.deepEqual(blocks(parse("feature F { Cart.add(n: Num): Num {} }")).map((b) => [b.id, b.kind, b.node.name]), [["F", "feature", "F"], ["F.Cart.add", "function", "Cart.add"]], "a method keeps its class in its name");

// ── classification: exact forms, and sentences that only start like one ──
const k = (text: string, parent: Parameters<typeof classify>[1] = "function") => classify(text, parent);
assert.deepEqual(k("uses a, b"), { kind: "uses", names: ["a", "b"] });
assert.deepEqual(k("uses external stripe, @scope/pkg"), { kind: "uses", names: ["stripe", "@scope/pkg"], external: true });
assert.equal(k("uses of the coupon are counted").kind, "sentence");
assert.deepEqual(k('source "a.js", "dir/"'), { kind: "source", paths: ["a.js", "dir/"] });
assert.equal(k("source of truth is the ledger").kind, "sentence");
assert.deepEqual(k("example f(1, {a: [2]}) => {b: 3}"), { kind: "example", call: "f(1, {a: [2]})", value: "{b: 3}" });
assert.deepEqual(k('example f(null) throws "bad input"'), { kind: "example", call: "f(null)", throws: "bad input" });
assert.equal(k("example of a refund is a partial one").kind, "sentence");
assert.equal(k("example f(1) is fine").kind, "sentence");
assert.deepEqual(k("check all(s in stock, s.qty >= 0)"), { kind: "check", expr: "all(s in stock, s.qty >= 0)" });
assert.deepEqual(k("check total == sum(lines)"), { kind: "check", expr: "total == sum(lines)" });
assert.equal(k("check the totals daily").kind, "sentence");
assert.deepEqual(k('fail "out of stock"'), { kind: "fail", message: "out of stock" });
assert.equal(k("fail loudly when the card is refused").kind, "sentence");
assert.deepEqual(k("initial cart", "state"), { kind: "initial", names: ["cart"] });
assert.equal(k("initial cart", "function").kind, "sentence", "initial counts only inside state");
assert.equal(k("initial setup takes a minute", "state").kind, "sentence");
assert.deepEqual(k("final paid, cancelled", "state"), { kind: "final", names: ["paid", "cancelled"] });
assert.deepEqual(k("a -> b : go() when x(1) then y()", "state"), { kind: "transition", from: "a", to: "b", trigger: "go()", when: "x(1)", then: "y()", calls: ["go", "x", "y"] });
assert.deepEqual(k("a -> b : after(15 min) then tell them (when it then fails)", "state"), { kind: "transition", from: "a", to: "b", trigger: "after(15 min)", then: "tell them (when it then fails)", calls: ["after"] });
assert.equal(k("a -> b : go()", "function").kind, "sentence");
assert.deepEqual(k("on pay.click -> confirm()", "screen"), { kind: "on", event: "pay.click", call: "confirm()", calls: ["confirm"] });
assert.equal(k("on pay.click -> nothing happens", "screen").kind, "sentence");
assert.equal(k("on a slow day the page waits", "screen").kind, "sentence");
assert.deepEqual(k("visible when Order in (cart, reserved)", "screen"), { kind: "visible", machine: "Order", names: ["cart", "reserved"] });
assert.equal(k("visible when the user is signed in", "screen").kind, "sentence");
assert.equal(k("Uses a, b").kind, "sentence", "keywords are case-sensitive");
// classification runs on the statement without comments and extra whitespace
const st = stmtsDeep(parse('feature F { g() { uses /* c */ a ,\n  b; } }').items)[0]!;
assert.deepEqual([st.kind, st.names, st.text], ["uses", ["a", "b"], "uses a , b"]);
assert.equal(clean('a  /* x */ "s  t"   b // y'), 'a "s  t" b');
// an object literal is not a block: after =>, =, :, ',' or inside an example
assert.equal(blocks(parse("feature F { g() { x => { a: 1 }; y = { b }; } }")).length, 2);

// ── lint ──
const findings = (files: Record<string, string>) => lint(Object.entries(files).map(([file, t]) => ({ file, tree: parse(t) })));
assert.deepEqual(findings({ "a.arc": REF }).map((f) => [f.level, f.line, f.text.split(": ").slice(1).join(": ")]), [
  ["note", 17, "Checkout.Order: chargeOk() has no function block in feature Checkout; add one, or say in assume what it does."],
  ["note", 18, "Checkout.Order: chargeFailed() has no function block in feature Checkout; add one, or say in assume what it does."],
]);
const errs = (files: Record<string, string>) => findings(files).filter((f) => f.level === "error").map((f) => f.text);
assert.deepEqual(errs({ "a.arc": "feature A { f() { x; } }", "b.arc": "feature A {\n  f() { y; }\n}" }), [
  "b.arc:1: the block id A is already used at a.arc:1; rename one of the two blocks.",
  "b.arc:2: the block id A.f is already used at a.arc:1; rename one of the two blocks.",
]);
const machine = (body: string, screen = "") => `feature M {\n  state S {\n${body}\n  }\n${screen}}\n`;
assert.deepEqual(errs({ "m.arc": machine("    initial a;\n    initial b;\n    a -> b : go();") }), ["m.arc:4: M.S: a second `initial` (b); a machine starts in one state, keep one `initial` line."]);
assert.deepEqual(errs({ "m.arc": machine("    initial a;\n    a -> b : go();\n    b -> a : back();\n    final b;") }), ["m.arc:5: M.S: b is final but has a transition to a; remove the transition or the state from `final`."]);
assert.deepEqual(errs({ "m.arc": machine("    initial a;\n    a -> b : go();\n    bb -> a : back();") }), ["m.arc:5: M.S: bb cannot be reached from the initial state a; add a transition into it, or fix the name if it is a typo."]);
assert.deepEqual(errs({ "m.arc": machine("    a -> b : go();\n    c -> a : back();") }), [], "no initial: reachability is not checked");
assert.deepEqual(errs({ "m.arc": machine("    initial a;\n    a -> b : go();", "  screen P {\n    visible when S in (a, c);\n    visible when T in (a);\n  }\n") }), [
  "m.arc:7: M.P: `visible when` names the state c, which machine S never mentions; use one of a, b, or add c to the machine.",
  "m.arc:8: M.P: `visible when` names T, but feature M has no `state T` block; add it or fix the name.",
]);
assert.deepEqual(findings({ "m.arc": machine("    initial a;\n    a -> b : go() then tidy();\n    b -> a : after(1 h);", "  go() { x; }\n  screen P { on b.click -> press(); }\n") }).map((f) => [f.level, f.text.split(": ")[2]]), [
  ["note", "tidy() has no function block in feature M; add one, or say in assume what it does."],
  ["note", "press() has no function block in feature M; add one, or say in assume what it does."],
]);

// ── the CLI, in a real project ──
if (process.platform === "win32") { console.log("pdl.check: CLI part skipped on Windows"); process.exit(0); }
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
type Row = { id: string; status: string; linked: boolean; source: string[]; missing?: string[]; designSize: number; codeSize?: number; ratio?: number };
const status = async () => {
  const r = await oa(["pdl", "status", "--json"]);
  assert.equal(r.code, 0, r.out + r.err);
  const j = JSON.parse(r.out) as { summary: Record<string, number>; blocks: Row[] };
  return { ...j, of: (id: string) => j.blocks.find((b) => b.id === id)! };
};
const statuses = async () => Object.fromEntries((await status()).blocks.map((b) => [b.id, b.status]));
const ARC = "arc/features/shop/checkout.arc";

dir = mkdtempSync(join(resolve(".."), ".pdl-check-"));
try {
  write("package.json", '{"name":"shop","version":"1.0.0","private":true,"type":"module"}');
  write(ARC, REF);
  write("src/checkout/confirm.js", "export function confirm(cart, card) {\n  return reserve(cart) && charge(cart.total, card);\n}\n");
  write("src/checkout/cart.js", "export const lines = (cart) => cart.lines;\n");
  write("src/checkout/node_modules/skip.js", "skipped\n");
  write("src/pricing.js", "export const total = (lines) => lines.reduce((n, l) => n + l.qty * l.price, 0);\n");
  write("arc/features/notes.arc", "feature Notes {\n  a feature with no code yet;\n}\n");

  let s = await status();
  assert.ok(s.blocks.every((b) => b.status === "new"));
  assert.equal(s.blocks.length, 9);
  assert.deepEqual(s.of("Checkout.confirm").source, ["src/checkout/confirm.js"], "a block's own source wins");
  assert.deepEqual(s.of("Checkout.applyCoupon").source, ["src/checkout/", "src/pricing.js"], "else its feature's");
  assert.equal(s.of("Notes").linked, false);
  // sizes: non-space characters, comments excluded from the design; the code side only where linked
  const conf = s.of("Checkout.confirm"), codeChars = read("src/checkout/confirm.js").replace(/\s/g, "").length;
  assert.equal(conf.codeSize, codeChars);
  assert.equal(conf.ratio, conf.designSize / codeChars);
  assert.equal(s.of("Notes").designSize, "featureNotes{afeaturewithnocodeyet;}".length);
  assert.ok(!("codeSize" in s.of("Notes")) && !("ratio" in s.of("Notes")));
  const allCode = ["src/checkout/confirm.js", "src/checkout/cart.js", "src/pricing.js"].reduce((n, f) => n + read(f).replace(/\s/g, "").length, 0);
  assert.equal(s.of("Checkout").codeSize, allCode, "a feature's row: every source its blocks name, node_modules skipped");
  assert.equal(s.summary.ratio, s.of("Checkout").designSize / allCode);
  let r = await oa(["pdl", "status"]);
  assert.equal(r.code, 0);
  assert.match(r.out, /^Notes: new, not linked$/m);
  assert.match(r.out, new RegExp(`^Checkout\\.confirm: new, design ${Math.round(conf.ratio! * 100)}% of code$`, "m"));
  assert.match(r.out, /^9 blocks: new 9, in step 0, design ahead 0, code ahead 0, both changed 0, not linked 1; design \d+% of code$/m);
  r = await oa(["pdl", "status", "Checkout", "--json"]);
  assert.equal((JSON.parse(r.out) as { blocks: Row[] }).blocks.length, 8, "a feature filter: its blocks");
  r = await oa(["pdl", "status", "Nope"]);
  assert.equal(r.code, 0, "status is a report");

  // check: notes only (two calls, and the feature's size) exit 0
  r = await oa(["pdl", "check", "--json"]);
  assert.equal(r.code, 0, r.out + r.err);
  assert.ok((JSON.parse(r.out) as { findings: { level: string }[] }).findings.every((f) => f.level === "note"));

  // sync, then in step
  r = await oa(["pdl", "sync", "--all"]);
  assert.equal(r.code, 0, r.out + r.err);
  assert.ok(Object.values(await statuses()).every((x) => x === "in step"));

  // the design moves ahead
  write(ARC, read(ARC).replace("the usual percentage coupon;", "the usual percentage coupon, rounded down;"));
  let st = await statuses();
  assert.equal(st["Checkout.applyCoupon"], "design ahead");
  assert.equal(st["Checkout.confirm"], "in step");
  assert.equal(st["Checkout"], "in step", "a feature's hash covers its own statements, not its blocks");
  // then the code moves too
  write("src/pricing.js", read("src/pricing.js") + "export const coupon = (t, p) => Math.floor(t * (100 - p) / 100);\n");
  st = await statuses();
  assert.equal(st["Checkout.applyCoupon"], "both changed");
  assert.equal(st["Checkout.Order"], "code ahead");
  assert.equal(st["Checkout.confirm"], "in step", "a block-level source narrows the code side: pricing.js is not confirm's");
  // syncing a feature syncs only its own entry
  r = await oa(["pdl", "sync", "Checkout", "Checkout.applyCoupon"]);
  assert.equal(r.code, 0, r.err);
  st = await statuses();
  assert.deepEqual([st["Checkout"], st["Checkout.applyCoupon"], st["Checkout.Order"]], ["in step", "in step", "code ahead"]);
  r = await oa(["pdl", "sync", "--all"]);
  assert.equal(r.code, 0);

  // reformatting is not a change
  r = await oa(["pdl", "format", "--check"]);
  assert.equal(r.code, 1);
  assert.match(r.out, /arc\/features\/shop\/checkout\.arc: not in canonical layout/);
  const before = read(ARC);
  r = await oa(["pdl", "format"]);
  assert.equal(r.code, 0, r.err);
  assert.notEqual(read(ARC), before);
  assert.equal(read(ARC), format(before));
  assert.ok(Object.values(await statuses()).every((x) => x === "in step"));
  assert.equal((await oa(["pdl", "format", "--check"])).code, 0);

  // a file in a directory source
  write("src/checkout/cart.js", "export const lines = (cart) => cart.lines.filter(Boolean);\n");
  st = await statuses();
  assert.deepEqual([st["Checkout.release"], st["Checkout"], st["Checkout.confirm"]], ["code ahead", "code ahead", "in step"]);
  write("src/checkout/node_modules/skip.js", "changed, still skipped\n");
  write("src/checkout/confirm.js", read("src/checkout/confirm.js") + "// edited\n");
  st = await statuses();
  assert.equal(st["Checkout.confirm"], "code ahead");
  r = await oa(["pdl", "sync", "--all"]);
  assert.equal(r.code, 0);

  // a missing source, and the size note at the threshold
  write(ARC, read(ARC).replace(/\n}\n$/, `\n\n  ghost() {\n    source "src/nope.js";\n    haunts;\n  }\n\n  tiny() {\n    source "src/tiny.js";\n    adds the two numbers;\n  }\n}\n`));
  s = await status();
  assert.deepEqual([s.of("Checkout.ghost").status, s.of("Checkout.ghost").linked, s.of("Checkout.ghost").missing], ["new", true, ["src/nope.js"]]);
  assert.ok(!("codeSize" in s.of("Checkout.ghost")));
  r = await oa(["pdl", "status"]);
  assert.match(r.out, /^Checkout\.ghost: new, missing src\/nope\.js$/m);
  const tinyDesign = s.of("Checkout.tiny").designSize;
  const tinyNote = async () => ((JSON.parse((await oa(["pdl", "check", "--json"])).out) as { findings: { id?: string; text: string }[] }).findings.find((f) => f.id === "Checkout.tiny"));
  write("src/tiny.js", "x".repeat(tinyDesign * 2)); // exactly 0.5: no note
  assert.equal((await status()).of("Checkout.tiny").ratio, 0.5);
  assert.equal(await tinyNote(), undefined);
  write("src/tiny.js", "x".repeat(tinyDesign * 2 - 2)); // above 0.5
  const note = await tinyNote();
  assert.ok(note, "a note above the threshold");
  assert.match(note!.text, new RegExp(`Checkout\\.tiny: the design is ${Math.round((tinyDesign / (tinyDesign * 2 - 2)) * 100)}% of its code \\(${tinyDesign} of ${tinyDesign * 2 - 2} non-space characters\\); drop the steps a reader would assume, or move them to \`assume\`\\.`));
  r = await oa(["pdl", "check"]);
  assert.equal(r.code, 0, "notes never fail check");
  const feat = (await status()).of("Checkout");
  const featNote = (JSON.parse((await oa(["pdl", "check", "--json"])).out) as { findings: { id?: string; text: string }[] }).findings.find((f) => f.id === "Checkout");
  assert.equal(!!featNote, feat.ratio! > 0.5, "the same note for a feature as a whole");

  // show: the block, its feature's purpose, assume and uses, the sources and the status, nothing else
  r = await oa(["pdl", "show", "Checkout.confirm", "--json"]);
  assert.equal(r.code, 0, r.err);
  const show = JSON.parse(r.out) as Record<string, unknown>;
  assert.deepEqual(Object.keys(show).sort(), ["assume", "codeSize", "designSize", "external", "file", "id", "kind", "line", "linked", "purpose", "ratio", "source", "status", "text", "uses"]);
  assert.ok((show.text as string).startsWith("confirm(cart: Cart, card: Card): Order {") && (show.text as string).endsWith("}"));
  assert.ok(!(show.text as string).includes("applyCoupon"));
  assert.deepEqual(show.purpose, ["a customer turns a cart into a paid order", "the shop never charges for stock it does not have"]);
  assert.match(show.assume as string, /^assume \{\n {4}money is whole cents/);
  assert.deepEqual([show.uses, show.external, show.source, show.status], [["inventory", "pricing", "payments"], ["stripe", "postgres"], ["src/checkout/confirm.js"], "in step"]);
  assert.equal(show.ratio, (show.designSize as number) / (show.codeSize as number));
  r = await oa(["pdl", "show", "Checkout"]);
  assert.match(r.out, /^blocks: Checkout\.assume, Checkout\.Order, /m);
  assert.ok(!r.out.includes("reserve"), "a feature's show does not repeat its blocks");
  assert.equal((await oa(["pdl", "show", "Checkout.nope"])).code, 1);
  assert.equal((await oa(["pdl", "show"])).code, 2);
  assert.equal((await oa(["pdl", "sync"])).code, 2);
  assert.equal((await oa(["pdl", "status", "--bogus"])).code, 2);

  // sync refuses when the block's file has an error, and writes nothing; other files still sync
  write(ARC, read(ARC).replace("visible when Order in (cart, reserved);", "visible when Order in (cart, shipped);"));
  const state = read(".openarc/pdl.json");
  r = await oa(["pdl", "check"]);
  assert.equal(r.code, 1);
  assert.match(r.out, /error: arc\/features\/shop\/checkout\.arc:\d+: Checkout\.CheckoutPage: `visible when` names the state shipped/);
  r = await oa(["pdl", "sync", "Checkout.confirm"]);
  assert.equal(r.code, 1);
  assert.match(r.err, /names the state shipped[\s\S]*nothing was synced/);
  assert.equal(read(".openarc/pdl.json"), state);
  assert.equal((await oa(["pdl", "sync", "--all"])).code, 1);
  assert.equal(read(".openarc/pdl.json"), state);
  assert.equal((await oa(["pdl", "sync", "Notes.nope"])).code, 1);
  write("arc/features/notes.arc", "feature Notes {\n  a feature with no code yet, still;\n}\n");
  r = await oa(["pdl", "sync", "Notes"]);
  assert.equal(r.code, 0, r.err);
  assert.equal((await statuses())["Notes"], "in step");

  // a removed block drops out of the state on the next sync --all
  write(ARC, read(ARC).replace("shipped", "reserved").replace(/\n {2}ghost\(\) \{[^}]*\}\n/, "\n"));
  r = await oa(["pdl", "sync", "--all"]);
  assert.equal(r.code, 0, r.err);
  assert.ok(!("Checkout.ghost" in (JSON.parse(read(".openarc/pdl.json")) as { blocks: object }).blocks));

  // a broken file is reported by format and check, and status still reads it
  write("arc/features/broken.arc", "feature Broken {\n  x\n");
  r = await oa(["pdl", "format"]);
  assert.equal(r.code, 1);
  assert.match(r.err, /broken\.arc: not formatted, it has structural problems/);
  assert.equal((await oa(["pdl", "check"])).code, 1);
  assert.equal((await statuses())["Broken"], "new");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log("pdl.check: ok");
