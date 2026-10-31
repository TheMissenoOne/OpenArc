# CLI Reference

| Command | |
|---|---|
| `openarc init` | create `openarc.config.json`, `tsconfig.json`, `.openarc/` (existing files are kept) |
| `openarc init --backend <preset> [--model <id>] [--base-url <url>]` | the same, with that backend as the default in a new `openarc.config.json`. Presets: `ollama`, `openai`, `anthropic`, `openrouter`, `local`. See "Connecting providers" in [[Configuration]] |
| `openarc backends` | list the configured backends: provider (and preset), model, URL, and whether each key's env var is set; the default is marked `*`. Keys are never printed |
| `openarc backends test [name]` | send one small structured request through a backend (default: the default backend) and print `OK` or `FAIL`, the reason and the latency; for Ollama, also check the model is pulled. Exit 1 on FAIL |
| `openarc scaffold` | add markers and typed placeholders for specs without a region; deterministic, no model. Doesn't need the project to type-check: run it before `tsc`, since files that import another file's regions only type-check once those exist |
| `openarc compile [ids…]` | generate and verify pending/stale regions in one transaction |
| `openarc compile --keep-going` | commit what passed; failed regions stay pending; exit 1. Blocks whose function can't pass its examples yet (a sibling failed) are held back (W042). Stops calling the backend after 3 consecutive E080s |
| `openarc watch [--debounce <ms>]` | keep running: on each relevant save, analyse, queue stale regions and compile them one at a time (one model in memory). Failed regions wait for their spec to change; an unreachable backend pauses the queue. See [[Watch Mode]] |
| `openarc graph` | region tree: kind, state (`stale` for a compiler region whose spec changed since its body was verified), number of examples, file |
| `openarc inspect <id>` | spec, state (`stale` as in `graph`, with `ownership` alongside), `tokens` (`{prompt, completion}` the model used to produce the current body, failed attempts included; `null` when the backend reports none or the body isn't generated), manifest entry and provenance (model, output format, context level, attempts, sampling, tokens, checks) |
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
| `.openarc/attempts/<id>/<n>.json` | no | every failed attempt: body (or the raw invalid output), imports, problems, output format, context level, prompt hash, sampling, tokens (`{prompt, completion}` as the backend reported them: Ollama `prompt_eval_count`/`eval_count`, OpenAI `usage.prompt_tokens`/`completion_tokens`, Anthropic `usage.input_tokens`/`output_tokens`; `null` when it reports none); the last 20 per region (`.openarc/.gitignore`; `openarc init` adds the line to an existing file) |

## Diagnostics

Errors are `OARC-Exxx` and warnings `OARC-Wxxx`. The full table is in `SPEC-phase0.md` §11. The common ones:

| Code | Meaning |
|---|---|
| E070 | type error in the generated body (shown with the line) |
| E082 | attempts exhausted for a region |
| E090 | an example failed |
| E096 | a file changed on disk while the compile ran; nothing was written, run it again (watch re-queues it by itself) |
| E097 | the generated code tried to write outside its region (a comment that merely mentions `@openarc:` is stripped instead, and logged) |
| E098 | the body calls an imported or port function that its spec's `calls` list doesn't allow (detail: the call path) |
| W060 | manual edit detected; region is now yours |
| E061 | you changed the spec of a region you had edited; resolve it |
| E080 | the model backend is unreachable (retried once after 10 s; `stopped:3-consecutive` means the run gave up on it) |
| W042 | a generated block was held back until its sibling blocks exist; it's cached for the next run |
| W043 | a compiler-owned region's recompile failed, so it keeps a body that does not satisfy its current spec; `compile` exits 1 and `graph` shows it as `stale` |
| W044 | thin examples: fewer than 3, or none with an edge case (empty, zero, negative, null); consider `openarc check --oracle` |
| W045 | a generated block is unverified: no passing example of its function reaches it. It isn't cached as verified or committed; add an example that runs through it |
| E091 | the sandbox timed out (wall clock) or hit a resource limit |
| E092 | the configured sandbox tier isn't available on this machine (detail: `bwrap-unavailable`, `sandbox-exec-unavailable`, `no-podman-or-docker`); nothing runs |
| W046 | weaker isolation: Node permission model only, no OS sandbox (the `node` tier: Windows, or Linux without a usable `bwrap`). Printed once per command. Detail `node-<version>:network-not-blocked` on Node < 25 |
| W047 | `sandbox.isolation` is `"unsafe-none"`: no sandbox at all. Printed at error level on every run; it is never chosen implicitly |
