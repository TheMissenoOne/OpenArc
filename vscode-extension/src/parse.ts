// Pure parsing of OpenArc markers and specs (SPEC-phase0 §3). No vscode import, so it is testable from plain Node.
import * as ts from "typescript";

export type Severity = "error" | "warning" | "info";

/** All lines are 0-based. `idStart`/`idEnd` are absolute offsets into the file text. */
export interface Marker { kind: "begin" | "end"; id: string; line: number; idStart: number; idEnd: number }
export interface Region { id: string; begin: Marker; end: Marker; parent: string | null; placeholder: boolean }
export interface Spec { id: string; kind: "function" | "block"; line: number; idStart: number; idEnd: number; examples: number }
export interface Problem { code: string; message: string; line: number; start: number; end: number; severity: Severity }
export interface Parsed { markers: Marker[]; regions: Region[]; specs: Spec[]; problems: Problem[]; lineStarts: readonly number[] }

const ID = "[a-z][a-zA-Z0-9]*(?:\\.[a-z][a-zA-Z0-9]*)*";
const MARKER = new RegExp(`^// @openarc:(begin|end) (${ID})[ \\t]*$`);

/** Every comment in the file, found as trivia in front of real tokens, so text inside strings/templates is never seen. */
function comments(sf: ts.SourceFile): ts.CommentRange[] {
  const text = sf.text;
  const seen = new Map<number, ts.CommentRange>();
  const visit = (node: ts.Node) => {
    if (node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode) return;
    const kids = node.getChildren(sf);
    if (kids.length === 0) {
      // Leading ranges skip comments on the previous token's line; those are that token's trailing ranges.
      for (const c of [...ts.getLeadingCommentRanges(text, node.pos) ?? [], ...ts.getTrailingCommentRanges(text, node.end) ?? []]) seen.set(c.pos, c);
    } else kids.forEach(visit);
  };
  visit(sf);
  return [...seen.values()].sort((a, b) => a.pos - b.pos);
}

/** §3.1: a marker is a single-line comment that is alone on its line. Any other `@openarc:` comment is OARC-W001. */
export function scanMarkers(sf: ts.SourceFile): { markers: Marker[]; problems: Problem[] } {
  const text = sf.text;
  const markers: Marker[] = [];
  const problems: Problem[] = [];
  for (const c of comments(sf)) {
    const body = text.slice(c.pos, c.end);
    if (!body.includes("@openarc:")) continue;
    const ls = text.lastIndexOf("\n", c.pos - 1) + 1;
    let le = text.indexOf("\n", c.end);
    if (le === -1) le = text.length;
    const alone = text.slice(ls, c.pos).trim() === "" && text.slice(c.end, le).trim() === "";
    const m = c.kind === ts.SyntaxKind.SingleLineCommentTrivia && alone ? MARKER.exec(body.replace(/\r$/, "")) : null;
    const line = sf.getLineAndCharacterOfPosition(c.pos).line;
    if (!m) {
      problems.push({ code: "OARC-W001", message: "OARC-W001: '@openarc:' comment is not a valid marker (must be '// @openarc:begin|end <id>' alone on its line)", line, start: c.pos, end: c.end, severity: "warning" });
      continue;
    }
    const idStart = c.pos + `// @openarc:${m[1]} `.length;
    markers.push({ kind: m[1] as "begin" | "end", id: m[2], line, idStart, idEnd: idStart + m[2].length });
  }
  return { markers, problems };
}

/**
 * Stack pairing, mirroring markers.buildRegionTree: an end matching an outer open begin is OARC-E031 (crossed);
 * an end with no open begin, or a begin left open, is OARC-E030. Pairing stops at the first structural error.
 * ponytail: regions already closed before the error are kept (the CLI drops all), so navigation keeps working.
 */
export function pairMarkers(markers: Marker[], text: string): { regions: Region[]; problems: Problem[] } {
  const regions: Region[] = [];
  const stack: Marker[] = [];
  const err = (code: string, m: Marker, why: string): Problem =>
    ({ code, message: `${code}: ${why} '${m.id}'`, line: m.line, start: m.idStart, end: m.idEnd, severity: "error" });
  for (const m of markers) {
    if (m.kind === "begin") { stack.push(m); continue; }
    const top = stack[stack.length - 1];
    if (top && top.id === m.id) {
      stack.pop();
      regions.push({ id: m.id, begin: top, end: m, parent: stack.length ? stack[stack.length - 1].id : null, placeholder: isPlaceholder(text, top, m) });
      continue;
    }
    const crossed = stack.some((b) => b.id === m.id);
    return { regions, problems: [crossed ? err("OARC-E031", m, "crossed nesting at end of") : err("OARC-E030", m, "end marker without a matching begin for")] };
  }
  if (stack.length) return { regions, problems: [err("OARC-E030", stack[stack.length - 1], "begin marker without a matching end for")] };
  return { regions: regions.sort((a, b) => a.begin.line - b.begin.line), problems: [] };
}

/** §3.6: placeholder bodies are `... => arc.todo("<id>")` for functions and `arc.pending("<id>");` for blocks. */
function isPlaceholder(text: string, begin: Marker, end: Marker): boolean {
  const body = text.slice(text.indexOf("\n", begin.idEnd) + 1, text.lastIndexOf("\n", end.idStart) + 1).trim();
  const q = JSON.stringify(begin.id);
  return body === `arc.pending(${q});` || (/^(export\s+)?const\s/.test(body) && body.replace(/;$/, "").endsWith(`arc.todo(${q})`));
}

/** `<anything>.defineRegion(...)` / `.defineBlock(...)` calls whose first argument has a string `id`. */
export function findSpecs(sf: ts.SourceFile): Spec[] {
  const specs: Spec[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const name = node.expression.name.text;
      const arg = node.arguments[0];
      if ((name === "defineRegion" || name === "defineBlock") && arg && ts.isObjectLiteralExpression(arg)) {
        const prop = (key: string) => arg.properties.find((p): p is ts.PropertyAssignment =>
          ts.isPropertyAssignment(p) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) && p.name.text === key)?.initializer;
        const id = prop("id");
        const ex = prop("examples");
        if (id && ts.isStringLiteralLike(id)) {
          const idStart = id.getStart(sf) + 1;
          specs.push({
            id: id.text, kind: name === "defineRegion" ? "function" : "block",
            line: sf.getLineAndCharacterOfPosition(idStart).line, idStart, idEnd: idStart + id.text.length,
            examples: ex && ts.isArrayLiteralExpression(ex) ? ex.elements.length : 0,
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return specs;
}

export function parse(text: string, fileName = "file.ts"): Parsed {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  const scanned = scanMarkers(sf);
  const paired = pairMarkers(scanned.markers, text);
  return { markers: scanned.markers, regions: paired.regions, specs: findSpecs(sf), problems: [...scanned.problems, ...paired.problems], lineStarts: sf.getLineStarts() };
}

/** Offset to 0-based line/character, without keeping the AST around. */
export function positionAt(lineStarts: readonly number[], offset: number): { line: number; character: number } {
  let lo = 0, hi = lineStarts.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (lineStarts[mid] <= offset) lo = mid; else hi = mid - 1; }
  return { line: lo, character: offset - lineStarts[lo] };
}
