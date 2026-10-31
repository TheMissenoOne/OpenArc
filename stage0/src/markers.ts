import * as arc from "open-arc";
import type { Diagnostic, Marker, RegionNode } from "./types.ts";
import ts from "typescript";
import { isValidId } from "./ids.ts";

// ── markers.scanMarkers ───────────────────────────────────────── spec §3.1
type ScanMarkers = (text: string) => { markers: Marker[]; diagnostics: Diagnostic[] };

export const scanMarkersSpec = arc.defineRegion<ScanMarkers>({
  id: "markers.scanMarkers",
  intent: [
    "Tokenize with the TypeScript scanner and consider ONLY single-line comment tokens; text inside strings, templates and code is never inspected.",
    "A comment is a marker iff it is the only non-whitespace content of its line and equals '// @openarc:begin <id>' or '// @openarc:end <id>' (single spaces) with a valid id (ids.isValidId).",
    "Any other comment (single- or multi-line) containing '@openarc:' yields OARC-W001 with its 1-based start line. Markers are returned in line order.",
    "Line endings may be CRLF (files checked out on Windows): a trailing \\r is whitespace, never part of a marker, and line numbers are the same as with LF.",
  ],
  deps: ["./ids.ts", "typescript"],
  examples: [
    {
      name: "begin/end with indentation",
      args: ["a\n// @openarc:begin x.y\nb\n    // @openarc:end x.y\n"],
      expected: {
        markers: [
          { kind: "begin", id: "x.y", line: 2 },
          { kind: "end", id: "x.y", line: 4 },
        ],
        diagnostics: [],
      },
    },
    {
      name: "marker sharing a line with code is not a marker",
      args: ["const s = 1; // @openarc:begin x\n"],
      expected: { markers: [], diagnostics: [{ code: "OARC-W001", line: 1 }] },
    },
    {
      name: "invalid id is not a marker",
      args: ["// @openarc:begin Bad.Id\n"],
      expected: { markers: [], diagnostics: [{ code: "OARC-W001", line: 1 }] },
    },
    {
      name: "CRLF line endings",
      args: ["a\r\n// @openarc:begin x.y\r\nb\r\n    // @openarc:end x.y\r\n"],
      expected: {
        markers: [
          { kind: "begin", id: "x.y", line: 2 },
          { kind: "end", id: "x.y", line: 4 },
        ],
        diagnostics: [],
      },
    },
    { name: "no markers", args: ["const x = 1;\n"], expected: { markers: [], diagnostics: [] } },
    {
      name: "marker text inside a string is ignored",
      args: ["const s = \"// @openarc:begin x\";\n"],
      expected: { markers: [], diagnostics: [] },
    },
    {
      name: "marker text inside a block comment warns",
      args: ["/* @openarc:begin x */\n"],
      expected: { markers: [], diagnostics: [{ code: "OARC-W001", line: 1 }] },
    },
  ],
});

// @openarc:begin markers.scanMarkers
export const scanMarkers: ScanMarkers = (text) => {
  const sf = ts.createSourceFile("m.ts", text, ts.ScriptTarget.Latest, true);
  const ranges: ts.CommentRange[] = [];
  const seen = new Set<number>();
  const visit = (n: ts.Node): void => {
    if (n.kind >= ts.SyntaxKind.FirstJSDocNode && n.kind <= ts.SyntaxKind.LastJSDocNode) return;
    const kids = n.getChildren(sf);
    if (kids.length) return kids.forEach(visit);
    for (const r of [...(ts.getLeadingCommentRanges(text, n.pos) ?? []), ...(ts.getTrailingCommentRanges(text, n.end) ?? [])])
      if (!seen.has(r.pos)) {
        seen.add(r.pos);
        ranges.push(r);
      }
  };
  visit(sf);
  const lines = text.split("\n");
  const markers: Marker[] = [];
  const diagnostics: Diagnostic[] = [];
  for (const r of ranges.sort((a, b) => a.pos - b.pos)) {
    const c = text.slice(r.pos, r.end);
    if (!c.includes("@openarc:")) continue;
    const line = sf.getLineAndCharacterOfPosition(r.pos).line + 1;
    const m = /^\/\/ @openarc:(begin|end) (\S+)$/.exec(c.trimEnd());
    if (m && r.kind === ts.SyntaxKind.SingleLineCommentTrivia && lines[line - 1]!.trim() === c.trim() && isValidId(m[2]!))
      markers.push({ kind: m[1] as "begin" | "end", id: m[2]!, line });
    else diagnostics.push({ code: "OARC-W001", line });
  }
  return { markers, diagnostics };
};
// @openarc:end markers.scanMarkers

// ── markers.buildRegionTree ───────────────────────────────────── spec §3.1, §3.3
type BuildRegionTree = (markers: Marker[]) => { roots: RegionNode[]; diagnostics: Diagnostic[] };

export const buildRegionTreeSpec = arc.defineRegion<BuildRegionTree>({
  id: "markers.buildRegionTree",
  intent: [
    "Pair markers with a stack. On the FIRST structural error, stop and return roots: [] and that single diagnostic:",
    "an end whose id differs from the open begin but which matches an outer open begin -> OARC-E031 at the end's line with that end's id;",
    "an end with no matching open begin, or a begin still open at the end -> OARC-E030 at that marker's line with its id.",
    "Children are in source order.",
  ],
  examples: [
    {
      name: "nested",
      args: [[
        { kind: "begin", id: "a", line: 1 },
        { kind: "begin", id: "a.b", line: 3 },
        { kind: "end", id: "a.b", line: 5 },
        { kind: "end", id: "a", line: 7 },
      ]],
      expected: {
        roots: [{ id: "a", beginLine: 1, endLine: 7, children: [{ id: "a.b", beginLine: 3, endLine: 5, children: [] }] }],
        diagnostics: [],
      },
    },
    {
      name: "unclosed begin",
      args: [[{ kind: "begin", id: "a", line: 1 }]],
      expected: { roots: [], diagnostics: [{ code: "OARC-E030", id: "a", line: 1 }] },
    },
    {
      name: "stray end",
      args: [[{ kind: "end", id: "a", line: 4 }]],
      expected: { roots: [], diagnostics: [{ code: "OARC-E030", id: "a", line: 4 }] },
    },
    {
      name: "crossed",
      args: [[
        { kind: "begin", id: "a", line: 1 },
        { kind: "begin", id: "b", line: 2 },
        { kind: "end", id: "a", line: 3 },
        { kind: "end", id: "b", line: 4 },
      ]],
      expected: { roots: [], diagnostics: [{ code: "OARC-E031", id: "a", line: 3 }] },
    },
  ],
});

// @openarc:begin markers.buildRegionTree
export const buildRegionTree: BuildRegionTree = (markers) => {
  const roots: RegionNode[] = [];
  const stack: RegionNode[] = [];
  for (const m of markers) {
    if (m.kind === "begin") {
      const node: RegionNode = { id: m.id, beginLine: m.line, endLine: 0, children: [] };
      (stack.at(-1)?.children ?? roots).push(node);
      stack.push(node);
      continue;
    }
    const top = stack.at(-1);
    if (top && top.id === m.id) {
      top.endLine = m.line;
      stack.pop();
      continue;
    }
    const code = stack.some((n) => n.id === m.id) ? "OARC-E031" : "OARC-E030";
    return { roots: [], diagnostics: [{ code, id: m.id, line: m.line }] };
  }
  const open = stack.at(-1);
  if (open) return { roots: [], diagnostics: [{ code: "OARC-E030", id: open.id, line: open.beginLine }] };
  return { roots, diagnostics: [] };
};
// @openarc:end markers.buildRegionTree
