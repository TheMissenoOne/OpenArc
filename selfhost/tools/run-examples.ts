// Dev runner: execute every region's examples in-process, without a sandbox, against YOUR own code.
// Usage: node tools/run-examples.ts [--strict] [id-prefix]
// Pending regions are reported but don't fail the run unless --strict is set.
import { readdirSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { runExamples, showValue } from "@openarc/core/harness";
import type { AnyFn, RegionSpec } from "@openarc/core";

const root = process.cwd();
const strict = process.argv.includes("--strict");
const prefix = process.argv.slice(2).find((a) => !a.startsWith("--")) ?? "";
let failed = 0;
let pending = 0;
let passed = 0;

for (const file of readdirSync(`${root}/src`).filter((f) => f.endsWith(".ts")).sort()) {
  if (!readFileSync(`${root}/src/${file}`, "utf8").includes("defineRegion")) continue; // e.g. main.ts would run the CLI
  const mod = await import(pathToFileURL(`${root}/src/${file}`).href);
  for (const value of Object.values(mod)) {
    const spec = value as RegionSpec<AnyFn>;
    if (typeof spec !== "object" || spec === null || typeof spec.id !== "string" || !("intent" in spec)) continue;
    if (!spec.id.startsWith(prefix) || !spec.examples?.length) continue;
    const symbol = spec.symbol ?? spec.id.split(".").at(-1)!;
    const outcomes = await runExamples(root, mod[symbol] as AnyFn, spec);
    const bad = outcomes.filter((o) => !o.ok);
    const isPending = bad.length > 0 && bad.every((o) => typeof o.actual === "object" && o.actual !== null && "pending" in o.actual);
    if (bad.length === 0) passed++;
    else if (isPending) pending++;
    else failed++;
    const tag = bad.length === 0 ? "ok     " : isPending ? "pending" : "FAIL   ";
    console.log(`${tag} ${spec.id.padEnd(28)} ${outcomes.length - bad.length}/${outcomes.length}`);
    if (!isPending) for (const o of bad) console.log(`          ✗ ${o.name}: ${showValue(o.actual)}`);
  }
}
console.log(`\n${passed} ok, ${pending} pending, ${failed} failing`);
process.exit(failed > 0 || (strict && pending > 0) ? 1 : 0);
