// `openarc view [module]` (docs/wiki/View.md): the `.arc` spec and, per function, whether the code meets it, in a raw
// terminal (plain ANSI escapes, no TUI library). render() and reduce() are pure; view() is the I/O shell around them:
// raw keys in, checks (`arc status --json`) and compiles (`arc compile`) as child processes so the screen never waits,
// the dirwatch watcher re-checking the module whose `.arc` or source file changed. `--once` (and any non-TTY stdout)
// prints one frame and exits 1 when a function is stale.
import { spawn as nodeSpawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { parseArc, printExample } from "./arc.ts";
import { arcStatus, failLine, type ArcCtx, type ArcRow, type ArcState } from "./arcsync.ts";
import { walk } from "./decompile.ts";
import { watchDirs } from "./dirwatch.ts";
import { enqueue, takeNext, type WatchQueue } from "./watch.ts";

type Failing = { example: string; got: string };
/** text: the function's lines exactly as in the file; line: 1-based line of its `fn` line. */
export interface Fn { id: string; name: string; line: number; text: string[]; status?: ArcState; busy?: boolean; failing?: Failing[]; why?: string }
/** head: the file's lines before its first `fn`; error: the file does not parse. */
export interface Mod { path: string; name: string; head: string[]; fns: Fn[]; file: string; open: boolean; error?: string }
/** What a key asks the shell to do. A check target is a module, `<module>.<fn>`, or "" for everything. */
export type Want = { kind: "check"; target: string } | { kind: "compile"; id: string } | { kind: "edit"; path: string; line: number };
/** sel: the key of the selected row (a module's path or a function's id); typing: `/` is reading the filter. */
export interface State { mods: Mod[]; sel: string; filter: string; typing: boolean; help: boolean; log: string[]; want: Want[]; quit: boolean; color: boolean }
type Row = { key: string; mod: Mod; fn?: Fn };

export const initState = (mods: Mod[], color: boolean): State => ({ mods, sel: "", filter: "", typing: false, help: false, log: [], want: [], quit: false, color });

// ── model ──
const escape = (s: string) => s.replace(/[$.]/g, "\\$&");
/** The modules of these `.arc` files, keeping what `prev` knew of each function (status, open modules). */
export function loadModules(files: { path: string; text: string }[], prev: Mod[] = []): Mod[] {
  return files.map(({ path, text }): Mod => {
    const old = prev.find((m) => m.path === path);
    const lines = text.replaceAll("\r\n", "\n").replace(/\n$/, "").split("\n");
    try {
      const m = parseArc(text);
      // ponytail: a function's block is found by its name; a name declared twice shows the first block
      const starts = m.fns.map((f) => lines.findIndex((l) => new RegExp(`^(async\\s+)?fn\\s+(static\\s+)?${escape(f.name)}\\s*\\(`).test(l)));
      const end = (i: number) => {
        let j = i + 1;
        while (j < lines.length && (!lines[j]!.trim() || /^\s/.test(lines[j]!))) j++;
        while (j > i + 1 && !lines[j - 1]!.trim()) j--;
        return j;
      };
      const first = lines.findIndex((l) => /^(async\s+)?fn\s/.test(l));
      const head = lines.slice(0, first < 0 ? lines.length : first);
      while (head.length && !head.at(-1)!.trim()) head.pop();
      const fns = m.fns.map((f, k): Fn => {
        const id = `${m.name}.${f.name}`, at = starts[k]!, was = old?.fns.find((x) => x.id === id);
        const keep = was ? { ...(was.status ? { status: was.status } : {}), ...(was.busy ? { busy: true } : {}), ...(was.failing ? { failing: was.failing } : {}), ...(was.why ? { why: was.why } : {}) } : {};
        return { id, name: f.name, line: at + 1, text: at < 0 ? [] : lines.slice(at, end(at)), ...keep };
      });
      return { path, name: m.name, file: m.file, head, fns, open: old?.open ?? true };
    } catch (e) {
      return { path, name: path, file: "", head: [], fns: [], open: true, error: (e as Error).message };
    }
  });
}

const hits = (target: string, m: Mod, f: Fn) => !target || target === m.name || target === f.id;
const mapFns = (s: State, fn: (f: Fn, m: Mod) => Fn): State => ({ ...s, mods: s.mods.map((m) => ({ ...m, fns: m.fns.map((f) => fn(f, m)) })) });
/** Mark the functions a check of `target` covers as being checked. */
export const markBusy = (s: State, target: string): State => mapFns(s, (f, m) => (hits(target, m, f) ? { ...f, busy: true } : f));
/** A check of `target` finished: its rows set each function's status, and none of them is busy any more. */
export function applyRows(s: State, target: string, rows: ArcRow[]): State {
  return mapFns(s, (f, m) => {
    if (!hits(target, m, f)) return f;
    const r = rows.find((x) => x.id === f.id);
    const { busy: _b, ...rest } = f;
    if (!r) return rest;
    const { failing: _f, why: _w, ...bare } = rest;
    return { ...bare, status: r.status, ...(r.failing ? { failing: r.failing } : {}), ...(r.why ? { why: r.why } : {}) };
  });
}
export const log = (s: State, ...lines: string[]): State => ({ ...s, log: [...s.log, ...lines].slice(-50) });

/** The rows of the list: modules, and the functions of open ones. A filter keeps the functions whose id contains it
 *  (every function of a module whose name contains it), case-insensitively, and shows them whether open or not. */
export function rows(s: State): Row[] {
  const q = s.filter.toLowerCase();
  return s.mods.flatMap((m) => {
    const whole = !q || m.name.toLowerCase().includes(q);
    const fns = whole ? m.fns : m.fns.filter((f) => f.id.toLowerCase().includes(q));
    if (!whole && !fns.length) return [];
    return [{ key: m.path, mod: m }, ...(m.open || q ? fns.map((fn) => ({ key: fn.id, mod: m, fn })) : [])];
  });
}

// ── keys ──
/** One key: "up" "down" "left" "right" "enter" "esc" "backspace" "ctrl-c", or the character typed. */
export function reduce(s: State, key: string): State {
  if (key === "ctrl-c") return { ...s, quit: true };
  if (s.help) return { ...s, help: false };
  if (s.typing) {
    if (key === "enter") return { ...s, typing: false };
    if (key === "esc") return { ...s, typing: false, filter: "" };
    if (key === "backspace") return { ...s, filter: s.filter.slice(0, -1) };
    if ([...key].length === 1 && key >= " ") return { ...s, filter: s.filter + key };
  }
  const rs = rows(s), i = Math.max(0, rs.findIndex((r) => r.key === s.sel)), row = rs[i];
  const move = (d: number): State => ({ ...s, sel: rs[Math.min(rs.length - 1, Math.max(0, i + d))]?.key ?? s.sel });
  const setOpen = (open: boolean): State => (row ? { ...s, mods: s.mods.map((m) => (m === row.mod ? { ...m, open } : m)), sel: row.mod.path } : s);
  switch (key) {
    case "up": case "k": return move(-1);
    case "down": case "j": return move(1);
    case "enter": return row && !row.fn ? setOpen(!row.mod.open) : s;
    case "right": return row && !row.fn ? setOpen(true) : move(0);
    case "left": return row?.fn ? { ...s, sel: row.mod.path } : setOpen(false);
    case "/": return { ...s, typing: true };
    case "esc": return { ...s, filter: "" };
    case "?": return { ...s, help: true };
    case "q": return { ...s, quit: true };
    case "R": return { ...markBusy(s, ""), want: [...s.want, { kind: "check", target: "" }] };
    case "r": {
      if (!row) return s;
      const target = row.fn?.id ?? row.mod.name;
      return { ...markBusy(s, target), want: [...s.want, { kind: "check", target }] };
    }
    case "c": {
      const f = row?.fn;
      if (!f) return log(s, "c: select a function first");
      if (f.status !== "stale") return log(s, `c: ${f.id} is ${f.busy ? "being checked" : f.status ?? "not checked yet"}; only a stale function is compiled`);
      return { ...log(s, `compiling ${f.id}`), want: [...s.want, { kind: "compile", id: f.id }] };
    }
    case "e": return row ? { ...s, want: [...s.want, { kind: "edit", path: row.mod.path, line: row.fn?.line ?? 1 }] } : s;
    default: return s;
  }
}

// ── text width: ANSI colour codes take no cell, wide characters two, combining marks none ──
const ANSI = /\x1b\[[0-9;]*m/g;
const graphemes = (s: string) => [...new Intl.Segmenter().segment(s)].map((x) => x.segment);
const WIDE = /^[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꀀ-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦\u{1F300}-\u{1F64F}\u{1F900}-\u{1F9FF}\u{20000}-\u{3FFFD}]/u;
// ponytail: the wide ranges are CJK, Hangul, fullwidth forms and the common pictographs, not the whole of East Asian Width
const cells = (g: string) => (/^[\p{M}​-‍﻿]/u.test(g) ? 0 : WIDE.test(g) ? 2 : 1);
/** The cells `s` takes on a terminal. */
export const visible = (s: string): number => graphemes(s.replace(ANSI, "")).reduce((n, g) => n + cells(g), 0);
/** `s` cut or padded to exactly `w` cells, colour codes kept (and reset when the cut drops a reset). */
export function fit(s: string, w: number): string {
  let out = "", n = 0, coloured = false, cut = false;
  for (const part of s.split(/(\x1b\[[0-9;]*m)/)) {
    if (part.startsWith("\x1b[")) { out += part; coloured = true; continue; }
    for (const g of graphemes(part)) {
      const c = cells(g);
      if (n + c > w) { cut = true; break; }
      out += g; n += c;
    }
    if (cut) break;
  }
  return out + (cut && coloured ? "\x1b[0m" : "") + " ".repeat(w - n);
}
/** Plain `s` in pieces of at most `w` cells. */
function wrap(s: string, w: number): string[] {
  const out: string[] = [];
  let cur = "", n = 0;
  for (const g of graphemes(s)) {
    const c = cells(g);
    if (n + c > w && cur) { out.push(cur); cur = ""; n = 0; }
    cur += g; n += c;
  }
  return [...out, cur];
}
/** File or child-process text made safe to print: no escape sequences or control characters, tabs as two spaces. */
const clean = (s: string) => s.replace(ANSI, "").replace(/\t/g, "  ").replace(/[\x00-\x1f\x7f]/g, "?");

// ── render ──
const COLOUR: Record<string, string> = { ok: "32", stale: "31", unrunnable: "33", "no examples": "2", checking: "36", error: "31", unchecked: "2" };
const WORST = ["error", "stale", "unrunnable", "checking", "unchecked", "no examples", "ok"];
const word = (f: Fn) => (f.busy ? "checking" : f.status ?? "unchecked");
const HELP = [
  "keys",
  "  up/down, j/k     move",
  "  enter            open or close a module",
  "  right / left     open a module / back to the module, close it",
  "  r                check the selected function or module again",
  "  R                check everything again",
  "  c                compile the selected stale function (openarc arc compile)",
  "  e                open the .arc file at the function in $EDITOR",
  "  /                filter by name (enter keeps it, esc clears it)",
  "  ?                this help; any key closes it",
  "  q, ctrl-c        quit",
];

/** An example or rule line in the form arcStatus names it: `example (3) => 9`, `rule bounded`. null for other lines. */
function named(line: string): string | null {
  const t = line.trim();
  if (t.startsWith("rule ")) return `rule ${/^rule\s+([\w$-]+)/.exec(t)?.[1] ?? ""}`;
  if (!t.startsWith("example")) return null;
  try {
    const e = parseArc(`module m from "m"\nfn f(): Any\n  ${t}\n`).fns[0]!.examples[0]!;
    return printExample({ ...e, name: undefined });
  } catch { return null; }
}

/** The right-hand pane: the selected function's `.arc` text, each unmet example or rule marked `!` and followed by what
 *  the code did (failLine). A module shows its header; `?` the keys. */
function detail(s: State, row: Row | undefined, w: number, c: (code: string, t: string) => string): string[] {
  type L = { text: string; code?: string; mark?: boolean };
  let ls: L[];
  if (s.help) ls = HELP.map((text) => ({ text }));
  else if (!row) ls = [{ text: s.filter ? `nothing matches /${s.filter}` : "no functions" }];
  else if (!row.fn) {
    const m = row.mod;
    ls = [{ text: m.path }, ...(m.error ? [{ text: `error: ${m.error}`, code: COLOUR.error, mark: true }] : m.head.map((text) => ({ text })))];
  } else {
    const f = row.fn, failing = [...(f.failing ?? [])];
    ls = [{ text: `${f.id}  ${word(f)}  ${row.mod.path}:${f.line}`, code: COLOUR[word(f)] }];
    if (f.status === "unrunnable" && f.why) ls.push({ text: `unrunnable: ${f.why}`, code: COLOUR.unrunnable, mark: true });
    for (const text of f.text) {
      const n = named(text), mine = n === null ? [] : failing.filter((x) => x.example === n);
      ls.push({ text, ...(mine.length ? { mark: true } : {}) });
      for (const x of mine) { ls.push({ text: `  ${failLine(x)}`, code: COLOUR.stale }); failing.splice(failing.indexOf(x), 1); }
    }
    for (const x of failing) ls.push({ text: failLine(x), code: COLOUR.stale, mark: true }); // a line written another way
  }
  return ls.flatMap((l) => wrap(clean(l.text), Math.max(1, w - 2)).map((piece, i) => `${i === 0 && l.mark ? c(COLOUR.stale!, "!") : " "} ${l.code ? c(l.code, piece) : piece}`));
}

/** One frame, every line exactly `width` cells. height Infinity (`--once`): everything, no key or log lines. */
export function render(s: State, width: number, height = Infinity): string[] {
  const c = (code: string, t: string) => (s.color ? `\x1b[${code}m${t}\x1b[0m` : t);
  const all = s.mods.flatMap((m) => m.fns), count = (w: string) => all.filter((f) => word(f) === w).length;
  const busy = count("checking");
  const head = [...["ok", "stale", "unrunnable", "no examples"].map((w) => `${c(COLOUR[w]!, w)} ${count(w)}`), ...(busy ? [`${c(COLOUR.checking!, "checking")} ${busy}`] : []),
    ...(s.filter || s.typing ? [`filter /${s.filter}${s.typing ? "_" : ""}`] : [])].join("  ");
  const rs = rows(s), at = Math.max(0, rs.findIndex((r) => r.key === s.sel)), row = rs[at];
  const wide = width >= 80, L = wide ? Math.min(48, Math.max(24, Math.floor(width * 0.4))) : width, D = wide ? width - L - 2 : width;
  const list = rs.map((r, i) => {
    const w = r.fn ? word(r.fn) : r.mod.error ? "error" : WORST.find((x) => r.mod.fns.some((f) => word(f) === x)) ?? "";
    const label = `${i === at ? ">" : " "} ${r.fn ? `  ${r.fn.name}` : `${r.mod.open || s.filter ? "-" : "+"} ${r.mod.name}`}`;
    return fit(clean(label), Math.max(0, L - visible(w) - 1)) + " " + (w ? c(COLOUR[w] ?? "0", w) : "");
  });
  const right = detail(s, row, D, c);
  const once = !Number.isFinite(height);
  const tail = once ? [] : [...["", "", ...s.log.map(clean)].slice(-2).map((l) => c("2", l)), "/ filter  r check  R check all  c compile  e edit  ? keys  q quit"];
  const body = once ? Infinity : Math.max(2, height - 1 - tail.length);
  let lines: string[];
  if (wide) {
    // the list scrolls to keep the selection in view; the detail shows its top
    const off = once ? 0 : Math.max(0, at - body + 1), n = once ? Math.max(list.length, right.length) : body;
    lines = Array.from({ length: n }, (_, i) => `${list[off + i] ?? " ".repeat(L)}${c("2", "│")} ${right[i] ?? ""}`);
  } else {
    const lh = once ? list.length : Math.min(list.length, Math.max(3, Math.floor(body * 0.4))), off = Math.max(0, at - lh + 1);
    const pane = [...list.slice(off, off + lh), c("2", "─".repeat(width)), ...right];
    lines = once ? pane : Array.from({ length: body }, (_, i) => pane[i] ?? "");
  }
  return [head, ...lines, ...tail].map((l) => fit(l, width));
}

// ── child processes ──
/** The argv of a check or a compile: the same CLI (`cli`: node, its flags, main.ts) as `openarc arc status|compile`. */
export const jobArgv = (cli: string[], out: string, w: Exclude<Want, { kind: "edit" }>): string[] =>
  w.kind === "check" ? [...cli, "arc", "status", ...(w.target ? [w.target] : []), "--json", `--out=${out}`] : [...cli, "arc", "compile", w.id, `--out=${out}`];

type Spawn = (cmd: string, args: string[], opts: { cwd: string; stdio: ["ignore", "pipe", "pipe"] }) => Pick<ChildProcess, "stdout" | "stderr" | "on" | "kill">;
/** Run `argv` in `cwd`, each output line to onLine, then onDone with the exit code (null when it could not start). */
export function runJob(spawn: Spawn, argv: string[], cwd: string, onLine: (line: string, err: boolean) => void, onDone: (code: number | null) => void) {
  const kid = spawn(argv[0]!, argv.slice(1), { cwd, stdio: ["ignore", "pipe", "pipe"] });
  for (const [st, err] of [[kid.stdout, false], [kid.stderr, true]] as const) {
    let buf = "";
    st?.setEncoding("utf8");
    st?.on("data", (d: string) => { const parts = (buf + d).split("\n"); buf = parts.pop()!; parts.forEach((l) => onLine(l, err)); });
    st?.on("end", () => buf && onLine(buf, err));
  }
  let done = false;
  kid.on("error", (e: Error) => { if (!done) { done = true; onLine(e.message, true); onDone(null); } });
  kid.on("close", (code: number | null) => { if (!done) { done = true; onDone(code); } });
  return kid;
}

// ── the shell ──
/** Colour only on a terminal, and never when NO_COLOR is set to anything (no-color.org). */
export const useColor = (env: NodeJS.ProcessEnv, tty: boolean): boolean => tty && !env.NO_COLOR;

export interface ViewOpts { module?: string; once: boolean; width?: number; cli: string[] }

/** `openarc view`: exit 1 when `--once` finds a stale function, or when there is nothing to show. */
export async function view(ctx: ArcCtx, o: ViewOpts): Promise<number> {
  const read = async () => {
    const files: { path: string; text: string }[] = [];
    for (const path of await walk(ctx.ports, ctx.out, [], (n) => n.endsWith(".arc"))) files.push({ path, text: (await ctx.ports.fs.read(path)) ?? "" });
    return files;
  };
  const only = (ms: Mod[]) => (o.module ? ms.filter((m) => m.name === o.module) : ms);
  let s = initState(only(loadModules(await read())), useColor(process.env, !!process.stdout.isTTY));
  if (!s.mods.length) return console.error(o.module ? `openarc: no module ${o.module} in ${ctx.out}` : `openarc: no .arc files under ${ctx.out}; \`openarc decompile\` writes them`), 1;
  s.sel = s.mods[0]!.path;
  if (o.once || !process.stdout.isTTY || !process.stdin.isTTY) {
    s = applyRows(s, o.module ?? "", await arcStatus(ctx, o.module));
    const fns = s.mods.flatMap((m) => m.fns);
    s.sel = (fns.find((f) => f.status === "stale") ?? fns[0])?.id ?? s.sel;
    for (const l of render(s, o.width ?? process.stdout.columns ?? 100)) console.log(l.trimEnd());
    return fns.some((f) => f.status === "stale") ? 1 : 0;
  }
  return interactive(ctx, o, s, async (prev) => only(loadModules(await read(), prev)));
}

/** The key names of a chunk of raw terminal input. */
export const keysOf = (data: string): string[] =>
  [...data.matchAll(/\x1bO[A-D]|\x1b\[[0-9;]*[~A-Za-z]|[^]/gu)].map(([k]) =>
    ({ "\x1b[A": "up", "\x1bOA": "up", "\x1b[B": "down", "\x1bOB": "down", "\x1b[C": "right", "\x1bOC": "right", "\x1b[D": "left", "\x1bOD": "left", "\x1b": "esc", "\r": "enter", "\n": "enter", "\x7f": "backspace", "\x08": "backspace", "\x03": "ctrl-c" } as Record<string, string>)[k] ?? (k.startsWith("\x1b") ? "" : k));

function interactive(ctx: ArcCtx, o: ViewOpts, first: State, reload: (prev: Mod[]) => Promise<Mod[]>): Promise<number> {
  let s = first;
  const out = process.stdout, inp = process.stdin, spawn = nodeSpawn as unknown as Spawn;
  const kids = new Set<ReturnType<Spawn>>();
  let q: WatchQueue = { pending: [], running: null, rerun: [] }, restored = false, timer: NodeJS.Timeout | undefined;
  const changed = new Set<string>();
  const draw = () => { if (!restored) out.write(render(s, out.columns || 80, out.rows || 24).map((l, i) => `\x1b[${i + 1};1H${l}`).join("")); };
  const restore = () => {
    if (restored) return;
    restored = true;
    try { inp.setRawMode(false); } catch { /* not a TTY any more */ }
    out.write("\x1b[0m\x1b[?25h\x1b[?1049l");
  };
  // one check at a time (watch.ts's queue): `*` is everything, else a module or a function
  const pump = () => {
    if (q.running) return;
    const t = takeNext(q);
    q = t.queue;
    if (t.next === null) return;
    const target = t.next === "*" ? "" : t.next;
    let json = "";
    const kid = runJob(spawn, jobArgv(o.cli, ctx.out, { kind: "check", target }), ctx.root, (l, err) => (err ? (s = log(s, clean(l))) : (json += l)), () => {
      kids.delete(kid);
      let rows: ArcRow[] = [];
      try { rows = (JSON.parse(json) as { fns: ArcRow[] }).fns; } catch { s = log(s, `check ${target || "all"}: no result`); }
      s = applyRows(s, target, rows);
      q = { ...q, running: null };
      draw();
      pump();
    });
    kids.add(kid);
  };
  const check = (targets: string[]) => {
    for (const t of targets) s = markBusy(s, t);
    q = enqueue(q, targets.map((t) => t || "*"));
    pump();
  };
  const dirs = [...new Set([ctx.out, ...first.mods.map((m) => m.file.split("/")[0]!).filter(Boolean)])].filter((d) => existsSync(resolve(ctx.root, d)));
  // ponytail: a module is re-checked when its own `.arc` or source file changes, not a file its source imports; a source
  // directory that appears after start is not watched
  const dw = watchDirs(ctx.root, dirs, (p) => {
    changed.add(p);
    clearTimeout(timer);
    timer = setTimeout(() => void flush(), 300);
  });
  const flush = async () => {
    const ps = [...changed];
    changed.clear();
    try {
      if (ps.some((p) => p.endsWith(".arc"))) s = { ...s, mods: await reload(s.mods) };
      check([...new Set(s.mods.filter((m) => ps.includes(m.path) || ps.includes(m.file)).map((m) => m.name))]);
    } catch (e) { s = log(s, (e as Error).message); }
    draw();
  };
  const edit = (path: string, line: number) => {
    const ed = process.env.EDITOR;
    if (!ed) return void (s = log(s, "e: set $EDITOR to open the file"));
    inp.pause();
    inp.setRawMode(false);
    out.write("\x1b[0m\x1b[?25h\x1b[?1049l");
    // ponytail: `$EDITOR +<line> <file>` through sh, the vi/emacs/nano convention; POSIX only
    spawnSync("sh", ["-c", `${ed} "$@"`, "sh", `+${line}`, resolve(ctx.root, path)], { stdio: "inherit" });
    out.write("\x1b[?1049h\x1b[?25l\x1b[2J");
    inp.setRawMode(true);
    inp.resume();
  };
  return new Promise<number>((done) => {
    const finish = (code: number) => {
      restore();
      clearTimeout(timer);
      dw.close();
      for (const k of kids) k.kill();
      inp.off("data", onData);
      out.off("resize", draw);
      for (const sig of ["SIGTERM", "SIGHUP", "SIGINT"] as const) process.off(sig, onSignal);
      process.off("exit", restore);
      process.off("uncaughtException", onCrash);
      inp.pause();
      done(code);
    };
    const onSignal = (sig: NodeJS.Signals) => finish(sig === "SIGINT" ? 130 : 143);
    const onCrash = (e: Error) => { finish(1); console.error(e); process.exit(1); };
    const onData = (data: string) => {
      for (const k of keysOf(data)) {
        s = reduce(s, k);
        if (s.quit) return finish(0);
        const wants = s.want;
        s = { ...s, want: [] };
        for (const w of wants) {
          if (w.kind === "check") check([w.target || (o.module ?? "")]);
          else if (w.kind === "edit") edit(w.path, w.line);
          else {
            const mod = s.mods.find((m) => m.fns.some((f) => f.id === w.id))!.name;
            const kid = runJob(spawn, jobArgv(o.cli, ctx.out, w), ctx.root, (l) => { s = log(s, clean(l)); draw(); }, (code) => {
              kids.delete(kid);
              s = log(s, `compile ${w.id}: ${code === 0 ? "done" : `exit ${code}`}`);
              dw.rewatch(); // the commit replaced the file by rename (dirwatch.ts)
              check([mod]);
              draw();
            });
            kids.add(kid);
          }
        }
      }
      draw();
    };
    process.on("exit", restore);
    process.on("uncaughtException", onCrash);
    for (const sig of ["SIGTERM", "SIGHUP", "SIGINT"] as const) process.on(sig, onSignal);
    out.write("\x1b[?1049h\x1b[?25l\x1b[2J");
    inp.setRawMode(true);
    inp.setEncoding("utf8");
    inp.on("data", onData);
    inp.resume();
    out.on("resize", draw);
    check([o.module ?? ""]);
    draw();
  });
}
