// Second-opinion differential: body A (selfhost as frozen) vs a second body B on oracle inputs plus structural variations; stage0 scores who is right.
// Run from stage0: node --no-warnings ../bench/results/2026-11-05-second-opinion/compare.ts <project dir of B, or "stage0"> [--runs 2000]   Prints one JSON line per region.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import * as engine from "../../../stage0/src/engine.ts";

type J = any;
const J = JSON.stringify;
const here = fileURLToPath(import.meta.url);
const REPO = resolve(here, "../../../..");
const FILES: Record<string, string> = { "model.parseOutput": "src/model.ts" };
const P2P = ["p2p.onGossip", "p2p.broadcast", "p2p.peerTable", "p2p.handshake", "p2p.encodeVarint", "p2p.decodeLengthPrefixed"];
for (const id of P2P) FILES[id] = "src/palette/p2p.ts";
export const REGIONS = Object.keys(FILES);

function prng(seed: number) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32); }
const TYPES: J[] = [null, 1, "", [], {}, true];
const kind = (v: J) => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);

/** Every single edit of v. json: v came out of a JSON string parameter, so its contents are untrusted and types may change. Otherwise the declared type holds: only values, order and lengths change. */
export function variants(v: J, json: boolean, pool: string[]): J[] {
  const out: J[] = [];
  if (json) for (const t of TYPES) if (kind(t) !== kind(v)) out.push(t);
  if (Array.isArray(v)) {
    if (v.length > 1) out.push([...v].reverse(), [...v.slice(1), v[0]]);
    v.forEach((_, i) => { out.push(v.filter((__, j) => j !== i)); });
    if (v.length) out.push([...v, v[0]]);
    v.forEach((x, i) => { for (const w of variants(x, json, pool)) out.push(v.map((y, j) => (j === i ? w : y))); });
  } else if (v && typeof v === "object") {
    if ("$fake" in v) return [];
    for (const k of Object.keys(v)) {
      if (json) { const { [k]: _, ...rest } = v; out.push(rest); }
      for (const w of variants(v[k], json, pool)) out.push({ ...v, [k]: w });
    }
    if (json) out.push({}, { ...v, extra: 1 });
  } else if (typeof v === "number") out.push(-v, 0, v + 1);
  else if (typeof v === "string") out.push(...pool.filter((s) => s !== v), "__proto__", "");
  else if (typeof v === "boolean") out.push(!v);
  return out;
}
const asJson = (s: J): J => { if (typeof s !== "string") return undefined; try { const o = JSON.parse(s); return o && typeof o === "object" ? o : undefined; } catch { return undefined; } };
const strings = (v: J, acc: Set<string>): Set<string> => { if (typeof v === "string") acc.add(v); else if (v && typeof v === "object") Object.values(v).forEach((x) => strings(x, acc)); return acc; };
function argVariants(a: J, pool: string[]): J[] {
  const o = asJson(a);
  return o === undefined ? variants(a, false, pool) : variants(o, true, pool).map((x) => J(x));
}
/** Structural inputs: all single edits of each example, then seeded double edits. */
export function structuralInputs(examples: J[], count: number, seed = 1): J[][] {
  const rand = prng(seed);
  const bases: J[][] = examples.map((e) => e.args).filter(Array.isArray);
  const pool = [...strings(bases.map((b) => b.filter((a) => asJson(a) === undefined && !a?.$fake)), new Set<string>())].filter((s) => s.length <= 12).slice(0, 16);
  const seen = new Set<string>(), out: J[][] = [];
  const add = (a: J[]) => { const k = J(a); if (!seen.has(k) && out.length < count) seen.add(k), out.push(a); };
  const singles: J[][] = [];
  for (const b of bases) b.forEach((a, i) => { for (const w of argVariants(a, pool)) singles.push(b.map((x, j) => (j === i ? w : x))); });
  singles.forEach(add);
  for (let n = 0; out.length < count && n < count * 5 && singles.length; n++) {
    const s = singles[Math.floor(rand() * singles.length)]!, i = Math.floor(rand() * s.length);
    const vs = argVariants(s[i], pool);
    if (vs.length) add(s.map((x, j) => (j === i ? vs[Math.floor(rand() * vs.length)] : x)));
  }
  return out;
}

const specOf = (m: J, name: string) => { const s = m[`${name}Spec`]; return s.examples ?? s.spec?.examples ?? s.__spec?.examples; };
async function call(mod: J, name: string, args: J[], makeFake: J) {
  let snapshot: J = null;
  const real = structuredClone(args).map((a: J) => { if (a && a.$fake) { const f = makeFake(a.init); snapshot = f.snapshot; return f.instance; } return a; });
  try {
    // vm's timeout stops a synchronous loop; ponytail: an async body that spins is left to the child's 300 s timeout
    const r = await runInNewContext("f(...a)", { f: mod[name], a: real }, { timeout: 200 });
    return J([r ?? null, snapshot ? snapshot() : null]);
  } catch (e: J) { return e?.code === "ERR_SCRIPT_EXECUTION_TIMEOUT" ? "hang" : "throw"; }
}
/** Where two outcomes differ, indexes dropped: what a person reads, once per class. */
function diffPaths(a: J, b: J, path = ""): string[] {
  if (J(a) === J(b)) return [];
  if (a && b && typeof a === "object" && typeof b === "object" && Array.isArray(a) === Array.isArray(b)) {
    const keys = Array.isArray(a) ? [...Array(Math.max(a.length, b.length)).keys()] : [...new Set([...Object.keys(a), ...Object.keys(b)])];
    return keys.flatMap((k) => diffPaths(a[k], b[k], Array.isArray(a) ? `${path}[]` : `${path}.${k}`));
  }
  return [path || "."];
}
const stop = (s: string) => s === "throw" || s === "hang";
const classOf = (a: string, b: string) => (stop(a) || stop(b) ? `${stop(a) ? a : "ok"}:A ${stop(b) ? b : "ok"}:B` : [...new Set(diffPaths(JSON.parse(a), JSON.parse(b)))].sort().join(" ") || "order");

/** Keep inputs that respect literal unions: a `phase` seen in the examples, and an object with a `type` only in a (type, keys) pair the examples show.
 *  ponytail: named keys, enough for these regions; a real version asks the type checker. */
function literalKeys(v: J, acc: { phases: Set<string>; tagged: Set<string> }) {
  if (Array.isArray(v)) v.forEach((x) => literalKeys(x, acc));
  else if (v && typeof v === "object") {
    if ("$fake" in v) return;
    if (typeof v.phase === "string") acc.phases.add(v.phase);
    if (typeof v.type === "string") acc.tagged.add(J([v.type, Object.keys(v).sort()]));
    Object.values(v).forEach((x) => literalKeys(x, acc));
  }
}
function respects(v: J, seen: { phases: Set<string>; tagged: Set<string> }): boolean {
  if (Array.isArray(v)) return v.every((x) => respects(x, seen));
  if (!v || typeof v !== "object" || "$fake" in v) return true;
  if ("phase" in v && !seen.phases.has(v.phase)) return false;
  if ("type" in v && !seen.tagged.has(J([v.type, Object.keys(v).sort()]))) return false;
  return Object.values(v).every((x) => respects(x, seen));
}

/** The input shows gap g when A is wrong in that gap's way. */
const GAPS: Record<string, Record<string, (args: J[], a: string, r: string) => boolean>> = {
  "model.parseOutput": {
    "parseOutput no body": ([raw], a, r) => { const o = asJson(raw); return !!o && !Array.isArray(o) && !("body" in o) && a !== r; },
    "parseOutput bad import items": (_, a, r) => a.includes('"ok":true') && r.includes("bad-imports"),
    "parseOutput check order": (_, a, r) => a.includes("bad-imports") && r.includes("unexpected-property"),
  },
  "p2p.broadcast": {
    "broadcast unknown peer": (args, a, r) => a === "throw" && r !== "throw" && !args[1].some((p: J) => p.self === "__proto__"),
    "broadcast __proto__ peer": (args, a, r) => a !== r && Array.isArray(args[1]) && args[1].some((p: J) => p.self === "__proto__"),
  },
  "p2p.decodeLengthPrefixed": { "decoder hang (found here, not one of the 7)": (_, a, r) => a === "hang" && r !== "hang" },
  "p2p.onGossip": {
    "onGossip unsorted": ([st, , , fan], a, r) => a !== r && fan >= 0 && J([...st.peers].sort()) !== J(st.peers),
    "onGossip negative fanout": ([st, , , fan], a, r) => a !== r && fan < 0 && J([...st.peers].sort()) === J(st.peers),
  },
};

async function region(bDir: string, id: string, runs: number, mode: string) {
  const file = FILES[id]!, name = id.split(".")[1]!;
  const load = async (d: string) => import(resolve(d, file));
  const A = await load(`${REPO}/selfhost`), R = await load(`${REPO}/stage0`), B = await load(bDir);
  const owned = (d: string) => { const t = readFileSync(resolve(d, file), "utf8"); return t.slice(t.indexOf(`// @openarc:begin ${id}\n`), t.indexOf(`// @openarc:end ${id}\n`)); };
  if (owned(bDir).includes(`arc.todo("${id}")`)) return { body: bDir, region: id, noBody: true };
  if (bDir !== `${REPO}/stage0` && owned(bDir) === owned(`${REPO}/selfhost`)) return { body: bDir, region: id, sameAsA: true }; // no second opinion: never count it as agreement
  const makeFake = id === "p2p.broadcast" ? (await import(`${REPO}/stage0/tests/fakes/palette.net.ts`)).default : null;
  const examples = specOf(R, name);
  const inputs: J[][] = [];
  const seen = new Set<string>();
  const old = mode === "structural" ? [] : (engine.oracleInputs(examples, runs, 1) as J[][]);
  const add = mode === "oracle" ? [] : structuralInputs(examples, runs);
  const lit = { phases: new Set<string>(), tagged: new Set<string>() };
  literalKeys(examples.map((e: J) => e.args), lit);
  for (const a of [...old, ...add]) if (!seen.has(J(a)) && respects(a, lit)) seen.add(J(a)), inputs.push(a);
  const gapSpec = GAPS[id] ?? {};
  const gaps: Record<string, { inputs: number; caught: number; example?: J }> = Object.fromEntries(Object.keys(gapSpec).map((g) => [g, { inputs: 0, caught: 0 }]));
  const classes: Record<string, { n: number; real: number; example: J }> = {};
  let disagree = 0, real = 0, falseAlarm = 0, aWrong = 0, hangs = { a: 0, b: 0, r: 0 } as Record<string, number>;
  for (const args of inputs) {
    const a = await call(A, name, args, makeFake), b = await call(B, name, args, makeFake), r = await call(R, name, args, makeFake);
    if (a !== r) aWrong++;
    if (a === "hang") hangs.a!++; if (b === "hang") hangs.b!++; if (r === "hang") hangs.r!++;
    for (const [g, test] of Object.entries(gapSpec)) if (test(args, a, r)) { gaps[g]!.inputs++; if (a !== b) { gaps[g]!.caught++; gaps[g]!.example ??= { args, a, b, r }; } }
    if (a === b) continue;
    disagree++;
    if (a === r) falseAlarm++; else real++;
    const c = (classes[classOf(a, b)] ??= { n: 0, real: 0, example: { args, a, b, r } });
    c.n++; if (a !== r) c.real++;
  }
  return { body: bDir, region: id, inputs: inputs.length, hangs, aWrong, disagree, real, falseAlarm, classes: Object.keys(classes).length, gaps, classList: classes };
}

if (process.argv[1] === here) {
  const flag = (n: string, d: string) => { const i = process.argv.indexOf(n); return i < 0 ? d : process.argv[i + 1]!; };
  const runs = Number(flag("--runs", "2000")), mode = flag("--mode", "both"), one = flag("--region", "");
  const bDir = process.argv[2] === "stage0" ? `${REPO}/stage0` : resolve(process.argv[2]!);
  if (one) console.log(J(await region(bDir, one, runs, mode)));
  else for (const id of REGIONS) { // a child per region: a body can hang on a strange input
    const r = spawnSync(process.execPath, ["--no-warnings", here, process.argv[2]!, "--region", id, "--runs", String(runs), "--mode", mode], { encoding: "utf8", timeout: 300_000, maxBuffer: 1 << 28 });
    console.log(r.status === 0 ? r.stdout.trim() : J({ body: bDir, region: id, crashed: r.signal ?? r.status, stderr: r.stderr?.slice(-300) }));
  }
}
