// The argument recorder `openarc decompile --run-tests` loads into each test process (NODE_OPTIONS=--import=<this file>).
// Plain JavaScript with no dependencies, so any Node can load it by path. It records INPUTS only: the arguments the
// project's exported functions receive while its tests run. Results come from decompile's own sandbox runs, never from here.
// Environment: OPENARC_RECORD_MANIFEST (JSON: absolute source path -> instrumented file), OPENARC_RECORD_OUT (directory
// for calls-<pid>.jsonl), OPENARC_RECORD_TEST (the test file this process runs for). Without the first two it does nothing.
// It must never throw into the program under test, and prints nothing.
// Limits: it sees only modules Node's own loader loads through `import` (record-hooks.mjs), so not test runners that
// transform sources themselves (Vitest, Jest): with those nothing is recorded. Only plain JSON arguments are kept.
import { register } from "node:module";
import { appendFileSync, mkdirSync } from "node:fs";

const { OPENARC_RECORD_MANIFEST: manifest, OPENARC_RECORD_OUT: out, OPENARC_RECORD_TEST: test = "" } = process.env;
const MAX_JSON = 600, MAX_LISTS = 12;

/** True when JSON gives the value back as it is: null, booleans, strings, finite numbers, dense arrays and plain objects
 *  of those, with data properties only (a getter is never called). `budget` bounds the walk: 600 characters of JSON hold
 *  fewer than 300 values, and a cycle runs out of it. */
function plain(v, budget) {
  if (--budget.n < 0) return false;
  if (v === null || typeof v === "string" || typeof v === "boolean") return true;
  if (typeof v === "number") return Number.isFinite(v);
  if (typeof v !== "object") return false;
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) if (!Object.hasOwn(v, i) || !plain(v[i], budget)) return false;
    return true;
  }
  const proto = Object.getPrototypeOf(v);
  if (proto !== Object.prototype && proto !== null) return false;
  const ds = Object.getOwnPropertyDescriptors(v);
  for (const k of Reflect.ownKeys(ds)) {
    const d = ds[k];
    if (typeof k !== "string" || k === "__proto__" || !("value" in d) || (d.enumerable && !plain(d.value, budget))) return false;
  }
  return true;
}

if (manifest && out) {
  try { register("./record-hooks.mjs", import.meta.url); } catch { /* an older Node: nothing is recorded */ }
  const held = new Map(); // "<file>\0<name>" -> { file, name, lists: Set of argument-list JSON }
  const record = (file, name, args) => {
    try {
      const list = Array.from(args);
      while (list.length && list.at(-1) === undefined) list.pop();
      const k = `${file}\0${name}`;
      let h = held.get(k);
      if (!h) held.set(k, (h = { file, name, lists: new Set() }));
      if (h.lists.size >= MAX_LISTS || !plain(list, { n: 300 })) return;
      const json = JSON.stringify(list); // the clone, taken before the function can change its arguments
      if (json.length <= MAX_JSON) h.lists.add(json);
    } catch { /* never into the program under test */ }
  };
  Object.defineProperty(globalThis, "__openarcRecord", { value: record, configurable: true, writable: true, enumerable: false });
  process.on("exit", () => {
    try {
      const lines = [...held.values()].filter((h) => h.lists.size).map((h) => `{"file":${JSON.stringify(h.file)},"name":${JSON.stringify(h.name)},"test":${JSON.stringify(test)},"args":[${[...h.lists].join(",")}]}\n`);
      if (!lines.length) return;
      mkdirSync(out, { recursive: true });
      appendFileSync(`${out}/calls-${process.pid}.jsonl`, lines.join(""));
    } catch { /* nothing recorded */ }
  });
}
