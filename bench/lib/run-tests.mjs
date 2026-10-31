// Usage: node --experimental-transform-types run-tests.mjs <abs test file> [--record]
// Prints one JSON line per test, then {"done": n}. The test file must resolve '@jest/globals' to jest-shim.mjs.
import { tests } from "./jest-shim.mjs";

const [file, mode] = process.argv.slice(2);
const record = mode === "--record";

export function encode(v) {
  if (v === undefined) return "$undefined";
  if (typeof v === "number") return Number.isNaN(v) ? "$NaN" : v === Infinity ? "$Infinity" : v === -Infinity ? "$-Infinity" : v;
  if (Array.isArray(v)) return v.map(encode);
  if (v !== null && typeof v === "object") {
    if (Object.getPrototypeOf(v) !== Object.prototype) throw new Error("non-plain object");
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, encode(x)]));
  }
  if (typeof v === "function" || typeof v === "symbol" || typeof v === "bigint") throw new Error(`unencodable ${typeof v}`);
  return v;
}

if (record) {
  globalThis.__rec = (fn, args) => {
    const r = globalThis.__record;
    let enc;
    try { enc = encode(structuredClone(args)); } catch { r.unusable = true; }
    r.calls.push({ fn, args: enc });
    return { __tok: r.calls.length - 1 };
  };
}

await import(file);
for (const t of tests) {
  if (record) globalThis.__record = { calls: [], unusable: false, encode: (v) => { try { return encode(v); } catch { globalThis.__record.unusable = true; } } };
  let ok = true, msg;
  try {
    for (const h of t.before) await h();
    await t.fn();
    for (const h of t.after) await h();
  } catch (e) {
    ok = false;
    msg = String(e?.message ?? e).replace(/\u001b\[[0-9;]*m/g, "").slice(0, 600);
  }
  const line = record ? { name: t.name, calls: globalThis.__record.calls, unusable: globalThis.__record.unusable || !ok, err: msg } : { name: t.name, ok, msg };
  process.stdout.write(JSON.stringify(line) + "\n");
}
process.stdout.write(JSON.stringify({ done: tests.length }) + "\n");
