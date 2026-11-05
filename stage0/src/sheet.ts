// The spec sheet: `openarc.spec.md`, one editable view of every region's intent and examples. Hand-written. The
// TypeScript stays the source of truth (JSDoc, arc.configure, defineRegion); `openarc sync` carries edits both ways.
// Pure: text in, text out, and render(parse(x)) === x for anything render wrote.
import type { Json } from "open-arc";

export const SHEET_FILE = "openarc.spec.md";

export interface Suggestion {
  kind: "intent" | "example" | "escalate";
  value: string; // intent: the new text; example: its line; escalate: the backend
  note?: string;
  checked: boolean;
}
export interface SheetRegion {
  id: string;
  file?: string; // required on a new section: where the function goes
  meta?: string; // generated, ignored on read: owner and status
  signature: string; // read-only for an existing region; `name(a: T): R` on a new section
  intent: string;
  examples: Json[];
  hold: boolean; // apply spec edits, but never regenerate the body
  notes: string[]; // generated, ignored on read
  suggestions: Suggestion[];
}
export interface Sheet {
  regions: SheetRegion[];
  notAdopted: { ref: string; checked: boolean }[]; // src/x.ts#fn
}

const HEADER = `<!-- OpenArc spec sheet. Edit intents and examples, tick suggestions, add a section for a new function, then save.
     openarc sync applies it to the code. Lines starting with > and comments are generated. -->`;
const parseJson = (s: string): { ok: boolean; v?: Json } => {
  try {
    return { ok: true, v: JSON.parse(s) as Json };
  } catch {
    return { ok: false };
  }
};

/** One example as a line: `[1, 2] -> 3 # name`, or `raw {...}` when it has fields besides args, expected and name. */
export function exampleLine(e: Json): string {
  const o = e as { args?: Json; expected?: Json; name?: unknown };
  const plain = e !== null && typeof e === "object" && !Array.isArray(e) && Array.isArray(o.args) && "expected" in o
    && Object.keys(o).every((k) => k === "args" || k === "expected" || k === "name") && (o.name === undefined || (typeof o.name === "string" && !o.name.includes("\n")));
  if (!plain) return `raw ${JSON.stringify(e)}`;
  return `${JSON.stringify(o.args)} -> ${JSON.stringify(o.expected)}${o.name ? ` # ${o.name}` : ""}`;
}
/** The inverse; null for a line it can't read. A " -> " or " # " inside a JSON string is fine: each split is tried. */
export function readExample(line: string): Json | null {
  if (line.startsWith("raw ")) return parseJson(line.slice(4)).ok ? parseJson(line.slice(4)).v! : null;
  for (let i = line.indexOf(" -> "); i >= 0; i = line.indexOf(" -> ", i + 1)) {
    const args = parseJson(line.slice(0, i));
    if (!args.ok || !Array.isArray(args.v)) continue;
    const rest = line.slice(i + 4);
    const whole = parseJson(rest);
    if (whole.ok) return { args: args.v, expected: whole.v! };
    for (let k = rest.indexOf(" # "); k >= 0; k = rest.indexOf(" # ", k + 1)) {
      const expected = parseJson(rest.slice(0, k));
      if (expected.ok) return { name: rest.slice(k + 3), args: args.v, expected: expected.v! };
    }
  }
  return null;
}

export function renderSheet(s: Sheet): string {
  const out = [HEADER, ""];
  for (const r of s.regions) {
    out.push(`## ${r.id}`);
    out.push(`<!-- ${r.file ? `file: ${r.file}` : ""}${r.meta ? ` | ${r.meta}` : ""} -->`);
    out.push(`\`${r.signature}\``, "");
    if (r.intent) out.push(r.intent, "");
    if (r.hold) out.push("**Hold**", "");
    if (r.examples.length) {
      out.push("**Examples**");
      for (const e of r.examples) out.push(`- ${exampleLine(e)}`);
      out.push("");
    }
    for (const n of r.notes) out.push(`> ${n}`);
    if (r.notes.length) out.push("");
    if (r.suggestions.length) {
      out.push("**Suggestions**");
      for (const g of r.suggestions) out.push(`- [${g.checked ? "x" : " "}] ${g.kind}: ${g.value}${g.note ? ` <!-- ${g.note} -->` : ""}`);
      out.push("");
    }
  }
  if (s.notAdopted.length) {
    out.push("## Not adopted", "");
    for (const n of s.notAdopted) out.push(`- [${n.checked ? "x" : " "}] ${n.ref}`);
    out.push("");
  }
  return out.join("\n");
}

/** Reads a saved sheet; every unreadable line is an error, and a sheet with errors is never applied or overwritten. */
export function parseSheet(text: string): { sheet: Sheet; errors: string[] } {
  const sheet: Sheet = { regions: [], notAdopted: [] };
  const errors: string[] = [];
  let r: SheetRegion | null = null;
  let mode: "none" | "intent" | "examples" | "suggestions" | "adopt" = "none";
  let intent: string[] = [];
  const close = () => {
    if (r) r.intent = intent.join("\n").trim();
    intent = [];
  };
  text.split("\n").forEach((raw, i) => {
    const line = raw.trimEnd();
    const at = `line ${i + 1}`;
    if (line.startsWith("## ")) {
      close();
      const id = line.slice(3).trim();
      if (id === "Not adopted") {
        r = null;
        mode = "adopt";
        return;
      }
      r = { id, signature: "", intent: "", examples: [], hold: false, notes: [], suggestions: [] };
      sheet.regions.push(r);
      mode = "intent";
      return;
    }
    if (mode === "adopt") {
      const m = /^- \[( |x|X)\] (\S+)$/.exec(line);
      if (m) sheet.notAdopted.push({ ref: m[2]!, checked: m[1] !== " " });
      else if (line) errors.push(`${at}: expected "- [ ] src/file.ts#function"`);
      return;
    }
    if (!r) return; // the header
    const cur: SheetRegion = r;
    if (line.startsWith("> ")) return;
    if (line.startsWith("<!--") && line.endsWith("-->")) {
      const m = /file:\s*([^\s|]+)/.exec(line);
      if (m) cur.file = m[1]!;
      return;
    }
    if (line === "**Examples**") return void (mode = "examples");
    if (line === "**Suggestions**") return void (mode = "suggestions");
    if (line === "**Hold**") return void (cur.hold = true);
    if (mode === "examples") {
      if (!line) return;
      const e = line.startsWith("- ") ? readExample(line.slice(2)) : null;
      if (e === null) errors.push(`${at}: cannot read this example in ${cur.id} (expected: - [args] -> expected)`);
      else cur.examples.push(e);
      return;
    }
    if (mode === "suggestions") {
      if (!line) return;
      const m = /^- \[( |x|X)\] (intent|example|escalate): (.*?)(?: <!-- (.*) -->)?$/.exec(line);
      if (!m) errors.push(`${at}: cannot read this suggestion in ${cur.id}`);
      else cur.suggestions.push({ kind: m[2] as Suggestion["kind"], value: m[3]!, ...(m[4] ? { note: m[4] } : {}), checked: m[1] !== " " });
      return;
    }
    if (!cur.signature && /^`.*`$/.test(line)) return void (cur.signature = line.slice(1, -1));
    intent.push(line);
  });
  close();
  const seen = new Set<string>();
  for (const x of sheet.regions) {
    if (seen.has(x.id)) errors.push(`${x.id} appears twice`);
    seen.add(x.id);
  }
  return { sheet, errors };
}
