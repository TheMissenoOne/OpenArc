// Concepts (SPEC §2.5): a family of regions that share an intent and laws. HAND-WRITTEN bootstrap code, not a region.
// A concept is `arc.defineConcept({ id, intent, laws })`; a variant is an ordinary region with `concept`, `fixtures`
// and `waive`. Laws are example templates: each one becomes an authoritative example of every variant, with the
// variant's fixtures substituted. Nothing is expanded at runtime and no variant body is ever shown to another region.
import ts from "typescript";
import type { Json } from "open-arc";
import { posix } from "node:path";
import { canonicalJson, sha256Tagged } from "./hash.ts";
import type { Diagnostic } from "./types.ts";

export interface ConceptInfo {
  id: string;
  file: string;
  intent: string;
  laws: { name: string; [k: string]: Json }[];
  interface?: string;
  hash: string; // part of every variant's spec hash: changing a law recompiles every variant
}

/** The shape of a spec this module reads (engine.SpecInfo, structurally). */
interface VariantSpec {
  id: string;
  kind: "function" | "block";
  file: string;
  symbol: string;
  literal: { [k: string]: Json };
  examples: Json[];
  typeText: string;
  typeNode?: ts.TypeNode;
}

const intentText = (v: Json | undefined) => (Array.isArray(v) ? v.join(" ") : typeof v === "string" ? v : "");

/** A `defineConcept` literal (already read by the §2.2 static reader) -> ConceptInfo, or an E010 detail. */
export function readConcept(literal: Json | undefined, file: string): ConceptInfo | { error: string } {
  if (!literal || typeof literal !== "object" || Array.isArray(literal) || typeof literal.id !== "string") return { error: "concept:not-static" };
  const laws = literal.laws;
  if (!Array.isArray(laws) || !laws.every((l) => typeof l === "object" && l !== null && !Array.isArray(l) && typeof l.name === "string" && Array.isArray(l.args)))
    return { error: "concept:laws-must-be-[{name, args, …}]" };
  const names = laws.map((l) => (l as { name: string }).name);
  const dup = names.find((n, i) => names.indexOf(n) !== i);
  if (dup) return { error: `concept:duplicate-law:${dup}` };
  return {
    id: literal.id, file, intent: intentText(literal.intent), laws: laws as ConceptInfo["laws"],
    ...(typeof literal.interface === "string" ? { interface: literal.interface } : {}),
    hash: sha256Tagged(canonicalJson(literal)),
  };
}

/** Replace every "$fixture:<name>" string anywhere in `v` with fixtures[name]. Throws the missing name. */
function substitute(v: Json, fixtures: { [k: string]: Json }): Json {
  if (typeof v === "string" && v.startsWith("$fixture:")) {
    const k = v.slice("$fixture:".length);
    if (!Object.hasOwn(fixtures, k)) throw new Error(k);
    return fixtures[k]!;
  }
  if (Array.isArray(v)) return v.map((x) => substitute(x, fixtures));
  if (v !== null && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, substitute(x, fixtures)]));
  return v;
}

/** The variant's examples: one `law: <name>` example per law it doesn't waive, then its own examples. Shared by the
 *  compiler (static JSON) and tools/run-examples.ts (runtime objects): pure JSON substitution, no evaluation. */
export function expandLaws(concept: { laws: readonly unknown[] }, variant: { fixtures?: unknown; waive?: unknown; examples?: readonly unknown[] }): { examples: Json[]; waived: [string, string][]; error?: string } {
  const fixtures = (variant.fixtures ?? {}) as { [k: string]: Json };
  const waive = (variant.waive ?? {}) as { [k: string]: string };
  const laws = concept.laws as { name: string; [k: string]: Json }[];
  const out: Json[] = [];
  const waived: [string, string][] = [];
  const unknown = Object.keys(waive).find((w) => !laws.some((l) => l.name === w));
  if (unknown) return { examples: [], waived, error: `waive-unknown-law:${unknown}` };
  for (const law of laws) {
    if (Object.hasOwn(waive, law.name)) {
      waived.push([law.name, waive[law.name]!]);
      continue;
    }
    try {
      out.push({ ...(substitute(law, fixtures) as { [k: string]: Json }), name: `law: ${law.name}` });
    } catch (e) {
      return { examples: [], waived, error: `fixture-missing:${(e as Error).message}` };
    }
  }
  return { examples: [...out, ...((variant.examples ?? []) as Json[])], waived };
}

/** After extraction: give every variant its law examples, its concept hash and the interface check (§2.4, E020). */
export function applyConcepts(specs: Map<string, VariantSpec>, concepts: Map<string, ConceptInfo>, checker: ts.TypeChecker, program: ts.Program, root: string): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const s of [...specs.values()]) {
    const cid = s.literal.concept;
    if (cid === undefined) continue;
    const bad = (detail: string, code: Diagnostic["code"] = "OARC-E010") => out.push({ code, id: s.id, file: s.file, detail });
    const c = typeof cid === "string" ? concepts.get(cid) : undefined;
    if (!c || s.kind !== "function") {
      bad(`concept-unknown:${String(cid)}`);
      continue;
    }
    const ex = expandLaws(c, s.literal);
    if (ex.error) {
      bad(ex.error);
      continue;
    }
    if (c.interface && !instanceOf(s, c, checker, program, root)) {
      bad(`concept-interface:${c.interface}`, "OARC-E020");
      continue;
    }
    s.examples = ex.examples;
    s.literal.$concept = c.hash;
  }
  return out;
}

/** F names the concept's interface (`Strategy<PasswordCred>` for `interface: "Strategy"`), or is assignable to it when
 *  the interface is not generic. */
function instanceOf(s: VariantSpec, c: ConceptInfo, checker: ts.TypeChecker, program: ts.Program, root: string): boolean {
  const n = s.typeNode;
  if (n && ts.isTypeReferenceNode(n) && (ts.isIdentifier(n.typeName) ? n.typeName.text : n.typeName.right.text) === c.interface) return true;
  const sf = program.getSourceFile(`${root}/${c.file}`);
  const decl = sf?.statements.find((st): st is ts.TypeAliasDeclaration | ts.InterfaceDeclaration => (ts.isTypeAliasDeclaration(st) || ts.isInterfaceDeclaration(st)) && st.name.text === c.interface);
  if (!decl || !n || decl.typeParameters?.length) return false;
  return checker.isTypeAssignableTo(checker.getTypeFromTypeNode(n), checker.getTypeAtLocation(decl.name));
}

/** One line a caller sees next to a variant's signature: what the concept promises, never the variant's body. */
export const conceptNote = (c: ConceptInfo): string => `// variant of concept ${c.id}: ${c.intent}${c.intent.endsWith(".") ? "" : "."} Laws: ${c.laws.map((l) => l.name).join("; ")}.`;

/** Waived laws of a variant, for the compile log and the manifest provenance. */
export const waivers = (s: { literal: { [k: string]: Json } }): [string, string][] =>
  Object.entries((s.literal.waive ?? {}) as { [k: string]: string }).filter(([, v]) => typeof v === "string");

interface ContextSpec {
  id: string;
  file: string;
  symbol: string;
  kind: string;
  typeText: string;
  literal: { [k: string]: Json };
  sketch?: { callees: { path: string; file: string; name: string; type: string }[] };
}

/** Package sections after the intent (§8.8): for a variant, its concept; for a sketch, the functions it calls; for any
 *  region, the concept variants it can call through the file's imports, each with the concept's one-line summary. */
export function extraSections(specs: Map<string, ContextSpec>, concepts: Map<string, ConceptInfo>, s: ContextSpec, fileText: string): [string, string][] {
  const out: [string, string][] = [];
  const variantOf = (file: string, name: string) => [...specs.values()].find((x) => x.file === file && x.symbol === name && typeof x.literal.concept === "string");
  const noteFor = (v: ContextSpec | undefined) => {
    const c = v && concepts.get(v.literal.concept as string);
    return c ? `  ${conceptNote(c)}` : "";
  };
  const own = typeof s.literal.concept === "string" ? concepts.get(s.literal.concept) : undefined;
  if (own) {
    const w = waivers(s);
    out.push(["Concept", [
      `This region is the "${s.symbol}" variant of concept ${own.id}: ${own.intent}`,
      "Its examples below include the concept's laws (named \"law: …\") with this variant's fixtures. They are authoritative.",
      ...(w.length ? [`Waived for this variant: ${w.map(([l, why]) => `${l} (${why})`).join("; ")}.`] : []),
    ].join("\n")]);
  }
  if (s.sketch?.callees.length) {
    out.push(["Functions the sketch calls", s.sketch.callees.map((c) => `${c.path}: ${c.type}${noteFor(variantOf(c.file, c.name))}`).join("\n")]);
    return out;
  }
  // a prose region: the variants its file imports
  const lines: string[] = [];
  const sf = ts.createSourceFile("i.ts", fileText, ts.ScriptTarget.Latest, true);
  for (const d of sf.statements.filter(ts.isImportDeclaration)) {
    const spec = (d.moduleSpecifier as ts.StringLiteral).text;
    const nb = d.importClause?.namedBindings;
    if (!spec.startsWith(".") || !nb || d.importClause?.isTypeOnly) continue;
    const file = posix.normalize(posix.join(posix.dirname(s.file), spec));
    for (const v of [...specs.values()].filter((x) => x.file === file && typeof x.literal.concept === "string")) {
      const path = ts.isNamespaceImport(nb) ? `${nb.name.text}.${v.symbol}` : nb.elements.find((e) => (e.propertyName ?? e.name).text === v.symbol)?.name.text;
      if (path) lines.push(`${path}: ${v.typeText}${noteFor(v)}`);
    }
  }
  if (lines.length) out.push(["Concept variants you can call", lines.join("\n")]);
  return out;
}
