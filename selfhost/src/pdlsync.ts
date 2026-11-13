// `openarc pdl status|check|show|sync|format` (docs/wiki/PDL.md): the design in `arc/features/**/*.arc` (src/pdl.ts)
// and the code its `source` statements name, kept in step by a host agent. No model runs here. `.openarc/pdl.json` holds,
// per block id, the hash of its design and of its code when they were last declared in step (`pdl sync`); status
// compares both with now; a block's design includes its notes (its comments, src/pdl.ts notes). Sizes are non-whitespace
// characters: a design should stay well under its code. exactOf is the bridge `pdl verify` (src/pdlverify.ts) runs on.
import { createHash } from "node:crypto";
import type { Ports } from "./types.ts";
import { blocks, designKey, designSize, format, lint, mask, noteKey, notes, ownText, parse, printNode, stmtsDeep, stmtsOf, type Block, type BlockInfo, type Finding, type Notes, type Stmt, type Tree } from "./pdl.ts";
import { parseExample, type ArcExample, type ArcFn } from "./arc.ts";
import { langOf } from "./lang/lang.ts";
import { commit, planJournal } from "./txn.ts";

export const PDL_DIR = "arc/features";
export const PDL_STATE = ".openarc/pdl.json";
/** Above this design/code size ratio, `pdl check` notes that the design restates its code. */
export const RATIO_NOTE = 0.5;
const SKIP = new Set(["node_modules", ".git", ".openarc", "dist", "build"]);

export type PdlStatus = "new" | "in step" | "design ahead" | "code ahead" | "both changed";
interface State { version: 1; blocks: Record<string, { design: string; code: string | null }> }
/** ownSource: the block names its own code (its ratio compares it with that code, not with the whole feature's).
 *  noteSize: its notes in non-whitespace characters, outside designSize. exact: its `example` and `check` lines, by
 *  whether `pdl verify` can run them (exactOf; nothing is run for this). */
export interface PdlRow {
  id: string; kind: string; file: string; line: number; status: PdlStatus; linked: boolean; ownSource: boolean; source: string[]; missing?: string[];
  designSize: number; noteSize: number; codeSize?: number; ratio?: number; exact: { runnable: number; notRunnable: number };
}
export interface Loaded { file: string; text: string; tree: Tree }
export interface Entry { info: BlockInfo; file: string; notes: Notes }

const sha = (s: string) => `sha256:${createHash("sha256").update(s).digest("hex")}`;

/** Every file under `dir`, recursively, sorted, skipping SKIP. A path that reads as a file is itself. */
async function filesUnder(ports: Ports, dir: string, keep: (f: string) => boolean = () => true): Promise<string[]> {
  const out: string[] = [];
  const walk = async (d: string) => {
    for (const name of await ports.fs.list(d)) {
      if (SKIP.has(name)) continue;
      const rel = `${d}/${name}`;
      if ((await ports.fs.read(rel)) !== null) { if (keep(rel)) out.push(rel); }
      else await walk(rel);
    }
  };
  await walk(dir.replace(/\/+$/, ""));
  return out.sort();
}

/** The design files, parsed. */
export async function load(ports: Ports): Promise<Loaded[]> {
  const out: Loaded[] = [];
  for (const file of await filesUnder(ports, PDL_DIR, (f) => f.endsWith(".arc"))) {
    const text = (await ports.fs.read(file)) ?? "";
    out.push({ file, text, tree: parse(text) });
  }
  return out;
}

/** The code a list of `source` paths names: `dir/` is every file under it; a path that does not exist is missing. A path
 *  without the trailing `/` that names a directory is read as one too. */
async function code(ports: Ports, paths: string[], memo: Map<string, string | null>): Promise<{ files: Map<string, string>; missing: string[] }> {
  const files = new Map<string, string>(), missing: string[] = [];
  const read = async (f: string) => { if (!memo.has(f)) memo.set(f, await ports.fs.read(f)); return memo.get(f)!; };
  for (const p of paths) {
    const clean = p.replace(/^\.\//, "");
    const one = clean.endsWith("/") ? null : await read(clean);
    const list = one !== null ? [clean] : await filesUnder(ports, clean);
    if (!list.length) missing.push(p);
    for (const f of list) { const t = one ?? (await read(f)); if (t !== null) files.set(f, t); }
  }
  return { files, missing };
}

const codeHash = (files: Map<string, string>) => sha([...files.keys()].sort().map((f) => `${f}\0${files.get(f)}\0`).join(""));
const codeSize = (files: Map<string, string>) => [...files.values()].reduce((n, t) => n + t.replace(/\s/g, "").length, 0);
const sourcesOf = (b: Block) => stmtsOf(b).flatMap((s) => s.paths ?? []);

/** The source paths a block resolves to: its own `source` statements, else its feature's. */
export const resolved = (e: BlockInfo): string[] => { const own = sourcesOf(e.node); return own.length || !e.feature ? own : sourcesOf(e.feature); };

const NO_NOTES: Notes = { above: [], inside: [] };
export const entries = (all: Loaded[]): Entry[] => all.flatMap((l) => { const ns = notes(l.tree); return blocks(l.tree).map((info) => ({ info, file: l.file, notes: ns.get(info.node) ?? NO_NOTES })); });
const notesOf = (e: Entry) => [...e.notes.above, ...e.notes.inside];

/** The statements a block holds itself: its items' and those of its control (and unknown) blocks, not a nested block
 *  with an id's. */
export const owned = (b: Block): Stmt[] => b.items.flatMap((n) => (n.t === "stmt" ? [n] : n.t === "block" && n.name === undefined ? owned(n) : []));

/** One `example` or `check` line and how `pdl verify` runs it: ex (an example in the `.arc` model), check (a rule in the
 *  rules language, src/rules.ts), else why it cannot run. */
export interface Exact { stmt: Stmt; ex?: ArcExample; check?: string; why?: string }

/** A function block's `example f(args) => v;` / `throws "t";` (`new C(r).m(args)` for a method) as an ArcExample, or why
 *  not: it calls another function, or an argument or value is no literal. */
function example(stmt: Stmt, name: string): Exact {
  const call = stmt.call!, mk = mask(call), groups = [...mk.matchAll(/\( *\)/g)].map((g) => call.slice(g.index + 1, g.index + g[0].length - 1));
  const m = /^new\s+([A-Za-z_$][\w$]*)\(/.exec(call), called = m ? `${m[1]}.${mk.slice(mk.indexOf(").") + 2, mk.lastIndexOf("("))}` : mk.slice(0, mk.indexOf("(")).trim();
  if (called !== name) return { stmt, why: `it calls ${called}, and the block is ${name}` };
  const text = `${m ? `new (${groups[0]}) . ` : ""}(${groups.at(-1)}) ${stmt.throws !== undefined ? `throws ${JSON.stringify(stmt.throws)}` : `=> ${stmt.value}`}`;
  try { return { stmt, ex: parseExample(text) }; } catch (e) {
    const col = Number(/column (\d+)/.exec((e as Error).message)?.[1] ?? 0), word = col ? /^[A-Za-z_$][\w$]*/.exec(text.slice(col - 1))?.[0] : undefined;
    return { stmt, why: word ? `${word} is a name, not a literal value` : `not a literal: ${(e as Error).message}` };
  }
}

/** The block's exact lines and what `pdl verify` would hand the sandbox: an ArcFn named like the block (`f`, or
 *  `Class.method`, static when no example builds a receiver) in `file`, its parameters from the header (type Any), its
 *  runnable examples and its checks as rules. Runnable only in a function block whose source is exactly one file a
 *  language reads; a check also needs to sit directly in the block and a runnable example to give it inputs. Static: no
 *  code is read or run. */
export function exactOf(info: BlockInfo, source: string[], missing: string[]): { lines: Exact[]; fn?: ArcFn; file?: string } {
  const all = owned(info.node).filter((s) => s.kind === "example" || s.kind === "check");
  if (info.kind !== "function") return { lines: all.map((stmt) => ({ stmt, why: "not inside a function" })) };
  const name = info.node.name!, file = source.length === 1 && !source[0]!.endsWith("/") ? source[0]!.replace(/^\.\//, "") : null;
  const noFile = !source.length ? "no `source` names its code" : !file ? `its source is not one file (${source.join(", ")}); give the block its own \`source "<file>"\``
    : !langOf(file) ? `no language reads ${file}` : missing.length ? `${file} does not exist` : undefined;
  const direct = new Set(stmtsOf(info.node));
  const lines = all.map((stmt): Exact => noFile ? { stmt, why: noFile }
    : stmt.kind === "example" ? example(stmt, name)
    : direct.has(stmt) ? { stmt, check: stmt.expr! } : { stmt, why: "not directly inside a function (it sits in a branch or a loop)" });
  const instance = lines.some((x) => x.ex?.receiver);
  for (const x of lines) if (x.ex && name.includes(".") && instance && !x.ex.receiver) Object.assign(x, { ex: undefined, why: `a method's examples build their receiver: new ${name.split(".")[0]}(...).${name.split(".")[1]}(...)` });
  const exs = lines.flatMap((x) => (x.ex ? [x.ex] : []));
  for (const x of lines) if (x.check !== undefined && !exs.length) Object.assign(x, { check: undefined, why: "no runnable example gives it inputs" });
  if (!exs.length) return { lines };
  const params = (info.node.paramList ?? []).flatMap((p) => {
    const m = /^(\.\.\.)?([A-Za-z_$][\w$]*)(\?)?$/.exec(p.name.trim());
    return m ? [{ name: m[2]!, type: "Any", ...(m[3] ? { optional: true } : {}), ...(m[1] ? { rest: true } : {}) }] : [];
  });
  const rules = lines.flatMap((x) => (x.check !== undefined ? [{ name: `${info.id}:${x.stmt.line}`, text: x.check }] : []));
  return { lines, file: file!, fn: { name, params, returns: "Any", intent: [], examples: exs, rules, ...(name.includes(".") && !instance ? { static: true } : {}) } };
}

async function readState(ports: Ports): Promise<State> {
  try { const s = JSON.parse((await ports.fs.read(PDL_STATE)) ?? "") as State; if (s?.blocks) return s; } catch { /* none yet, or unreadable: start over */ }
  return { version: 1, blocks: {} };
}

/** One block's row against the state. A feature's hash covers its own text; its sizes cover the whole feature and every
 *  source any of its blocks names. */
async function row(ports: Ports, e: Entry, state: State, memo: Map<string, string | null>): Promise<PdlRow & { hashes: { design: string; code: string | null } }> {
  const { info } = e, source = resolved(info), linked = source.length > 0;
  const c = await code(ports, source, memo), ns = noteKey(notesOf(e));
  // a block with no notes hashes as it did before notes counted, so existing state stays in step
  const hashes = { design: sha(designKey(ownText(info.node)) + (ns ? `\0notes\0${ns}` : "")), code: linked ? codeHash(c.files) : null };
  const ex = exactOf(info, source, c.missing).lines, runnable = ex.filter((x) => !x.why).length;
  const whole = info.kind === "feature" ? await code(ports, [...new Set(stmtsDeep(info.node.items).flatMap((s) => s.paths ?? []))], memo) : c;
  const design = designSize(printNode(info.node)), size = codeSize(whole.files);
  const was = state.blocks[info.id];
  const dAhead = was && was.design !== hashes.design, cAhead = was && was.code !== hashes.code;
  const status: PdlStatus = !was ? "new" : dAhead && cAhead ? "both changed" : dAhead ? "design ahead" : cAhead ? "code ahead" : "in step";
  const hasCode = whole.files.size > 0;
  return {
    id: info.id, kind: info.kind, file: e.file, line: info.line, status, linked, ownSource: sourcesOf(info.node).length > 0, source, ...(c.missing.length ? { missing: c.missing } : {}),
    designSize: design, noteSize: ns.replace(/\s/g, "").length, ...(hasCode ? { codeSize: size } : {}), ...(hasCode && size ? { ratio: design / size } : {}),
    exact: { runnable, notRunnable: ex.length - runnable }, hashes,
  };
}

const strip = ({ hashes: _, ...r }: PdlRow & { hashes?: unknown }): PdlRow => r;

/** `pdl status [feature-or-id]`: every block's status, or one feature's blocks, or one block. */
export async function pdlStatus(ports: Ports, filter?: string): Promise<PdlRow[]> {
  const state = await readState(ports), memo = new Map<string, string | null>();
  const picked = entries(await load(ports)).filter((e) => !filter || e.info.id === filter || e.info.id.startsWith(`${filter}.`));
  const out: PdlRow[] = [];
  for (const e of picked) out.push(strip(await row(ports, e, state, memo)));
  return out;
}

/** design/code over the features whose code is linked and not empty, as a percentage; null when there are none. */
export function overall(rows: PdlRow[]): number | null {
  const f = rows.filter((r) => r.kind === "feature" && r.codeSize);
  const code = f.reduce((n, r) => n + r.codeSize!, 0);
  return code ? f.reduce((n, r) => n + r.designSize, 0) / code : null;
}

export const pct = (r: number) => `${Math.round(r * 100)}%`;

/** `pdl check`: structural diagnostics and lint as errors, lint notes, and a note for each block with its own `source`
 *  (and each feature as a whole) whose design is over RATIO_NOTE of its code. */
export async function pdlCheck(ports: Ports, all?: Loaded[]): Promise<Finding[]> {
  all ??= await load(ports);
  const out: Finding[] = [];
  for (const l of all) for (const d of l.tree.diagnostics) out.push({ file: l.file, line: d.line, level: "error", text: `${l.file}:${d.line}: ${d.text}` });
  out.push(...lint(all.map((l) => ({ file: l.file, tree: l.tree }))));
  const state = await readState(ports), memo = new Map<string, string | null>();
  for (const e of entries(all)) {
    if (e.info.kind !== "feature" && !sourcesOf(e.info.node).length) continue;
    const r = await row(ports, e, state, memo);
    if (r.ratio !== undefined && r.ratio > RATIO_NOTE)
      out.push({ id: r.id, file: r.file, line: r.line, level: "note", text: `${r.file}:${r.line}: ${r.id}: the design is ${pct(r.ratio)} of its code (${r.designSize} of ${r.codeSize} non-space characters); drop the steps a reader would assume, or move them to \`assume\`.` });
  }
  return out.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line));
}

/** text: the block as written, dedented to column 0, after the notes right above it; a feature's is its header and own
 *  statements, one per line (its notes are in `notes`). notes: the block's notes. featureNotes: its feature's, for a
 *  block that is not the feature. assume: the statements of the feature's `assume` block, without the wrapper. */
export interface PdlShow extends PdlRow { text: string; notes: string[]; featureNotes?: string[]; purpose: string[]; assume: string | null; uses: string[]; external: string[]; blocks?: string[] }

/** `t` with the indent its lines after the first share removed (the first starts where the block starts). */
const dedent = (t: string): string => {
  const ls = t.split("\n"), ind = (l: string) => /^[ \t]*/.exec(l)![0].length;
  const cut = Math.min(...ls.slice(1).filter((l) => l.trim()).map(ind));
  return Number.isFinite(cut) ? [ls[0], ...ls.slice(1).map((l) => l.slice(Math.min(cut, ind(l))))].join("\n") : t;
};

/** `pdl show <id>`: what a translator needs for one block and nothing more. For a feature, text is its own text (its
 *  nested blocks are listed by id, not repeated). */
export async function pdlShow(ports: Ports, id: string): Promise<PdlShow | null> {
  const all = entries(await load(ports)), e = all.find((x) => x.info.id === id);
  if (!e) return null;
  const r = strip(await row(ports, e, await readState(ports), new Map()));
  const feature = e.info.kind === "feature", f = feature ? e.info.node : e.info.feature;
  const fs = f ? stmtsOf(f) : [];
  const assume = f?.items.find((n): n is Block => n.t === "block" && n.kind === "assume");
  const fe = f && !feature ? all.find((x) => x.info.node === f) : undefined;
  const body = feature ? `${e.info.header} {\n${fs.map((s) => `  ${s.text};`).join("\n")}\n}` : dedent(printNode(e.info.node));
  return {
    ...r,
    text: feature ? body : [...e.notes.above, body].join("\n"), // a feature's notes are its show's `notes` section
    notes: notesOf(e),
    ...(fe ? { featureNotes: notesOf(fe) } : {}),
    purpose: fs.filter((s) => s.kind === "sentence").map((s) => s.text),
    assume: assume ? dedent(assume.items.map(printNode).join("")).trim() : null,
    uses: fs.filter((s) => s.kind === "uses" && !s.external).flatMap((s) => s.names!),
    external: fs.filter((s) => s.kind === "uses" && s.external).flatMap((s) => s.names!),
    ...(e.info.kind === "feature" ? { blocks: all.filter((x) => x.info.feature === e.info.node).map((x) => x.info.id) } : {}),
  };
}

/** Stage files and commit them in one transaction (src/txn.ts). */
async function writeAll(ports: Ports, writes: { target: string; data: string }[]): Promise<void> {
  const tx = ports.newTxId();
  const staged = writes.map((w, i) => ({ target: w.target, staged: `.openarc/txn/${tx}/stage/${i}` }));
  for (const [i, w] of writes.entries()) await ports.fs.write(staged[i]!.staged, w.data);
  await commit(ports.fs, planJournal(tx, staged));
}

/** `pdl sync <ids> | --all`: record the current design and code hashes. Refused, writing nothing, when a named block's
 *  file has an error in `pdl check` (every file, for --all) or an id is unknown. --all also drops ids no longer in the
 *  design. verify: runs the picked blocks' exact lines (src/pdlverify.ts), per block id the lines that failed; a block
 *  with one is not recorded (failed says why) and keeps its old entry; null refuses the sync (it could not run). */
export async function pdlSync(ports: Ports, ids: string[] | "all", verify?: (picked: Entry[]) => Promise<Map<string, string[]> | null>): Promise<{ synced: string[]; failed: string[] } | { refused: string[] }> {
  const all = await load(ports), es = entries(all);
  const unknown = ids === "all" ? [] : ids.filter((id) => !es.some((e) => e.info.id === id));
  if (unknown.length) return { refused: unknown.map((id) => `${id} is not a block id in ${PDL_DIR}; \`openarc pdl status\` lists them`) };
  const picked = ids === "all" ? es : ids.map((id) => es.find((e) => e.info.id === id)!);
  const files = new Set(picked.map((e) => e.file));
  const errors = (await pdlCheck(ports, all)).filter((f) => f.level === "error" && (ids === "all" || files.has(f.file)));
  if (errors.length) return { refused: [...errors.map((f) => f.text), "nothing was synced; fix these (`openarc pdl check`), then sync again"] };
  const bad = verify ? await verify(picked) : new Map<string, string[]>();
  if (!bad) return { refused: ["nothing was synced: the exact lines could not be verified (`--no-verify` skips them)"] };
  const state = await readState(ports), memo = new Map<string, string | null>();
  const next: State = { version: 1, blocks: ids === "all" ? Object.fromEntries([...bad.keys()].flatMap((id) => (state.blocks[id] ? [[id, state.blocks[id]!]] : []))) : { ...state.blocks } };
  const ok = picked.filter((e) => !bad.has(e.info.id));
  for (const e of ok) next.blocks[e.info.id] = (await row(ports, e, state, memo)).hashes;
  if (ok.length || ids === "all") await writeAll(ports, [{ target: PDL_STATE, data: JSON.stringify(next, null, 1) + "\n" }]);
  return { synced: ok.map((e) => e.info.id), failed: [...bad].flatMap(([id, ls]) => ls.map((l) => `${id}: not synced: ${l}`)) };
}

/** `pdl format [--check] [files]`: the files (default: every design file) in canonical layout. changed: the files that
 *  differ from it (written unless `check`); broken: files with structural diagnostics, left as they are. */
export async function pdlFormat(ports: Ports, files: string[], check: boolean): Promise<{ changed: string[]; broken: string[]; missing: string[] }> {
  const list = files.length ? files : await filesUnder(ports, PDL_DIR, (f) => f.endsWith(".arc"));
  const changed: string[] = [], broken: string[] = [], missing: string[] = [], writes: { target: string; data: string }[] = [];
  for (const f of list) {
    const text = await ports.fs.read(f);
    if (text === null) { missing.push(f); continue; }
    if (parse(text).diagnostics.length) { broken.push(f); continue; }
    const out = format(text);
    if (out !== text) { changed.push(f); writes.push({ target: f, data: out }); }
  }
  if (!check && writes.length) await writeAll(ports, writes);
  return { changed, broken, missing };
}
