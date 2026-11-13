// `openarc arc status|prompt|accept|compile` (docs/wiki/Arc-Sync.md): the `.arc` file leads, the code follows. An edit
// to a function's intent, examples or rules in `arc/spec/*.arc` reaches its body: status says which functions the spec
// moved ahead of (an `example` fails), prompt gives a writer what it needs, accept splices a body into the developer's
// file (no markers, the signature and every byte outside the body kept) and keeps it only when every `example` holds.
// compile is the same loop with the configured model writing the body. The examples run through decompile's checkSpecs.
import type { Ports } from "./types.ts";
import * as engine from "./engine.ts";
import { parseArc, printExample, printSignature, type ArcFn, type ArcModule } from "./arc.ts";
import { STATE_FILE, checkLine, checkSpecs, walk, type CheckItem, type DecompileCtx, type DecompileState } from "./decompile.ts";
import { langOf, type Lang, type Located } from "./lang/lang.ts";
import { parseCodeOutput } from "./output-format.ts";
import { commit, planJournal } from "./txn.ts";

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
/** What the arc commands need from decompile's context: dirs are derived from the `.arc` files. */
export type ArcCtx = Omit<DecompileCtx, "dirs">;
interface Entry { path: string; mod: ArcModule; fn: ArcFn; id: string }

export type ArcState = "ok" | "stale" | "unrunnable" | "no examples";
export interface ArcRow { id: string; file: string; status: ArcState; failing?: { example: string; got: string }[]; why?: string; changed?: { args: Json[]; was: string; now: string }[] }

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
    const failing = [
      ...mine.filter((i) => i.kind === "failing").map((i) => ({ example: line(i.args), got: i.now! })),
      // a rule the code breaks (or one that cannot be read) is a requirement the code does not meet, like a failing example
      ...mine.filter((i) => i.kind === "broken" || i.kind === "unparsable").map((i) => ({ example: `rule ${i.rule}`, got: ruleText(i) })),
    ];
    return failing.length ? { ...base, status: "stale", failing, ...extra } : { ...base, status: "ok", ...extra };
  });
}

/** One unmet requirement as text: `example (3) => 9: the code returns 6`, `rule bounded: broken by (-50) -> -50`. */
export const failLine = (x: { example: string; got: string }): string =>
  x.example.startsWith("rule ") ? `${x.example}: ${x.got}` : `${x.example}: the code ${x.got.startsWith("throws") ? x.got : `returns ${x.got}`}`;

/** What a rule item says, without the file and function: `broken by (-50) -> -50`. */
const ruleText = (i: CheckItem): string => checkLine(i).split(`rule ${i.rule}: `)[1] ?? i.why ?? "";

// ── the function in the source file (its language finds it: lang/lang.ts) ──
/** parseCodeOutput, also taking a ```js / ```javascript fence: the body may be JavaScript. */
const readReply = (raw: string) => parseCodeOutput(raw.replace(/^(\s*```)\s*(?:js|javascript|jsx|tsx|mjs|cjs)\s*$/gim, "$1"));

/** The file with `body` (statements) as the function's body: a block indented one step past the line the function
 *  starts on. Everything outside the body's braces (or its expression, for an arrow) is kept byte for byte. */
function splice(text: string, loc: Located, body: string, step: string): string {
  const eol = text.includes("\r\n") ? "\r\n" : "\n", base = loc.indent;
  // the reply's first line comes trimmed (parseCodeOutput), so the common indent is the other lines'. ponytail: lines
  // are re-indented, a multi-line template literal's included
  const lines = body.replace(/\r/g, "").trim().split("\n");
  const cut = Math.min(...lines.slice(1).filter((l) => l.trim()).map((l) => /^[ \t]*/.exec(l)![0].length));
  const inner = lines.map((l, i) => (l.trim() ? `${base}${step}${i ? l.slice(Number.isFinite(cut) ? cut : 0) : l}` : "")).join(eol);
  return text.slice(0, loc.start) + `{${eol}${inner}${eol}${base}}` + text.slice(loc.end);
}

// ── prompt ──
type Found = { entry: Entry; text: string; lang: Lang; loc: Located; all: Entry[] };

/** The function `id` in its `.arc` file and in the code, or why it can't be written from the spec. */
async function find(ctx: ArcCtx, id: string): Promise<Found | { refused: string }> {
  const all = await entries(ctx);
  const entry = all.find((e) => e.id === id);
  if (!entry) return { refused: `${id} is not in any .arc file under ${ctx.out}; \`openarc decompile\` writes them, \`openarc arc status\` lists the functions` };
  if (!requirements(entry.fn).length) return { refused: `${id} has no \`example\` lines, so nothing would verify a new body. Promote an \`observed\` line (change the word to \`example\`) or write an example in ${entry.path}` };
  const text = await ctx.ports.fs.read(entry.mod.file);
  if (text === null) return { refused: `${id}: cannot read ${entry.mod.file}` };
  const lang = langOf(entry.mod.file);
  if (!lang) return { refused: `${id}: no language reads ${entry.mod.file}` };
  const loc = await lang.locate(ctx, entry.mod.file, text, entry.fn.name);
  if (!loc) return { refused: `${id}: no function ${entry.fn.name} with a body in ${entry.mod.file} (${lang.forms})` };
  return { entry, text, lang, loc, all };
}

/** The `type` lines the signature names, and the ones those name. */
function typesOf(m: ArcModule, f: ArcFn): string[] {
  const used = new Set<string>(), named = (s: string) => m.types.filter((t) => !used.has(t.name) && new RegExp(`\\b${t.name.replaceAll("$", "\\$")}\\b`).test(s));
  let next = named(printSignature(f));
  while (next.length) { next.forEach((t) => used.add(t.name)); next = next.flatMap((t) => named(t.type)); }
  return m.types.filter((t) => used.has(t.name)).map((t) => `type ${t.name} = ${t.type}`);
}

const SYSTEM = "You write one function body. You output exactly one fenced code block holding the body's statements only: no signature, no outer braces, no imports.";

/** What a writer (the host agent, or compile's model) needs for a new body of `id`: the shape of host.hostPrompt. */
export async function arcPrompt(ctx: ArcCtx, id: string): Promise<{ id: string; file: string; signature: string; outputFormat: "code"; system: string; prompt: string; instruction: string } | { refused: string }> {
  const got = await find(ctx, id);
  if ("refused" in got) return got;
  const { entry: { mod, fn }, lang, loc } = got;
  const row = (await arcStatus(ctx, id))[0];
  const signature = `${fn.async ? "async " : ""}fn ${printSignature(fn)}`;
  const types = typesOf(mod, fn);
  const failing = row?.status === "stale" ? row.failing!.map(failLine) : row?.status === "unrunnable" ? [`unrunnable: ${row.why}`] : [];
  const prompt = [
    `Write the body of ${fn.name} in ${mod.file} (${lang.label(mod.file)}).`,
    signature, ...types,
    ...(fn.intent.length ? ["Intent:", ...fn.intent.map((l) => `  ${l}`)] : []),
    "Examples (each must hold; `after (...)`: the arguments as the call leaves them; `throws \"t\"`: the error message contains t):",
    ...requirements(fn).map((e) => `  ${printExample({ ...e, name: undefined })}`),
    ...(fn.rules.length ? ["Rules:", ...fn.rules.map((r) => `  ${r.name}: ${r.text}`)] : []),
    "Current code:", loc.code,
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
  const { entry, text, lang, loc, all } = got;
  const file = entry.mod.file, name = entry.fn.name;
  const reply = readReply(raw);
  if (!reply.ok) return { ok: false, problems: [`the reply has no usable code block (${reply.diagnostic.detail})`] };
  if (reply.imports.length) return { refused: `${id}: the body has import lines; accept writes the body only, so add the import to ${file} first` };
  if (lang.notBody(file, reply.body, name))
    return { refused: `${id}: the body repeats the signature; send the statements inside the function only (the signature is the spec's and stays)` };
  const after = splice(text, loc, reply.body, lang.indent);
  const moved = await lang.locate(ctx, file, after, name);
  if (!moved || after.slice(0, moved.start) !== text.slice(0, loc.start) || after.slice(moved.end) !== text.slice(loc.end))
    return { refused: `${id}: the body changes the signature or code outside the body (unbalanced braces?)` };
  const problems = await lang.problems(ctx, file, after);
  if (!problems.length) {
    // the examples run against the new text: the sandbox stages what ports.fs.read returns, and the file on disk is untouched
    const overlay: Ports = { ...ctx.ports, fs: { ...ctx.ports.fs, read: (rel) => (rel === file ? Promise.resolve(after) : ctx.ports.fs.read(rel)) } };
    const { items } = await check(ctx, all, (f, fn) => f === file && fn === name, overlay);
    for (const i of items) {
      if (i.kind === "failing") problems.push(i.why!);
      else if (i.kind === "unrunnable") problems.push(`unrunnable: ${i.why}`);
      else if (i.kind === "removed") problems.push(`${name} is no longer exported`);
      else if (i.kind === "broken" || i.kind === "unparsable") problems.push(`rule ${i.rule}: ${ruleText(i)}`); // checked by checkSpecs on the written lines and generated inputs (src/rules.ts)
    }
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
