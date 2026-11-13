// Go behind the language seam (src/lang/go.ts), end to end on a standard-library-only module: `openarc decompile` (type
// mapping, intent, literal calls and receivers as inputs, `after`, throws from an error and from a panic, the per-call
// timeout), `--run-tests`, `--check` with rules, `openarc arc status|prompt|accept`, `status`, and a folder holding both a
// Go module and JavaScript decompiled in one run. Nothing in the project's code may change except an accepted body.
// Without a Go toolchain (OPENARC_GO, else go on PATH) it checks only the message that says so, and skips the rest.
// Every OS: the node tier refuses Go code with how to proceed. Windows (no OS sandbox): that refusal and an unsafe-none
// run, then stops. Linux (bwrap) and macOS (sandbox-exec): everything, plus what the sandbox denies the code.
// Run: OPENARC_GO=/path/to/go node --no-warnings tests/go.check.ts
import assert from "node:assert";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { parseArc, printArc } from "../src/arc.ts";
import "../src/decompile.ts"; // first: the language modules import it back
import type { DecompileCtx } from "../src/decompile.ts";
import { langOf } from "../src/lang/lang.ts";
import type { Ports } from "../src/types.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";

const MAIN = resolve("src/main.ts");
const go = process.env.OPENARC_GO || (process.env.PATH ?? "").split(delimiter).map((d) => join(d, process.platform === "win32" ? "go.exe" : "go")).find((p) => existsSync(p));
const roots: string[] = [];
const project = (files: Record<string, string>) => {
  const dir = mkdtempSync(join(resolve(".."), ".go-check-"));
  roots.push(dir);
  for (const [f, t] of Object.entries(files)) mkdirSync(dirname(join(dir, f)), { recursive: true }), writeFileSync(join(dir, f), t);
  const oa = (args: string[], input?: string, env: Record<string, string> = {}) => {
    const r = spawnSync(process.execPath, ["--no-warnings", MAIN, ...args], { cwd: dir, encoding: "utf8", input, env: { ...process.env, ...env } });
    return { code: r.status, out: r.stdout + r.stderr };
  };
  return { dir, oa, read: (f: string) => readFileSync(join(dir, f), "utf8"), write: (f: string, t: string) => writeFileSync(join(dir, f), t) };
};

const CALC = `// Package calc is a small fixture.
package calc

import (
	"errors"
	"strconv"
	"strings"
)

// Add returns the sum of two integers.
func Add(a, b int) int {
	return a + b
}

// Average is the mean of the numbers; 0 for none.
func Average(xs []float64) float64 {
	if len(xs) == 0 {
		return 0
	}
	s := 0.0
	for _, x := range xs {
		s += x
	}
	return s / float64(len(xs))
}

// Shout upper-cases s and adds an exclamation mark.
func Shout(s string) string {
	return strings.ToUpper(s) + "!"
}

// IsEven reports whether n is even.
func IsEven(n int) bool {
	return n%2 == 0
}

// Point is a place on the grid.
type Point struct {
	X      int    \`json:"x"\`
	Y      int    \`json:"y"\`
	Label  string \`json:"label,omitempty"\`
	hidden int
}

// Move shifts p by dx and dy in place.
func Move(p *Point, dx, dy int) {
	if p == nil {
		return
	}
	p.X += dx
	p.Y += dy
}

// Div divides a by b.
func Div(a, b int) (int, error) {
	if b == 0 {
		return 0, errors.New("division by zero")
	}
	return a / b, nil
}

// MustPositive returns n, and panics when it is negative.
func MustPositive(n int) int {
	if n < 0 {
		panic("negative: " + strconv.Itoa(n))
	}
	return n
}

// Double doubles every element of xs in place.
func Double(xs []int) {
	for i := range xs {
		xs[i] *= 2
	}
}

// Clamp keeps n between lo and hi.
func Clamp(n, lo, hi int) int {
	if n < lo {
		return lo
	}
	if n > hi {
		return hi
	}
	return n
}

// Counter counts.
type Counter struct {
	N int \`json:"n"\`
}

// Inc adds by to the counter and returns the new count.
func (c *Counter) Inc(by int) int {
	c.N += by
	return c.N
}
`;
const LOOP = `package calc

// Steps counts the Collatz steps from n down to 1 (0 for 0). It never ends for a negative n.
func Steps(n int) int {
	s := 0
	for n != 1 && n != 0 {
		if n%2 == 0 {
			n /= 2
		} else {
			n = 3*n + 1
		}
		s++
	}
	return s
}
`;
const TESTS = `package calc

import "testing"

func TestAdd(t *testing.T) {
	if Add(2, 3) != 5 {
		t.Fatal("2 + 3")
	}
}

func TestDiv(t *testing.T) {
	if _, err := Div(1, 0); err == nil {
		t.Fatal("no error")
	}
	if q, _ := Div(7, 2); q != 3 {
		t.Fatal("7 / 2")
	}
}

func TestCounter(t *testing.T) {
	c := Counter{N: 5}
	if c.Inc(2) != 7 {
		t.Fatal("inc")
	}
}
`;

try {
  // ── no toolchain: one line that says how to set it
  {
    const p = project({ "go.mod": "module example.com/calc\n\ngo 1.22\n", "src/calc.go": CALC });
    const r = p.oa(["decompile"], undefined, { OPENARC_GO: join(p.dir, "no-such-go") });
    assert.strictEqual(r.code, 1, r.out);
    assert.strictEqual(r.out.trim(), "openarc: Go code needs the Go toolchain: set OPENARC_GO to the go binary (OPENARC_GO=/usr/local/go/bin/go) or put go on PATH");
  }
  if (!go) {
    console.log("go.check: SKIP: no Go toolchain (set OPENARC_GO to the go binary, or put go on PATH); checked only the message for a missing one");
    for (const d of roots) rmSync(d, { recursive: true, force: true });
    process.exit(0);
  }

  // ── the node tier cannot confine a Go binary: nothing runs, and the refusal says how to proceed
  {
    const t = project({ "go.mod": "module example.com/t\n\ngo 1.22\n", "src/t.go": "package t\n\n// Inc adds one.\nfunc Inc(n int) int {\n\treturn n + 1\n}\n" });
    const tier = (isolation: string) => t.write("openarc.config.json", JSON.stringify({ ...DEFAULT_CONFIG, sandbox: { isolation } }));
    tier("node");
    const r = t.oa(["decompile"]);
    assert.strictEqual(r.code, 0, r.out);
    assert.match(r.out, /^OARC-E092 sandbox unavailable: Go code needs bwrap \(Linux\) or sandbox-exec \(macOS\), not node, so no Go function ran\. To run Go code with no sandbox at all, as you, with your files and your network, set "sandbox": \{ "isolation": "unsafe-none" \} in openarc\.config\.json, then run decompile --fresh$/m);
    assert.strictEqual(r.out.match(/OARC-E092/g)?.length, 1, "said once per run");
    assert.match(r.out, /observed 0, described 1,/);
    const kept = (JSON.parse(t.read(".openarc/decompile.json")) as { modules: Record<string, { fns: Record<string, { why: string }> }> }).modules["src/t.go"]!.fns.Inc!.why;
    assert.strictEqual(kept, 'OARC-E092 sandbox unavailable: Go code needs bwrap (Linux) or sandbox-exec (macOS), not node; or sandbox.isolation "unsafe-none" (no sandbox), then decompile --fresh');
    if (process.platform === "win32") {
      tier("unsafe-none");
      const u = t.oa(["decompile", "--fresh"]);
      assert.match(u.out, /observed 1, described 0,/, u.out);
      assert.ok(t.read("arc/spec/t.arc").includes("  observed (0) => 1\n"), t.read("arc/spec/t.arc"));
      console.log("go.check ok: Windows has no sandbox for Go: checked the node tier's refusal and an unsafe-none run only");
      for (const d of roots) rmSync(d, { recursive: true, force: true });
      process.exit(0);
    }
  }

  const p = project({ "go.mod": "module example.com/calc\n\ngo 1.22\n", "src/calc.go": CALC, "src/loop.go": LOOP, "src/calc_test.go": TESTS });
  const { oa, read, write } = p;
  const code = () => ["go.mod", "src/calc.go", "src/loop.go", "src/calc_test.go"].map(read).join("\0");
  const before = code();

  // ── decompile: signatures, intent, observations; the code is untouched
  let r = oa(["decompile"]);
  assert.strictEqual(r.code, 0, r.out);
  assert.match(r.out, /decompiled 2 modules: tested 0, failing 0, specified 0, observed 11, described 0, bare 0, skipped 0/);
  assert.strictEqual(code(), before);
  const calc = read("arc/spec/calc.arc");
  assert.strictEqual(printArc(parseArc(calc)), calc);
  for (const part of [
    'module calc from "src/calc.go"\n\ntype Point = { x: Int, y: Int, label?: Str }\n\ntype Counter = { n: Int }\n',
    'fn Add(a: Int, b: Int): Int\n  "Add returns the sum of two integers."\n  observed (2, 3) => 5\n', // a literal call in the test comes first
    "fn Average(xs: [Float]): Float\n",
    'fn Shout(s: Str): Str\n  "Shout upper-cases s and adds an exclamation mark."\n  observed ("") => "!"\n  observed ("a") => "A!"\n',
    "fn IsEven(n: Int): Bool\n",
    'fn Move(p: Point?, dx: Int, dy: Int): Void\n  "Move shifts p by dx and dy in place."\n  observed ({x: 0, y: 0}, 1, -1) => "$undefined" after ({x: 1, y: -1}, 1, -1)\n  observed (null, -1, 42) => "$undefined"\n',
    'fn Div(a: Int, b: Int): Int\n  "Div divides a by b."\n  observed (7, 2) => 3\n', // (int, error): an error is a throw
    '  observed (1, 0) throws "division by zero"\n',
    '  observed (-1) throws "negative: -1"\n', // a panic is a throw
    '  observed ([0, 1, -1]) => "$undefined" after ([0, 2, -2])\n', // a slice changed in place
    "fn Counter.Inc(by: Int): Int\n  \"Inc adds by to the counter and returns the new count.\"\n  observed new ({n: 5}) . (2) => 7\n  observed new () . (2) => 2\n", // receivers: a composite literal, the zero value
  ]) assert.ok(calc.includes(part), `missing:\n${part}\nin:\n${calc}`);
  // the per-call limit: an input that loops forever is named and the others still run
  assert.strictEqual(read("arc/spec/loop.arc"), 'module loop from "src/loop.go"\n\nfn Steps(n: Int): Int\n  "Steps counts the Collatz steps from n down to 1 (0 for 0). It never ends for a negative n."\n  observed (0) => 0\n  observed (42) => 8\n  observed (-1) throws "timed out after 5000 ms (does it loop forever?)"\n');
  const state = JSON.parse(read(".openarc/decompile.json")) as { modules: Record<string, { fns: Record<string, { status: string; tests: string[]; origins?: Record<string, string> }> }> };
  assert.deepStrictEqual(state.modules["src/calc.go"]!.fns.Add!.tests, ["src/calc_test.go"]);
  assert.strictEqual(state.modules["src/calc.go"]!.fns.Add!.origins!["[2,3]"], "call src/calc_test.go:6");
  assert.strictEqual(state.modules["src/calc.go"]!.fns["Counter.Inc"]!.origins!['[[{"n":5}],2]'], "call src/calc_test.go:22");
  r = oa(["status"]);
  assert.match(r.out, /^total: 2 modules, 11 functions \(observed 11\); weakest observed$/m, r.out);

  // ── --run-tests: `go test`, a test file failing when one of its tests does
  write("src/even_test.go", 'package calc\n\nimport "testing"\n\nfunc TestEven(t *testing.T) {\n\tif !IsEven(3) {\n\t\tt.Fatal("3 is odd")\n\t}\n}\n');
  r = oa(["decompile", "--run-tests"]);
  assert.match(r.out, /decompiled 2 modules: tested 3, failing 1, specified 0, observed 7,/, r.out);
  const ran = JSON.parse(read(".openarc/decompile.json")) as typeof state;
  assert.deepStrictEqual(ran.modules["src/calc.go"]!.fns.IsEven, { ...ran.modules["src/calc.go"]!.fns.IsEven, status: "failing", why: "src/even_test.go fails" });
  rmSync(join(p.dir, "src/even_test.go"));
  // a `go test` run that fails as a whole (a non-zero exit, no test or package failing) fails every test file of the
  // module, with its first plain-text line as the reason; a go wrapper makes `go test -json` do that
  write("fakego", `#!/bin/sh\nif [ "$1" = test ] && [ "$2" = -json ]; then echo "go: something broke before any test ran" >&2; exit 1; fi\nexec ${go} "$@"\n`);
  spawnSync("chmod", ["+x", join(p.dir, "fakego")]);
  r = oa(["decompile", "--run-tests"], undefined, { OPENARC_GO: join(p.dir, "fakego") });
  assert.strictEqual(r.code, 0, r.out);
  const whole = JSON.parse(read(".openarc/decompile.json")) as typeof state;
  assert.deepStrictEqual([whole.modules["src/calc.go"]!.fns.Add!.status, (whole.modules["src/calc.go"]!.fns.Add as { why?: string }).why], ["failing", "src/calc_test.go fails: go: something broke before any test ran"]);
  rmSync(join(p.dir, "fakego"));
  // and one that times out (proc.run stubbed for `go test -json`), with "timed out after N s"
  {
    const run = (argv: string[], _ms: number, opts?: { cwd?: string; env?: Record<string, string>; stdin?: string }) => {
      if (argv[1] === "test") return Promise.resolve({ code: null, stdout: "", timedOut: true });
      const x = spawnSync(argv[0]!, argv.slice(1), { cwd: opts?.cwd ?? p.dir, env: { ...process.env, ...opts?.env }, encoding: "utf8", ...(opts?.stdin !== undefined ? { input: opts.stdin } : {}) });
      return Promise.resolve({ code: x.status, stdout: x.stdout + (x.status ? x.stderr : ""), timedOut: false });
    };
    const fs = { read: async (rel: string) => { try { return readFileSync(join(p.dir, rel), "utf8"); } catch { return null; } } };
    const ctx = { ports: { fs, proc: { run } } as unknown as Ports, root: p.dir, out: "arc/spec", dirs: ["src"], log: () => {}, request: () => { throw new Error("not here"); } } as unknown as DecompileCtx;
    const goLang = langOf("x.go")!;
    await goLang.read(ctx, ["src/calc.go"], []);
    assert.deepStrictEqual(await goLang.runTest(ctx, "src/calc_test.go"), { ok: false, why: "timed out after 300 s" });
  }

  // ── --check: preserved; a changed function is caught; a rule holds and a generated input breaks another
  r = oa(["decompile", "--check"]);
  assert.strictEqual(r.code, 0, r.out);
  assert.match(r.out, /checked 11 functions: preserved \d+, changed 0, failing 0, unrunnable 0, removed 0, new 0/);
  write("src/calc.go", CALC.replace('strings.ToUpper(s) + "!"', 'strings.ToUpper(s) + "!!"'));
  r = oa(["decompile", "--check"]);
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /^src\/calc\.go: Shout\("a"\) changed: was "A!", now "A!!"$/m);
  write("src/calc.go", CALC);
  write("arc/spec/calc.arc", read("arc/spec/calc.arc").replace("fn Clamp(n: Int, lo: Int, hi: Int): Int\n", "fn Clamp(n: Int, lo: Int, hi: Int): Int\n  rule sane: lo > hi or result in lo..hi\n  rule floor: result >= lo\n"));
  r = oa(["decompile", "--check"]);
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /^src\/calc\.go: Clamp: rule sane: held on \d+ inputs$/m);
  assert.match(r.out, /^src\/calc\.go: Clamp: rule floor: broken by \(-?\d+, -?\d+, -?\d+\) -> -?\d+$/m);
  write("arc/spec/calc.arc", read("arc/spec/calc.arc").replace("  rule floor: result >= lo\n", ""));

  // ── arc: an example edit makes the function stale; accept rejects a wrong body and one that does not compile, the
  // file byte for byte as it was, and keeps a right one with only the body changed
  write("arc/spec/calc.arc", read("arc/spec/calc.arc").replace("  observed (2, 3) => 5\n", "  example (2, 3) => 5\n  example (10, 1) => 9\n"));
  r = oa(["arc", "status", "calc.Add"]);
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /^calc\.Add: stale: example \(10, 1\) => 9: the code returns 11$/m);
  r = oa(["arc", "prompt", "calc.Add"]);
  assert.ok(r.out.includes("Write the body of Add in src/calc.go (Go).\nfn Add(a: Int, b: Int): Int\n"), r.out);
  assert.ok(r.out.includes("Current code:\nfunc Add(a, b int) int {\n\treturn a + b\n}\nFailing now:\n  example (10, 1) => 9: the code returns 11\n"), r.out);
  const src = read("src/calc.go");
  r = oa(["arc", "accept", "calc.Add"], "return a + b + 1");
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /^example \(2, 3\) => 5: the code returns 6$/m);
  assert.strictEqual(read("src/calc.go"), src);
  r = oa(["arc", "accept", "calc.Add"], "return a + missing");
  assert.strictEqual(r.code, 1, r.out);
  assert.strictEqual(r.out.trim(), "src/calc.go:12:13: undefined: missing");
  assert.strictEqual(read("src/calc.go"), src);
  r = oa(["arc", "accept", "calc.Add"], "```go\nif b == 1 {\n\treturn a - b\n}\nreturn a + b\n```");
  assert.strictEqual(r.code, 0, r.out);
  assert.strictEqual(read("src/calc.go"), src.replace("func Add(a, b int) int {\n\treturn a + b\n}", "func Add(a, b int) int {\n\tif b == 1 {\n\t\treturn a - b\n\t}\n\treturn a + b\n}"));
  r = oa(["arc", "status", "calc.Add"]);
  assert.strictEqual(r.code, 0, r.out);
  assert.match(r.out, /^calc\.Add: ok$/m);
  // a method on a pointer receiver, the same way
  write("arc/spec/calc.arc", read("arc/spec/calc.arc").replace("  observed new ({n: 5}) . (2) => 7\n", "  example new ({n: 5}) . (2) => 9\n"));
  r = oa(["arc", "prompt", "calc.Counter.Inc"]);
  assert.ok(r.out.includes("Current code:\nfunc (c *Counter) Inc(by int) int {\n\tc.N += by\n\treturn c.N\n}\n"), r.out);
  const src2 = read("src/calc.go");
  r = oa(["arc", "accept", "calc.Counter.Inc"], "c.N += by * 3\nreturn c.N");
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /^example new \(\{n: 5\}\) \. \(2\) => 9: the code returns 11$/m);
  r = oa(["arc", "accept", "calc.Counter.Inc"], "func (c *Counter) Inc(by int) int {\n\treturn 0\n}");
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /repeats the signature/);
  assert.strictEqual(read("src/calc.go"), src2);
  r = oa(["arc", "accept", "calc.Counter.Inc"], "c.N += 2 * by\nreturn c.N");
  assert.strictEqual(r.code, 0, r.out);
  assert.strictEqual(read("src/calc.go"), src2.replace("\tc.N += by\n", "\tc.N += 2 * by\n"));

  // ── one folder, two languages: a Go module in svc/ and JavaScript in src/, decompiled in one run; the architecture
  // reads both
  const m = project({
    "package.json": '{"name":"mixed","version":"1.0.0","private":true,"type":"module"}',
    "src/util.js": "/** Doubles n.\n *  @param {number} n */\nexport function twice(n) {\n  return n * 2;\n}\n",
    "svc/go.mod": "module example.com/svc\n\ngo 1.22\n",
    "svc/greet.go": 'package svc\n\nimport "strings"\n\n// Greet says hello to name, trimmed.\nfunc Greet(name string) string {\n\treturn "Hello, " + strings.TrimSpace(name) + "!"\n}\n',
  });
  r = m.oa(["decompile", "src", "svc"]);
  assert.strictEqual(r.code, 0, r.out);
  assert.match(r.out, /decompiled 2 modules: tested 0, failing 0, specified 0, observed 2,/);
  assert.ok(m.read("arc/spec/util.arc").includes('fn twice(n: Num): Num\n  "Doubles n."\n  observed (0) => 0\n'), m.read("arc/spec/util.arc"));
  assert.ok(m.read("arc/spec/greet.arc").includes('fn Greet(name: Str): Str\n  "Greet says hello to name, trimmed."\n  observed ("") => "Hello, !"\n'), m.read("arc/spec/greet.arc"));
  r = m.oa(["arch", "src", "svc"]);
  assert.strictEqual(r.code, 0, r.out);
  assert.match(m.read("arc/architecture.arc"), /^external go:strings$/m);
  assert.match(m.read("arc/architecture.arc"), /^part svc\n  module svc\/greet\.go\n  uses go:strings$/m);

  // ── `.`: a module at the project root, read like any dir (no `./` prefix on its paths)
  const flat = project({ "go.mod": "module example.com/flat\n\ngo 1.22\n", "add.go": "package flat\n\n// Add adds.\nfunc Add(a, b int) int {\n\treturn a + b\n}\n", "add_test.go": 'package flat\n\nimport "testing"\n\nfunc TestAdd(t *testing.T) {\n\tif Add(2, 3) != 5 {\n\t\tt.Fatal("2 + 3")\n\t}\n}\n' });
  r = flat.oa(["decompile", "."]);
  assert.strictEqual(r.code, 0, r.out);
  assert.ok(flat.read("arc/spec/add.arc").startsWith('module add from "add.go"\n\nfn Add(a: Int, b: Int): Int\n  "Add adds."\n  observed (2, 3) => 5\n'), flat.read("arc/spec/add.arc"));
  assert.deepStrictEqual((JSON.parse(flat.read(".openarc/decompile.json")) as typeof state).modules["add.go"]!.fns.Add!.tests, ["add_test.go"]);
  // ── what the sandbox denies the code: a project file outside the stage, writing the stage, the network
  {
    const s = project({ "go.mod": "module example.com/probe\n\ngo 1.22\n", "secret.txt": "s\n", "src/probe.go": "" });
    s.write("src/probe.go", `package probe

import (
	"net"
	"os"
	"time"
)

// Probe reports what the code may do.
func Probe() string {
	out := "read:yes"
	if _, err := os.ReadFile(${JSON.stringify(join(s.dir, "secret.txt"))}); err != nil {
		out = "read:no"
	}
	if os.WriteFile("probe.txt", []byte("x"), 0o644) == nil {
		out += " write:yes"
	} else {
		out += " write:no"
	}
	if c, err := net.DialTimeout("tcp", "1.1.1.1:53", 2*time.Second); err == nil {
		c.Close()
		out += " net:yes"
	} else {
		out += " net:no"
	}
	return out
}
`);
    r = s.oa(["decompile"]);
    assert.strictEqual(r.code, 0, r.out);
    assert.ok(s.read("arc/spec/probe.arc").includes('  observed () => "read:no write:no net:no"\n'), s.read("arc/spec/probe.arc"));
  }
  console.log("go.check ok");
} finally {
  for (const d of roots) rmSync(d, { recursive: true, force: true });
}
