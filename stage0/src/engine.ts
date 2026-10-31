// OpenArc engine: everything compile.run's blocks call. HAND-WRITTEN bootstrap code (not a region yet).
// Each block in compile.ts is one or two calls into this module, which keeps the blocks small enough
// for a small model to regenerate. Regionizing the engine itself is the next self-hosting step.
import ts from "typescript";
import type { Json } from "openarc";
import type { Candidate, ChildSpan, CompileRequest, Diagnostic, ManifestView, Ports, RegionState, StagedFile } from "./types.ts";
import type { BackendConfig, ContextLevel, OpenArcConfig } from "./config.ts";
import { hostOf, parseConfig } from "./config.ts";
import { scanMarkers, buildRegionTree } from "./markers.ts";
import { findDuplicateIds } from "./ids.ts";
import { canonicalJson, normalizeOwnedText, sha256Tagged } from "./hash.ts";
import { detect } from "./ownership.ts";
import { checkRestrictions } from "./block.ts";
import { selectTargets } from "./plan.ts";
import { PROMPT_TEMPLATE_VERSION, PROMPT_TEMPLATE, renderTemplate, parseOutput } from "./model.ts";
import { baseUrlOf, complete } from "./backends.ts";
import { buildArgv, readHarnessOutput } from "./sandbox.ts";

export const COMPILER_VERSION = "0.2.0";
const SOURCE_DIRS = ["src", "core", "tests/fakes", "tools"];

// ───────────────────────────── data model ─────────────────────────────

export interface SpecInfo {
  id: string;
  kind: "function" | "block";
  file: string;
  exportName: string;
  literal: { [k: string]: Json };
  symbol: string;
  deps: string[];
  effects: string[];
  examples: Json[];
  intent: string;
  typeText: string; // F as written, e.g. "IsValidId"
  signature: string; // printed call signature, e.g. "(id: string) => boolean"
  params: string[];
  isAsync: boolean;
  typeNode?: ts.TypeNode;
}

export interface ManifestEntry {
  kind: "function" | "block";
  parent: string | null;
  file: string;
  symbol?: string;
  ownership: "compiler" | "developer" | "conflicted";
  hash: string;
  specHash: string;
  fingerprint: string | null;
  provenance: { [k: string]: Json };
}
export interface Manifest {
  schema: 1;
  regions: Record<string, ManifestEntry>;
}

export interface RegionInfo {
  id: string;
  kind: "function" | "block";
  file: string;
  parent: string | null;
  root: string; // id of the enclosing function region (itself for function regions)
  bodyLines: string[];
  childSpans: ChildSpan[];
  indent: string;
  pending: boolean;
  hash: string;
  spec: SpecInfo;
  specHash: string;
  state: RegionState;
  stale: boolean;
  fingerprint: string;
  scope: string[]; // blocks: "let x: T" lines in scope
  context0: string; // the initial context package (its hash is part of the fingerprint)
}

export interface Project {
  root: string;
  config: OpenArcConfig;
  files: Map<string, string>; // rel path -> current text (after the in-memory scaffold)
  disk: Map<string, string>; // rel path -> text on disk
  specs: Map<string, SpecInfo>;
  regions: RegionInfo[];
  manifest: Manifest;
  program?: ts.Program;
  digests: Map<string, string>;
  accepted: Map<string, string>; // rel path -> text with this run's accepted candidates
  sandboxDir?: string; // rel path of this run's sandbox stage
  provenance: Map<string, { [k: string]: Json }>;
}

const err = (code: Diagnostic["code"], extra: Omit<Diagnostic, "code"> = {}): Diagnostic => ({ code, ...extra });
const linesOf = (t: string) => t.split("\n");
const abs = (p: Project, rel: string) => `${p.root}/${rel}`;

// ───────────────────────────── PARSE ─────────────────────────────

async function listTs(ports: Ports, dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const name of await ports.fs.list(dir)) {
    const rel = `${dir}/${name}`;
    if (name.endsWith(".ts")) out.push(rel);
    else if (!name.includes(".")) out.push(...(await listTs(ports, rel)));
  }
  return out;
}

export async function parse(ports: Ports, req: CompileRequest, diagnostics: Diagnostic[]): Promise<Project> {
  const { config, error } = parseConfig(await ports.fs.read("openarc.config.json"));
  if (error) diagnostics.push(err("OARC-E051", { file: "openarc.config.json", detail: error }));
  const manifestText = await ports.fs.read(".openarc/manifest.json");
  const manifest = (manifestText ? JSON.parse(manifestText) : { schema: 1, regions: {} }) as Manifest;
  if (manifest.schema !== 1) diagnostics.push(err("OARC-E050"));
  const project: Project = {
    root: req.root, config, files: new Map(), disk: new Map(), specs: new Map(), regions: [], manifest,
    digests: new Map(), accepted: new Map(), provenance: new Map(),
  };
  for (const dir of SOURCE_DIRS)
    for (const rel of await listTs(ports, dir)) {
      const text = (await ports.fs.read(rel)) ?? "";
      project.files.set(rel, text);
      project.disk.set(rel, text);
    }
  const ids: { id: string; file: string }[] = [];
  for (const [rel, text] of srcFiles(project)) {
    const { markers, diagnostics: d1 } = scanMarkers(text);
    for (const d of d1) diagnostics.push({ ...d, file: rel });
    const { diagnostics: d2 } = buildRegionTree(markers);
    for (const d of d2) diagnostics.push({ ...d, file: rel });
    for (const m of /\bdefine(?:Region|Block)\s*(?:<[^>]*>)?\s*\(\s*\{\s*id:\s*"([^"]+)"/g[Symbol.matchAll](text)) ids.push({ id: m[1]!, file: rel });
  }
  diagnostics.push(...findDuplicateIds(ids));
  return project;
}

const srcFiles = (p: Project) => [...p.files].filter(([rel]) => rel.startsWith("src/"));

// ───────────────────────────── TypeScript program ─────────────────────────────

const sfCache = new Map<string, ts.SourceFile>();

function compilerOptions(root: string): ts.CompilerOptions {
  const cfg = ts.readConfigFile(`${root}/tsconfig.json`, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(cfg.config ?? {}, ts.sys, root);
  return { ...parsed.options, noEmit: true };
}

export function makeProgram(p: Project, overlay: Map<string, string>, old?: ts.Program): ts.Program {
  const options = compilerOptions(p.root);
  const host = ts.createCompilerHost(options, true);
  const mem = new Map([...overlay].map(([rel, t]) => [abs(p, rel), t]));
  host.readFile = (f) => mem.get(f) ?? ts.sys.readFile(f);
  host.fileExists = (f) => mem.has(f) || ts.sys.fileExists(f);
  host.getSourceFile = (f, lang) => {
    const text = host.readFile(f);
    if (text === undefined) return undefined;
    const key = `${f}\0${text.length}\0${text}`;
    let sf = sfCache.get(key);
    if (!sf) sfCache.set(key, (sf = ts.createSourceFile(f, text, lang, true)));
    return sf;
  };
  return ts.createProgram([...mem.keys()], options, host, old);
}

// ───────────────────────────── spec extraction ─────────────────────────────

function staticJson(n: ts.Expression): Json | undefined {
  if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) return n.text;
  if (ts.isNumericLiteral(n)) return Number(n.text);
  if (ts.isPrefixUnaryExpression(n) && n.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(n.operand)) return -Number(n.operand.text);
  if (n.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (n.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (n.kind === ts.SyntaxKind.NullKeyword) return null;
  if (ts.isArrayLiteralExpression(n)) {
    const out: Json[] = [];
    for (const e of n.elements) {
      const v = staticJson(e);
      if (v === undefined) return undefined;
      out.push(v);
    }
    return out;
  }
  if (ts.isObjectLiteralExpression(n)) {
    const out: { [k: string]: Json } = {};
    for (const prop of n.properties) {
      if (!ts.isPropertyAssignment(prop) || ts.isComputedPropertyName(prop.name)) return undefined;
      const key = ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name) ? prop.name.text : undefined;
      const v = staticJson(prop.initializer);
      if (key === undefined || v === undefined) return undefined;
      out[key] = v;
    }
    return out;
  }
  return undefined;
}

const intentText = (v: Json | undefined) => (Array.isArray(v) ? v.join(" ") : typeof v === "string" ? v : "");

function extractSpecs(p: Project, checker: ts.TypeChecker, diagnostics: Diagnostic[]) {
  for (const [rel] of srcFiles(p)) {
    const sf = p.program!.getSourceFile(abs(p, rel))!;
    for (const stmt of sf.statements) {
      if (!ts.isVariableStatement(stmt)) continue;
      for (const decl of stmt.declarationList.declarations) {
        const init = decl.initializer;
        if (!init || !ts.isCallExpression(init) || !ts.isIdentifier(decl.name)) continue;
        const callee = init.expression.getText(sf);
        const kind = /defineRegion$/.test(callee) ? "function" : /defineBlock$/.test(callee) ? "block" : null;
        if (!kind) continue;
        const literal = init.arguments[0] ? staticJson(init.arguments[0]) : undefined;
        const line = sf.getLineAndCharacterOfPosition(stmt.getStart(sf)).line + 1;
        if (!literal || typeof literal !== "object" || Array.isArray(literal) || typeof literal.id !== "string") {
          diagnostics.push(err("OARC-E010", { file: rel, line }));
          continue;
        }
        const id = literal.id as string;
        let signature = "", params: string[] = [], isAsync = false, typeText = "", typeNode: ts.TypeNode | undefined;
        if (kind === "function") {
          typeNode = init.typeArguments?.[0];
          const sigs = typeNode ? checker.getTypeFromTypeNode(typeNode).getCallSignatures() : [];
          if (!typeNode || sigs.length !== 1) {
            diagnostics.push(err("OARC-E010", { id, file: rel, line, detail: "F must have exactly one call signature" }));
            continue;
          }
          const sig = sigs[0]!;
          typeText = typeNode.getText(sf);
          signature = checker.signatureToString(sig, undefined, ts.TypeFormatFlags.NoTruncation);
          params = sig.getParameters().map((s) => s.name);
          isAsync = checker.typeToString(sig.getReturnType()).startsWith("Promise<");
          if (literal.refine === "next") diagnostics.push(err("OARC-E041", { id, file: rel }));
        }
        p.specs.set(id, {
          id, kind, file: rel, exportName: decl.name.text, literal,
          symbol: typeof literal.symbol === "string" ? literal.symbol : id.split(".").at(-1)!,
          deps: (literal.deps as string[] | undefined) ?? [],
          effects: (literal.effects as string[] | undefined) ?? [],
          examples: (literal.examples as Json[] | undefined) ?? [],
          intent: intentText(literal.intent),
          typeText, signature, params, isAsync, typeNode,
        });
      }
    }
  }
}

// ───────────────────────────── scaffold (§3.6) ─────────────────────────────

export function scaffoldLines(s: SpecInfo): string[] {
  return [
    `// @openarc:begin ${s.id}`,
    `export const ${s.symbol}: ${s.typeText} = (${s.params.join(", ")}) => arc.todo("${s.id}");`,
    `// @openarc:end ${s.id}`,
  ];
}

/** Insert markers + placeholder after each function spec that has none. Returns the ids scaffolded. */
export function scaffoldInMemory(p: Project, diagnostics: Diagnostic[]): string[] {
  const done: string[] = [];
  const markerIds = new Set<string>();
  for (const [, text] of srcFiles(p)) for (const m of scanMarkers(text).markers) markerIds.add(m.id);
  for (const s of p.specs.values()) {
    if (markerIds.has(s.id)) continue;
    if (s.kind === "block") {
      diagnostics.push(err("OARC-W013", { id: s.id, file: s.file }));
      continue;
    }
    const text = p.files.get(s.file)!;
    const sf = ts.createSourceFile(s.file, text, ts.ScriptTarget.Latest, true);
    const stmt = sf.statements.find((st) => ts.isVariableStatement(st) && st.declarationList.declarations.some((d) => ts.isIdentifier(d.name) && d.name.text === s.exportName))!;
    const endLine = sf.getLineAndCharacterOfPosition(stmt.getEnd()).line;
    const lines = linesOf(text);
    lines.splice(endLine + 1, 0, "", ...scaffoldLines(s));
    let out = lines.join("\n");
    if (!/import \* as arc from "openarc"/.test(out)) out = `import * as arc from "openarc";\n${out}`;
    p.files.set(s.file, out);
    done.push(s.id);
  }
  return done;
}

/** `openarc scaffold`: write markers and placeholders for every function spec that has none. */
export async function scaffoldProject(ports: Ports, p: Project, diagnostics: Diagnostic[]): Promise<string[]> {
  if (srcFiles(p).length === 0) return [];
  p.program = makeProgram(p, p.files);
  extractSpecs(p, p.program.getTypeChecker(), diagnostics);
  const ids = scaffoldInMemory(p, diagnostics);
  for (const [rel, text] of p.files) if (p.disk.get(rel) !== text) await ports.fs.write(rel, text);
  return ids;
}

// ───────────────────────────── ANALYZE ─────────────────────────────

export async function analyze(ports: Ports, req: CompileRequest, p: Project, diagnostics: Diagnostic[], opts: { offline?: boolean } = {}): Promise<void> {
  if (srcFiles(p).length === 0) return;
  p.program = makeProgram(p, p.files);
  extractSpecs(p, p.program.getTypeChecker(), diagnostics);
  if (scaffoldInMemory(p, diagnostics).length) {
    p.program = makeProgram(p, p.files, p.program);
    p.specs.clear();
    extractSpecs(p, p.program.getTypeChecker(), diagnostics);
  }
  const checker = p.program.getTypeChecker();

  for (const [rel, text] of srcFiles(p)) {
    const lines = linesOf(text);
    const { markers } = scanMarkers(text);
    const { roots } = buildRegionTree(markers);
    const walk = (node: (typeof roots)[number], parent: string | null, rootId: string | null) => {
      const spec = p.specs.get(node.id);
      if (!spec) {
        diagnostics.push(err("OARC-E012", { id: node.id, file: rel, line: node.beginLine }));
        return;
      }
      const bodyLines = lines.slice(node.beginLine, node.endLine - 1);
      const childSpans = node.children.map((c) => ({ id: c.id, from: c.beginLine - node.beginLine - 1, to: c.endLine - node.beginLine - 1 }));
      const owned = bodyLines.join("\n");
      const pending = spec.kind === "block"
        ? owned.trim() === `arc.pending("${spec.id}");`
        : owned.includes(`arc.todo("${spec.id}")`) && bodyLines.length <= 3;
      if (spec.kind === "function" && parent !== null) diagnostics.push(err("OARC-E034", { id: spec.id, file: rel }));
      if (spec.kind === "block" && rootId === null) diagnostics.push(err("OARC-E032", { id: spec.id, file: rel }));
      const myRoot = rootId ?? spec.id;
      const region: RegionInfo = {
        id: spec.id, kind: spec.kind, file: rel, parent, root: myRoot, bodyLines, childSpans,
        indent: /^\s*/.exec(lines[node.beginLine - 1]!)![0], pending,
        hash: sha256Tagged(normalizeOwnedText(bodyLines, childSpans)),
        spec, specHash: "", state: "pending", stale: true, fingerprint: "", scope: [], context0: "",
      };
      if (spec.kind === "block") {
        region.scope = blockScope(p, checker, rel, node.beginLine);
        const rootSpec = p.specs.get(myRoot);
        const usedAfter = lines.slice(node.endLine).join("\n");
        const declared = [...owned.matchAll(/\b(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/g)].map((m) => m[1]!);
        for (const d of checkRestrictions(owned, rootSpec?.isAsync ?? false, declared.filter((n) => new RegExp(`\\b${n}\\b`).test(usedAfter))))
          diagnostics.push({ ...d, id: spec.id, file: rel });
      }
      p.regions.push(region);
      for (const c of node.children) walk(c, spec.id, myRoot);
    };
    for (const r of roots) walk(r, null, null);
  }

  for (const r of p.regions) {
    const scopeJson = r.kind === "block" ? canonicalJson(r.scope) : r.spec.signature;
    r.specHash = sha256Tagged(canonicalJson(r.spec.literal) + "\n" + scopeJson);
  }
  // Ownership (§6.2) is decided before the model digest is needed, so a project with nothing to compile never calls the backend.
  for (const r of p.regions) {
    const m = p.manifest.regions[r.id];
    const view: ManifestView | null = m ? { ownership: m.ownership, hash: m.hash, specHash: m.specHash, parent: m.parent } : null;
    const { state, diagnostic } = detect(view, { present: true, pending: r.pending, parent: r.parent, hash: r.hash, specHash: r.specHash });
    r.state = state;
    r.stale = state === "pending"; // compiler regions: decided by fingerprint below; developer/conflicted: never regenerated
    if (diagnostic) diagnostics.push({ ...diagnostic, id: r.id, file: r.file });
  }
  for (const [id, m] of Object.entries(p.manifest.regions))
    if (!p.regions.some((r) => r.id === id)) diagnostics.push(err("OARC-E062", { id, file: m.file }));

  if (opts.offline) return;
  for (const r of p.regions) {
    if (r.state === "developer" || r.state === "conflicted") continue;
    const backend = backendFor(p, r.id, 0);
    const digest = await modelDigest(ports, p, backend, diagnostics);
    if (digest === null) return;
    r.context0 = buildContext(p, r, initialLevel(p, r), backend);
    const parentSpecHash = r.kind === "block" ? (p.regions.find((x) => x.id === r.root)?.specHash ?? null) : null;
    r.fingerprint = sha256Tagged(canonicalJson({
      specHash: r.specHash, parentSpecHash, context: sha256Tagged(r.context0),
      backend: { provider: backend.provider, model: backend.model, digest, seed: backend.seed ?? 1, maxContextTokens: backend.maxContextTokens },
      promptTemplate: PROMPT_TEMPLATE_VERSION, compiler: COMPILER_VERSION, typescript: ts.version,
    }));
    r.stale = p.manifest.regions[r.id]?.fingerprint !== r.fingerprint;
  }
}

/** Variables visible at a block (parameters and locals of the enclosing function, plus module helpers), as "kind name: type". */
function blockScope(p: Project, checker: ts.TypeChecker, rel: string, beginLine: number): string[] {
  const sf = p.program!.getSourceFile(abs(p, rel))!;
  const pos = sf.getPositionOfLineAndCharacter(beginLine, 0); // first body line
  let node: ts.Node = sf;
  const descend = (n: ts.Node): void => {
    n.forEachChild((c) => {
      if (c.getStart(sf) <= pos && pos < c.getEnd()) {
        node = c;
        descend(c);
      }
    });
  };
  descend(sf);
  const out: string[] = [];
  for (const sym of checker.getSymbolsInScope(node, ts.SymbolFlags.Variable | ts.SymbolFlags.Function)) {
    const decl = sym.valueDeclaration;
    if (!decl || decl.getSourceFile() !== sf || decl.getStart(sf) > pos) continue;
    if (ts.isVariableDeclaration(decl) && decl.initializer && ts.isCallExpression(decl.initializer) && /define(Region|Block)$/.test(decl.initializer.expression.getText(sf))) continue;
    const kind = ts.isParameter(decl) ? "param" : ts.isFunctionDeclaration(decl) ? "function" : ts.isVariableDeclarationList(decl.parent) && decl.parent.flags & ts.NodeFlags.Const ? "const" : "let";
    out.push(`${kind} ${sym.name}: ${checker.typeToString(checker.getTypeOfSymbolAtLocation(sym, node), undefined, ts.TypeFormatFlags.NoTruncation)}`);
  }
  return out.sort();
}

// ───────────────────────────── backends ─────────────────────────────

const initialLevel = (p: Project, r: RegionInfo): ContextLevel =>
  Math.max(p.config.regions?.[r.id]?.contextLevel ?? p.config.compilation.context.initialLevel, r.kind === "block" ? 1 : 0) as ContextLevel;

/** stage 0 = default (or per-region) backend, stage 1 = fallback backend */
function backendFor(p: Project, id: string, stage: 0 | 1): BackendConfig & { name: string } {
  const c = p.config.compilation;
  const name = stage === 1 && c.fallbackBackend ? c.fallbackBackend : (p.config.regions?.[id]?.backend ?? c.defaultBackend);
  return { ...p.config.backends[name]!, name };
}

async function modelDigest(ports: Ports, p: Project, b: BackendConfig, diagnostics: Diagnostic[]): Promise<string | null> {
  // Hosted models have no digest and can change silently behind the same id. That's acceptable: cached bodies are
  // re-verified (STATIC + SANDBOX) on every use. Never call the network here.
  if (b.provider !== "ollama") return `${b.provider}:${baseUrlOf(b)}:${b.model}`;
  const key = `${hostOf(b)} ${b.model}`;
  if (p.digests.has(key)) return p.digests.get(key)!;
  try {
    const tags = JSON.parse(await ports.http.get(`${hostOf(b)}/api/tags`)) as { models: { name: string; digest: string }[] };
    const m = tags.models.find((x) => x.name === b.model || x.name === `${b.model}:latest`);
    if (!m) {
      diagnostics.push(err("OARC-E080", { detail: `model-not-installed:${b.model}` }));
      return null;
    }
    p.digests.set(key, m.digest);
    return m.digest;
  } catch {
    diagnostics.push(err("OARC-E080", { detail: `unreachable:${hostOf(b)}` }));
    return null;
  }
}

// ───────────────────────────── context builder ─────────────────────────────

const declOf = (sym: ts.Symbol, checker: ts.TypeChecker) =>
  (sym.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(sym) : sym).declarations ?? [];

/** Source text of every project-local type declaration reachable from `roots` (the type closure). */
function typeClosure(p: Project, checker: ts.TypeChecker, roots: ts.Node[]): string[] {
  const seen = new Set<ts.Node>();
  const out: string[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isTypeReferenceNode(n) || ts.isExpressionWithTypeArguments(n) || ts.isTypeQueryNode(n)) {
      const name = ts.isTypeReferenceNode(n) ? n.typeName : ts.isTypeQueryNode(n) ? n.exprName : n.expression;
      const sym = checker.getSymbolAtLocation(name);
      for (const d of sym ? declOf(sym, checker) : []) {
        const file = d.getSourceFile().fileName;
        if (!file.startsWith(p.root + "/") || file.includes("/node_modules/") || seen.has(d)) continue;
        if (!(ts.isTypeAliasDeclaration(d) || ts.isInterfaceDeclaration(d))) continue;
        seen.add(d);
        visit(d);
        out.push(d.getText(d.getSourceFile()).trim());
      }
    }
    n.forEachChild(visit);
  };
  roots.forEach(visit);
  return out;
}

/** Exported value signatures of a local module (helpers a region may call), skipping specs. */
function moduleSignatures(sf: ts.SourceFile, checker: ts.TypeChecker): { lines: string[]; nodes: ts.Node[] } {
  const lines: string[] = [];
  const nodes: ts.Node[] = [];
  for (const st of sf.statements) {
    const exported = ts.canHaveModifiers(st) && ts.getModifiers(st)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    if (!exported) continue;
    if (ts.isFunctionDeclaration(st) && st.name) {
      const sig = checker.getSignatureFromDeclaration(st);
      lines.push(`function ${st.name.text}${sig ? checker.signatureToString(sig, undefined, ts.TypeFormatFlags.NoTruncation) : "(…)"}`);
      nodes.push(st);
    } else if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        if (!ts.isIdentifier(d.name)) continue;
        if (d.initializer && ts.isCallExpression(d.initializer) && /define(Region|Block)$/.test(d.initializer.expression.getText(sf))) continue;
        const t = d.type ? d.type.getText(sf) : checker.typeToString(checker.getTypeAtLocation(d.name), undefined, ts.TypeFormatFlags.NoTruncation);
        lines.push(`const ${d.name.text}: ${t}`);
        nodes.push(d);
      }
    }
  }
  return { lines, nodes };
}

function resolveLocal(p: Project, fromRel: string, spec: string): string | null {
  if (!spec.startsWith(".")) return null;
  const parts = fromRel.split("/").slice(0, -1);
  for (const seg of spec.split("/")) {
    if (seg === "..") parts.pop();
    else if (seg !== ".") parts.push(seg);
  }
  const rel = parts.join("/");
  return p.files.has(rel) ? rel : null;
}

const RULES = [
  "Only use imports listed under 'Allowed new imports' or already imported by the file.",
  "Never use: process, globalThis, eval, Function, fetch, require, dynamic import(), setTimeout, setInterval.",
  "Date/performance need effect 'clock'; Math.random/crypto need 'random'; console needs 'log'.",
  "Deterministic output; no I/O except through parameters.",
].join("\n");

/** Deterministic context package for one region at one level (adaptive context, see config.ts). */
export function buildContext(p: Project, r: RegionInfo, level: ContextLevel, backend: BackendConfig): string {
  const checker = p.program!.getTypeChecker();
  const s = r.spec;
  const sf = p.program!.getSourceFile(abs(p, r.file))!;
  const sections: [string, string][] = [];
  const rootSpec = p.specs.get(r.root)!;

  if (r.kind === "function") {
    sections.push(["Fixed signature (write ONLY the statements inside the braces)", `export const ${s.symbol}: ${s.typeText} = ${s.isAsync ? "async " : ""}(${s.params.join(", ")}) => {\n  /* your body */\n};\n// ${s.typeText} = ${s.signature}`]);
  } else {
    sections.push(["Task", `Write ONLY the statements that replace arc.pending("${s.id}") inside function ${rootSpec.symbol}. Do not return, break or continue out of the block; report results by assigning the 'let' variables below.${rootSpec.isAsync ? " await is allowed." : ""}`]);
    sections.push(["Variables in scope", r.scope.join("\n")]);
  }
  const typeRoots: ts.Node[] = s.typeNode ? [s.typeNode] : [];
  const helperLines: string[] = [];
  if (level >= 1 || r.kind === "block") {
    const importLines = sf.statements.filter(ts.isImportDeclaration).map((d) => d.getText(sf));
    sections.push(["Imports already in the file", importLines.join("\n")]);
    const mods = new Set<string>();
    for (const d of sf.statements.filter(ts.isImportDeclaration)) {
      const rel = resolveLocal(p, r.file, (d.moduleSpecifier as ts.StringLiteral).text);
      if (rel) mods.add(rel);
    }
    for (const dep of s.deps) {
      const rel = resolveLocal(p, r.file, dep);
      if (rel) mods.add(rel);
    }
    for (const rel of mods) {
      const msf = p.program!.getSourceFile(abs(p, rel));
      if (!msf) continue;
      const { lines, nodes } = moduleSignatures(msf, checker);
      if (lines.length) helperLines.push(`// ${rel}\n${lines.join("\n")}`);
      typeRoots.push(...nodes);
    }
    if (r.kind === "block") {
      const scopeDecls = blockScopeTypeRoots(sf, r);
      typeRoots.push(...scopeDecls);
    }
  }
  const types = typeClosure(p, checker, typeRoots);
  if (types.length) sections.push(["Types (verbatim)", types.join("\n\n")]);
  if (helperLines.length) sections.push(["Helpers you may call", helperLines.join("\n\n")]);
  sections.push(["Intent", s.intent || "(none)"]);
  if (r.kind === "function") {
    sections.push(["Effects allowed", s.effects.join(", ") || "none"]);
    sections.push(["Allowed new imports", s.deps.join(", ") || "none"]);
    if (s.examples.length)
      sections.push(["Examples (deep strict equality; {\"$fake\": name} is a test double for that parameter)", s.examples.map((e) => canonicalJson(e)).join("\n")]);
  } else {
    sections.push(["Allowed new imports", s.deps.join(", ") || "none"]);
    sections.push(["Enclosing function (your block is at <<<HERE>>>)", enclosingSource(p, r)]);
  }
  if (level >= 2) sections.push([`Full file ${r.file}`, p.files.get(r.file)!]);
  sections.push(["Rules", RULES]);

  // Budget: drop optional sections (from the end of the optional list) until the package fits.
  const budget = (backend.maxContextTokens - (backend.outputReserveTokens ?? 2048)) * 3.5; // ~3.5 chars/token
  const render = () => sections.map(([h, b]) => `## ${h}\n${b}`).join("\n\n");
  let text = render();
  for (const optional of [`Full file ${r.file}`, "Helpers you may call", "Imports already in the file"]) {
    if (text.length <= budget) break;
    const i = sections.findIndex(([h]) => h === optional);
    if (i >= 0) sections.splice(i, 1);
    text = render();
  }
  return text;
}

function blockScopeTypeRoots(sf: ts.SourceFile, r: RegionInfo): ts.Node[] {
  const out: ts.Node[] = [];
  const visit = (n: ts.Node) => {
    if ((ts.isVariableDeclaration(n) || ts.isParameter(n)) && n.type) out.push(n.type);
    n.forEachChild(visit);
  };
  const root = sf.statements.find((st) => (ts.isFunctionDeclaration(st) && st.name?.text === r.spec.symbol) || ts.isFunctionDeclaration(st));
  visit(root ?? sf);
  return out;
}

function enclosingSource(p: Project, r: RegionInfo): string {
  const root = p.regions.find((x) => x.id === r.root)!;
  const text = p.files.get(r.file)!;
  const lines = linesOf(text);
  const { roots } = buildRegionTree(scanMarkers(text).markers);
  const find = (ns: typeof roots): (typeof roots)[number] | undefined => {
    for (const n of ns) {
      if (n.id === root.id) return n;
      const c = find(n.children);
      if (c) return c;
    }
  };
  const rn = find(roots)!;
  const out: string[] = [];
  const emit = (from: number, to: number, children: typeof roots) => {
    let i = from;
    for (const c of children) {
      out.push(...lines.slice(i - 1, c.beginLine - 1));
      out.push(c.id === r.id ? `${lines[c.beginLine - 1]!.match(/^\s*/)![0]}<<<HERE>>>` : `${lines[c.beginLine - 1]!.match(/^\s*/)![0]}/* block ${c.id} */`);
      i = c.endLine + 1;
    }
    out.push(...lines.slice(i - 1, to));
  };
  emit(rn.beginLine + 1, rn.endLine - 1, rn.children);
  return out.join("\n");
}

// ───────────────────────────── PLAN ─────────────────────────────

export function plan(p: Project, req: CompileRequest, diagnostics: Diagnostic[]): string[] {
  const { targets, skipped } = selectTargets(
    p.regions.map((r) => ({ id: r.id, parent: r.parent, state: r.state, stale: r.stale })),
    req.ids,
  );
  diagnostics.push(...skipped);
  for (const id of targets) {
    const r = p.regions.find((x) => x.id === id)!;
    if (r.kind === "block" && (p.specs.get(r.root)?.examples.length ?? 0) === 0) diagnostics.push(err("OARC-W041", { id }));
    else if (r.kind === "block") diagnostics.push(err("OARC-W040", { id }));
  }
  return targets;
}

// ───────────────────────────── GENERATE ─────────────────────────────

interface Attempt {
  backend: BackendConfig & { name: string };
  level: ContextLevel;
}

/** Normalise model output (F13): strip fences; unwrap a whole function when only a body was asked for. */
export function unwrapBody(body: string, kind: "function" | "block"): string {
  let b = body.trim().replace(/^```[a-z]*\n?/i, "").replace(/\n?```$/, "").trim();
  if (kind !== "function") return b;
  const sf = ts.createSourceFile("b.ts", b, ts.ScriptTarget.Latest, true);
  if (sf.statements.length !== 1) return b;
  const st = sf.statements[0]!;
  let fn: ts.FunctionLikeDeclaration | undefined;
  if (ts.isFunctionDeclaration(st)) fn = st;
  else if (ts.isVariableStatement(st) && st.declarationList.declarations.length === 1) {
    const init = st.declarationList.declarations[0]!.initializer;
    if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) fn = init;
  }
  if (!fn?.body) return b;
  if (ts.isBlock(fn.body)) return fn.body.statements.map((s) => s.getText(sf)).join("\n");
  return `return ${fn.body.getText(sf)};`;
}

/** Names bound at module level in a file (imports and top-level declarations). */
function fileBindings(text: string): Set<string> {
  const sf = ts.createSourceFile("f.ts", text, ts.ScriptTarget.Latest, true);
  const out = new Set<string>();
  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st) && st.importClause) {
      const c = st.importClause;
      if (c.name) out.add(c.name.text);
      if (c.namedBindings && ts.isNamespaceImport(c.namedBindings)) out.add(c.namedBindings.name.text);
      if (c.namedBindings && ts.isNamedImports(c.namedBindings)) c.namedBindings.elements.forEach((e) => out.add(e.name.text));
    }
    if (ts.isVariableStatement(st)) st.declarationList.declarations.forEach((d) => ts.isIdentifier(d.name) && out.add(d.name.text));
    if ((ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st)) && st.name) out.add(st.name.text);
  }
  return out;
}

/** Static rules (§7) on a candidate body. Best-effort: the sandbox is the real boundary. */
export function staticCheck(body: string, effects: string[], fileBound: Set<string> = new Set()): { diag: Diagnostic; message: string }[] {
  const sf = ts.createSourceFile("c.ts", `async function __w() {\n${body}\n}`, ts.ScriptTarget.Latest, true);
  const out: { diag: Diagnostic; message: string }[] = [];
  const declared = new Set<string>(fileBound); // a file import named `crypto` is not the global
  const collect = (n: ts.Node) => {
    if ((ts.isVariableDeclaration(n) || ts.isParameter(n) || ts.isFunctionDeclaration(n) || ts.isBindingElement(n)) && n.name && ts.isIdentifier(n.name)) declared.add(n.name.text);
    n.forEachChild(collect);
  };
  collect(sf);
  const forbidden = new Set(["process", "globalThis", "global", "window", "self", "eval", "Function", "fetch", "XMLHttpRequest", "WebSocket", "Deno", "Bun", "setTimeout", "setInterval", "queueMicrotask", "require"]);
  const gated: Record<string, string> = { Date: "clock", performance: "clock", crypto: "random", console: "log" };
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword)
      out.push({ diag: err("OARC-E072"), message: "dynamic import() is not allowed" });
    if (ts.isIdentifier(n) && !declared.has(n.text)) {
      const parent = n.parent;
      const isPropName = (ts.isPropertyAccessExpression(parent) && parent.name === n) || (ts.isPropertyAssignment(parent) && parent.name === n);
      if (!isPropName) {
        if (forbidden.has(n.text)) out.push({ diag: err("OARC-E073", { detail: n.text }), message: `'${n.text}' is forbidden in regions` });
        const need = gated[n.text];
        if (need && !effects.includes(need)) out.push({ diag: err("OARC-E074", { detail: n.text }), message: `'${n.text}' requires effect '${need}'` });
        if (n.text === "Math" && ts.isPropertyAccessExpression(parent) && parent.name.text === "random" && !effects.includes("random"))
          out.push({ diag: err("OARC-E074", { detail: "Math.random" }), message: "Math.random requires effect 'random'" });
      }
    }
    n.forEachChild(visit);
  };
  visit(sf);
  return out;
}

// ───────────────────────────── write scope (structural, not instructions) ─────────────────────────────
// The model never writes files. It returns a body string; the compiler is the only writer, and it
// enforces that a body can only ever land between its own region's markers.

/** The body must parse as exactly one function body: it cannot close its braces and escape the region. */
export function guardBody(body: string): string | null {
  // Markers are recognised on comment tokens only (F2), so "@openarc:" inside a string or regex is inert and
  // allowed (the marker scanner itself needs it). Reject marker-shaped LINES (line-based locators must never be
  // fooled, even by a template-literal line) and any comment that mentions @openarc:.
  if (linesOf(body).some((l) => /^\s*\/\/\s*@openarc:/.test(l))) return "OARC-E097 body contains a marker-shaped line (markers belong to the compiler)";
  const text = `async function __region() {\n${body}\n}\n`;
  const sf = ts.createSourceFile("g.ts", text, ts.ScriptTarget.Latest, true);
  const comments: string[] = [];
  const walk = (n: ts.Node): void => {
    const kids = n.getChildren(sf);
    if (kids.length) return kids.forEach(walk);
    for (const r of [...(ts.getLeadingCommentRanges(text, n.pos) ?? []), ...(ts.getTrailingCommentRanges(text, n.end) ?? [])]) comments.push(text.slice(r.pos, r.end));
  };
  walk(sf);
  if (comments.some((c) => c.includes("@openarc:"))) return "OARC-E097 body has a comment mentioning @openarc: (markers belong to the compiler)";
  const syntax = ts.transpileModule(text, { reportDiagnostics: true, compilerOptions: { target: ts.ScriptTarget.ES2023 } }).diagnostics ?? [];
  if (syntax.length) return `OARC-E097 body has syntax errors: ${ts.flattenDiagnosticMessageText(syntax[0]!.messageText, " ")}`;
  if (sf.statements.length !== 1) return "OARC-E097 body escapes its region (it does not parse as a single function body)";
  return null;
}

/** Outside the region, the file must be byte-identical, except for added import declarations. */
export function guardSplice(before: string, after: string, id: string): string | null {
  const outside = (text: string) => {
    const lines = linesOf(text);
    const b = lines.findIndex((l) => l.trim() === `// @openarc:begin ${id}`);
    const e = lines.findIndex((l) => l.trim() === `// @openarc:end ${id}`);
    return b < 0 || e < b ? null : [...lines.slice(0, b + 1), ...lines.slice(e)];
  };
  const o1 = outside(before), o2 = outside(after);
  if (!o1 || !o2) return `OARC-E097 markers of ${id} changed`;
  const isImport = (l: string) => /^import (type )?\{[^}]*\} from "[^"]+";$/.test(l);
  const remaining = [...o2];
  for (let i = 0, j = 0; j < remaining.length; ) {
    if (i < o1.length && remaining[j] === o1[i]) {
      i++;
      j++;
    } else if (isImport(remaining[j]!)) remaining.splice(j, 1);
    else return `OARC-E097 write outside region ${id} (line ${j + 1}: ${remaining[j]!.slice(0, 80)})`;
  }
  return remaining.length === o1.length ? null : `OARC-E097 text outside region ${id} was removed`;
}

/** Texts of every spec statement (defineRegion/defineBlock) in a file, in order. */
export function specStatements(text: string): string[] {
  const sf = ts.createSourceFile("s.ts", text, ts.ScriptTarget.Latest, true);
  return sf.statements
    .filter((st) => ts.isVariableStatement(st) && st.declarationList.declarations.some((d) => d.initializer && ts.isCallExpression(d.initializer) && /define(Region|Block)$/.test(d.initializer.expression.getText(sf))))
    .map((st) => st.getText(sf));
}

/** Replace a region's body in `text`, re-locating it by its markers. */
export function spliceRegion(text: string, id: string, newBody: string[]): string {
  const lines = linesOf(text);
  const { roots } = buildRegionTree(scanMarkers(text).markers);
  const find = (ns: typeof roots): (typeof roots)[number] | undefined => {
    for (const n of ns) {
      if (n.id === id) return n;
      const c = find(n.children);
      if (c) return c;
    }
  };
  const n = find(roots);
  if (!n) throw new Error(`splice: markers for ${id} not found`);
  lines.splice(n.beginLine, n.endLine - n.beginLine - 1, ...newBody);
  return lines.join("\n");
}

function regionBodyLines(r: RegionInfo, body: string): string[] {
  const inner = linesOf(body.replace(/\r/g, "")).map((l) => (l.trim() ? `${r.indent}  ${l}` : ""));
  if (r.kind === "block") return linesOf(body.replace(/\r/g, "")).map((l) => (l.trim() ? `${r.indent}${l}` : ""));
  const s = r.spec;
  const exported = r.bodyLines[0]?.trimStart().startsWith("export") ?? true;
  return [
    `${r.indent}${exported ? "export " : ""}const ${s.symbol}: ${s.typeText} = ${s.isAsync ? "async " : ""}(${s.params.join(", ")}) => {`,
    ...inner,
    `${r.indent}};`,
  ];
}

function mergeImports(text: string, imports: { from: string; names: string[] }[], typeOnly: (from: string, name: string) => boolean): string {
  const sf = ts.createSourceFile("m.ts", text, ts.ScriptTarget.Latest, true);
  const have = new Set<string>();
  for (const d of sf.statements.filter(ts.isImportDeclaration)) {
    const c = d.importClause;
    if (c?.name) have.add(c.name.text);
    if (c?.namedBindings && ts.isNamedImports(c.namedBindings)) c.namedBindings.elements.forEach((e) => have.add(e.name.text));
    if (c?.namedBindings && ts.isNamespaceImport(c.namedBindings)) have.add(c.namedBindings.name.text);
  }
  const add: string[] = [];
  for (const imp of imports) {
    const names = imp.names.filter((n) => !have.has(n));
    if (!names.length) continue;
    const values = names.filter((n) => !typeOnly(imp.from, n));
    const types = names.filter((n) => typeOnly(imp.from, n));
    if (values.length) add.push(`import { ${values.join(", ")} } from "${imp.from}";`);
    if (types.length) add.push(`import type { ${types.join(", ")} } from "${imp.from}";`);
    names.forEach((n) => have.add(n));
  }
  if (!add.length) return text;
  const imports_ = sf.statements.filter(ts.isImportDeclaration);
  const at = imports_.length ? sf.getLineAndCharacterOfPosition(imports_.at(-1)!.getEnd()).line + 1 : 0;
  const lines = linesOf(text);
  lines.splice(at, 0, ...add);
  return lines.join("\n");
}

const TS_MISSING_CONTEXT = new Set([2304, 2305, 2339, 2551, 2552, 2724]); // cannot find name/property/export: a context problem

export async function generate(ports: Ports, req: CompileRequest, p: Project, id: string, diagnostics: Diagnostic[]): Promise<{ candidate: Candidate | null; modelCalls: number }> {
  const r = p.regions.find((x) => x.id === id)!;
  const c = p.config.compilation;
  let level = initialLevel(p, r);
  let stage: 0 | 1 = 0;
  let modelCalls = 0;
  let previous: { body: string; problems: string[] } | null = null;
  const cachePath = `.openarc/cache/${r.fingerprint.replace("sha256:", "")}.json`;
  const cached = await ports.fs.read(cachePath);

  for (let attempt = 1; attempt <= c.maxAttempts; attempt++) {
    const backend = backendFor(p, id, stage);
    const at: Attempt = { backend, level };
    let body: string;
    let imports: { from: string; names: string[] }[];
    if (attempt === 1 && cached) {
      ({ body, imports } = JSON.parse(cached) as { body: string; imports: { from: string; names: string[] }[] });
      ports.log(`  ${id}: cache hit`);
    } else {
      const digest = await modelDigest(ports, p, backend, diagnostics);
      if (digest === null) return { candidate: null, modelCalls };
      const context = attempt === 1 && level === initialLevel(p, r) ? r.context0 : buildContext(p, r, level, backend);
      const rendered = renderTemplate(PROMPT_TEMPLATE, {
        context,
        repair: previous ? `## Your previous attempt failed\nPrevious body:\n${previous.body}\n\nProblems:\n${previous.problems.join("\n")}\n\nFix these problems.` : "",
      });
      if (!rendered.ok) throw new Error(`prompt template is missing ${rendered.missing.join(", ")}`);
      const t0 = Date.now();
      let raw: string;
      try {
        raw = await complete(
          ports,
          backend,
          "You are a compiler backend. You output JSON only: {\"body\": string, \"imports\": [{\"from\": string, \"names\": string[]}]}. body is TypeScript statements only, with no markdown.",
          rendered.text,
        );
      } catch (e) {
        diagnostics.push(err("OARC-E080", { id, detail: (e as Error).message.slice(0, 120) }));
        return { candidate: null, modelCalls };
      }
      modelCalls++;
      const parsed = parseOutput(raw);
      ports.log(`  ${id}: attempt ${attempt} via ${backend.name} (${backend.model}), context L${level} ${context.length} chars, ${((Date.now() - t0) / 1000).toFixed(1)}s`);
      if (!parsed.ok) {
        previous = { body: raw.slice(0, 2000), problems: [`output was not valid: ${parsed.diagnostic.detail}`] };
        continue;
      }
      body = parsed.body;
      imports = parsed.imports;
    }
    body = unwrapBody(body, r.kind);
    const result = await verify(ports, req, p, r, body, imports);
    if (result.ok) {
      if (!(attempt === 1 && cached)) await ports.fs.write(cachePath, JSON.stringify({ body, imports }));
      p.provenance.set(id, { source: "generated", backend: at.backend.name, model: at.backend.model, contextLevel: at.level, attempts: attempt, verifiedBy: result.verifiedBy });
      ports.log(`  ${id}: ✓ ${result.verifiedBy.join(", ")}`);
      return { candidate: { id, body, imports, verifiedBy: result.verifiedBy }, modelCalls };
    }
    ports.log(`  ${id}: ✗ ${result.problems[0]?.slice(0, 160)}`);
    previous = { body, problems: result.problems };
    // Escalation by failure type: a missing name means a context problem, so expand; otherwise repair at the same level.
    // The last attempt switches to the fallback backend when one is configured.
    if (c.context.expandOnFailure && result.missingContext && level < 2) level = (level + 1) as ContextLevel;
    if (attempt === c.maxAttempts - 1 && c.fallbackBackend) stage = 1;
  }
  diagnostics.push(err("OARC-E082", { id, detail: previous?.problems[0]?.slice(0, 200) }));
  return { candidate: null, modelCalls };
}

interface Verified {
  ok: boolean;
  problems: string[];
  verifiedBy: string[];
  missingContext: boolean;
}

async function verify(ports: Ports, req: CompileRequest, p: Project, r: RegionInfo, body: string, imports: { from: string; names: string[] }[]): Promise<Verified> {
  const fail = (problems: string[], missingContext = false): Verified => ({ ok: false, problems, verifiedBy: [], missingContext });
  // static
  const allowed = new Set([...r.spec.deps, "openarc"]);
  const bad = imports.filter((i) => !allowed.has(i.from));
  if (bad.length) return fail(bad.map((i) => `OARC-E071 import "${i.from}" is not in deps (allowed: ${[...allowed].join(", ")})`));
  const st = staticCheck(body, r.spec.effects, fileBindings(p.accepted.get(r.file) ?? p.files.get(r.file)!));
  if (st.length) return fail(st.map((s) => `${s.diag.code} ${s.message}`));
  if (r.kind === "block") {
    const rs = checkRestrictions(body, p.specs.get(r.root)?.isAsync ?? false, []);
    if (rs.length) return fail(rs.map((d) => `OARC-E035 not allowed in a block: ${d.detail}`));
  }
  const escape = guardBody(body);
  if (escape) return fail([escape]);
  // splice into the in-memory copy (with this run's accepted candidates) and type-check
  const base = p.accepted.get(r.file) ?? p.files.get(r.file)!;
  const typeOnly = (from: string, name: string) => {
    const rel = resolveLocal(p, r.file, from);
    const t = rel ? p.files.get(rel) ?? "" : "";
    return new RegExp(`export\\s+(type|interface)\\s+${name}\\b`).test(t);
  };
  const text = mergeImports(spliceRegion(base, r.id, regionBodyLines(r, body)), imports, typeOnly);
  const outside = guardSplice(base, text, r.id);
  if (outside) return fail([outside]);
  const overlay = new Map(p.files);
  for (const [k, v] of p.accepted) overlay.set(k, v);
  overlay.set(r.file, text);
  const prog = makeProgram(p, overlay, p.program);
  const sf = prog.getSourceFile(abs(p, r.file))!;
  const tsDiags = [...prog.getSyntacticDiagnostics(sf), ...prog.getSemanticDiagnostics(sf)].filter((d) => d.category === ts.DiagnosticCategory.Error);
  if (tsDiags.length) {
    const msgs = tsDiags.slice(0, 6).map((d) => {
      const line = d.start !== undefined ? sf.getLineAndCharacterOfPosition(d.start).line : 0;
      return `OARC-E070 TS${d.code} line ${line + 1}: ${ts.flattenDiagnosticMessageText(d.messageText, "\n")}\n    > ${linesOf(text)[line]?.trim()}`;
    });
    return fail(msgs, tsDiags.some((d) => TS_MISSING_CONTEXT.has(d.code)));
  }
  const verifiedBy = ["tsc", "static"];
  // examples in the sandbox: the region's own (function) or its enclosing function's (block)
  const rootSpec = p.specs.get(r.root)!;
  if (rootSpec.examples.length) {
    const res = await runSandbox(ports, req, p, r.root, overlay);
    const pendingSiblings = (o: { actual?: Json }) =>
      typeof o.actual === "object" && o.actual !== null && !Array.isArray(o.actual) && typeof o.actual.pending === "string" && r.kind === "block";
    const real = res.failed.filter((o) => !pendingSiblings(o));
    if (res.error) return fail([res.error]);
    if (real.length || (!res.complete && r.kind === "function"))
      return fail(real.map((o) => `OARC-E090 example "${o.name}" failed: got ${JSON.stringify(o.actual)}; expected ${JSON.stringify(exampleExpected(rootSpec, o.name))}`).concat(res.complete ? [] : ["OARC-E090 harness output incomplete (process exited early?)"]));
    verifiedBy.push(`examples:${res.passed}/${rootSpec.examples.length}${res.failed.length ? ` (${res.failed.length} inconclusive: sibling blocks pending)` : ""}`);
    if (r.kind === "block") verifiedBy.push(`via:${r.root}`);
  }
  p.accepted.set(r.file, text);
  return { ok: true, problems: [], verifiedBy, missingContext: false };
}

function exampleExpected(spec: SpecInfo, name: string): Json {
  const exs = spec.examples as { name?: string; expected?: Json; fakesAfter?: Json }[];
  const i = exs.findIndex((e, k) => (e.name ?? `#${k + 1}`) === name);
  const e = exs[i];
  return e ? (e.expected ?? { fakesAfter: e.fakesAfter ?? null }) : null;
}

// ───────────────────────────── sandbox ─────────────────────────────

async function runSandbox(ports: Ports, req: CompileRequest, p: Project, rootId: string, overlay: Map<string, string>): Promise<{ complete: boolean; passed: number; failed: { name: string; actual?: Json }[]; error?: string }> {
  const dir = p.sandboxDir ?? (p.sandboxDir = `.openarc/sandbox/${Date.now().toString(36)}`);
  if ((await ports.fs.read(`${dir}/package.json`)) === null) {
    for (const f of ["package.json", "tsconfig.json", ".openarc/harness.mjs", ...SOURCE_DIRS.map((d) => `${d}/package.json`)]) {
      const t = await ports.fs.read(f);
      if (t !== null) await ports.fs.write(`${dir}/${f}`, t);
    }
    const cp = await ports.proc.run(["cp", "-al", `${p.root}/node_modules`, `${p.root}/${dir}/node_modules`], 60_000);
    if (cp.code !== 0) return { complete: false, passed: 0, failed: [], error: `OARC-E092 could not stage node_modules: ${cp.stdout}` };
  }
  for (const [rel, text] of overlay) await ports.fs.write(`${dir}/${rel}`, text);
  const spec = p.specs.get(rootId)!;
  // Examples are passed from the compiler's STATIC extraction: a body that mutates spec.examples at runtime cannot weaken its own tests.
  await ports.fs.write(`${dir}/.openarc/harness-plan.json`, JSON.stringify({ [rootId]: { module: spec.file, symbol: spec.symbol, specExport: spec.exportName, examples: spec.examples } }));
  const sb = p.config.sandbox ?? {};
  const argv = buildArgv({
    stageDir: `${p.root}/${dir}`, nodeBin: req.sandbox.nodeBin, nodePrefix: req.sandbox.nodePrefix,
    heapMb: sb.heapMb ?? req.sandbox.heapMb, addressSpaceBytes: sb.addressSpaceBytes ?? req.sandbox.addressSpaceBytes,
    cpuSeconds: sb.cpuSeconds ?? req.sandbox.cpuSeconds, regionId: rootId,
  });
  const res = await ports.proc.run(argv, ((sb.cpuSeconds ?? req.sandbox.cpuSeconds) + 20) * 1000);
  if (res.timedOut) return { complete: false, passed: 0, failed: [], error: "OARC-E091 sandbox timed out" };
  const summary = readHarnessOutput(res.stdout);
  if (!summary.complete && summary.passed === 0 && summary.failed.length === 0)
    return { ...summary, error: `OARC-E090 harness crashed (exit ${res.code}): ${res.stdout.slice(-600)}` };
  return summary;
}

// ───────────────────────────── STAGE ─────────────────────────────

/** Apply candidates, run the joint check for blocks, build the new manifest, and write staged files. */
export async function stage(ports: Ports, req: CompileRequest, p: Project, candidates: Candidate[], txid: string, diagnostics: Diagnostic[]): Promise<StagedFile[]> {
  // joint check: a function whose blocks were generated in this run must pass ALL its examples now (F14).
  // With --keep-going, a function that still has pending blocks can't run its examples yet; its blocks stay individually verified.
  const generatedIds = new Set(candidates.map((c) => c.id));
  const stillPending = (rootId: string) => p.regions.some((r) => r.root === rootId && r.kind === "block" && r.pending && !generatedIds.has(r.id));
  const roots = new Set(candidates.map((c) => p.regions.find((r) => r.id === c.id)!).filter((r) => r.kind === "block").map((r) => r.root).filter((id) => !stillPending(id)));
  const overlay = new Map(p.files);
  for (const [k, v] of p.accepted) overlay.set(k, v);
  for (const rootId of roots) {
    if (!p.specs.get(rootId)!.examples.length) continue;
    const res = await runSandbox(ports, req, p, rootId, overlay);
    if (res.error || res.failed.length || !res.complete) {
      diagnostics.push(err("OARC-E090", { id: rootId, detail: `joint:${res.error ?? res.failed.map((f) => f.name).join(",")}` }));
      return [];
    }
  }
  if (p.sandboxDir) await ports.fs.remove(p.sandboxDir);

  const files = new Map(overlay);
  const manifest: Manifest = { schema: 1, regions: {} };
  const generated = new Set(candidates.map((c) => c.id));
  for (const r of p.regions) {
    const text = files.get(r.file)!;
    const old = p.manifest.regions[r.id];
    let hash = r.hash;
    if (generated.has(r.id)) {
      const tree = buildRegionTree(scanMarkers(text).markers).roots;
      const flat = (ns: typeof tree): typeof tree => ns.flatMap((n) => [n, ...flat(n.children)]);
      const n = flat(tree).find((x) => x.id === r.id)!;
      const body = linesOf(text).slice(n.beginLine, n.endLine - 1);
      hash = sha256Tagged(normalizeOwnedText(body, n.children.map((c) => ({ id: c.id, from: c.beginLine - n.beginLine - 1, to: c.endLine - n.beginLine - 1 }))));
    } else if (r.state === "pending") continue;
    const base = { kind: r.kind, parent: r.parent, file: r.file, ...(r.kind === "function" ? { symbol: r.spec.symbol } : {}) };
    if (generated.has(r.id)) {
      manifest.regions[r.id] = { ...base, ownership: "compiler", hash, specHash: r.specHash, fingerprint: r.fingerprint, provenance: { ...p.provenance.get(r.id)!, at: ports.now() } };
    } else if (r.state === "compiler") {
      manifest.regions[r.id] = old!;
    } else if (r.state === "developer") {
      manifest.regions[r.id] = old
        ? { ...old, ownership: "developer", hash: r.hash }
        : { ...base, ownership: "developer", hash: r.hash, specHash: r.specHash, fingerprint: null, provenance: { source: "extracted", at: ports.now() } };
    } else if (old) manifest.regions[r.id] = { ...old, ownership: "conflicted" };
  }
  const out: StagedFile[] = [];
  for (const [rel, text] of files) {
    if (p.disk.get(rel) === text) continue;
    // Spec integrity, enforced on bytes: only src/ may change (never tests, fakes or core), and every
    // spec statement must be identical to the one on disk. Scaffolding and generation only touch region bodies and imports.
    const before = p.disk.get(rel) ?? "";
    if (!rel.startsWith("src/") || specStatements(before).join("\n") !== specStatements(text).join("\n")) {
      diagnostics.push(err("OARC-E097", { file: rel, detail: "spec-integrity" }));
      return [];
    }
    out.push({ target: rel, text });
  }
  out.push({ target: ".openarc/manifest.json", text: JSON.stringify(manifest, null, 2) + "\n" });
  for (const [i, f] of out.entries()) await ports.fs.write(`.openarc/txn/${txid}/stage/${i}`, f.text);
  return out;
}
