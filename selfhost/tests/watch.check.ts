// The `openarc watch` loop (src/watcher.ts) on fakes: no model, no network, no real file watcher.
// Run: node tests/watch.check.ts
import assert from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, existsSync, writeFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import type { CompileResult } from "../src/types.ts";
import { memoryFs } from "./fakes/fs.memory.ts";
import { createWatcher, HISTORY, regionKey } from "../src/watcher.ts";
import { clearStaleLock, releaseOwnLock } from "../src/lock.ts";

/** A fake project: a region is stale while the spec it was last compiled with differs from its current spec. */
function harness(opts: { specs: Record<string, string>; fails?: string[]; problems?: (string | null)[]; files?: Record<string, string>; during?: (id: string) => void }) {
  const specs = { ...opts.specs };
  const compiledWith: Record<string, string> = {};
  const compiled: string[] = [];
  const lines: string[] = [];
  const problems = [...(opts.problems ?? [])];
  let analyses = 0;
  const asked: string[] = [];
  const { fs, files } = memoryFs({ files: opts.files ?? {} });
  const w = createWatcher({
    fs,
    print: (l) => lines.push(l),
    debounceMs: 5,
    backoffMs: [10, 20],
    async analyze() {
      analyses++;
      const targets = Object.keys(specs).filter((id) => compiledWith[id] !== specs[id]);
      return {
        targets,
        keys: Object.fromEntries(targets.map((id) => [id, { spec: specs[id]!, fp: "" }])),
        examples: Object.fromEntries(targets.map((id) => [id, 2])),
      };
    },
    async compile(id): Promise<CompileResult> {
      compiled.push(id);
      const spec = specs[id]!;
      opts.during?.(id);
      await new Promise((r) => setTimeout(r, 15)); // longer than the debounce
      if (opts.fails?.includes(id)) return { exit: 1, diagnostics: [{ code: "OARC-E082", id }], modelCalls: 3 };
      compiledWith[id] = spec;
      return { exit: 0, diagnostics: [], modelCalls: 1 };
    },
    async backendProblem(id) {
      asked.push(id);
      return problems.shift() ?? null;
    },
  });
  const settle = async () => {
    await new Promise((r) => setTimeout(r, 10));
    await w.idle();
  };
  return { w, specs, compiled, lines, files, settle, asked, analyses: () => analyses };
}
const history = (files: Map<string, string>) => (files.get(HISTORY) ?? "").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { id: string; state: string });

// ── 1. initial targets are queued and compiled in order; history gets running/done
{
  const h = harness({ specs: { a: "s1", b: "s1" } });
  await h.w.start();
  await h.settle();
  assert.deepStrictEqual(h.compiled, ["a", "b"]);
  assert.equal(h.lines[0], "[watch] 2 regions queued: a, b");
  assert.match(h.lines[1]!, /^\[watch\] a {2}✓ 1 attempt · 2\/2 examples · \d+\.\ds$/);
  assert.equal(h.lines.at(-1), "[watch] idle, watching for changes");
  assert.deepStrictEqual(history(h.files).map((e) => `${e.id}:${e.state}`), ["a:running", "a:done", "b:running", "b:done"]);
}

// ── 2. an edit during a run produces a rerun, ahead of what was already queued
{
  let edited = false;
  const h = harness({
    specs: { a: "s1", b: "s1" },
    during(id) {
      if (id === "a" && !edited) {
        edited = true;
        h.specs.a = "s2";
        h.w.onChange("src/a.ts");
      }
    },
  });
  await h.w.start();
  await h.settle();
  assert.deepStrictEqual(h.compiled, ["a", "a", "b"]);
  assert.ok(h.lines.includes("[watch] src/a.ts changed: 1 region queued: a"), h.lines.join("\n"));
}

// ── 3. edits to ignored paths do nothing
{
  const h = harness({ specs: {} });
  await h.w.start();
  await h.settle();
  const before = h.analyses();
  for (const p of [".openarc/manifest.json", ".openarc/txn/tx1/stage/0", "node_modules/x/index.ts", "src/readme.md", "build/dist/a.ts"]) h.w.onChange(p);
  await h.settle();
  assert.equal(h.analyses(), before, "no analysis for ignored paths");
  assert.deepStrictEqual(h.compiled, []);
}

// ── 4. a failed region stays pending and is not re-queued until its spec changes (or the config/fakes change)
{
  const h = harness({ specs: { a: "s1", b: "s1" }, fails: ["b"] });
  await h.w.start();
  await h.settle();
  assert.deepStrictEqual(h.compiled, ["a", "b"]);
  assert.ok(h.lines.some((l) => /^\[watch\] b {2}✗ 3 attempts · OARC-E082 · .* · still pending$/.test(l)), h.lines.join("\n"));
  assert.deepStrictEqual(h.w.state().failed, ["b"]);
  h.w.onChange("src/a.ts"); // a touch elsewhere: b is still stale but its spec is the one it failed on
  await h.settle();
  assert.deepStrictEqual(h.compiled, ["a", "b"], "no hot loop on a failed region");
  assert.equal(h.lines.at(-1), "[watch] src/a.ts changed: nothing new to compile (0 regions queued)");
  h.specs.b = "s2";
  h.w.onChange("src/b.ts");
  await h.settle();
  assert.deepStrictEqual(h.compiled, ["a", "b", "b"], "re-queued after its spec changed");
  h.w.onChange("openarc.config.json");
  await h.settle();
  assert.deepStrictEqual(h.compiled, ["a", "b", "b", "b"], "a config change gives failed regions another try");
}

// ── 5. an unreachable backend pauses the worker without dropping the queue
{
  const h = harness({ specs: { a: "s1", b: "s1" }, problems: ["unreachable:http://127.0.0.1:9", "unreachable:http://127.0.0.1:9"] });
  await h.w.start();
  await new Promise((r) => setTimeout(r, 5));
  assert.deepStrictEqual(h.w.state().queue.pending, ["a", "b"], "queue kept while paused");
  assert.deepStrictEqual(h.compiled, []);
  await h.settle();
  const paused = h.lines.filter((l) => l.includes("backend not ready"));
  assert.equal(paused.length, 2);
  assert.equal(paused[0], "[watch] backend not ready (unreachable:http://127.0.0.1:9): paused, 2 regions kept in the queue, retrying in 10ms");
  assert.match(paused[1]!, /retrying in 20ms$/);
  assert.deepStrictEqual(h.compiled, ["a", "b"], "compiled once the backend is back");
}

// ── 6. first stop finishes the running region and exits; history: a crash's "running" becomes "interrupted" on restart
{
  const h = harness({ specs: { a: "s1", b: "s1" }, during: (id) => id === "a" && void stopping.push(h.w.stop()) });
  const stopping: Promise<void>[] = [];
  await h.w.start();
  await h.settle();
  await Promise.all(stopping);
  assert.deepStrictEqual(h.compiled, ["a"], "b is not started after stop");
  assert.ok(h.lines.includes("[watch] finishing a, Ctrl+C again to abort"));

  const old = Array.from({ length: 1005 }, (_, i) => JSON.stringify({ at: "t", id: `x${i}`, state: "done", ms: 1, detail: "" }));
  old.push(JSON.stringify({ at: "t", id: "a", state: "running", ms: 0, detail: "" }));
  const r = harness({ specs: {}, files: { [HISTORY]: old.join("\n") + "\n" } });
  await r.w.start();
  await r.settle();
  assert.ok(r.lines.includes("[watch] a was interrupted (openarc exited mid-compile); re-planning it"), r.lines.join("\n"));
  const after = history(r.files);
  assert.equal(after.length, 1000, "history capped at 1000 lines");
  assert.deepStrictEqual(after.at(-1), { ...after.at(-1), id: "a", state: "interrupted" });
}

// ── 8. every run is followed by an analysis, even with no edit (the commit rewrote files); a queued region that is
//       no longer a target is dropped; the backend check is asked about the region that is about to compile
{
  const h = harness({ specs: { a: "s1", b: "s1", c: "s1" }, during: (id) => void (id === "a" && delete h.specs.c) });
  await h.w.start();
  await h.settle();
  assert.deepStrictEqual(h.compiled, ["a", "b"], "c stopped being a target while a compiled: not compiled");
  assert.equal(h.analyses(), 3, "start, after a, after b");
  assert.deepStrictEqual(h.w.state().queue, { pending: [], running: null, rerun: [] });
  assert.deepStrictEqual(h.asked, ["a", "b"]);
}

// ── 9. a region's key: developer-owned blocks (no fingerprint, never regenerated) don't blank the fingerprint
assert.deepStrictEqual(regionKey([
  { specHash: "s1", fingerprint: "f1", state: "compiler" },
  { specHash: "s2", fingerprint: "", state: "developer" },
  { specHash: "s3", fingerprint: "f3", state: "pending" },
]), { spec: "s1,s2,s3", fp: "f1,f3" });
assert.deepStrictEqual(regionKey([{ specHash: "s1", fingerprint: "", state: "compiler" }]), { spec: "s1", fp: "" }, "unknown fingerprint (backend down)");

// ── 7. stale-lock recovery
{
  const root = mkdtempSync(`${tmpdir()}/openarc-lock-`);
  mkdirSync(`${root}/.openarc`);
  const lock = `${root}/.openarc/lock`;
  const dead = spawnSync(process.execPath, ["-e", ""]).pid!; // exited: its pid is free
  const warned: string[] = [];
  writeFileSync(lock, String(dead));
  clearStaleLock(root, (l) => warned.push(l));
  assert.equal(existsSync(lock), false, "a dead holder's lock is removed");
  assert.match(warned[0]!, new RegExp(`stale \\.openarc/lock \\(pid ${dead} is not running\\)`));

  writeFileSync(lock, String(process.pid));
  clearStaleLock(root, (l) => warned.push(l));
  assert.equal(readFileSync(lock, "utf8"), String(process.pid), "a live holder's lock is kept");
  writeFileSync(lock, "");
  clearStaleLock(root, (l) => warned.push(l));
  assert.equal(existsSync(lock), true, "a fresh lock without a pid is kept (it may be mid-create)");
  assert.equal(warned.length, 1);

  // Another process removed the same stale lock and took its own between our check and our removal: theirs is kept.
  writeFileSync(lock, String(dead));
  clearStaleLock(root, (l) => warned.push(l), () => {
    rmSync(lock);
    writeFileSync(lock, String(process.pid));
  });
  assert.equal(readFileSync(lock, "utf8"), String(process.pid), "a replacement lock taken during the cleanup survives");
  assert.deepStrictEqual(readdirSync(`${root}/.openarc`), ["lock"], "no leftover .stale file");
  assert.equal(warned.length, 1);

  writeFileSync(lock, "1");
  releaseOwnLock(root);
  assert.equal(existsSync(lock), true, "never release someone else's lock");
  writeFileSync(lock, String(process.pid));
  releaseOwnLock(root);
  assert.equal(existsSync(lock), false, "our own lock is released on abort");
  rmSync(root, { recursive: true });
}

console.log("watch.check: ok");
