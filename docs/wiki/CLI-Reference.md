# CLI Reference

| Command | |
|---|---|
| `openarc init` | create `openarc.config.json`, `tsconfig.json`, `.openarc/` (existing files are kept) |
| `openarc init --backend <preset> [--model <id>] [--base-url <url>]` | the same, with that backend as the default in a new `openarc.config.json`. Presets: `ollama`, `openai`, `anthropic`, `openrouter`, `local`. See "Connecting providers" in [[Configuration]] |
| `openarc backends` | list the configured backends: provider (and preset), model, URL, and whether each key's env var is set; the default is marked `*`. Keys are never printed |
| `openarc backends test [name]` | send one small structured request through a backend (default: the default backend) and print `OK` or `FAIL`, the reason and the latency; for Ollama, also check the model is pulled. Exit 1 on FAIL |
| `openarc scaffold` | add markers and typed placeholders for specs without a region (a UI spec's region goes in the sibling `.tsx` file, created if missing); deterministic, no model. Doesn't need the project to type-check: run it before `tsc`, since files that import another file's regions only type-check once those exist |
| `openarc compile [ids…]` | generate and verify pending/stale regions in one transaction. A sketch's callees compile before it; a concept variant prints each waived law (`<id>: law "<name>" waived: <reason>`) |
| `openarc compile --keep-going` | commit what passed; failed regions stay pending; exit 1. Blocks whose function can't pass its examples yet (a sibling failed) are held back (W042). Stops calling the backend after 3 consecutive E080s |
| `openarc watch [--debounce <ms>]` | keep running: on each relevant save, analyse, queue stale regions and compile them one at a time (one model in memory). Failed regions wait for their spec to change; an unreachable backend pauses the queue. See [[Watch Mode]] |
| `openarc graph` | region tree: kind, state (`stale` for a compiler region whose spec changed since its body was verified), number of examples, file |
| `openarc inspect <id>` | spec, state (`stale` as in `graph`, with `ownership` alongside), manifest entry and provenance (model, context level, attempts, sampling, checks) |
| `openarc check <id> --oracle <module>#<export>` | differential test: run the compiled region and a reference implementation on its examples' arguments plus 60 seeded variations, in the sandbox, and list every disagreement; exit 1 if any. See "Thin examples" in [[Writing Specs]] |
| `openarc doctor` | report Node, the platform, the tools found and the selected sandbox tier, then run one example in that sandbox which also tries a file write, a child process and a network request; each must be refused. No model. Exit 1 if the tier is unavailable or anything gets through (except the network on Node < 25 in the `node` tier, which is reported) |
| `openarc freeze <id>` | make a region developer-owned |
| `openarc release <id>` | hand a region back to the compiler; the current body is backed up to `.openarc/backup/` |
| `openarc resolve <id> --keep` | accept the current body under the new spec |
| `openarc resolve <id> --regen` | back up and regenerate |
| `openarc resolve <id> --unlink` | forget a region whose markers you deleted |
| `openarc extract <file> [--function <name>] [--id <id>]` | adopt existing functions as developer-owned regions: markers, a `defineRegion` spec with a checker-derived `type <Name>Fn`, and a manifest entry; bodies untouched. See [[Adopting Existing Code]] |

## Files

| Path | Commit it? | |
|---|---|---|
| `openarc.config.json` | yes | backends and policies |
| `.openarc/manifest.json` | yes | ownership, hashes, fingerprints, provenance |
| `.openarc/cache/` | optional | verified bodies by fingerprint; makes rebuilds free and reproducible |
| `.openarc/harness.mjs` | yes | sandbox entry point |
| `.openarc/sandbox/`, `txn/`, `lock` | no | runtime only (`.openarc/.gitignore`). `lock` holds the PID of its holder; a lock whose holder is gone is removed with a warning |
| `.openarc/watch-history.jsonl` | no | `openarc watch` dispatch log, last 1000 entries (`.openarc/.gitignore`) |
| `.openarc/attempts/<id>/<n>.json` | no | every failed attempt: body (or the raw invalid output), imports, problems, context level, prompt hash, sampling; the last 20 per region (`.openarc/.gitignore`; `openarc init` adds the line to an existing file) |

## Diagnostics

Errors are `OARC-Exxx` and warnings `OARC-Wxxx`. The full table is in `SPEC-phase0.md` §11. The common ones:

| Code | Meaning |
|---|---|
| E070 | type error in the generated body (shown with the line); detail `sketch:TS<code>` for an error in a sketch, reported before any model call |
| E082 | attempts exhausted for a region |
| E090 | an example failed |
| E096 | a file changed on disk while the compile ran; nothing was written, run it again (watch re-queues it by itself) |
| E097 | the generated code tried to write outside its region (a comment that merely mentions `@openarc:` is stripped instead, and logged) |
| E098 | the body calls an imported or port function that its spec's `calls` list doesn't allow (detail: the call path); in a sketch, a fill calls something neither the sketch nor `calls` allows |
| E099 | a sketch region's body changed code outside its holes |
| E100 | an example fails without reaching any hole of the sketch: the sketch decides it, so fix the sketch or the example (detail: the example name) |
| E010 | a spec isn't static, or (since 0.8.0) a sketch, concept or UI structure breaks its rules (detail `sketch:…`, `fixture-missing:<name>`, `concept-unknown:<id>`, `waive-unknown-law:<name>`, `ui:…`) |
| E020 | a body doesn't match its type `F`; or a concept variant's `F` isn't an instance of the concept's interface (detail `concept-interface:<name>`) |
| W060 | manual edit detected; region is now yours |
| E061 | you changed the spec of a region you had edited; resolve it |
| E080 | the model backend is unreachable (retried once after 10 s; `stopped:3-consecutive` means the run gave up on it) |
| W042 | a generated block was held back until its sibling blocks exist; it's cached for the next run |
| W043 | a compiler-owned region's recompile failed, so it keeps a body that does not satisfy its current spec; `compile` exits 1 and `graph` shows it as `stale` |
| W044 | thin examples: fewer than 3, or none with an edge case (empty, zero, negative, null); consider `openarc check --oracle` |
| W045 | a generated block, or a sketch hole (detail `hole:<id>#<n>`), is unverified: no passing example reaches it. It isn't cached as verified or committed; add an example that runs through it |
| E091 | the sandbox timed out (wall clock) or hit a resource limit |
| E092 | the configured sandbox tier isn't available on this machine (detail: `bwrap-unavailable`, `sandbox-exec-unavailable`, `no-podman-or-docker`); nothing runs. For a UI region: no DOM (`dom:not-configured`, `dom:jsdom-missing`, `dom:react-missing`, `dom:react-dom-missing`) |
| W046 | weaker isolation: Node permission model only, no OS sandbox (the `node` tier: Windows, or Linux without a usable `bwrap`). Printed once per command. Detail `node-<version>:network-not-blocked` on Node < 25 |
| W047 | `sandbox.isolation` is `"unsafe-none"`: no sandbox at all. Printed at error level on every run; it is never chosen implicitly |
