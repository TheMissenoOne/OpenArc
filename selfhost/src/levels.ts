// The levels above the module specs: the concept (what the project is for), the architecture (its parts, which part uses
// which, the packages it depends on), then the `.arc` modules, then the code. Each level is checked against the one below.
// Line-oriented like arc.ts: a heading at column 0, two-space indented children, JSON-quoted intent strings, and
// print(parse(x)) === x for any text the printer produced. Language-neutral: the imports come from each file's language
// (lang/lang.ts imports).
//
//   architecture game                    concept game
//     "intent"                             "What the project is."
//   external three                       goal voice
//     "3D rendering"                         "The player talks to the daemon."
//   part sim                                 part daemon
//     "Deterministic simulation."          nongoal
//     module src/survival.js                 "Multiplayer."
//     module src/worldos/**                term Daemon
//     uses three                             "The AI companion."
import type { Ports } from "./types.ts";
import { CODE, STATE_FILE, isTest, walk, type DecompileState } from "./decompile.ts";
import { LANGS } from "./lang/lang.ts";
export { importsOf } from "./lang/ts.ts";

export const ARCH_FILE = "arc/architecture.arc";
export const CONCEPT_FILE = "arc/concept.arc";

export interface ArchPart { name: string; intent: string[]; modules: string[]; uses: string[] }
export interface ArchExternal { name: string; intent: string[] }
export interface Arch { name: string; intent: string[]; externals: ArchExternal[]; parts: ArchPart[] }
export interface Goal { name: string; intent: string[]; parts: string[] }
export interface Concept { name: string; intent: string[]; goals: Goal[]; nongoals: string[][]; terms: { name: string; intent: string[] }[] }
/** An import: `to` is a source file, or the package name when `external`. */
export interface Edge { from: string; to: string; external: boolean }
export interface Report { ok: boolean; violations: string[]; warnings: string[] }

// ── shared line reading ──
interface Line { n: number; text: string }
interface Block extends Line { kids: Line[] }

function blocks(text: string): Block[] {
  const out: Block[] = [];
  for (const [i, raw] of text.replaceAll("\r\n", "\n").split("\n").entries()) {
    const line = raw.trimEnd();
    if (!line.trim()) continue;
    if (!line.startsWith("  ")) out.push({ n: i + 1, text: line, kids: [] });
    else if (!out.length) throw new Error(`line ${i + 1}: an indented line needs a heading above it`);
    else out.at(-1)!.kids.push({ n: i + 1, text: line.trim() });
  }
  return out;
}

const at = <T>(n: number, f: () => T): T => {
  try { return f(); } catch (e) { throw new Error(`line ${n}: ${(e as Error).message}`); }
};
const str = (t: string): string => {
  if (!/^"(?:[^"\\]|\\.)*"$/.test(t)) throw new Error("expected one quoted string");
  return JSON.parse(t) as string;
};
const fail = (message: string): never => { throw new Error(message); };
const intents = (kids: Line[], under: string) => kids.map((k) => at(k.n, () => (k.text.startsWith('"') ? str(k.text) : fail(`only intent strings belong under ${under}`))));
const quoted = (intent: string[]) => intent.map((l) => `  ${JSON.stringify(l)}`);

function header(bs: Block[], word: string): [string, string[]] {
  const m = bs[0] && new RegExp(`^${word}\\s+(\\S+)$`).exec(bs[0].text);
  if (!m) throw new Error(`line ${bs[0]?.n ?? 1}: a file starts with \`${word} <name>\``);
  return [m[1]!, intents(bs[0]!.kids, word)];
}

function unique(names: string[], what: string, n: number): void {
  if (new Set(names).size !== names.length) throw new Error(`line ${n}: duplicate ${what} ${names.at(-1)}`);
}

// ── architecture ──
export function printArch(a: Arch): string {
  const out = [`architecture ${a.name}`, ...quoted(a.intent)];
  if (a.externals.length) out.push("");
  for (const e of a.externals) out.push(`external ${e.name}`, ...quoted(e.intent));
  for (const p of a.parts) out.push("", `part ${p.name}`, ...quoted(p.intent), ...p.modules.map((m) => `  module ${m}`), ...p.uses.map((u) => `  uses ${u}`));
  return out.join("\n") + "\n";
}

/** Parse `arc/architecture.arc`. Errors carry the 1-based line: `line 7: expected external or part`. */
export function parseArch(text: string): Arch {
  const bs = blocks(text);
  const [name, intent] = header(bs, "architecture");
  const a: Arch = { name, intent, externals: [], parts: [] };
  for (const b of bs.slice(1)) {
    const m = at(b.n, () => /^(external|part)\s+(\S+)$/.exec(b.text) ?? fail("expected external or part"));
    if (m[1] === "external") {
      a.externals.push({ name: m[2]!, intent: intents(b.kids, "external") });
      unique(a.externals.map((e) => e.name), "external", b.n);
      continue;
    }
    const p: ArchPart = { name: m[2]!, intent: [], modules: [], uses: [] };
    a.parts.push(p);
    unique(a.parts.map((x) => x.name), "part", b.n);
    // ponytail: paths with spaces cannot be written; quote them when a project needs that
    for (const k of b.kids) at(k.n, () => {
      const kid = /^(module|uses)\s+(\S+)$/.exec(k.text);
      if (k.text.startsWith('"')) p.intent.push(str(k.text));
      else if (!kid) throw new Error("expected an intent string, module or uses");
      else if (kid[1] === "module") p.modules.push(kid[2]!);
      else if (!p.uses.includes(kid[2]!)) p.uses.push(kid[2]!);
    });
  }
  return a;
}

/** A module line is a file path, or `dir/**` for the directory and everything under it. */
const matches = (pattern: string, file: string) => (pattern.endsWith("/**") ? file.startsWith(pattern.slice(0, -2)) : file === pattern);
const dirOf = (f: string) => f.slice(0, Math.max(0, f.lastIndexOf("/")));

function owners(a: Arch, files: string[]): Map<string, ArchPart[]> {
  return new Map(files.map((f) => [f, a.parts.filter((p) => p.modules.some((m) => matches(m, f)))]));
}

// ── reading the code (the one language-specific step) ──
/** The source files under `dirs` that are not tests, with their text. Same file set as decompile. */
export async function sources(ports: Ports, dirs: string[]): Promise<Map<string, string>> {
  const files = (await Promise.all(dirs.map((d) => walk(ports, d)))).flat().filter((f) => CODE.test(f) && !isTest(f));
  return new Map(await Promise.all(files.map(async (f) => [f, (await ports.fs.read(f)) ?? ""] as const)));
}

/** Every import of the given files, each file read by its language (lang/lang.ts). */
export async function projectImports(ports: Ports, files: Map<string, string>): Promise<Edge[]> {
  const out: Edge[] = [];
  for (const lang of LANGS) {
    const mine = new Map([...files].filter(([f]) => lang.code.test(f)));
    if (mine.size) out.push(...(await lang.imports(ports, mine)));
  }
  return out;
}

// ── architecture from the code ──
/** Adds what the code shows and the file lacks, and never removes: a file in no part goes to the part that holds a
 *  sibling from its directory, else to a part named after its directory; a part created now gets the uses and externals
 *  its imports need. One line per addition. */
export function updateArch(a: Arch, files: string[], edges: Edge[]): string[] {
  const added: string[] = [], fresh = new Set<ArchPart>(), owner = owners(a, files);
  for (const f of files) {
    if (owner.get(f)!.length) continue;
    const dir = dirOf(f), name = dir.replaceAll("/", ".");
    let p = a.parts.find((x) => files.some((g) => dirOf(g) === dir && owner.get(g)!.includes(x))) ?? a.parts.find((x) => x.name === name);
    if (!p) {
      a.parts.push((p = { name, intent: [], modules: [], uses: [] }));
      fresh.add(p);
      added.push(`part ${name}`);
    }
    p.modules.push(f);
    owner.set(f, [p]);
    added.push(`module ${f} to part ${p.name}`);
  }
  for (const e of edges) {
    const p = owner.get(e.from)?.[0];
    if (!p || !fresh.has(p)) continue;
    const to = e.external ? e.to : owner.get(e.to)?.[0]?.name;
    if (!to || to === p.name || p.uses.includes(to)) continue;
    p.uses.push(to);
    added.push(`uses ${to} to part ${p.name}`);
    if (e.external && !a.externals.some((x) => x.name === to)) { a.externals.push({ name: to, intent: [] }); added.push(`external ${to}`); }
  }
  for (const p of fresh) p.uses.sort();
  return added;
}

/** The first architecture: one part per directory, uses and externals from the imports, sorted. */
export function deriveArch(name: string, files: string[], edges: Edge[]): Arch {
  const a: Arch = { name, intent: [], externals: [], parts: [] };
  updateArch(a, files, edges);
  a.parts.sort((x, y) => (x.name < y.name ? -1 : 1));
  a.externals.sort((x, y) => (x.name < y.name ? -1 : 1));
  return a;
}

/** Strongly connected groups of parts through their declared uses, each listed once.
 *  ponytail: a group is reported, not each elementary cycle inside it. */
function cycles(parts: ArchPart[]): string[][] {
  const next = new Map(parts.map((p) => [p.name, p.uses.filter((u) => u !== p.name && parts.some((q) => q.name === u))]));
  const index = new Map<string, number>(), low = new Map<string, number>(), stack: string[] = [], out: string[][] = [];
  const visit = (v: string): void => {
    index.set(v, index.size);
    low.set(v, index.get(v)!);
    stack.push(v);
    for (const w of next.get(v)!) {
      if (!index.has(w)) { visit(w); low.set(v, Math.min(low.get(v)!, low.get(w)!)); }
      else if (stack.includes(w)) low.set(v, Math.min(low.get(v)!, index.get(w)!));
    }
    if (low.get(v) !== index.get(v)) return;
    const group: string[] = [];
    let w: string;
    do group.push((w = stack.pop()!)); while (w !== v);
    if (group.length > 1) out.push(group.sort());
  };
  for (const p of parts) if (!index.has(p.name)) visit(p.name);
  return out;
}

/** The architecture against the real imports. */
export function checkArch(a: Arch, files: string[], edges: Edge[]): Report {
  const violations: string[] = [], warnings: string[] = [], owner = owners(a, files);
  const parts = new Set(a.parts.map((p) => p.name)), exts = new Set(a.externals.map((e) => e.name));
  for (const [f, ps] of owner) {
    if (!ps.length) violations.push(`${f} belongs to no part`);
    else if (ps.length > 1) violations.push(`${f} belongs to more than one part: ${ps.map((p) => p.name).join(", ")}`);
  }
  for (const p of a.parts) {
    for (const m of p.modules) if (!files.some((f) => matches(m, f))) violations.push(`part ${p.name}: module ${m} matches no file`);
    for (const u of p.uses) if (!parts.has(u) && !exts.has(u)) violations.push(`part ${p.name} uses ${u}, which is neither a part nor an external`);
  }
  const needed = new Set<string>();
  for (const e of edges) {
    const from = owner.get(e.from) ?? [], to = e.external ? [] : owner.get(e.to) ?? [];
    if (from.length !== 1 || (!e.external && (to.length !== 1 || to[0] === from[0]))) continue; // unowned: reported above
    const p = from[0]!, target = e.external ? e.to : to[0]!.name;
    needed.add(`${p.name}\0${target}`);
    if (e.external && !exts.has(target)) violations.push(`${e.from} imports ${target}, which has no external line`);
    if (!p.uses.includes(target)) violations.push(`${e.from} imports ${e.external ? target : `${e.to} (part ${target})`}, but part ${p.name} does not use ${target}`);
  }
  for (const p of a.parts) for (const u of p.uses) if ((parts.has(u) || exts.has(u)) && !needed.has(`${p.name}\0${u}`)) warnings.push(`part ${p.name} uses ${u}, but no import needs it`);
  for (const c of cycles(a.parts)) warnings.push(`parts ${c.join(", ")} use each other in a cycle`);
  return { ok: !violations.length, violations, warnings };
}

// ── concept ──
export function printConcept(c: Concept): string {
  const out = [`concept ${c.name}`, ...quoted(c.intent)];
  for (const g of c.goals) out.push("", `goal ${g.name}`, ...quoted(g.intent), ...g.parts.map((p) => `  part ${p}`));
  for (const n of c.nongoals) out.push("", "nongoal", ...quoted(n));
  for (const t of c.terms) out.push("", `term ${t.name}`, ...quoted(t.intent));
  return out.join("\n") + "\n";
}

/** Parse `arc/concept.arc`. Errors carry the 1-based line. */
export function parseConcept(text: string): Concept {
  const bs = blocks(text);
  const [name, intent] = header(bs, "concept");
  const c: Concept = { name, intent, goals: [], nongoals: [], terms: [] };
  for (const b of bs.slice(1)) {
    const m = at(b.n, () => /^(?:goal\s+(\S+)|(nongoal)|term\s+(\S.*))$/.exec(b.text) ?? fail("expected goal, nongoal or term"));
    if (m[2]) { c.nongoals.push(intents(b.kids, "nongoal")); continue; }
    if (m[3]) { c.terms.push({ name: m[3], intent: intents(b.kids, "term") }); unique(c.terms.map((t) => t.name), "term", b.n); continue; }
    const g: Goal = { name: m[1]!, intent: [], parts: [] };
    c.goals.push(g);
    unique(c.goals.map((x) => x.name), "goal", b.n);
    for (const k of b.kids) at(k.n, () => {
      const part = /^part\s+(\S+)$/.exec(k.text);
      if (k.text.startsWith('"')) g.intent.push(str(k.text));
      else if (part) g.parts.push(part[1]!);
      else throw new Error("expected an intent string or part");
    });
  }
  return c;
}

/** Every goal traces to parts the architecture has. `parts`: the architecture's part names. */
export function checkConcept(c: Concept, parts: string[]): Report {
  const violations: string[] = [], warnings: string[] = [];
  for (const g of c.goals) {
    if (!g.parts.length) violations.push(`goal ${g.name} names no part`);
    for (const p of g.parts) if (!parts.includes(p)) violations.push(`goal ${g.name} names part ${p}, which ${ARCH_FILE} does not have`);
  }
  for (const p of parts) if (!c.goals.some((g) => g.parts.includes(p))) warnings.push(`part ${p}: no goal names it`);
  if (!c.intent.length) warnings.push("the concept has no intent");
  return { ok: !violations.length, violations, warnings };
}

export const formatReport = (r: Report, json: boolean): string =>
  json ? JSON.stringify(r) : [...r.violations.map((l) => `violation: ${l}`), ...r.warnings.map((l) => `warning: ${l}`), `${r.ok ? "ok" : "failed"}: ${r.violations.length} violations, ${r.warnings.length} warnings`].join("\n");

// ── status: what backs each goal and part, read across the levels ──
// A goal is prose: no machine proves it. The roll-up only says what was checked below it, never "verified".
/** Function statuses, weakest first. A name not listed (a newer or older decompile's) ranks just before `described`. */
export const STRENGTH = ["failing", "bare", "described", "observed", "examples", "specified", "tested"];
const rank = (s: string) => (STRENGTH.includes(s) ? STRENGTH.indexOf(s) : STRENGTH.indexOf("described") - 0.5);

/** `counts`: functions per status, strongest first. `weakest`: the weakest status present, null with no functions. */
export interface Backing { modules: string[]; functions: number; counts: Record<string, number>; skipped: number; weakest: string | null }
export interface PartStatus extends Backing { name: string; notDecompiled: string[] }
export interface GoalStatus extends Backing { name: string; parts: string[]; unknownParts: string[]; notDecompiled: string[] }
export interface Status { goals: GoalStatus[]; parts: PartStatus[]; unassigned: Backing | null; totals: Backing; missing: string[] }

/** What the decompile state records for these source files. */
export function backing(s: DecompileState, files: string[]): Backing {
  const counts: Record<string, number> = {};
  let skipped = 0;
  for (const f of files) {
    for (const fn of Object.values(s.modules[f]?.fns ?? {})) counts[fn.status] = (counts[fn.status] ?? 0) + 1;
    skipped += Object.keys(s.modules[f]?.skipped ?? {}).length;
  }
  const names = Object.keys(counts).sort((a, b) => rank(b) - rank(a) || (a < b ? -1 : 1));
  return { modules: files, functions: names.reduce((n, k) => n + counts[k]!, 0), counts: Object.fromEntries(names.map((k) => [k, counts[k]!])), skipped, weakest: names.at(-1) ?? null };
}

/** The roll-up: each part over the decompiled files its module lines match (the matching `arch --check` uses), the files
 *  in no part, each goal over the files of the parts it names (each file once), and the total. A missing level is null. */
export function rollUp(s: DecompileState, a: Arch | null, c: Concept | null): Status {
  const files = Object.keys(s.modules).sort(), owner = owners(a ?? { name: "", intent: [], externals: [], parts: [] }, files);
  const parts = (a?.parts ?? []).map((p) => ({ name: p.name, ...backing(s, files.filter((f) => owner.get(f)!.includes(p))), notDecompiled: p.modules.filter((m) => !files.some((f) => matches(m, f))) }));
  const goals = (c?.goals ?? []).map((g) => {
    const mine = parts.filter((p) => g.parts.includes(p.name));
    return { name: g.name, parts: g.parts, unknownParts: g.parts.filter((n) => !mine.some((p) => p.name === n)), ...backing(s, [...new Set(mine.flatMap((p) => p.modules))].sort()), notDecompiled: [...new Set(mine.flatMap((p) => p.notDecompiled))] };
  });
  const loose = files.filter((f) => !owner.get(f)!.length);
  return { goals, parts, unassigned: loose.length ? backing(s, loose) : null, totals: backing(s, files), missing: [...(c ? [] : [CONCEPT_FILE]), ...(a ? [] : [ARCH_FILE])] };
}

const MAKES: Record<string, string> = { [CONCEPT_FILE]: "concept", [ARCH_FILE]: "arch", [STATE_FILE]: "decompile" };
export const missingLine = (file: string) => `no ${file}; run \`openarc ${MAKES[file]}\` to write it`;
const counted = (b: Backing) => `${b.functions} functions${b.functions ? ` (${Object.entries(b.counts).map(([k, n]) => `${k} ${n}`).join(", ")}); weakest ${b.weakest}` : ""}${b.skipped ? `; ${b.skipped} skipped` : ""}`;
const notYet = (l: string[]) => (l.length ? `; not decompiled: ${l.join(", ")}` : "");
const itemLine = (x: PartStatus | GoalStatus) => "parts" in x
  ? `goal ${x.name}: parts ${x.parts.join(", ") || "none"}: ${counted(x)}${x.unknownParts.map((p) => `; part ${p} is not in ${ARCH_FILE}`).join("")}${notYet(x.notDecompiled)}`
  : `part ${x.name}: ${x.modules.length} modules, ${counted(x)}${notYet(x.notDecompiled)}`;

/** One line per missing level, goal, part, then the unassigned files and the total. */
export const formatStatus = (r: Status): string =>
  [...r.missing.map(missingLine), ...r.goals.map(itemLine), ...r.parts.map(itemLine), ...(r.unassigned ? [`unassigned: ${r.unassigned.modules.length} modules, ${counted(r.unassigned)}`] : []), `total: ${r.totals.modules.length} modules, ${counted(r.totals)}`].join("\n");

/** One part or goal: its line, a line per module, then its failing and bare functions with why (the first 20). */
export function statusDetail(x: PartStatus | GoalStatus, s: DecompileState): string {
  const weak = x.modules.flatMap((f) => Object.entries(s.modules[f]!.fns).filter(([, fn]) => rank(fn.status) <= rank("bare")).map(([name, fn]) => ({ f, name, ...fn })))
    .sort((a, b) => rank(a.status) - rank(b.status)) // stable: failing first, then source order
    .map((w) => `  ${w.status} ${w.f} ${w.name}${w.why ? `: ${w.why}` : ""}`);
  return [itemLine(x), ...x.modules.map((f) => `  ${f}: ${counted(backing(s, [f]))}`), ...x.notDecompiled.map((m) => `  ${m}: not decompiled`), ...weak.slice(0, 20), ...(weak.length > 20 ? [`  and ${weak.length - 20} more`] : [])].join("\n");
}

/** package.json's name, else the folder's. */
export async function projectName(ports: Ports, root: string): Promise<string> {
  let name: unknown;
  try { name = (JSON.parse((await ports.fs.read("package.json")) ?? "{}") as { name?: unknown }).name; } catch { /* no usable package.json */ }
  return (typeof name === "string" && name ? name : root.split(/[/\\]/).filter(Boolean).at(-1) ?? "project").replace(/\s+/g, "-");
}
