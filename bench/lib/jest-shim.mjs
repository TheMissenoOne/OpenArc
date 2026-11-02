// Minimal @jest/globals replacement: collects tests, real matchers come from jest's own `expect` package.
// Exercism marks all but the first test `xit`/`xdescribe`; like the Exercism CI, we run all of them.
// In record mode (globalThis.__record set), exercise exports are recorder stubs that return tokens, and
// `expect(token).toEqual(v)` stores v as that call's expected value instead of asserting.
import { expect as jexpect } from "expect";

export const tests = [];
const stack = [];
const hooks = { before: [], after: [] };

export function describe(name, fn) {
  stack.push(name);
  try { fn(); } finally { stack.pop(); }
}
export function it(name, fn) {
  tests.push({ name: [...stack, name].join(" > "), fn, before: [...hooks.before], after: [...hooks.after] });
}
for (const f of [describe, it]) { f.skip = f; f.only = f; f.each = undefined; }
export const xdescribe = describe, test = it, xit = it, xtest = it;
export const beforeEach = (fn) => hooks.before.push(fn);
export const afterEach = (fn) => hooks.after.push(fn);

const isTok = (v) => v !== null && typeof v === "object" && "__tok" in v;

function recordingMatchers(actual) {
  const rec = globalThis.__record;
  const set = (k, v) => { if (isTok(actual)) rec.calls[actual.__tok][k] = v; else rec.unusable = true; };
  const m = {
    toEqual: (e) => set("expected", rec.encode(e)),
    toStrictEqual: (e) => set("expected", rec.encode(e)),
    toBe: (e) => set("expected", rec.encode(e)),
    toThrow: () => {
      if (typeof actual !== "function") return void (rec.unusable = true);
      const n = rec.calls.length;
      try { actual(); } catch {}
      for (let i = n; i < rec.calls.length; i++) rec.calls[i].throws = true;
      if (rec.calls.length === n) rec.unusable = true;
    },
  };
  m.toThrowError = m.toThrow;
  return new Proxy(m, { get: (t, k) => (k in t ? t[k] : k === "not" ? new Proxy({}, { get: () => () => (rec.unusable = true) }) : () => (rec.unusable = true)) });
}

export const expect = new Proxy(jexpect, {
  apply: (_t, _this, [actual]) => (globalThis.__record ? recordingMatchers(actual) : jexpect(actual)),
});
