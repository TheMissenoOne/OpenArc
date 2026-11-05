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
    {
      name: "developer not stale is left alone; conflicted is skipped even when stale",
      args: [
        [
          { id: "a", parent: null, state: "developer", stale: false },
          { id: "b", parent: null, state: "conflicted", stale: true },
        ],
        [],
      ],
      expected: { targets: [], skipped: [{ code: "OARC-E061", id: "b" }] },
    },
  ],
});

// @openarc:begin plan.selectTargets
export const selectTargets: SelectTargets = (regions, requested) => {
  const buildDescendants = (regions: PlanInput[], id: string): string[] => {
    const result: string[] = [];
    const queue: string[] = [id];
    while (queue.length > 0) {
      const current = queue.shift()!;
      const children = regions.filter(r => r.parent === current);
      for (const child of children) {
        result.push(child.id);
        queue.push(child.id);
      }
    }
    return result;
  };
  const allIds = new Set(regions.map(r => r.id));
  const scope: string[] = [];
  if (requested.length === 0) {
      scope.push(...regions.map(r => r.id));
    } else {
      for (const req of requested) {
        if (allIds.has(req)) {
          scope.push(req, ...buildDescendants(regions, req));
        }
      }
    }
  const scopeSet = new Set(scope);
  const targets: string[] = [];
  const skipped: Diagnostic[] = [];
  const byParent: Map<string | null, PlanInput[]> = new Map();
  for (const r of regions) {
      if (!byParent.has(r.parent)) byParent.set(r.parent, []);
      byParent.get(r.parent)!.push(r);
    }
  const visited = new Set<string>();
  const postOrder: string[] = [];
  const traverse = (id: string) => {
      if (visited.has(id)) return;
      visited.add(id);
      const children = byParent.get(id) || [];
      for (const child of children) {
        traverse(child.id);
      }
      postOrder.push(id);
    };
  for (const id of scope) {
      traverse(id);
    }
  for (const id of postOrder) {
      const region = regions.find(r => r.id === id);
      if (!region) continue;
      if (region.state === "conflicted") {
        skipped.push({ code: "OARC-E061", id });
      } else if (region.state === "developer" && region.stale) {
        skipped.push({ code: "OARC-W060", id });
      } else if ((region.state === "pending" || (region.state === "compiler" && region.stale)) && scopeSet.has(id)) {
        targets.push(id);
      }
    }
  return { targets, skipped };
};
// @openarc:end plan.selectTargets
