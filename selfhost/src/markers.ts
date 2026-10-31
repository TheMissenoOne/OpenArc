import * as arc from "@openarc/core";
import type { Diagnostic, Marker, RegionNode } from "./types.ts";

// ── markers.scanMarkers ───────────────────────────────────────── spec §3.1
type ScanMarkers = (text: string) => { markers: Marker[]; diagnostics: Diagnostic[] };

export const scanMarkersSpec = arc.defineRegion<ScanMarkers>({
  id: "markers.scanMarkers",
  intent: [
    "Tokenize with the TypeScript scanner and consider ONLY single-line comment tokens; text inside strings, templates and code is never inspected.",
    "A comment is a marker iff it is the only non-whitespace content of its line and equals '// @openarc:begin <id>' or '// @openarc:end <id>' (single spaces) with a valid id (ids.isValidId).",
    "Any other comment (single- or multi-line) containing '@openarc:' yields OARC-W001 with its 1-based start line. Markers are returned in line order.",
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
export const buildRegionTree: BuildRegionTree = (markers) => arc.todo("markers.buildRegionTree");
// @openarc:end markers.buildRegionTree
