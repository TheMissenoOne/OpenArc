// Module hooks for record.mjs (they run on Node's hooks thread): a source file listed in OPENARC_RECORD_MANIFEST loads
// with the instrumented text decompile wrote for it, in the format Node chose (a .ts file is still type-stripped, CommonJS
// stays CommonJS); every other file is untouched. The instrumented text is the project's own source plus one fixed
// recorder call per exported function, so nothing from the test process is ever executed.
// Covers `import` on the Node versions tested (22, 23, 25), also a CommonJS source that is imported. A `require()` from a
// CommonJS test file is not covered (on Node 25 a `require()` inside an imported CommonJS module is).
// ponytail: module.registerHooks would also cover require(), but on Node 22/23 it breaks require() of a .ts file;
// switch to it once the supported Node versions no longer have that bug.
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

const files = new Map();
try {
  // keyed by real path: Node resolves symlinks before it loads
  for (const [src, inst] of Object.entries(JSON.parse(readFileSync(process.env.OPENARC_RECORD_MANIFEST, "utf8")))) {
    try { files.set(realpathSync(src), inst); } catch { /* gone: not instrumented */ }
  }
} catch { /* no manifest: nothing is instrumented */ }

export async function load(url, context, nextLoad) {
  const r = await nextLoad(url, context);
  try {
    const inst = url.startsWith("file:") ? files.get(fileURLToPath(url)) : undefined;
    return inst ? { ...r, source: readFileSync(inst, "utf8") } : r;
  } catch {
    return r;
  }
}
