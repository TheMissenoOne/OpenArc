// `openarc arc status|prompt|accept|compile` (docs/wiki/Arc-Sync.md): the `.arc` file leads, the code follows. An edit
// to a function's intent, examples or rules in `arc/spec/*.arc` reaches its body: status says which functions the spec
// moved ahead of (an `example` fails), prompt gives a writer what it needs, accept splices a body into the developer's
// file (no markers, the signature and every byte outside the body kept) and keeps it only when every `example` holds.
// compile is the same loop with the configured model writing the body. The examples run through decompile's checkSpecs.
import ts from "typescript";
import { resolve } from "node:path";
import type { Ports } from "./types.ts";
import * as engine from "./engine.ts";
import { parseArc, printExample, printSignature, type ArcFn, type ArcModule } from "./arc.ts";
import { STATE_FILE, checkSpecs, fnOf, makeProgram, walk, type DecompileCtx, type DecompileState } from "./decompile.ts";
import { parseCodeOutput } from "./output-format.ts";
import { commit, planJournal } from "./txn.ts";

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
/** What the arc commands need from decompile's context: dirs are derived from the `.arc` files. */
export type ArcCtx = Omit<DecompileCtx, "dirs">;
interface Entry { path: string; mod: ArcModule; fn: ArcFn; id: string }

export type ArcState = "ok" | "stale" | "unrunnable" | "no examples";
export interface ArcRow { id: string; file: string; status: ArcState; failing?: { example: string; got: string }[]; why?: string; changed?: { args: Json[]; was: string; now: string }[] }

const isTs = (file: string) => /\.[cm]?tsx?$/.test(file);
const requirements = (f: ArcFn) => f.examples.filter((e) => !e.observed);

/** Every function in the `.arc` files under ctx.out, as `<module>.<fn>`. */
async function entries(ctx: ArcCtx): Promise<Entry[]> {
  const out: Entry[] = [];
  for (const path of await walk(ctx.ports, ctx.out, [], (n) => n.endsWith(".arc"))) {
    try {
      const mod = parseArc((await ctx.ports.fs.read(path)) ?? "");
      for (const fn of mod.fns) out.push({ path, mod, fn, id: `${mod.name}.${fn.name}` });
    } catch (e) { ctx.log(`${path}: ${(e as Error).message}; skipped`); }
  }
  return out;
}

/** checkSpecs over the source directories the `.arc` files name. ponytail: a module's directory is the first segment
 *  of its path, as decompile's `dirs` are; a source file at the project root is not reached. */
const check = (ctx: ArcCtx, all: Entry[], only: (file: string, fn: string) => boolean, ports = ctx.ports) =>
  checkSpecs({ ...ctx, ports, dirs: [...new Set(all.map((e) => e.mod.file.split("/")[0]!))] }, only);

/** `arc status`: each function's examples against the code as it is. `filter`: a module name or `<module>.<fn>`. */
export async function arcStatus(ctx: ArcCtx, filter?: string): Promise<ArcRow[]> {
  const all = await entries(ctx);
  const picked = all.filter((e) => !filter || e.id === filter || e.mod.name === filter);
  if (!picked.length) return [];
  const want = new Set(picked.map((e) => `${e.mod.file}\0${e.fn.name}`));
  const { items } = await check(ctx, all, (file, fn) => want.has(`${file}\0${fn}`));
  return picked.map((e): ArcRow => {
    const mine = items.filter((i) => i.file === e.mod.file && i.fn === e.fn.name);
    const changed = mine.filter((i) => i.kind === "changed").map((i) => ({ args: i.args!, was: i.was!, now: i.now! }));
    const extra = changed.length ? { changed } : {};
    const base = { id: e.id, file: e.mod.file };
    if (!requirements(e.fn).length) return { ...base, status: "no examples", ...extra };
    const gone = mine.find((i) => i.kind === "removed" || i.kind === "unrunnable");
    if (gone) return { ...base, status: "unrunnable", why: gone.kind === "removed" ? "the code no longer exports it" : gone.why!, ...extra };
    const line = (args: Json[] | undefined) => printExample({ ...requirements(e.fn).find((x) => JSON.stringify(x.args) === JSON.stringify(args))!, name: undefined });
    const failing = mine.filter((i) => i.kind === "failing").map((i) => ({ example: line(i.args), got: i.now! }));
    return failing.length ? { ...base, status: "stale", failing, ...extra } : { ...base, status: "ok", ...extra };
  });
}

// ── the function in the source file ──
/** The function `name` binds at the top level of `sf`, found the way decompile finds exports: `function f`,
 *  `const f = <fn>`, `export default <fn>`, `exports.f = <fn>` (and `module.exports.f`). */
export function locate(sf: ts.SourceFile, name: string): ts.FunctionLikeDeclaration | undefined {
  for (const st of sf.statements) {
    if (ts.isFunctionDeclaration(st)) {
      const isDefault = !!st.modifiers?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);
      if (st.body && (name === "default" ? isDefault : st.name?.text === name)) return st;
    } else if (ts.isVariableStatement(st)) {
      const d = st.declarationList.declarations.find((v) => ts.isIdentifier(v.name) && v.name.text === name);
      if (d) return fnOf(d);
    } else if (ts.isExportAssignment(st) && !st.isExportEquals && name === "default") return fnOf(st);
    else if (ts.isExpressionStatement(st) && ts.isBinaryExpression(st.expression) && st.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const l = st.expression.left;
      if (ts.isPropertyAccessExpression(l) && l.name.text === name && /^(module\.)?exports$/.test(l.expression.getText(sf))) {
        const f = fnOf(st.expression);
        if (f) return f;
      }
    }
  }
  return undefined;
}

/** parseCodeOutput, also taking a ```js / ```javascript fence: the body may be JavaScript. */
const readReply = (raw: string) => parseCodeOutput(raw.replace(/^(\s*```)\s*(?:js|javascript|jsx|tsx|mjs|cjs)\s*$/gim, "$1"));
const parse = (file: string, text: string) => ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, isTs(file) ? ts.ScriptKind.TS : ts.ScriptKind.JS);

/** The file with `body` (statements) as the function's body: a block indented one step past the line the function
 *  starts on. Everything outside the body's braces (or its expression, for an arrow) is kept byte for byte. */
function splice(text: string, sf: ts.SourceFile, node: ts.FunctionLikeDeclaration, body: string): string {
  const b = node.body!, eol = text.includes("\r\n") ? "\r\n" : "\n";
  const base = /^[ \t]*/.exec(text.slice(text.lastIndexOf("\n", node.getStart(sf)) + 1))![0];
  // the reply's first line comes trimmed (parseCodeOutput), so the common indent is the other lines'. ponytail: lines
  // are re-indented, a multi-line template literal's included
  const lines = body.replace(/\r/g, "").trim().split("\n");
  const cut = Math.min(...lines.slice(1).filter((l) => l.trim()).map((l) => /^[ \t]*/.exec(l)![0].length));
  const inner = lines.map((l, i) => (l.trim() ? `${base}  ${i ? l.slice(Number.isFinite(cut) ? cut : 0) : l}` : "")).join(eol);
  return text.slice(0, b.getStart(sf)) + `{${eol}${inner}${eol}${base}}` + text.slice(b.getEnd());
}

/** Type and syntax errors the new text adds to the file. Syntax for every file; types for TypeScript, in the program
 *  decompile builds (the project's tsconfig, or its defaults). ponytail: only the edited file is checked, and errors are
 *  matched by message, so a caller elsewhere that the new body breaks is not reported. */
function tsProblems(root: string, file: string, after: string): string[] {
  const abs = resolve(root, file);
  const before = makeProgram(root, [file]);
  const host = ts.createCompilerHost(before.getCompilerOptions());
  const get = host.getSourceFile.bind(host);
  host.getSourceFile = (f, lang, ...rest) => (resolve(f) === abs ? ts.createSourceFile(f, after, lang) : get(f, lang, ...rest));
  const next = ts.createProgram([abs], before.getCompilerOptions(), host, before);
  const diags = (p: ts.Program) => { const sf = p.getSourceFile(abs); return sf ? [...p.getSyntacticDiagnostics(sf), ...(isTs(file) ? p.getSemanticDiagnostics(sf) : [])] : []; };
  const text = (d: ts.Diagnostic) => `TS${d.code} ${ts.flattenDiagnosticMessageText(d.messageText, " ")}`;
  const had = new Map<string, number>();
  for (const d of diags(before)) had.set(text(d), (had.get(text(d)) ?? 0) + 1);
  return diags(next).flatMap((d) => {
    const n = had.get(text(d)) ?? 0;
    if (n) return had.set(text(d), n - 1), [];
    const line = d.file && d.start !== undefined ? d.file.getLineAndCharacterOfPosition(d.start).line + 1 : 0;
    return [text(d).replace(/^(TS\d+) /, `$1 line ${line}: `)];
  });
}

// ── prompt ──
type Found = { entry: Entry; text: string; sf: ts.SourceFile; node: ts.FunctionLikeDeclaration; all: Entry[] };

/** The function `id` in its `.arc` file and in the code, or why it can't be written from the spec. */
async function find(ctx: ArcCtx, id: string): Promise<Found | { refused: string }> {
  const all = await entries(ctx);
  const entry = all.find((e) => e.id === id);
  if (!entry) return { refused: `${id} is not in any .arc file under ${ctx.out}; \`openarc decompile\` writes them, \`openarc arc status\` lists the functions` };
  if (!requirements(entry.fn).length) return { refused: `${id} has no \`example\` lines, so nothing would verify a new body. Promote an \`observed\` line (change the word to \`example\`) or write an example in ${entry.path}` };
  const text = await ctx.ports.fs.read(entry.mod.file);
  if (text === null) return { refused: `${id}: cannot read ${entry.mod.file}` };
  const sf = parse(entry.mod.file, text), node = locate(sf, entry.fn.name);
  if (!node) return { refused: `${id}: no function ${entry.fn.name} with a body in ${entry.mod.file} (function f, const f = <fn>, export default <fn> or exports.f = <fn>)` };
  return { entry, text, sf, node, all };
}

/** The `type` lines the signature names, and the ones those name. */
function typesOf(m: ArcModule, f: ArcFn): string[] {
  const used = new Set<string>(), named = (s: string) => m.types.filter((t) => !used.has(t.name) && new RegExp(`\\b${t.name.replaceAll("$", "\\$")}\\b`).test(s));
  let next = named(printSignature(f));
  while (next.length) { next.forEach((t) => used.add(t.name)); next = next.flatMap((t) => named(t.type)); }
  return m.types.filter((t) => used.has(t.name)).map((t) => `type ${t.name} = ${t.type}`);
}

/** The top-level statement holding `n`: the whole `export const f = (a) => ...;`, not only the arrow. */
const top = (n: ts.Node): ts.Node => (ts.isSourceFile(n.parent) ? n : top(n.parent));

const SYSTEM = "You write one function body. You output exactly one fenced code block holding the body's statements only: no signature, no outer braces, no imports.";

/** What a writer (the host agent, or compile's model) needs for a new body of `id`: the shape of host.hostPrompt. */
export async function arcPrompt(ctx: ArcCtx, id: string): Promise<{ id: string; file: string; signature: string; outputFormat: "code"; system: string; prompt: string; instruction: string } | { refused: string }> {
  const got = await find(ctx, id);
  if ("refused" in got) return got;
  const { entry: { mod, fn }, sf, node } = got;
  const row = (await arcStatus(ctx, id))[0];
  const signature = `${fn.async ? "async " : ""}fn ${printSignature(fn)}`;
  const types = typesOf(mod, fn);
  const failing = row?.status === "stale" ? row.failing!.map((x) => `${x.example}: the code ${x.got.startsWith("throws") ? x.got : `returns ${x.got}`}`) : row?.status === "unrunnable" ? [`unrunnable: ${row.why}`] : [];
  const prompt = [
    `Write the body of ${fn.name} in ${mod.file} (${isTs(mod.file) ? "TypeScript" : "JavaScript"}).`,
    signature, ...types,
    ...(fn.intent.length ? ["Intent:", ...fn.intent.map((l) => `  ${l}`)] : []),
    "Examples (each must hold; `after (...)`: the arguments as the call leaves them; `throws \"t\"`: the error message contains t):",
    ...requirements(fn).map((e) => `  ${printExample({ ...e, name: undefined })}`),
    ...(fn.rules.length ? ["Rules:", ...fn.rules.map((r) => `  ${r.name}: ${r.text}`)] : []),
    "Current code:", top(node).getText(sf),
    ...(failing.length ? ["Failing now:", ...failing.map((l) => `  ${l}`)] : []),
  ].join("\n");
  return { id, file: mod.file, signature, outputFormat: "code", system: SYSTEM, prompt, instruction: `Pipe your reply to \`openarc arc accept ${id}\`: the function BODY only: statements, no signature, no code fences, no imports.` };
}

// ── accept ──
/** `arc accept`: `raw` (a body, maybe fenced) becomes the body of `id`, kept only when the file still parses (and type
 *  checks, for TypeScript) and every `example` line holds. The file is written only then, so a rejected body leaves it
 *  byte-identical. No model. refused: the input can't be tried; problems: it was tried and failed. */
export async function arcAccept(ctx: ArcCtx, id: string, raw: string): Promise<{ ok: true; file: string } | { ok: false; problems: string[] } | { refused: string }> {
  const got = await find(ctx, id);
  if ("refused" in got) return got;
  const { entry, text, sf, node, all } = got;
  const file = entry.mod.file, name = entry.fn.name;
  const reply = readReply(raw);
  if (!reply.ok) return { ok: false, problems: [`the reply has no usable code block (${reply.diagnostic.detail})`] };
  if (reply.imports.length) return { refused: `${id}: the body has import lines; accept writes the body only, so add the import to ${file} first` };
  const stmts = parse(file, reply.body).statements;
  if (stmts.some((s) => ts.canHaveModifiers(s) && ts.getModifiers(s)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) || !!locate(parse(file, reply.body), name))
    return { refused: `${id}: the body repeats the signature; send the statements inside the function only (the signature is the spec's and stays)` };
  const after = splice(text, sf, node, reply.body);
  const nsf = parse(file, after), moved = locate(nsf, name);
  if (!moved || after.slice(0, moved.body!.getStart(nsf)) !== text.slice(0, node.body!.getStart(sf)) || after.slice(moved.body!.getEnd()) !== text.slice(node.body!.getEnd()))
    return { refused: `${id}: the body changes the signature or code outside the body (unbalanced braces?)` };
  const problems = tsProblems(ctx.root, file, after);
  if (!problems.length) {
    // the examples run against the new text: the sandbox stages what ports.fs.read returns, and the file on disk is untouched
    const overlay: Ports = { ...ctx.ports, fs: { ...ctx.ports.fs, read: (rel) => (rel === file ? Promise.resolve(after) : ctx.ports.fs.read(rel)) } };
    const { items } = await check(ctx, all, (f, fn) => f === file && fn === name, overlay);
    for (const i of items) {
      if (i.kind === "failing") problems.push(i.why!);
      else if (i.kind === "unrunnable") problems.push(`unrunnable: ${i.why}`);
      else if (i.kind === "removed") problems.push(`${name} is no longer exported`);
    }
    // rule checks go here, once rule lines are evaluable (src/rules.ts): after the examples pass, before anything is written
  }
  if (problems.length) return { ok: false, problems };
  // the file and the decompile state in one transaction (src/txn.ts)
  const writes = [{ target: file, data: after }];
  const stateText = await ctx.ports.fs.read(STATE_FILE);
  if (stateText !== null) {
    try {
      const state = JSON.parse(stateText) as DecompileState;
      const m = (state.modules[file] ??= { hash: "", arc: entry.path, fns: {}, skipped: {} });
      const was = m.fns[name];
      // what decompile records for a function whose examples all hold and whose tests did not run: specified. The module's
      // hash no longer matches its source, so the next decompile runs it again and re-records its observations
      m.fns[name] = { status: "specified", tests: was?.tests ?? [], ...(was?.origins ? { origins: was.origins } : {}) };
      writes.push({ target: STATE_FILE, data: JSON.stringify(state, null, 1) + "\n" });
    } catch { ctx.log(`${STATE_FILE} is not valid JSON; left as it is`); }
  }
  const tx = ctx.ports.newTxId();
  const staged = writes.map((w, i) => ({ target: w.target, staged: `.openarc/txn/${tx}/stage/${i}` }));
  for (const [i, w] of writes.entries()) await ctx.ports.fs.write(staged[i]!.staged, w.data);
  await commit(ctx.ports.fs, planJournal(tx, staged));
  return { ok: true, file };
}

// ── compile ──
/** `arc compile`: for each id, ask the model for a body (arcPrompt), put it through arcAccept, and on a failure ask again
 *  with the problems, up to `attempts` requests in all. Stops at the first accepted body. */
export async function arcCompile(ctx: ArcCtx, ids: string[], ask: (system: string, user: string) => Promise<string>, attempts: number): Promise<{ id: string; ok: boolean; attempts: number; problems: string[] }[]> {
  const out: { id: string; ok: boolean; attempts: number; problems: string[] }[] = [];
  for (const id of ids) {
    const p = await arcPrompt(ctx, id);
    if ("refused" in p) { out.push({ id, ok: false, attempts: 0, problems: [p.refused] }); continue; }
    let previous: { body: string; problems: string[] } | null = null, n = 0;
    while (n < attempts) {
      n++;
      const repair = engine.repairText(previous);
      let reply: string;
      try { reply = await ask(p.system, repair ? `${p.prompt}\n\n${repair}` : p.prompt); }
      catch (e) { previous = { body: "", problems: [`the model request failed: ${(e as Error).message}`] }; break; }
      const res = await arcAccept(ctx, id, reply);
      if ("ok" in res && res.ok) { previous = null; break; }
      const body = readReply(reply);
      previous = { body: body.ok ? body.body : reply, problems: "refused" in res ? [res.refused] : res.problems };
    }
    out.push({ id, ok: !previous, attempts: n, problems: previous?.problems ?? [] });
  }
  return out;
}

/** The ids `arc compile` works on: `--stale` every stale function, a module its stale functions, `<module>.<fn>` that
 *  one when stale. Functions that already satisfy their examples cost no request. */
export async function compileTargets(ctx: ArcCtx, what: string): Promise<{ ids: string[]; rows: ArcRow[] }> {
  const rows = await arcStatus(ctx, what === "--stale" ? undefined : what);
  return { ids: rows.filter((r) => r.status === "stale").map((r) => r.id), rows };
}
