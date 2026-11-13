// The `.arc` program design language (docs/wiki/PDL.md), v0: pseudocode organised around meaning, in C/JS shape. Files
// live under `arc/features/`; this module is pure (no I/O). A file is blocks, `<header> { <items> }`; an item is a block
// or a statement, the text up to a `;` outside strings, parentheses, brackets and braces. Most statements are free
// sentences; a few forms are exact (classify). The parser is tolerant: it never throws and always returns a tree; the
// only diagnostics are structural (unbalanced braces, an unterminated string or block comment, a missing `;`).
//
// Round trip: every byte of the input lands in exactly one node, as raw text (trivia, statement, block header, close,
// stray `}`), and print concatenates them in order, so print(parse(x)) === x for any x. Meaning (kind, names, calls)
// is derived from the raw text and stored beside it; nothing is printed from the derived fields.
//
// Keyword versus sentence: a statement is an exact form only when the WHOLE statement fits that form's pattern; a
// sentence that merely starts with the keyword stays a sentence. `uses` takes a comma list of single names, `source`
// and `fail` take string literals only, `example` takes `name(...)` then `=> value` or `throws "text"`, `check` takes an
// expression with no two plain words in a row outside parentheses, brackets and strings (`check total >= 0` is a
// check, `check the totals daily` a sentence). `initial`, `final` and transitions count only inside `state`; `on` and
// `visible when` only inside `screen`. Keywords are case-sensitive.

// ── lexing: whitespace, comments, strings, single characters ──
interface Tok { k: "ws" | "lc" | "bc" | "str" | "ch"; s: number; e: number; bad?: true }

/** The token at `i`. A string ends at its closing quote or, unterminated, at the end of its line. */
function tok(t: string, i: number): Tok {
  const c = t[i]!;
  if (/\s/.test(c)) { let e = i + 1; while (e < t.length && /\s/.test(t[e]!)) e++; return { k: "ws", s: i, e }; }
  if (c === "/" && t[i + 1] === "/") { const e = t.indexOf("\n", i); return { k: "lc", s: i, e: e < 0 ? t.length : e }; }
  if (c === "/" && t[i + 1] === "*") { const j = t.indexOf("*/", i + 2); return j < 0 ? { k: "bc", s: i, e: t.length, bad: true } : { k: "bc", s: i, e: j + 2 }; }
  if (c === '"') {
    let e = i + 1;
    while (e < t.length && t[e] !== '"' && t[e] !== "\n") e += t[e] === "\\" ? 2 : 1;
    return t[e] === '"' ? { k: "str", s: i, e: e + 1 } : { k: "str", s: i, e: Math.min(e, t.length), bad: true };
  }
  return { k: "ch", s: i, e: i + 1 };
}

function* toks(t: string): Generator<Tok> { for (let i = 0; i < t.length;) { const k = tok(t, i); yield k; i = k.e; } }

/** The text without comments, whitespace runs outside strings as one space, trimmed. */
export function clean(t: string): string {
  let out = "", sp = false;
  for (const k of toks(t)) {
    if (k.k === "ws" || k.k === "lc" || k.k === "bc") { if (!sp) out += " "; sp = true; }
    else { out += t.slice(k.s, k.e); sp = false; }
  }
  return out.trim();
}

/** `s` with everything inside strings and inside ()[]{} groups blanked to spaces (same length), so a pattern run on it
 *  sees only the top level. A group's own delimiters and a string's quotes are kept. */
function mask(s: string): string {
  let out = "", depth = 0;
  for (const k of toks(s)) {
    const raw = s.slice(k.s, k.e);
    if (k.k === "str") out += depth ? " ".repeat(raw.length) : `"${" ".repeat(Math.max(0, raw.length - 2))}${raw.length > 1 ? '"' : ""}`;
    else if (k.k !== "ch") out += " ".repeat(raw.length);
    else if ("([{".includes(raw)) out += depth++ ? " " : raw;
    else if (")]}".includes(raw)) out += depth && --depth ? " " : raw;
    else out += depth ? " " : raw;
  }
  return out;
}

// ── the tree ──
export type StmtKind = "sentence" | "uses" | "source" | "example" | "check" | "fail" | "initial" | "final" | "transition" | "on" | "visible";
export type BlockKind = "feature" | "assume" | "state" | "rule" | "screen" | "function" | "if" | "else" | "else if" | "for each" | "while" | "unknown";
export interface Trivia { t: "trivia"; raw: string; start: number }
export interface Stray { t: "stray"; raw: string; start: number; line: number }
/** text: the statement without its `;`, comments and extra whitespace. names: `uses` names, `initial`/`final` states,
 *  `visible when` states. calls: the function names a transition (trigger, `when`, `then`) or an `on` names with the
 *  `name(...)` shape. */
export interface Stmt {
  t: "stmt"; raw: string; start: number; line: number; terminated: boolean; text: string; kind: StmtKind;
  names?: string[]; external?: boolean; paths?: string[]; call?: string; value?: string; throws?: string; expr?: string; message?: string;
  from?: string; to?: string; trigger?: string; when?: string; then?: string; event?: string; machine?: string; calls?: string[];
}
/** head: the raw header through its `{`; close: `}`, or "" when the block is never closed. */
export interface Block {
  t: "block"; head: string; close: string; start: number; end: number; line: number; kind: BlockKind; header: string;
  name?: string; cond?: string; params?: string; paramList?: { name: string; type?: string }[]; type?: string; items: Node[];
}
export type Node = Trivia | Stray | Stmt | Block;
export interface Diag { line: number; text: string }
export interface Tree { items: Node[]; diagnostics: Diag[] }

export const CONTROL: readonly BlockKind[] = ["if", "else", "else if", "for each", "while"];
const ID = "[A-Za-z_$][\\w$]*";
const STR = '"(?:[^"\\\\]|\\\\.)*"';
const strings = (s: string) => [...s.matchAll(new RegExp(STR, "g"))].map((m) => JSON.parse(m[0]) as string);
const idList = (s: string) => s.split(",").map((x) => x.trim());
/** `name(...)`: the name, else null. */
const callName = (s: string): string | null => /^([A-Za-z_$][\w$.]*)\( *\)$/.exec(mask(s.trim()))?.[1] ?? null;
/** The index of `word` at the top level of `s` (outside strings and groups), as a whole word, else -1. */
const topWord = (s: string, word: string) => mask(s).search(new RegExp(`(?<![\\w$])${word}(?![\\w$])`));

/** What a header says: `feature X`, `assume`, `state X`, `rule x()`, `screen X()`, control blocks, `name(params): T`. */
function classifyHead(h: string): Pick<Block, "kind" | "name" | "cond" | "params" | "paramList" | "type"> {
  let m: RegExpExecArray | null;
  const mk = mask(h), inner = () => h.slice(h.indexOf("(") + 1, mk.lastIndexOf(")")).trim();
  if (/^else\s+if\s*\( *\)$/.test(mk)) return { kind: "else if", cond: inner() };
  if (h === "else") return { kind: "else" };
  if ((m = /^(if|while|for\s+each)\s*\( *\)$/.exec(mk))) return { kind: m[1]!.startsWith("for") ? "for each" : (m[1] as "if" | "while"), cond: inner() };
  if ((m = new RegExp(`^feature\\s+(${ID})$`).exec(h))) return { kind: "feature", name: m[1]! };
  if (h === "assume") return { kind: "assume", name: "assume" };
  if ((m = new RegExp(`^state\\s+(${ID})$`).exec(h))) return { kind: "state", name: m[1]! };
  if ((m = new RegExp(`^(rule|screen)\\s+(${ID})(?:\\s*\\(\\s*\\))?$`).exec(h))) return { kind: m[1] as "rule" | "screen", name: m[2]! };
  if ((m = new RegExp(`^(${ID}(?:\\.${ID})*)\\s*\\( *\\)\\s*(:\\s*\\S.*)?$`, "s").exec(mk))) {
    const close = mk.indexOf(")"), params = h.slice(h.indexOf("(") + 1, close).trim();
    const paramList = params ? splitTop(params).map((p) => { const x = /^([^:]+?)\s*:\s*(.+)$/s.exec(p); return x ? { name: x[1]!, type: x[2]! } : { name: p }; }) : [];
    return { kind: "function", name: m[1]!, params, paramList, ...(m[2] ? { type: h.slice(mk.indexOf(":", close) + 1).trim() } : {}) };
  }
  return { kind: "unknown" };
}

/** Split at top-level commas. */
function splitTop(s: string): string[] {
  const m = mask(s), out: string[] = [];
  let from = 0;
  for (let i = 0; i <= s.length; i++) if (i === s.length || m[i] === ",") { out.push(s.slice(from, i).trim()); from = i + 1; }
  return out.filter(Boolean);
}

/** The exact form `text` fits inside a block of kind `parent`, else a sentence (see the header comment). */
export function classify(text: string, parent: BlockKind | null): Omit<Stmt, "t" | "raw" | "start" | "line" | "terminated" | "text"> {
  let m: RegExpExecArray | null;
  const NAME = "[A-Za-z_$@][\\w$@./-]*";
  if ((m = new RegExp(`^uses(\\s+external)?\\s+(${NAME}(?:\\s*,\\s*${NAME})*)$`).exec(text))) return { kind: "uses", names: idList(m[2]!), ...(m[1] ? { external: true } : {}) };
  if ((m = new RegExp(`^source\\s+(${STR}(?:\\s*,\\s*${STR})*)$`).exec(text))) return { kind: "source", paths: strings(m[1]!) };
  if ((m = new RegExp(`^fail\\s+(${STR})$`).exec(text))) return { kind: "fail", message: strings(m[1]!)[0]! };
  if ((m = /^example\s+(.+)$/s.exec(text))) {
    const r = m[1]!, c = /^[A-Za-z_$][\w$.]*\( *\)/.exec(mask(r));
    const after = c ? r.slice(c[0].length) : "";
    const v = /^\s*=>\s*(\S.*)$/s.exec(after), th = new RegExp(`^\\s*throws\\s+(${STR})$`).exec(after);
    if (c && v) return { kind: "example", call: r.slice(0, c[0].length), value: v[1]!.trim() };
    if (c && th) return { kind: "example", call: r.slice(0, c[0].length), throws: strings(th[1]!)[0]! };
  }
  if ((m = /^check\s+(.+)$/s.exec(text)) && !/[A-Za-z_$][\w$]*\s+[A-Za-z_$]/.test(mask(m[1]!))) return { kind: "check", expr: m[1]!.trim() };
  if (parent === "state") {
    if ((m = new RegExp(`^initial\\s+(${ID})$`).exec(text))) return { kind: "initial", names: [m[1]!] };
    if ((m = new RegExp(`^final\\s+(${ID}(?:\\s*,\\s*${ID})*)$`).exec(text))) return { kind: "final", names: idList(m[1]!) };
    if ((m = new RegExp(`^(${ID})\\s*->\\s*(${ID})\\s*:\\s*(\\S.*)$`, "s").exec(text))) {
      let rest = m[3]!, then: string | undefined, when: string | undefined;
      const t = topWord(rest, "then");
      if (t > 0) { then = rest.slice(t + 4).trim(); rest = rest.slice(0, t); }
      const w = topWord(rest, "when");
      if (w > 0) { when = rest.slice(w + 4).trim(); rest = rest.slice(0, w); }
      const trigger = rest.trim();
      if (trigger && when !== "" && then !== "") {
        const calls = [trigger, when, then].flatMap((x) => (x && callName(x) ? [callName(x)!] : []));
        return { kind: "transition", from: m[1]!, to: m[2]!, trigger, ...(when ? { when } : {}), ...(then ? { then } : {}), calls };
      }
    }
  }
  if (parent === "screen") {
    if ((m = new RegExp(`^on\\s+(${ID}(?:\\.${ID})*)\\s*->\\s*(\\S.*)$`, "s").exec(text)) && callName(m[2]!))
      return { kind: "on", event: m[1]!, call: m[2]!.trim(), calls: [callName(m[2]!)!] };
    if ((m = new RegExp(`^visible\\s+when\\s+(${ID})\\s+in\\s*\\(\\s*(${ID}(?:\\s*,\\s*${ID})*)\\s*\\)$`).exec(text))) return { kind: "visible", machine: m[1]!, names: idList(m[2]!) };
  }
  return { kind: "sentence" };
}

// ── parse and print ──
/** Parse one file. Never throws. */
export function parse(text: string): Tree {
  const nl: number[] = [];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") nl.push(i);
  const lineAt = (off: number) => { let lo = 0, hi = nl.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (nl[mid]! < off) lo = mid + 1; else hi = mid; } return lo + 1; };
  const diagnostics: Diag[] = [];
  const diag = (off: number, t: string) => diagnostics.push({ line: lineAt(off), text: t });
  let i = 0;

  const items = (parent: BlockKind | null, top: boolean): Node[] => {
    const out: Node[] = [];
    while (i < text.length) {
      const s = i;
      for (let k = tok(text, i); k.k === "ws" || k.k === "lc" || k.k === "bc"; k = tok(text, i)) {
        if (k.bad) diag(k.s, "a block comment is never closed: add */");
        i = k.e;
        if (i >= text.length) break;
      }
      if (i > s) out.push({ t: "trivia", raw: text.slice(s, i), start: s });
      if (i >= text.length) break;
      if (text[i] === "}") {
        if (!top) return out;
        diag(i, "this } closes no block: remove it, or add the block it was meant to close");
        out.push({ t: "stray", raw: "}", start: i, line: lineAt(i) });
        i++;
        continue;
      }
      out.push(chunk(parent));
    }
    return out;
  };

  /** One statement or block, starting at a non-trivia character. */
  const chunk = (parent: BlockKind | null): Stmt | Block => {
    const s = i;
    let depth = 0, last = -1; // last: the previous significant character
    const stmt = (end: number, terminated: boolean): Stmt => {
      const raw = text.slice(s, end), body = clean(terminated ? raw.slice(0, -1) : raw);
      return { t: "stmt", raw, start: s, line: lineAt(s), terminated, text: body, ...classify(body, parent) };
    };
    while (i < text.length) {
      const k = tok(text, i);
      if (k.bad) diag(k.s, k.k === "str" ? "a string is never closed: add the closing quote on the same line" : "a block comment is never closed: add */");
      if (k.k !== "ch") { if (k.k === "str") last = k.e - 1; i = k.e; continue; }
      const c = text[i]!;
      if (c === "(" || c === "[") depth++;
      else if (c === ")" || c === "]") depth = Math.max(0, depth - 1);
      else if (c === ";" && !depth) { i++; return stmt(i, true); }
      else if (c === "}") {
        if (depth) depth--;
        else {
          const end = s + text.slice(s, i).trimEnd().length;
          diag(s, "this statement has no ; before the } that follows it: add ;");
          i = end;
          return stmt(end, false);
        }
      } else if (c === "{") {
        // an object literal, not a block: after = : , ( [ or =>, inside a group, or in an example or check
        const objectLike = depth || (last >= 0 && ("=:,([".includes(text[last]!) || (text[last] === ">" && text[last - 1] === "="))) || /^(example|check)\s/.test(text.slice(s, i));
        if (objectLike) depth++;
        else {
          const head = text.slice(s, i + 1), header = clean(head.slice(0, -1));
          i++;
          const b = classifyHead(header);
          const kids = items(b.kind, false);
          const close = text[i] === "}" ? "}" : "";
          if (close) i++;
          else diag(s, `the block \`${header}\` is never closed: add }`);
          return { t: "block", head, close, start: s, end: i, line: lineAt(s), header, ...b, items: kids };
        }
      }
      last = i;
      i++;
    }
    diag(s, "the last statement has no ;: add ;");
    return stmt(i, false);
  };

  return { items: items(null, true), diagnostics };
}

export const printNode = (n: Node): string => (n.t === "block" ? n.head + n.items.map(printNode).join("") + n.close : n.raw);
/** The exact text parse read: print(parse(x)) === x. */
export const print = (tree: Tree): string => tree.items.map(printNode).join("");

// ── format ──
/** A statement or header in one line: whitespace runs to one space, except the run after a `//` comment, which becomes
 *  a line break and continuation indent (else the comment would swallow the rest). Tokens are kept as they are. */
function oneLine(raw: string, pad: string): string {
  let out = "", prev: Tok | null = null;
  for (const k of toks(raw)) {
    out += k.k === "ws" ? (prev?.k === "lc" ? `\n${pad}  ` : " ") : raw.slice(k.s, k.e);
    prev = k;
  }
  return out.trim();
}

/** Canonical layout: 2-space indent, one statement per line, a blank line around each non-control block, comments kept
 *  (one on the line of what precedes it stays there), at most one blank line where the author had one, `} else {`.
 *  Idempotent; statement tokens are never changed. A file with structural diagnostics is returned unchanged. */
export function format(text: string): string {
  const tree = parse(text);
  if (tree.diagnostics.length) return text;
  const lines: string[] = [];
  emit(tree.items, 0, lines, true);
  return lines.length ? lines.join("\n") + "\n" : "";
}

function emit(items: Node[], depth: number, lines: string[], top: boolean): void {
  const pad = "  ".repeat(depth);
  let first = true, nl = 0, forceBlank = false, joinable = false, run = -1; // run: where the comment lines just above start
  const startLen = lines.length;
  const blank = () => { if (!first && lines[lines.length - 1] !== "") lines.push(""); };
  for (const n of items) {
    if (n.t === "trivia") {
      for (const k of toks(n.raw)) {
        if (k.k === "ws") { nl += (n.raw.slice(k.s, k.e).match(/\n/g) ?? []).length; continue; }
        const c = n.raw.slice(k.s, k.e);
        if (!nl && (!top || lines.length > startLen)) lines[lines.length - 1] += ` ${c}`; // on the line of what precedes it
        else {
          if (nl >= 2 || forceBlank) blank();
          if (run < 0 || nl >= 2 || forceBlank) run = lines.length;
          lines.push(pad + c);
          first = forceBlank = false;
        }
        nl = 0;
        joinable = false;
      }
      continue;
    }
    if (n.t === "stray") continue; // only in files with diagnostics, which format leaves alone
    if (n.t === "stmt") {
      if (nl >= 2 || forceBlank) blank();
      lines.push(pad + oneLine(n.raw, pad));
      forceBlank = joinable = false;
      run = -1;
    } else {
      const control = CONTROL.includes(n.kind);
      const h = oneLine(n.head.slice(0, -1), pad), head = !h ? "{" : /\/\/[^\n]*$/.test(h) ? `${h}\n${pad}{` : `${h} {`;
      if (joinable && (n.kind === "else" || n.kind === "else if")) lines[lines.length - 1] += ` ${head}`;
      else if (run >= 0 && nl < 2 && !control) { // the comment lines right above belong to the block: the blank goes above them
        if (run > startLen && lines[run - 1] !== "") lines.splice(run, 0, "");
        lines.push(pad + head);
      } else { if (nl >= 2 || forceBlank || !control) blank(); lines.push(pad + head); }
      if (n.items.every((x) => x.t === "trivia" && !x.raw.trim())) lines[lines.length - 1] += "}";
      else { emit(n.items, depth + 1, lines, false); lines.push(pad + "}"); }
      forceBlank = !control;
      joinable = n.kind === "if" || n.kind === "else if";
      run = -1;
    }
    first = false;
    nl = 0;
  }
  while (lines.length > startLen && lines[lines.length - 1] === "") lines.pop();
}

// ── blocks and lint ──
/** A block with an id: `Feature`, `Feature.assume`, `Feature.<name>`; outside a feature, its name. Control and unknown
 *  blocks have none (they belong to the block around them). feature: the enclosing feature block, if any. */
export interface BlockInfo { id: string; kind: BlockKind; header: string; start: number; end: number; line: number; node: Block; feature: Block | null }

export function blocks(tree: Tree): BlockInfo[] {
  const out: BlockInfo[] = [];
  const walk = (ns: Node[], feature: Block | null) => {
    for (const n of ns) {
      if (n.t !== "block") continue;
      if (n.name !== undefined) // the kinds with a name are the kinds with an id
        out.push({ id: feature ? `${feature.name}.${n.name}` : n.name, kind: n.kind, header: n.header, start: n.start, end: n.end, line: n.line, node: n, feature });
      walk(n.items, feature ?? (n.kind === "feature" ? n : null));
    }
  };
  walk(tree.items, null);
  return out;
}

/** Every statement under `ns`, nested blocks included. */
export const stmtsDeep = (ns: Node[]): Stmt[] => ns.flatMap((n) => (n.t === "stmt" ? [n] : n.t === "block" ? stmtsDeep(n.items) : []));
/** The statements directly in `b`. */
export const stmtsOf = (b: Block): Stmt[] => b.items.filter((n): n is Stmt => n.t === "stmt");

export interface Finding { id?: string; line: number; file: string; level: "error" | "note"; text: string }

/** Duplicate ids, state machines that contradict themselves, and (notes) calls to functions the feature does not hold. */
export function lint(trees: { file: string; tree: Tree }[]): Finding[] {
  const out: Finding[] = [], seen = new Map<string, { file: string; line: number }>();
  for (const { file, tree } of trees) {
    const all = blocks(tree);
    for (const b of all) {
      const was = seen.get(b.id);
      if (was) out.push({ id: b.id, file, line: b.line, level: "error", text: `${file}:${b.line}: the block id ${b.id} is already used at ${was.file}:${was.line}; rename one of the two blocks.` });
      else seen.set(b.id, { file, line: b.line });
    }
    for (const f of all.filter((b) => b.kind === "feature")) {
      const mine = all.filter((b) => b.feature === f.node);
      const fns = new Set(mine.filter((b) => b.kind === "function").map((b) => b.node.name!));
      const machines = new Map(mine.filter((b) => b.kind === "state").map((b) => [b.node.name!, b]));
      const err = (id: string, line: number, text: string) => out.push({ id, file, line, level: "error", text: `${file}:${line}: ${id}: ${text}` });
      const noteCall = (id: string, s: Stmt) => {
        for (const c of s.calls ?? []) if (c !== "after" && !fns.has(c))
          out.push({ id, file, line: s.line, level: "note", text: `${file}:${s.line}: ${id}: ${c}() has no function block in feature ${f.node.name}; add one, or say in assume what it does.` });
      };
      for (const m of machines.values()) {
        const ss = stmtsOf(m.node), tr = ss.filter((s) => s.kind === "transition");
        const initial = ss.filter((s) => s.kind === "initial"), finals = new Set(ss.filter((s) => s.kind === "final").flatMap((s) => s.names!));
        const known = new Set([...initial.flatMap((s) => s.names!), ...finals, ...tr.flatMap((s) => [s.from!, s.to!])]);
        if (initial.length > 1) for (const s of initial.slice(1)) err(m.id, s.line, `a second \`initial\` (${s.names![0]}); a machine starts in one state, keep one \`initial\` line.`);
        for (const s of tr) {
          if (finals.has(s.from!)) err(m.id, s.line, `${s.from} is final but has a transition to ${s.to}; remove the transition or the state from \`final\`.`);
          noteCall(m.id, s);
        }
        if (initial.length) {
          const reached = new Set([initial[0]!.names![0]!]);
          for (let grew = true; grew;) { grew = false; for (const s of tr) if (reached.has(s.from!) && !reached.has(s.to!)) { reached.add(s.to!); grew = true; } }
          for (const st of known) if (!reached.has(st)) err(m.id, (tr.find((s) => s.from === st || s.to === st) ?? ss.find((s) => s.names?.includes(st)) ?? m).line, `${st} cannot be reached from the initial state ${initial[0]!.names![0]}; add a transition into it, or fix the name if it is a typo.`);
        }
      }
      for (const sc of mine.filter((b) => b.kind === "screen")) {
        for (const s of stmtsDeep(sc.node.items)) {
          if (s.kind === "on") noteCall(sc.id, s);
          if (s.kind !== "visible") continue;
          const m = machines.get(s.machine!);
          if (!m) { err(sc.id, s.line, `\`visible when\` names ${s.machine}, but feature ${f.node.name} has no \`state ${s.machine}\` block; add it or fix the name.`); continue; }
          const ss = stmtsOf(m.node);
          const known = new Set(ss.flatMap((x) => (x.kind === "transition" ? [x.from!, x.to!] : x.kind === "initial" || x.kind === "final" ? x.names! : [])));
          for (const st of s.names!) if (!known.has(st)) err(sc.id, s.line, `\`visible when\` names the state ${st}, which machine ${s.machine} never mentions; use one of ${[...known].join(", ") || "its states"}, or add ${st} to the machine.`);
        }
      }
    }
  }
  return out;
}

/** The design text as hashed: comments dropped, whitespace runs to one space and none beside { } ;, so a reformat is not
 *  a change. */
// ponytail: the spaces beside { } ; inside a string literal go too, so such an edit alone is not seen as a change
export const designKey = (t: string): string => clean(t).replace(/ ?([{};]) ?/g, "$1");
/** Non-whitespace characters, comments excluded: the design size. */
export const designSize = (t: string): number => clean(t).replace(/\s/g, "").length;
/** A feature's own text: its header and direct statements, not its nested blocks. */
export const ownText = (b: Block): string => (b.kind === "feature" ? b.head + stmtsOf(b).map((s) => s.raw).join("\n") + b.close : printNode(b));
