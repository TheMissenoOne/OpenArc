// `openarc lint`: spec rules over the project, deterministic and offline. HAND-WRITTEN, not a region.
// It parses and analyzes the project exactly like `graph` (engine.analyze with offline: true: no model, no sandbox, no
// network), then checks each function region's spec. Compile never reads any of this: lint only reports.
import { posix } from "node:path";
import ts from "typescript";
import type { Json } from "open-arc";
import type { CompileRequest, Diagnostic, Ports } from "./types.ts";
import * as engine from "./engine.ts";
import * as implicit from "./implicit.ts";
import { outcomeName } from "./tests-plan.ts";
import { canonicalJson } from "./hash.ts";
import { LINT_PROFILES, LINT_RULES, parseConfig, type LintConfig, type LintProfile, type LintSeverity } from "./config.ts";

export interface Finding {
  rule: string; // spec/<rule>, or the OARC-E code of a spec error found while analysing
  severity: "warn" | "error";
  id: string;
  file: string;
  line: number;
  message: string;
}

/** Analysis errors that are about a spec (they stop compile too): reported by lint as findings, never configurable. */
const SPEC_ERRORS = new Set(["OARC-E010", "OARC-E011", "OARC-E012", "OARC-E013", "OARC-E020", "OARC-E022", "OARC-E041", "OARC-E064", "OARC-E070"]);

/** Every rule's severity for a spec in `file`: the profile < `rules` < each matching override's profile < its `rules`. */
export function severities(lint: LintConfig | undefined, file: string, profile?: LintProfile): Record<string, LintSeverity> {
  const of = (p: LintProfile) => Object.fromEntries(Object.entries(LINT_RULES).map(([k, v]) => [k, v[p === "strict" ? 1 : 0]]));
  let s = { ...of(profile ?? lint?.extends ?? "recommended"), ...lint?.rules };
  for (const o of lint?.overrides ?? [])
    if (o.files.some((g) => posix.matchesGlob(file, g))) s = { ...s, ...(o.extends ? of(o.extends) : {}), ...o.rules };
  return s;
}

// ── where a spec is written (lines on disk: analysis holds scaffolded copies whose lines shift) ──
interface Site {
  line: number; // 1-based: the declaration (after its JSDoc) or the defineRegion statement
  above: number[]; // 0-based lines a suppression comment may end on: right above the declaration's JSDoc, and above its class
}
function siteOf(text: string, s: engine.SpecInfo): Site {
  const sf = ts.createSourceFile(s.file, text, ts.ScriptTarget.Latest, true);
  const lineAt = (pos: number) => sf.getLineAndCharacterOfPosition(pos).line;
  const cf = s.codeFirst;
  if (cf) {
    const d = implicit.declarations(sf).find((x) => x.name === s.symbol && x.cls?.name?.text === cf.cls?.name?.text);
    if (d) return { line: lineAt(d.headStart) + 1, above: [lineAt(d.docNode.getStart(sf, true)) - 1, ...(d.cls ? [lineAt(d.cls.getStart(sf, true)) - 1] : [])] };
  } else {
    const st = sf.statements.find((x) => ts.isVariableStatement(x) && x.declarationList.declarations.some((d) => ts.isIdentifier(d.name) && d.name.text === s.exportName));
    if (st) return { line: lineAt(st.getStart(sf)) + 1, above: [lineAt(st.getStart(sf, true)) - 1] };
  }
  return { line: 1, above: [] };
}

interface Suppression { line: number; rules: string[]; reason: string }
const SUPPRESS = /^\s*\/\/\s*openarc-lint-disable-next-line\b(.*)$/;
/** The suppression comments stacked directly above each of `above` (a run of consecutive comment lines). */
function suppressions(lines: string[], above: number[]): Suppression[] {
  const out: Suppression[] = [];
  for (const start of above)
    for (let i = start; i >= 0; i--) {
      const m = SUPPRESS.exec(lines[i] ?? "");
      if (!m) break;
      const [ruleText, ...rest] = m[1]!.split(" -- ");
      out.push({ line: i + 1, rules: ruleText!.split(/[\s,]+/).filter(Boolean), reason: rest.join(" -- ").trim() });
    }
  return out;
}

// ── parameter and return types (boundary-cases, return-union-coverage) ──
function signatureOf(s: engine.SpecInfo, checker: ts.TypeChecker): ts.Signature | undefined {
  if (s.codeFirst) return checker.getSignatureFromDeclaration(s.codeFirst.decl);
  return s.typeNode ? checker.getTypeFromTypeNode(s.typeNode).getCallSignatures()[0] : undefined;
}
const NULLISH = ts.TypeFlags.Null | ts.TypeFlags.Undefined | ts.TypeFlags.Void;
type Kind = "number" | "string" | "array";
/** number, string or array (literal types aside: `"a" | "b"` has no empty boundary), and whether null/undefined is allowed. */
function kindOf(t: ts.Type, checker: ts.TypeChecker): { kind: Kind; nullable: boolean } | null {
  const all = t.isUnion() ? t.types : [t];
  const rest = all.filter((m) => !(m.flags & NULLISH));
  const kind: Kind | null = !rest.length ? null
    : rest.every((m) => m.flags & ts.TypeFlags.Number) ? "number"
    : rest.every((m) => m.flags & ts.TypeFlags.String) ? "string"
    : rest.every((m) => checker.isArrayType(m)) ? "array" : null;
  return kind ? { kind, nullable: rest.length < all.length } : null;
}
const BOUNDARY: Record<Kind, { arg: (v: Json) => boolean; source: RegExp; what: string }> = {
  number: { arg: (v) => v === 0 || (typeof v === "number" && v < 0) || v === "$-Infinity", source: /(?<![\w.$])0(?![\w.])|(?<![\w$)\]]\s*)-\d/, what: "0 or a negative number" },
  string: { arg: (v) => v === "", source: /""|''|``/, what: 'an empty string ("")' },
  array: { arg: (v) => Array.isArray(v) && v.length === 0, source: /\[\s*\]/, what: "an empty array ([])" },
};
const NULL_ARG = (v: Json | undefined) => v === undefined || v === null || v === "$undefined";

/** A union member's example value: a literal's value, null, "$undefined", or undefined when it isn't a single value. */
function memberValue(m: ts.Type, checker: ts.TypeChecker): Json | undefined {
  if (m.flags & ts.TypeFlags.Null) return null;
  if (m.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Void)) return "$undefined";
  if (m.flags & ts.TypeFlags.BooleanLiteral) return checker.typeToString(m) === "true";
  if (m.isStringLiteral() || m.isNumberLiteral()) return m.value;
  return undefined;
}

// ── undeclared-effects: a keyword check on the intent ──
// ponytail: the compiler's effect detection (engine.staticCheck) reads bodies, and a spec has none yet; prose is the only
// signal, so these are deliberately narrow. A seeded generator ("seed" in the intent) is not randomness.
const EFFECT_WORDS: [string, RegExp][] = [
  ["clock", /\b(current (date|time|timestamp)|today'?s date|the time now|Date\.now|wall[- ]clock|system (time|clock))\b/i],
  ["random", /\b(random(ly|ness|ized)?|shuffles?|shuffled|uuids?)\b/i],
  ["log", /\b(logs|logged|logging|console)\b|\blog (a|an|the|it|each|every)\b/i],
];

/** One function region's findings, before severities and suppressions (`id`, `file`, `line` are filled in by the caller). */
function check(r: engine.RegionInfo, checker: ts.TypeChecker, diskText: string): { rule: string; message: string }[] {
  const s = r.spec;
  const out: { rule: string; message: string }[] = [];
  const add = (rule: string, message: string) => out.push({ rule, message });
  const examples = s.examples as { name?: string; args?: Json[]; expected?: Json; throws?: Json }[];
  const tests = s.codeFirst?.tests ?? [];

  // contradictory-examples: same arguments, different outcome
  const seen = new Map<string, { i: number; outcome: string }>();
  examples.forEach((e, i) => {
    if (s.ui || !Array.isArray(e.args)) return;
    const key = canonicalJson(e.args);
    const outcome = e.throws !== undefined ? "throws" : e.expected === undefined ? null : canonicalJson(e.expected);
    if (outcome === null) return;
    const prev = seen.get(key);
    if (!prev) seen.set(key, { i, outcome });
    else if (prev.outcome !== outcome) add("spec/contradictory-examples", `examples ${label(examples, prev.i)} and ${label(examples, i)} have the same args ${key} but different outcomes`);
  });

  // duplicate-test-names
  const dups = (names: string[]) => [...new Set(names.filter((n, i) => names.indexOf(n) !== i))];
  for (const n of dups(examples.flatMap((e) => (typeof e.name === "string" ? [e.name] : [])))) add("spec/duplicate-test-names", `two examples are named ${JSON.stringify(n)}`);
  for (const n of dups(tests.map(outcomeName))) add("spec/duplicate-test-names", `two tests for this region are named ${n}`);

  // require-tests / thin-examples (OARC-W044's condition, engine.thinDetail)
  if (!engine.hasChecks(s)) add("spec/require-tests", "no example, arc.test or arc.law verifies this region: only its type is checked");
  const thin = engine.thinDetail(s);
  if (thin && engine.hasChecks(s)) add("spec/thin-examples", `thin examples (${thin}): fewer than 3, or none with an edge case (empty, zero, negative, null)`);

  // require-intent (OARC-W023 for code-first; a defineRegion may also leave it empty). A sketch, UI structure or concept is guidance enough.
  if (!s.intent.trim() && !s.sketch && !s.ui && s.literal.concept === undefined)
    add("spec/require-intent", s.codeFirst ? "no intent: no JSDoc description of its own or inherited" : "empty intent");

  const sig = signatureOf(s, checker);
  // boundary-cases: per number/string/array parameter, an example argument (or a literal in a test) at a boundary
  if (sig && !s.ui) {
    const testSource = tests.map((t) => t.source).join("\n");
    sig.getParameters().forEach((sym, i) => {
      const decl = sym.valueDeclaration;
      if (decl && ts.isParameter(decl) && decl.dotDotDotToken) return;
      const k = kindOf(checker.getTypeOfSymbol(sym), checker);
      if (!k) return;
      const b = BOUNDARY[k.kind];
      const hit = examples.some((e) => Array.isArray(e.args) && (b.arg(e.args[i] as Json) || (k.nullable && NULL_ARG(e.args[i])))) ||
        b.source.test(testSource) || (k.nullable && /\b(null|undefined)\b/.test(testSource));
      if (!hit) add("spec/boundary-cases", `parameter ${sym.name}: no example or test passes ${b.what}${k.nullable ? " or null/undefined" : ""}`);
    });
  }

  // return-union-coverage: examples only; a region with tests is skipped (what they return isn't known statically)
  const withExpected = examples.filter((e) => e.expected !== undefined);
  if (sig && !tests.length && withExpected.length) {
    const ret = sig.getReturnType();
    const t = s.isAsync ? (checker.getAwaitedType(ret) ?? ret) : ret;
    if (t.isUnion()) {
      const values = t.types.map((m) => memberValue(m, checker));
      if (values.every((v) => v !== undefined) || values.some((v) => v === null || v === "$undefined")) {
        const got = new Set(withExpected.map((e) => canonicalJson(e.expected!)));
        const missing = [...new Set(values.filter((v) => v !== undefined).map((v) => canonicalJson(v!)))].filter((v) => !got.has(v));
        if (missing.length) add("spec/return-union-coverage", `return value${missing.length > 1 ? "s" : ""} ${missing.join(", ")} never appear${missing.length > 1 ? "" : "s"} among the examples' expected values`);
      }
    }
  }

  // undeclared-effects
  const intent = s.intent;
  for (const [effect, re] of EFFECT_WORDS) {
    if (s.effects.includes(effect) || (effect === "random" && /\bseed(ed|s)?\b/i.test(intent))) continue;
    const m = re.exec(intent);
    if (m) add("spec/undeclared-effects", `the intent mentions "${m[0]}" but effects doesn't declare "${effect}"`);
  }

  // explicit-deps: the intent names an imported binding as code (`name`, name(…), name.x(…)) and there are no deps/calls
  if (!s.deps.length && s.calls === undefined) {
    const sf = ts.createSourceFile(s.file, diskText, ts.ScriptTarget.Latest, true);
    for (const st of sf.statements) {
      if (!ts.isImportDeclaration(st) || !st.importClause || st.importClause.isTypeOnly) continue;
      const from = (st.moduleSpecifier as ts.StringLiteral).text;
      if (from === "open-arc" || from.startsWith("open-arc/")) continue;
      const c = st.importClause;
      const names = [...(c.name ? [c.name.text] : []), ...(c.namedBindings && ts.isNamespaceImport(c.namedBindings) ? [c.namedBindings.name.text] : []),
        ...(c.namedBindings && ts.isNamedImports(c.namedBindings) ? c.namedBindings.elements.filter((e) => !e.isTypeOnly).map((e) => e.name.text) : [])];
      for (const n of names) {
        const q = n.replace(/\$/g, "\\$");
        if (new RegExp(`\`${q}[\`.(]|(?<![\\w$.])${q}(\\.[\\w$]+)*\\s*\\(`).test(intent))
          add("spec/explicit-deps", `the intent refers to ${n} (imported from "${from}") but the spec declares no deps or calls`);
      }
    }
  }
  return out;
}
const label = (examples: { name?: string }[], i: number) => (typeof examples[i]!.name === "string" ? JSON.stringify(examples[i]!.name) : `#${i + 1}`);

/** Lint an analysed project: every function region's findings at their configured severity, suppressions applied. */
export function lintProject(p: engine.Project, diagnostics: Diagnostic[], opts: { profile?: LintProfile; only?: string[]; message?: (code: string) => string } = {}): Finding[] {
  const lint = p.config.lint;
  const picked = (id: string | undefined, files: string[]) => !opts.only?.length || opts.only.some((o) => o === id || files.includes(o));
  const out: Finding[] = [];
  const checker = p.program?.getTypeChecker();
  for (const r of p.regions) {
    if (r.kind !== "function" || !checker || !picked(r.id, [r.file, r.spec.file])) continue;
    const text = (p.disk.get(r.spec.file) ?? "").replaceAll("\r\n", "\n");
    const lines = text.split("\n");
    const site = siteOf(text, r.spec);
    const sev = severities(lint, r.spec.file, opts.profile);
    const supp = suppressions(lines, site.above);
    const at = { id: r.id, file: r.spec.file };
    for (const s of supp)
      if (!s.reason && sev["spec/suppression-reason"] !== "off")
        out.push({ rule: "spec/suppression-reason", severity: sev["spec/suppression-reason"] as Finding["severity"], ...at, line: s.line, message: 'a suppression needs a reason: "// openarc-lint-disable-next-line <rule> -- <why>"' });
    for (const f of check(r, checker, text)) {
      const level = sev[f.rule]!;
      if (level === "off" || supp.some((s) => s.reason && s.rules.includes(f.rule))) continue;
      out.push({ rule: f.rule, severity: level, ...at, line: site.line, message: f.message });
    }
  }
  // the spec errors analysis found (compile stops on them too)
  for (const d of diagnostics)
    if (SPEC_ERRORS.has(d.code) && picked(d.id, d.file ? [d.file] : []))
      out.push({ rule: d.code, severity: "error", id: d.id ?? "-", file: d.file ?? "-", line: d.line ?? 0, message: [opts.message?.(d.code), d.detail && `[${d.detail}]`].filter(Boolean).join(" ") });
  const seen = new Set<string>();
  return out
    .filter((f) => !seen.has(JSON.stringify(f)) && !!seen.add(JSON.stringify(f)))
    .sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line || (a.id < b.id ? -1 : a.id > b.id ? 1 : a.rule < b.rule ? -1 : a.rule > b.rule ? 1 : 0)));
}

export const LINT_USAGE = "openarc lint [--strict | --profile recommended|strict] [--fail-on-warnings] [--format text|json] [ids or files...]";

/** `openarc lint`: exit 0 clean (warnings allowed unless --fail-on-warnings or lint.failOnWarnings), 1 findings at error level (or a
 *  bad config), 2 usage. `only` arguments are region ids or project-relative files. */
export async function lintCommand(ports: Ports, req: CompileRequest, args: string[], io: { out: (l: string) => void; err: (l: string) => void; message?: (code: string) => string }): Promise<number> {
  let failOnWarnings = false, format = "text", profile: LintProfile | undefined;
  const only: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--strict") profile = "strict"; // shorthand for --profile strict
    else if (a === "--fail-on-warnings") failOnWarnings = true;
    else if (a === "--profile" && LINT_PROFILES.includes(args[i + 1] as LintProfile)) profile = args[++i] as LintProfile;
    else if (a === "--format" && ["text", "json"].includes(args[i + 1]!)) format = args[++i]!;
    else if (a.startsWith("-")) {
      io.err(`openarc: bad-flag\n\nusage: ${LINT_USAGE}`);
      return 2;
    } else only.push(a.replace(/^\.\//, ""));
  }
  const { error } = parseConfig(await ports.fs.read("openarc.config.json"));
  if (error) {
    io.err(error);
    return 1;
  }
  const diagnostics: Diagnostic[] = [];
  const project = await engine.parse(ports, req, diagnostics);
  await engine.analyze(ports, req, project, diagnostics, { offline: true }); // no model, no sandbox
  const unknown = only.filter((o) => !project.regions.some((r) => r.id === o || r.file === o || r.spec.file === o));
  if (unknown.length) {
    io.err(`openarc lint: no region or spec file ${unknown.join(", ")}`);
    return 2;
  }
  const findings = lintProject(project, diagnostics, { profile, only, message: io.message });
  const errors = findings.filter((f) => f.severity === "error").length, warnings = findings.length - errors;
  if (format === "json") io.out(JSON.stringify(findings, null, 2));
  else {
    for (const f of findings) io.out(`${f.severity === "error" ? "error" : "warn "} ${f.rule} ${f.id} ${f.file}:${f.line}  ${f.message}`);
    const n = project.regions.filter((r) => r.kind === "function" && (!only.length || only.some((o) => o === r.id || o === r.file || o === r.spec.file))).length;
    io.out(`lint: ${errors} error(s), ${warnings} warning(s) in ${n} function region(s)`);
  }
  return errors || (warnings && (failOnWarnings || project.config.lint?.failOnWarnings)) ? 1 : 0;
}
