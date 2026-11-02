Tasks: 48 from /mnt/data/projetos/openarc-wt-ablations/bench/results/2026-11-01-prompt-trim. OpenArc 0.9.3. Backends: llama-server-vulkan-json.

Raw = held-out tests on whatever the arm shipped. Accepted-and-correct = counted only when the arm's own gate passed (OpenArc: every region verified on the public examples; baseline: every public example passes). Fail rates are per model attempt: compile = type/syntax error or unparseable output (baseline: the file did not load; it is not type-checked), public = a public example failed, constraint = an OpenArc static rule (imports, forbidden names, effects, calls, sketch containment).

## Per arm and seed

| backend | model | config | seed | n | held-out tests (raw) | exercise pass (raw) | accepted-and-correct exercises | accepted held-out tests | public gate passed | attempts | compile-fail / attempt | public-fail / attempt | constraint violations | mean calls | mean prompt tok | mean output tok | mean wall s |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| llama-server-vulkan-json | qwen2.5-coder-7b | A | 1 | 8 | 40% (23/57) | 25% (2/8) | 25% (2/8) | 40% (23/57) | 63% (5/8) | 17 | 6% | 65% | 0 | 2.0 | 1620.5 | 367.1 | 9.4 |
| llama-server-vulkan-json | qwen2.5-coder-7b | A | 2 | 8 | 40% (23/57) | 25% (2/8) | 25% (2/8) | 40% (23/57) | 63% (5/8) | 17 | 6% | 65% | 0 | 2.0 | 1642.4 | 415.1 | 10.3 |
| llama-server-vulkan-json | qwen2.5-coder-7b | A | 3 | 8 | 40% (23/57) | 25% (2/8) | 25% (2/8) | 40% (23/57) | 63% (5/8) | 17 | 18% | 53% | 0 | 2.0 | 1622.9 | 434.0 | 10.6 |
| llama-server-vulkan-json | qwen2.5-coder-7b | E-resample | 1 | 8 | 40% (23/57) | 25% (2/8) | 25% (2/8) | 40% (23/57) | 63% (5/8) | 17 | 24% | 47% | 0 | 1.8 | 1480.0 | 482.0 | 11.1 |
| llama-server-vulkan-json | qwen2.5-coder-7b | E-resample | 2 | 8 | 49% (28/57) | 25% (2/8) | 25% (2/8) | 40% (23/57) | 63% (5/8) | 17 | 18% | 47% | 0 | 1.8 | 1480.0 | 382.1 | 9.3 |
| llama-server-vulkan-json | qwen2.5-coder-7b | E-resample | 3 | 8 | 51% (29/57) | 38% (3/8) | 38% (3/8) | 51% (29/57) | 75% (6/8) | 16 | 13% | 44% | 0 | 1.8 | 1373.8 | 356.3 | 8.9 |

## Mean over seeds, with 95% task-level bootstrap CIs (10000 resamples of the 8 exercises)

| backend | model | config | seeds | exercise pass (raw) | accepted-and-correct | held-out tests (raw, pooled) | held-out tests (accepted) | mean tokens/task | mean wall s/task |
|---|---|---|---|---|---|---|---|---|---|
| llama-server-vulkan-json | qwen2.5-coder-7b | A | 1,2,3 | 25% [0%, 63%] | 25% [0%, 63%] | 40% [22%, 62%] | 40% [22%, 62%] | 2034.0 | 10.1 |
| llama-server-vulkan-json | qwen2.5-coder-7b | E-resample | 1,2,3 | 29% [4%, 63%] | 29% [4%, 63%] | 47% [32%, 69%] | 44% [29%, 64%] | 1851.4 | 9.8 |

## Paired difference vs A (exercise pass, percentage points; mean over seeds, 95% bootstrap CI over exercises)

| backend | model | config | raw diff | accepted-and-correct diff |
|---|---|---|---|---|
| llama-server-vulkan-json | qwen2.5-coder-7b | E-resample | +4.2 [+0.0, +12.5] | +4.2 [+0.0, +12.5] |

## Per exercise: seeds with all held-out tests passing, raw / accepted (mean held-out tests passed)

| exercise | A | E-resample |
|---|---|---|
| acronym | 0/0 of 3 (0.0/3) | 0/0 of 3 (0.0/3) |
| binary-search | 0/0 of 3 (3.0/8) | 0/0 of 3 (3.0/8) |
| flatten-array | 3/3 of 3 (3.0/3) | 3/3 of 3 (3.0/3) |
| food-chain | 0/0 of 3 (0.0/6) | 1/1 of 3 (3.7/6) |
| relative-distance | 0/0 of 3 (0.0/4) | 0/0 of 3 (0.0/4) |
| spiral-matrix | 3/3 of 3 (4.0/4) | 3/3 of 3 (4.0/4) |
| transpose | 0/0 of 3 (6.0/9) | 0/0 of 3 (6.0/9) |
| wordy | 0/0 of 3 (7.0/20) | 0/0 of 3 (7.0/20) |
