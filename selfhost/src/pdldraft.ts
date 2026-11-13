// `openarc pdl draft <file-or-dir>... [--name <Name>]` (docs/wiki/PDL.md, "Starting from existing code"): the first design
// file for existing code, with no model. One feature per argument, written to `arc/features/<kebab-name>.arc`: a note
// inviting what the code does not say, a purpose sentence (the file's or package's doc comment, else a placeholder), its
// `source`, and per exported function and public method (`Class.method`) of the files a language adapter reads
// (lang/lang.ts) a block with its signature and its doc comment's first sentence. A file no adapter reads gets one
// comment. Never a state, rule, screen or assume block: those are design choices for whoever fills the skeleton.
import { basename } from "node:path";
import type { ArcFn } from "./arc.ts";
import { isTest, type DecompileCtx } from "./decompile.ts"; // before lang.ts: lang/go.ts imports decompile.ts back
import { LANGS, langOf, type ReadModule } from "./lang/lang.ts";
import { classify, format, parse } from "./pdl.ts";
import { PDL_DIR, pdlStatus } from "./pdlsync.ts";
import { commit, planJournal } from "./txn.ts";

const SKIP = new Set(["node_modules", ".git", ".openarc", "dist", "build", "arc"]);
/** Languages with no adapter whose files a directory draft still names; any other file in a directory (docs, data,
 *  styles) is left out. A file named on the command line is always drafted. */
const OTHER_CODE = /\.(py|rs|java|kts?|rb|php|c|h|cc|cpp|hpp|cs|swift|scala|sh|lua|dart|exs?|erl|hs|ml|clj|r|jl|zig|nim|sql|vue|svelte)$/i;
const ID = /^[A-Za-z_$][\w$]*$/;
export const NOTE = "// Notes for the agent: what the code does not say (why this exists, limits, plans). Edit or delete.";
export const PLACEHOLDER = "describe what this is for";
export const NEXT = "next: fill the purpose, delete the blocks a reader would assume, and write what the code does not say in the notes; then `openarc pdl check`.";

export interface Drafted { file: string; feature: string; functions: number; ratio: number | null }

/** `Checkout`, `PdlSync` from `checkout.ts`, `pdl-sync/`, `pdl_sync.go`. */
export const pascal = (base: string) => base.replace(/\..*$/, "").split(/[^A-Za-z0-9]+/).filter(Boolean).map((w) => w[0]!.toUpperCase() + w.slice(1)).join("");
/** `PdlSync` -> `pdl-sync`. */
export const kebab = (name: string) => name.replace(/([a-z0-9])([A-Z])/g, "$1-$2").replace(/([A-Z])([A-Z][a-z])/g, "$1-$2").replace(/[_$]+/g, "-").toLowerCase();

/** Every file under `dir`, sorted, skipping SKIP and dot-entries. */
async function filesIn(ctx: DecompileCtx, dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const name of (await ctx.ports.fs.list(dir)).sort()) {
    if (SKIP.has(name) || name.startsWith(".")) continue;
    const rel = `${dir}/${name}`;
    if ((await ctx.ports.fs.read(rel)) !== null) out.push(rel);
    else out.push(...(await filesIn(ctx, rel)));
  }
  return out;
}

/** The first sentence of comment text as a sentence statement (without its `;`), or undefined when it cannot be one.
 *  `;` becomes `,` and braces parentheses; when that still does not parse as one plain sentence, quotes, brackets and
 *  comment openers go too. ponytail: the first `. ` ends the sentence, so `e.g. x` cuts there */
export function sentence(text: string): string | undefined {
  const flat = text.replace(/\s+/g, " ").trim(), first = (/^(.*?[.!?])(?:\s|$)/.exec(flat)?.[1] ?? flat).replace(/[.]$/, "").trim();
  const ok = (s: string) => {
    const t = parse(`${s};`), items = t.items.filter((n) => n.t !== "trivia");
    return !!s && !t.diagnostics.length && items.length === 1 && items[0]!.t === "stmt" && items[0]!.terminated && classify(items[0]!.text, "function").kind === "sentence";
  };
  const a = first.replace(/;/g, ",").replace(/\{/g, "(").replace(/\}/g, ")");
  if (ok(a)) return a;
  const b = a.replace(/["()[\]]/g, "").replace(/\/[/*]/g, "/").replace(/\s+/g, " ").trim();
  return ok(b) ? b : undefined;
}

/** A file's own doc comment: the first comment block at its top (after a shebang) that is not a licence header and is
 *  not the doc of the declaration right below it (a block directly above `package` or an import is the file's). */
export function fileDoc(text: string): string | undefined {
  const lines = text.split("\n");
  let i = lines[0]?.startsWith("#!") ? 1 : 0;
  for (;;) {
    while (i < lines.length && (!lines[i]!.trim() || /^\s*\/\/go:build/.test(lines[i]!))) i++;
    const block: string[] = [], l = lines[i]?.trim() ?? "";
    const fence = l.startsWith("/*") ? "*/" : l.startsWith('"""') ? '"""' : null;
    if (fence) {
      let s = l.slice(fence === "*/" ? 2 : 3);
      for (;;) {
        const end = s.indexOf(fence);
        block.push((end >= 0 ? s.slice(0, end) : s).replace(/^\s*\*+\s?/, "").trim());
        i++;
        if (end >= 0 || i >= lines.length) break;
        s = lines[i]!;
      }
    } else while (i < lines.length && /^\s*(\/\/|#(\s|$))/.test(lines[i]!)) block.push(lines[i++]!.trim().replace(/^(\/\/+|#)\s?/, ""));
    if (!block.length) return undefined;
    const next = lines[i] ?? "", attached = !!next.trim() && !/^\s*(package|import|from|use|["']use strict)\b/.test(next);
    if (attached) return undefined;
    const t = block.join("\n").trim();
    if (t && !/copyright|spdx-license|licensed under/i.test(t)) return t;
  }
}

/** A function block's header: `name(p: T, q?: T): R`. A type is kept when the adapter knows more than Any and it is
 *  short; Void returns are left out. */
function header(fn: ArcFn): string {
  const ty = (t: string) => (t && t !== "Any" && t !== "Void" && t.length <= 40 ? `: ${t}` : "");
  const params = fn.params.map((p) => `${p.rest ? "..." : ""}${p.name}${p.optional ? "?" : ""}${ty(p.type)}`);
  return `${fn.name}(${params.join(", ")})${ty(fn.returns)}`;
}

/** The adapters' reading of `files`, per file; a reading that throws is retried per file, and a file that still throws
 *  gets its error. A missing toolchain (an `OpenArcSetup` error) stops the draft. */
async function readAll(ctx: DecompileCtx, files: string[]): Promise<Map<string, ReadModule>> {
  const out = new Map<string, ReadModule>();
  for (const lang of LANGS) {
    const mine = files.filter((f) => lang.code.test(f));
    if (!mine.length) continue;
    const fail = (e: unknown) => { if ((e as Error)?.name === "OpenArcSetup") throw e; return (e as Error)?.message ?? String(e); };
    const all = await lang.read(ctx, mine, []).catch(fail);
    const rs = typeof all !== "string" ? [all] : await Promise.all(mine.map((f) => lang.read(ctx, [f], []).catch((e) => ({ modules: new Map([[f, { types: [], found: [], skipped: {}, error: fail(e) }]]) }))));
    for (const r of rs) for (const [f, m] of r.modules) out.set(f, m);
  }
  return out;
}

/** One feature's text, formatted, and its number of function blocks. */
async function draftOne(ctx: DecompileCtx, path: string, isDir: boolean, name: string): Promise<{ text: string; functions: number }> {
  const files = isDir ? (await filesIn(ctx, path)).filter((f) => (langOf(f) ? !isTest(f) : OTHER_CODE.test(f))) : [path];
  const read = await readAll(ctx, files.filter((f) => langOf(f)));
  const texts = await Promise.all(files.map(async (f) => (await ctx.ports.fs.read(f)) ?? ""));
  const purpose = texts.map(fileDoc).map((d) => d && sentence(d)).find(Boolean) ?? PLACEHOLDER;
  const fns: string[] = [], notes: string[] = [], seen = new Set<string>();
  for (const f of files) {
    const m = read.get(f);
    if (!langOf(f)) { notes.push(`// ${f}: no reader for this language yet; describe its operations here.`); continue; }
    if (!m || m.error) { notes.push(`// ${f}: not read (${m?.error?.split("\n")[0] ?? "the reader skipped it"}); describe its operations here.`); continue; }
    for (const { fn } of m.found) {
      if (seen.has(fn.name)) { notes.push(`// ${f}: ${fn.name}() is exported here too; add a block under another name if it differs.`); continue; }
      seen.add(fn.name);
      const s = fn.intent.length ? sentence(fn.intent.join("\n")) : undefined;
      const body = [...(files.length > 1 ? [`source ${JSON.stringify(f)};`] : []), ...(s ? [`${s};`] : [])];
      fns.push(body.length ? `${header(fn)} {\n${body.join("\n")}\n}` : `${header(fn)} {}`);
    }
  }
  const src = isDir ? `${path}/` : path;
  const text = format(`${NOTE}\nfeature ${name} {\n${purpose};\nsource ${JSON.stringify(src)};\n${fns.join("\n\n")}\n${notes.join("\n")}\n}\n`);
  if (parse(text).diagnostics.length) throw new Error(`pdl draft: the skeleton for ${path} does not parse: ${parse(text).diagnostics[0]!.text}`);
  return { text, functions: fns.length };
}

/** `pdl draft`: one feature per path (project-relative, normalised). Refused, writing nothing, when a path is missing,
 *  is the root, is a test file, gives no valid name, or its file or feature name is taken. Written in one transaction. */
export async function pdlDraft(ctx: DecompileCtx, paths: string[], name?: string): Promise<{ drafted: Drafted[] } | { refused: string[] }> {
  const { ports } = ctx, refused: string[] = [], plans: { path: string; isDir: boolean; name: string; file: string }[] = [];
  for (const p of paths) {
    if (!p || p === "." || p.startsWith("../")) { refused.push(`${p || "."}: name a file or directory inside the project, not the project itself`); continue; }
    const isDir = (await ports.fs.read(p)) === null;
    if (isDir && !(await ports.fs.list(p)).length) { refused.push(`${p}: no such file or directory, or it is empty`); continue; }
    if (!isDir && isTest(p)) { refused.push(`${p}: a test file; draft the code it tests`); continue; }
    const n = name ?? pascal(basename(p));
    if (!ID.test(n)) { refused.push(`${p}: \`${n}\` is not a feature name; pass --name <Name>`); continue; }
    const file = `${PDL_DIR}/${kebab(n)}.arc`, held = (await pdlStatus(ports, n)).find((r) => r.id === n);
    if ((await ports.fs.read(file)) !== null) refused.push(`${file} already exists; edit it, or pass --name <Name> for another file`);
    else if (held) refused.push(`feature ${n} already exists in ${held.file}; edit it, or pass --name <Name>`);
    else if (plans.some((x) => x.name === n)) refused.push(`${p}: two arguments give the feature name ${n}; draft them one at a time with --name`);
    else plans.push({ path: p, isDir, name: n, file });
  }
  if (refused.length) return { refused: [...refused, "nothing was written"] };
  const writes = await Promise.all(plans.map(async (x) => ({ ...x, ...(await draftOne(ctx, x.path, x.isDir, x.name)) })));
  const tx = ports.newTxId(), staged = writes.map((w, i) => ({ target: w.file, staged: `.openarc/txn/${tx}/stage/${i}` }));
  for (const [i, w] of writes.entries()) await ports.fs.write(staged[i]!.staged, w.text);
  await commit(ports.fs, planJournal(tx, staged));
  const drafted: Drafted[] = [];
  for (const w of writes) drafted.push({ file: w.file, feature: w.name, functions: w.functions, ratio: (await pdlStatus(ports, w.name)).find((r) => r.id === w.name)?.ratio ?? null });
  return { drafted };
}
