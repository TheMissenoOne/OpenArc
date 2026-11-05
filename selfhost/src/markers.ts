import * as arc from "open-arc";
import type { Diagnostic, Marker, RegionNode } from "./types.ts";

// ── markers.scanMarkers ───────────────────────────────────────── spec §3.1
type ScanMarkers = (text: string) => { markers: Marker[]; diagnostics: Diagnostic[] };

export const scanMarkersSpec = arc.defineRegion<ScanMarkers>({
  id: "markers.scanMarkers",
  intent: [
    "Tokenize with the TypeScript scanner and consider ONLY single-line comment tokens; text inside strings, templates and code is never inspected.",
    "A comment is a marker iff it is the only non-whitespace content of its line and equals '// @openarc:begin <id>' or '// @openarc:end <id>' (single spaces) with a valid id (ids.isValidId).",
    "Any other comment (single- or multi-line) containing '@openarc:' yields OARC-W001 with its 1-based start line. Markers are returned in line order.",
    "Line endings may be CRLF (files checked out on Windows): a trailing \\r is whitespace, never part of a marker, and line numbers are the same as with LF.",
    "Method: this overrides any idea of a raw scanner loop. Parse with ts.createSourceFile('m.ts', text, ts.ScriptTarget.Latest, true) and walk leaves as hash.normalizeOwnedText does, collecting ts.getLeadingCommentRanges(text, n.pos) and ts.getTrailingCommentRanges(text, n.end), de-duplicated by pos and sorted by pos. Skip JSDoc nodes (kinds FirstJSDocNode..LastJSDocNode).",
    "For each range containing '@openarc:': line = sf.getLineAndCharacterOfPosition(r.pos).line + 1; it is a marker iff r.kind === ts.SyntaxKind.SingleLineCommentTrivia, the comment's trimEnd() matches /^\\/\\/ @openarc:(begin|end) (\\S+)$/, the whole source line trimmed equals the comment trimmed, and isValidId(id). Otherwise OARC-W001. Import only isValidId from ./ids.ts; never use require.",
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
export const scanMarkers: ScanMarkers = (text) => arc.todo("markers.scanMarkers");
// @openarc:end markers.scanMarkers

// ── markers.buildRegionTree ───────────────────────────────────── spec §3.1, §3.3
type BuildRegionTree = (markers: Marker[]) => { roots: RegionNode[]; diagnostics: Diagnostic[] };

export const buildRegionTreeSpec = arc.defineRegion<BuildRegionTree>({
  id: "markers.buildRegionTree",
  intent: [
    "Pair markers with a stack. On the FIRST structural error, stop and return roots: [] and that single diagnostic:",
    "an end whose id differs from the open begin but which matches an outer open begin -> OARC-E031 at the end's line with that end's id;",
    "an end with no matching open begin, or a begin still open at the end (the innermost one) -> OARC-E030 at that marker's line with its id.",
    "Children are in source order.",
    "Method: declare once `roots` and `stack`, both RegionNode[]. A begin creates a node with endLine 0, pushes it to the top of stack's children (or to roots when the stack is empty), then onto the stack. An end matching the top sets endLine and pops. Any other end returns its diagnostic: OARC-E031 if stack.some(n => n.id === m.id), else OARC-E030. After the loop, a non-empty stack returns OARC-E030 for its top. The success result is { roots, diagnostics: [] }.",
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
      name: "end matching no open begin, inside an open region",
      args: [[{ kind: "begin", id: "a", line: 1 }, { kind: "end", id: "b", line: 2 }]],
      expected: { roots: [], diagnostics: [{ code: "OARC-E030", id: "b", line: 2 }] },
    },
    {
      name: "two begins left open: the innermost is reported",
      args: [[{ kind: "begin", id: "a", line: 1 }, { kind: "begin", id: "a.b", line: 2 }]],
      expected: { roots: [], diagnostics: [{ code: "OARC-E030", id: "a.b", line: 2 }] },
    },
    {
      name: "three levels",
      args: [[
        { kind: "begin", id: "a", line: 1 },
        { kind: "begin", id: "a.b", line: 2 },
        { kind: "begin", id: "a.b.c", line: 3 },
        { kind: "end", id: "a.b.c", line: 4 },
        { kind: "end", id: "a.b", line: 5 },
        { kind: "end", id: "a", line: 6 },
      ]],
      expected: {
        roots: [{ id: "a", beginLine: 1, endLine: 6, children: [{ id: "a.b", beginLine: 2, endLine: 5, children: [{ id: "a.b.c", beginLine: 3, endLine: 4, children: [] }] }] }],
        diagnostics: [],
      },
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
  let stack: RegionNode[] = [];

  for (const marker of markers) {
    if (marker.kind === "begin") {
      const node: RegionNode = {
        id: marker.id,
        beginLine: marker.line,
        endLine: 0,
        children: []
      };

      if (stack.length === 0) {
        roots.push(node);
      } else {
        stack[stack.length - 1].children.push(node);
      }

      stack.push(node);
    } else {
      // marker.kind === "end"
      if (stack.length === 0) {
        // No open begin at all
        stack.push({
          id: marker.id,
          beginLine: 0,
          endLine: marker.line,
          children: []
        });
        // This will be caught in the final check if we didn't stop
        // But per spec, we stop on first error. However, the error is OARC-E030.
        // Let's look at the logic: "an end with no matching open begin... -> OARC-E030"
        // This is the FIRST structural error. We return now.
        return { roots: [], diagnostics: [{ code: "OARC-E030", id: marker.id, line: marker.line }] };
      }

      const top = stack[stack.length - 1];
      if (top.id === marker.id) {
        top.endLine = marker.line;
        stack.pop();
      } else {
        // Mismatched end
        // Check if it matches an outer open begin (OARC-E031)
        if (stack.some(n => n.id === marker.id)) {
          return { roots: [], diagnostics: [{ code: "OARC-E031", id: marker.id, line: marker.line }] };
        } else {
          // No matching open begin anywhere (OARC-E030)
          return { roots: [], diagnostics: [{ code: "OARC-E030", id: marker.id, line: marker.line }] };
        }
      }
    }
  }

  // After loop, check for unclosed begins
  if (stack.length > 0) {
    const unclosed = stack[stack.length - 1];
    return { roots: [], diagnostics: [{ code: "OARC-E030", id: unclosed.id, line: unclosed.beginLine }] };
  }

  return { roots, diagnostics: [] };
};
// @openarc:end markers.buildRegionTree
