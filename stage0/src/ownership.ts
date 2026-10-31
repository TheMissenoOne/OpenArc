import * as arc from "open-arc";
import type { ManifestView, ObservedRegion, OwnershipResult } from "./types.ts";

// ── ownership.detect ──────────────────────────────────────────── spec §6.2
// The examples ARE the §6.2 table, one row each. Change the table here, not in prose.
type Detect = (entry: ManifestView | null, observed: ObservedRegion) => OwnershipResult;

export const detectSpec = arc.defineRegion<Detect>({
  id: "ownership.detect",
  intent: [
    "First matching rule wins:",
    "markers absent -> conflicted, OARC-E062;",
    "entry exists and observed.parent != entry.parent -> conflicted, OARC-E063;",
    "no entry -> pending if observed.pending else developer, no diagnostic;",
    "entry conflicted -> conflicted, no diagnostic;",
    "entry compiler: hash equal -> compiler; else developer with OARC-W060;",
    "entry developer: specHash changed -> conflicted with OARC-E061; else developer.",
  ],
  examples: [
    {
      name: "new pending region",
      args: [null, { present: true, pending: true, parent: null, hash: "h1", specHash: "s1" }],
      expected: { state: "pending", diagnostic: null },
    },
    {
      name: "new hand-written region (extracted or developer skeleton)",
      args: [null, { present: true, pending: false, parent: null, hash: "h1", specHash: "s1" }],
      expected: { state: "developer", diagnostic: null },
    },
    {
      name: "compiler, untouched (spec change alone does not flip ownership)",
      args: [
        { ownership: "compiler", hash: "h1", specHash: "s1", parent: null },
        { present: true, pending: false, parent: null, hash: "h1", specHash: "s2" },
      ],
      expected: { state: "compiler", diagnostic: null },
    },
    {
      name: "compiler, hand-edited",
      args: [
        { ownership: "compiler", hash: "h1", specHash: "s1", parent: null },
        { present: true, pending: false, parent: null, hash: "h2", specHash: "s1" },
      ],
      expected: { state: "developer", diagnostic: { code: "OARC-W060" } },
    },
    {
      name: "developer, spec unchanged",
      args: [
        { ownership: "developer", hash: "h1", specHash: "s1", parent: null },
        { present: true, pending: false, parent: null, hash: "h9", specHash: "s1" },
      ],
      expected: { state: "developer", diagnostic: null },
    },
    {
      name: "developer, spec changed",
      args: [
        { ownership: "developer", hash: "h1", specHash: "s1", parent: null },
        { present: true, pending: false, parent: null, hash: "h1", specHash: "s2" },
      ],
      expected: { state: "conflicted", diagnostic: { code: "OARC-E061" } },
    },
    {
      name: "markers removed",
      args: [
        { ownership: "compiler", hash: "h1", specHash: "s1", parent: null },
        { present: false, pending: false, parent: null, hash: "", specHash: "s1" },
      ],
      expected: { state: "conflicted", diagnostic: { code: "OARC-E062" } },
    },
    {
      name: "moved under another parent",
      args: [
        { ownership: "compiler", hash: "h1", specHash: "s1", parent: null },
        { present: true, pending: false, parent: "a", hash: "h1", specHash: "s1" },
      ],
      expected: { state: "conflicted", diagnostic: { code: "OARC-E063" } },
    },
    {
      name: "conflicted stays conflicted until resolved",
      args: [
        { ownership: "conflicted", hash: "h1", specHash: "s1", parent: null },
        { present: true, pending: false, parent: null, hash: "h1", specHash: "s1" },
      ],
      expected: { state: "conflicted", diagnostic: null },
    },
  ],
});

// @openarc:begin ownership.detect
export const detect: Detect = (entry, observed) => {
  if (!observed.present) return { state: "conflicted", diagnostic: { code: "OARC-E062" } };
  if (entry && observed.parent !== entry.parent) return { state: "conflicted", diagnostic: { code: "OARC-E063" } };
  if (!entry) return { state: observed.pending ? "pending" : "developer", diagnostic: null };
  if (entry.ownership === "conflicted") return { state: "conflicted", diagnostic: null };
  if (entry.ownership === "compiler")
    return observed.hash === entry.hash ? { state: "compiler", diagnostic: null } : { state: "developer", diagnostic: { code: "OARC-W060" } };
  return observed.specHash !== entry.specHash ? { state: "conflicted", diagnostic: { code: "OARC-E061" } } : { state: "developer", diagnostic: null };
};
// @openarc:end ownership.detect
