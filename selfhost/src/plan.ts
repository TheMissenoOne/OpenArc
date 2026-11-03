import * as arc from "open-arc";
import type { PlanInput, PlanResult } from "./types.ts";
import type { Diagnostic } from "./types.ts";

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
    {
      name: "unknown requested id is ignored",
      args: [[{ id: "a", parent: null, state: "pending", stale: true }], ["zzz", "a"]],
      expected: { targets: ["a"], skipped: [] },
    },
  ],
});

// @openarc:begin plan.selectTargets
export const selectTargets: SelectTargets = (regions, requested) => {
  const buildRegionMap = (regions: PlanInput[]): Map<string, PlanInput> => { const map = new Map(); for (const region of regions) { map.set(region.id, region); } return map; };
  const getDescendants = (map: Map<string, PlanInput>, id: string): string[] => { const descendants: string[] = []; const stack = [id]; while (stack.length > 0) { const current = stack.pop()!; const region = map.get(current); if (region) { for (const [key, value] of map.entries()) { if (value.parent === current) { stack.push(key); descendants.push(key); } } } } return descendants; };
  const map = buildRegionMap(regions);
  const scopeIds = requested.length === 0 ? Array.from(map.keys()) : requested.concat(requested.flatMap(id => getDescendants(map, id)));
  const scopeSet = new Set(scopeIds);
  const targets: string[] = [];
  const skipped: Diagnostic[] = [];
  const visited = new Set<string>();
  const postOrderTraversal = (id: string) => { if (visited.has(id)) return; visited.add(id); const region = map.get(id)!; for (const [key, value] of map.entries()) { if (value.parent === id) { postOrderTraversal(key); } } if (scopeSet.has(id)) { if (region.state === 'pending' || (region.state === 'compiler' && region.stale)) { targets.push(id); } else if (region.state === 'developer' && region.stale) { skipped.push({ code: 'OARC-W060', id }); } else if (region.state === 'conflicted') { skipped.push({ code: 'OARC-E061', id }); } } };
  for (const id of scopeIds) { postOrderTraversal(id); }
  return { targets, skipped };
};
// @openarc:end plan.selectTargets
