import * as arc from "open-arc";
import type { PlanInput, PlanResult } from "./types.ts";

// ── plan.selectTargets ────────────────────────────────────────── spec §8.1 PLAN
type SelectTargets = (regions: PlanInput[], requested: string[]) => PlanResult;

export const selectTargetsSpec = arc.defineRegion<SelectTargets>({
  id: "plan.selectTargets",
  intent: [
    "Scope = all regions if requested is empty, else the requested ids plus all their descendants.",
    "Within scope, target = state pending, or state compiler with stale true.",
    "developer regions with stale true are skipped with {code: OARC-W060, id}; conflicted regions are always skipped with {code: OARC-E061, id}.",
    "Order: post-order over the parent tree (children before parents), siblings in input order. A parent is NOT targeted because a child is.",
  ],
  examples: [
    {
      name: "mixed tree",
      args: [
        [
          { id: "a", parent: null, state: "compiler", stale: true },
          { id: "a.b", parent: "a", state: "pending", stale: true },
          { id: "a.c", parent: "a", state: "developer", stale: true },
          { id: "d", parent: null, state: "conflicted", stale: false },
        ],
        [],
      ],
      expected: {
        targets: ["a.b", "a"],
        skipped: [
          { code: "OARC-W060", id: "a.c" },
          { code: "OARC-E061", id: "d" },
        ],
      },
    },
    {
      name: "requested child only",
      args: [
        [
          { id: "a", parent: null, state: "compiler", stale: true },
          { id: "a.b", parent: "a", state: "pending", stale: true },
          { id: "a.c", parent: "a", state: "developer", stale: true },
        ],
        ["a.b"],
      ],
      expected: { targets: ["a.b"], skipped: [] },
    },
    {
      name: "nothing stale",
      args: [[{ id: "a", parent: null, state: "compiler", stale: false }], []],
      expected: { targets: [], skipped: [] },
    },
  ],
});

// @openarc:begin plan.selectTargets
export const selectTargets: SelectTargets = (regions, requested) => arc.todo("plan.selectTargets");
// @openarc:end plan.selectTargets
