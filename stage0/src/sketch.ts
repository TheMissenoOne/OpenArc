// Sketches (SPEC §4.5): a region body written as typed TypeScript inside its spec, with `arc.hole<T>("…")` where the
// model fills in. HAND-WRITTEN bootstrap code, not a region. engine.ts calls it from small, marked hooks: extraction,
// the context package, the model reply, and verification (containment E099, per-hole rules, probes, E100).
// The sketch is read as syntax and never run. Everything below works on the sketch's text, re-parsed on its own.
import ts from "typescript";
import type { Json } from "open-arc";
import { checkRestrictions } from "./block.ts";
import { normalizeOwnedText } from "./hash.ts";
import { parseOutput } from "./model.ts";
import type { Diagnostic, ModelOutput } from "./types.ts";

/** Part of every sketch region's spec hash (so of its fingerprint): the fills protocol and its prompt. */
export const SKETCH_TEMPLATE_VERSION = "1";

export interface Hole {
  n: number; // 1-based, in source order
  kind: "expr" | "stmt";
  description: string;
  type: string; // checker-printed T of an expression hole; "statements" for a statement hole
  start: number; // span in SketchInfo.body: the call (expression hole) or the whole statement (statement hole)
  end: number;
  isAsync: boolean; // the function the hole is in is async (statement-hole restrictions, §3.4)
  usedAfter: string[]; // identifiers the sketch uses after a statement hole: a fill may not declare them
}

export interface SketchInfo {
  body: string; // the sketch's statements, dedented, holes in place: what the region body is checked against
  holes: Hole[];
  params: string[];
  isAsync: boolean;
  span: [number, number]; // the sketch function in its spec file (tsc errors there are reported before any model call)
  roots: string[]; // restricted call roots: the file's value imports and parameters of a `…Ports` type
  implied: string[]; // calls the sketch itself makes on restricted roots: fills may call these plus spec.calls
  callees: { path: string; file: string; name: string; type: string; typeNode?: ts.Node }[]; // implied calls into project files
}

const WRAP = "async function __sketch() {\n";
const wrap = (body: string) => `${WRAP}${body}\n}\n`;
const isHoleCall = (n: ts.Node): boolean =>
  ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && ts.isIdentifier(n.expression.expression) &&
  n.expression.expression.text === "arc" && n.expression.name.text === "hole";
const isStmtHole = (n: ts.Node): n is ts.ExpressionStatement => ts.isExpressionStatement(n) && isHoleCall(n.expression);
const holeCalls = (root: ts.Node): ts.CallExpression[] => {
  const out: ts.CallExpression[] = [];
  const visit = (n: ts.Node) => {
    if (isHoleCall(n)) out.push(n as ts.CallExpression);
    n.forEachChild(visit);
  };
  visit(root);
  return out;
};
const isJsDoc = (n: ts.Node) => n.kind >= ts.SyntaxKind.FirstJSDocNode && n.kind <= ts.SyntaxKind.LastJSDocNode;
const kids = (n: ts.Node, sf: ts.SourceFile) => n.getChildren(sf).filter((c) => !isJsDoc(c));
const hasAsync = (n: ts.Node) => (ts.canHaveModifiers(n) ? ts.getModifiers(n) : undefined)?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword) ?? false;

/** `a.b.c` for a callee of identifiers and property accesses (`x[i]` prints `x[]`), or null. Same shape as §7 rule 6. */
export function calleePath(e: ts.Expression): { root: string; path: string } | null {
  if (ts.isIdentifier(e)) return { root: e.text, path: e.text };
  if (ts.isParenthesizedExpression(e) || ts.isNonNullExpression(e) || ts.isAsExpression(e)) return calleePath(e.expression);
  const base = ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e) ? calleePath(e.expression) : null;
  return base && { root: base.root, path: `${base.path}${ts.isPropertyAccessExpression(e) ? `.${e.name.text}` : "[]"}` };
}
export const callAllowed = (calls: string[], path: string) => calls.some((c) => c === path || c === "*" || (c.endsWith(".*") && path.startsWith(c.slice(0, -1))));

/** Value bindings the file imports (named, default, namespace), minus `arc`. */
export function importBindings(sf: ts.SourceFile): Set<string> {
  const out = new Set<string>();
  for (const st of sf.statements) {
    const c = ts.isImportDeclaration(st) ? st.importClause : undefined;
    if (!c || c.isTypeOnly) continue;
    if (c.name) out.add(c.name.text);
    if (c.namedBindings && ts.isNamespaceImport(c.namedBindings)) out.add(c.namedBindings.name.text);
    if (c.namedBindings && ts.isNamedImports(c.namedBindings)) c.namedBindings.elements.filter((e) => !e.isTypeOnly).forEach((e) => out.add(e.name.text));
  }
  out.delete("arc");
  return out;
}

/** Strip the common indentation, unless a template literal spans lines (its text would change). */
function dedent(text: string, multilineTemplate: boolean): string {
  const lines = text.split("\n");
  while (lines.length && !lines[0]!.trim()) lines.shift();
  while (lines.length && !lines.at(-1)!.trim()) lines.pop();
  if (multilineTemplate) return lines.join("\n");
  const ind = Math.min(...lines.filter((l) => l.trim()).map((l) => /^\s*/.exec(l)![0].length));
  return lines.map((l) => l.slice(Math.min(ind, /^\s*/.exec(l)![0].length))).join("\n");
}

/** Read `sketch: (…) => { … }` from a spec. `relOf` maps a source file name to a project-relative path (null: not ours). */
export function readSketch(node: ts.Expression, sf: ts.SourceFile, checker: ts.TypeChecker, relOf: (fileName: string) => string | null): SketchInfo | { error: string } {
  if (!(ts.isArrowFunction(node) || ts.isFunctionExpression(node)) || !ts.isBlock(node.body)) return { error: "sketch:must-be-a-function-with-a-block-body" };
  const block = node.body;
  let multiline = false;
  const scan = (n: ts.Node): void => {
    if ((ts.isTemplateExpression(n) || ts.isNoSubstitutionTemplateLiteral(n)) && n.getText(sf).includes("\n")) multiline = true;
    n.forEachChild(scan);
  };
  scan(block);
  const body = dedent(sf.text.slice(block.getStart(sf) + 1, block.getEnd() - 1), multiline);
  const bsf = ts.createSourceFile("sketch.ts", wrap(body), ts.ScriptTarget.Latest, true);
  const wrapper = bsf.statements[0] as ts.FunctionDeclaration;
  const isAsync = hasAsync(node);
  const calls = holeCalls(wrapper.body!), origCalls = holeCalls(block);
  if (calls.length !== origCalls.length) return { error: "sketch:reparse" };
  const holes: Hole[] = [];
  for (const [i, c] of calls.entries()) {
    const arg = c.arguments[0];
    if (c.arguments.length !== 1 || !arg || !ts.isStringLiteralLike(arg)) return { error: `sketch:hole-${i + 1}-description-must-be-a-string-literal` };
    const stmt = isStmtHole(c.parent) ? c.parent : null;
    const at = stmt ?? c;
    const fn = ts.findAncestor(c.parent, ts.isFunctionLike);
    const used = new Set<string>();
    const collect = (n: ts.Node): void => {
      if (ts.isIdentifier(n) && n.getStart(bsf) >= at.getEnd() && !(ts.isPropertyAccessExpression(n.parent) && n.parent.name === n)) used.add(n.text);
      n.forEachChild(collect);
    };
    if (stmt) collect(wrapper.body!);
    holes.push({
      n: i + 1, kind: stmt ? "stmt" : "expr", description: arg.text,
      type: stmt ? "statements" : checker.typeToString(checker.getTypeAtLocation(origCalls[i]!), undefined, ts.TypeFormatFlags.NoTruncation),
      start: at.getStart(bsf) - WRAP.length, end: at.getEnd() - WRAP.length,
      isAsync: fn === wrapper || !fn ? isAsync : hasAsync(fn), usedAfter: [...used].sort(),
    });
  }
  // two adjacent statement holes would be ambiguous: which statements belong to which?
  const adjacent = (n: ts.Node): boolean => {
    const ss = ts.isBlock(n) || ts.isSourceFile(n) || ts.isModuleBlock(n) || ts.isCaseClause(n) || ts.isDefaultClause(n) ? [...n.statements] : [];
    return ss.some((s, i) => i > 0 && isStmtHole(s) && isStmtHole(ss[i - 1]!)) || n.getChildren(bsf).some(adjacent);
  };
  if (adjacent(wrapper.body!)) return { error: "sketch:adjacent-statement-holes" };

  const imports = importBindings(sf);
  const portParams = node.parameters.filter((x) => /Ports$/.test(checker.typeToString(checker.getTypeAtLocation(x)))).map((x) => x.name.getText(sf));
  const roots = [...imports, ...portParams];
  const implied = new Set<string>();
  const callees: SketchInfo["callees"] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n) && !isHoleCall(n)) {
      const c = calleePath(n.expression);
      if (c && roots.includes(c.root) && !implied.has(c.path)) {
        implied.add(c.path);
        const nameNode = ts.isPropertyAccessExpression(n.expression) ? n.expression.name : n.expression;
        let sym = imports.has(c.root) ? checker.getSymbolAtLocation(nameNode) : undefined;
        if (sym && sym.flags & ts.SymbolFlags.Alias) sym = checker.getAliasedSymbol(sym);
        const decl = sym?.valueDeclaration;
        const rel = decl ? relOf(decl.getSourceFile().fileName) : null;
        if (decl && rel && (ts.isVariableDeclaration(decl) || ts.isFunctionDeclaration(decl)) && decl.name && ts.isIdentifier(decl.name))
          callees.push({ path: c.path, file: rel, name: decl.name.text, type: checker.typeToString(checker.getTypeOfSymbolAtLocation(sym!, decl), undefined, ts.TypeFormatFlags.NoTruncation), ...(ts.isVariableDeclaration(decl) && decl.type ? { typeNode: decl.type } : {}) });
      }
    }
    n.forEachChild(visit);
  };
  visit(block);
  return {
    body, holes, params: node.parameters.map((x) => x.name.getText(sf)), isAsync, span: [node.getStart(sf), node.getEnd()],
    roots, implied: [...implied], callees,
  };
}

/** tsc errors inside sketches, as OARC-E070 (detail `sketch:TS<code>`): reported at ANALYZE, before any model call. */
export function sketchTypeErrors(program: ts.Program, root: string, specs: Iterable<{ id: string; file: string; sketch?: SketchInfo }>): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const s of specs) {
    if (!s.sketch) continue;
    const sf = program.getSourceFile(`${root}/${s.file}`);
    if (!sf) continue;
    const [from, to] = s.sketch.span;
    for (const d of [...program.getSyntacticDiagnostics(sf), ...program.getSemanticDiagnostics(sf)])
      if (d.category === ts.DiagnosticCategory.Error && d.start !== undefined && d.start >= from && d.start < to)
        out.push({ code: "OARC-E070", id: s.id, file: s.file, line: sf.getLineAndCharacterOfPosition(d.start).line + 1, detail: `sketch:TS${d.code}` });
  }
  return out;
}

/** PLAN order (§8.1): every target after the targets its sketch calls, so a caller's examples see compiled callees. */
export function calleesFirst(targets: string[], specs: Map<string, { id: string; file: string; symbol: string; sketch?: SketchInfo }>): string[] {
  const idOf = (c: { file: string; name: string }) => [...specs.values()].find((s) => s.file === c.file && s.symbol === c.name)?.id;
  const out: string[] = [];
  const seen = new Set<string>();
  const visit = (id: string) => {
    if (seen.has(id)) return;
    seen.add(id);
    for (const c of specs.get(id)?.sketch?.callees ?? []) {
      const d = idOf(c);
      if (d && targets.includes(d)) visit(d);
    }
    out.push(id);
  };
  targets.forEach(visit);
  return out;
}

/** The spec-hash view of a sketch (§4.1 normalisation: whitespace-insensitive, comments count). */
export const sketchHashText = (s: SketchInfo): string => `v${SKETCH_TEMPLATE_VERSION}:${normalizeOwnedText(s.body.split("\n"), [])}`;

/** The sketch with every hole replaced by its fill. Expression fills are parenthesised, so they can't change how the
 *  code around them parses. `probe` (the region id) adds the coverage probe `id#n` in each hole: sandbox copies only. */
export function spliceFills(s: SketchInfo, fills: Record<string, string>, probe?: string): string {
  let text = s.body;
  for (const h of [...s.holes].reverse()) {
    const fill = (fills[String(h.n)] ?? "").trim();
    const hit = probe ? `globalThis.__openarcHit?.(${JSON.stringify(`${probe}#${h.n}`)})` : "";
    const ind = /[ \t]*$/.exec(text.slice(0, h.start))![0];
    const rep = h.kind === "expr"
      ? (probe ? `(${hit}, (${fill}))` : `(${fill})`)
      : [...(probe ? [`${hit};`] : []), ...fill.split("\n")].map((l, i) => (i && l.trim() && !fill.includes("`") ? ind + l : l)).join("\n");
    text = text.slice(0, h.start) + rep + text.slice(h.end);
  }
  return text;
}

/** The sketch with «n» in place of each hole, for the context package. */
export function displaySketch(s: SketchInfo): string {
  let text = s.body;
  for (const h of [...s.holes].reverse()) text = text.slice(0, h.start) + `«${h.n}»` + text.slice(h.end);
  return text;
}

export type Containment = { ok: true; fills: Record<string, string> } | { ok: false; why: string };

/** OARC-E099: `body` is the sketch with each hole replaced by some code, and nothing else changed. Walks both ASTs in
 *  parallel: an expression hole matches one expression, a statement hole 0..n statements (backtracking); every other
 *  node must have the same kind and children, and every token the same text (string literals by value). Comments and
 *  whitespace are ignored. Returns the fills it found (the recovery path for a whole-body reply), or the first mismatch. */
export function contains(s: SketchInfo, body: string): Containment {
  const ssf = ts.createSourceFile("sketch.ts", wrap(s.body), ts.ScriptTarget.Latest, true);
  const bsf = ts.createSourceFile("body.ts", wrap(body), ts.ScriptTarget.Latest, true);
  const parseErrors = (bsf as unknown as { parseDiagnostics: unknown[] }).parseDiagnostics.length;
  const fn = bsf.statements[0];
  if (bsf.statements.length !== 1 || !fn || !ts.isFunctionDeclaration(fn) || !fn.body || parseErrors)
    return { ok: false, why: "OARC-E099 sketch not preserved: the body does not parse as one function body" };
  const holeNo = new Map<ts.Node, number>(holeCalls(ssf).map((c, i) => [c, i + 1]));
  const fills: Record<string, string> = {};
  let miss: { pos: number; sketch: string; body: string } | null = null;
  const fail = (a: ts.Node, b: ts.Node | undefined): false => {
    const pos = b ? b.getStart(bsf) : Infinity;
    if (!miss || pos >= miss.pos) miss = { pos, sketch: a.getText(ssf).slice(0, 70), body: b ? b.getText(bsf).slice(0, 70) : "(nothing)" };
    return false;
  };
  const leafEq = (a: ts.Node, b: ts.Node) => (ts.isStringLiteral(a) && ts.isStringLiteral(b) ? a.text === b.text : a.getText(ssf) === b.getText(bsf));
  const match = (a: ts.Node, b: ts.Node): boolean => {
    if (holeNo.has(a)) {
      if (!ts.isExpression(b)) return fail(a, b);
      let x: ts.Expression = b;
      while (ts.isParenthesizedExpression(x)) x = x.expression;
      fills[String(holeNo.get(a))] = x.getText(bsf);
      return true;
    }
    if (a.kind !== b.kind) return fail(a, b);
    const ca = kids(a, ssf), cb = kids(b, bsf);
    if (ca.length === 0) return cb.length === 0 && leafEq(a, b) ? true : fail(a, b);
    if (a.kind === ts.SyntaxKind.SyntaxList) return seq(ca, cb, 0, 0);
    if (ca.length !== cb.length) return fail(a, b);
    return ca.every((c, i) => match(c, cb[i]!));
  };
  const seq = (ca: ts.Node[], cb: ts.Node[], i: number, j: number): boolean => {
    if (i === ca.length) return j === cb.length || fail(ca[i - 1] ?? ssf, cb[j]);
    const a = ca[i]!;
    if (isStmtHole(a)) {
      for (let e = j; e <= cb.length; e++) {
        if (cb.slice(j, e).some((x) => !ts.isStatement(x))) break;
        if (seq(ca, cb, i + 1, e)) {
          fills[String(holeNo.get(a.expression))] = cb.slice(j, e).map((x) => x.getText(bsf)).join("\n");
          return true;
        }
      }
      return false;
    }
    return (j < cb.length || fail(a, undefined)) && match(a, cb[j]!) && seq(ca, cb, i + 1, j + 1);
  };
  if (match(ssf.statements[0]!, fn)) return { ok: true, fills };
  const m = miss as { pos: number; sketch: string; body: string } | null;
  const line = m && Number.isFinite(m.pos) ? bsf.getLineAndCharacterOfPosition(m.pos).line : null;
  return { ok: false, why: `OARC-E099 sketch not preserved: ${line === null ? "the body ends" : `body line ${line} has \`${m!.body}\``} where the sketch has \`${m?.sketch ?? "?"}\`` };
}

/** Calls in `code` on a restricted root that `code` doesn't declare itself. ponytail: any declaration of the name in the
 *  fill shadows it (not scope-exact); the allowlist stops a wandering model, the sandbox is the boundary. */
function restrictedCalls(code: string, roots: string[]): string[] {
  const sf = ts.createSourceFile("f.ts", `async function __f() {\n${code}\n}`, ts.ScriptTarget.Latest, true);
  const declared = new Set<string>();
  const out: string[] = [];
  const visit = (n: ts.Node): void => {
    if ((ts.isVariableDeclaration(n) || ts.isParameter(n) || ts.isFunctionDeclaration(n) || ts.isBindingElement(n)) && n.name && ts.isIdentifier(n.name)) declared.add(n.name.text);
    if (ts.isCallExpression(n)) {
      const c = calleePath(n.expression);
      if (c && roots.includes(c.root)) out.push(`${c.root}\0${c.path}`);
    }
    n.forEachChild(visit);
  };
  visit(sf);
  return out.filter((x) => !declared.has(x.split("\0")[0]!)).map((x) => x.split("\0")[1]!);
}

/** STATIC checks of a candidate body for a sketch region: containment (E099), §3.4 on statement fills (E035), and the
 *  implied call allowlist on every fill (E098). The sketch's own code is never checked against `calls`. */
export function checkSketchBody(s: SketchInfo, body: string, specCalls: string[]): { problems: string[]; fills: Record<string, string> } {
  const c = contains(s, body);
  if (!c.ok) return { problems: [c.why], fills: {} };
  const problems: string[] = [];
  const allowed = [...s.implied, ...specCalls];
  for (const h of s.holes) {
    const fill = c.fills[String(h.n)] ?? "";
    if (h.kind === "stmt") for (const d of checkRestrictions(fill, h.isAsync, h.usedAfter)) problems.push(`OARC-E035 hole «${h.n}»: not allowed in a statement hole: ${d.detail}`);
    for (const path of restrictedCalls(h.kind === "expr" ? `(${fill});` : fill, s.roots))
      if (!callAllowed(allowed, path)) problems.push(`OARC-E098 hole «${h.n}»: call not allowed by spec: ${path} (allowed: ${allowed.join(", ") || "none"})`);
  }
  return { problems, fills: c.fills };
}

/** Hole numbers no passing example reached (`hits` holds "<id>#<n>" probe ids from passing outcomes). */
export const unreachedHoles = (s: SketchInfo, id: string, hits: Set<string>): number[] => s.holes.filter((h) => !hits.has(`${id}#${h.n}`)).map((h) => h.n);

/** OARC-E100: a failing example whose run reached no hole is decided by the developer's own code (sketch and callees),
 *  so no fill can fix it. Pending callees are inconclusive, not a conflict. Reads the harness's JSON lines. */
export function sketchConflict(stdout: string, id: string): Diagnostic | null {
  for (const line of stdout.split("\n")) {
    let v: { name?: unknown; ok?: unknown; actual?: { pending?: unknown }; hits?: unknown } | null = null;
    try {
      v = JSON.parse(line);
    } catch {
      continue;
    }
    if (!v || v.ok !== false || typeof v.name !== "string" || (typeof v.actual === "object" && v.actual !== null && "pending" in v.actual)) continue;
    const hits = Array.isArray(v.hits) ? v.hits.map(String) : [];
    if (!hits.some((h) => h.startsWith(`${id}#`))) return { code: "OARC-E100", id, detail: v.name };
  }
  return null;
}

// ───────────────────────────── model protocol (§8.4 for sketch regions) ─────────────────────────────

export const SKETCH_PROMPT_TEMPLATE = `Fill the holes of one OpenArc sketch in TypeScript.

{{context}}

{{repair}}

Reply with JSON only: {"fills": {"1": "<code>", "2": "<code>"}, "imports": [{"from": "<specifier>", "names": ["<name>"]}]}.
One fill per hole number. An expression hole's fill is ONE expression; a statement hole's fill is zero or more statements. Never repeat the sketch.
Use "imports": [] unless you need something listed under "Allowed new imports" that the file doesn't already import.`;

export const SKETCH_SYSTEM = "You are a compiler backend. You output JSON only: {\"fills\": {\"<hole number>\": string}, \"imports\": [{\"from\": string, \"names\": string[], \"default\"?: string}]}. Each fill is TypeScript code only, with no markdown.";

const importsSchema = (strict: boolean): Json => ({
  type: "array",
  items: {
    type: "object", additionalProperties: false, required: strict ? ["from", "names", "default"] : ["from", "names"],
    properties: { from: { type: "string" }, names: { type: "array", items: { type: "string" } }, default: { type: strict ? ["string", "null"] : "string" } },
  },
});
/** Structured-output schemas for a sketch region: exactly one string per hole. `loose` for Ollama and Anthropic,
 *  `strict` for OpenAI json_schema (every property required). */
export function fillsSchema(s: SketchInfo): { loose: Json; strict: Json } {
  const keys = s.holes.map((h) => String(h.n));
  const fills: Json = { type: "object", additionalProperties: false, required: keys, properties: Object.fromEntries(keys.map((k) => [k, { type: "string" }])) };
  const make = (strict: boolean): Json => ({ type: "object", additionalProperties: false, required: strict ? ["fills", "imports"] : ["fills"], properties: { fills, imports: importsSchema(strict) } });
  return { loose: make(false), strict: make(true) };
}

/** Parse a reply to a sketch region into a whole body (the sketch with the fills spliced in). A reply with `body`
 *  instead of `fills` (the F13 habit) is kept as a whole body: containment then recovers its fills or rejects it. */
export function parseFills(raw: string, s: SketchInfo): ModelOutput {
  const bad = (detail: string): ModelOutput => ({ ok: false, diagnostic: { code: "OARC-E081", detail } });
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return bad("invalid-json");
  }
  if (typeof v !== "object" || v === null || Array.isArray(v)) return bad("not-object");
  const o = v as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!["fills", "imports", "body"].includes(k)) return bad(`unexpected-property:${k}`);
  const imp = parseOutput(JSON.stringify({ body: "", imports: o.imports ?? [] }));
  if (!imp.ok) return imp;
  if (o.fills === undefined && typeof o.body === "string") return { ok: true, body: o.body, imports: imp.imports };
  if (typeof o.fills !== "object" || o.fills === null || Array.isArray(o.fills)) return bad("fills-not-object");
  const fills = o.fills as Record<string, unknown>;
  for (const k of Object.keys(fills)) if (!s.holes.some((h) => String(h.n) === k)) return bad(`unexpected-fill:${k}`);
  for (const h of s.holes) {
    const f = fills[String(h.n)];
    if (typeof f !== "string") return bad(`fill-missing:${h.n}`);
  }
  return { ok: true, body: spliceFills(s, fills as Record<string, string>), imports: imp.imports };
}

// ───────────────────────────── context package (§8.8 for sketch regions) ─────────────────────────────

/** The head of a sketch region's package: the task, the sketch with «n» in place, and one line per hole. */
export function sketchHead(s: SketchInfo, symbol: string, typeText: string, signature: string): [string, string][] {
  return [
    ["Task", `Fill the numbered holes «n» in the sketch of export const ${symbol}. Everything else in the sketch is fixed and is checked to be unchanged (OARC-E099).`],
    [`Sketch (fixed; ${typeText} = ${signature})`, `${s.isAsync ? "async " : ""}(${s.params.join(", ")}) => {\n${displaySketch(s).split("\n").map((l) => (l ? `  ${l}` : l)).join("\n")}\n}`],
    ["Holes", s.holes.map((h) => `«${h.n}» ${h.kind === "expr" ? `one expression of type ${h.type}` : "statements (no return, break or continue out of the hole; don't declare a name the sketch uses later)"}: ${h.description}`).join("\n")],
  ];
}

/** "Calls allowed in fills": what the sketch calls itself, plus spec.calls. */
export const sketchCalls = (s: SketchInfo, specCalls: string[] | undefined): [string, string] =>
  ["Calls allowed in fills", `You may call: ${[...s.implied, ...(specCalls ?? [])].join(", ") || "nothing"} (what the sketch itself calls${specCalls?.length ? ", plus the spec's calls" : ""}). Any other call on an import or a port is rejected (OARC-E098); calls on locals and on functions a fill defines are fine.`];
