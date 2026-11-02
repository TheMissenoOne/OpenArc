Tasks: 96 from results/2026-11-01-efficiency. OpenArc 0.9.1. Backends: llama-server-vulkan-json.

Raw = held-out tests on whatever the arm shipped. Accepted-and-correct = counted only when the arm's own gate passed (OpenArc: every region verified on the public examples; baseline: every public example passes). Fail rates are per model attempt: compile = type/syntax error or unparseable output (baseline: the file did not load; it is not type-checked), public = a public example failed, constraint = an OpenArc static rule (imports, forbidden names, effects, calls, sketch containment).

## Per arm and seed

| backend | model | config | seed | n | held-out tests (raw) | exercise pass (raw) | accepted-and-correct exercises | accepted held-out tests | public gate passed | attempts | compile-fail / attempt | public-fail / attempt | constraint violations | mean calls | mean prompt tok | mean output tok | mean wall s |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| llama-server-vulkan-json | qwen2.5-coder-7b | A | 1 | 8 | 40% (23/57) | 25% (2/8) | 25% (2/8) | 40% (23/57) | 63% (5/8) | 17 | 0% | 71% | 0 | 2.1 | 1923.8 | 371.4 | 9.4 |
| llama-server-vulkan-json | qwen2.5-coder-7b | A | 2 | 8 | 40% (23/57) | 25% (2/8) | 25% (2/8) | 40% (23/57) | 63% (5/8) | 17 | 0% | 71% | 0 | 2.1 | 1926.9 | 378.5 | 9.6 |
| llama-server-vulkan-json | qwen2.5-coder-7b | A | 3 | 8 | 40% (23/57) | 25% (2/8) | 25% (2/8) | 40% (23/57) | 63% (5/8) | 17 | 0% | 71% | 0 | 2.1 | 1933.0 | 383.4 | 9.7 |
| llama-server-vulkan-json | qwen2.5-coder-7b | D-resample | 1 | 8 | 47% (27/57) | 38% (3/8) | 25% (2/8) | 40% (23/57) | 63% (5/8) | 14 | 0% | 64% | 0 | 1.8 | 981.1 | 359.4 | 6.8 |
| llama-server-vulkan-json | qwen2.5-coder-7b | D-resample | 2 | 8 | 47% (27/57) | 38% (3/8) | 25% (2/8) | 40% (23/57) | 63% (5/8) | 14 | 0% | 64% | 0 | 1.8 | 981.1 | 398.8 | 7.5 |
| llama-server-vulkan-json | qwen2.5-coder-7b | D-resample | 3 | 8 | 46% (26/57) | 38% (3/8) | 25% (2/8) | 40% (23/57) | 63% (5/8) | 14 | 7% | 57% | 0 | 1.8 | 981.1 | 344.3 | 6.5 |
| llama-server-vulkan-json | qwen2.5-coder-7b | D | 1 | 8 | 47% (27/57) | 38% (3/8) | 25% (2/8) | 40% (23/57) | 63% (5/8) | 14 | 0% | 64% | 0 | 1.8 | 1398.5 | 353.9 | 7.4 |
| llama-server-vulkan-json | qwen2.5-coder-7b | D | 2 | 8 | 47% (27/57) | 38% (3/8) | 25% (2/8) | 40% (23/57) | 63% (5/8) | 14 | 0% | 64% | 0 | 1.8 | 1398.5 | 353.9 | 7.4 |
| llama-server-vulkan-json | qwen2.5-coder-7b | D | 3 | 8 | 47% (27/57) | 38% (3/8) | 25% (2/8) | 40% (23/57) | 63% (5/8) | 14 | 0% | 64% | 0 | 1.8 | 1398.5 | 353.9 | 7.4 |
| llama-server-vulkan-json | qwen2.5-coder-7b | E-resample | 1 | 8 | 40% (23/57) | 25% (2/8) | 25% (2/8) | 40% (23/57) | 63% (5/8) | 17 | 24% | 47% | 0 | 2.1 | 1607.1 | 397.0 | 10.0 |
| llama-server-vulkan-json | qwen2.5-coder-7b | E-resample | 2 | 8 | 40% (23/57) | 25% (2/8) | 25% (2/8) | 40% (23/57) | 63% (5/8) | 17 | 18% | 53% | 0 | 2.1 | 1607.1 | 395.3 | 10.0 |
| llama-server-vulkan-json | qwen2.5-coder-7b | E-resample | 3 | 8 | 40% (23/57) | 25% (2/8) | 25% (2/8) | 40% (23/57) | 63% (5/8) | 17 | 18% | 53% | 0 | 2.1 | 1607.1 | 401.3 | 10.1 |

## Mean over seeds, with 95% task-level bootstrap CIs (10000 resamples of the 8 exercises)

| backend | model | config | seeds | exercise pass (raw) | accepted-and-correct | held-out tests (raw, pooled) | held-out tests (accepted) | mean tokens/task | mean wall s/task |
|---|---|---|---|---|---|---|---|---|---|
| llama-server-vulkan-json | qwen2.5-coder-7b | A | 1,2,3 | 25% [0%, 63%] | 25% [0%, 63%] | 40% [22%, 62%] | 40% [22%, 62%] | 2305.6 | 9.6 |
| llama-server-vulkan-json | qwen2.5-coder-7b | D | 1,2,3 | 38% [13%, 75%] | 25% [0%, 63%] | 47% [31%, 73%] | 40% [22%, 62%] | 1752.4 | 7.4 |
| llama-server-vulkan-json | qwen2.5-coder-7b | D-resample | 1,2,3 | 38% [13%, 75%] | 25% [0%, 63%] | 47% [30%, 72%] | 40% [22%, 62%] | 1348.6 | 7.0 |
| llama-server-vulkan-json | qwen2.5-coder-7b | E-resample | 1,2,3 | 25% [0%, 63%] | 25% [0%, 63%] | 40% [22%, 62%] | 40% [22%, 62%] | 2005.0 | 10.0 |

## Paired difference vs A (exercise pass, percentage points; mean over seeds, 95% bootstrap CI over exercises)

| backend | model | config | raw diff | accepted-and-correct diff |
|---|---|---|---|---|
| llama-server-vulkan-json | qwen2.5-coder-7b | D | +12.5 [+0.0, +37.5] | +0.0 [+0.0, +0.0] |
| llama-server-vulkan-json | qwen2.5-coder-7b | D-resample | +12.5 [+0.0, +37.5] | +0.0 [+0.0, +0.0] |
| llama-server-vulkan-json | qwen2.5-coder-7b | E-resample | +0.0 [+0.0, +0.0] | +0.0 [+0.0, +0.0] |

## Paired difference vs D (exercise pass, percentage points; mean over seeds, 95% bootstrap CI over exercises)

| backend | model | config | raw diff | accepted-and-correct diff |
|---|---|---|---|---|
| llama-server-vulkan-json | qwen2.5-coder-7b | A | -12.5 [-37.5, +0.0] | +0.0 [+0.0, +0.0] |
| llama-server-vulkan-json | qwen2.5-coder-7b | D-resample | +0.0 [+0.0, +0.0] | +0.0 [+0.0, +0.0] |
| llama-server-vulkan-json | qwen2.5-coder-7b | E-resample | -12.5 [-37.5, +0.0] | +0.0 [+0.0, +0.0] |

## Per exercise: seeds with all held-out tests passing, raw / accepted (mean held-out tests passed)

| exercise | A | D | D-resample | E-resample |
|---|---|---|---|---|
| acronym | 0/0 of 3 (0.0/3) | 3/0 of 3 (3.0/3) | 3/0 of 3 (3.0/3) | 0/0 of 3 (0.0/3) |
| binary-search | 0/0 of 3 (3.0/8) | 0/0 of 3 (3.0/8) | 0/0 of 3 (3.0/8) | 0/0 of 3 (3.0/8) |
| flatten-array | 3/3 of 3 (3.0/3) | 3/3 of 3 (3.0/3) | 3/3 of 3 (3.0/3) | 3/3 of 3 (3.0/3) |
| food-chain | 0/0 of 3 (0.0/6) | 0/0 of 3 (0.0/6) | 0/0 of 3 (0.0/6) | 0/0 of 3 (0.0/6) |
| relative-distance | 0/0 of 3 (0.0/4) | 0/0 of 3 (1.0/4) | 0/0 of 3 (0.7/4) | 0/0 of 3 (0.0/4) |
| spiral-matrix | 3/3 of 3 (4.0/4) | 3/3 of 3 (4.0/4) | 3/3 of 3 (4.0/4) | 3/3 of 3 (4.0/4) |
| transpose | 0/0 of 3 (6.0/9) | 0/0 of 3 (6.0/9) | 0/0 of 3 (6.0/9) | 0/0 of 3 (6.0/9) |
| wordy | 0/0 of 3 (7.0/20) | 0/0 of 3 (7.0/20) | 0/0 of 3 (7.0/20) | 0/0 of 3 (7.0/20) |
