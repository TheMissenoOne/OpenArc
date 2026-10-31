// `openarc watch` loop (spec §15). Hand-written: debounce, the single worker, pause/backoff, failed-region memory and
// the history file. Everything with an effect is injected (WatchDeps), so tests/watch.check.ts drives it without a model.
// The queue itself is the watch.* regions in ./watch.ts.
import type { CompileResult, FsPort } from "./types.ts";
import { classifyPath, enqueue, takeNext, type WatchQueue } from "./watch.ts";

export const HISTORY = ".openarc/watch-history.jsonl";
const HISTORY_CAP = 1000;

/** What a region was last compiled against: specHashes of the function and its blocks, and their fingerprints
 *  ("" when the backend could not be asked, so the fingerprint is unknown). */
export interface RegionKey {
  spec: string;
  fp: string;
}
export interface Analysis {
  targets: string[]; // function region ids (block targets already mapped to their enclosing function), plan order
  keys: Record<string, RegionKey>;
  examples: Record<string, number>;
}
export interface WatchDeps {
  analyze(): Promise<Analysis>;
  compile(id: string): Promise<CompileResult>;
  backendProblem(): Promise<string | null>;
  fs: FsPort;
  print(line: string): void;
  debounceMs: number;
  backoffMs?: number[]; // pause schedule; the last value repeats
}

type HistoryState = "running" | "done" | "failed" | "interrupted";

const same = (a: RegionKey, b: RegionKey | undefined) => b !== undefined && a.spec === b.spec && (a.fp === b.fp || !a.fp || !b.fp);
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

export function createWatcher(d: WatchDeps) {
  const backoff = d.backoffMs ?? [5_000, 10_000, 30_000, 60_000];
  let queue: WatchQueue = { pending: [], running: null, rerun: [] };
  let keys: Record<string, RegionKey> = {};
  let examples: Record<string, number> = {};
  const failed = new Map<string, RegionKey>(); // id -> the key it failed on; not re-queued until the key changes
  const changed = new Set<string>();
  let dirty = true;
  let stopping = false;
  let busy = false;
  let pauses = 0;
  let idleSaid = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let wake: (() => void) | null = null;
  let loop: Promise<void> = Promise.resolve();
  const say = (line: string) => d.print(`[watch] ${line}`);
  const queued = () => [...queue.rerun, ...queue.pending.filter((id) => !queue.rerun.includes(id))];

  async function record(id: string, state: HistoryState, ms: number, detail: string) {
    const line = JSON.stringify({ at: new Date().toISOString(), id, state, ms, detail });
    const old = ((await d.fs.read(HISTORY)) ?? "").split("\n").filter(Boolean);
    await d.fs.write(HISTORY, [...old, line].slice(-HISTORY_CAP).join("\n") + "\n");
  }

  async function refresh() {
    const paths = [...changed];
    changed.clear();
    const a = await d.analyze();
    keys = a.keys;
    examples = a.examples;
    const before = new Set([...queued(), ...(queue.running ? [queue.running] : [])]);
    const ids = a.targets.filter((id) => !same(a.keys[id]!, failed.get(id)));
    queue = enqueue(queue, ids);
    const added = ids.filter((id) => !before.has(id) || queue.rerun.includes(id));
    const what = added.length ? `${plural(added.length, "region")} queued: ${added.join(", ")}` : `nothing new to compile (${plural(queued().length, "region")} queued)`;
    if (added.length || paths.length) say(`${paths.length ? `${paths.join(", ")} changed: ` : ""}${what}`);
  }

  const sleep = (ms: number) =>
    new Promise<void>((done) => {
      const t = setTimeout(() => ((wake = null), done()), ms);
      wake = () => (clearTimeout(t), (wake = null), done());
    });

  async function pause(why: string) {
    const ms = backoff[Math.min(pauses++, backoff.length - 1)]!;
    say(`backend not ready (${why}): paused, ${plural(queued().length, "region")} kept in the queue, retrying in ${ms >= 1000 ? `${ms / 1000}s` : `${ms}ms`}`);
    await sleep(ms);
  }

  async function work() {
    for (;;) {
      if (stopping) return;
      if (dirty) {
        dirty = false;
        await refresh();
      }
      if (queued().length === 0) {
        if (!idleSaid) say("idle, watching for changes");
        idleSaid = true;
        return;
      }
      idleSaid = false;
      const problem = await d.backendProblem();
      if (problem !== null) {
        await pause(problem);
        continue;
      }
      const t = takeNext(queue);
      queue = t.queue;
      const id = t.next!;
      const key = keys[id] ?? { spec: "", fp: "" };
      const t0 = Date.now();
      await record(id, "running", 0, "");
      const res = await d.compile(id);
      const ms = Date.now() - t0;
      const secs = `${(ms / 1000).toFixed(1)}s`;
      const err = res.diagnostics.find((x) => x.code.startsWith("OARC-E"));
      const transient = err !== undefined && (err.code === "OARC-E080" || err.code === "OARC-E095");
      const detail = err ? `${err.code}${err.detail ? ` ${err.detail}` : ""}` : "failed";
      if (res.exit === 0) {
        pauses = 0;
        failed.delete(id);
        const n = examples[id] ?? 0;
        say(`${id}  ✓ ${plural(res.modelCalls, "attempt")} · ${n}/${n} examples · ${secs}`);
        await record(id, "done", ms, plural(res.modelCalls, "attempt"));
      } else {
        say(`${id}  ✗ ${plural(res.modelCalls, "attempt")} · ${detail.length > 72 ? `${detail.slice(0, 71)}…` : detail} · ${secs} · still pending`);
        await record(id, "failed", ms, detail);
        if (!transient) failed.set(id, key);
      }
      // Edits saved during the run are analysed now, while `running` is still set, so they land in rerun (front).
      if (dirty && !stopping) {
        dirty = false;
        await refresh();
      }
      queue = { ...queue, running: null };
      if (transient) {
        queue = { ...queue, rerun: [id, ...queue.rerun.filter((x) => x !== id)] }; // backend/lock trouble: retry it first
        if (!stopping) await pause(detail);
      }
    }
  }

  function kick() {
    timer = null;
    if (stopping) return;
    if (busy) return wake?.(); // paused: a change (say, a fixed config) retries now instead of after the backoff
    busy = true;
    loop = work().catch((e: Error) => {
      queue = { ...queue, running: null };
      say(`error: ${e.message} (the next change retries)`);
    }).finally(() => {
      busy = false;
      if (dirty && !stopping && !timer) kick(); // an edit arrived while the last analysis was finishing
    });
  }

  return {
    /** Reads the history (a "running" entry left by a crash is reported and marked interrupted), then plans and starts. */
    async start() {
      const last = new Map<string, HistoryState>();
      for (const line of ((await d.fs.read(HISTORY)) ?? "").split("\n").filter(Boolean)) {
        try {
          const e = JSON.parse(line) as { id: string; state: HistoryState };
          last.set(e.id, e.state);
        } catch {
          // a torn last line from a crash
        }
      }
      for (const [id, state] of last)
        if (state === "running") {
          say(`${id} was interrupted (openarc exited mid-compile); re-planning it`);
          await record(id, "interrupted", 0, "previous watch exited while compiling");
        }
      kick();
    },
    /** A changed path, project-relative POSIX. */
    onChange(path: string) {
      const kind = classifyPath(path);
      if (kind === "ignore" || stopping) return;
      if (kind === "config" || kind === "fakes") failed.clear(); // may fix any failed region: give them all another try
      changed.add(path);
      dirty = true;
      if (timer) clearTimeout(timer);
      timer = setTimeout(kick, d.debounceMs);
    },
    /** First Ctrl+C: finish the region being compiled, then resolve. */
    async stop() {
      stopping = true;
      if (timer) clearTimeout(timer);
      timer = null;
      wake?.();
      if (queue.running) say(`finishing ${queue.running}, Ctrl+C again to abort`);
      await loop;
    },
    /** Tests: resolves once nothing is scheduled or running. */
    async idle() {
      while (timer || busy) await new Promise((r) => setTimeout(r, 2));
    },
    state: () => ({ queue, failed: [...failed.keys()] }),
  };
}
