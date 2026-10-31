// Code-first regions (SPEC §3.8): a function, class method, getter or arrow whose whole body is `arc.todo()` is a
// pending region. Its signature is the contract, its JSDoc the intent, its id derived from the module path, class and
// member (or `@arc id`). HAND-WRITTEN bootstrap code, not a region; engine.ts calls it from small hooks marked
// `code-first:`. Nothing here executes project code: declarations, JSDoc and arc.configure are read as syntax.
//
// Markers go INSIDE the body (position M): in memory at analysis, so hashing, the splice guard, ownership and E062 work
// unchanged; on disk only once a body is committed. A pending region that isn't committed is written back as it was.
import ts from "typescript";
import type { Json } from "open-arc";
import type { Diagnostic } from "./types.ts";
import type { SpecInfo } from "./engine.ts";
import { isValidId } from "./ids.ts";
import { buildRegionTree, scanMarkers } from "./markers.ts";
import * as plan from "./tests-plan.ts";

export type CodeFirstKind = "function" | "method" | "getter" | "arrow";
export interface CodeFirstInfo {
  kind: CodeFirstKind;
  decl: ts.FunctionLikeDeclaration;
  cls?: ts.ClassDeclaration;
  /** Members of one class are verified jointly (SPEC §8.10): "<file>#<Class>"; otherwise the region id. */
  group: string;
  declaration: string; // "RoundRobin.pick" or "hash32" (manifest, display only)
  head: string; // the declaration up to its body, as written
  doc: string; // its JSDoc as written, or the JSDoc of the interface/base member it implements
  extraIntent: string; // a defineRegion attached by id: its intent, printed after the JSDoc
  exported: boolean;
  tests: plan.TestInfo[];
}

/** The project view this module needs (engine.Project satisfies it). */
export interface CodeFirstProject {
  root: string;
  files: Map<string, string>;
  program?: ts.Program;
  specs: Map<string, SpecInfo>;
  config: { backends: Record<string, unknown> };
  tests?: plan.TestInfo[];
  scaffolds?: Scaffolded[];
  codeFirstIds?: Set<string>;
}

const err = (code: Diagnostic["code"], extra: Omit<Diagnostic, "code"> = {}): Diagnostic => ({ code, ...extra });
const lc = (s: string) => s.toLowerCase();
export const idSegment = (s: string) => {
  const c = s.replace(/[^A-Za-z0-9]+(.)?/g, (_m, ch: string | undefined) => (ch ? ch.toUpperCase() : "")).replace(/^[^A-Za-z]+/, "");
  return c ? c[0]!.toLowerCase() + c.slice(1) : "x";
};
/** Files whose declarations can be regions: src/, not test files. */
export const regionFile = (rel: string) => rel.startsWith("src/") && /\.tsx?$/.test(rel) && !/\.test\.tsx?$/.test(rel);
const lineOf = (sf: ts.SourceFile, pos: number) => sf.getLineAndCharacterOfPosition(pos).line; // 0-based
const hasMod = (n: ts.Node, k: ts.SyntaxKind) => ts.canHaveModifiers(n) && (ts.getModifiers(n)?.some((m) => m.kind === k) ?? false);

// ── declarations ──
export interface Decl {
  decl: ts.FunctionLikeDeclaration & { body: ts.ConciseBody };
  name: string;
  kind: CodeFirstKind;
  cls?: ts.ClassDeclaration;
  docNode: ts.Node; // where its JSDoc is attached (the variable statement of an arrow const)
  headStart: number; // the head as written starts here (after the JSDoc)
  typed: boolean; // an explicit return type (or a typed const/property)
  exported: boolean;
}

/** Top-level functions and arrow consts, and the methods, getters and arrow properties of top-level classes. */
export function declarations(sf: ts.SourceFile): Decl[] {
  const out: Decl[] = [];
  const fnInit = (e: ts.Expression | undefined) => (e && (ts.isArrowFunction(e) || ts.isFunctionExpression(e)) ? e : undefined);
  for (const st of sf.statements) {
    const exported = hasMod(st, ts.SyntaxKind.ExportKeyword);
    if (ts.isFunctionDeclaration(st) && st.name && st.body)
      out.push({ decl: st as Decl["decl"], name: st.name.text, kind: "function", docNode: st, headStart: st.getStart(sf), typed: !!st.type, exported });
    else if (ts.isVariableStatement(st))
      for (const d of st.declarationList.declarations) {
        const f = fnInit(d.initializer);
        if (f && ts.isIdentifier(d.name)) out.push({ decl: f, name: d.name.text, kind: "arrow", docNode: st, headStart: st.getStart(sf), typed: !!(f.type || d.type), exported });
      }
    else if (ts.isClassDeclaration(st) && st.name)
      for (const m of st.members) {
        if (!m.name || !ts.isIdentifier(m.name)) continue;
        const base = { name: m.name.text, cls: st, docNode: m as ts.Node, headStart: m.getStart(sf), exported };
        if (ts.isMethodDeclaration(m) && m.body) out.push({ ...base, decl: m as Decl["decl"], kind: "method", typed: !!m.type });
        else if (ts.isGetAccessorDeclaration(m) && m.body) out.push({ ...base, decl: m as Decl["decl"], kind: "getter", typed: !!m.type });
        else if (ts.isPropertyDeclaration(m)) {
          const f = fnInit(m.initializer);
          if (f) out.push({ ...base, decl: f, kind: "arrow", typed: !!(f.type || m.type) });
        }
      }
  }
  return out;
}

const isTodo = (e: ts.Node | undefined): e is ts.CallExpression =>
  !!e && ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression) && ts.isIdentifier(e.expression.expression) &&
  e.expression.expression.text === "arc" && e.expression.name.text === "todo";

/** The `arc.todo(…)` call when the whole body is one: `{ return arc.todo(); }`, `{ arc.todo(); }` or `=> arc.todo()`. */
export function pendingCall(body: ts.ConciseBody): ts.CallExpression | null {
  if (!ts.isBlock(body)) return isTodo(body) ? body : null;
  if (body.statements.length !== 1) return null;
  const s = body.statements[0]!;
  const e = ts.isReturnStatement(s) ? s.expression : ts.isExpressionStatement(s) ? s.expression : undefined;
  return isTodo(e) ? e : null;
}
/** The owned text of a pending code-first region (what analyze sees between its markers). */
export const isPendingText = (owned: string) => /^(return\s+)?arc\.todo\(\s*("[^"]*")?\s*\);?$/.test(owned.trim());

// ── JSDoc ──
export interface Doc {
  raw: string; // the JSDoc comment(s) as written
  description: string;
  tags: { name: string; text: string }[];
  arc: Record<string, string>; // @arc <key> <value>
}
export function docOf(node: ts.Node, sf: ts.SourceFile): Doc {
  const out: Doc = { raw: "", description: "", tags: [], arc: {} };
  for (const d of ts.getJSDocCommentsAndTags(node)) {
    if (!ts.isJSDoc(d)) continue;
    out.raw = [out.raw, d.getText(sf)].filter(Boolean).join("\n");
    out.description = [out.description, ts.getTextOfJSDocComment(d.comment) ?? ""].filter(Boolean).join(" ");
    for (const t of d.tags ?? []) {
      const text = (ts.getTextOfJSDocComment(t.comment) ?? "").trim();
      if (t.tagName.text === "arc") {
        const [k, ...v] = text.split(/\s+/);
        if (k) out.arc[k] = ["calls", "effects", "deps", "waive"].includes(k) ? v.join(" ") : (v[0] ?? ""); // a tag's text runs on to the next line
      } else out.tags.push({ name: t.tagName.text, text: ts.isJSDocParameterTag(t) ? `${t.name.getText(sf)} ${text}`.trim() : text });
    }
  }
  return out;
}
const intentOf = (d: Doc) => [d.description, ...d.tags.filter((t) => ["param", "returns", "return", "throws"].includes(t.name)).map((t) => `@${t.name} ${t.text}`)].filter(Boolean).join("\n");

/** The JSDoc an undocumented member inherits: from the interfaces its class implements, then its base classes. */
function inheritedDoc(d: Decl, checker: ts.TypeChecker): { raw: string; intent: string } | null {
  for (const h of d.cls?.heritageClauses ?? [])
    for (const t of h.types) {
      const m = checker.getTypeAtLocation(t).getProperty(d.name)?.declarations?.[0];
      if (!m) continue;
      const doc = docOf(m, m.getSourceFile());
      if (doc.raw) return { raw: doc.raw, intent: intentOf(doc) };
    }
  return null;
}

// ── ids (SPEC §3.8) ──
/** `<module>` of a file: its path under src/ without the extension or a trailing index, each segment camel-cased; or
 *  `@arc module <id>` in a JSDoc at the top of the file. */
export function moduleId(rel: string, text: string): string {
  const tag = /^(?:#![^\n]*\n)?\s*\/\*\*(?:(?!\*\/)[\s\S])*?@arc\s+module\s+(\S+)/.exec(text);
  if (tag) return tag[1]!;
  return rel.replace(/^src\//, "").replace(/\.tsx?$/, "").replace(/(^|\/)index$/, "").split(/[/.]/).filter(Boolean).map(idSegment).join(".");
}
export function derivedId(rel: string, text: string, d: Pick<Decl, "name" | "cls">): string {
  const base = lc(rel.replace(/\.tsx?$/, "").replace(/\/index$/, "").split("/").at(-1)!);
  const owner = d.cls?.name?.text;
  return [moduleId(rel, text), ...(owner && lc(owner) !== base ? [idSegment(owner)] : []), ...(!owner && lc(d.name) === base ? [] : [idSegment(d.name)])].join(".");
}

// ── phase A: markers inside pending bodies, in memory ──
export interface Scaffolded {
  id: string;
  file: string;
  scaffolded: string; // the body with markers, as held in memory
  original: string; // the body as written; restored when the region isn't committed
}

/** Region nodes whose markers are the first and last lines of `body` (position M). */
function markedBody(sf: ts.SourceFile, body: ts.ConciseBody, nodes: { id: string; beginLine: number; endLine: number }[]): string | null {
  if (!ts.isBlock(body)) return null;
  const open = lineOf(sf, body.getStart(sf)), close = lineOf(sf, body.end - 1);
  return nodes.find((n) => n.beginLine === open + 2 && n.endLine === close)?.id ?? null;
}
/** A declaration inside a marker pair belongs to a classic region (a scaffolded `export const f: F = … arc.todo("id")`,
 *  or code a block wraps): never code-first. */
const enclosed = (sf: ts.SourceFile, d: Decl, nodes: { beginLine: number; endLine: number }[]) => {
  const from = lineOf(sf, d.headStart) + 1, to = lineOf(sf, d.decl.body.end) + 1;
  return nodes.some((n) => n.beginLine < from && to < n.endLine);
};
const flatNodes = (text: string) => {
  const flat = (ns: ReturnType<typeof buildRegionTree>["roots"]): ReturnType<typeof buildRegionTree>["roots"] => ns.flatMap((n) => [n, ...flat(n.children)]);
  return flat(buildRegionTree(scanMarkers(text).markers).roots);
};

/** Insert markers inside every pending code-first body that has none (in p.files only) and record how to undo it.
 *  E022: a pending declaration without an explicit return type (arc.todo() would infer never). E011: two declarations
 *  derive the same id. A pending body whose id has a defineRegion spec gets markers too: that spec attaches to it. */
export function scaffoldPending(p: CodeFirstProject, diagnostics: Diagnostic[]): boolean {
  const used = new Set<string>();
  for (const [rel, text] of p.files) if (rel.startsWith("src/")) for (const n of flatNodes(text)) used.add(n.id);
  const done: Scaffolded[] = [];
  p.codeFirstIds = new Set();
  for (const [rel, text] of [...p.files].filter(([f]) => regionFile(f))) {
    if (!text.includes("arc.todo") && !text.includes("@openarc:begin")) continue;
    const sf = p.program!.getSourceFile(`${p.root}/${rel}`)!;
    const nodes = flatNodes(text);
    const edits: { start: number; end: number; text: string }[] = [];
    for (const d of declarations(sf)) {
      const marked = markedBody(sf, d.decl.body, nodes);
      if (marked && !enclosed(sf, d, nodes)) p.codeFirstIds.add(marked);
      const call = pendingCall(d.decl.body);
      if (!call || marked || enclosed(sf, d, nodes)) continue;
      const line = lineOf(sf, d.headStart) + 1;
      const doc = docOf(d.docNode, sf);
      const arg = call.arguments[0];
      const id = doc.arc.id ?? (arg && ts.isStringLiteral(arg) ? arg.text : derivedId(rel, text, d));
      if (!d.typed) {
        diagnostics.push(err("OARC-E022", { id, file: rel, line }));
        continue;
      }
      if (!isValidId(id)) {
        diagnostics.push(err("OARC-E010", { id, file: rel, line, detail: `id:${id}` }));
        continue;
      }
      if (used.has(id)) {
        diagnostics.push(err("OARC-E011", { id, file: rel, line }));
        continue;
      }
      used.add(id);
      p.codeFirstIds.add(id);
      const body = d.decl.body;
      const ind = /^[ \t]*/.exec(text.slice(text.lastIndexOf("\n", d.headStart - 1) + 1))![0];
      const stmt = ts.isBlock(body) ? body.statements[0]! : null;
      const stmtOwnLine = stmt && lineOf(sf, stmt.getStart(sf)) !== lineOf(sf, body.getStart(sf));
      const inner = stmt && stmtOwnLine ? /^[ \t]*/.exec(text.slice(text.lastIndexOf("\n", stmt.getStart(sf) - 1) + 1))![0] : `${ind}  `;
      const scaffolded = `{\n${inner}// @openarc:begin ${id}\n${inner}${stmt ? stmt.getText(sf) : `return ${body.getText(sf)};`}\n${inner}// @openarc:end ${id}\n${ind}}`;
      edits.push({ start: body.getStart(sf), end: body.end, text: scaffolded });
      done.push({ id, file: rel, scaffolded, original: text.slice(body.getStart(sf), body.end) });
    }
    if (!edits.length) continue;
    let out = text;
    for (const e of edits.sort((a, b) => b.start - a.start)) out = out.slice(0, e.start) + e.text + out.slice(e.end);
    p.files.set(rel, out);
  }
  p.scaffolds = [...(p.scaffolds ?? []), ...done];
  return done.length > 0;
}

/** A file's text with the in-memory markers of the regions not in `keep` taken out again (they stay pending). */
export function unscaffold(p: CodeFirstProject, rel: string, text: string, keep: Set<string>): string {
  for (const s of p.scaffolds ?? []) if (s.file === rel && !keep.has(s.id)) text = text.replace(s.scaffolded, s.original);
  return text;
}

// ── phase B: specs for every code-first region (markers inside its body) ──
const LAYERS = ["jsdoc", "configure", "defineRegion"];
const SINGLE = ["calls", "effects", "deps", "tolerance", "outputFormat", "backend"] as const;

/** The JSDoc layer: `@arc calls|effects|deps <list>` ("none" is empty), `@arc backend <name>`, `@arc outputFormat|format json|code`. */
function tagLayer(arc: Record<string, string>): Record<string, Json> {
  const list = (v: string) => (v.trim() === "none" ? [] : v.split(/[\s,]+/).filter(Boolean));
  const out: Record<string, Json> = {};
  for (const k of ["calls", "effects", "deps"]) if (arc[k] !== undefined) out[k] = list(arc[k]!);
  if (arc.backend) out.backend = arc.backend;
  if (arc.outputFormat ?? arc.format) out.outputFormat = (arc.outputFormat ?? arc.format)!;
  return out;
}

/** Read every code-first region, the tests and arc.configure statements, and merge the customization layers.
 *  Replaces any defineRegion spec with the same id (it attaches as a layer). */
export function discover(p: CodeFirstProject, checker: ts.TypeChecker, diagnostics: Diagnostic[]): void {
  const once = (d: Diagnostic) => diagnostics.some((x) => x.code === d.code && x.id === d.id && x.detail === d.detail) || diagnostics.push(d);
  const found: { spec: SpecInfo; d: Decl; sf: ts.SourceFile; layers: { name: string; cfg: Record<string, Json> }[] }[] = [];
  for (const [rel, text] of [...p.files].filter(([f]) => regionFile(f))) {
    if (!text.includes("@openarc:begin")) continue;
    const sf = p.program!.getSourceFile(`${p.root}/${rel}`)!;
    const nodes = flatNodes(text);
    for (const d of declarations(sf)) {
      const id = markedBody(sf, d.decl.body, nodes);
      if (!id || enclosed(sf, d, nodes)) continue;
      const doc = docOf(d.docNode, sf);
      const line = lineOf(sf, d.headStart) + 1;
      if (doc.arc.id !== undefined && doc.arc.id !== id) once(err("OARC-E064", { id, file: rel, line, detail: `@arc id ${doc.arc.id}` }));
      const inherited = doc.raw ? null : inheritedDoc(d, checker);
      const sig = checker.getSignatureFromDeclaration(d.decl);
      const signature = sig ? checker.signatureToString(sig, undefined, ts.TypeFormatFlags.NoTruncation) : "";
      const layers = [{ name: "jsdoc", cfg: tagLayer(doc.arc) }];
      const classic = p.specs.get(id);
      let extraIntent = "";
      if (classic && !classic.codeFirst) { // a defineRegion with this id attaches (SPEC §7)
        const F = classic.typeNode ? checker.getTypeFromTypeNode(classic.typeNode) : undefined;
        const mine = checker.getTypeAtLocation(d.decl);
        if (F && !(checker.isTypeAssignableTo(mine, F) && checker.isTypeAssignableTo(F, mine))) once(err("OARC-E020", { id, file: classic.file, detail: "defineRegion-type" }));
        const { id: _id, symbol: _s, intent, ...rest } = classic.literal;
        extraIntent = typeof intent === "string" ? intent : Array.isArray(intent) ? intent.join(" ") : "";
        layers.push({ name: "defineRegion", cfg: rest });
      }
      const name = d.cls ? `${d.cls.name!.text}.${d.name}` : d.name;
      const head = sf.text.slice(d.headStart, d.decl.body.getStart(sf)).replace(/\s*=>\s*$/, " =>").trim();
      const spec: SpecInfo = {
        id, kind: "function", file: rel, exportName: "", literal: {}, symbol: d.name, deps: [], effects: [], examples: [],
        intent: [inherited ? inherited.intent : intentOf(doc), extraIntent].filter(Boolean).join("\n"),
        typeText: "", signature, params: d.decl.parameters.map((x) => x.name.getText(sf)),
        isAsync: !!sig && checker.typeToString(sig.getReturnType()).startsWith("Promise<"),
        ...(d.decl.type ? { typeNode: d.decl.type } : {}),
        codeFirst: {
          kind: d.kind, decl: d.decl, ...(d.cls ? { cls: d.cls } : {}), group: d.cls ? `${rel}#${d.cls.name!.text}` : id, declaration: name,
          head, doc: doc.raw || inherited?.raw || "", extraIntent, exported: d.exported, tests: [],
        },
      };
      found.push({ spec, d, sf, layers });
      p.specs.set(id, spec);
    }
  }
  // arc.test / arc.law / arc.configure, read as syntax (tests-plan.ts), then mapped to regions by their target
  const read = plan.readStatements(p, checker, diagnostics);
  p.tests = read.tests;
  for (const c of read.configures) {
    const f = found.find((x) => c.decl === x.d.decl || c.decl === x.d.decl.parent);
    if (!f) once(err("OARC-E010", { file: c.file, line: c.line, detail: `configure:not-a-region:${c.target}` }));
    else f.layers.push({ name: "configure", cfg: c.config });
  }
  plan.mapTests(read.tests, found.map((x) => x.spec), checker);
  for (const { spec, d, layers } of found) {
    const cf = spec.codeFirst!;
    const merged: Record<string, Json> = {};
    for (const k of SINGLE) {
      const set = layers.filter((l) => l.cfg[k] !== undefined).sort((a, b) => LAYERS.indexOf(a.name) - LAYERS.indexOf(b.name));
      if (set.length > 1) once(err("OARC-E013", { id: spec.id, file: spec.file, detail: `${k}:${set.map((l) => l.name).join(",")}` }));
      if (set[0]) merged[k] = set[0].cfg[k]!;
    }
    const examples = layers.flatMap((l) => (Array.isArray(l.cfg.examples) ? l.cfg.examples : []));
    const configIntent = layers.find((l) => l.name === "configure")?.cfg.intent;
    if (configIntent !== undefined) {
      const more = Array.isArray(configIntent) ? configIntent.join(" ") : String(configIntent);
      spec.intent = [spec.intent, more].filter(Boolean).join("\n");
      cf.extraIntent = [cf.extraIntent, more].filter(Boolean).join("\n");
    }
    if (examples.length && (d.kind === "method" || d.kind === "getter" || d.cls)) once(err("OARC-E010", { id: spec.id, file: spec.file, detail: "examples:method" }));
    else if (examples.length && !d.exported) once(err("OARC-E010", { id: spec.id, file: spec.file, detail: "examples:not-exported" }));
    if (typeof merged.backend === "string" && !(merged.backend in p.config.backends)) once(err("OARC-E010", { id: spec.id, file: spec.file, detail: `backend:${merged.backend}` }));
    spec.examples = examples;
    spec.deps = (merged.deps as string[] | undefined) ?? [];
    spec.effects = (merged.effects as string[] | undefined) ?? [];
    if (Array.isArray(merged.calls)) spec.calls = merged.calls as string[];
    if (typeof merged.backend === "string") spec.backend = merged.backend;
    if (merged.outputFormat === "json" || merged.outputFormat === "code") spec.outputFormat = merged.outputFormat;
    // The spec hash (SPEC §8.4): the head and JSDoc, the merged configuration (not backend/outputFormat: machine-local),
    // and every test that targets the region (hidden ones too) with the test-file consts it reads.
    const { backend: _b, outputFormat: _o, ...hashed } = merged;
    spec.literal = {
      id: spec.id, $head: cf.head.replace(/\s+/g, " "), $doc: cf.doc, $intent: cf.extraIntent, ...hashed, examples,
      $tests: cf.tests.map((t) => [...t.consts, t.source].join("\n")),
    };
  }
}

// ── the context package's Contract section (SPEC §8.8) ──
/** The class shell with `<<<BODY>>>` for the target (methods), or the JSDoc and head (functions). `pending`: the other
 *  code-first members still pending (omitted in the stable view, so a sibling's commit doesn't change the fingerprint). */
export function contract(spec: SpecInfo, checker: ts.TypeChecker, pending: Set<ts.Node> | null): string {
  const cf = spec.codeFirst!;
  const docLines = (raw: string, ind: string) => (raw ? raw.split("\n").map((l) => ind + l.trim().replace(/^\*/, " *")) : []);
  if (!cf.cls) return [`// ${spec.id} in ${spec.file}`, ...docLines(cf.doc, ""), `${cf.head} {`, "  <<<BODY>>>", "}"].join("\n");
  const out = [`// ${spec.id} in ${spec.file}`];
  const shell = (cls: ts.ClassDeclaration, target: ts.Node | null) => {
    const csf = cls.getSourceFile();
    out.push(csf.text.slice(cls.getStart(csf), cls.members.pos).replace(/\s+$/, ""));
    for (const m of cls.members) {
      const own = docOf(m, csf).raw;
      const fn = ts.isPropertyDeclaration(m) && m.initializer && (ts.isArrowFunction(m.initializer) || ts.isFunctionExpression(m.initializer)) ? m.initializer : m;
      const name = m.name && ts.isIdentifier(m.name) ? m.name.text : "";
      const inherited = !own && name ? inheritedDoc({ name, cls } as Decl, checker)?.raw ?? "" : "";
      const body = (fn as ts.FunctionLikeDeclaration).body;
      out.push(...docLines(own || inherited, "  "));
      if (fn === target) out.push(`  ${cf.head} {`, "    <<<BODY>>>", "  }");
      else if (ts.isConstructorDeclaration(m) || !body) out.push(`  ${m.getText(csf)}`);
      else {
        const head = csf.text.slice(m.getStart(csf), body.getStart(csf)).replace(/\s*=>\s*$/, " =>").trim();
        const note = pending === null ? "" : pending.has(fn) ? "  // pending: compiled jointly with this member; tests may call it" : "  // implemented";
        out.push(`  ${head}${head.endsWith("=>") ? " …" : ""};${note}`);
      }
    }
    out.push("}");
  };
  // a project base class is context too (its concrete members are inherited, implemented)
  for (const h of cf.cls.heritageClauses ?? [])
    if (h.token === ts.SyntaxKind.ExtendsKeyword)
      for (const t of h.types) {
        const base = checker.getSymbolAtLocation(t.expression)?.valueDeclaration;
        if (base && ts.isClassDeclaration(base) && !base.getSourceFile().fileName.includes("/node_modules/")) {
          out.push(`// base class of ${cf.cls.name!.text}`);
          shell(base, null);
        }
      }
  shell(cf.cls, cf.decl);
  return out.join("\n");
}

/** The type-bearing parts of the contract, never a body (the type closure must not change when a body does, §4.3):
 *  the declaration's signature; for a member, its class's heritage, fields and member signatures (and its bases'). */
export function typeRoots(cf: CodeFirstInfo, checker: ts.TypeChecker): ts.Node[] {
  const sig = (f: ts.SignatureDeclarationBase): ts.Node[] => [...(f.typeParameters ?? []), ...f.parameters, ...(f.type ? [f.type] : [])];
  if (!cf.cls) return [...sig(cf.decl), ...(ts.isVariableDeclaration(cf.decl.parent) && cf.decl.parent.type ? [cf.decl.parent.type] : [])];
  const out: ts.Node[] = [];
  const seen = new Set<ts.Node>();
  const cls = (c: ts.ClassDeclaration) => {
    if (seen.has(c)) return;
    seen.add(c);
    for (const h of c.heritageClauses ?? [])
      for (const t of h.types) {
        out.push(t);
        const base = checker.getSymbolAtLocation(t.expression)?.valueDeclaration;
        if (base && ts.isClassDeclaration(base)) cls(base);
      }
    for (const m of c.members) {
      if (ts.isPropertyDeclaration(m)) {
        const f = m.initializer && (ts.isArrowFunction(m.initializer) || ts.isFunctionExpression(m.initializer)) ? m.initializer : null;
        out.push(...(m.type ? [m.type] : f ? sig(f) : []));
      } else if (ts.isMethodDeclaration(m) || ts.isGetAccessorDeclaration(m) || ts.isSetAccessorDeclaration(m) || ts.isConstructorDeclaration(m)) out.push(...sig(m));
    }
  };
  cls(cf.cls);
  return out;
}
