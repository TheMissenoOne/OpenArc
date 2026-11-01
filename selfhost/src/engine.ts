// OpenArc engine: everything compile.run's blocks call. HAND-WRITTEN bootstrap code (not a region yet).
// Each block in compile.ts is one or two calls into this module, which keeps the blocks small enough
// for a small model to regenerate. Regionizing the engine itself is the next self-hosting step.
import ts from "typescript";
import type { Json } from "open-arc";
import type { Candidate, ChildSpan, CompileRequest, Diagnostic, ImportDecl, ManifestView, Ports, RegionState, StagedFile } from "./types.ts";
import type { BackendConfig, ContextLevel, OpenArcConfig } from "./config.ts";
import { DEFAULT_OUTPUT_RESERVE, hostOf, parseConfig } from "./config.ts";
import { scanMarkers, buildRegionTree } from "./markers.ts";
import { findDuplicateIds, isValidId } from "./ids.ts";
import { canonicalJson, normalizeOwnedText, sha256Tagged } from "./hash.ts";
import { detect } from "./ownership.ts";
import { checkRestrictions } from "./block.ts";
import { selectTargets } from "./plan.ts";
import { BATCH_PROMPT_TEMPLATE, PROMPT_TEMPLATE_VERSION, PROMPT_TEMPLATE, renderTemplate, parseOutput } from "./model.ts";
import { OUTPUT_SCHEMA, STRICT_OUTPUT_SCHEMA, addTokens, baseUrlOf, completeWithUsage, isOllamaCompat, type Tokens } from "./backends.ts";
import { BATCH_CODE_PROMPT_TEMPLATE, BATCH_CODE_SYSTEM, CODE_PROMPT_TEMPLATE, CODE_PROMPT_TEMPLATE_VERSION, CODE_SYSTEM, codeRules, parseCodeOutput, splitCodeSections } from "./output-format.ts";
import { buildArgv, readHarnessOutput } from "./sandbox.ts";
import { readFileSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, posix, sep } from "node:path";
import { HARNESS_ENTRY, bwrapReadPaths, tierArgv } from "./isolation.ts";
// palette (structured specs, SPEC §2.5, §2.6, §3.7): concepts, UI specs and sketches; hooks below are marked `palette:`
import * as sketch from "./sketch.ts";
import * as concepts from "./concepts.ts";
import * as ui from "./ui.ts";
// code-first (SPEC §3.8, §2.7): implicit regions, tests as code; hooks below are marked `code-first:`
import * as implicit from "./implicit.ts";
import * as testsPlan from "./tests-plan.ts";

const versionAt = (rel: string): string | undefined => {
  try {
    return (JSON.parse(readFileSync(new URL(rel, import.meta.url), "utf8")) as { version?: string }).version;
  } catch {
    return undefined;
  }
};
/** The release version, so cache keys (fingerprints) change with every release. Source tree: core/package.json;
 *  published package (dist/src/engine.js): the package's own package.json. */
export const COMPILER_VERSION: string = versionAt("../core/package.json") ?? versionAt("../../package.json") ?? "0.0.0";
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
  calls?: string[]; // allowlist of imported/port functions the body may call (§7 rule 6); absent: unrestricted
  typeText: string; // F as written, e.g. "IsValidId"
  signature: string; // printed call signature, e.g. "(id: string) => boolean"
  params: string[];
  isAsync: boolean;
  typeNode?: ts.TypeNode;
  sketch?: sketch.SketchInfo; // palette: the body as typed code with holes (§3.7)
  ui?: ui.UiInfo; // palette: the component's structure, read from a *.spec.tsx file (§2.6)
  codeFirst?: implicit.CodeFirstInfo; // code-first: the declaration is the spec (§3.8)
  backend?: string; // code-first: `@arc backend` / arc.configure (openarc.config.json regions[id] still wins)
  outputFormat?: "json" | "code"; // code-first: likewise
}

export interface ManifestEntry {
  kind: "function" | "block";
  declaration?: string; // code-first: "RoundRobin.pick" (display only)
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
  typeImports: Map<string, string>; // closure types shown in context but not in scope in the file: name -> import specifier
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
  crlf: Set<string>; // files that are CRLF on disk: held as LF in `files` (hashes match on every OS), written back as CRLF
  provenance: Map<string, { [k: string]: Json }>;
  e080Streak: number; // consecutive OARC-E080s in this run; generate stops calling the backend at 3
  concepts?: Map<string, concepts.ConceptInfo>; // palette: defineConcept statements, by id
  tests?: testsPlan.TestInfo[]; // code-first: every arc.test/arc.law statement, in file then source order
  scaffolds?: implicit.Scaffolded[]; // code-first: markers inserted in memory inside pending bodies
  codeFirstIds?: Set<string>; // code-first: every code-first region id (pending or with markers), known before extractSpecs
  targets?: string[]; // plan's targets, in order: batchReply looks ahead for a region's file siblings
  batched?: Map<string, BatchShare>; // a batched first reply waiting for its region's generate
}

const err = (code: Diagnostic["code"], extra: Omit<Diagnostic, "code"> = {}): Diagnostic => ({ code, ...extra });
const linesOf = (t: string) => t.split("\n");
const abs = (p: Project, rel: string) => `${p.root}/${rel}`;
/** Only files whose every line ends in CRLF; a mixed file is kept byte for byte, as before. */
const isCrlf = (t: string) => t.includes("\r\n") && !/(^|[^\r])\n/.test(t);
/** The bytes to write for `text` (LF, as held in p.files): the file's own line endings. */
export const toDisk = (p: Project, rel: string, text: string) => (p.crlf.has(rel) ? text.replaceAll("\n", "\r\n") : text);

// ───────────────────────────── PARSE ─────────────────────────────

async function listTs(ports: Ports, dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const name of await ports.fs.list(dir)) {
    const rel = `${dir}/${name}`;
    if (/\.tsx?$/.test(name)) out.push(rel); // palette: .tsx for UI specs and components
    else if (!name.includes(".") && name !== "node_modules") out.push(...(await listTs(ports, rel)));
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
    // TypeScript reports file names with forward slashes, also on Windows; abs() must build the same strings
    root: sep === "\\" ? req.root.replaceAll("\\", "/") : req.root, config, files: new Map(), disk: new Map(), specs: new Map(), regions: [], manifest,
    digests: new Map(), accepted: new Map(), provenance: new Map(), e080Streak: 0, crlf: new Set(),
  };
  for (const dir of SOURCE_DIRS)
    for (const rel of await listTs(ports, dir)) {
      const text = (await ports.fs.read(rel)) ?? "";
      project.disk.set(rel, text);
      if (isCrlf(text)) project.crlf.add(rel);
      project.files.set(rel, project.crlf.has(rel) ? text.replaceAll("\r\n", "\n") : text);
    }
  // code-first: test files under tests/ (src/ is read already); never written, staged for the sandbox
  const load = (rel: string, text: string) => {
    project.disk.set(rel, text);
    if (isCrlf(text)) project.crlf.add(rel);
    project.files.set(rel, project.crlf.has(rel) ? text.replaceAll("\r\n", "\n") : text);
  };
  const testsDir = await listTs(ports, "tests");
  for (const rel of testsDir) {
    if (project.files.has(rel) || !testsPlan.testFile(rel)) continue;
    const text = (await ports.fs.read(rel)) ?? "";
    if (/\barc\.(test|law|configure)\b/.test(text)) load(rel, text);
  }
  // ...and the tests/ modules they import, transitively (helpers without tests of their own), so the stage has them
  const inTests = new Set(testsDir);
  const queue = [...project.files].filter(([, t]) => /\barc\.(test|law)\b/.test(t)).map(([rel]) => rel);
  for (let rel = queue.pop(); rel !== undefined; rel = queue.pop())
    for (const { fileName } of ts.preProcessFile(project.files.get(rel)!, true, true).importedFiles) {
      if (!fileName.startsWith(".")) continue;
      const to = posix.normalize(posix.join(posix.dirname(rel), fileName));
      const hit = [to, to.replace(/\.js$/, ".ts"), to.replace(/\.jsx$/, ".tsx"), `${to}.ts`, `${to}.tsx`, `${to}/index.ts`].find((f) => inTests.has(f));
      if (!hit || project.files.has(hit)) continue;
      load(hit, (await ports.fs.read(hit)) ?? "");
      queue.push(hit);
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
  host.directoryExists = (d) => ts.sys.directoryExists(d) || [...mem.keys()].some((f) => f.startsWith(`${d}/`)); // overlay-only directories (tests)
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
  p.concepts = new Map(); // palette
  const once = (d: Diagnostic) => diagnostics.some((x) => x.code === d.code && x.id === d.id && x.file === d.file && x.detail === d.detail) || diagnostics.push(d); // extraction runs again after scaffolding
  for (const [rel] of srcFiles(p)) {
    const sf = p.program!.getSourceFile(abs(p, rel))!;
    for (const stmt of sf.statements) {
      if (!ts.isVariableStatement(stmt)) continue;
      for (const decl of stmt.declarationList.declarations) {
        const init = decl.initializer;
        if (!init || !ts.isCallExpression(init) || !ts.isIdentifier(decl.name)) continue;
        const callee = init.expression.getText(sf);
        const kind = /defineRegion$/.test(callee) ? "function" : /defineBlock$/.test(callee) ? "block" : null;
        if (/defineConcept$/.test(callee)) { // palette: a concept is static JSON, read like a spec (§2.5)
          const c = concepts.readConcept(init.arguments[0] ? staticJson(init.arguments[0]) : undefined, rel);
          const cline = sf.getLineAndCharacterOfPosition(stmt.getStart(sf)).line + 1;
          if ("error" in c) once(err("OARC-E010", { file: rel, line: cline, detail: c.error }));
          else if (p.concepts.has(c.id)) once(err("OARC-E011", { file: rel, line: cline, detail: `duplicate concept id ${c.id} (first declared in ${p.concepts.get(c.id)!.file})` }));
          else p.concepts.set(c.id, c);
        }
        if (!kind) continue;
        // palette: `sketch` and `ui` are read as syntax, not as JSON
        const arg = init.arguments[0], own = (k: string) => (arg && ts.isObjectLiteralExpression(arg) ? arg.properties.find((x): x is ts.PropertyAssignment => ts.isPropertyAssignment(x) && x.name.getText(sf) === k) : undefined);
        const syn = own("sketch"), uiProp = own("ui");
        const literal = arg ? staticJson(syn || uiProp ? ts.factory.updateObjectLiteralExpression(arg as ts.ObjectLiteralExpression, (arg as ts.ObjectLiteralExpression).properties.filter((x) => x !== syn && x !== uiProp)) : arg) : undefined;
        const line = sf.getLineAndCharacterOfPosition(stmt.getStart(sf)).line + 1;
        if (!literal || typeof literal !== "object" || Array.isArray(literal) || typeof literal.id !== "string") {
          diagnostics.push(err("OARC-E010", { file: rel, line }));
          continue;
        }
        const id = literal.id as string;
        // the model needs some guidance. code-first: a defineRegion that attaches to a declaration has its JSDoc
        if (literal.intent === undefined && !syn && !uiProp && literal.concept === undefined && !p.codeFirstIds?.has(id)) {
          diagnostics.push(err("OARC-E010", { id, file: rel, line, detail: "intent is required unless sketch, ui or concept is present" }));
          continue;
        }
        if (literal.calls !== undefined && !(Array.isArray(literal.calls) && literal.calls.every((c) => typeof c === "string"))) {
          diagnostics.push(err("OARC-E010", { id, file: rel, line, detail: "calls must be an array of strings" }));
          continue;
        }
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
        let sk: sketch.SketchInfo | undefined; // palette: a sketch fixes the parameter names and joins the spec hash
        if (syn) {
          const r = kind === "function" ? sketch.readSketch(syn.initializer, sf, checker, (f) => (f.startsWith(p.root + "/") && !f.includes("/node_modules/") ? f.slice(p.root.length + 1) : null)) : { error: "sketch:function-regions-only" };
          if ("error" in r) {
            diagnostics.push(err("OARC-E010", { id, file: rel, line, detail: r.error }));
            continue;
          }
          sk = r;
          params = r.params;
          literal.$sketch = sketch.sketchHashText(r);
        }
        let u: ui.UiInfo | undefined; // palette: the structure tree joins the spec hash; react is an allowed import
        if (uiProp) {
          const r = kind === "function" ? ui.readUi(uiProp.initializer, sf) : { error: "ui:function-regions-only" };
          if ("error" in r) {
            diagnostics.push(err("OARC-E010", { id, file: rel, line, detail: r.error }));
            continue;
          }
          const typeProblem = ui.uiTypeProblem(typeNode, sf, checker);
          if (typeProblem) {
            diagnostics.push(err("OARC-E010", { id, file: rel, line, detail: typeProblem }));
            continue;
          }
          u = r;
          literal.$ui = { tree: r.root as unknown as Json, vocabulary: ui.VOCABULARY_VERSION };
          literal.deps = [...new Set([...((literal.deps as string[] | undefined) ?? []), "react"])];
        }
        p.specs.set(id, {
          id, kind, file: rel, exportName: decl.name.text, literal,
          symbol: typeof literal.symbol === "string" ? literal.symbol : id.split(".").at(-1)!,
          deps: (literal.deps as string[] | undefined) ?? [],
          effects: (literal.effects as string[] | undefined) ?? [],
          examples: (literal.examples as Json[] | undefined) ?? [],
          intent: intentText(literal.intent),
          ...(Array.isArray(literal.calls) ? { calls: literal.calls as string[] } : {}),
          typeText, signature, params, isAsync, typeNode, ...(sk ? { sketch: sk } : {}), ...(u ? { ui: u } : {}),
        });
      }
    }
  }
  concepts.applyConcepts(p.specs, p.concepts, checker, p.program!, p.root).forEach(once); // palette: laws -> examples
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
    if (s.ui) { // palette: a UI region lives in its component file, next to the *.spec.tsx
      const d = ui.scaffoldUi(p.files, s);
      if (d) diagnostics.push(d);
      else done.push(s.id);
      continue;
    }
    const text = p.files.get(s.file)!;
    const sf = ts.createSourceFile(s.file, text, ts.ScriptTarget.Latest, true);
    const stmt = sf.statements.find((st) => ts.isVariableStatement(st) && st.declarationList.declarations.some((d) => ts.isIdentifier(d.name) && d.name.text === s.exportName))!;
    const endLine = sf.getLineAndCharacterOfPosition(stmt.getEnd()).line;
    const lines = linesOf(text);
    lines.splice(endLine + 1, 0, "", ...scaffoldLines(s));
    let out = lines.join("\n");
    if (!/import \* as arc from "open-arc"/.test(out)) out = `import * as arc from "open-arc";\n${out}`;
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
  for (const [rel, lf] of p.files) {
    const text = toDisk(p, rel, lf);
    if (p.disk.get(rel) !== text) await ports.fs.write(rel, text);
  }
  return ids;
}

// ───────────────────────────── ANALYZE ─────────────────────────────

export async function analyze(ports: Ports, req: CompileRequest, p: Project, diagnostics: Diagnostic[], opts: { offline?: boolean } = {}): Promise<void> {
  if (srcFiles(p).length === 0) return;
  p.program = makeProgram(p, p.files);
  const cfScaffolded = implicit.scaffoldPending(p, diagnostics); // code-first: markers inside pending bodies, in memory
  extractSpecs(p, p.program.getTypeChecker(), diagnostics);
  if (scaffoldInMemory(p, diagnostics).length || cfScaffolded) {
    p.program = makeProgram(p, p.files, p.program);
    p.specs.clear();
    extractSpecs(p, p.program.getTypeChecker(), diagnostics);
  }
  const checker = p.program.getTypeChecker();
  implicit.discover(p, checker, diagnostics); // code-first: specs, tests, arc.configure, layers
  diagnostics.push(...sketch.sketchTypeErrors(p.program, p.root, p.specs.values())); // palette: a sketch must type-check before any model call (§3.7)
  diagnostics.push(...testsPlan.testTypeErrors(p.program, p.tests ?? [])); // code-first: so must a test that runs for a region

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
        : spec.codeFirst ? implicit.isPendingText(owned) : owned.includes(`arc.todo("${spec.id}")`) && bodyLines.length <= 3;
      if (spec.kind === "function" && parent !== null) diagnostics.push(err("OARC-E034", { id: spec.id, file: rel }));
      if (spec.kind === "block" && rootId === null) diagnostics.push(err("OARC-E032", { id: spec.id, file: rel }));
      const myRoot = rootId ?? spec.id;
      const region: RegionInfo = {
        id: spec.id, kind: spec.kind, file: rel, parent, root: myRoot, bodyLines, childSpans,
        indent: /^\s*/.exec(lines[node.beginLine - 1]!)![0], pending,
        hash: sha256Tagged(normalizeOwnedText(bodyLines, childSpans)),
        spec, specHash: "", state: "pending", stale: true, fingerprint: "", scope: [], context0: "", typeImports: new Map(),
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
    // The fingerprint hashes the STABLE view of the context (§4.3): sibling regions by signature whether pending or not,
    // never their bodies. Otherwise committing one region would re-queue its siblings.
    const shown = new Map(r.typeImports);
    const stable = buildContext(p, r, initialLevel(p, r), backend, { stable: true });
    r.typeImports = shown;
    r.fingerprint = sha256Tagged(canonicalJson({
      specHash: r.specHash, parentSpecHash, context: sha256Tagged(stable),
      backend: { provider: backend.provider, model: backend.model, digest, seed: backend.seed ?? 1, maxContextTokens: backend.maxContextTokens },
      // the normalised endpoint (provider presets, §13): a changed preset default re-fingerprints its regions
      endpoint: backend.provider === "ollama" ? null : { preset: backend.preset ?? backend.provider, structuredOutput: backend.structuredOutput ?? null, ollamaCompat: isOllamaCompat(backend) },
      promptTemplate: backend.outputFormat === "code" ? CODE_PROMPT_TEMPLATE_VERSION : PROMPT_TEMPLATE_VERSION, outputFormat: backend.outputFormat!,
      batch: p.config.compilation.batch ?? "file",
      compiler: COMPILER_VERSION, typescript: ts.version,
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
  const code = p.specs.get(id); // code-first: `@arc backend|outputFormat` are defaults; openarc.config.json regions[id] wins
  const name = stage === 1 && c.fallbackBackend ? c.fallbackBackend : (p.config.regions?.[id]?.backend ?? code?.backend ?? c.defaultBackend);
  const b = p.config.backends[name]!;
  return { ...b, name, outputFormat: p.config.regions?.[id]?.outputFormat ?? code?.outputFormat ?? b.outputFormat ?? "json" };
}

async function modelDigest(ports: Ports, p: Pick<Project, "digests">, b: BackendConfig, diagnostics: Diagnostic[]): Promise<string | null> {
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

/** Watch mode's pre-dispatch check (spec §15): null when the backend region `id` compiles with (its `backend`
 *  override, else the default) can take a call, else why not.
 *  Ollama: /api/tags answers and lists the model (modelDigest, no model is loaded). Hosted: its key env var is set. */
export async function backendProblem(ports: Ports, config: OpenArcConfig, id?: string, env: Record<string, string | undefined> = process.env): Promise<string | null> {
  const b = config.backends[(id && config.regions?.[id]?.backend) || config.compilation.defaultBackend]!;
  if (b.provider !== "ollama") return b.apiKeyEnv && !env[b.apiKeyEnv] ? `env ${b.apiKeyEnv} is not set` : null;
  const ds: Diagnostic[] = [];
  return (await modelDigest(ports, { digests: new Map() }, b, ds)) === null ? (ds[0]?.detail ?? "unreachable") : null;
}

// ───────────────────────────── context builder ─────────────────────────────

const declOf = (sym: ts.Symbol, checker: ts.TypeChecker) =>
  (sym.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(sym) : sym).declarations ?? [];

interface ClosureType {
  name: string;
  rel: string; // project-relative file that declares it
  exported: boolean;
  text: string;
}

/** Every project-local type declaration reachable from `roots` (the type closure), with its source text. */
function typeClosure(p: Project, checker: ts.TypeChecker, roots: ts.Node[]): ClosureType[] {
  const seen = new Set<ts.Node>();
  const out: ClosureType[] = [];
  const reach = (d: ts.Node) => {
    const file = d.getSourceFile().fileName;
    if (!file.startsWith(p.root + "/") || file.includes("/node_modules/") || seen.has(d)) return;
    if (!(ts.isTypeAliasDeclaration(d) || ts.isInterfaceDeclaration(d))) return;
    seen.add(d);
    visit(d);
    const exported = ts.getModifiers(d)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;
    out.push({ name: d.name.text, rel: file.slice(p.root.length + 1), exported, text: d.getText(d.getSourceFile()).trim() });
  };
  const visit = (n: ts.Node) => {
    if (ts.isTypeReferenceNode(n) || ts.isExpressionWithTypeArguments(n) || ts.isTypeQueryNode(n)) {
      const name = ts.isTypeReferenceNode(n) ? n.typeName : ts.isTypeQueryNode(n) ? n.exprName : n.expression;
      const sym = checker.getSymbolAtLocation(name);
      for (const d of sym ? declOf(sym, checker) : []) reach(d);
    }
    n.forEachChild(visit);
  };
  // a root that is itself a type declaration (from inferredTypeDecls) is reached directly
  roots.forEach((n) => (ts.isTypeAliasDeclaration(n) || ts.isInterfaceDeclaration(n) ? reach(n) : visit(n)));
  return out;
}

/** Declarations of the named types an inferred type prints with (aliases, interfaces, their type arguments and the
 *  members of anonymous object types), found through the checker: never by walking a function body (§4.3). */
function inferredTypeDecls(checker: ts.TypeChecker, t: ts.Type, seen = new Set<ts.Type>()): ts.Node[] {
  if (seen.has(t)) return [];
  seen.add(t);
  const rec = (x: ts.Type) => inferredTypeDecls(checker, x, seen);
  if (t.aliasSymbol) return [...(t.aliasSymbol.declarations ?? []), ...(t.aliasTypeArguments ?? []).flatMap(rec)];
  if (t.isUnionOrIntersection()) return t.types.flatMap(rec);
  const out: ts.Node[] = [];
  if (t.symbol && t.symbol.flags & ts.SymbolFlags.Interface) out.push(...(t.symbol.declarations ?? []));
  if (t.flags & ts.TypeFlags.Object) {
    const o = t as ts.ObjectType;
    if (o.objectFlags & ts.ObjectFlags.Reference) out.push(...checker.getTypeArguments(o as ts.TypeReference).flatMap(rec));
    if (o.objectFlags & ts.ObjectFlags.Anonymous) {
      for (const prop of checker.getPropertiesOfType(o)) out.push(...rec(checker.getTypeOfSymbol(prop)));
      for (const sig of o.getCallSignatures()) out.push(...sig.getParameters().flatMap((x) => rec(checker.getTypeOfSymbol(x))), ...rec(sig.getReturnType()));
    }
  }
  return out;
}

/** The type-bearing parts of a function (type parameters, parameters, return type), never its body: the type closure
 *  must not change when a body does (§4.3). */
const sigNodes = (f: ts.SignatureDeclarationBase): ts.Node[] => [...(f.typeParameters ?? []), ...f.parameters, ...(f.type ? [f.type] : [])];

/** Value signatures of a local module (helpers a region may call), skipping specs. Other modules: exported values only.
 *  The region's own file (`sameFile`): every top-level value, minus `skip` (the region itself and pending regions). */
function moduleSignatures(sf: ts.SourceFile, checker: ts.TypeChecker, sameFile?: { skip: Set<string> }): { lines: string[]; nodes: ts.Node[] } {
  const lines: string[] = [];
  const nodes: ts.Node[] = [];
  for (const st of sf.statements) {
    const exported = ts.canHaveModifiers(st) && ts.getModifiers(st)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    if (!exported && !sameFile) continue;
    if (ts.isFunctionDeclaration(st) && st.name) {
      if (sameFile?.skip.has(st.name.text)) continue;
      const sig = checker.getSignatureFromDeclaration(st);
      lines.push(`function ${st.name.text}${sig ? checker.signatureToString(sig, undefined, ts.TypeFormatFlags.NoTruncation) : "(…)"}`);
      nodes.push(...sigNodes(st));
      if (!st.type && sig) nodes.push(...inferredTypeDecls(checker, sig.getReturnType())); // printed above, inferred
    } else if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        if (!ts.isIdentifier(d.name) || sameFile?.skip.has(d.name.text)) continue;
        if (d.initializer && ts.isCallExpression(d.initializer) && /define(Region|Block|Concept)$/.test(d.initializer.expression.getText(sf))) continue;
        const t = d.type ? d.type.getText(sf) : checker.typeToString(checker.getTypeAtLocation(d.name), undefined, ts.TypeFormatFlags.NoTruncation);
        lines.push(`const ${d.name.text}: ${t}`);
        const fn = d.initializer && (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer)) ? d.initializer : null;
        nodes.push(...(d.type ? [d.type] : fn ? sigNodes(fn) : [d]));
        if (!d.type && fn && !fn.type) { // an unannotated helper's return type is inferred: reach the types it prints with
          const sig = checker.getSignatureFromDeclaration(fn);
          if (sig) nodes.push(...inferredTypeDecls(checker, sig.getReturnType()));
        }
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

/** The import declaration most often used for package `spec` across the project (value imports only), or null. */
function canonicalImport(p: Project, spec: string): string | null {
  const counts = new Map<string, number>();
  for (const rel of p.files.keys()) {
    const sf = p.program?.getSourceFile(abs(p, rel));
    for (const d of sf?.statements.filter(ts.isImportDeclaration) ?? [])
      if ((d.moduleSpecifier as ts.StringLiteral).text === spec && d.importClause && !d.importClause.isTypeOnly) {
        const t = d.getText(sf).replace(/\s+/g, " ");
        counts.set(t, (counts.get(t) ?? 0) + 1);
      }
  }
  let best: string | null = null;
  for (const [t, n] of counts) if (best === null || n > counts.get(best)!) best = t; // ties: first seen (files are in sorted order)
  return best;
}

/** "Allowed new imports": the deps, then the exact import form for each package dep (e.g. typescript needs a default import, TS2595). */
function allowedImports(p: Project, deps: string[]): string {
  const pkgs = deps.filter((d) => !d.startsWith("."));
  const forms = pkgs.map((d) => canonicalImport(p, d) ?? d);
  return [deps.join(", ") || "none", ...(forms.length ? ["Use exactly these import forms:", ...forms] : [])].join("\n");
}

const RULES = [
  "Names the file already imports, and its same-file helpers, are in scope: call them directly, never re-import or re-implement them.",
  "\"imports\" may name: specifiers under 'Allowed new imports', modules the file already imports, and the file of a type shown under 'Types' (marked 'not in scope').",
  "For a default import use {\"from\": \"x\", \"names\": [], \"default\": \"x\"}.",
  "Never use: process, globalThis, eval, Function, fetch, require, dynamic import(), setTimeout, setInterval.",
  "Date.now()/new Date()/performance need effect 'clock' (Date.parse and new Date(value) don't); Math.random and crypto.getRandomValues/randomUUID/randomBytes need 'random'; console needs 'log'.",
  "Deterministic output; no I/O except through parameters.",
].join("\n");

/** RULES for a function region with no effects, no deps, nothing to import for its types and no import besides
 *  open-arc (most regions): the same constraints in about half the tokens, with no import or effect vocabulary to
 *  explain (issue #19 prompt trim). */
const CLOSED_RULES = [
  "Names the file already imports, and its same-file helpers, are in scope: call them directly, never re-import or re-implement them. No new imports.",
  "No effects: never use Date.now(), new Date() without arguments, performance, Math.random, crypto, console, process, globalThis, eval, Function, fetch, require, import(), setTimeout or setInterval.",
].join("\n");

/** The Examples heading: deep equality, plus only the conventions these examples use. */
export function examplesHeading(text: string): string {
  const notes = ["deep equality"];
  if (/\d\.\d|\d[eE][-+]?\d|"exact"|[:,[]-0[,\]}]/.test(text)) notes.push('numbers match within 1e-9 relative and -0 equals 0 unless "exact"');
  const tokens = ["$NaN", "$Infinity", "$-Infinity", "$undefined"].filter((t) => text.includes(`"${t}"`));
  if (tokens.length) notes.push(`the string${tokens.length > 1 ? "s" : ""} ${tokens.map((t) => `"${t}"`).join(", ")} stand${tokens.length > 1 ? "" : "s"} for ${tokens.length > 1 ? "those values" : "that value"}`);
  if (text.includes('"$fake"')) notes.push('{"$fake": name} is a test double for that parameter');
  if (text.includes('"throws"')) notes.push('{"throws": true} means the call must throw, and a "throws" string must appear in the error message');
  return `Examples (${notes.join("; ")})`;
}

const TESTS_HEADING = "Tests your body must pass (TypeScript, run in a sandbox)";

/** Deterministic context package for one region at one level (adaptive context, see config.ts). */
export function buildContext(p: Project, r: RegionInfo, level: ContextLevel, backend: BackendConfig, opts: { stable?: boolean } = {}): string {
  return renderSections(contextSections(p, r, level, backend, opts).sections);
}
const renderSections = (sections: [string, string][], h = "##") => sections.map(([t, b]) => `${h} ${t}\n${b}`).join("\n\n");
const TYPES_HEADING = "Types (verbatim)";

/** buildContext's sections, and the type closure entries of its Types section (batchContext merges those). */
function contextSections(p: Project, r: RegionInfo, level: ContextLevel, backend: BackendConfig, opts: { stable?: boolean } = {}): { sections: [string, string][]; types: string[] } {
  const checker = p.program!.getTypeChecker();
  const s = r.spec;
  const sf = p.program!.getSourceFile(abs(p, r.file))!;
  const sections: [string, string][] = [];
  const rootSpec = p.specs.get(r.root)!;

  const cf = r.kind === "function" ? s.codeFirst : undefined;
  if (r.kind === "function" && s.sketch) sections.push(...sketch.sketchHead(s.sketch, s.symbol, s.typeText, s.signature)); // palette
  else if (cf) { // code-first: the declaration (and its class shell) is the contract; JSDoc in place
    const pendingDecls = new Set(p.regions.filter((x) => x.pending && x.spec.codeFirst).map((x) => x.spec.codeFirst!.decl as ts.Node));
    sections.push(["Task", `Write ONLY the statements of the body marked <<<BODY>>> (${cf.declaration}).${cf.cls ? " `this` is the instance; the class shell (fields, constructor, other members, signatures) is fixed." : ""} The declaration, its JSDoc and everything outside the body are fixed and checked to be unchanged.`]);
    sections.push(["Contract (fixed)", implicit.contract(s, checker, opts.stable ? null : pendingDecls)]);
  } else if (r.kind === "function") {
    sections.push(["Fixed signature (write ONLY the statements inside the braces)", `export const ${s.symbol}: ${s.typeText} = ${s.isAsync ? "async " : ""}(${s.params.join(", ")}) => {\n  /* your body */\n};`]);
  } else {
    sections.push(["Task", `Write ONLY the statements that replace arc.pending("${s.id}") inside function ${rootSpec.symbol}. Do not return, break or continue out of the block; report results by assigning the 'let' variables below.${rootSpec.isAsync ? " await is allowed." : ""}`]);
    sections.push(["Variables in scope", r.scope.join("\n")]);
  }
  const typeRoots: ts.Node[] = cf ? implicit.typeRoots(cf, checker) : s.typeNode ? [s.typeNode] : [];
  if (s.sketch) typeRoots.push(...s.sketch.callees.flatMap((c) => (c.typeNode ? [c.typeNode] : []))); // palette
  const helperLines: string[] = [];
  // Every level: the file's imports and its other implemented top-level values (same-file helpers and regions).
  const importLines = sf.statements.filter(ts.isImportDeclaration).map((d) => d.getText(sf));
  // Only open-arc (the spec library): nothing a function body calls, and showing `import * as arc` led a 7B to write
  // `arc.flatten(input)` with an open-arc import (issue #19 rerun; D-min had the same failure), so leave it out.
  const arcOnly = sf.statements.filter(ts.isImportDeclaration).every((d) => (d.moduleSpecifier as ts.StringLiteral).text === "open-arc");
  if (importLines.length && !(r.kind === "function" && arcOnly)) sections.push(["Imports already in the file", importLines.join("\n")]);
  let sameFileLines: string[] = [];
  if (r.kind === "function") {
    // The prompt omits pending siblings (nothing to call yet); the stable view (fingerprint) lists them all, so a
    // sibling going from pending to implemented doesn't change it.
    const pendingSiblings = opts.stable ? [] : p.regions.filter((x) => x.file === r.file && x.pending && x.kind === "function").map((x) => x.spec.symbol);
    const skip = new Set([s.symbol, ...pendingSiblings]);
    const own = moduleSignatures(sf, checker, { skip });
    sameFileLines = own.lines;
    typeRoots.push(...own.nodes);
  }
  if (level >= 1 || r.kind === "block") {
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
  // A closure type the file neither declares nor imports would be TS2304 in the body: say so, and remember where it
  // comes from so verify() adds `import type` for it when the body uses it.
  const inScope = fileBindings(p.files.get(r.file)!);
  for (const st of sf.statements) if ((ts.isTypeAliasDeclaration(st) || ts.isInterfaceDeclaration(st) || ts.isEnumDeclaration(st)) && st.name) inScope.add(st.name.text);
  const types = typeClosure(p, checker, typeRoots).map((t) => {
    if (inScope.has(t.name)) return t.text;
    if (!t.exported) return `// ${t.name}: not in scope (not exported by ${t.rel}); don't name it\n${t.text}`;
    let spec = posix.relative(posix.dirname(r.file), t.rel);
    if (!spec.startsWith(".")) spec = `./${spec}`;
    r.typeImports.set(t.name, spec);
    return `// ${t.name}: not in scope; the compiler adds import type { ${t.name} } from "${spec}" if you use it\n${t.text}`;
  });
  // "// T = signature" only when Types doesn't already declare T (issue #19: the signature was in the prompt twice)
  if (r.kind === "function" && !cf && !s.sketch && !(/^\w+$/.test(s.typeText) ? types.some((t) => new RegExp(`\\b(type|interface) ${s.typeText}\\b`).test(t)) : true))
    sections[0]![1] += `\n// ${s.typeText} = ${s.signature}`;
  if (types.length) sections.push([TYPES_HEADING, types.join("\n\n")]);
  if (sameFileLines.length) sections.push([`Already in ${r.file} (call these, don't re-implement them)`, sameFileLines.join("\n")]);
  if (helperLines.length) sections.push(["Helpers you may call", helperLines.join("\n\n")]);
  if (!cf) sections.push(["Intent", s.intent || "(none)"]);
  else if (cf.extraIntent) sections.push(["More intent", cf.extraIntent]); // code-first: the JSDoc is in the contract
  sections.push(...concepts.extraSections(p.specs, p.concepts ?? new Map(), s, p.files.get(r.file)!), ...ui.uiSections(s)); // palette: concept, callees, UI structure
  if (s.sketch) sections.push(sketch.sketchCalls(s.sketch, s.calls));
  else if (s.calls) sections.push(["Calls allowed", `You may call exactly: ${s.calls.join(", ") || "nothing"}. Any other call on an import or a port is rejected (OARC-E098); calls on local variables and on functions you define in the body are fine.`]);
  // closed: nothing to say about effects or imports beyond "none" (CLOSED_RULES says it once)
  const closed = r.kind === "function" && !s.effects.length && !s.deps.length && !r.typeImports.size && arcOnly;
  if (r.kind === "function") {
    if (!closed) {
      sections.push(["Effects allowed", s.effects.join(", ") || "none"]);
      sections.push(["Allowed new imports", allowedImports(p, s.deps)]);
    }
    if (s.examples.length) {
      const text = s.examples.map((e) => canonicalJson(e)).join("\n");
      sections.push([examplesHeading(text), text]);
    }
    if (cf?.tests.length) sections.push([TESTS_HEADING, testsPlan.testsSection(cf.tests)]); // code-first
  } else {
    sections.push(["Allowed new imports", allowedImports(p, s.deps)]);
    sections.push(["Enclosing function (your block is at <<<HERE>>>)", enclosingSource(p, r)]);
  }
  if (level >= 2 && !opts.stable) { // ponytail: holds sibling bodies, so not in the fingerprint
    // a hidden test in the region's own file stays out of the package here too (SPEC §8.5)
    let full = p.files.get(r.file)!;
    for (const t of p.tests ?? []) if (t.hidden && t.file === r.file) full = full.replace(t.source, "// (a hidden test, not shown)");
    sections.push([`Full file ${r.file}`, full]);
  }
  sections.push(["Rules", closed ? (sameFileLines.length ? CLOSED_RULES : CLOSED_RULES.replace(/^.*?No new imports\./, "No new imports.")) : backend.outputFormat === "code" ? codeRules(RULES) : RULES]);

  // Budget: drop optional sections (from the end of the optional list) until the package fits.
  const budget = (backend.maxContextTokens - (backend.outputReserveTokens ?? DEFAULT_OUTPUT_RESERVE)) * 3.5; // ~3.5 chars/token
  const render = () => renderSections(sections);
  let text = render();
  const ti = sections.findIndex(([h]) => h === TESTS_HEADING); // code-first: the summary replaces the test source first
  if (text.length > budget && ti >= 0) {
    sections[ti] = ["Tests your body must pass (summary: the test source did not fit)", testsPlan.summarySection(cf!.tests)];
    text = render();
  }
  for (const optional of [`Full file ${r.file}`, "Helpers you may call", `Already in ${r.file} (call these, don't re-implement them)`, "Imports already in the file"]) {
    if (text.length <= budget) break;
    const i = sections.findIndex(([h]) => h === optional);
    if (i >= 0) sections.splice(i, 1);
    text = render();
  }
  return { sections, types };
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
  const { targets: selected, skipped } = selectTargets(
    p.regions.map((r) => ({ id: r.id, parent: r.parent, state: r.state, stale: r.stale })),
    req.ids,
  );
  // palette: callees compile before their callers (§8.1): a sketch's calls, and the regions of the files a file imports
  const targets = sketch.calleesFirst(selected, p.specs, (f) => [...importedSpecifiers(p.files.get(f) ?? "")].flatMap((x) => resolveLocal(p, f, x) ?? []));
  diagnostics.push(...skipped);
  p.targets = targets;
  for (const id of targets) {
    const r = p.regions.find((x) => x.id === id)!;
    if (r.kind === "block" && !hasChecks(p.specs.get(r.root))) diagnostics.push(err("OARC-W041", { id }));
    else if (r.kind === "block") diagnostics.push(err("OARC-W040", { id }));
    else {
      // palette: UI examples are interaction scripts. code-first: tests are the checks; with none, the examples' rule
      const cfTests = r.spec.codeFirst?.tests.length ?? 0;
      const thin = r.spec.ui || cfTests ? null : r.spec.codeFirst && !r.spec.examples.length ? "tests:0" : thinExamples(r.spec.examples);
      if (thin) diagnostics.push(err("OARC-W044", { id, detail: thin }));
      if (r.spec.codeFirst && !r.spec.intent) diagnostics.push(err("OARC-W023", { id, file: r.file })); // code-first: no JSDoc anywhere
    }
  }
  return targets;
}

/** A region with behavioural checks: examples, a UI structure, or code-first tests. */
const hasChecks = (s: SpecInfo | undefined): boolean => !!s && (s.examples.length > 0 || !!s.ui || (s.codeFirst?.tests.length ?? 0) > 0);

/** Any value inside `v` that is an edge case: "", [], {}, 0, a negative number, null, or a NaN/Infinity/undefined token. */
const hasEdge = (v: Json): boolean =>
  v === "" || v === 0 || v === null || (typeof v === "number" && v < 0) || (typeof v === "string" && /^\$(NaN|-?Infinity|undefined)$/.test(v)) ||
  (Array.isArray(v) ? v.length === 0 || v.some(hasEdge) : typeof v === "object" && ("$fake" in v ? false : Object.keys(v).length === 0 || Object.values(v).some(hasEdge)));

/** OARC-W044 detail when a function region's examples are thin: fewer than 3 (`examples:<n>`), or none with an edge-case
 *  argument (`no-edge-case`). ponytail: a syntactic heuristic on the args; a boundary like 5 in [1, 5] goes unnoticed. */
export function thinExamples(examples: Json[]): string | null {
  if (examples.length < 3) return `examples:${examples.length}`;
  return examples.some((e) => hasEdge(((e as { args?: Json }).args ?? []) as Json)) ? null : "no-edge-case";
}

/** What graph, inspect and watch show: a compiler-owned region whose spec (or, when known, fingerprint) no longer matches
 *  the manifest is "stale". Its body was verified against an older spec. Display only: ownership is unchanged. */
export function displayState(p: Project, r: RegionInfo): RegionState | "stale" {
  const m = p.manifest.regions[r.id];
  if (r.state !== "compiler" || !m) return r.state;
  return m.specHash !== r.specHash || (r.fingerprint !== "" && m.fingerprint !== r.fingerprint) ? "stale" : r.state;
}

// ───────────────────────────── GENERATE ─────────────────────────────

interface Attempt {
  backend: BackendConfig & { name: string };
  level: ContextLevel;
}

/** The function `st` declares under `name` (`function name`, `const name = (…) => …` / `= function`), if any. */
function declaredFunction(st: ts.Statement, name: string): ts.FunctionLikeDeclaration | undefined {
  if (ts.isFunctionDeclaration(st)) return st.name?.text === name ? st : undefined;
  if (!ts.isVariableStatement(st) || st.declarationList.declarations.length !== 1) return undefined;
  const d = st.declarationList.declarations[0]!;
  const init = d.initializer;
  return ts.isIdentifier(d.name) && d.name.text === name && init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) ? init : undefined;
}

/** The body of a function-like as statements (an expression body becomes `return expr;`). */
const bodyText = (fn: ts.FunctionLikeDeclaration, sf: ts.SourceFile): string =>
  ts.isBlock(fn.body!) ? fn.body.statements.map((s) => s.getText(sf)).join("\n") : `return ${fn.body!.getText(sf)};`;

/** A reply of helper statements plus the region's own declaration (same name, same parameter names), e.g.
 *  `const animals = [...];\nconst verse: VerseFn = (n) => {...};`: the helpers (export dropped) followed by the own
 *  body. null when no single statement declares it, or another statement already returns (then it is a real body). */
function unwrapOwn(sf: ts.SourceFile, self: { name: string; params: string[] }): string | null {
  const own = sf.statements.filter((st) => declaredFunction(st, self.name));
  if (own.length !== 1) return null;
  const fn = declaredFunction(own[0]!, self.name)!;
  const norm = (s: string) => s.replace(/\s+/g, "");
  if (!fn.body || fn.parameters.length !== self.params.length || fn.parameters.some((x, i) => norm(x.name.getText(sf)) !== norm(self.params[i]!))) return null;
  const rest = sf.statements.filter((st) => st !== own[0] && !ts.isExportAssignment(st) && !ts.isExportDeclaration(st)); // `export default f;`, `export { f };`
  // a return anywhere in the rest (an `if (…) return verse(n);` too), not counting nested functions' own returns
  const returns = (n: ts.Node): boolean => ts.isReturnStatement(n) || (!ts.isFunctionLike(n) && !!ts.forEachChild(n, (c) => returns(c) || undefined));
  if (rest.some(returns)) return null;
  return [...rest.map((st) => st.getText(sf).replace(/^export\s+(default\s+)?/, "")), bodyText(fn, sf)].join("\n");
}

/** Normalise model output (F13): strip fences; unwrap a whole function when only a body was asked for. With `self`
 *  (the region's own name and parameter names), also a whole declaration of it that follows helper statements. */
export function unwrapBody(body: string, kind: "function" | "block", tsx = false, self?: { name: string; params: string[] }): string {
  let b = body.trim().replace(/^```[a-z]*\n?/i, "").replace(/\n?```$/, "").trim();
  if (kind !== "function") return b;
  const sf = ts.createSourceFile(tsx ? "b.tsx" : "b.ts", b, ts.ScriptTarget.Latest, true);
  if (sf.statements.length !== 1) { // code-first: a whole method (`pick(key: string): T { … }`)
    const own = self && sf.statements.length > 1 ? unwrapOwn(sf, self) : null;
    if (own !== null) return own;
    const m = ts.createSourceFile(tsx ? "m.tsx" : "m.ts", `class __M {\n${b}\n}`, ts.ScriptTarget.Latest, true);
    const c = m.statements[0];
    const clean = !(m as unknown as { parseDiagnostics: unknown[] }).parseDiagnostics.length; // ponytail: internal field, stable since TS 2
    const only = clean && c && ts.isClassDeclaration(c) && c.members.length === 1 ? c.members[0] : undefined;
    if (only && (ts.isMethodDeclaration(only) || ts.isGetAccessorDeclaration(only)) && only.body) return only.body.statements.map((x) => x.getText(m)).join("\n");
    return b;
  }
  const st = sf.statements[0]!;
  let fn: ts.FunctionLikeDeclaration | undefined;
  if (ts.isFunctionDeclaration(st)) fn = st;
  else if (ts.isVariableStatement(st) && st.declarationList.declarations.length === 1) {
    const init = st.declarationList.declarations[0]!.initializer;
    if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) fn = init;
  }
  return fn?.body ? bodyText(fn, sf) : b;
}

/** Names bound at module level in a file (imports and top-level declarations; only imports with `importsOnly`). */
export function fileBindings(text: string, importsOnly = false): Set<string> {
  const sf = ts.createSourceFile("f.ts", text, ts.ScriptTarget.Latest, true);
  const out = new Set<string>();
  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st) && st.importClause) {
      const c = st.importClause;
      if (c.name) out.add(c.name.text);
      if (c.namedBindings && ts.isNamespaceImport(c.namedBindings)) out.add(c.namedBindings.name.text);
      if (c.namedBindings && ts.isNamedImports(c.namedBindings)) c.namedBindings.elements.forEach((e) => out.add(e.name.text));
    }
    if (importsOnly) continue;
    if (ts.isVariableStatement(st)) st.declarationList.declarations.forEach((d) => ts.isIdentifier(d.name) && out.add(d.name.text));
    if ((ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st)) && st.name) out.add(st.name.text);
  }
  return out;
}

/** The local names an import binds (named, default and namespace). */
const localNames = (i: ImportDecl): string[] => [...i.names, ...(i.default ? [i.default] : []), ...(i.namespace ? [i.namespace] : [])];

/** A spec's `calls` allowlist (§7 rule 6) and the root names it governs: the file's import bindings (with the requested
 *  imports) and the enclosing function's parameters typed `Ports`. */
export interface CallPolicy {
  calls: string[];
  restricted: Set<string>;
}

/** The call policy of region `r`, or undefined when its spec has no `calls`. `requested`: the candidate's imports. */
export function callPolicy(p: Project, r: RegionInfo, requested: ImportDecl[] = []): CallPolicy | undefined {
  if (!r.spec.calls) return undefined;
  const restricted = fileBindings(p.accepted.get(r.file) ?? p.files.get(r.file)!, true);
  for (const i of requested) localNames(i).forEach((n) => restricted.add(n));
  const root = p.specs.get(r.root);
  const checker = p.program?.getTypeChecker();
  const cf = root?.codeFirst;
  const sig = cf && checker ? checker.getSignatureFromDeclaration(cf.decl) : root?.typeNode && checker ? checker.getTypeFromTypeNode(root.typeNode).getCallSignatures()[0] : undefined;
  for (const s of sig?.getParameters() ?? []) if (checker!.typeToString(checker!.getTypeOfSymbol(s)) === "Ports") restricted.add(s.name);
  // code-first: a field whose type is an interface is a port held by the instance; `this.<field>` is a restricted root
  for (const m of cf?.cls?.members ?? []) {
    const sym = ts.isPropertyDeclaration(m) && m.type && checker ? checker.getTypeFromTypeNode(m.type).symbol : undefined;
    const port = !!sym && (sym.flags & ts.SymbolFlags.Interface) !== 0 && (sym.declarations ?? []).some((d) => !d.getSourceFile().isDeclarationFile && d.getSourceFile().fileName.startsWith(`${p.root}/`));
    if (port && ts.isPropertyDeclaration(m) && ts.isIdentifier(m.name)) restricted.add(`this.${m.name.text}`);
  }
  return { calls: r.spec.calls, restricted };
}

/** `a.b.c` for a callee made of identifiers and property accesses (`x[i]` prints as `x[]`), or null. */
function calleePath(e: ts.Expression): { root: string; path: string } | null {
  if (ts.isIdentifier(e)) return { root: e.text, path: e.text };
  if (e.kind === ts.SyntaxKind.ThisKeyword) return { root: "this", path: "this" }; // code-first: `this.net.send`
  if (ts.isParenthesizedExpression(e) || ts.isNonNullExpression(e) || ts.isAsExpression(e)) return calleePath(e.expression);
  const base = ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e) ? calleePath(e.expression) : null;
  if (!base) return null;
  return { root: base.root, path: `${base.path}${ts.isPropertyAccessExpression(e) ? `.${e.name.text}` : "[]"}` };
}

const callAllowed = (calls: string[], path: string) => calls.some((c) => c === path || c === "*" || (c.endsWith(".*") && path.startsWith(c.slice(0, -1))));

const RANDOM_MEMBERS = new Set(["getRandomValues", "randomUUID", "randomBytes"]);

/** Static rules (§7) on a candidate body. Best-effort: the sandbox is the real boundary. */
export function staticCheck(body: string, effects: string[], fileBound: Set<string> = new Set(), policy?: CallPolicy, tsx = false): { diag: Diagnostic; message: string }[] {
  const sf = ts.createSourceFile(tsx ? "c.tsx" : "c.ts", `async function __w() {\n${body}\n}`, ts.ScriptTarget.Latest, true);
  const out: { diag: Diagnostic; message: string }[] = [];
  const local = new Set<string>(); // names the body itself declares
  const scopes = new Map<string, ts.Node[]>(); // name -> the nodes its declarations are visible in
  const scopeOf = (d: ts.Node): ts.Node => {
    while (ts.isBindingElement(d) || ts.isObjectBindingPattern(d) || ts.isArrayBindingPattern(d)) d = d.parent;
    if (ts.isParameter(d) || ts.isFunctionDeclaration(d)) return d.parent; // the function / the enclosing block
    const list = d.parent; // a VariableDeclaration: its list, or a catch clause
    if (ts.isCatchClause(list)) return list;
    // ponytail: `var` is scoped to its function; let/const to the block, for statement or case clause around them
    if (!(list.flags & ts.NodeFlags.BlockScoped)) return ts.findAncestor(list.parent, ts.isFunctionLike) ?? sf;
    return ts.isVariableStatement(list.parent) ? list.parent.parent : list.parent;
  };
  const collect = (n: ts.Node) => {
    if ((ts.isVariableDeclaration(n) || ts.isParameter(n) || ts.isFunctionDeclaration(n) || ts.isBindingElement(n)) && n.name && ts.isIdentifier(n.name)) {
      local.add(n.name.text);
      scopes.set(n.name.text, [...(scopes.get(n.name.text) ?? []), scopeOf(n)]);
    }
    n.forEachChild(collect);
  };
  /** A body-declared `name` is visible at `at` (a nested function's local does not shadow an import outside it). */
  const inScope = (name: string, at: ts.Node) => (scopes.get(name) ?? []).some((s) => s.pos <= at.pos && at.end <= s.end);
  collect(sf);
  const declared = new Set<string>([...fileBound, ...local]); // a file import named `crypto` is not the global
  const forbidden = new Set(["process", "globalThis", "global", "window", "self", "eval", "Function", "fetch", "XMLHttpRequest", "WebSocket", "Deno", "Bun", "setTimeout", "setInterval", "queueMicrotask", "require"]);
  const gated: Record<string, string> = { Date: "clock", performance: "clock", console: "log" };
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword)
      out.push({ diag: err("OARC-E072"), message: "dynamic import() is not allowed" });
    // §7 rule 6: a call rooted at an import or a port must be on the spec's `calls` list.
    // ponytail: calls only. An alias (`const f = engine.parse; f()`) or a passed reference (`xs.map(engine.parse)`) is not
    // traced; the allowlist stops a model that wanders into the wrong step, not an adversary (the sandbox is the boundary).
    if (policy && ts.isCallExpression(n)) {
      const c = calleePath(n.expression);
      const root = c?.root === "this" ? c.path.split(".").slice(0, 2).join(".") : c?.root; // code-first: `this.<field>` roots
      if (c && root && policy.restricted.has(root) && !inScope(root, n) && !callAllowed(policy.calls, c.path))
        out.push({ diag: err("OARC-E098", { detail: c.path }), message: `call not allowed by spec: ${c.path} (allowed: ${policy.calls.join(", ") || "none"})` });
    }
    // Randomness: Math.random and crypto.getRandomValues/randomUUID/randomBytes (global crypto or an import named crypto).
    // Any other use of crypto (createHash from node:crypto, say) is pure.
    if (ts.isPropertyAccessExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "crypto" && RANDOM_MEMBERS.has(n.name.text) && !effects.includes("random"))
      out.push({ diag: err("OARC-E074", { detail: `crypto.${n.name.text}` }), message: `crypto.${n.name.text} requires effect 'random'` });
    if (ts.isIdentifier(n) && !declared.has(n.text)) {
      const parent = n.parent;
      const isPropName = (ts.isPropertyAccessExpression(parent) && parent.name === n) || (ts.isPropertyAssignment(parent) && parent.name === n);
      if (!isPropName) {
        if (forbidden.has(n.text))
          out.push({ diag: err("OARC-E073", { detail: n.text }), message: `'${n.text}' is forbidden in regions${n.text === "require" ? ": put the module in \"imports\" instead (names the file already imports are already in scope)" : ""}` });
        // Date.parse/Date.UTC, new Date(value) and the Date type are pure; only the current time needs 'clock'.
        const pureDate = n.text === "Date" && (ts.isTypeReferenceNode(parent) ||
          (ts.isPropertyAccessExpression(parent) && parent.expression === n && ["parse", "UTC"].includes(parent.name.text)) ||
          (ts.isNewExpression(parent) && parent.expression === n && (parent.arguments?.length ?? 0) > 0));
        const need = pureDate ? undefined : gated[n.text];
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

/** A comment that merely mentions the marker prefix ("// matches @openarc: markers") is removed before splicing: a safe,
 *  non-semantic normalisation (§8.7). A marker-SHAPED comment (`// @openarc:begin|end …`) is kept, so guardBody rejects it. */
export function stripMarkerComments(body: string, tsx = false): { body: string; stripped: number } {
  if (!body.includes("@openarc:")) return { body, stripped: 0 };
  const pre = "async function __region() {\n";
  const text = `${pre}${body}\n}\n`;
  const sf = ts.createSourceFile(tsx ? "s.tsx" : "s.ts", text, ts.ScriptTarget.Latest, true);
  const drop = new Map<number, number>(); // body offsets: start -> end, so a comment seen twice counts once
  const walk = (n: ts.Node): void => {
    const kids = n.getChildren(sf);
    if (kids.length) return kids.forEach(walk);
    for (const r of [...(ts.getLeadingCommentRanges(text, n.pos) ?? []), ...(ts.getTrailingCommentRanges(text, n.end) ?? [])]) {
      const c = text.slice(r.pos, r.end);
      if (c.includes("@openarc:") && !/^\/\/\s*@openarc:(begin|end)\b/.test(c)) drop.set(r.pos - pre.length, r.end - pre.length);
    }
  };
  walk(sf);
  if (!drop.size) return { body, stripped: 0 };
  const gone = new Array<boolean>(body.length).fill(false);
  for (const [from, to] of drop) gone.fill(true, from, to);
  const out: string[] = [];
  let at = 0;
  for (const line of linesOf(body)) {
    let kept = "", touched = false;
    for (let i = 0; i < line.length; i++) gone[at + i] ? (touched = true) : (kept += line[i]);
    at += line.length + 1;
    if (!touched) out.push(line);
    else if (kept.trim()) out.push(kept.trimEnd()); // a line that was only the comment goes away entirely
  }
  return { body: out.join("\n"), stripped: drop.size };
}

/** The body must parse as exactly one function body: it cannot close its braces and escape the region. */
export function guardBody(body: string, tsx = false): string | null {
  // Markers are recognised on comment tokens only (F2), so the marker prefix inside a string or regex is inert and
  // allowed (the marker scanner itself needs it). Reject marker-shaped LINES (line-based locators must never be
  // fooled, even by a template-literal line) and any comment that mentions the marker prefix.
  if (linesOf(body).some((l) => /^\s*\/\/\s*@openarc:/.test(l))) return "OARC-E097 body contains a marker-shaped line (markers belong to the compiler)";
  const text = `async function __region() {\n${body}\n}\n`;
  const sf = ts.createSourceFile(tsx ? "g.tsx" : "g.ts", text, ts.ScriptTarget.Latest, true);
  const comments: string[] = [];
  const walk = (n: ts.Node): void => {
    const kids = n.getChildren(sf);
    if (kids.length) return kids.forEach(walk);
    for (const r of [...(ts.getLeadingCommentRanges(text, n.pos) ?? []), ...(ts.getTrailingCommentRanges(text, n.end) ?? [])]) comments.push(text.slice(r.pos, r.end));
  };
  walk(sf);
  if (comments.some((c) => c.includes("@openarc:"))) return "OARC-E097 body has a comment mentioning @openarc: (markers belong to the compiler)";
  const syntax = ts.transpileModule(text, { reportDiagnostics: true, ...(tsx ? { fileName: "g.tsx" } : {}), compilerOptions: { target: ts.ScriptTarget.ES2023, ...(tsx ? { jsx: ts.JsxEmit.Preserve } : {}) } }).diagnostics ?? [];
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
  const isImport = (l: string) => /^import (type )?(\{[^}]*\}|\* as [A-Za-z_$][\w$]*|[A-Za-z_$][\w$]*(, \{[^}]*\})?) from "[^"]+";$/.test(l);
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

/** Texts of every spec statement (defineRegion/defineBlock/defineConcept, and code-first arc.test/arc.law/arc.configure)
 *  in a file, in order. */
export function specStatements(text: string): string[] {
  const sf = ts.createSourceFile("s.ts", text, ts.ScriptTarget.Latest, true);
  return sf.statements
    .filter((st) => (ts.isVariableStatement(st) && st.declarationList.declarations.some((d) => d.initializer && ts.isCallExpression(d.initializer) && /define(Region|Block|Concept)$/.test(d.initializer.expression.getText(sf)))) ||
      (ts.isExpressionStatement(st) && ts.isCallExpression(st.expression) && /^arc\.(test|test\.hidden|law|configure)$/.test(st.expression.expression.getText(sf))))
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

/** The body a compiler-owned, implemented region already has, when its spec is what the manifest recorded: the inverse
 *  of regionBodyLines, accepted only if it round-trips exactly. null = nothing to keep. */
function keptBody(p: Project, r: RegionInfo): string | null {
  const m = p.manifest.regions[r.id];
  if (r.state !== "compiler" || r.pending || r.childSpans.length || !m || m.specHash !== r.specHash) return null;
  const plain = r.kind === "block" || !!r.spec.codeFirst;
  const inner = plain ? r.bodyLines : r.bodyLines.slice(1, -1);
  const pad = plain ? r.indent : `${r.indent}  `;
  if (inner.some((l) => l.trim() && !l.startsWith(pad))) return null;
  const body = inner.map((l) => l.slice(pad.length)).join("\n");
  const again = regionBodyLines(r, body);
  return again.length === r.bodyLines.length && again.every((l, i) => l === r.bodyLines[i]) ? body : null;
}

function regionBodyLines(r: RegionInfo, body: string): string[] {
  const inner = linesOf(body.replace(/\r/g, "")).map((l) => (l.trim() ? `${r.indent}  ${l}` : ""));
  if (r.kind === "block" || r.spec.codeFirst) return linesOf(body.replace(/\r/g, "")).map((l) => (l.trim() ? `${r.indent}${l}` : "")); // code-first: statements only (position M)
  const s = r.spec;
  const exported = r.bodyLines.find((l) => l.trim())?.trimStart().startsWith("export") ?? true; // a leading blank line keeps export
  return [
    `${r.indent}${exported ? "export " : ""}const ${s.symbol}: ${s.typeText} = ${s.isAsync ? "async " : ""}(${s.params.join(", ")}) => {`,
    ...inner,
    `${r.indent}};`,
  ];
}

function mergeImports(text: string, imports: ImportDecl[], typeOnly: (from: string, name: string) => boolean): string {
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
    const def = imp.default && !have.has(imp.default) ? imp.default : undefined;
    if (imp.namespace && !have.has(imp.namespace)) {
      add.push(`import * as ${imp.namespace} from "${imp.from}";`);
      have.add(imp.namespace);
    }
    if (!names.length && !def) continue;
    const values = names.filter((n) => !typeOnly(imp.from, n));
    const types = names.filter((n) => typeOnly(imp.from, n));
    if (def) add.push(`import ${def}${values.length ? `, { ${values.join(", ")} }` : ""} from "${imp.from}";`);
    else if (values.length) add.push(`import { ${values.join(", ")} } from "${imp.from}";`);
    if (types.length) add.push(`import type { ${types.join(", ")} } from "${imp.from}";`);
    [...names, ...(def ? [def] : [])].forEach((n) => have.add(n));
  }
  if (!add.length) return text;
  const imports_ = sf.statements.filter(ts.isImportDeclaration);
  const at = imports_.length ? sf.getLineAndCharacterOfPosition(imports_.at(-1)!.getEnd()).line + 1 : 0;
  const lines = linesOf(text);
  lines.splice(at, 0, ...add);
  return lines.join("\n");
}

// cannot find name/property/export, or the wrong import form for a module (TS2595/TS1259/TS2497): a context problem
const TS_MISSING_CONTEXT = new Set([2304, 2305, 2339, 2551, 2552, 2724, 2595, 2614, 1259, 2497]);

/** model.parseOutput predates `default` on import items and rejects unknown keys: take `default` out first (null = absent). */
function splitDefaults(raw: string): { raw: string; defaults: Map<number, string> } {
  const defaults = new Map<number, string>();
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return { raw, defaults };
  }
  const imports = (v as { imports?: unknown } | null)?.imports;
  if (!Array.isArray(imports) || !imports.some((it) => typeof it === "object" && it !== null && "default" in it)) return { raw, defaults };
  imports.forEach((it: { default?: unknown; names?: unknown }, i) => {
    if (typeof it !== "object" || it === null || !("default" in it)) return;
    if (typeof it.default === "string" && it.default) defaults.set(i, it.default);
    delete it.default;
    it.names ??= [];
  });
  return { raw: JSON.stringify(v), defaults };
}

export const ATTEMPTS_KEPT = 20;
/** Failed attempts go to .openarc/attempts/<id>/<n>.json (n counts up across runs; the last ATTEMPTS_KEPT stay). */
async function saveAttempt(ports: Ports, id: string, record: { [k: string]: Json }): Promise<void> {
  const dir = `.openarc/attempts/${id}`;
  const ns = (await ports.fs.list(dir)).map((f) => Number.parseInt(f, 10)).filter(Number.isFinite).sort((a, b) => a - b);
  const n = (ns.at(-1) ?? 0) + 1;
  await ports.fs.write(`${dir}/${n}.json`, JSON.stringify({ n, at: ports.now(), ...record }, null, 2) + "\n");
  for (const old of ns.slice(0, Math.max(0, ns.length + 1 - ATTEMPTS_KEPT))) await ports.fs.remove(`${dir}/${old}.json`);
}

/** Sampling of an attempt: the backend's own on attempt 1; every retry varies it (temperature 0.4 on attempt 2, 0.7
 *  after that, seed + attempt - 1), because at temperature 0 a small model mostly repeats its body whatever the repair
 *  prompt says (issue #19: 14 of 24 retries were byte-identical to the previous body). */
export function retrySampling(b: BackendConfig, attempt: number): { temperature: number; seed: number } | null {
  return attempt === 1 ? null : { temperature: attempt === 2 ? 0.4 : 0.7, seed: (b.seed ?? 1) + attempt - 1 };
}

// Exact text (trimmed): collapsing whitespace would also merge replies that differ only inside a string literal.
export const repeatKey = (body: string): string => body.trim();

/** The retry prompt's note. A body that failed only its examples or tests is resampled: the base prompt plus what
 *  failed, without the body (issue #19: on a 7B, repairing with the body did no better than resampling, and resent the
 *  body's tokens). A parse, tsc or static failure keeps the full repair: its diagnostics point into the body. */
export function repairText(previous: { body: string; problems: string[] } | null): string {
  if (!previous) return "";
  if (previous.problems.length && previous.problems.every((x) => /^OARC-E09[01] /.test(x)))
    return `## A previous attempt failed\n${previous.problems.slice(0, 3).map((x) => x.slice(0, 300)).join("\n")}\n\nWrite a new body that passes every example and test above.`;
  return `## Your previous attempt failed\nPrevious body:\n${previous.body}\n\nProblems:\n${previous.problems.join("\n")}\n\nFix these problems.`;
}

const JSON_SYSTEM = "You are a compiler backend. You output JSON only: {\"body\": string, \"imports\": [{\"from\": string, \"names\": string[], \"default\"?: string}]}. body is TypeScript statements only, with no markdown.";
const BATCH_JSON_SYSTEM = "You are a compiler backend. You output JSON only: an object with one {\"body\": string, \"imports\": [...]} entry per region id. Each body is TypeScript statements only, with no markdown.";

/** A region's part of a batched first request: its slice of the reply ("json": its entry as JSON, "code": its
 *  section), the shared prompt's hash, and its share of the tokens and of the one call (the first region holds it). */
interface BatchShare { raw: string; tokens: Tokens | null; promptHash: string; ids: string[]; calls: number; contextChars: number }

/** Regions that can share a request: plain function regions (no sketch, UI, class member or nested blocks). */
const batchable = (r: RegionInfo) => r.kind === "function" && !r.spec.sketch && !r.spec.ui && !r.spec.codeFirst?.cls && r.childSpans.length === 0;
const cachePathOf = (r: RegionInfo) => `.openarc/cache/${r.fingerprint.replace("sha256:", "")}.json`;

/** The context of a batched request: the sections every member has verbatim, once (their type closures merged into
 *  one Types section), then one "## Region <id>" section per member with the rest, then the shared Rules. */
export function batchContext(p: Project, rs: RegionInfo[], backend: BackendConfig): string {
  const parts = rs.map((r) => contextSections(p, r, initialLevel(p, r), backend));
  const key = ([h, b]: [string, string]) => `${h}\n${b}`;
  const everywhere = new Set(parts[0]!.sections.map(key).filter((k) => parts.every((x) => x.sections.some((s) => key(s) === k))));
  const types = [...new Set(parts.flatMap((x) => x.types))];
  const shared = parts[0]!.sections.filter((s) => everywhere.has(key(s)) && s[0] !== "Rules" && s[0] !== TYPES_HEADING);
  if (types.length) shared.unshift([TYPES_HEADING, types.join("\n\n")]);
  const own = rs.map((r, i): [string, string] => [`Region ${r.id}`, renderSections(parts[i]!.sections.filter((s) => !everywhere.has(key(s)) && s[0] !== TYPES_HEADING), "###")]);
  return renderSections([...shared, ...own, ...parts[0]!.sections.filter((s) => s[0] === "Rules" && everywhere.has(key(s)))]);
}

const batchSchema = (ids: string[]): { loose: Json; strict: Json } => {
  const make = (one: Json): Json => ({ type: "object", additionalProperties: false, required: ids, properties: Object.fromEntries(ids.map((id) => [id, one])) });
  return { loose: make(OUTPUT_SCHEMA), strict: make(STRICT_OUTPUT_SCHEMA) };
};

/** compilation.batch "file": the first attempt of a region and of its pending siblings later in the plan (same file
 *  and backend, no cache hit, none naming another in `calls`) is ONE request. Returns this region's share and keeps
 *  the siblings' for their own generate; null = no batch (one request per region, as before). Each share then goes
 *  through the usual parse, repeat, verify and commit of its region; only failed regions retry, one by one. */
async function batchReply(ports: Ports, p: Project, r: RegionInfo, backend: BackendConfig & { name: string }): Promise<BatchShare | null> {
  const mine = p.batched?.get(r.id);
  if (mine) {
    p.batched!.delete(r.id);
    return mine;
  }
  if (p.config.compilation.batch === "off" || !batchable(r) || !p.targets) return null;
  let group = [r];
  for (const id of p.targets.slice(p.targets.indexOf(r.id) + 1)) {
    const x = p.regions.find((y) => y.id === id)!;
    const b = backendFor(p, id, 0);
    if (x.file !== r.file || !batchable(x) || b.name !== backend.name || b.outputFormat !== backend.outputFormat) continue;
    if ((await ports.fs.read(cachePathOf(x))) !== null || keptBody(p, x) !== null) continue; // a cache hit or a kept body needs no model call
    group.push(x);
  }
  group = group.filter((x) => !group.some((y) => y !== x && (x.spec.calls ?? []).includes(y.spec.symbol)));
  if (group.length < 2 || group[0] !== r) return null;
  const ids = group.map((x) => x.id);
  const code = backend.outputFormat === "code";
  const context = batchContext(p, group, backend);
  if (context.length > (backend.maxContextTokens - (backend.outputReserveTokens ?? DEFAULT_OUTPUT_RESERVE)) * 3.5) return null; // ponytail: too big to share
  const rendered = renderTemplate(code ? BATCH_CODE_PROMPT_TEMPLATE : BATCH_PROMPT_TEMPLATE, {
    count: String(ids.length), context, ids: ids.join("\n"), shape: `{${ids.map((id) => `"${id}": {"body": "<statements>", "imports": []}`).join(", ")}}`,
  });
  if (!rendered.ok) throw new Error(`batch prompt template is missing ${rendered.missing.join(", ")}`);
  const t0 = Date.now();
  // a failed request throws: generate reports it as this region's E080, like its own request's
  const { text: raw, tokens } = await completeWithUsage(ports, { ...backend, ...(code ? {} : { outputSchema: batchSchema(ids) }) }, code ? BATCH_CODE_SYSTEM : BATCH_JSON_SYSTEM, rendered.text);
  p.e080Streak = 0;
  ports.log(`  ${ids.join(", ")}: one batched request via ${backend.name} (${backend.model}), context ${context.length} chars, ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  let parts: string[];
  if (code) parts = [...splitCodeSections(raw, ids).values()].map((t) => t ?? "");
  else {
    let v: unknown = null;
    try {
      v = JSON.parse(raw);
    } catch { /* every region gets the raw reply and reports it as invalid JSON */ }
    const o = typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
    parts = ids.map((id) => (o ? JSON.stringify(o[id] ?? null) : raw));
  }
  const n = ids.length;
  const share = (v: number, i: number) => Math.floor(v / n) + (i === 0 ? v % n : 0);
  const shares = ids.map((_, i): BatchShare => ({ raw: parts[i]!, tokens: tokens && { prompt: share(tokens.prompt, i), completion: share(tokens.completion, i) }, promptHash: sha256Tagged(rendered.text), ids, calls: i === 0 ? 1 : 0, contextChars: context.length }));
  p.batched ??= new Map();
  ids.forEach((id, i) => i > 0 && p.batched!.set(id, shares[i]!));
  return shares[0]!;
}

export async function generate(ports: Ports, req: CompileRequest, p: Project, id: string, diagnostics: Diagnostic[]): Promise<{ candidate: Candidate | null; modelCalls: number }> {
  const r = p.regions.find((x) => x.id === id)!;
  const c = p.config.compilation;
  let level = initialLevel(p, r);
  let stage: 0 | 1 = 0;
  let modelCalls = 0;
  let previous: { body: string; problems: string[] } | null = null;
  const seen = new Set<string>(); // repeatKey of every body (or invalid reply) this run produced for the region
  let spent: Tokens | null = null; // every model call for this region in this run (provenance.tokens)
  let cachedTokens: Tokens | null = null; // a cache hit carries the tokens that produced its body
  for (const [law, why] of concepts.waivers(r.spec)) ports.log(`  ${id}: law "${law}" waived: ${why}`); // palette
  const dom = r.spec.ui ? await ui.domProblem(ports, p.config.ui?.dom) : null; // palette: UI checks need the project's DOM
  if (dom) {
    diagnostics.push(err("OARC-E092", { id, detail: dom })); // no unverified fallback, and no model call wasted
    return { candidate: null, modelCalls: 0 };
  }
  const cachePath = cachePathOf(r);
  let cached = await ports.fs.read(cachePath);
  // Spec unchanged, only the context moved (a sibling added or changed, issue #19 evolution run): the region's own body
  // goes through verification first, like a cache hit, and the model is asked only if it fails.
  const kept = !cached ? keptBody(p, r) : null;
  if (kept !== null) cached = JSON.stringify({ body: kept, imports: [] });
  // A compiler-owned region that fails keeps its old body, which may not satisfy the current spec: say so (display: stale).
  const giveUp = () => {
    if (r.state === "compiler") diagnostics.push(err("OARC-W043", { id }));
    return { candidate: null, modelCalls };
  };
  // The backend died mid-run (e.g. Ollama OOM-killed): after 3 consecutive E080s, stop calling it for the rest of the
  // run. Checked before each model call, not up front, so a cache hit still compiles.
  const backendDown = () => {
    if (++p.e080Streak === 3) diagnostics.push(err("OARC-E080", { detail: "stopped:3-consecutive" }));
    return giveUp();
  };
  // Repeat-stop: a reply identical to an earlier one of this run is not verified again, and it ends the
  // region's attempts (E082 repeat: with the earlier verdict): on a 7B no retry after a repeat ever passed (issue #19).
  // A configured fallback backend still gets its turn.
  const repeated = (text: string): boolean => {
    const key = repeatKey(text);
    if (!seen.has(key)) {
      seen.add(key);
      return false;
    }
    const fallback = !!c.fallbackBackend && stage === 0;
    ports.log(`  ${id}: ✗ the reply repeats an earlier attempt; ${fallback ? "switching to the fallback backend" : "stopping"}`);
    return true;
  };
  /** After a repeat: the fallback backend's turn when there is one, else E082 and give up (null = continue). */
  const afterRepeat = () => {
    if (c.fallbackBackend && stage === 0) {
      stage = 1;
      return null;
    }
    diagnostics.push(err("OARC-E082", { id, detail: `repeat: ${previous?.problems[0] ?? ""}`.slice(0, 200) }));
    return giveUp();
  };

  for (let attempt = 1; attempt <= c.maxAttempts; attempt++) {
    const backend = backendFor(p, id, stage);
    const at: Attempt = { backend, level };
    let body: string;
    let imports: ImportDecl[];
    let sampling: { temperature: number; seed: number } | null = null;
    let promptHash: string | null = null;
    let tokens: Tokens | null = null;
    let batch: string[] | null = null; // the region ids that shared this attempt's request
    const code = backend.outputFormat === "code";
    if (attempt === 1 && cached) {
      ({ body, imports, sampling = null, tokens: cachedTokens = null } = JSON.parse(cached) as { body: string; imports: ImportDecl[]; sampling?: { temperature: number; seed: number }; tokens?: Tokens });
      ports.log(`  ${id}: ${kept !== null ? "spec unchanged, re-verifying the current body" : "cache hit"}`);
    } else {
      if (p.e080Streak >= 3) return giveUp();
      const digest = await modelDigest(ports, p, backend, diagnostics);
      if (digest === null) return backendDown();
      const t0 = Date.now();
      let raw: string;
      let contextChars: number;
      let shared: BatchShare | null;
      try {
        shared = attempt === 1 ? await batchReply(ports, p, r, backend) : null;
      } catch (e) {
        diagnostics.push(err("OARC-E080", { id, detail: (e as Error).message.slice(0, 120) }));
        return backendDown();
      }
      if (shared) {
        ({ raw, tokens, promptHash, ids: batch, contextChars } = shared);
        spent = addTokens(spent, tokens);
        modelCalls += shared.calls;
      } else {
        const context = attempt === 1 && level === initialLevel(p, r) ? r.context0 : buildContext(p, r, level, backend);
        contextChars = context.length;
        // palette: a sketch region uses the fills protocol; in "code" format the model returns the whole filled sketch as
        // one code block and verify's containment check (E099) recovers the fills
        const rendered = renderTemplate(r.spec.sketch ? (code ? sketch.SKETCH_CODE_PROMPT_TEMPLATE : sketch.SKETCH_PROMPT_TEMPLATE) : code ? CODE_PROMPT_TEMPLATE : PROMPT_TEMPLATE, { context, repair: repairText(previous) });
        if (!rendered.ok) throw new Error(`prompt template is missing ${rendered.missing.join(", ")}`);
        promptHash = sha256Tagged(rendered.text);
        sampling = retrySampling(backend, attempt);
        try {
          ({ text: raw, tokens } = await completeWithUsage(
            ports,
            { ...(sampling ? { ...backend, ...sampling } : backend), ...(r.spec.sketch && !code ? { outputSchema: sketch.fillsSchema(r.spec.sketch) } : {}) },
            r.spec.sketch ? (code ? sketch.SKETCH_CODE_SYSTEM : sketch.SKETCH_SYSTEM) : code ? CODE_SYSTEM : JSON_SYSTEM,
            rendered.text,
          ));
          spent = addTokens(spent, tokens);
        } catch (e) {
          diagnostics.push(err("OARC-E080", { id, detail: (e as Error).message.slice(0, 120) }));
          return backendDown();
        }
        p.e080Streak = 0;
        modelCalls++;
      }
      const split = code ? { raw, defaults: new Map<number, string>() } : splitDefaults(raw);
      const parsed = code ? parseCodeOutput(raw) : r.spec.sketch ? sketch.parseFills(split.raw, r.spec.sketch) : parseOutput(split.raw); // palette: fills
      const varied = sampling ? ` (retry sampling: temperature ${sampling.temperature}, seed ${sampling.seed})` : "";
      ports.log(`  ${id}: attempt ${attempt} via ${backend.name} (${backend.model}), context L${level} ${contextChars} chars${varied}${batch ? `, batched with ${batch.length - 1} other region${batch.length === 2 ? "" : "s"}` : ""}, ${((Date.now() - t0) / 1000).toFixed(1)}s`);
      if (!parsed.ok) {
        const problem = `output was not valid: ${parsed.diagnostic.detail}`;
        ports.log(`  ${id}: ✗ ${problem} (${raw.length} chars${raw.length ? `, ends ${JSON.stringify(raw.slice(-40))}` : ""})`);
        await saveAttempt(ports, id, { attempt, backend: backend.name, model: backend.model, outputFormat: backend.outputFormat!, contextLevel: level, promptHash, sampling, tokens, ...(batch ? { batch } : {}), raw, problems: [problem] });
        if (repeated(raw)) {
          const stop = afterRepeat();
          if (stop) return stop;
        }
        previous = { body: raw.slice(0, 2000), problems: [problem] };
        continue;
      }
      body = parsed.body;
      imports = parsed.imports.map((im, i) => (split.defaults.has(i) ? { ...im, default: split.defaults.get(i)! } : im));
    }
    const tsx = r.file.endsWith(".tsx"); // palette: UI components are parsed as TSX
    body = unwrapBody(body, r.kind, tsx, { name: r.spec.symbol, params: r.spec.params });
    const clean = stripMarkerComments(body, tsx);
    if (clean.stripped) {
      ports.log(`  ${id}: stripped ${clean.stripped} comment${clean.stripped === 1 ? "" : "s"} mentioning @openarc: (markers belong to the compiler)`);
      body = clean.body;
    }
    const replyKey = body + (imports.length ? `\n${JSON.stringify(imports)}` : "");
    if (repeated(replyKey)) { // the same reply again: same verdict
      await saveAttempt(ports, id, { attempt, source: promptHash ? "model" : "cache", backend: backend.name, model: backend.model, outputFormat: backend.outputFormat!, contextLevel: level, promptHash, sampling, tokens, body, imports: imports as unknown as Json, problems: ["repeat of an earlier attempt (not verified again)"] });
      const stop = afterRepeat();
      if (stop) return stop;
      continue;
    }
    const result = await verify(ports, req, p, r, body, imports);
    if (!result.ok && result.problems[0]?.startsWith("OARC-E091")) seen.delete(repeatKey(replyKey)); // a timeout is no verdict: an identical retry runs again
    if (result.ok) {
      if (attempt === 1 && cached) spent = cachedTokens;
      if (result.holes?.length) { // palette: a hole no passing example reaches is unverified (W045): not cached, not committed
        for (const n of result.holes) diagnostics.push(err("OARC-W045", { id, detail: `hole:${id}#${n}` }));
        ports.log(`  ${id}: unverified: no passing example reaches hole(s) ${result.holes.map((n) => `«${n}»`).join(", ")} (${result.verifiedBy.join(", ")}); add an example that does`);
        return giveUp();
      }
      // A block that no passing example reaches is never cached or counted as verified (W045); the joint check at STAGE
      // holds it back. One reached by none YET, while sibling blocks are still pending, is provisional: cached, and
      // committed only once the joint check sees a passing example reach it.
      if (!(attempt === 1 && cached) && !result.unverified) await ports.fs.write(cachePath, JSON.stringify({ body, imports, ...(sampling ? { sampling } : {}), ...(spent ? { tokens: spent } : {}) }));
      const waived = Object.fromEntries(concepts.waivers(r.spec)); // palette: waived laws are recorded with the body
      p.provenance.set(id, { source: "generated", backend: at.backend.name, model: at.backend.model, outputFormat: at.backend.outputFormat!, contextLevel: at.level, attempts: attempt, verifiedBy: result.verifiedBy, ...(sampling ? { sampling } : {}), ...(batch ? { batch } : {}), ...(spent ? { tokens: spent } : {}), ...(Object.keys(waived).length ? { waived } : {}) });
      if (result.unverified) {
        diagnostics.push(err("OARC-W045", { id, detail: `unreached:${r.root}` }));
        ports.log(`  ${id}: unverified: no passing example of ${r.root} reaches this block (${result.verifiedBy.join(", ")})`);
      } else if (result.verifiedBy.includes("unreached")) ports.log(`  ${id}: provisional: ${result.verifiedBy.join(", ")} (no passing example reaches it while siblings are pending; the joint check decides)`);
      else ports.log(`  ${id}: ✓ ${result.verifiedBy.join(", ")}`);
      return { candidate: { id, body, imports, verifiedBy: result.verifiedBy }, modelCalls };
    }
    ports.log(`  ${id}: ✗ ${result.problems[0]?.slice(0, 160)}`);
    await saveAttempt(ports, id, { attempt, source: promptHash ? "model" : "cache", backend: backend.name, model: backend.model, outputFormat: backend.outputFormat!, contextLevel: level, promptHash, sampling, tokens, ...(batch ? { batch } : {}), body, imports: imports as unknown as Json, problems: result.problems });
    previous = { body, problems: result.problems };
    if (result.stop) { // palette: OARC-E100, no fill can fix it
      diagnostics.push(result.stop);
      return giveUp();
    }
    // Escalation by failure type: a missing name means a context problem, so expand; otherwise repair at the same level.
    // The last attempt switches to the fallback backend when one is configured.
    if (c.context.expandOnFailure && result.missingContext && level < (r.spec.sketch ? 1 : 2)) level = (level + 1) as ContextLevel;
    if (attempt === c.maxAttempts - 1 && c.fallbackBackend) stage = 1;
  }
  diagnostics.push(err("OARC-E082", { id, detail: previous?.problems[0]?.slice(0, 200) }));
  return giveUp();
}

interface Verified {
  ok: boolean;
  problems: string[];
  verifiedBy: string[];
  missingContext: boolean;
  unverified?: boolean; // a block that passing examples never reach while every example was conclusive (W045)
  holes?: number[]; // palette: sketch holes no passing example reaches (W045)
  stop?: Diagnostic; // palette: OARC-E100, stop the repair loop
}

/** Specifiers a file imports from. */
const importedSpecifiers = (text: string) =>
  new Set(ts.createSourceFile("i.ts", text, ts.ScriptTarget.Latest, true).statements.filter(ts.isImportDeclaration).map((d) => (d.moduleSpecifier as ts.StringLiteral).text));

async function verify(ports: Ports, req: CompileRequest, p: Project, r: RegionInfo, body: string, imports: ImportDecl[]): Promise<Verified> {
  const fail = (problems: string[], missingContext = false): Verified => ({ ok: false, problems, verifiedBy: [], missingContext });
  const base = p.accepted.get(r.file) ?? p.files.get(r.file)!;
  // static. Allowed (§7.2, matching RULES): deps, openarc, modules the file already imports, and type-only imports of
  // closure types the context showed as "not in scope" (from their own file).
  const allowed = new Set([...r.spec.deps, "open-arc", ...importedSpecifiers(base)]);
  const shownType = (i: ImportDecl) => !i.default && !i.namespace && i.names.length > 0 && i.names.every((n) => r.typeImports.get(n) === i.from);
  const bad = imports.filter((i) => !allowed.has(i.from) && !shownType(i));
  if (bad.length) return fail(bad.map((i) => `OARC-E071 import "${i.from}" is not allowed (allowed: ${[...allowed].join(", ")}, or a type shown as not in scope from its own file)`));
  // Closure types the body names but the file doesn't import: the compiler adds the type-only import (§8.8).
  const autoTypes = [...r.typeImports].filter(([name]) => new RegExp(`(?<![\\w$.])${name.replace(/\$/g, "\\$")}(?![\\w$])`).test(body));
  imports = [...imports, ...autoTypes.map(([name, from]) => ({ from, names: [name] }))];
  // Requested imports are file bindings too: `import crypto from "node:crypto"` makes `crypto` a binding, not the global.
  const bound = fileBindings(base);
  for (const i of imports) localNames(i).forEach((n) => bound.add(n));
  // palette: a sketch region's body must be its sketch with only the holes filled (E099); fills keep §3.4 and the implied calls
  const sk = r.spec.sketch ? sketch.checkSketchBody(r.spec.sketch, body, r.spec.calls ?? [], imports.flatMap(localNames)) : null;
  if (sk?.problems.length) return fail(sk.problems);
  const tsx = r.file.endsWith(".tsx"); // palette
  const st = staticCheck(body, r.spec.effects, bound, sk ? undefined : callPolicy(p, r, imports), tsx);
  if (st.length) return fail(st.map((s) => `${s.diag.code} ${s.message}`));
  if (r.kind === "block") {
    const rs = checkRestrictions(body, p.specs.get(r.root)?.isAsync ?? false, []);
    if (rs.length) return fail(rs.map((d) => `OARC-E035 not allowed in a block: ${d.detail}`));
  }
  const escape = guardBody(body, tsx);
  if (escape) return fail([escape]);
  // splice into the in-memory copy (with this run's accepted candidates) and type-check
  const typeOnly = (from: string, name: string) => {
    if (r.typeImports.get(name) === from) return true;
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
  // a body that is itself pending would read as an inconclusive outcome (a pending sibling), never as a failure
  if (pendingInBody(prog, sf, text, r.id)) return fail(["OARC-E033 the body calls arc.todo() (or throws OpenArcTodoError): implement the region instead of leaving it pending"]);
  const verifiedBy = ["tsc", "static"];
  // examples in the sandbox: the region's own (function) or its enclosing function's (block)
  const rootSpec = p.specs.get(r.root)!;
  const cf = r.spec.codeFirst; // code-first: tests run with the examples; the members of a class are probed together
  if (hasChecks(rootSpec)) {
    // palette: a sketch's sandbox copy carries one coverage probe per hole
    const sbOverlay = sk ? new Map(overlay).set(r.file, mergeImports(spliceRegion(base, r.id, regionBodyLines(r, sketch.spliceFills(r.spec.sketch!, sk.fills, r.id))), imports, typeOnly)) : overlay;
    const probes = r.kind === "block" ? [r.id] : cf ? groupIds(p, r) : [];
    const res = await runSandbox(ports, req, p, r.root, sbOverlay, undefined, probes);
    const pendingSiblings = (o: { actual?: Json }) => isPendingOutcome(o) && (r.kind === "block" || !!cf);
    const real = res.failed.filter((o) => !pendingSiblings(o));
    if (res.error) return fail([res.error]);
    const registry = res.failed.find((o) => o.name === "test-registry"); // code-first: no body can fix it: stop
    if (registry) return { ...fail([testsPlan.failureText(undefined, registry.name, registry.actual)]), stop: err("OARC-E090", { id: r.id, detail: `test-registry:${(registry.actual as { registry?: string }).registry ?? ""}` }) };
    const conflict = sk && real.length ? sketch.sketchConflict(res.stdout ?? "", r.id) : null; // palette: OARC-E100
    if (conflict) return { ...fail([`OARC-E100 example "${conflict.detail}" fails without reaching any hole: the sketch decides it, so no fill can fix it`]), stop: conflict };
    if (real.length || (!res.complete && r.kind === "function"))
      return fail(real.map((o) => testsPlan.isTestOutcome(o.name) ? testsPlan.failureText(testOf(p, o.name, r.root), o.name, o.actual)
        : `OARC-E090 example "${o.name}" failed: got ${showValue(o.actual)}; expected ${showValue(exampleExpected(rootSpec, o.name))}`).concat(res.complete ? [] : ["OARC-E090 harness output incomplete (process exited early?)"]));
    if (cf || rootSpec.codeFirst) verifiedBy.push(...testsPlan.verifiedBy(rootSpec, res));
    else verifiedBy.push(`examples:${res.passed}/${rootSpec.ui ? res.passed + res.failed.length : rootSpec.examples.length}${res.failed.length ? ` (${res.failed.length} inconclusive: sibling blocks pending)` : ""}`);
    if (r.kind === "block") verifiedBy.push(`via:${r.root}`);
    const holes = sk ? sketch.unreachedHoles(r.spec.sketch!, r.id, res.hits) : [];
    if (holes.length) return { ok: true, problems: [], verifiedBy, missingContext: false, holes }; // palette: W045 per hole
    if ((r.kind === "block" || cf) && !res.hits.has(r.id)) {
      verifiedBy.push("unreached");
      if (!res.failed.length) {
        p.accepted.set(r.file, text);
        return { ok: true, problems: [], verifiedBy, missingContext: false, unverified: true };
      }
    }
  }
  p.accepted.set(r.file, text);
  return { ok: true, problems: [], verifiedBy, missingContext: false };
}

/** Whether region `id`'s body in `sf` calls open-arc's `todo` or constructs its OpenArcTodoError (through any import name). */
function pendingInBody(prog: ts.Program, sf: ts.SourceFile, text: string, id: string): boolean {
  const ls = linesOf(text);
  const b = ls.findIndex((l) => l.trim() === `// @openarc:begin ${id}`);
  const e = ls.findIndex((l, i) => i > b && l.trim() === `// @openarc:end ${id}`);
  if (b < 0 || e < 0) return false;
  const from = sf.getPositionOfLineAndCharacter(b, 0), to = sf.getPositionOfLineAndCharacter(e, 0);
  const checker = prog.getTypeChecker();
  const isCore = (n: ts.Expression, name: string) => {
    let sym = checker.getSymbolAtLocation(ts.isPropertyAccessExpression(n) ? n.name : n);
    if (sym && sym.flags & ts.SymbolFlags.Alias) sym = checker.getAliasedSymbol(sym);
    return sym?.name === name && !!sym.declarations?.some((d) => /\bclass OpenArcTodoError\b/.test(d.getSourceFile().text));
  };
  let hit = false;
  const walk = (n: ts.Node): void => {
    if (hit || n.end < from || n.pos > to) return;
    if (n.pos >= from && n.end <= to && ((ts.isCallExpression(n) && isCore(n.expression, "todo")) || (ts.isNewExpression(n) && isCore(n.expression, "OpenArcTodoError")))) hit = true;
    n.forEachChild(walk);
  };
  walk(sf);
  return hit;
}

/** An outcome that failed only because a region it reached is still pending (inconclusive, not a failure). */
const isPendingOutcome = (o: { actual?: Json }) =>
  typeof o.actual === "object" && o.actual !== null && !Array.isArray(o.actual) && typeof o.actual.pending === "string";
/** code-first: the regions verified together with `r` (the code-first members of its class; itself otherwise). */
const groupIds = (p: Project, r: RegionInfo) => p.regions.filter((x) => x.spec.codeFirst?.group === r.spec.codeFirst?.group).map((x) => x.id);
/** code-first: the test a test outcome line is about, among the tests of region `id`. */
const testOf = (p: Project, name: string, id: string) => (p.tests ?? []).find((t) => t.regions.includes(id) && testsPlan.outcomeName(t) === name);

/** A harness value or example literal as text, tokens unquoted: [-0,1,NaN] (core/harness.ts showValue). */
const showValue = (v: Json | undefined): string =>
  v === undefined ? "undefined" : JSON.stringify(v).replace(/"\$(-0|NaN|-?Infinity|undefined)"/g, "$1");

function exampleExpected(spec: SpecInfo, name: string): Json {
  const exs = spec.examples as { name?: string; expected?: Json; throws?: Json; fakesAfter?: Json }[];
  const i = exs.findIndex((e, k) => (e.name ?? `#${k + 1}`) === name);
  const e = exs[i];
  return e ? (e.expected ?? (e.throws !== undefined ? { throws: e.throws } : { fakesAfter: e.fakesAfter ?? null })) : null;
}

// ───────────────────────────── sandbox ─────────────────────────────

/** The coverage probe (§8.10): `globalThis.__openarcHit?.("<id>")` as the first statement of each block in `ids`. Only
 *  ever applied to the sandbox's staged copy, never to text that is committed. */
function probed(p: Project, overlay: Map<string, string>, ids: string[]): Map<string, string> {
  const out = new Map(overlay);
  for (const id of ids) {
    const r = p.regions.find((x) => x.id === id)!;
    const lines = linesOf(out.get(r.file)!);
    const at = lines.findIndex((l) => l.trim() === `// @openarc:begin ${id}`);
    if (at < 0) continue;
    lines.splice(at + 1, 0, `${r.indent}globalThis.__openarcHit?.(${JSON.stringify(id)});`);
    out.set(r.file, lines.join("\n"));
  }
  return out;
}

/** Probed block ids that passing examples reached (the harness adds `hits` to passing outcome lines). */
function harnessHits(stdout: string): Set<string> {
  const hits = new Set<string>();
  for (const line of stdout.split("\n")) {
    try {
      const v = JSON.parse(line) as { ok?: unknown; hits?: unknown };
      if (v?.ok === true && Array.isArray(v.hits)) for (const h of v.hits) hits.add(String(h));
    } catch {
      // not an outcome line
    }
  }
  return hits;
}

export type SandboxResult = { complete: boolean; passed: number; failed: { name: string; actual?: Json }[]; hits: Set<string>; error?: string; stdout?: string };

async function runSandbox(ports: Ports, req: CompileRequest, p: Project, rootId: string, overlay: Map<string, string>, oracle?: { module: string; export: string; inputs: Json[][] }, probe: string[] = [], testIds: string[] = [rootId]): Promise<SandboxResult> {
  const none = new Set<string>();
  if (req.sandbox.unavailable) return { complete: false, passed: 0, failed: [], hits: none, error: `OARC-E092 sandbox unavailable: ${req.sandbox.unavailable}` };
  const tier = req.sandbox.isolation ?? "bwrap";
  const dir = p.sandboxDir ?? (p.sandboxDir = `.openarc/sandbox/${Date.now().toString(36)}`);
  if ((await ports.fs.read(`${dir}/package.json`)) === null) {
    for (const f of ["package.json", "tsconfig.json", ...SOURCE_DIRS.map((d) => `${d}/package.json`)]) {
      const t = await ports.fs.read(f);
      if (t !== null) await ports.fs.write(`${dir}/${f}`, t);
    }
    await ports.fs.write(`${dir}/.openarc/harness.mjs`, HARNESS_ENTRY); // the project's copy may predate argv[3]
    // bwrap sees only the stage, so node_modules is hard-linked into it (Linux: cp -al always exists); links in it that
    // leave the project are bound at their real paths (isolation.bwrapReadPaths). The other tiers
    // read the project's node_modules in place: module resolution walks up from the stage, which lives inside the
    // project, and isolation.readPaths grants exactly that directory. The container tier mounts it at /work/node_modules.
    if (tier === "bwrap") {
      const cp = await ports.proc.run(["cp", "-al", `${p.root}/node_modules`, `${p.root}/${dir}/node_modules`], 60_000);
      if (cp.code !== 0) return { complete: false, passed: 0, failed: [], hits: none, error: `OARC-E092 could not stage node_modules: ${cp.stdout}` };
    } else if (tier === "container") await ports.fs.write(`${dir}/node_modules/.mountpoint`, "");
  }
  const tests = testsPlan.harnessTests(p.tests ?? [], testIds); // code-first: the planned tests, and staged copies that index them
  for (const [rel, text] of probe.length ? probed(p, overlay, probe) : overlay) await ports.fs.write(`${dir}/${rel}`, tests ? testsPlan.instrument(text, rel, p.tests!) : text);
  const spec = p.specs.get(rootId)!;
  // Examples are passed from the compiler's STATIC extraction: a body that mutates spec.examples at runtime cannot weaken its own tests.
  const tolerance = typeof spec.literal.tolerance === "number" ? { tolerance: spec.literal.tolerance } : {};
  // palette: a UI region's module is its component file; the harness gets the structure tree for the derived checks
  const uiPlan = spec.ui ? { module: p.regions.find((x) => x.id === rootId)!.file, ui: spec.ui as unknown as Json } : {};
  await ports.fs.write(`${dir}/.openarc/harness-plan.json`, JSON.stringify({ [rootId]: { module: spec.file, symbol: spec.symbol, specExport: spec.exportName, examples: spec.examples, ...tolerance, ...(oracle ? { oracle } : {}), ...uiPlan, ...(tests ? { tests } : {}) } }));
  const sb = p.config.sandbox ?? {};
  const limits = {
    nodeBin: req.sandbox.nodeBin, nodePrefix: req.sandbox.nodePrefix, heapMb: sb.heapMb ?? req.sandbox.heapMb,
    cpuSeconds: sb.cpuSeconds ?? req.sandbox.cpuSeconds, regionId: rootId,
  };
  const argv = tier === "bwrap"
    ? buildArgv({ ...limits, stageDir: `${p.root}/${dir}`, addressSpaceBytes: sb.addressSpaceBytes ?? req.sandbox.addressSpaceBytes, extraReadPaths: bwrapReadPaths(p.root, `${p.root}/${dir}`) })
    : tierArgv(tier, { ...limits, root: p.root, stageDir: join(p.root, dir), containerImage: req.sandbox.containerImage });
  const res = await ports.proc.run(argv, ((sb.cpuSeconds ?? req.sandbox.cpuSeconds) + 20) * 1000);
  if (res.timedOut) return { complete: false, passed: 0, failed: [], hits: none, error: "OARC-E091 sandbox timed out" };
  const summary = { ...readHarnessOutput(res.stdout), hits: harnessHits(res.stdout), stdout: res.stdout };
  // no outcome line at all (only stderr: a crash before the first example): one diagnostic, not one failure per line
  if (!summary.complete && summary.passed === 0 && summary.failed.every((f) => f.name === "<unparseable>"))
    return { ...summary, error: `OARC-E090 harness crashed (exit ${res.code}): ${crashLine(res.stdout)}` };
  return summary;
}

/** The line of a crash's output that says what went wrong: the first `...Error: ...` line, else the first line that is
 *  not Node's experimental-feature warning, else "no output". */
export function crashLine(out: string): string {
  const lines = out.split("\n").map((l) => l.trim()).filter((l) => l && !/ExperimentalWarning|--trace-warnings/.test(l));
  return lines.find((l) => /^[\w.]*Error\b/.test(l)) ?? lines[0] ?? "no output";
}

/** `openarc doctor`: one example through the real sandbox path, in this project. It returns 2 and then the error code
 *  of a file write, a child process and a connection to a socket doctor listens on, each of which the sandbox must refuse. */
export const DOCTOR_EXPECTED: Json = ["2", "ERR_ACCESS_DENIED", "ERR_ACCESS_DENIED", "ERR_ACCESS_DENIED"];
/** Connection errors that mean "denied": a permission refusal (Node's model, sandbox-exec), or a network namespace of
 *  its own (bwrap, container) where the socket doctor is listening on does not exist. A timeout or anything else proves
 *  nothing. */
export const NETWORK_DENIED: readonly string[] = ["ERR_ACCESS_DENIED", "EPERM", "EACCES", "ECONNREFUSED", "ENETUNREACH"];
const doctorSource = (escape: string, port: number) => `import { writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
const code = async (f: () => unknown): Promise<string> => {
  try {
    await f();
    return "allowed";
  } catch (e) {
    const x = e as { code?: unknown; cause?: { code?: unknown } };
    return String(x.code ?? x.cause?.code ?? e);
  }
};
const reach = () => new Promise<void>((ok, no) => {
  const s = connect(${port}, "127.0.0.1", () => (s.destroy(), ok()));
  s.on("error", no);
  s.setTimeout(3000, () => (s.destroy(), no(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }))));
});
export const probeSpec = { id: "doctor.probe", intent: "" };
export const probe = async (n: number): Promise<string[]> => [
  String(n + 1),
  await code(() => writeFileSync(join(tmpdir(), ${JSON.stringify(escape)}), "x")),
  await code(() => execFileSync(process.execPath, ["-e", ""])),
  await code(reach),
];
`;
/** doctor's verdict on the probe: what to print and whether the sandbox held. `networkExcused`: the node tier on a Node
 *  without network permission (< 25), where an allowed connection is a known gap (W046), not a failure. */
export function doctorReport(res: SandboxResult, tier: string, networkExcused: boolean): { lines: string[]; ok: boolean } {
  if (res.error) return { lines: [`sandbox: ${res.error}`], ok: false };
  if (!res.complete) return { lines: ["sandbox: harness output incomplete (process exited early?)"], ok: false };
  const got = res.passed === 1 ? (DOCTOR_EXPECTED as string[]) : res.failed[0]?.actual;
  if (!Array.isArray(got)) return { lines: [`sandbox: the example did not run: ${JSON.stringify(res.failed[0]?.actual ?? null)}`], ok: false };
  let ok = got[0] === "2";
  const lines = [`example: ${ok ? "ok (1 + 1 = 2 inside the sandbox)" : `FAIL (got ${String(got[0])})`}`];
  for (const [i, what] of ["file write", "child process", "network"].entries()) {
    const r = String(got[i + 1]);
    const allowed = r === "allowed";
    const excused = allowed && what === "network" && networkExcused;
    // the network probe connects to a socket doctor itself listens on, so only a denial counts as blocked; anything
    // else (a timeout, an unrelated error) proves nothing either way
    const unproven = !allowed && what === "network" && !NETWORK_DENIED.includes(r);
    if (((allowed && !excused) || unproven) && tier !== "unsafe-none") ok = false;
    lines.push(`${what.padEnd(13)} ${allowed ? (excused ? "ALLOWED (Node < 25 has no network permission; use Node 25+ or an OS sandbox)" : "ALLOWED") : unproven ? `UNVERIFIED (${r})` : `blocked (${r})`}`);
  }
  lines.push(ok ? "doctor: ok" : "doctor: FAIL");
  return { lines, ok };
}
export async function sandboxProbe(ports: Ports, req: CompileRequest): Promise<SandboxResult> {
  const spec = { file: "src/__openarc_doctor.ts", symbol: "probe", exportName: "probeSpec", literal: {}, examples: [{ args: [1], expected: DOCTOR_EXPECTED }] };
  const p = await parse(ports, req, []); // the project's own files are staged too, as in a compile (core/ of a file: dep)
  p.specs.set("doctor.probe", spec as unknown as SpecInfo);
  const escape = `openarc-doctor-escape-${process.pid}-${randomBytes(4).toString("hex")}`;
  const server = createServer((c) => c.destroy());
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  try {
    const port = (server.address() as AddressInfo).port;
    return await runSandbox(ports, req, p, "doctor.probe", new Map(p.files).set(spec.file, doctorSource(escape, port)));
  } finally {
    server.close();
    rmSync(join(tmpdir(), escape), { force: true }); // written only where the sandbox let it through (unsafe-none)
    if (p.sandboxDir) await ports.fs.remove(p.sandboxDir);
  }
}

// ───────────────────────────── STAGE ─────────────────────────────

/** Apply candidates, run the joint check for blocks, build the new manifest, and write staged files. */
export async function stage(ports: Ports, req: CompileRequest, p: Project, candidates: Candidate[], txid: string, diagnostics: Diagnostic[]): Promise<StagedFile[]> {
  // Joint check (F14): a block is verified only through its function's examples, and sibling outcomes that fail because
  // another block is still pending count as inconclusive. So a generated block is committed only if its function passes
  // ALL its examples now. When a sibling is still pending (it failed under --keep-going, or wasn't requested), the joint
  // check can't run: the block is held back (OARC-W042) and stays pending. Its cache entry stays, so the next run gets it
  // without a model call. A failed joint check aborts the run, or under --keep-going holds back that function's blocks.
  const overlay = new Map(p.files);
  for (const [k, v] of p.accepted) overlay.set(k, v);
  const regionOf = (id: string) => p.regions.find((r) => r.id === id)!;
  const generatedIds = new Set(candidates.map((c) => c.id));
  const genBlocks = candidates.map((c) => regionOf(c.id)).filter((r) => r.kind === "block");
  const roots = [...new Set(genBlocks.map((r) => r.root))].filter((id) => hasChecks(p.specs.get(id)));
  const held = new Set<string>();
  const hold = (rootId: string) => {
    for (const r of genBlocks.filter((b) => b.root === rootId)) {
      held.add(r.id);
      overlay.set(r.file, spliceRegion(overlay.get(r.file)!, r.id, r.bodyLines)); // back to its pre-run (pending) body
    }
    // verify() also merged the held blocks' imports. A file whose every candidate is now held goes back to its pre-run
    // text, imports included. ponytail: a file that also has an accepted candidate keeps them (one unused import line).
    for (const file of new Set(genBlocks.filter((b) => b.root === rootId).map((b) => b.file)))
      if (candidates.every((c) => held.has(c.id) || regionOf(c.id).file !== file)) overlay.set(file, p.files.get(file)!);
  };
  const waiting = roots.filter((id) => p.regions.some((r) => r.root === id && r.kind === "block" && r.pending && !generatedIds.has(r.id)));
  for (const rootId of waiting) {
    hold(rootId);
    for (const r of genBlocks.filter((b) => b.root === rootId)) diagnostics.push(err("OARC-W042", { id: r.id, detail: `waiting:${rootId}` }));
  }
  for (const rootId of roots.filter((id) => !waiting.includes(id))) {
    const mine = genBlocks.filter((b) => b.root === rootId);
    const res = await runSandbox(ports, req, p, rootId, overlay, undefined, mine.map((b) => b.id));
    if (res.error || res.failed.length || !res.complete) {
      const code = res.error?.startsWith("OARC-E092") ? "OARC-E092" : "OARC-E090"; // sandbox unavailable, as per block
      diagnostics.push(err(code, { id: rootId, detail: `joint:${res.error ?? res.failed.map((f) => f.name).join(",")}` }));
      if (!req.keepGoing) return [];
      hold(rootId);
      continue;
    }
    // Coverage (§8.10): every generated block must be reached by at least one passing example, else none is committed.
    const unreached = mine.filter((b) => !res.hits.has(b.id)).map((b) => b.id);
    if (unreached.length) {
      hold(rootId);
      for (const b of mine)
        if (!unreached.includes(b.id)) diagnostics.push(err("OARC-W042", { id: b.id, detail: `unreached:${unreached.join(",")}` }));
        else if (!diagnostics.some((d) => d.code === "OARC-W045" && d.id === b.id)) diagnostics.push(err("OARC-W045", { id: b.id, detail: `unreached:${rootId}` }));
    }
  }
  // code-first: the members of a class (a function alone otherwise) are verified jointly, every generated member in
  // place. Outcomes stuck on a region that is still pending are inconclusive; each generated member must be reached by
  // a passing test or example (W045), else the group is held back (W042), like sibling blocks.
  const cfGen = candidates.map((c) => regionOf(c.id)).filter((r) => r.kind === "function" && r.spec.codeFirst && hasChecks(r.spec));
  for (const group of new Set(cfGen.map((r) => r.spec.codeFirst!.group))) {
    const mine = cfGen.filter((r) => r.spec.codeFirst!.group === group);
    const holdGroup = () => mine.forEach((r) => (held.add(r.id), overlay.set(r.file, spliceRegion(overlay.get(r.file)!, r.id, r.bodyLines))));
    const res = await runSandbox(ports, req, p, mine[0]!.id, overlay, undefined, groupIds(p, mine[0]!), mine.map((r) => r.id));
    const real = res.failed.filter((o) => !isPendingOutcome(o));
    if (res.error || real.length || !res.complete) {
      const code = res.error?.startsWith("OARC-E092") ? "OARC-E092" : "OARC-E090";
      diagnostics.push(err(code, { id: mine[0]!.id, detail: `joint:${res.error ?? real.map((f) => f.name).join(",")}` }));
      if (!req.keepGoing) return [];
      holdGroup();
      continue;
    }
    const unreached = mine.filter((r) => !res.hits.has(r.id)).map((r) => r.id);
    if (unreached.length) {
      holdGroup();
      for (const r of mine)
        if (!unreached.includes(r.id)) diagnostics.push(err("OARC-W042", { id: r.id, detail: `unreached:${unreached.join(",")}` }));
        else if (!diagnostics.some((d) => d.code === "OARC-W045" && d.id === r.id)) diagnostics.push(err("OARC-W045", { id: r.id, detail: `unreached:${r.id}` }));
    }
  }
  if (p.sandboxDir) await ports.fs.remove(p.sandboxDir);

  const committed = new Set([...generatedIds].filter((id) => !held.has(id)));
  const files = new Map([...overlay].map(([rel, text]) => [rel, implicit.unscaffold(p, rel, text, committed)])); // code-first: pending bodies as written
  const manifest = nextManifest(p, files, committed, ports.now());
  const out: StagedFile[] = [];
  for (const [rel, lf] of files) {
    const text = toDisk(p, rel, lf);
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
  // A file saved while the model was working would be overwritten by text built from the parse-time snapshot: abort
  // instead, write nothing, and let the next run start from the saved file. (The lock keeps other openarc commands out.)
  const moved: string[] = [];
  for (const f of out) if ((await ports.fs.read(f.target)) !== (p.disk.get(f.target) ?? null)) moved.push(f.target);
  if (moved.length) {
    for (const file of moved) diagnostics.push(err("OARC-E096", { file }));
    return [];
  }
  out.push({ target: ".openarc/manifest.json", text: JSON.stringify(manifest, null, 2) + "\n" });
  for (const [i, f] of out.entries()) await ports.fs.write(`.openarc/txn/${txid}/stage/${i}`, f.text);
  return out;
}

/** The manifest STAGE writes: generated regions become compiler-owned, the rest keep or record their analyzed state. */
function nextManifest(p: Project, files: Map<string, string>, generated: Set<string>, now: string): Manifest {
  const manifest: Manifest = { schema: 1, regions: {} };
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
    const base = { kind: r.kind, parent: r.parent, file: r.file, ...(r.kind === "function" ? { symbol: r.spec.symbol } : {}), ...(r.spec.codeFirst ? { declaration: r.spec.codeFirst.declaration } : {}) };
    if (generated.has(r.id)) {
      manifest.regions[r.id] = { ...base, ownership: "compiler", hash, specHash: r.specHash, fingerprint: r.fingerprint, provenance: { ...p.provenance.get(r.id)!, at: now } };
    } else if (r.state === "compiler") {
      manifest.regions[r.id] = old!;
    } else if (r.state === "developer") {
      manifest.regions[r.id] = old
        ? { ...old, ownership: "developer", hash: r.hash }
        : { ...base, ownership: "developer", hash: r.hash, specHash: r.specHash, fingerprint: null, provenance: { source: "extracted", at: now } };
    } else if (old) manifest.regions[r.id] = { ...old, ownership: "conflicted" };
  }
  return manifest;
}

/** True when this run's ownership transitions (W060 -> developer, new developer/extracted regions, conflicts) are not yet
 *  in the manifest. compile.run commits a manifest-only transaction for them when there is nothing to generate.
 *  Removed entries don't count: those are OARC-E062 and need `openarc resolve --unlink`. */
export function manifestChanged(p: Project): boolean {
  const next = nextManifest(p, p.files, new Set(), "");
  return Object.entries(next.regions).some(([id, e]) => {
    const old = p.manifest.regions[id];
    return !old || canonicalJson(e as unknown as Json) !== canonicalJson(old as unknown as Json);
  });
}

// ───────────────────────────── EXTRACT (§10) ─────────────────────────────
// `openarc extract <file>`: adopt existing functions as developer-owned regions. Markers go around the declaration,
// a defineRegion spec (with a checker-derived `type <Name>Fn`) goes above it, and the body stays byte-for-byte,
// so nothing is regenerated until `openarc release <id>`.

export interface ExtractResult {
  files: StagedFile[]; // the rewritten source file, then the manifest; empty when nothing changed
  extracted: string[]; // new region ids
  skipped: string[]; // functions already inside a region (re-running is a no-op)
  refused: { name: string; reason: string }[];
}

const idSegment = (s: string) => {
  const c = s.replace(/[^A-Za-z0-9]+(.)?/g, (_m, ch: string | undefined) => (ch ? ch.toUpperCase() : "")).replace(/^[^A-Za-z]+/, "");
  return c ? c[0]!.toLowerCase() + c.slice(1) : "x";
};
/** Default id: `<file-stem>.<functionName>`, each segment normalised to the id grammar (§2.3). */
export const extractId = (rel: string, fn: string) => [...rel.split("/").at(-1)!.replace(/\.tsx?$/, "").split("."), fn].map(idSegment).join(".");

const SPEC_ID_RE = /\bdefine(?:Region|Block)\s*(?:<[^>]*>)?\s*\(\s*\{\s*id:\s*"([^"]+)"/g;
const tsErrors = (prog: ts.Program, sf: ts.SourceFile) =>
  [...prog.getSyntacticDiagnostics(sf), ...prog.getSemanticDiagnostics(sf)].filter((d) => d.category === ts.DiagnosticCategory.Error);
/** A type error's identity across a rewrite that moves lines: code and message, not position. */
const errorKey = (d: ts.Diagnostic) => `TS${d.code} ${ts.flattenDiagnosticMessageText(d.messageText, " ")}`;
/** The errors in `after` that `before` doesn't account for (multiset difference). */
function newErrors(before: string[], after: string[]): string[] {
  const left = [...before];
  return after.filter((k) => {
    const i = left.indexOf(k);
    if (i < 0) return true;
    left.splice(i, 1);
    return false;
  });
}

export async function extract(ports: Ports, req: CompileRequest, p: Project, rel: string, opts: { fn?: string; id?: string; style?: "code" | "region" }): Promise<ExtractResult> {
  const res: ExtractResult = { files: [], extracted: [], skipped: [], refused: [] };
  const refuse = (name: string, reason: string) => res.refused.push({ name, reason });
  const text = p.files.get(rel);
  if (!rel.startsWith("src/") || !rel.endsWith(".ts") || text === undefined) return refuse(rel, "not a .ts file under src/ (only src/ holds regions)"), res;
  if (opts.id && !opts.fn) return refuse(rel, "--id needs --function"), res;
  p.program = makeProgram(p, p.files);
  const checker = p.program.getTypeChecker();
  const sf = p.program.getSourceFile(abs(p, rel))!;
  const errorsBefore = tsErrors(p.program, sf).map(errorKey);
  const scan = scanMarkers(text);
  const tree = buildRegionTree(scan.markers);
  if (scan.diagnostics.length || tree.diagnostics.length) return refuse(rel, `fix its markers first (${[...scan.diagnostics, ...tree.diagnostics].map((d) => d.code).join(", ")})`), res;
  const flat = (ns: typeof tree.roots): typeof tree.roots => ns.flatMap((n) => [n, ...flat(n.children)]);
  const regions = flat(tree.roots);
  const usedIds = new Set([...srcFiles(p).flatMap(([, t]) => [...t.matchAll(SPEC_ID_RE)].map((m) => m[1]!)), ...Object.keys(p.manifest.regions)]);
  const bound = fileBindings(text);
  const hasMod = (st: ts.Statement, k: ts.SyntaxKind) => ts.canHaveModifiers(st) && (ts.getModifiers(st)?.some((m) => m.kind === k) ?? false);
  const listed = new Set(sf.statements.filter(ts.isExportDeclaration).filter((d) => !d.moduleSpecifier && d.exportClause && ts.isNamedExports(d.exportClause))
    .flatMap((d) => (d.exportClause as ts.NamedExports).elements.map((e) => (e.propertyName ?? e.name).text)));
  const lineOf = (pos: number) => sf.getLineAndCharacterOfPosition(pos).line; // 0-based
  const lines = linesOf(text);

  // Top-level function declarations and `const f = (...) => ...` / `= function (...) {...}`, grouped by name (overloads).
  const byName = new Map<string, (ts.FunctionDeclaration | ts.VariableStatement)[]>();
  for (const st of sf.statements) {
    let name: string | undefined;
    if (ts.isFunctionDeclaration(st)) {
      if (!st.name) {
        if (!opts.fn) refuse("default", "default-exported anonymous function: give it a name first");
        continue;
      }
      name = st.name.text;
    } else if (ts.isVariableStatement(st) && st.declarationList.declarations.length === 1) {
      const d = st.declarationList.declarations[0]!;
      if (ts.isIdentifier(d.name) && d.initializer && (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer))) name = d.name.text;
    } else if (ts.isExportAssignment(st) && !st.isExportEquals && (ts.isArrowFunction(st.expression) || ts.isFunctionExpression(st.expression)) && !opts.fn) {
      refuse("default", "default-exported anonymous function: give it a name first");
    }
    if (name !== undefined) byName.set(name, [...(byName.get(name) ?? []), st as ts.FunctionDeclaration | ts.VariableStatement]);
  }
  if (opts.fn && !byName.has(opts.fn)) {
    const isMethod = sf.statements.some((st) => ts.isClassDeclaration(st) && st.members.some((m) =>
      (ts.isMethodDeclaration(m) || ts.isGetAccessor(m) || ts.isSetAccessor(m)) && m.name && ts.isIdentifier(m.name) && (m.name.text === opts.fn || `${st.name?.text}.${m.name.text}` === opts.fn)));
    refuse(opts.fn, isMethod ? "class method: regions are top-level functions (§3.2); move it out of the class first" : "no top-level function with that name");
  }

  const inserts: { from: number; to: number; specAt: number; id: string; spec: string[]; apply?: (ls: string[]) => void }[] = [];
  for (const [name, decls] of byName) {
    const exported = decls.some((st) => hasMod(st, ts.SyntaxKind.ExportKeyword)) || listed.has(name);
    if (opts.fn ? name !== opts.fn : !exported) continue;
    if (decls.length > 1) {
      refuse(name, "overloaded function: a region holds one declaration with one call signature");
      continue;
    }
    const st = decls[0]!;
    if (hasMod(st, ts.SyntaxKind.DefaultKeyword)) {
      refuse(name, "default export: a regenerated region is a named `export const`, which would drop the default export");
      continue;
    }
    const fnNode = ts.isFunctionDeclaration(st) ? st : (st.declarationList.declarations[0]!.initializer as ts.ArrowFunction | ts.FunctionExpression);
    const nameNode = ts.isFunctionDeclaration(st) ? st.name! : (st.declarationList.declarations[0]!.name as ts.Identifier);
    const start = st.getStart(sf), from = lineOf(start), to = lineOf(st.getEnd());
    if (regions.some((n) => n.beginLine < from + 1 && to + 1 < n.endLine)) {
      res.skipped.push(name);
      continue;
    }
    const sigs = checker.getTypeAtLocation(nameNode).getCallSignatures();
    if (sigs.length !== 1) {
      refuse(name, "overloaded function: a region holds one declaration with one call signature");
      continue;
    }
    if (opts.style === "code") { // code-first (§3.8): markers inside the body, `@arc id` in the JSDoc; generics are fine
      const body = fnNode.body;
      const block = body && ts.isBlock(body) ? body : null;
      const open = block ? lineOf(block.getStart(sf)) : -1, close = block ? lineOf(block.end - 1) : -1;
      if (!block || open === close || lines[open]!.slice(sf.getLineAndCharacterOfPosition(block.getStart(sf)).character + 1).trim() || lines[close]!.slice(0, sf.getLineAndCharacterOfPosition(block.end - 1).character).trim()) {
        refuse(name, "the body must be a block whose braces end and start their own lines (or use --style region)");
        continue;
      }
      // the signature is the contract: without a return type (on the function or its const) a regenerated body would set it
      if (!fnNode.type && !(ts.isVariableStatement(st) && st.declarationList.declarations[0]!.type)) {
        refuse(name, "no explicit return type: the signature is the region's contract, so annotate it (or the const's type) first");
        continue;
      }
      const id = opts.id ?? implicit.derivedId(rel, text, { name });
      if (!isValidId(id) || usedIds.has(id)) {
        refuse(name, isValidId(id) ? `id "${id}" is already used; pass --function ${name} --id <id>` : `invalid id "${id}" (segments are [a-z][a-zA-Z0-9]*)`);
        continue;
      }
      const ind = /^\s*/.exec(lines[from]!)![0];
      const jd = ts.getJSDocCommentsAndTags(st).filter(ts.isJSDoc).at(-1);
      inserts.push({
        from, to, id, specAt: 0, spec: [], apply: (ls) => { // bottom-up: the end marker, the begin marker, then the JSDoc above
          ls.splice(close, 0, `${ind}  // @openarc:end ${id}`);
          ls.splice(open + 1, 0, `${ind}  // @openarc:begin ${id}`);
          if (!jd) return void ls.splice(from, 0, `${ind}/** @arc id ${id} */`);
          const j0 = lineOf(jd.getStart(sf)), j1 = lineOf(jd.end);
          if (j0 !== j1) return void ls.splice(j1, 0, `${ind} * @arc id ${id}`);
          const t = jd.getText(sf);
          ls.splice(j0, 1, ...ls[j0]!.replace(t, `/**\n${ind} * ${t.slice(3, -2).trim()}\n${ind} * @arc id ${id}\n${ind} */`).split("\n"));
        },
      });
      usedIds.add(id);
      continue;
    }
    if (fnNode.typeParameters?.length || sigs[0]!.typeParameters?.length) {
      refuse(name, "generic function: its type parameters can't be expressed in the non-generic alias defineRegion<F> needs");
      continue;
    }
    if (lines[from]!.slice(0, sf.getLineAndCharacterOfPosition(start).character).trim() || !/^\s*(\/\/.*)?$/.test(lines[to]!.slice(sf.getLineAndCharacterOfPosition(st.getEnd()).character))) {
      refuse(name, "the declaration shares a line with other code; markers need whole lines");
      continue;
    }
    const id = opts.id ?? extractId(rel, name);
    if (!isValidId(id)) {
      refuse(name, `invalid id "${id}" (segments are [a-z][a-zA-Z0-9]*)`);
      continue;
    }
    if (usedIds.has(id)) {
      refuse(name, `id "${id}" is already used; pass --function ${name} --id <id>`);
      continue;
    }
    const alias = `${name[0]!.toUpperCase()}${name.slice(1)}Fn`;
    const specName = `${name}Spec`;
    if (bound.has(specName) || new RegExp(`\\b(type|interface|class|enum)\\s+${alias.replace(/\$/g, "\\$")}\\b`).test(text)) {
      refuse(name, `${alias} or ${specName} is already declared in the file`);
      continue;
    }
    const sig = checker.signatureToString(sigs[0]!, st, ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.WriteArrowStyleSignature);
    const doc = ts.getJSDocCommentsAndTags(st).filter(ts.isJSDoc).map((d) => ts.getTextOfJSDocComment(d.comment) ?? "").join("\n");
    const first = doc.split("\n").map((l) => l.trim()).find(Boolean) ?? "TODO describe";
    const ind = /^\s*/.exec(lines[from]!)![0];
    inserts.push({
      from, to, id,
      specAt: lineOf(st.getStart(sf, true)), // above the JSDoc, which stays attached to the function and outside the markers
      spec: [
        `type ${alias} = ${sig};`,
        "",
        `export const ${specName} = arc.defineRegion<${alias}>({`,
        `  id: ${JSON.stringify(id)},`,
        ...(id.split(".").at(-1) === name ? [] : [`  symbol: ${JSON.stringify(name)},`]),
        `  intent: [${JSON.stringify(`[inferred] ${first}`)}],`,
        "  examples: [],",
        "});",
        "",
      ].map((l) => (l ? ind + l : l)),
    });
    usedIds.add(id);
  }
  if (!inserts.length) return res;
  const classic = inserts.some((i) => !i.apply);
  if (classic && bound.has("arc") && !/import \* as arc from "open-arc"/.test(text)) return refuse(rel, "the name `arc` is already bound; specs need `import * as arc from \"open-arc\"`"), res;

  for (const ins of inserts.sort((a, b) => b.from - a.from)) {
    if (ins.apply) {
      ins.apply(lines);
      continue;
    }
    const ind = /^\s*/.exec(lines[ins.from]!)![0];
    lines.splice(ins.to + 1, 0, `${ind}// @openarc:end ${ins.id}`);
    lines.splice(ins.from, 0, `${ind}// @openarc:begin ${ins.id}`);
    lines.splice(ins.specAt, 0, ...ins.spec);
  }
  if (classic && !/import \* as arc from "open-arc"/.test(text)) lines.splice(lines[0]?.startsWith("#!") ? 1 : 0, 0, 'import * as arc from "open-arc";');
  const out = lines.join("\n");

  // The result must type-check no worse than before, and analyze as developer-owned function regions.
  p.files.set(rel, out);
  p.program = makeProgram(p, p.files, p.program);
  const added = newErrors(errorsBefore, tsErrors(p.program, p.program.getSourceFile(abs(p, rel))!).map(errorKey));
  const ds: Diagnostic[] = [];
  if (!added.length) {
    p.specs.clear();
    p.regions = [];
    await analyze(ports, req, p, ds, { offline: true });
  }
  const bad = ds.filter((d) => d.code.startsWith("OARC-E") && d.file === rel);
  if (added.length || bad.length) {
    p.files.set(rel, text);
    const why = added.length ? added[0]! : bad.map((d) => `${d.code}${d.id ? ` ${d.id}` : ""}`).join(", ");
    return refuse(rel, `the extracted file would not check: ${why}`), res;
  }
  const manifest: Manifest = JSON.parse(JSON.stringify(p.manifest));
  for (const { id } of [...inserts].reverse()) {
    const r = p.regions.find((x) => x.id === id)!;
    manifest.regions[id] = {
      kind: "function", parent: null, file: rel, symbol: r.spec.symbol, ...(r.spec.codeFirst ? { declaration: r.spec.codeFirst.declaration } : {}), ownership: "developer",
      hash: r.hash, specHash: r.specHash, fingerprint: null, provenance: { source: "extracted", at: ports.now() },
    };
    res.extracted.push(id);
  }
  res.files = [{ target: rel, text: toDisk(p, rel, out) }, { target: ".openarc/manifest.json", text: JSON.stringify(manifest, null, 2) + "\n" }];
  return res;
}

// ───────────────────────────── CHECK --oracle ─────────────────────────────
// `openarc check <id> --oracle <module>#<export>`: differential testing against an existing implementation (the
// "port" use case). Inputs are the region's example args plus deterministic variations of them; both functions run on
// each input in the sandbox (core/harness.ts runOracle) and every disagreement is reported.

/** mulberry32: a tiny deterministic PRNG, so a check is reproducible from its seed. */
function prng(seed: number): () => number {
  let x = seed >>> 0;
  return () => {
    x = (x + 0x6d2b79f5) >>> 0;
    let t = Math.imul(x ^ (x >>> 15), x | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Only numbers, strings, booleans and arrays/objects of those can be varied (no null, no fakes). */
const variable = (v: Json): boolean =>
  v !== null && (typeof v !== "object" || (Array.isArray(v) ? v.every(variable) : !("$fake" in v) && Object.values(v).every(variable)));

/** The examples' argument lists (those with only supported values) followed by seeded variations, deduplicated, at most `count`.
 *  ponytail: shape-preserving mutation, no type-directed generation. A top-level array arg changes length only when the
 *  examples show different lengths there (so tuples like [x, y] stay tuples); strings are sometimes swapped for another
 *  example's string at the same position (enum-like values), otherwise edited. */
export function oracleInputs(examples: Json[], count = 60, seed = 1): Json[][] {
  const rand = prng(seed);
  const pick = <T>(xs: T[]): T => xs[Math.floor(rand() * xs.length)]!;
  const bases = examples.map((e) => (e as { args?: Json[] }).args ?? []).filter((a) => Array.isArray(a) && a.every(variable));
  if (!bases.length) return [];
  const strings = (i: number) => bases.map((a) => a[i]).filter((v): v is string => typeof v === "string");
  const lengths = (i: number) => new Set(bases.map((a) => a[i]).filter(Array.isArray).map((a) => a.length));
  const mutate = (v: Json, pool: string[], resize: boolean): Json => {
    if (typeof v === "boolean") return rand() < 0.5 ? !v : v;
    if (typeof v === "number") {
      const int = Number.isInteger(v);
      const r = (rand() * 2 - 1) * Math.max(10, Math.abs(v) * 2);
      return pick([0, -v, v + (int ? pick([-1, 1]) : rand() - 0.5), int ? Math.round(r) : r, v]);
    }
    if (typeof v === "string") {
      if (v.startsWith("$")) return v; // a value token
      if (pool.length > 1 && rand() < 0.4) return pick(pool);
      const i = Math.floor(rand() * (v.length + 1));
      const ch = pick([...new Set([...v, "a", "Z", " ", "0", "-", "é", "/"])]);
      return pick([v.slice(0, i) + ch + v.slice(i), v.slice(0, i) + v.slice(i + 1), "", v.toUpperCase(), v + v]);
    }
    if (Array.isArray(v)) {
      let out = v.map((x) => (rand() < 0.5 ? mutate(x, [], false) : x));
      if (resize && out.length && rand() < 0.3) out.splice(Math.floor(rand() * out.length), 1);
      if (resize && v.length && rand() < 0.3) out.push(mutate(pick(v), [], false));
      if (resize && rand() < 0.05) out = [];
      return out;
    }
    if (v === null) return v;
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, rand() < 0.5 ? mutate(x, [], false) : x]));
  };
  const seen = new Set<string>();
  const out: Json[][] = [];
  const add = (a: Json[]) => {
    const key = canonicalJson(a);
    if (!seen.has(key) && out.length < count) seen.add(key), out.push(a);
  };
  bases.forEach(add);
  for (let i = 0; out.length < count && i < count * 20; i++) {
    const base = bases[i % bases.length]!;
    add(base.map((v, k) => (rand() < 0.6 ? mutate(v, strings(k), lengths(k).size > 1) : v)));
  }
  return out;
}

export interface OracleReport {
  inputs: number;
  agreed: number;
  disagreements: { name: string; actual?: Json }[]; // actual: {args, got, oracle}
  error?: string;
}

/** Run region `id` and `<module>#<export>` on the same inputs in the sandbox. `p` must be analyzed (offline is enough). */
export async function oracleCheck(ports: Ports, req: CompileRequest, p: Project, id: string, oracle: string, opts: { count?: number; seed?: number } = {}): Promise<OracleReport> {
  const fail = (error: string): OracleReport => ({ inputs: 0, agreed: 0, disagreements: [], error });
  const r = p.regions.find((x) => x.id === id);
  if (!r || r.kind !== "function") return fail(`no function region ${id}`);
  if (r.pending) return fail(`${id} is not implemented yet (compile it first)`);
  const m = /^(.+)#([A-Za-z_$][\w$]*)$/.exec(oracle);
  if (!m) return fail(`--oracle must be <module>#<export>, e.g. legacy/core.js#fitLine`);
  const module = posix.normalize(m[1]!);
  if (module.startsWith("/") || module.startsWith("..")) return fail(`the oracle module must be inside the project (the sandbox only sees the project): ${m[1]}`);
  const text = await ports.fs.read(module);
  if (text === null) return fail(`cannot read ${module}`);
  const inputs = oracleInputs(r.spec.examples, opts.count ?? 60, opts.seed ?? 1);
  if (!inputs.length) return fail("no example has only number/string/boolean/array/object arguments to vary");
  const overlay = new Map(p.files).set(module, text);
  try {
    const res = await runSandbox(ports, req, p, id, overlay, { module, export: m[2]!, inputs });
    if (res.error) return fail(res.error);
    if (!res.complete) return { inputs: inputs.length, agreed: res.passed, disagreements: res.failed, error: "harness output incomplete (process exited early?)" };
    return { inputs: inputs.length, agreed: res.passed, disagreements: res.failed };
  } finally {
    if (p.sandboxDir) await ports.fs.remove(p.sandboxDir);
  }
}

/** One line per disagreement, values printed faithfully. */
export const showDisagreement = (d: { name: string; actual?: Json }): string => {
  const a = (d.actual ?? {}) as { args?: Json; got?: Json; oracle?: Json };
  return `${d.name} args ${showValue(a.args)}: got ${showValue(a.got)}; oracle ${showValue(a.oracle)}`;
};
