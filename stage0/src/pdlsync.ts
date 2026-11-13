// `openarc pdl status|check|show|sync|format` (docs/wiki/PDL.md): the design in `arc/features/**/*.arc` (src/pdl.ts)
// and the code its `source` statements name, kept in step by a host agent. No model runs here. `.openarc/pdl.json` holds,
// per block id, the hash of its design and of its code when they were last declared in step (`pdl sync`); status
// compares both with now. Sizes are non-whitespace characters: a design should stay well under its code.
import { createHash } from "node:crypto";
import type { Ports } from "./types.ts";
import { blocks, designKey, designSize, format, lint, ownText, parse, printNode, stmtsDeep, stmtsOf, type Block, type BlockInfo, type Finding, type Tree } from "./pdl.ts";
import { commit, planJournal } from "./txn.ts";

export const PDL_DIR = "arc/features";
export const PDL_STATE = ".openarc/pdl.json";
/** Above this design/code size ratio, `pdl check` notes that the design restates its code. */
export const RATIO_NOTE = 0.5;
const SKIP = new Set(["node_modules", ".git", ".openarc", "dist", "build"]);

export type PdlStatus = "new" | "in step" | "design ahead" | "code ahead" | "both changed";
interface State { version: 1; blocks: Record<string, { design: string; code: string | null }> }
export interface PdlRow {
  id: string; kind: string; file: string; line: number; status: PdlStatus; linked: boolean; source: string[]; missing?: string[];
  designSize: number; codeSize?: number; ratio?: number;
}
interface Loaded { file: string; text: string; tree: Tree }
interface Entry { info: BlockInfo; file: string }

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
async function load(ports: Ports): Promise<Loaded[]> {
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
const resolved = (e: BlockInfo): string[] => { const own = sourcesOf(e.node); return own.length || !e.feature ? own : sourcesOf(e.feature); };

const entries = (all: Loaded[]): Entry[] => all.flatMap((l) => blocks(l.tree).map((info) => ({ info, file: l.file })));

async function readState(ports: Ports): Promise<State> {
  try { const s = JSON.parse((await ports.fs.read(PDL_STATE)) ?? "") as State; if (s?.blocks) return s; } catch { /* none yet, or unreadable: start over */ }
  return { version: 1, blocks: {} };
}

/** One block's row against the state. A feature's hash covers its own text; its sizes cover the whole feature and every
 *  source any of its blocks names. */
async function row(ports: Ports, e: Entry, state: State, memo: Map<string, string | null>): Promise<PdlRow & { hashes: { design: string; code: string | null } }> {
  const { info } = e, source = resolved(info), linked = source.length > 0;
  const c = await code(ports, source, memo);
  const hashes = { design: sha(designKey(ownText(info.node))), code: linked ? codeHash(c.files) : null };
  const whole = info.kind === "feature" ? await code(ports, [...new Set(stmtsDeep(info.node.items).flatMap((s) => s.paths ?? []))], memo) : c;
  const design = designSize(printNode(info.node)), size = codeSize(whole.files);
  const was = state.blocks[info.id];
  const dAhead = was && was.design !== hashes.design, cAhead = was && was.code !== hashes.code;
  const status: PdlStatus = !was ? "new" : dAhead && cAhead ? "both changed" : dAhead ? "design ahead" : cAhead ? "code ahead" : "in step";
  const hasCode = whole.files.size > 0;
  return {
    id: info.id, kind: info.kind, file: e.file, line: info.line, status, linked, source, ...(c.missing.length ? { missing: c.missing } : {}),
    designSize: design, ...(hasCode ? { codeSize: size } : {}), ...(hasCode && size ? { ratio: design / size } : {}), hashes,
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

export interface PdlShow extends PdlRow { text: string; purpose: string[]; assume: string | null; uses: string[]; external: string[]; blocks?: string[] }

/** `pdl show <id>`: what a translator needs for one block and nothing more. For a feature, text is its own text (its
 *  nested blocks are listed by id, not repeated). */
export async function pdlShow(ports: Ports, id: string): Promise<PdlShow | null> {
  const all = entries(await load(ports)), e = all.find((x) => x.info.id === id);
  if (!e) return null;
  const r = strip(await row(ports, e, await readState(ports), new Map()));
  const f = e.info.kind === "feature" ? e.info.node : e.info.feature;
  const fs = f ? stmtsOf(f) : [];
  const assume = f?.items.find((n): n is Block => n.t === "block" && n.kind === "assume");
  return {
    ...r,
    text: e.info.kind === "feature" ? ownText(e.info.node) : printNode(e.info.node),
    purpose: fs.filter((s) => s.kind === "sentence").map((s) => s.text),
    assume: assume ? printNode(assume) : null,
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
 *  design. */
export async function pdlSync(ports: Ports, ids: string[] | "all"): Promise<{ synced: string[] } | { refused: string[] }> {
  const all = await load(ports), es = entries(all);
  const unknown = ids === "all" ? [] : ids.filter((id) => !es.some((e) => e.info.id === id));
  if (unknown.length) return { refused: unknown.map((id) => `${id} is not a block id in ${PDL_DIR}; \`openarc pdl status\` lists them`) };
  const picked = ids === "all" ? es : ids.map((id) => es.find((e) => e.info.id === id)!);
  const files = new Set(picked.map((e) => e.file));
  const errors = (await pdlCheck(ports, all)).filter((f) => f.level === "error" && (ids === "all" || files.has(f.file)));
  if (errors.length) return { refused: [...errors.map((f) => f.text), "nothing was synced; fix these (`openarc pdl check`), then sync again"] };
  const state = await readState(ports), memo = new Map<string, string | null>();
  const next: State = { version: 1, blocks: ids === "all" ? {} : { ...state.blocks } };
  for (const e of picked) next.blocks[e.info.id] = (await row(ports, e, state, memo)).hashes;
  await writeAll(ports, [{ target: PDL_STATE, data: JSON.stringify(next, null, 1) + "\n" }]);
  return { synced: picked.map((e) => e.info.id) };
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
