# Watch Mode

```bash
npx openarc watch                 # debounce 300 ms
npx openarc watch --debounce 1000
```

Like `nodemon` for specs. OpenArc stays running, watches your project, and keeps every region compiled: you edit a spec, save, and the body is regenerated and verified in the background.

```
[watch] watching src/, tests/fakes/, openarc.config.json (debounce 300 ms, Ctrl+C to stop)
[watch] 3 regions queued: tasks.normalizeTitle, tasks.slugify, tasks.parseDue
[watch] tasks.normalizeTitle  ✓ 2 attempts · 3/3 examples · 4.1s
[watch] tasks.slugify  ✓ 1 attempt · 5/5 examples · 2.0s
[watch] tasks.parseDue  ✗ 3 attempts · OARC-E082 OARC-E090 iso date · 9.7s · still pending
[watch] idle, watching for changes
[watch] src/tasks.ts changed: 1 region queued: tasks.parseDue
```

Each status line shows the outcome, the model calls it took, the function's examples, the time and, for a failure, the first error code. A failed region that had no body yet is `still pending`; a compiler-owned region whose recompile failed ends with `stale: keeps a body that fails the current spec` (`OARC-W043`), because its old body stays in the file.

## What is watched

`src/` and `tests/fakes/` with all their subdirectories, plus the project root for `openarc.config.json`. Each directory has its own non-recursive watcher, and a subdirectory created later is picked up: on Linux a recursive `fs.watch` stops reporting a file once it has been replaced by rename, which is how a commit writes, so watch went blind to every file it had just compiled. The watchers are also re-created after each compile, and every run is followed by an analysis. Every changed path goes through `watch.classifyPath`:

| Path | Kind |
|---|---|
| `src/**/*.ts` | source |
| `tests/fakes/**/*.ts` | fakes |
| `openarc.config.json` | config |
| anything under `.openarc/`, `node_modules/`, `build/` or `dist/`, and everything else | ignored |

An ignored path does nothing at all: no analysis. `node_modules/` isn't even watched, because each directory costs one inotify watch. A `src/` or `tests/fakes/` created after `openarc watch` started needs a restart.

## What triggers a compile

A relevant change marks the project dirty. Once the worker is idle, OpenArc analyses it and plans, exactly like `openarc compile` does, and queues what the plan finds:

| Change | Effect |
|---|---|
| a spec's intent, examples, deps or type | its region becomes stale and is queued |
| a new spec | queued; the compile scaffolds it |
| a type a region depends on (it's in the region's context package) | every region whose fingerprint changed is queued |
| `openarc.config.json` (e.g. a new model) | regions whose fingerprint changed are queued; failed regions get another try |
| `tests/fakes/*.ts` | re-analysed; failed regions get another try. Compiled regions are queued only if their fingerprint changed |
| a hand edit inside a region | the region becomes `developer` and is **not** queued (your edit wins) |
| OpenArc's own write of a compiled file | re-analysed, finds nothing: `src/x.ts changed: nothing new to compile`. A region's fingerprint covers its siblings' signatures, never their bodies, so compiling one region doesn't re-queue the others in its file |

Analysis asks Ollama for `/api/tags` (the model digest is part of the fingerprint). That's a list call: it never loads a model. When the backend is down, analysis falls back to comparing spec hashes, so edited specs are still noticed; type and config changes are picked up once the backend answers again.

## The queue

- **One region compiles at a time.** That's one model in memory, which matters on small machines.
- **Analysis never runs during a compile.** Changes saved during a run only set the dirty flag; the worker analyses after the run finishes. Two TypeScript programs and a model are never resident at once.
- **Order is first-come, first-served.** A region that is already queued keeps its place; it's never queued twice.
- **Editing a region while it compiles re-queues it.** It goes to the **front**, so the result always matches your latest save. The run in progress still finishes, but it's verified against the spec it started with.
- **Blocks are compiled as a whole function.** A stale block queues its enclosing function, because blocks are only verified together (see [[Safety Model]]).
- **Saves are debounced** (300 ms by default; `--debounce <ms>`). Saving five times quickly is a single analysis.
- Each region is one `compile.run` with that id and `--keep-going` semantics: its own transaction and lock.

## Model reloads

Ollama unloads an idle model after the backend's `keepAlive` (`"2m"` in the default config). In watch mode that means the first compile after a quiet spell reloads the model, which takes about 55 s for `qwen3.5:9b` on a small machine. If you have the RAM to keep it resident, set a longer `keepAlive` (for example `"30m"`) on the backend in `openarc.config.json`; the trade-off is that the model's memory stays taken while you aren't editing.

## Failed regions

A region that fails (attempts exhausted, examples failing) stays pending and is **not** queued again on its own, so a hopeless region can't burn the model in a loop. Watch remembers the spec hashes and fingerprints it failed on. It's queued again when:

- its spec or one of its blocks' specs changes;
- its fingerprint changes (a dependency type, the model);
- `openarc.config.json` or a fake changes (that clears every failure).

## Backend down: pause, never drop

Before each region, watch checks that the backend that region compiles with (its `regions.<id>.backend` override, else the default) can take a call: Ollama must answer `/api/tags` and list the model; a hosted backend needs its `apiKeyEnv` variable set. If not, it prints one line, pauses and retries with backoff: 5 s, 10 s, 30 s, then every 60 s. The queue is kept. A relevant change during a pause retries at once (you may have just fixed the config).

```
[watch] backend not ready (unreachable:http://127.0.0.1:11434): paused, 2 regions kept in the queue, retrying in 5s
```

A compile that fails with `OARC-E080` (backend died mid-run) or `OARC-E095` (another `openarc` holds the lock) is shown as failed but put back at the front and paused the same way; it isn't remembered as a failed region.

A compile that ends with `OARC-E096` is not the region's fault: it may well have passed, but you saved the file during the compile (often while editing another region of the same file), so nothing was written. It goes back to the front of the queue at once, with no pause, and isn't remembered as failed:

```
[watch] text.slugify  ✗ 1 attempt · OARC-E096 · 2.8s · re-queued (file changed during compile)
```

Before 0.6.3 it said `still pending` and was remembered as failed, so a region that had just passed could be stranded until its own spec changed.

Since 0.6.4 this applies only when `OARC-E096` is the run's sole problem (no other error, no `OARC-W045`), and only while the region is still a target. After 3 `OARC-E096` runs in a row the region is remembered as failed, `gave up: a file it commits to changed during 3 compiles in a row (E096)`, so a file saved during every compile can't keep other regions waiting.

A compile that held back a block with `OARC-W045` (no example reaches it) is remembered as failed, `held back: an example must reach every block (W045)`, until the spec or its examples change, or a config or fake file changes.

## History

Every dispatch is appended to `.openarc/watch-history.jsonl` (git-ignored by `openarc init`), capped at the last 1000 lines:

```json
{"at":"2026-10-31T18:32:03.352Z","id":"tasks.slugify","state":"running","ms":0,"detail":""}
{"at":"2026-10-31T18:32:03.517Z","id":"tasks.slugify","state":"done","ms":165,"detail":"1 attempt"}
```

`state` is `running`, `done`, `failed` (detail: the first error), `requeued` (`OARC-E096`) or `interrupted`. If watch starts and a region's last entry is `running`, the previous watch died mid-compile: it's reported, recorded as `interrupted`, and the region is simply re-planned. The history is never trusted for what to compile; analysis decides.

## Stopping

The first `Ctrl+C` prints `finishing <id>, Ctrl+C again to abort` (if a region is compiling) and exits after it. A second `Ctrl+C` exits at once. That's still safe: compiles are transactions (an interrupted one is rolled back at the next start, `OARC-W094`), and watch removes `.openarc/lock` if this process holds it.

If the process dies hard, the lock stays. Every `openarc` process writes its PID into `.openarc/lock`, so the next `compile`, `extract` or `watch` checks it with `kill(pid, 0)`, removes a lock whose holder is gone and warns:

```
[watch] warning: removed a stale .openarc/lock (pid 157341 is not running)
```

## Under the hood

The queue logic is itself OpenArc regions with examples, in `src/watch.ts`:

| Region | Does |
|---|---|
| `watch.classifyPath` | `src/**.ts` is source, `tests/fakes/**.ts` is fakes, the config is config, everything else is ignored |
| `watch.enqueue` | dedupes and re-queues regions that change while running |
| `watch.takeNext` | rerun-first scheduling |

The loop is hand-written in `src/watcher.ts` (debounce, single worker, pause/backoff, failed-region memory, history), with every effect injected so `tests/watch.check.ts` drives it without a model. The stale-lock check is `src/lock.ts`. The normative rules are `SPEC-phase0.md` §15.
