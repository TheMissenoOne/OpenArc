# Ablations: why OpenArc trails plain prompting (issue #10)

Setup: qwen2.5-coder-7b Q4_K_M on llama.cpp `llama-server` (Vulkan, build f3586e6, the model screen's flags: `-ngl 99 -c 8192 -fa on -np 1 --cache-ram 0 --reasoning off --jinja --no-webui`, port 18080), `outputFormat: "json"`, context 8192, output cap 4096, temperature 0, 3 calls per unit, the same 8 exercises and splits as the model screen (57 held-out tests). OpenArc 0.8.0 with the env-gated bench patch (`../../patches/min-prompt.patch`; only `D-min` sets `OPENARC_MIN_PROMPT=1`). 8 arms x 8 exercises x seeds 1, 2, 3 = 192 tasks, no errors, no aborts, 37 min of runs. Arms: see `../../README.md`, "Ablations", and `../../matrix-ablations.json`. Every prompt sent is in `prompts/`. Full tables: `tables.md`. Rerun: `bench/ablations.sh`, then `node summarize.mjs` and `node ungated.mjs`.

The controls reproduce the model screen exactly (A 23/57 and 2/8, D 27/57 and 3/8; the screen ran open-arc 0.7.1).

**Seeds barely matter here.** At temperature 0 llama-server is deterministic, so the seed only changes the temperature-0.7 resamples (E-resample, D-resample). Seeds 1-3 are identical for every other arm. The intervals below are therefore over the 8 exercises only, and n = 8 means one exercise is 12.5 points.

## Per arm and seed

Raw = held-out tests on what the arm shipped. Accepted-and-correct = counted only when the arm's own gate passed (OpenArc: every region verified on the public examples; baseline: every public example passes). Fail rates are per model attempt: compile = type error, syntax error or unparseable output (baseline: the file did not load, since it isn't type-checked); public = a public example failed; constraint = an OpenArc static rule (here only `OARC-E099`, the sketch was not preserved).

| backend | model | config | seed | n | held-out tests (raw) | exercise pass (raw) | accepted-and-correct exercises | accepted held-out tests | public gate passed | attempts | compile-fail / attempt | public-fail / attempt | constraint violations | mean calls | mean prompt tok | mean output tok | mean wall s |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| llama-server-vulkan-json | qwen2.5-coder-7b | A-same-info | 1 | 8 | 28% (16/57) | 25% (2/8) | 25% (2/8) | 28% (16/57) | 50% (4/8) | 21 | 24% | 57% | 0 | 2.6 | 2957.9 | 623.4 | 14.7 |
| llama-server-vulkan-json | qwen2.5-coder-7b | A-same-info | 2 | 8 | 28% (16/57) | 25% (2/8) | 25% (2/8) | 28% (16/57) | 50% (4/8) | 21 | 24% | 57% | 0 | 2.6 | 2963.3 | 624.9 | 14.7 |
| llama-server-vulkan-json | qwen2.5-coder-7b | A-same-info | 3 | 8 | 28% (16/57) | 25% (2/8) | 25% (2/8) | 28% (16/57) | 50% (4/8) | 21 | 24% | 57% | 0 | 2.6 | 2963.3 | 625.1 | 14.7 |
| llama-server-vulkan-json | qwen2.5-coder-7b | A | 1 | 8 | 40% (23/57) | 25% (2/8) | 25% (2/8) | 40% (23/57) | 63% (5/8) | 17 | 18% | 53% | 0 | 2.1 | 2276.5 | 369.6 | 9.7 |
| llama-server-vulkan-json | qwen2.5-coder-7b | A | 2 | 8 | 40% (23/57) | 25% (2/8) | 25% (2/8) | 40% (23/57) | 63% (5/8) | 17 | 18% | 53% | 0 | 2.1 | 2276.5 | 369.4 | 9.6 |
| llama-server-vulkan-json | qwen2.5-coder-7b | A | 3 | 8 | 40% (23/57) | 25% (2/8) | 25% (2/8) | 40% (23/57) | 63% (5/8) | 17 | 18% | 53% | 0 | 2.1 | 2276.5 | 369.6 | 9.6 |
| llama-server-vulkan-json | qwen2.5-coder-7b | B-oracle | 1 | 8 | 23% (13/57) | 13% (1/8) | 13% (1/8) | 23% (13/57) | 38% (3/8) | 21 | 57% | 29% | 0 | 2.6 | 3531.1 | 574.4 | 13.8 |
| llama-server-vulkan-json | qwen2.5-coder-7b | B-oracle | 2 | 8 | 23% (13/57) | 13% (1/8) | 13% (1/8) | 23% (13/57) | 38% (3/8) | 21 | 57% | 29% | 0 | 2.6 | 3529.6 | 569.3 | 13.7 |
| llama-server-vulkan-json | qwen2.5-coder-7b | B-oracle | 3 | 8 | 23% (13/57) | 13% (1/8) | 13% (1/8) | 23% (13/57) | 38% (3/8) | 21 | 57% | 29% | 0 | 2.6 | 3531.1 | 573.4 | 13.8 |
| llama-server-vulkan-json | qwen2.5-coder-7b | C-sketch | 1 | 8 | 18% (10/57) | 25% (2/8) | 25% (2/8) | 18% (10/57) | 38% (3/8) | 22 | 5% | 55% | 6 | 2.8 | 3474.3 | 285.9 | 8.7 |
| llama-server-vulkan-json | qwen2.5-coder-7b | C-sketch | 2 | 8 | 18% (10/57) | 25% (2/8) | 25% (2/8) | 18% (10/57) | 38% (3/8) | 22 | 5% | 55% | 6 | 2.8 | 3474.3 | 289.4 | 8.7 |
| llama-server-vulkan-json | qwen2.5-coder-7b | C-sketch | 3 | 8 | 18% (10/57) | 25% (2/8) | 25% (2/8) | 18% (10/57) | 38% (3/8) | 22 | 5% | 55% | 6 | 2.8 | 3474.3 | 286.0 | 8.6 |
| llama-server-vulkan-json | qwen2.5-coder-7b | D-min | 1 | 8 | 23% (13/57) | 13% (1/8) | 13% (1/8) | 23% (13/57) | 38% (3/8) | 21 | 29% | 57% | 0 | 2.6 | 2048.1 | 468.9 | 11.3 |
| llama-server-vulkan-json | qwen2.5-coder-7b | D-min | 2 | 8 | 23% (13/57) | 13% (1/8) | 13% (1/8) | 23% (13/57) | 38% (3/8) | 21 | 29% | 57% | 0 | 2.6 | 2048.1 | 468.9 | 11.3 |
| llama-server-vulkan-json | qwen2.5-coder-7b | D-min | 3 | 8 | 23% (13/57) | 13% (1/8) | 13% (1/8) | 23% (13/57) | 38% (3/8) | 21 | 29% | 57% | 0 | 2.6 | 2048.1 | 468.9 | 11.3 |
| llama-server-vulkan-json | qwen2.5-coder-7b | D-resample | 1 | 8 | 47% (27/57) | 38% (3/8) | 25% (2/8) | 40% (23/57) | 63% (5/8) | 14 | 0% | 64% | 0 | 1.8 | 981.1 | 359.4 | 7.4 |
| llama-server-vulkan-json | qwen2.5-coder-7b | D-resample | 2 | 8 | 47% (27/57) | 38% (3/8) | 25% (2/8) | 40% (23/57) | 63% (5/8) | 14 | 0% | 64% | 0 | 1.8 | 981.1 | 398.8 | 8.1 |
| llama-server-vulkan-json | qwen2.5-coder-7b | D-resample | 3 | 8 | 46% (26/57) | 38% (3/8) | 25% (2/8) | 40% (23/57) | 63% (5/8) | 14 | 7% | 57% | 0 | 1.8 | 981.1 | 407.0 | 8.2 |
| llama-server-vulkan-json | qwen2.5-coder-7b | D | 1 | 8 | 47% (27/57) | 38% (3/8) | 25% (2/8) | 40% (23/57) | 63% (5/8) | 14 | 0% | 64% | 0 | 1.8 | 1398.5 | 353.9 | 7.4 |
| llama-server-vulkan-json | qwen2.5-coder-7b | D | 2 | 8 | 47% (27/57) | 38% (3/8) | 25% (2/8) | 40% (23/57) | 63% (5/8) | 14 | 0% | 64% | 0 | 1.8 | 1398.5 | 353.9 | 7.4 |
| llama-server-vulkan-json | qwen2.5-coder-7b | D | 3 | 8 | 47% (27/57) | 38% (3/8) | 25% (2/8) | 40% (23/57) | 63% (5/8) | 14 | 0% | 64% | 0 | 1.8 | 1398.5 | 353.9 | 7.4 |
| llama-server-vulkan-json | qwen2.5-coder-7b | E-resample | 1 | 8 | 40% (23/57) | 25% (2/8) | 25% (2/8) | 40% (23/57) | 63% (5/8) | 17 | 24% | 47% | 0 | 2.1 | 2047.0 | 468.1 | 11.9 |
| llama-server-vulkan-json | qwen2.5-coder-7b | E-resample | 2 | 8 | 40% (23/57) | 25% (2/8) | 25% (2/8) | 40% (23/57) | 63% (5/8) | 17 | 24% | 47% | 0 | 2.1 | 2047.0 | 493.4 | 12.3 |
| llama-server-vulkan-json | qwen2.5-coder-7b | E-resample | 3 | 8 | 40% (23/57) | 25% (2/8) | 25% (2/8) | 40% (23/57) | 63% (5/8) | 17 | 24% | 47% | 0 | 2.1 | 2047.0 | 399.4 | 10.6 |


## Mean over seeds, 95% task-level bootstrap CIs (10000 resamples of the 8 exercises)

| backend | model | config | seeds | exercise pass (raw) | accepted-and-correct | held-out tests (raw, pooled) | held-out tests (accepted) | mean tokens/task | mean wall s/task |
|---|---|---|---|---|---|---|---|---|---|
| llama-server-vulkan-json | qwen2.5-coder-7b | A | 1,2,3 | 25% [0%, 63%] | 25% [0%, 63%] | 40% [22%, 62%] | 40% [22%, 62%] | 2646.0 | 9.7 |
| llama-server-vulkan-json | qwen2.5-coder-7b | A-same-info | 1,2,3 | 25% [0%, 63%] | 25% [0%, 63%] | 28% [7%, 61%] | 28% [7%, 61%] | 3585.9 | 14.7 |
| llama-server-vulkan-json | qwen2.5-coder-7b | B-oracle | 1,2,3 | 13% [0%, 38%] | 13% [0%, 38%] | 23% [3%, 52%] | 23% [3%, 52%] | 4103.0 | 13.7 |
| llama-server-vulkan-json | qwen2.5-coder-7b | C-sketch | 1,2,3 | 25% [0%, 63%] | 25% [0%, 63%] | 18% [3%, 49%] | 18% [3%, 49%] | 3761.3 | 8.7 |
| llama-server-vulkan-json | qwen2.5-coder-7b | D | 1,2,3 | 38% [13%, 75%] | 25% [0%, 63%] | 47% [31%, 73%] | 40% [22%, 62%] | 1752.4 | 7.4 |
| llama-server-vulkan-json | qwen2.5-coder-7b | D-min | 1,2,3 | 13% [0%, 38%] | 13% [0%, 38%] | 23% [3%, 52%] | 23% [3%, 52%] | 2517.0 | 11.3 |
| llama-server-vulkan-json | qwen2.5-coder-7b | D-resample | 1,2,3 | 38% [13%, 75%] | 25% [0%, 63%] | 47% [30%, 72%] | 40% [22%, 62%] | 1369.5 | 7.9 |
| llama-server-vulkan-json | qwen2.5-coder-7b | E-resample | 1,2,3 | 25% [0%, 63%] | 25% [0%, 63%] | 40% [22%, 62%] | 40% [22%, 62%] | 2500.6 | 11.6 |


Paired differences in exercise pass (percentage points, 95% bootstrap CI over exercises):

| arm | vs A, raw | vs A, accepted | vs D, raw | vs D, accepted |
|---|---|---|---|---|
| D | +12.5 [0, +37.5] | 0 [0, 0] | | |
| A | | | -12.5 [-37.5, 0] | 0 [0, 0] |
| A-same-info | 0 [0, 0] | 0 [0, 0] | -12.5 [-37.5, 0] | 0 [0, 0] |
| B-oracle | -12.5 [-37.5, 0] | -12.5 [-37.5, 0] | -25.0 [-62.5, 0] | -12.5 [-37.5, 0] |
| C-sketch | 0 [0, 0] | 0 [0, 0] | -12.5 [-37.5, 0] | 0 [0, 0] |
| D-min | -12.5 [-37.5, 0] | -12.5 [-37.5, 0] | -25.0 [-62.5, 0] | -12.5 [-37.5, 0] |
| E-resample | 0 [0, 0] | 0 [0, 0] | -12.5 [-37.5, 0] | 0 [0, 0] |
| D-resample | +12.5 [0, +37.5] | 0 [0, 0] | 0 [0, 0] | 0 [0, 0] |

Per exercise (seeds where every held-out test passes, raw / accepted, out of 3; mean held-out tests passed):

| exercise | A | A-same-info | B-oracle | C-sketch | D-min | E-resample | D | D-resample |
|---|---|---|---|---|---|---|---|---|
| acronym | 0/0 (0/3) | 0/0 (0/3) | 0/0 (0/3) | 0/0 (0/3) | 0/0 (0/3) | 0/0 (0/3) | **3/0 (3/3)** | **3/0 (3/3)** |
| binary-search | 0/0 (3/8) | 0/0 (3/8) | 0/0 (3/8) | 0/0 (3/8) | 0/0 (3/8) | 0/0 (3/8) | 0/0 (3/8) | 0/0 (3/8) |
| flatten-array | 3/3 | 3/3 | **0/0** | 3/3 | **0/0** | 3/3 | 3/3 | 3/3 |
| food-chain | 0/0 (0/6) | 0/0 (0/6) | 0/0 (0/6) | 0/0 (0/6) | 0/0 (0/6) | 0/0 (0/6) | 0/0 (0/6) | 0/0 (0/6) |
| relative-distance | 0/0 (0/4) | 0/0 (0/4) | 0/0 (0/4) | 0/0 (0/4) | 0/0 (0/4) | 0/0 (0/4) | 0/0 (1/4) | 0/0 (0.7/4) |
| spiral-matrix | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 |
| transpose | 0/0 (6/9) | 0/0 (6/9) | 0/0 (6/9) | 0/0 (**0/9**) | 0/0 (6/9) | 0/0 (6/9) | 0/0 (6/9) | 0/0 (6/9) |
| wordy | 0/0 (7/20) | 0/0 (**0/20**) | 0/0 (**0/20**) | 0/0 (**0/20**) | 0/0 (**0/20**) | 0/0 (7/20) | 0/0 (7/20) | 0/0 (7/20) |

## F, counterfactual: OpenArc "ungated"

OpenArc ships nothing for a region it can't verify (a throwing placeholder), while the baseline ships its last file even when public examples fail. `ungated.jsonl` (from `bench/ungated.mjs`) splices each failed region's LAST attempt into the file and runs the held-out tests, i.e. OpenArc shipping the way D ships:

| arm | held-out tests, gated (as shipped) | held-out tests, ungated | exercise pass, ungated (of 24) |
|---|---|---|---|
| A | 69/171 (40%) | 72/171 (42%) | 6 (25%) |
| A-same-info | 48/171 (28%) | 51/171 (30%) | 6 (25%) |
| B-oracle | 39/171 (23%) | 42/171 (25%) | 3 (13%) |
| C-sketch | 30/171 (18%) | 48/171 (28%) | 9 (38%) |
| D-min | 39/171 (23%) | 42/171 (25%) | 3 (13%) |
| E-resample | 69/171 (40%) | **78/171 (46%)** | **8 (33%)** |
| D (raw, for reference) | 81/171 (47%) | | 9 (38%) |

## Diagnostics

- **The whole exercise-level gap is acronym, and the gate decides it.** D's file is `phrase.split(/[\s-]+/).map(w => w[0].toUpperCase())`: it fails the public example "HyperText Markup Language" -> "HTML" (gives "HML") on all 3 attempts, so it is NOT accepted, yet it passes all 3 held-out tests (none of them is camel-cased). OpenArc's first body strips the spaces before splitting (`"P"` for "PNG") and its repairs repeat it; when resampling (or a sketch) gets OpenArc to D's algorithm, the gate rejects it on the same "HTML" example. Accepted-and-correct is 2/8 for A, D and every arm except B-oracle and D-min.
- **Repair is close to a no-op for this model.** No unit in A, B-oracle, D-min, E-resample, D or D-resample passed on attempt 2 or 3 (passes after a retry: 1 unit per seed in A-same-info and in C-sketch). Of D's 9 repair replies, all 9 are byte-identical to the previous reply; of A's 24 retries, 14 are identical to the previous body (the third, identical prompt gets temperature 0.4 and usually returns the same code).
- **Body-only protocol failures.** In 9 of A's 36 failed attempts (33 of 54 in B-oracle) the 7B returns a whole function definition (`const verse: VerseFn = (n) => {...}`) as the "body", which type-checks as a function returning void (TS2322). In C-sketch the same habit shows as statements written into an expression hole (`return (const visited = ...; ...)`), E099. The baseline never has this failure: it writes the whole file.
- **Every prompt change loses wordy.** A and D both get 7/20 on wordy with a body that passes the 3 public examples. With the full instructions (A-same-info) or the minimal prompt (D-min), the 7B writes a stricter parser that rejects "What is 1 plus 1?" ("Unsupported operation: 1"); with the gold context it returns a whole function as the body (TS2322); with the sketch it types a hole wrong and then makes the same parsing mistake. In every case the region is not accepted and ships nothing.
- **Gold and minimal prompts break flatten-array** through `input.flat(Infinity)` on the recursive `Nested` type: TS2589 (type instantiation excessively deep). The gold context lists `Array.prototype.flat`; D-min's first attempt also imports `flatten` from "open-arc". The baseline isn't type-checked, so the same code would pass there.

## Verdict (n = 8 exercises, one model; read every claim as "consistent with", not "shown")

| hypothesis | arm | what the data says |
|---|---|---|
| acceptance strictness | F (all arms), ungated | **Supported; it accounts for the whole exercise-level gap.** Accepted-and-correct: A = D = 25% (diff 0 [0, 0]). The raw gap is one exercise (acronym) where D ships a public-failing file that happens to pass the held-out tests. Ungated OpenArc with resampling comes within one exercise and 3 tests of D (8 vs 9 of 24, 78 vs 81 of 171). |
| repair strategy | E | **Partly.** At equal budget, resampling = repair on every gated metric (diff 0 [0, 0]) for both OpenArc and the baseline, because both loops mostly repeat themselves at temperature 0. Resampling does produce more different candidates: ungated it adds acronym on 2 of 3 seeds (+6 held-out tests). Diagnostic feedback buys nothing for this model. |
| requirement loss | A-same-info | **Not supported.** Keeping line breaks and the full text (the default intent flattens song lyrics and matrices into one line) changes no exercise and costs 7 held-out tests (wordy). |
| context selection | B-oracle | **Not supported, rather the opposite.** Hand-picked gold context lowers the score (-12.5 [-37.5, 0] vs A) and raises the compile-fail rate from 18% to 57% per attempt. |
| generation scope | C-sketch | **Not supported at this size.** Same exercise pass as A; fewer held-out tests (18% vs 40%) because the transpose and wordy regions no longer pass their public examples, so they ship nothing; 6 E099 violations per seed (the model rewrites the sketch). Ungated, sketches do help acronym (3/3 on every seed). |
| instruction overhead | D-min | **Not supported.** Dropping the Rules/effects/imports text saves about 230 prompt tokens per task and loses flatten-array (-12.5 [-37.5, 0] vs A). |

Bottom line: on these 8 exercises with a 7B model, OpenArc does not lose because of what its prompt contains. Each change to the prompt (more info, gold context, sketches, less text) made things the same or worse, and each one's intervals overlap A's. The gap to the plain prompt is the acceptance gate (OpenArc refuses to ship code that fails a public example; the baseline ships it, and here that code passes the held-out tests), plus a repair loop that can't get the 7B to change its answer. The issue's other run fits this: with Claude Haiku (via subagents) on the same 8 exercises, OpenArc A-json got 5/8 (43/57 held-out) against the plain prompt's 6/8 (44/57). That gap is within noise, so the local gap is mostly about small-model capability, and the pipeline costs a 7B mainly through the strict gate and the body-only output contract.

Suggested next steps: report accepted-and-correct as the headline metric for every arm; let repair retries vary sampling by default (or resample) instead of resending at temperature 0; to spend the call budget better, accept a "best effort" region marked unverified (W-level, not shipped as verified) so the two arms ship on the same terms; and move to tasks where context matters (ContextBench TypeScript) before judging context selection.

## What was skipped, and caveats

- Nothing was skipped: every exercise has a sketch (`../../sketches/`) and a gold file (`../../gold/`). The food-chain `verse` sketch fixes almost nothing (only the line joining), because the song's structure is the algorithm; `verses` fixes only the loop over verse(n).
- E-resample for OpenArc needed no engine change: each round is a separate compile of 1 attempt, and an unverified region moves to the next round's backend (`regions.<id>.backend`, seed + round - 1, temperature 0.7). Verified regions keep theirs, so their fingerprints don't change.
- `D-min` is the only engine change (env-gated, recorded in `../../patches/min-prompt.patch`). `/mnt/data/projetos/openarc/stage0` was not touched.
- binary-search (5 throw tests with a specific message), food-chain (no arm passes) and wordy (13 error tests with specific messages) can't reach an exercise pass in any arm, so 3 of the 8 exercises carry no signal at the exercise level.
- The baseline's compile-fail rate is not comparable to OpenArc's: the baseline runs type-stripped and is never type-checked (flatten's TS2589 would not fail it).
- The token proxy now streams responses (ported from the live harness), so a slow generation can't trip OpenArc's 300 s fetch timeout. No call came close here (the longest task took 62 s).
