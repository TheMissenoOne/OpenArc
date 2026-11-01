# OpenArc benchmark harness

Tests one hypothesis: **a small local model, given OpenArc's strict contract and isolated context, implements functions about as reliably as the same or a larger model given conventional whole-file context, and with less compute per success.**

Dataset: the v1 set of [ts-bench](https://github.com/laiso/ts-bench) (25 TypeScript Exercism exercises), read directly from a pinned clone. This folder holds only scripts, configs and results; exercise content stays in the clone.

## Run

Requirements: Linux, Node >= 23.6 (tests run with `--experimental-transform-types`), `bwrap`, `prlimit`, and a model server: Ollama, or any OpenAI-compatible endpoint such as llama.cpp `llama-server` (see Backend).

```bash
cd bench && npm i                                    # installs jest's `expect` (matchers only)
./fetch-dataset.sh /path/to/ts-bench                 # pinned ts-bench + exercism-typescript
node run.mjs --dataset /path/to/ts-bench --pilot     # 5 exercises, every config/model in matrix.json
node run.mjs --dataset /path/to/ts-bench             # all 12 function exercises
node summarize.mjs results/<dir>                     # writes results/<dir>/tables.md
```

Flags: `--exercises a,b`, `--models m`, `--configs A,D`, `--out <dir>`, `--work <dir>` (generated projects; default `$TMPDIR/openarc-bench`), `--oa <tgz>` (default: the newest `../stage0/build/open-arc-*.tgz`; pin it when resuming so a new build doesn't slip in), `--matrix <file>` (default `matrix.json`), `--port <n>` (the token proxy, default 18435).

**Resume:** rerun the same command with the same `--out` (and `--oa`). Tasks already in `tasks.jsonl` are skipped; a task that was interrupted wrote nothing, so it is redone from scratch.

### Backend

`matrix.json` `backend` applies to every config of every run (a run's own `backend` overrides it field by field):

| field | |
|---|---|
| `provider` | `ollama` (native `/api/chat`) or `openai` (any OpenAI-compatible `/v1/chat/completions`, e.g. `llama-server`) |
| `baseUrl` | Ollama origin, or the OpenAI-compatible base ending in `/v1` |
| `maxContextTokens`, `outputReserveTokens` | context window and output cap, the same for both arms |
| `openarc` | merged verbatim into OpenArc's backend block (`preset`, `structuredOutput`, `think`, ...) |
| `info` | engine, version, quant, KV cache type, ctx, flags: copied into every results row (`backend` field); `info.label` names the backend in the tables |

OpenArc (A/B/C) and the baseline (D) talk to the same server through the proxy with the same sampling (temperature 0, seed 1, the same output cap); the only request difference is OpenArc's JSON-schema output format. Templates for `llama-server` and a tuned Ollama are under `backendTemplates`: copy one to `backend` and fill the `FILL` fields from the running server. Two things to know for `openai` backends: thinking must be off server-side (OpenArc's `openai` provider sends no thinking switch, so the baseline sends none either; the baseline strips any `<think>` block), and a llama-server serves one model, so run one model per server start with `--models <name>`. `memory.minStartGb` (default 6) may need lowering for a persistent server whose weights stay resident; Ollama runs unload instead.

| File | What |
|---|---|
| `run.mjs` | orchestrator: memory gate, token proxy, RSS sampler, one task at a time, writes `tasks.jsonl` |
| `lib/adapter.mjs` | exercise to OpenArc project (configs A/B/C), compile, held-out tests |
| `lib/baseline.mjs` | config D: whole-file prompt to Ollama `/api/chat`, repair loop |
| `lib/common.mjs` | split rule, typed stub, sandboxed test runs |
| `lib/jest-shim.mjs`, `lib/run-tests.mjs` | runs the Exercism jest tests without jest; also records calls to extract examples |
| `exercises.json` | per-exercise signatures, and the skipped exercises with reasons |
| `matrix.json` | configs, models, disabled slots for bigger models and an API backend, pilot list |
| `summarize.mjs` | tables from `tasks.jsonl` |

## Methodology

### Exercises

12 of the 25 exercises are function-shaped and used: acronym, binary-search, diamond, flatten-array, food-chain, house, rectangles, relative-distance, spiral-matrix, transpose, variable-length-quantity, wordy. The other 13 are classes or stateful APIs (bank-account, bowling, react, robot-name, ...) and are **skipped**; `exercises.json` gives the reason for each. Skipping is a finding: OpenArc's unit is a pure function with JSON examples, and half of a standard TS benchmark doesn't fit it without a hand-written wrapper the baseline wouldn't get.

### Signatures

Exercism stubs are under-typed: `parse(phrase: unknown): unknown`, `count()` with no parameters, `flatten(/* Parameters go here */)`. A stub-derived `F` is useless as a contract (and `unknown` makes every example type-check). So each signature in `exercises.json` was written by hand from the test call sites (argument and expectation shapes only). **Both arms get the same typed signatures**: OpenArc as `defineRegion<F>`, the baseline as a typed stub file.

### Tests

ts-bench runs the exercise's jest suite. We don't install jest: `lib/jest-shim.mjs` stands in for `@jest/globals` (describe/it/xit/test/beforeEach, all `xit` tests enabled as in Exercism CI) and uses jest's own `expect` package for the matchers, so `toEqual`/`toThrow` semantics are jest's. The test file runs under `node --experimental-transform-types` in a read-only, network-less `bwrap` sandbox with a 512 MB heap and 60 s of CPU. A test that never reports (crash, timeout, load error) counts as failed.

### Split rule (deterministic)

The test file runs once against recorder stubs (`run-tests.mjs --record`): every call to an exercise export records its arguments, and `expect(call).toEqual(v)` records `v`. A test is **eligible** as an example for function `f` if it makes exactly one call, to `f`, with a value expectation (no `toThrow`, no `.not`, JSON-encodable arguments; `undefined` becomes the `"$undefined"` token). For each `f`, the **first `min(3, floor(eligible_f / 2))` eligible tests in file order are public**; every other test, including all throw tests, is **held out**. The halving keeps at least half of each function's tests hidden (diamond has 3 tests: 1 public). The split is cached in `<work>/splits/<exercise>.json` and recorded per task; held-out test names are in each task's failures. 12 exercises give 100 held-out tests.

The model never sees held-out tests, in either arm.

### Configurations

| | |
|---|---|
| A | OpenArc, `initialLevel: 0` (contract only) |
| B | OpenArc, `initialLevel: 1` (dependency-aware) |
| C | OpenArc, `initialLevel: 2` (full file) |
| D | baseline: system prompt + one user message with instructions, the typed stub file and the public examples; asks for the complete file in a code block. Each repair appends the reply and the failing public-example output (jest's diff) to the conversation |

OpenArc gets `expandOnFailure: false`, so each config stays at its level (with the default `true`, A would escalate to L1 and L2 on name errors and the levels would blur). `intent` is the exercise's `instructions.md` (+ `instructions.append.md`), paragraphs as an array, prefixed with `Exercise "<name>": implement <fn>.`. Examples are the public tests, with the test name as the example name.

Same for every arm: the model and server, `temperature 0`, `seed 1`, context 8192, output cap 4096 tokens (from `matrix.json` `backend`), thinking off, 3 attempts. Models: `qwen3.5:9b` (A, B, C, D) and `qwen2.5:7b-instruct-q4_K_M` (A, D).

### Metrics (one JSONL line per exercise x config x model)

- held-out tests passed, and whether all of them pass (exercise-level pass@1);
- public pass (OpenArc: every region verified; D: every public example passes) and attempts;
- `promptTokens`/`evalTokens`: Ollama's `prompt_eval_count`/`eval_count`, or OpenAI-style `usage.prompt_tokens`/`completion_tokens`, summed over every chat call of the task. OpenArc 0.6.x records no token counts (not in provenance, not in `.openarc/attempts`), so **both arms talk to the backend through a counting proxy** in `run.mjs` (OpenArc's backend `host`/`baseUrl` points at it);
- wall time, and model load time (`load_duration`) so it can be subtracted;
- peak RSS of the Ollama runner (`llama-server` / `ollama runner`), sampled from `/proc` every 2 s; weights on the GPU are not in RSS;
- OpenArc's context-package size in chars per attempt (parsed from `compile` output), levels, and the problems of each failed attempt;
- successes per 1M tokens = exercises with all held-out tests passing / (prompt + output tokens / 1e6).

### Memory safety

One task at a time. Before each model switch every loaded model is unloaded (`/api/generate` with `keep_alive: 0`). Before each task the runner waits until no foreign `openarc compile`/`watch` is running and `MemAvailable` >= 6 GB, unloading models if needed (at most 15 min, then it aborts). During a task, `MemAvailable` < 1 GB kills the task's process group, unloads models, writes an `aborted` line and exits 2. On this 15 GB machine, with `qwen3.5:9b` loaded `MemAvailable` sits just under 6 GB, so in practice every task starts with a cold model load (about 50 s); `modelLoadMs` records it, and the tables show wall time with and without it.

## Fairness notes

- **Unit of retry differs.** OpenArc retries per region (3 attempts each), the baseline per file. Two-function exercises (food-chain, house, variable-length-quantity) can cost OpenArc up to 6 calls versus D's 3. Token counts make this visible.
- **Repair context differs by design.** OpenArc builds a fresh prompt with the exact diagnostics (and raises temperature when the prompt would repeat). D keeps the conversation, so later attempts carry earlier replies. Both are the natural loop for each approach.
- **Failed regions ship nothing.** A region OpenArc can't verify stays a throwing placeholder and scores 0 on held-out tests. D always ships its last attempt, even if public examples fail. So the tables also report **D gated**: D's pass@1 counted only when its public examples passed, the same rule OpenArc applies.
- **OpenArc type-checks; D doesn't.** D's file runs with type stripping only, so type-wrong but behaviour-right code still passes for D.
- **Throw behaviour is never an example.** OpenArc examples can't express "throws" (the spec has no `throws` form), so error cases (binary-search not found, wordy errors, VLQ incomplete) are held-out only, for both arms; both see the instructions that describe them.
- **The signatures are hand-written** (see above), equally for both arms.
- Equality: OpenArc checks examples with its own deep equality; D's public check uses jest's `toEqual` (which ignores `undefined` properties). Held-out tests use jest's `expect` for both.

## OpenArc findings

See `results/2026-10-31-untuned-ollama-full-partial/summary.md` for the list with repro steps, the pilot verdict, and the next-benchmark sketches (ContextBench, CrossCodeEval, Inspect AI).

## Results so far

| dir | what |
|---|---|
| `results/2026-10-31-untuned-ollama-pilot/` | pilot, 30 tasks, open-arc 0.6.3, stock Ollama 0.40.5 |
| `results/2026-10-31-untuned-ollama-full-partial/` | full run paused after 4 of 72 tasks, open-arc 0.6.4 (first build), stock Ollama 0.40.5 |
| `results/2026-11-01-ablations/` | issue #10 ablations: 8 arms x 8 exercises x 3 seeds, qwen2.5-coder-7b on llama-server, open-arc 0.8.0 + env-gated bench patch; see its `summary.md` |
| `results/2026-11-01-efficiency/` | issue #19: arms A, E-resample, D, D-resample on open-arc 0.9.1 (c9c1c62), paired with the ablations; `compare.md` (`node compare.mjs`), `tables.md`. `efficiency-first-try/`: the first 0.9.1 build (lost flatten-array to `arc.flatten`), kept for the record |

## Ablations (issue #10)

Why does OpenArc trail the plain prompt? `matrix-ablations.json` holds one arm per suspected cause, all on the same model, server, sampling and call budget (3 per unit), selectable with `--configs`; `--seed n` sets the backend seed of every arm (OpenArc config `seed`, baseline request `seed`) and is part of the resume key. `ablations.sh <ts-bench> <work> <tgz>` waits for other benchmarks, starts llama-server, runs every arm with seeds 1-3, stops the server. Results: `results/2026-11-01-ablations/`. `efficiency.sh` (same arguments, `matrix-efficiency.json`) reruns A, E-resample, D and D-resample on a newer OpenArc; `node compare.mjs <out.md> <dirs...>` pairs runs by config@version.

| arm | what changes (vs `A`, OpenArc L0) | hypothesis |
|---|---|---|
| `A`, `D` | controls: OpenArc L0 and the whole-file baseline | |
| `A-same-info` | intent is ONE string: the full instructions verbatim, line breaks kept, no 2500-char cap, plus the original stub's comments. The default intent is an array of paragraphs that OpenArc joins with spaces, so code blocks (song lyrics, matrices, transpose examples) lose their line structure | requirement loss |
| `B-oracle` | default intent + `gold/<exercise>.md` (types, built-in signatures, the domain facts the instructions state; written from instructions and stubs only, no solution code, no held-out values) | context selection |
| `C-sketch` | 0.8.0 sketch per function from `sketches/<exercise>.<fn>.ts`: only structure the stub and instructions imply, holes for the logic; every hole sits on a path the public examples reach (else `OARC-W045` blocks the commit) | generation scope |
| `D-min` | `OPENARC_MIN_PROMPT=1` in a locally patched 0.8.0 (`patches/min-prompt.patch`): drops the Rules section, empty Effects/Allowed-imports sections, the long equality note of Examples and the template's imports line. Verification is unchanged. Unset, the patched build is byte-for-byte 0.8.0 behaviour, so every arm runs on it | instruction overhead |
| `E-resample`, `D-resample` | 3 independent samples, no feedback: attempt 1 temperature 0 and the run's seed, attempts 2-3 temperature 0.7 and seed + attempt - 1. OpenArc: three compiles of one attempt each, an unverified region moving to the next round's backend (`regions.<id>.backend`). Baseline: a fresh conversation per attempt | repair strategy |
| every arm (F) | `summarize.mjs` reports raw held-out pass AND accepted-and-correct (counted only when the arm's own public-example gate passed) | acceptance strictness |

Every request body is logged to `results/<dir>/prompts/s<seed>/<config>/<exercise>.jsonl` so prompts can be audited. Each task row records `failCounts` per attempt: compile (type/syntax error or unparseable output; for the baseline, the file did not load), public (a public example failed) and constraint (an OpenArc static rule).
