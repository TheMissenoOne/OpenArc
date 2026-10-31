# Watch Mode

```bash
npx openarc watch
```

Like `nodemon` for specs. OpenArc stays running, watches your project, and keeps every region compiled: you edit a spec, save, and the body is regenerated and verified in the background.

```
[watch] 3 regions queued: tasks.normalizeTitle, tasks.slugify, tasks.parseDue
[watch] tasks.normalizeTitle  ✓ 2 attempts · 3/3 examples · 4.1s
[watch] tasks.slugify         ✓ 1 attempt · 5/5 examples · 2.0s
[watch] tasks.parseDue        ✗ attempts exhausted (E090 example "iso date") · still pending
[watch] idle. Watching src/, tests/fakes/, openarc.config.json
[watch] src/tasks.ts changed: 1 region queued: tasks.parseDue
```

## What triggers a compile

| Change | Effect |
|---|---|
| a spec's intent, examples, deps or type in `src/**/*.ts` | its region becomes stale and is queued |
| a new spec | scaffolded, then queued |
| a type a region depends on (it's in the region's context package) | every affected region is queued |
| `tests/fakes/*.ts` | regions whose examples use that fake are re-verified |
| `openarc.config.json` (e.g. a new model) | regions whose fingerprint changed are queued |
| a hand edit inside a region | the region becomes `developer` and is **not** queued (your edit wins) |
| files OpenArc itself writes, `.openarc/`, `node_modules/` | ignored |

## The queue

- **One region compiles at a time.** That's one model in memory, which matters on small machines.
- **Order is first-come, first-served.** A region that is already queued keeps its place; it's never queued twice.
- **Editing a region while it compiles re-queues it.** It goes to the **front**, so the result always matches your latest save. The run in progress still finishes, but it's verified against the spec it started with.
- **Blocks are compiled as a whole function.** A change to a block queues its enclosing function, because blocks are only verified together (see [[Safety Model]]).
- **Saves are debounced** (300 ms by default; `--debounce <ms>`). Saving five times quickly is a single analysis.

`Ctrl+C` finishes the current region and exits; a second `Ctrl+C` aborts it. An abort is still safe: compiles are transactions, so nothing half-written is left.

## Under the hood

The queue logic is itself OpenArc regions with examples, in `src/watch.ts`:

| Region | Does |
|---|---|
| `watch.classifyPath` | `src/**.ts` is source, `tests/fakes/**.ts` is fakes, the config is config, everything else is ignored |
| `watch.enqueue` | dedupes and re-queues regions that change while running |
| `watch.takeNext` | rerun-first scheduling |

The file watcher and the worker loop are hand-written; they call `compile.run` with one region id at a time and `--keep-going` semantics.
