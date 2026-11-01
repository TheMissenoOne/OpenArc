// Output format "code" (spec §8.4): the model replies with one fenced code block, import lines first, then the body.
// Hand-written policy artifact, like model.ts's PROMPT_TEMPLATE: versioned and part of the fingerprint. The parsed
// {body, imports} goes through exactly the same guards as the "json" format's (engine.generate/verify).
// Why it exists: the 2026-10-31 benchmark pilot could not tell whether writing code as an escaped JSON string under
// grammar-constrained decoding costs small models accuracy on its own (finding 6); this is the ablation.
import ts from "typescript";
import type { ImportDecl, ModelOutput } from "./types.ts";

export const CODE_PROMPT_TEMPLATE_VERSION = "code-2";
/** {{context}} and {{repair}} as in PROMPT_TEMPLATE. */
export const CODE_PROMPT_TEMPLATE = `Implement exactly one OpenArc region in TypeScript.

{{context}}

{{repair}}

Reply with ONE fenced code block (\`\`\`ts ... \`\`\`). Inside it: first any import lines you need (only for something listed under "Allowed new imports" that the file doesn't already import), then ONLY the statements: the function's body without its signature and braces, or the block's statements.`;

/** Several regions in one request (engine.batchReply): {{ids}} lists the region ids, one per line. */
export const BATCH_CODE_PROMPT_TEMPLATE = `Implement {{count}} OpenArc regions of one file in TypeScript. They are independent: write each region's body on its own.

{{context}}

Reply with one section per region, in this order:
{{ids}}
Each section is a line "### <region id>", then ONE fenced code block (\`\`\`ts ... \`\`\`). Inside it: first any import lines you need (only for something listed under "Allowed new imports" that the file doesn't already import), then ONLY the statements of that function's body, without its signature and braces.`;
export const BATCH_CODE_SYSTEM = 'You are a compiler backend. For each region you output a "### <region id>" line, then one fenced TypeScript code block: optional import lines at the top, then statements only.';

/** A batched "code" reply split at its region headings: a line that is just a region id, give or take "#", "Region",
 *  backticks, asterisks and a colon. Each id gets the text up to the next heading (null when it has no heading). */
export function splitCodeSections(raw: string, ids: string[]): Map<string, string | null> {
  const lines = raw.replace(/\r/g, "").split("\n");
  const idOf = (l: string) => ids.find((id) => l.replace(/^\s*#*\s*(region\s+)?/i, "").replace(/[`*:\s]/g, "") === id);
  const heads = lines.flatMap((l, i) => { const id = idOf(l); return id ? [{ i, id }] : []; });
  const out = new Map<string, string | null>(ids.map((id) => [id, null]));
  heads.forEach(({ i, id }, k) => { if (out.get(id) === null) out.set(id, lines.slice(i + 1, heads[k + 1]?.i ?? lines.length).join("\n")); });
  return out;
}

export const CODE_SYSTEM = "You are a compiler backend. You output exactly one fenced TypeScript code block: optional import lines at the top, then statements only.";

/** The context's Rules, with the JSON "imports" wording replaced by import lines. */
export const codeRules = (rules: string): string =>
  rules
    .replace(/^"imports" may name:/m, "Import lines may name:")
    .replace(/^For a default import use .*$/m, 'Import forms: import { a, b } from "m"; import x from "m"; import * as x from "m"; import type { T } from "m". No "as" renames inside braces.');

const bad = (detail: string): ModelOutput => ({ ok: false, diagnostic: { code: "OARC-E081", detail } });

/** One import declaration as an ImportDecl, or null for a form the compiler doesn't write (side-effect import, renames,
 *  import attributes). Type-only names are plain names: verify/mergeImports decide `import type` as for "json". */
function importDecl(d: ts.ImportDeclaration): ImportDecl | null {
  const c = d.importClause;
  if (!c || d.attributes || !ts.isStringLiteral(d.moduleSpecifier)) return null;
  const out: ImportDecl = { from: d.moduleSpecifier.text, names: [] };
  if (c.name) out.default = c.name.text;
  const nb = c.namedBindings;
  if (nb && ts.isNamespaceImport(nb)) out.namespace = nb.name.text;
  if (nb && ts.isNamedImports(nb)) {
    if (nb.elements.some((e) => e.propertyName)) return null;
    out.names = nb.elements.map((e) => e.name.text);
  }
  return out;
}

/** Parse a "code" reply: drop <think> blocks, take the first ts/typescript/untagged fence (a reply with no fence at all
 *  is taken whole), and lift its leading import declarations into `imports`. E081 details: empty | unclosed-fence |
 *  no-ts-fence | bad-import:<text>. */
export function parseCodeOutput(raw: string): ModelOutput {
  const text = raw.replace(/\r/g, "").replace(/<think>[\s\S]*?(<\/think>|$)/g, "");
  const lines = text.split("\n");
  let code: string | null = null;
  let fences = 0;
  for (let i = 0; i < lines.length && code === null; i++) {
    const open = /^\s*```\s*([\w+-]*)\s*$/.exec(lines[i]!);
    if (!open) continue;
    fences++;
    const end = lines.findIndex((l, j) => j > i && /^\s*```\s*$/.test(l));
    if (!["", "ts", "typescript"].includes(open[1]!.toLowerCase())) {
      if (end < 0) break;
      i = end;
      continue;
    }
    if (end < 0) return bad("unclosed-fence"); // a reply cut at the output cap
    code = lines.slice(i + 1, end).join("\n");
  }
  if (code === null) {
    if (fences) return bad("no-ts-fence");
    code = text; // ponytail: no fence at all: take the reply as code; prose fails the same guards (syntax, tsc)
  }
  const sf = ts.createSourceFile("reply.ts", code, ts.ScriptTarget.Latest, true);
  const imports: ImportDecl[] = [];
  let end = 0;
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st)) break;
    const d = importDecl(st);
    if (!d) return bad(`bad-import:${st.getText(sf).slice(0, 80)}`);
    imports.push(d);
    end = st.getEnd();
  }
  const body = code.slice(end).trim();
  return body ? { ok: true, body, imports } : bad("empty");
}
