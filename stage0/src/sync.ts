// `openarc adopt` and `openarc sync`: the spec sheet and the TypeScript kept in step. Hand-written.
// The rule of the design is that a save costs no agent turn: everything here runs without a model unless the code can't
// answer. Examples come from running the body, drift from re-running them, and a model is asked only for what is left,
// through the backends the project configured, once per body. TypeScript stays the source of truth: the sheet is a
// view, three-way merged against .openarc/sheet-state.json, and every spec write goes to JSDoc, arc.configure or
// defineRegion under the usual rules (ownership, fingerprints, transactions, backups).
import ts from "typescript";
import type { Json } from "open-arc";
import type { CompileRequest, CompileResult, Diagnostic, Ports } from "./types.ts";
import * as engine from "./engine.ts";
import { complete } from "./backends.ts";
import { commit, planJournal } from "./txn.ts";
import { SHEET_FILE, exampleLine, parseSheet, readExample, renderSheet, type Sheet, type SheetRegion, type Suggestion } from "./sheet.ts";

const STATE_FILE = ".openarc/sheet-state.json";
const STATUS_FILE = ".openarc/sync-status.json";
const USAGE_FILE = ".openarc/usage.jsonl";
const MANIFEST = ".openarc/manifest.json";
const DEFAULT_SUGGEST_LINES = 8;

interface BaseRegion { intent: string; examples: string; hash: string; lines: string[]; described?: string }
interface SyncState { regions: Record<string, BaseRegion>; fileHashes: Record<string, string>; notAdopted: string[] }
export interface SyncStatus {
  regions: number;
  applied: string[]; // sheet edits written to the code
  pulled: string[]; // code edits written to the sheet
  compiled: string[];
  modelCalls: number;
  attention: { id: string; what: string }[];
  suggestions: number;
  hostedTokensToday: number;
  localTokensToday: number;
  error?: string;
}
export interface SyncCtx {
  ports: Ports;
  root: string;
  request: (project: { config: engine.Project["config"] } | null, ids: string[]) => CompileRequest;
  run: (ports: Ports, req: CompileRequest) => Promise<CompileResult>;
  noModel?: boolean;
  log?: (line: string) => void;
}

// ───────────────────────────── reading the project ─────────────────────────────

async function analyzed(ctx: SyncCtx, diagnostics: Diagnostic[] = []): Promise<engine.Project> {
  const p = await engine.parse(ctx.ports, ctx.request(null, []), diagnostics);
  await engine.analyze(ctx.ports, ctx.request(p, []), p, diagnostics, { offline: true });
  return p;
}
const functions = (p: engine.Project) => p.regions.filter((r) => r.kind === "function" && !r.parent);
const isMethod = (r: engine.RegionInfo) => !!r.spec.codeFirst?.cls;
const hasTests = (p: engine.Project, id: string) => (p.tests ?? []).some((t) => t.regions.includes(id));
const examplesKey = (xs: Json[]) => xs.map(exampleLine).join("\n");

/** The JSDoc description only: tags stay in the code, and an inherited JSDoc isn't this declaration's to edit. */
function intentOf(p: engine.Project, r: engine.RegionInfo): string {
  if (!r.spec.codeFirst) return r.spec.intent.trim();
  const sf = ts.createSourceFile("x.ts", p.files.get(r.file) ?? "", ts.ScriptTarget.Latest, true);
  const doc = docOf(hostOf(sf, r.id, r.spec.symbol));
  return doc ? String(ts.getTextOfJSDocComment(doc.comment) ?? "").trim() : "";
}

/** A declaration's statement or class member: by its markers once committed, by name while pending. */
function hostOf(sf: ts.SourceFile, id: string, symbol: string): ts.Node | null {
  const at = sf.text.indexOf(`// @openarc:begin ${id}\n`);
  const name = symbol.split(".").at(-1);
  let found: ts.Node | null = null;
  const visit = (n: ts.Node) => {
    if (ts.isFunctionLike(n) && ((at >= 0 && n.pos <= at && at < n.end) || (at < 0 && (n as ts.FunctionLikeDeclaration).name?.getText(sf) === name)) ) found = n;
    if (at < 0 && ts.isVariableDeclaration(n) && n.name.getText(sf) === name) found = n;
    ts.forEachChild(n, visit);
  };
  visit(sf);
  let h = found as ts.Node | null;
  while (h && !ts.isStatement(h) && !ts.isClassElement(h) && h.parent) h = h.parent;
  return h;
}
const docOf = (h: ts.Node | null): ts.JSDoc | undefined => (h as unknown as { jsDoc?: ts.JSDoc[] } | null)?.jsDoc?.at(-1);

// ───────────────────────────── writing specs into the source ─────────────────────────────

const splice = (t: string, from: number, to: number, s: string) => t.slice(0, from) + s + t.slice(to);
const indentAt = (t: string, pos: number) => /[ \t]*$/.exec(t.slice(t.lastIndexOf("\n", pos - 1) + 1, pos))![0];
const jsonLit = (v: Json) => JSON.stringify(v);

/** Replace a code-first declaration's JSDoc description, keeping its tags. */
export function setDocIntent(text: string, id: string, symbol: string, intent: string): string {
  const sf = ts.createSourceFile("x.ts", text, ts.ScriptTarget.Latest, true);
  const h = hostOf(sf, id, symbol);
  if (!h) throw new Error(`no declaration for ${id}`);
  const doc = docOf(h);
  const start = doc ? doc.getStart(sf) : h.getStart(sf);
  const ind = indentAt(text, start);
  const tags = (doc?.tags ?? []).map((g) => g.getText(sf).replace(/\s*\*?\s*$/, ""));
  const lines = [...intent.split("\n"), ...tags];
  const block = lines.length === 1 ? `/** ${lines[0]} */` : `/**\n${lines.map((l) => `${ind} * ${l}`.trimEnd()).join("\n")}\n${ind} */`;
  return doc ? splice(text, start, doc.end, block) : splice(text, start, start, `${block}\n${ind}`);
}

/** Set one property of an object literal, preserving the others. */
function setProp(text: string, obj: ts.ObjectLiteralExpression, sf: ts.SourceFile, key: string, value: string): string {
  const prop = obj.properties.find((x) => x.name?.getText(sf) === key);
  if (prop) return splice(text, prop.getStart(sf), prop.getEnd(), `${key}: ${value}`);
  const at = obj.getStart(sf) + 1;
  return splice(text, at, at, ` ${key}: ${value},`);
}
function dropProp(text: string, obj: ts.ObjectLiteralExpression, sf: ts.SourceFile, key: string): string {
  const prop = obj.properties.find((x) => x.name?.getText(sf) === key);
  if (!prop) return text;
  const end = text[prop.getEnd()] === "," ? prop.getEnd() + 1 : prop.getEnd();
  return splice(text, prop.getFullStart(), end, "");
}

/** A defineRegion statement's literal, found by its id. */
function regionLiteral(sf: ts.SourceFile, id: string): ts.ObjectLiteralExpression | null {
  let out: ts.ObjectLiteralExpression | null = null;
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n) && /\.defineRegion$/.test(n.expression.getText(sf)) && ts.isObjectLiteralExpression(n.arguments[0]!)) {
      const o = n.arguments[0];
      const idProp = o.properties.find((x) => x.name?.getText(sf) === "id");
      if (idProp && ts.isPropertyAssignment(idProp) && ts.isStringLiteralLike(idProp.initializer) && idProp.initializer.text === id) out = o;
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

const companionOf = (file: string) => file.replace(/\.ts$/, ".arc.ts");
const moduleSpec = (from: string, to: string, tsExt: boolean) => {
  const a = from.split("/").slice(0, -1), b = to.split("/");
  while (a.length && b.length > 1 && a[0] === b[0]) a.shift(), b.shift();
  const path = [...a.map(() => ".."), ...b].join("/").replace(/\.ts$/, tsExt ? ".ts" : ".js");
  return path.startsWith(".") ? path : `./${path}`;
};

/** Write a code-first function's examples: an existing arc.configure keeps its place, a new one goes in `src/x.arc.ts`,
 *  which nothing imports, so the program itself never gains a runtime dependency on open-arc. */
function setConfigureExamples(files: Map<string, string>, rel: string, symbol: string, examples: Json[], tsExt: boolean): void {
  const comp = companionOf(rel);
  for (const f of [rel, comp]) {
    const text = files.get(f);
    if (text === undefined) continue;
    const sf = ts.createSourceFile(f, text, ts.ScriptTarget.Latest, true);
    for (const st of sf.statements) {
      if (!ts.isExpressionStatement(st) || !ts.isCallExpression(st.expression) || st.expression.expression.getText(sf) !== "arc.configure") continue;
      const [target, cfg] = st.expression.arguments;
      if (target?.getText(sf) !== symbol || !cfg || !ts.isObjectLiteralExpression(cfg)) continue;
      files.set(f, examples.length ? setProp(text, cfg, sf, "examples", jsonLit(examples)) : dropProp(text, cfg, sf, "examples"));
      return;
    }
  }
  if (!examples.length) return;
  const name = symbol.split(".").at(-1)!;
  const spec = moduleSpec(comp, rel, tsExt);
  let text = files.get(comp) ?? `// Generated by openarc sync: this file's examples are the spec. Nothing imports it.\nimport * as arc from "open-arc";\n`;
  const importLine = `import { ${name} } from "${spec}";`;
  const statement = `arc.configure(${name}, { examples: ${jsonLit(examples)} });\n`;
  const lastImport = [...text.matchAll(/^import .*$/gm)].at(-1)!;
  const at = lastImport.index + lastImport[0].length + 1;
  text = splice(text, at, at, `${importLine}\n`);
  files.set(comp, `${text.trimEnd()}\n\n${statement}`);
}

/** Apply one region's edited intent and examples to the files map. */
function writeSpec(files: Map<string, string>, r: engine.RegionInfo, edit: { intent?: string; examples?: Json[] }, tsExt: boolean): void {
  if (r.spec.codeFirst) {
    if (edit.intent !== undefined) files.set(r.file, setDocIntent(files.get(r.file)!, r.id, r.spec.symbol, edit.intent));
    if (edit.examples !== undefined) setConfigureExamples(files, r.file, r.spec.symbol, edit.examples, tsExt);
    return;
  }
  const rel = r.spec.file;
  for (const [key, value] of [["intent", edit.intent], ["examples", edit.examples]] as const) {
    if (value === undefined) continue;
    const text = files.get(rel)!;
    const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true);
    const lit = regionLiteral(sf, r.id);
    if (!lit) throw new Error(`no defineRegion for ${r.id}`);
    files.set(rel, setProp(text, lit, sf, key, jsonLit(value as Json)));
  }
}

/** A new sheet section: a pending code-first function at the end of its file. */
function addFunction(files: Map<string, string>, s: SheetRegion, tsExt: boolean): string | null {
  const m = /^([A-Za-z_$][\w$]*)\s*(<.*>)?\(.*\)\s*:\s*\S/.exec(s.signature);
  if (!m) return `the signature must look like name(a: T): R`;
  if (!s.file || !s.file.startsWith("src/") || !s.file.endsWith(".ts")) return `a new section needs <!-- file: src/x.ts -->`;
  let text = files.get(s.file) ?? "";
  if (!/import \* as arc from "open-arc"/.test(text)) text = `import * as arc from "open-arc";\n${text}`;
  const doc = [...s.intent.split("\n").filter(Boolean), `@arc id ${s.id}`].map((l) => ` * ${l}`).join("\n");
  files.set(s.file, `${text.trimEnd()}\n\n/**\n${doc}\n */\nexport function ${s.signature} {\n  return arc.todo();\n}\n`);
  setConfigureExamples(files, s.file, m[1]!, s.examples, tsExt);
  return null;
}

async function commitFiles(ctx: SyncCtx, changed: Map<string, string>): Promise<void> {
  const list = [...changed];
  if (!list.length) return;
  const txid = ctx.ports.newTxId();
  for (const [i, [, t]] of list.entries()) await ctx.ports.fs.write(`.openarc/txn/${txid}/stage/${i}`, t);
  await commit(ctx.ports.fs, planJournal(txid, list.map(([target], i) => ({ target, staged: `.openarc/txn/${txid}/stage/${i}` }))));
}

// ───────────────────────────── examples from the code, no model ─────────────────────────────

/** Argument values a type allows, tamest first; null when the type can't be built as JSON (a port, a class, a function). */
export function valuesOf(checker: ts.TypeChecker, t: ts.Type, depth = 0): Json[] | null {
  if (depth > 3) return null;
  if (t.isUnion()) {
    const parts = t.types.filter((x) => !(x.flags & ts.TypeFlags.Undefined)).map((x) => valuesOf(checker, x, depth));
    if (parts.some((x) => x === null)) return null;
    return [...new Map((parts as Json[][]).flat().map((v) => [JSON.stringify(v), v])).values()].slice(0, 6);
  }
  if (t.isStringLiteral() || t.isNumberLiteral()) return [t.value];
  const f = t.flags;
  if (f & ts.TypeFlags.BooleanLiteral) return [checker.typeToString(t) === "true"];
  if (f & ts.TypeFlags.String) return ["", "a", "Hello World"];
  if (f & ts.TypeFlags.Number) return [0, 1, -1, 42];
  if (f & ts.TypeFlags.Boolean) return [true, false];
  if (f & ts.TypeFlags.Null) return [null];
  if (checker.isArrayType(t)) {
    const item = valuesOf(checker, checker.getTypeArguments(t as ts.TypeReference)[0]!, depth + 1);
    return item && [[], [item[0]!], item.slice(0, 3)];
  }
  if (checker.isTupleType(t)) {
    const items = checker.getTypeArguments(t as ts.TypeReference).map((x) => valuesOf(checker, x, depth + 1));
    return items.some((x) => !x) ? null : [items.map((x) => x![0]!)];
  }
  if (f & ts.TypeFlags.Object && !t.getCallSignatures().length && !(t.symbol?.flags & ts.SymbolFlags.Class)) {
    const out: Record<string, Json> = {};
    for (const s of t.getProperties()) {
      if (s.flags & ts.SymbolFlags.Optional) continue;
      const decl = s.valueDeclaration ?? s.declarations?.[0];
      if (!decl) return null;
      if (ts.isMethodSignature(decl) || ts.isMethodDeclaration(decl)) return null; // a port: nothing to characterize with
      const v = valuesOf(checker, checker.getTypeOfSymbolAtLocation(s, decl), depth + 1);
      if (!v) return null;
      out[s.name] = v[0]!;
    }
    return [out];
  }
  return null;
}

/** Rotations of every parameter's values (so parameters differ from each other: clamp(0, 0, 0) says nothing), then one
 *  parameter varied at a time; at most `cap` lists, deduplicated. */
export function inputsFor(params: (Json[] | null)[], cap = 12): Json[][] | null {
  if (params.some((p) => !p || !p.length)) return null;
  const longest = Math.max(1, ...params.map((p) => p!.length));
  const out = new Map<string, Json[]>();
  const add = (a: Json[]) => out.set(JSON.stringify(a), a);
  for (let t = 0; t < longest; t++) add(params.map((p, i) => p![(t + i) % p!.length]!));
  const base = params.map((p) => p![0]!);
  params.forEach((p, i) => p!.slice(1).forEach((v) => add(base.map((x, j) => (j === i ? v : x)))));
  return [...out.values()].slice(0, cap);
}

function deriveInputs(p: engine.Project, r: engine.RegionInfo): Json[][] | null {
  const checker = p.program?.getTypeChecker();
  if (!checker) return null;
  const sig = r.spec.codeFirst
    ? checker.getSignatureFromDeclaration(r.spec.codeFirst.decl)
    : r.spec.typeNode && checker.getTypeFromTypeNode(r.spec.typeNode).getCallSignatures()[0];
  if (!sig || sig.typeParameters?.length) return null;
  const at = r.spec.codeFirst?.decl ?? r.spec.typeNode!;
  return inputsFor(sig.parameters.map((s) => valuesOf(checker, checker.getTypeOfSymbolAtLocation(s, at))));
}

/** Examples the current body satisfies, by running it twice: a throwing or unrepeatable input is dropped, not guessed at. */
async function characterize(ctx: SyncCtx, p: engine.Project, r: engine.RegionInfo, inputs: Json[][]): Promise<Json[] | { error: string }> {
  const req = ctx.request(p, []);
  const a = await engine.observe(ctx.ports, req, p, r.id, inputs);
  if ("error" in a) return a;
  const b = await engine.observe(ctx.ports, req, p, r.id, inputs);
  if ("error" in b) return b;
  const usable = a.filter((x, i) => {
    const key = JSON.stringify(x.got);
    return key !== undefined && !isThrown(x.got) && key === JSON.stringify(b[i]?.got);
  });
  // Different results first: they say the most. Then repeats, so a function with few results still has a few examples.
  const seen = new Set<string>();
  const distinct = usable.filter((x) => { const k = JSON.stringify(x.got); return !seen.has(k) && !!seen.add(k); });
  return [...distinct, ...usable.filter((x) => !distinct.includes(x))].slice(0, 5).map((x) => ({ args: x.args, expected: x.got }));
}
const isThrown = (v: Json) => v !== null && typeof v === "object" && !Array.isArray(v) && "throws" in v && Object.keys(v).length === 1;

// ───────────────────────────── the model, only for what's left ─────────────────────────────

const DESCRIBE_SYSTEM = `You describe one TypeScript function for its spec. Reply with one JSON object and nothing else: {"intent": "<one or two plain sentences: what it does and its edge cases, not how>", "inputs": [<up to 5 argument lists, each a JSON array, including an edge case; [] if the arguments can't be JSON>]}.`;
const SUGGEST_SYSTEM = `A function's body changed. Reply with one JSON object and nothing else: {"intent": "<its intent, updated in one or two plain sentences; keep the old wording where it still holds>"}.`;

async function askJson(ctx: SyncCtx, p: engine.Project, system: string, user: string): Promise<Record<string, Json> | null> {
  if (ctx.noModel) return null;
  const c = p.config;
  const backend = c.backends[c.compilation.defaultBackend]!;
  if (await engine.backendProblem(ctx.ports, c).catch(() => "down")) return null;
  try {
    const raw = await complete(ctx.ports, { ...backend, outputFormat: "code", outputReserveTokens: 400 }, system, user, process.env, 0);
    const m = /\{[\s\S]*\}/.exec(raw);
    return m ? (JSON.parse(m[0]) as Record<string, Json>) : null;
  } catch {
    return null;
  }
}
const bodyOf = (r: engine.RegionInfo) => r.bodyLines.join("\n").slice(0, 6000); // ponytail: a longer body is described from its head

// ───────────────────────────── usage ─────────────────────────────

async function usageToday(ctx: SyncCtx): Promise<{ hosted: number; local: number }> {
  const day = ctx.ports.now().slice(0, 10);
  const out = { hosted: 0, local: 0 };
  for (const l of ((await ctx.ports.fs.read(USAGE_FILE)) ?? "").split("\n")) {
    if (!l.startsWith(`{"at":"${day}`)) continue;
    try {
      const u = JSON.parse(l) as { hosted: boolean; prompt: number; completion: number };
      out[u.hosted ? "hosted" : "local"] += u.prompt + u.completion;
    } catch {
      // a line cut by a crash: not worth failing a sync for
    }
  }
  return out;
}
const isHosted = (p: engine.Project, id: string) => {
  const b = p.config.backends[p.config.regions?.[id]?.backend ?? p.config.compilation.defaultBackend]!;
  return b.provider === "cli" || !/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])/.test(b.baseUrl ?? b.host ?? (b.provider === "ollama" ? "http://localhost" : "https://hosted"));
};

// ───────────────────────────── one sync ─────────────────────────────

const metaOf = (r: engine.RegionInfo, status: string) => `owner: ${r.state}${r.pending ? ", pending" : ""}${status ? ` | ${status}` : ""}`;
const changedLines = (a: string[], b: string[]) => {
  const x = new Set(a), y = new Set(b);
  return a.filter((l) => !y.has(l)).length + b.filter((l) => !x.has(l)).length;
};

/** One pass, safe to repeat: a second run with nothing new makes no writes and no model calls. */
export async function syncOnce(ctx: SyncCtx): Promise<SyncStatus> {
  const { ports } = ctx;
  const fs = ports.fs;
  const status: SyncStatus = { regions: 0, applied: [], pulled: [], compiled: [], modelCalls: 0, attention: [], suggestions: 0, hostedTokensToday: 0, localTokensToday: 0 };
  const attention = (id: string, what: string) => status.attention.push({ id, what });
  const sheetText = await fs.read(SHEET_FILE);
  const state = JSON.parse((await fs.read(STATE_FILE)) ?? '{"regions":{},"fileHashes":{},"notAdopted":[]}') as SyncState;
  const parsed = sheetText === null ? null : parseSheet(sheetText);
  if (parsed?.errors.length) {
    status.error = parsed.errors.join("; ");
    parsed.errors.forEach((e) => attention(SHEET_FILE, e));
    return finish(ctx, status);
  }
  const sheet: Sheet = parsed?.sheet ?? { regions: [], notAdopted: [] };
  const inSheet = new Map(sheet.regions.map((s) => [s.id, s]));
  let p = await analyzed(ctx);
  const tsExt = !!p.program?.getCompilerOptions().allowImportingTsExtensions;
  const known = new Map(functions(p).map((r) => [r.id, r]));
  const files = new Map<string, string>();
  for (const [f, t] of p.files) files.set(f, t); // edits go to this copy; only what changed is committed
  const notes = new Map<string, string[]>();
  const note = (id: string, s: string) => notes.set(id, [...(notes.get(id) ?? []), s]);
  const kept = new Map<string, Suggestion[]>();

  // ── sheet to code, three-way against the base
  const specEdited = new Map<string, { intentChanged: boolean; fromCode: boolean }>();
  for (const [id, r] of known) {
    const s = inSheet.get(id);
    if (!s) continue;
    const base = state.regions[id];
    const code = { intent: intentOf(p, r), examples: examplesKey(r.spec.examples) };
    const old = base ?? code;
    let intent = s.intent, examples = s.examples;
    // Ticking a suggestion says the code is right: the spec follows it, and the body must not be regenerated for it.
    const typed = s.intent !== old.intent || examplesKey(s.examples) !== old.examples;
    const open: Suggestion[] = [];
    for (const g of s.suggestions) {
      if (!g.checked) {
        open.push(g);
        continue;
      }
      if (g.kind === "intent") intent = g.value;
      else if (g.kind === "example") {
        const e = readExample(g.value);
        const args = JSON.stringify((e as { args?: Json } | null)?.args);
        if (e) examples = [...examples.filter((x) => JSON.stringify((x as { args?: Json }).args) !== args), e];
      } else if (g.kind === "escalate") {
        const raw = JSON.parse((await fs.read("openarc.config.json"))!) as { regions?: Record<string, { backend?: string }> };
        raw.regions = { ...raw.regions, [id]: { ...raw.regions?.[id], backend: g.value } };
        await fs.write("openarc.config.json", JSON.stringify(raw, null, 2) + "\n");
      }
    }
    kept.set(id, open);
    const sheetKey = examplesKey(examples);
    const sheetMoved = intent !== old.intent || sheetKey !== old.examples;
    const codeMoved = code.intent !== old.intent || code.examples !== old.examples;
    if (!sheetMoved) continue; // nothing from the sheet; a code move reaches the sheet when it is rendered below
    if (codeMoved && (intent !== code.intent || sheetKey !== code.examples)) {
      attention(id, "spec edited in both the sheet and the code: the code's version is shown; re-apply your edit");
      note(id, "conflict: this spec changed in the code and in the sheet. The code's version is shown here");
      continue;
    }
    if (isMethod(r) && sheetKey !== code.examples) {
      note(id, "methods are verified by arc.test, so these examples weren't applied");
      examples = r.spec.examples;
    }
    const intentChanged = intent !== code.intent;
    const examplesChanged = examplesKey(examples) !== code.examples;
    if (!intentChanged && !examplesChanged) continue;
    writeSpec(files, r, { ...(intentChanged ? { intent } : {}), ...(examplesChanged ? { examples } : {}) }, tsExt);
    specEdited.set(id, { intentChanged, fromCode: !typed });
    status.applied.push(id);
  }

  // ── new sections
  const fresh: string[] = [];
  for (const s of sheet.regions) {
    if (known.has(s.id)) continue;
    const refused = addFunction(files, s, tsExt);
    if (refused) attention(s.id, refused);
    else fresh.push(s.id), status.applied.push(s.id);
  }

  // ── ticked "not adopted" functions
  const adoptNow = sheet.notAdopted.filter((n) => n.checked);
  const changed = new Map([...files].filter(([f, t]) => p.files.get(f) !== t));
  const manifestBefore = JSON.parse((await fs.read(MANIFEST)) ?? '{"schema":1,"regions":{}}') as engine.Manifest;
  await commitFiles(ctx, changed);
  for (const n of adoptNow) {
    const [file, fn] = n.ref.split("#");
    const q = await engine.parse(ports, ctx.request(null, []), []);
    const res = await engine.extract(ports, ctx.request(q, []), q, file!, { fn: fn!, style: "code" });
    res.refused.forEach((x) => attention(n.ref, x.reason));
    await commitFiles(ctx, new Map(res.files.map((f) => [f.target, f.text])));
  }
  if (changed.size || adoptNow.length) p = await analyzed(ctx);

  // ── ownership after spec edits: spend a model call only when the current body can't satisfy the spec
  const m = JSON.parse((await fs.read(MANIFEST)) ?? '{"schema":1,"regions":{}}') as engine.Manifest;
  const regen: string[] = [...fresh];
  for (const [id, { intentChanged, fromCode }] of specEdited) {
    const r = p.regions.find((x) => x.id === id);
    const entry = m.regions[id];
    if (!r || !entry) continue;
    const holding = inSheet.get(id)?.hold || fromCode;
    let passes = false;
    if (!intentChanged && !r.pending && r.spec.examples.length) {
      const seen = await engine.observe(ports, ctx.request(p, []), p, id, r.spec.examples.map((e) => (e as { args: Json[] }).args));
      passes = !("error" in seen) && r.spec.examples.every((e, i) => JSON.stringify(seen[i]?.got) === JSON.stringify((e as { expected: Json }).expected));
    }
    const covered = r.spec.examples.length > 0 || hasTests(p, id);
    if (holding || passes || (entry.ownership === "developer" && !covered)) {
      // kept: the record moves to the new spec. A compiler region then re-verifies with no model call.
      m.regions[id] = { ...entry, specHash: r.specHash, hash: r.hash };
      if (!holding && !passes) {
        note(id, "not regenerated: no example or arc.test could check a new body. Add an example");
        attention(id, "needs an example before it can be regenerated");
      }
      continue;
    }
    if (entry.ownership === "developer") await fs.write(`.openarc/backup/${id}.${r.hash.slice(7, 19)}.ts`, r.bodyLines.join("\n") + "\n");
    // specHash stays the old one, so the compiler sees a changed spec and regenerates; a failure keeps today's body
    m.regions[id] = { ...entry, ownership: "compiler", hash: r.hash, specHash: manifestBefore.regions[id]?.specHash ?? entry.specHash, fingerprint: null };
    regen.push(id);
  }

  // ── adopted functions with no examples: run the body; ask a model only for what the types can't produce
  const adds = new Map<string, string>();
  const needFreeze: string[] = [];
  const base = new Map(Object.entries(state.regions));
  for (const r of functions(p)) {
    if (r.pending || r.state !== "developer" || isMethod(r) || r.spec.examples.length || hasTests(p, r.id)) continue;
    const seen = base.get(r.id);
    if (seen?.described === r.hash) continue; // once per body: this is where repeated sends would come from
    let inputs = deriveInputs(p, r);
    let intent: string | null = null;
    const noIntent = !intentOf(p, r);
    if (!inputs || noIntent) {
      const out = await askJson(ctx, p, DESCRIBE_SYSTEM, `${r.spec.signature}\n${r.spec.intent ? `// ${r.spec.intent}\n` : ""}${bodyOf(r)}`);
      if (out) {
        status.modelCalls++;
        if (noIntent && typeof out.intent === "string") intent = out.intent;
        if (!inputs && Array.isArray(out.inputs)) inputs = (out.inputs as Json[]).filter(Array.isArray) as Json[][];
      }
    }
    base.set(r.id, { ...(seen ?? { intent: "", examples: "", hash: r.hash, lines: [] }), described: r.hash });
    const examples = inputs?.length ? await characterize(ctx, p, r, inputs) : [];
    if ("error" in examples) {
      note(r.id, `can't run this body to record examples: ${examples.error.slice(0, 120)}`);
      continue;
    }
    if (!examples.length && !intent) continue;
    const texts = new Map<string, string>();
    for (const [f, t] of p.files) texts.set(f, t);
    for (const [f, t] of adds) texts.set(f, t);
    writeSpec(texts, r, { ...(intent ? { intent } : {}), ...(examples.length ? { examples } : {}) }, tsExt);
    for (const [f, t] of texts) if (p.files.get(f) !== t) adds.set(f, t);
    needFreeze.push(r.id);
  }
  if (adds.size) {
    await commitFiles(ctx, adds);
    p = await analyzed(ctx);
    for (const id of needFreeze) {
      const r = p.regions.find((x) => x.id === id);
      if (r && m.regions[id]) m.regions[id] = { ...m.regions[id]!, specHash: r.specHash, hash: r.hash };
    }
  }
  await fs.write(MANIFEST, JSON.stringify(m, null, 2) + "\n");

  // ── compile: what the edits asked for, and whatever the plan finds stale (dependencies, a new model, a new spec)
  const diagnostics: Diagnostic[] = [];
  p = await engine.parse(ports, ctx.request(null, []), diagnostics);
  const req = ctx.request(p, []);
  await engine.analyze(ports, req, p, diagnostics);
  for (const r of p.regions) if (r.state === "compiler" && !r.fingerprint && p.manifest.regions[r.id]?.specHash !== r.specHash) r.stale = true;
  const rootOf = (id: string) => p.regions.find((r) => r.id === id)?.root ?? id;
  let targets = [...new Set([...regen, ...engine.plan(p, req, diagnostics)].map(rootOf))];
  const usage = await usageToday(ctx);
  const limit = p.config.sync?.maxHostedTokensPerDay;
  if (limit !== undefined && usage.hosted >= limit) {
    const over = targets.filter((id) => isHosted(p, id));
    over.forEach((id) => attention(id, `not compiled: hosted budget reached (${usage.hosted} of ${limit} tokens today)`));
    targets = targets.filter((id) => !over.includes(id));
  }
  const compileFailed = new Map<string, string>();
  if (targets.length && !ctx.noModel) {
    const problem = await engine.backendProblem(ports, p.config, targets[0]).catch((e: Error) => e.message);
    if (problem) targets.forEach((id) => attention(id, `not compiled: backend not ready (${problem})`));
    else {
      ctx.log?.(`compiling: ${targets.join(", ")}`);
      const res = await ctx.run(ports, { ...ctx.request(p, targets), keepGoing: true });
      status.modelCalls += res.modelCalls;
      for (const d of res.diagnostics) if (d.code.startsWith("OARC-E") && d.id && !compileFailed.has(d.id)) compileFailed.set(d.id, `${d.code}${d.detail ? ` ${String(d.detail).slice(0, 100)}` : ""}`);
      status.compiled = targets.filter((id) => !compileFailed.has(id));
    }
  } else if (targets.length) targets.forEach((id) => attention(id, "waiting: run without --no-model to compile"));

  // ── code to sheet, and drift: a hand edit re-runs the examples, and only a big one costs a model call
  p = await analyzed(ctx);
  const next: SyncState = { regions: {}, fileHashes: state.fileHashes, notAdopted: state.notAdopted };
  const out: SheetRegion[] = [];
  const threshold = p.config.sync?.suggestAtLines ?? DEFAULT_SUGGEST_LINES;
  for (const r of functions(p)) {
    const old = base.get(r.id);
    const intent = intentOf(p, r);
    const examplesNow = examplesKey(r.spec.examples);
    const suggestions = [...(kept.get(r.id) ?? [])];
    const s = inSheet.get(r.id);
    if (s && old && !status.applied.includes(r.id) && (intent !== s.intent || examplesNow !== examplesKey(s.examples))) status.pulled.push(r.id);
    let described = old?.described;
    const handEdit = !!old?.lines.length && old.hash !== r.hash && !status.compiled.includes(r.id) && !r.pending;
    if (handEdit) {
      const lines = r.bodyLines;
      if (r.spec.examples.length && !isMethod(r)) {
        const seen = await engine.observe(ports, ctx.request(p, []), p, r.id, r.spec.examples.map((e) => (e as { args: Json[] }).args));
        if ("error" in seen) note(r.id, `body changed, and its examples couldn't be run: ${seen.error.slice(0, 120)}`);
        else r.spec.examples.forEach((e, i) => {
          const want = (e as { expected: Json }).expected;
          const got = seen[i]?.got;
          if (got !== undefined && !isThrown(got) && JSON.stringify(got) !== JSON.stringify(want)) {
            const value = exampleLine({ ...(e as object), expected: got });
            if (!suggestions.some((g) => g.value === value)) suggestions.push({ kind: "example", value, note: `the code now returns this; the spec says ${JSON.stringify(want)}`, checked: false });
          }
        });
      }
      if (changedLines(old.lines, lines) >= threshold && !isHosted(p, r.id)) {
        const out2 = await askJson(ctx, p, SUGGEST_SYSTEM, `${r.spec.signature}\nIntent: ${intent}\nNew body:\n${bodyOf(r)}`);
        if (out2 && typeof out2.intent === "string" && out2.intent.trim() !== intent) {
          status.modelCalls++;
          suggestions.push({ kind: "intent", value: out2.intent.trim().replace(/\n/g, " "), checked: false });
        }
      } else if (changedLines(old.lines, lines) >= threshold) note(r.id, "the body changed a lot: check that the intent still holds");
      described = r.hash;
    }
    const failed = compileFailed.get(r.id);
    const escalate = p.config.sync?.escalate;
    if (failed) {
      attention(r.id, `compile failed: ${failed}`);
      const current = p.config.regions?.[r.id]?.backend ?? p.config.compilation.defaultBackend;
      if (escalate && escalate !== current && !suggestions.some((g) => g.kind === "escalate")) suggestions.push({ kind: "escalate", value: escalate, note: "tick to compile this region with the stronger backend", checked: false });
    }
    status.suggestions += suggestions.length;
    out.push({
      id: r.id,
      file: r.file,
      meta: metaOf(r, failed ? `failed: ${failed}` : ""),
      signature: r.spec.signature,
      intent,
      examples: r.spec.examples,
      hold: !!s?.hold,
      notes: notes.get(r.id) ?? [],
      suggestions,
    });
    next.regions[r.id] = { intent, examples: examplesNow, hash: r.hash, lines: r.bodyLines, ...(described ? { described } : {}) };
  }
  for (const s of sheet.regions) if (!known.has(s.id) && !out.some((o) => o.id === s.id)) out.push(s); // a section that was refused stays for the person to fix

  // ── functions no region covers, checked only in files that changed
  const notAdopted = await scanNotAdopted(ctx, p, next);
  status.regions = out.length;
  const rendered = renderSheet({ regions: out.sort((a, b) => a.id.localeCompare(b.id)), notAdopted: notAdopted.map((ref) => ({ ref, checked: false })) });
  // Saved while this pass ran: leave the person's text alone; their save starts the next pass, which merges against this state.
  if ((await fs.read(SHEET_FILE)) === sheetText && rendered !== sheetText) await fs.write(SHEET_FILE, rendered);
  await fs.write(STATE_FILE, JSON.stringify(next) + "\n");
  status.hostedTokensToday = usage.hosted;
  status.localTokensToday = usage.local;
  return finish(ctx, status);
}

async function scanNotAdopted(ctx: SyncCtx, p: engine.Project, next: SyncState): Promise<string[]> {
  const hash = (t: string) => { let h = 0; for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) | 0; return String(h); };
  const out = new Set<string>(next.notAdopted);
  const hashes: Record<string, string> = {};
  for (const [rel, text] of p.files) {
    if (!adoptable(rel)) continue;
    hashes[rel] = hash(text);
    if (next.fileHashes[rel] === hashes[rel]) continue;
    for (const ref of [...out]) if (ref.startsWith(`${rel}#`)) out.delete(ref);
    const dry = await engine.extract(ctx.ports, ctx.request(p, []), await engine.parse(ctx.ports, ctx.request(null, []), []), rel, { style: "code" }).catch(() => null);
    for (const id of dry?.extracted ?? []) out.add(`${rel}#${id.split(".").at(-1)}`);
  }
  next.fileHashes = hashes;
  next.notAdopted = [...out].sort();
  return next.notAdopted;
}
const adoptable = (rel: string) => rel.startsWith("src/") && rel.endsWith(".ts") && !/\.(test|arc|d)\.ts$/.test(rel);

async function finish(ctx: SyncCtx, status: SyncStatus): Promise<SyncStatus> {
  await ctx.ports.fs.write(STATUS_FILE, JSON.stringify(status, null, 2) + "\n");
  return status;
}

/** One line, for an agent's context or a status bar. An agent reads this instead of the sheet. */
export const brief = (s: SyncStatus): string => [
  `openarc: ${s.regions} regions`,
  s.compiled.length ? `${s.compiled.length} compiled` : "",
  s.applied.length ? `${s.applied.length} applied` : "",
  s.attention.length ? `${s.attention.length} need attention (${s.attention.slice(0, 3).map((a) => a.id).join(", ")})` : "",
  s.suggestions ? `${s.suggestions} suggestions` : "",
  `hosted tokens today ${s.hostedTokensToday}`,
].filter(Boolean).join(" · ");

// ───────────────────────────── adopt ─────────────────────────────

/** Bring a repo with no specs under OpenArc: every function extract can take, unchanged and developer-owned; then a sync. */
export async function adopt(ctx: SyncCtx): Promise<{ extracted: string[]; refused: { name: string; reason: string }[]; status: SyncStatus }> {
  const extracted: string[] = [];
  const refused: { name: string; reason: string }[] = [];
  const first = await engine.parse(ctx.ports, ctx.request(null, []), []);
  // ponytail: one TypeScript program per file, so adoption of a very large src/ is slow; it runs once.
  for (const rel of [...first.files.keys()].filter(adoptable).sort()) {
    const p = await engine.parse(ctx.ports, ctx.request(null, []), []);
    const res = await engine.extract(ctx.ports, ctx.request(p, []), p, rel, { style: "code" });
    extracted.push(...res.extracted);
    refused.push(...res.refused.map((r) => ({ name: `${rel}#${r.name}`, reason: r.reason })));
    await commitFiles(ctx, new Map(res.files.map((f) => [f.target, f.text])));
  }
  return { extracted, refused, status: await syncOnce(ctx) };
}
