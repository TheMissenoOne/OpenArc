import * as arc from "open-arc";
import type { Diagnostic } from "./types.ts";

// ── ids.isValidId ─────────────────────────────────────────────── spec §2.3
type IsValidId = (id: string) => boolean;

export const isValidIdSpec = arc.defineRegion<IsValidId>({
  id: "ids.isValidId",
  intent:
    "True iff id matches: segment ('.' segment)*, where segment = [a-z][a-zA-Z0-9]*. No other characters, no empty segments.",
  examples: [
    { args: ["tasks"], expected: true },
    { args: ["tasks.create"], expected: true },
    { args: ["tasks.create2.normalizeTitle"], expected: true },
    { args: [""], expected: false },
    { args: ["Tasks.create"], expected: false },
    { args: ["tasks..create"], expected: false },
    { args: ["tasks.2create"], expected: false },
    { args: ["tasks.create-x"], expected: false },
    { args: ["tasks."], expected: false },
  ],
});

// @openarc:begin ids.isValidId
export const isValidId: IsValidId = (id) => /^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)*$/.test(id);
// @openarc:end ids.isValidId

// ── ids.findDuplicateIds ──────────────────────────────────────── spec §2.3, OARC-E011
type FindDuplicateIds = (occurrences: { id: string; file: string }[]) => Diagnostic[];

export const findDuplicateIdsSpec = arc.defineRegion<FindDuplicateIds>({
  id: "ids.findDuplicateIds",
  intent:
    "Report OARC-E011 for every occurrence of an id after its first, in input order, with the id and the file of the repeated occurrence.",
  examples: [
    { args: [[]], expected: [] },
    {
      args: [[{ id: "a", file: "x.ts" }, { id: "b", file: "x.ts" }]],
      expected: [],
    },
    {
      args: [[{ id: "a", file: "x.ts" }, { id: "b", file: "x.ts" }, { id: "a", file: "y.ts" }, { id: "a", file: "z.ts" }]],
      expected: [
        { code: "OARC-E011", id: "a", file: "y.ts" },
        { code: "OARC-E011", id: "a", file: "z.ts" },
      ],
    },
  ],
});

// @openarc:begin ids.findDuplicateIds
export const findDuplicateIds: FindDuplicateIds = (occurrences) => {
  const seen = new Set<string>();
  const out: Diagnostic[] = [];
  for (const o of occurrences) {
    if (seen.has(o.id)) out.push({ code: "OARC-E011", id: o.id, file: o.file });
    else seen.add(o.id);
  }
  return out;
};
// @openarc:end ids.findDuplicateIds
