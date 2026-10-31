// Dev runner: execute every region's examples in-process, without a sandbox, against YOUR own code.
// Usage: node tools/run-examples.ts [--strict] [id-prefix]
// Pending regions are reported but don't fail the run unless --strict is set. A concept variant runs its concept's laws
// (with its fixtures) before its own examples, as the compiler does.
import { readdirSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { runExamples, showValue } from "open-arc/harness";
import type { AnyFn, ConceptSpec, RegionSpec } from "open-arc";
import { expandLaws } from "../src/concepts.ts";

const root = process.cwd();
const strict = process.argv.includes("--strict");
const prefix = process.argv.slice(2).find((a) => !a.startsWith("--")) ?? "";
let failed = 0;
let pending = 0;
let passed = 0;

const files = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap((e) =>
    e.isDirectory() ? files(`${dir}/${e.name}`) : /\.ts$/.test(e.name) ? [`${dir}/${e.name}`] : []);
const mods: Record<string, unknown>[] = [];
for (const file of files(`${root}/src`)) {
  if (!readFileSync(file, "utf8").includes("defineRegion")) continue; // e.g. main.ts would run the CLI
  mods.push(await import(pathToFileURL(file).href));
}
const concepts = new Map<string, ConceptSpec>();
for (const mod of mods) for (const v of Object.values(mod)) if (typeof v === "object" && v !== null && Array.isArray((v as ConceptSpec).laws)) concepts.set((v as ConceptSpec).id, v as ConceptSpec);

for (const mod of mods) {
  for (const value of Object.values(mod)) {
    let spec = value as RegionSpec<AnyFn>;
    if (typeof spec !== "object" || spec === null || typeof spec.id !== "string" || !("intent" in spec || "sketch" in spec)) continue;
    if (spec.concept) {
      const c = concepts.get(spec.concept);
      if (!c) throw new Error(`${spec.id}: unknown concept ${spec.concept}`);
      const ex = expandLaws(c, spec);
      if (ex.error) throw new Error(`${spec.id}: ${ex.error}`);
      spec = { ...spec, examples: ex.examples as unknown as RegionSpec<AnyFn>["examples"] };
    }
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
