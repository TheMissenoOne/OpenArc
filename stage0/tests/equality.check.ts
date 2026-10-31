// Example equality (spec §9.3): numeric tolerance, -0, NaN, value tokens, faithful printing. Run: node tests/equality.check.ts
import assert from "node:assert";
import { decodeTokens, runExamples, showValue, toJson, valuesEqual } from "@openarc/core/harness";
import type { AnyFn, RegionSpec } from "@openarc/core";
import * as arc from "@openarc/core";

// numbers: -0 equals 0, NaN equals NaN, 1e-9 relative (absolute near zero) by default
assert.ok(valuesEqual(-0, 0));
assert.ok(valuesEqual([-0, 1, 0], [0, 1, 0]));
assert.ok(valuesEqual(NaN, NaN));
assert.ok(!valuesEqual(NaN, 0));
assert.ok(valuesEqual(Infinity, Infinity) && !valuesEqual(Infinity, -Infinity) && !valuesEqual(Infinity, 1e308));
assert.ok(valuesEqual(0.1 + 0.2, 0.3), "last-bit differences pass");
assert.ok(valuesEqual(1e12 + 1e-3, 1e12), "relative for large values");
assert.ok(valuesEqual(1e-10, 0), "absolute near zero");
assert.ok(!valuesEqual(1.000001, 1));
assert.ok(valuesEqual(1.000001, 1, { tolerance: 1e-5 }));
assert.ok(!valuesEqual(-0, 0, { exact: true }), "exact: Object.is");
assert.ok(!valuesEqual(0.1 + 0.2, 0.3, { exact: true }));
assert.ok(valuesEqual(NaN, NaN, { exact: true }));
// structure stays strict
assert.ok(!valuesEqual([1, 2], [1, 2, 3]));
assert.ok(!valuesEqual({ a: 1 }, { a: 1, b: undefined }));
assert.ok(valuesEqual({ a: [{ x: -0 }] }, { a: [{ x: 0 }] }));
assert.ok(!valuesEqual("1", 1));
assert.ok(!valuesEqual(null, undefined));
assert.ok(valuesEqual(new Map([[1, 2]]), new Map([[1, 2]])), "non-plain objects fall back to isDeepStrictEqual");

// tokens decode in args and expected; fake refs are left alone
assert.deepStrictEqual(decodeTokens(["$NaN", "$Infinity", "$-Infinity", "$undefined", "$other", { a: ["$NaN"] }]), [NaN, Infinity, -Infinity, undefined, "$other", { a: [NaN] }]);
assert.deepStrictEqual(decodeTokens({ $fake: "x", init: "$NaN" }), { $fake: "x", init: "$NaN" });
// printing keeps -0, NaN, Infinity and undefined visible
assert.equal(showValue(toJson([-0, 1, 0])), "[-0,1,0]");
assert.equal(showValue(toJson({ d: NaN, e: Infinity, f: -Infinity, g: undefined })), '{"d":NaN,"e":Infinity,"f":-Infinity,"g":undefined}');
assert.equal(showValue(toJson(undefined)), "undefined");

// runExamples: tokens, spec tolerance, per-example tolerance, exact
{
  // defineRegion<F> type-checks the tokens: "$NaN" where F returns a number, "$undefined" where it may return undefined
  const run = <F extends AnyFn>(fn: F, spec: RegionSpec<F>) => runExamples(process.cwd(), fn, spec as unknown as RegionSpec<AnyFn>);
  const div = (a: number, b: number) => a / b;
  const out = await run(div, {
    id: "t.div",
    intent: "",
    examples: [
      { args: [0, 0], expected: "$NaN" },
      { args: [1, 0], expected: "$Infinity" },
      { args: ["$-Infinity", 1], expected: "$-Infinity" },
      { args: [1, 3], expected: 0.33333 }, // fails at the default 1e-9
      { args: [1, 3], expected: 0.33333, tolerance: 1e-4 },
      { name: "exact -0", args: [-0, 1], expected: 0, exact: true },
    ],
  });
  assert.deepStrictEqual(out, [
    { name: "#1", ok: true },
    { name: "#2", ok: true },
    { name: "#3", ok: true },
    { name: "#4", ok: false, actual: 0.3333333333333333 },
    { name: "#5", ok: true },
    { name: "exact -0", ok: false, actual: "$-0" },
  ]);
  const loose = await run(div, { id: "t.div", intent: "", tolerance: 1e-4, examples: [{ args: [1, 3], expected: 0.33333 }] });
  assert.deepStrictEqual(loose, [{ name: "#1", ok: true }], "spec-level tolerance");
  const undef = await run((o: { a?: number }) => o.a, { id: "t.a", intent: "", examples: [{ args: [{}], expected: "$undefined" }, { args: [{ a: "$undefined" }], expected: "$undefined" }] });
  assert.ok(undef.every((o) => o.ok));
}

// Evaluation repro (gate-preview geometry.fitLine): the ORIGINAL code returns [-0, 1, 0] for a horizontal line, and the
// JSON example can only say [0, 1, 0]. Under isDeepStrictEqual the original failed its own example ("got [0,1,0]; expected
// [0,1,0]"); now it passes.
{
  function fitLine(pts: number[][]) {
    const n = pts.length;
    const mx = pts.reduce((s, p) => s + p[0]!, 0) / n, my = pts.reduce((s, p) => s + p[1]!, 0) / n;
    let sxx = 0, syy = 0, sxy = 0;
    for (const [x, y] of pts as [number, number][]) { sxx += (x - mx) ** 2; syy += (y - my) ** 2; sxy += (x - mx) * (y - my); }
    const th = 0.5 * Math.atan2(2 * sxy, sxx - syy);
    const [dx, dy] = [Math.cos(th), Math.sin(th)];
    return [-dy, dx, dy * mx - dx * my];
  }
  assert.ok(Object.is(fitLine([[0, 0], [1, 0], [2, 0]])[0], -0), "the original really returns -0");
  const spec = arc.defineRegion<typeof fitLine>({ id: "geometry.fitLine", intent: "", examples: [{ args: [[[0, 0], [1, 0], [2, 0]]], expected: [0, 1, 0] }] });
  const out = await runExamples(process.cwd(), fitLine, spec as unknown as RegionSpec<AnyFn>);
  assert.deepStrictEqual(out, [{ name: "#1", ok: true }]);
  // segDist printed NaN as "got null"; the value is now shown as NaN
  assert.equal(showValue(toJson(Math.hypot(NaN, 1))), "NaN");
}
console.log("equality: tolerance, -0, NaN, tokens, faithful printing, fitLine repro ok");
