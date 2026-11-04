// Held-out check for one bench/deps task: node heldout.mjs <projectDir> <task>
// Imports the compiled src/<task>.ts from the project and runs tasks/<task>.heldout.mjs's cases; prints {passed,total,failures}.
// run.mjs starts it under `node --permission` (reads only: no writes, no child processes).
import { isDeepStrictEqual } from "node:util";
import { pathToFileURL } from "node:url";
const [dir, task] = process.argv.slice(2);
const { meta, cases } = await import(new URL(`./tasks/${task}.heldout.mjs`, import.meta.url));
let fn, failures = [], passed = 0;
try {
  fn = (await import(pathToFileURL(`${dir}/src/${task}.ts`).href))[meta.export];
} catch (e) {
  fn = () => { throw e; };
}
for (const c of cases) {
  let got;
  try { got = fn(...c.args); } catch (e) { got = `throws ${String(e?.message ?? e).slice(0, 120)}`; }
  if (isDeepStrictEqual(got, c.expected)) passed++;
  else failures.push({ args: String(c.args.map((a) => (typeof a === "string" ? JSON.stringify(a) : String(a)))).slice(0, 120), got: String(typeof got === "string" ? JSON.stringify(got) : got).slice(0, 120) });
}
console.log(JSON.stringify({ passed, total: cases.length, failures: failures.slice(0, 5) }));
