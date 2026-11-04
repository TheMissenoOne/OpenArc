Tasks: 126 from /tmp/claude-1000/-mnt-data-projetos/0a52dddd-ec03-4d58-8441-c8ccfe4d6411/scratchpad/test1/out. OpenArc 0.10.0. Backends: llama-server-vulkan-json.

Raw = held-out tests on whatever the arm shipped. Accepted-and-correct = counted only when the arm's own gate passed (OpenArc: every region verified on the public examples; baseline: every public example passes). Fail rates are per model attempt: compile = type/syntax error or unparseable output (baseline: the file did not load; it is not type-checked), public = a public example failed, constraint = an OpenArc static rule (imports, forbidden names, effects, calls, sketch containment).

## Per arm and seed

| backend | model | config | seed | n | held-out tests (raw) | exercise pass (raw) | accepted-and-correct exercises | accepted held-out tests | public gate passed | attempts | compile-fail / attempt | public-fail / attempt | constraint violations | mean calls | mean prompt tok | mean output tok | mean wall s |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| llama-server-vulkan-json | qwen3.5-9b-q5km | A | 1 | 21 | 79% (159/202) | 62% (13/21) | 62% (13/21) | 79% (159/202) | 86% (18/21) | 34 | 15% | 26% | 0 | 1.5 | 1342.8 | 531.0 | 19.7 |
| llama-server-vulkan-json | qwen3.5-9b-q5km | A | 2 | 21 | 82% (165/202) | 62% (13/21) | 62% (13/21) | 80% (162/202) | 86% (18/21) | 33 | 15% | 21% | 0 | 1.5 | 1254.5 | 587.7 | 21.3 |
| llama-server-vulkan-json | qwen3.5-9b-q5km | A | 3 | 21 | 79% (159/202) | 62% (13/21) | 62% (13/21) | 79% (159/202) | 86% (18/21) | 33 | 18% | 21% | 0 | 1.5 | 1294.5 | 572.0 | 20.9 |
| llama-server-vulkan-json | qwen3.5-9b-q5km | D | 1 | 21 | 82% (165/202) | 57% (12/21) | 52% (11/21) | 78% (157/202) | 76% (16/21) | 32 | 0% | 50% | 0 | 1.5 | 1440.6 | 648.1 | 21.8 |
| llama-server-vulkan-json | qwen3.5-9b-q5km | D | 2 | 21 | 82% (166/202) | 57% (12/21) | 52% (11/21) | 78% (157/202) | 76% (16/21) | 32 | 0% | 50% | 0 | 1.5 | 1473.0 | 688.6 | 23.1 |
| llama-server-vulkan-json | qwen3.5-9b-q5km | D | 3 | 21 | 82% (166/202) | 57% (12/21) | 52% (11/21) | 78% (157/202) | 76% (16/21) | 32 | 0% | 50% | 0 | 1.5 | 1440.6 | 641.8 | 21.5 |

## Mean over seeds, with 95% task-level bootstrap CIs (10000 resamples of the 21 exercises)

| backend | model | config | seeds | exercise pass (raw) | accepted-and-correct | held-out tests (raw, pooled) | held-out tests (accepted) | mean tokens/task | mean wall s/task |
|---|---|---|---|---|---|---|---|---|---|
| llama-server-vulkan-json | qwen3.5-9b-q5km | A | 1,2,3 | 62% [41%, 81%] | 62% [41%, 81%] | 80% [66%, 91%] | 79% [65%, 90%] | 1860.8 | 20.6 |
| llama-server-vulkan-json | qwen3.5-9b-q5km | D | 1,2,3 | 57% [33%, 76%] | 52% [29%, 71%] | 82% [66%, 93%] | 78% [59%, 91%] | 2110.9 | 22.1 |

## Paired difference vs A (exercise pass, percentage points; mean over seeds, 95% bootstrap CI over exercises)

| backend | model | config | raw diff | accepted-and-correct diff |
|---|---|---|---|---|
| llama-server-vulkan-json | qwen3.5-9b-q5km | D | -4.8 [-20.6, +11.1] | -9.5 [-27.0, +7.9] |

## Paired difference vs D (exercise pass, percentage points; mean over seeds, 95% bootstrap CI over exercises)

| backend | model | config | raw diff | accepted-and-correct diff |
|---|---|---|---|---|
| llama-server-vulkan-json | qwen3.5-9b-q5km | A | +4.8 [-11.1, +20.6] | +9.5 [-7.9, +27.0] |

## Per exercise: seeds with all held-out tests passing, raw / accepted (mean held-out tests passed)

| exercise | A | D |
|---|---|---|
| alphametics | 0/0 of 3 (0.0/5) | 0/0 of 3 (1.7/5) |
| atbash-cipher | 3/3 of 3 (7.0/7) | 3/3 of 3 (7.0/7) |
| bob | 3/3 of 3 (21.0/21) | 3/3 of 3 (21.0/21) |
| etl | 3/3 of 3 (2.0/2) | 3/3 of 3 (2.0/2) |
| house | 1/1 of 3 (3.3/10) | 0/0 of 3 (0.0/10) |
| knapsack | 3/3 of 3 (4.0/4) | 3/3 of 3 (4.0/4) |
| largest-series-product | 0/0 of 3 (6.0/10) | 0/0 of 3 (6.0/10) |
| nucleotide-count | 3/3 of 3 (3.0/3) | 0/0 of 3 (2.0/3) |
| ocr-numbers | 0/0 of 3 (8.0/13) | 0/0 of 3 (12.0/13) |
| perfect-numbers | 3/3 of 3 (10.0/10) | 3/3 of 3 (10.0/10) |
| prime-factors | 3/3 of 3 (9.0/9) | 3/3 of 3 (9.0/9) |
| protein-translation | 0/0 of 3 (23.0/26) | 3/3 of 3 (26.0/26) |
| relative-distance | 0/0 of 3 (0.0/4) | 0/0 of 3 (1.0/4) |
| resistor-color-trio | 0/0 of 3 (4.0/7) | 0/0 of 3 (6.0/7) |
| roman-numerals | 3/3 of 3 (23.0/23) | 3/3 of 3 (23.0/23) |
| rotational-cipher | 3/3 of 3 (7.0/7) | 3/3 of 3 (7.0/7) |
| run-length-encoding | 2/2 of 3 (5.7/7) | 0/0 of 3 (0.0/7) |
| saddle-points | 3/3 of 3 (6.0/6) | 3/0 of 3 (6.0/6) |
| say | 0/0 of 3 (8.0/17) | 0/0 of 3 (11.0/17) |
| secret-handshake | 3/3 of 3 (8.0/8) | 3/3 of 3 (8.0/8) |
| sieve | 3/3 of 3 (3.0/3) | 3/3 of 3 (3.0/3) |
