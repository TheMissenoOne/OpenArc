// `openarc pdl verify` (docs/wiki/PDL.md): run what a design states exactly against the code, with no model. A function
// block's `example` lines and its `check` lines become an `.arc` function (pdlsync.ts exactOf) and go through decompile's
// checkSpecs: the same sandbox, value comparison and rules evaluation as `decompile --check`, no second runner. Anything
// else (transitions, `on`, `visible when`, sentences) is counted as not checked, so silence is never read as a pass.
import { isDeepStrictEqual } from "node:util";
import type { ArcFn, ArcModule } from "./arc.ts";
import { printOutcome } from "./arc.ts";
import { checkLine, checkSpecs, type DecompileCtx } from "./decompile.ts";
import { entries, exactOf, load, owned, resolved, type Entry } from "./pdlsync.ts";

export type Outcome = "passed" | "failed" | "not runnable";
/** One exact line: detail says what the code did (failed), how far a check held (passed), or why it could not run. */
export interface VerifyLine { line: number; text: string; outcome: Outcome; detail?: string }
export interface VerifyBlock { id: string; file: string; line: number; lines: VerifyLine[] }
export interface VerifyResult { blocks: VerifyBlock[]; summary: { passed: number; failed: number; notRunnable: number; notChecked: number } }

const NOT_CHECKED = new Set(["transition", "on", "visible", "sentence"]);

/** The exact lines of the blocks `filter` picks (a feature and its blocks, or one block; all without it), or of `picked`.
 *  ready: called once before anything runs, only when something is runnable (the config and the sandbox notice); false
 *  stops with null. */
export async function pdlVerify(ctx: Omit<DecompileCtx, "dirs" | "out">, ready: () => Promise<boolean>, filter?: string, picked?: Entry[]): Promise<VerifyResult | null> {
  picked ??= entries(await load(ctx.ports)).filter((e) => !filter || e.info.id === filter || e.info.id.startsWith(`${filter}.`));
  const plans = [];
  for (const e of picked) {
    const source = resolved(e.info), file = source.length === 1 ? source[0]!.replace(/^\.\//, "") : "";
    const missing = file && !file.endsWith("/") && (await ctx.ports.fs.read(file)) === null ? [file] : [];
    plans.push({ e, ...exactOf(e.info, source, missing) });
  }
  // one module per file; two blocks naming the same function share its ArcFn (their examples and rules side by side)
  const mods = new Map<string, ArcModule>(), fns = new Map<string, ArcFn>();
  for (const p of plans) {
    if (!p.fn) continue;
    const m = mods.get(p.file!) ?? mods.set(p.file!, { name: p.file!, file: p.file!, intent: [], types: [], fns: [] }).get(p.file!)!;
    const had = fns.get(`${p.file}\0${p.fn.name}`);
    if (had) { had.examples.push(...p.fn.examples); had.rules.push(...p.fn.rules); }
    else { m.fns.push(p.fn); fns.set(`${p.file}\0${p.fn.name}`, p.fn); }
  }
  let items: Awaited<ReturnType<typeof checkSpecs>>["items"] = [];
  if (mods.size) {
    if (!(await ready())) return null;
    // the source dirs as `arc` commands derive them: a file's first path segment, `.` for one at the root
    const files = [...mods.keys()], dirs = [...new Set(files.map((f) => (f.includes("/") ? f.split("/")[0]! : ".")))];
    items = (await checkSpecs({ ...ctx, dirs, out: "arc/spec" }, (file, fn) => fns.has(`${file}\0${fn}`), [...mods.values()])).items;
  }
  const blocks: VerifyBlock[] = [], summary = { passed: 0, failed: 0, notRunnable: 0, notChecked: 0 };
  for (const p of plans) {
    summary.notChecked += owned(p.e.info.node).filter((s) => NOT_CHECKED.has(s.kind)).length;
    if (!p.lines.length) continue;
    const mine = items.filter((i) => i.file === p.file && i.fn === p.fn?.name);
    const gone = mine.find((i) => i.kind === "removed" || i.kind === "unrunnable");
    const why = gone && (gone.kind === "removed" ? `${p.file} does not export ${p.fn!.name}` : gone.why!);
    const lines = p.lines.map((x): VerifyLine => {
      const at = { line: x.stmt.line, text: x.stmt.text };
      if (x.why) return { ...at, outcome: "not runnable", detail: x.why };
      if (why) return { ...at, outcome: "not runnable", detail: why };
      if (x.ex) {
        const f = mine.find((i) => i.kind === "failing" && isDeepStrictEqual(i.args, x.ex!.args) && isDeepStrictEqual(i.receiver, x.ex!.receiver) && i.was === printOutcome(x.ex!));
        return f ? { ...at, outcome: "failed", detail: `the code ${f.now!.startsWith("throws") ? f.now : `returns ${f.now}`}` } : { ...at, outcome: "passed" };
      }
      const r = mine.find((i) => i.rule === `${p.e.info.id}:${x.stmt.line}`);
      if (!r || r.kind === "unparsable") return { ...at, outcome: "not runnable", detail: r?.why ?? "it did not run" };
      return r.kind === "held" ? { ...at, outcome: "passed", detail: `held on ${r.inputs} input${r.inputs === 1 ? "" : "s"}` }
        : { ...at, outcome: "failed", detail: checkLine(r).slice(checkLine(r).indexOf("broken by (")) };
    });
    for (const l of lines) summary[l.outcome === "not runnable" ? "notRunnable" : l.outcome]++;
    blocks.push({ id: p.e.info.id, file: p.e.file, line: p.e.info.line, lines });
  }
  return { blocks, summary };
}
