import * as arc from "openarc";

// Watch mode (`openarc watch`): file changes become a queue of regions for the backend, one compile at a time.
// The pure queue logic lives here as regions; the file watcher and the worker loop are hand-written in main.ts.

export type ChangeKind = "source" | "fakes" | "config" | "ignore";

/** Queue state. `running` is the region being compiled right now; `rerun` holds ids that changed again while running. */
export interface WatchQueue {
  pending: string[];
  running: string | null;
  rerun: string[];
}

// ── watch.classifyPath ─────────────────────────────────────────── spec §15
type ClassifyPath = (path: string) => ChangeKind;

export const classifyPathSpec = arc.defineRegion<ClassifyPath>({
  id: "watch.classifyPath",
  intent: [
    "path is project-relative POSIX. 'openarc.config.json' -> config.",
    "Files ending in .ts under src/ -> source; under tests/fakes/ -> fakes.",
    "Anything under node_modules/, .openarc/, build/ or dist/ at any depth -> ignore. Everything else -> ignore.",
  ],
  examples: [
    { args: ["src/tasks.ts"], expected: "source" },
    { args: ["src/deep/a/b.ts"], expected: "source" },
    { args: ["tests/fakes/fs.memory.ts"], expected: "fakes" },
    { args: ["openarc.config.json"], expected: "config" },
    { args: [".openarc/manifest.json"], expected: "ignore" },
    { args: ["src/node_modules/x.ts"], expected: "ignore" },
    { args: ["src/readme.md"], expected: "ignore" },
    { args: ["tests/other.ts"], expected: "ignore" },
  ],
});

// @openarc:begin watch.classifyPath
export const classifyPath: ClassifyPath = (path) => {
  const parts = path.split("/");
  if (parts.some((p) => p === "node_modules" || p === ".openarc" || p === "build" || p === "dist")) return "ignore";
  if (path === "openarc.config.json") return "config";
  if (!path.endsWith(".ts")) return "ignore";
  if (parts[0] === "src") return "source";
  if (parts[0] === "tests" && parts[1] === "fakes") return "fakes";
  return "ignore";
};
// @openarc:end watch.classifyPath

// ── watch.enqueue ──────────────────────────────────────────────── spec §15
type Enqueue = (queue: WatchQueue, ids: string[]) => WatchQueue;

export const enqueueSpec = arc.defineRegion<Enqueue>({
  id: "watch.enqueue",
  intent: [
    "Return a new queue (never mutate the input). Each id is added at the end of pending unless it is already pending (keep its position).",
    "If an id is the one running, add it to rerun instead (once). Duplicates within ids are added once, in first-occurrence order.",
  ],
  examples: [
    { args: [{ pending: [], running: null, rerun: [] }, ["a", "b"]], expected: { pending: ["a", "b"], running: null, rerun: [] } },
    { args: [{ pending: ["a"], running: null, rerun: [] }, ["b", "a", "b"]], expected: { pending: ["a", "b"], running: null, rerun: [] } },
    { args: [{ pending: [], running: "a", rerun: [] }, ["a", "c"]], expected: { pending: ["c"], running: "a", rerun: ["a"] } },
    { args: [{ pending: [], running: "a", rerun: ["a"] }, ["a"]], expected: { pending: [], running: "a", rerun: ["a"] } },
  ],
});

// @openarc:begin watch.enqueue
export const enqueue: Enqueue = (queue, ids) => {
  const pending = [...queue.pending];
  const rerun = [...queue.rerun];
  for (const id of ids) {
    if (id === queue.running) {
      if (!rerun.includes(id)) rerun.push(id);
    } else if (!pending.includes(id)) pending.push(id);
  }
  return { pending, running: queue.running, rerun };
};
// @openarc:end watch.enqueue

// ── watch.takeNext ─────────────────────────────────────────────── spec §15
type TakeNext = (queue: WatchQueue) => { next: string | null; queue: WatchQueue };

export const takeNextSpec = arc.defineRegion<TakeNext>({
  id: "watch.takeNext",
  intent: [
    "Called when the worker is idle (the previous run finished). First move every id in rerun to the FRONT of pending (in rerun order, without duplicating ids already pending, which move to the front).",
    "Then take the first pending id as next and set running to it; if nothing is pending, next is null and running is null. Never mutate the input.",
  ],
  examples: [
    { args: [{ pending: ["a", "b"], running: null, rerun: [] }], expected: { next: "a", queue: { pending: ["b"], running: "a", rerun: [] } } },
    { args: [{ pending: [], running: "a", rerun: [] }], expected: { next: null, queue: { pending: [], running: null, rerun: [] } } },
    { args: [{ pending: ["c", "a"], running: "a", rerun: ["a"] }], expected: { next: "a", queue: { pending: ["c"], running: "a", rerun: [] } } },
  ],
});

// @openarc:begin watch.takeNext
export const takeNext: TakeNext = (queue) => {
  const pending = [...queue.rerun, ...queue.pending.filter((id) => !queue.rerun.includes(id))];
  const next = pending.shift() ?? null;
  return { next, queue: { pending, running: next, rerun: [] } };
};
// @openarc:end watch.takeNext
