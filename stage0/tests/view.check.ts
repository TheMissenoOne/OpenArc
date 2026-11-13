// `openarc view` (src/view.ts): the pure render and reducer, the key decoder, the child-process plumbing with a fake
// spawn (no model, no real compile), and `view --once` end to end on a plain JavaScript project with one ok and one
// stale function. Run: node --no-warnings tests/view.check.ts
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { applyRows, initState, jobArgv, keysOf, loadModules, markBusy, reduce, render, rows, runJob, useColor, visible, fit, type State } from "../src/view.ts";

const ARC = `module calc from "src/calc.js"
  "Small arithmetic, 小さな計算, café."

fn double(n: Num): Num
  "Doubles a number: 二倍にする."
  example (3) => 6

fn triple(n: Num): Num
  "Triples a number."
  example (3) => 9
  example (0) => 0
  observed (3) => 6
  rule positive: result >= 0

fn hello(n: Any): Any
`;
const ESC = "\x1b";

// ── width ──
assert.equal(visible("日本"), 4);
assert.equal(visible("é"), 1); // a combining accent takes no cell
assert.equal(visible(`${ESC}[31mstale${ESC}[0m`), 5);
assert.equal(visible(fit("日本語", 5)), 5); // a wide character that would straddle the edge is dropped, the cell padded
assert.equal(fit(`${ESC}[31mabcdef${ESC}[0m`, 3), `${ESC}[31mabc${ESC}[0m`);

// ── model ──
let s: State = initState(loadModules([{ path: "arc/spec/calc.arc", text: ARC }]), false);
const [mod] = s.mods;
assert.equal(mod!.name, "calc");
assert.deepEqual(mod!.fns.map((f) => [f.id, f.line, f.text.length]), [["calc.double", 4, 3], ["calc.triple", 8, 6], ["calc.hello", 15, 1]]);
assert.equal(mod!.fns[1]!.text[5], "  rule positive: result >= 0");
s = applyRows(markBusy(s, ""), "", [
  { id: "calc.double", file: "src/calc.js", status: "ok" },
  { id: "calc.triple", file: "src/calc.js", status: "stale", failing: [{ example: "example (3) => 9", got: "6" }, { example: "rule positive", got: "broken by (-1) -> -2" }] },
  { id: "calc.hello", file: "src/calc.js", status: "no examples" },
]);
assert.ok(s.mods[0]!.fns.every((f) => !f.busy));
// reloading keeps what a check found
assert.equal(loadModules([{ path: "arc/spec/calc.arc", text: ARC }], s.mods)[0]!.fns[1]!.status, "stale");
// a file that does not parse is a module row with the error
const bad = loadModules([{ path: "arc/spec/bad.arc", text: "fn x(" }])[0]!;
assert.ok(bad.error && !bad.fns.length);

// ── render: every line exactly the width, wide and narrow, colour or not ──
s = { ...s, sel: "calc.triple" };
for (const color of [false, true])
  for (const [w, h] of [[100, 20], [50, 30], [120, Infinity], [40, Infinity]] as const) {
    const lines = render({ ...s, color }, w, h);
    if (Number.isFinite(h)) assert.equal(lines.length, h);
    for (const l of lines) assert.equal(visible(l), w, `${w}x${h}: ${JSON.stringify(l)}`);
    assert.equal(lines.some((l) => l.includes(ESC)), color, "colour codes only when colour is on");
  }
const plain = render(s, 100).map((l) => l.trimEnd());
assert.equal(plain[0], "ok 1  stale 1  unrunnable 0  no examples 1");
assert.ok(plain.some((l) => /^>\s+triple\s+stale│/.test(l)), plain.join("\n"));
assert.ok(plain.some((l) => /^\s+double\s+ok│/.test(l)));
assert.ok(plain.some((l) => l.endsWith("│ !   example (3) => 9")), "the failing example is marked");
assert.ok(plain.some((l) => l.endsWith("example (3) => 9: the code returns 6")), "and followed by what the code returned");
assert.ok(plain.some((l) => l.endsWith("!   rule positive: result >= 0")) && plain.some((l) => l.endsWith("rule positive: broken by (-1) -> -2")));
assert.ok(!plain.some((l) => l.includes("! example (0)")), "a passing example is not marked");
const narrow = render(s, 50, 30).map((l) => l.trimEnd());
assert.ok(narrow.some((l) => /^─+$/.test(l)), "narrow: the spec below the list");
assert.ok(narrow.at(-1)!.startsWith("/ filter"));
// NO_COLOR and non-TTY output turn colour off
assert.equal(useColor({ NO_COLOR: "1" }, true), false);
assert.equal(useColor({}, false), false);
assert.equal(useColor({ NO_COLOR: "" }, true), true);

// ── reducer: every key ──
const key = (st: State, ...ks: string[]) => ks.reduce(reduce, st);
let k = { ...s, sel: "arc/spec/calc.arc" };
assert.equal(key(k, "down").sel, "calc.double");
assert.equal(key(k, "j", "j").sel, "calc.triple");
assert.equal(key(k, "j", "j", "k").sel, "calc.double");
assert.equal(key(k, "up").sel, "arc/spec/calc.arc", "the top stays the top");
assert.equal(key(k, "j", "j", "j", "j", "j").sel, "calc.hello", "the bottom stays the bottom");
assert.equal(key(k, "enter").mods[0]!.open, false, "enter closes an open module");
assert.equal(rows(key(k, "enter")).length, 1);
assert.equal(key(k, "enter", "enter").mods[0]!.open, true);
assert.equal(key(k, "left").mods[0]!.open, false);
assert.equal(key(k, "left", "right").mods[0]!.open, true);
assert.equal(key(k, "j", "j", "left").sel, "arc/spec/calc.arc", "left from a function goes to its module");
assert.equal(key(k, "j", "right").sel, "calc.double", "right on a function keeps it selected");
assert.equal(key(k, "?").help, true);
assert.equal(key(k, "?", "j").help, false, "any key closes the help");
assert.equal(key(k, "?", "j").sel, k.sel, "and does nothing else");
assert.equal(key(k, "q").quit, true);
assert.equal(key(k, "ctrl-c").quit, true);
assert.equal(key(k, "/", "ctrl-c").quit, true);
// filter
let f = key(k, "/", "t", "r", "x", "backspace");
assert.equal(f.typing, true);
assert.equal(f.filter, "tr");
assert.deepEqual(rows(f).map((r) => r.key), ["arc/spec/calc.arc", "calc.triple"]);
assert.equal(key(f, "q").filter, "trq", "while typing, letters go to the filter");
f = key(f, "enter");
assert.equal(f.typing, false);
assert.equal(f.filter, "tr", "enter keeps the filter");
assert.equal(key(f, "j").sel, "calc.triple");
assert.equal(key(f, "esc").filter, "");
assert.equal(key(k, "/", "x", "esc").filter, "", "esc while typing clears it");
assert.deepEqual(rows(key(k, "enter", "/", ..."CALC")).length, 4, "a module name matches all its functions, case-insensitively");
assert.deepEqual(rows(key(k, "/", ..."zzz")), []);
assert.ok(render(key(k, "/", ..."zzz"), 100).some((l) => l.includes("nothing matches /zzz")));
assert.equal(key(k, "enter", "/", ..."dou").mods[0]!.open, false);
assert.deepEqual(rows(key(k, "enter", "/", ..."dou")).map((r) => r.key), ["arc/spec/calc.arc", "calc.double"], "a filter shows the functions of a closed module");
// r, R: a check, and the functions it covers show `checking`
let r = key(k, "j", "j", "r");
assert.deepEqual(r.want, [{ kind: "check", target: "calc.triple" }]);
assert.deepEqual(r.mods[0]!.fns.map((x) => !!x.busy), [false, true, false]);
assert.ok(render(r, 100)[0]!.trimEnd().endsWith("checking 1"));
assert.deepEqual(key(k, "r").want, [{ kind: "check", target: "calc" }], "r on a module checks the module");
r = key(k, "R");
assert.deepEqual(r.want, [{ kind: "check", target: "" }]);
assert.ok(r.mods[0]!.fns.every((x) => x.busy));
// c: only a stale function
assert.deepEqual(key(k, "j", "j", "c").want, [{ kind: "compile", id: "calc.triple" }]);
assert.deepEqual(key(k, "j", "c").want, []);
assert.match(key(k, "j", "c").log.at(-1)!, /calc.double is ok; only a stale function is compiled/);
assert.match(key(k, "c").log.at(-1)!, /select a function/);
// e: the file at the function's line
assert.deepEqual(key(k, "j", "j", "e").want, [{ kind: "edit", path: "arc/spec/calc.arc", line: 8 }]);
assert.deepEqual(key(k, "e").want, [{ kind: "edit", path: "arc/spec/calc.arc", line: 1 }]);
assert.equal(key(k, "x"), k, "an unbound key changes nothing");

// ── raw input to keys ──
assert.deepEqual(keysOf(`${ESC}[A${ESC}[B${ESC}OC${ESC}[Dj\r\x7f\x03${ESC}${ESC}[5~/é`), ["up", "down", "right", "left", "j", "enter", "backspace", "ctrl-c", "esc", "", "/", "é"]);

// ── child processes: the compile key runs `openarc arc compile`, the check `arc status --json`; spawn is faked ──
const cli = ["/usr/bin/node", "--no-warnings", "/x/src/main.ts"];
assert.deepEqual(jobArgv(cli, "arc/spec", { kind: "compile", id: "calc.triple" }), [...cli, "arc", "compile", "calc.triple", "--out=arc/spec"]);
assert.deepEqual(jobArgv(cli, "specs", { kind: "check", target: "calc" }), [...cli, "arc", "status", "calc", "--json", "--out=specs"]);
assert.deepEqual(jobArgv(cli, "arc/spec", { kind: "check", target: "" }), [...cli, "arc", "status", "--json", "--out=arc/spec"]);
{
  const calls: unknown[][] = [];
  const fake = (cmd: string, args: string[], opts: unknown) => {
    calls.push([cmd, args, opts]);
    const kid = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), kill: () => true });
    Object.assign(kid.stdout, { setEncoding() {} });
    Object.assign(kid.stderr, { setEncoding() {} });
    setImmediate(() => {
      kid.stdout.emit("data", "compiled calc.tri");
      kid.stdout.emit("data", "ple (attempt 1)\nlast line");
      kid.stderr.emit("data", "warn\n");
      kid.stdout.emit("end");
      kid.stderr.emit("end");
      kid.emit("close", 0);
    });
    return kid;
  };
  const lines: [string, boolean][] = [];
  const code = await new Promise<number | null>((done) => runJob(fake as never, jobArgv(cli, "arc/spec", { kind: "compile", id: "calc.triple" }), "/proj", (l, err) => lines.push([l, err]), done));
  assert.equal(code, 0);
  assert.deepEqual(calls[0]!.slice(0, 2), ["/usr/bin/node", ["--no-warnings", "/x/src/main.ts", "arc", "compile", "calc.triple", "--out=arc/spec"]]);
  assert.equal((calls[0]![2] as { cwd: string }).cwd, "/proj");
  assert.deepEqual(lines, [["compiled calc.triple (attempt 1)", false], ["warn", true], ["last line", false]]);
}

// ── `view --once` on the real CLI ──
if (process.platform !== "win32") {
  const MAIN = resolve("src/main.ts");
  const dir = mkdtempSync(join(resolve(".."), ".view-check-"));
  const write = (fl: string, t: string) => (mkdirSync(dirname(join(dir, fl)), { recursive: true }), writeFileSync(join(dir, fl), t));
  const oa = (args: string[], env: NodeJS.ProcessEnv = {}) => new Promise<{ code: number | null; out: string; err: string }>((done) => {
    const c = spawn(process.execPath, ["--no-warnings", MAIN, ...args], { cwd: dir, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    c.stdout.on("data", (b) => (out += b));
    c.stderr.on("data", (b) => (err += b));
    c.on("close", (code) => done({ code, out, err }));
  });
  try {
    write("package.json", '{"name":"plain","version":"1.0.0","private":true,"type":"module"}');
    write("src/calc.js", "export const double = (n) => n * 2;\nexport function triple(n) {\n  return n * 2;\n}\n");
    write("arc/spec/calc.arc", 'module calc from "src/calc.js"\n\nfn double(n: Num): Num\n  example (3) => 6\n\nfn triple(n: Num): Num\n  "Triples."\n  example (3) => 9\n');
    let res = await oa(["view", "--once", "--width", "90"], { NO_COLOR: "1" });
    assert.equal(res.code, 1, res.out + res.err);
    const lines = res.out.trimEnd().split("\n");
    assert.equal(lines[0], "ok 1  stale 1  unrunnable 0  no examples 0");
    assert.ok(lines.every((l) => visible(l) <= 90));
    assert.ok(!res.out.includes(ESC));
    assert.match(res.out, /^ {2}- calc\s+stale│ +calc\.triple {2}stale {2}arc\/spec\/calc\.arc:6$/m);
    assert.match(res.out, /^>\s+triple\s+stale│/m, "the first stale function is selected");
    assert.match(res.out, /^\s+double\s+ok│/m);
    assert.match(res.out, /│ ! {3}example \(3\) => 9\n.*│ {5}example \(3\) => 9: the code returns 6$/m);
    // stdout not a TTY: the same frame without --once; narrow puts the spec below
    res = await oa(["view", "calc", "--width", "40"]);
    assert.equal(res.code, 1);
    assert.ok(res.out.split("\n").every((l) => visible(l) <= 40));
    assert.match(res.out, /^─{40}$/m);
    write("src/calc.js", "export const double = (n) => n * 2;\nexport function triple(n) {\n  return n * 3;\n}\n");
    res = await oa(["view", "--once"]);
    assert.equal(res.code, 0, res.out + res.err);
    assert.match(res.out, /^ok 2 {2}stale 0/);
    res = await oa(["view", "--once", "nope"]);
    assert.equal(res.code, 1);
    assert.match(res.err, /no module nope in arc\/spec/);
    assert.equal((await oa(["view", "--width", "x"])).code, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
console.log("view.check ok");
