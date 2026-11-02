Tasks: 102 from results/2026-11-02-dev. OpenArc 0.9.7. Backends: llama-server-vulkan-json.

Raw = held-out tests on whatever the arm shipped. Accepted-and-correct = counted only when the arm's own gate passed (OpenArc: every region verified on the public examples; baseline: every public example passes). Fail rates are per model attempt: compile = type/syntax error or unparseable output (baseline: the file did not load; it is not type-checked), public = a public example failed, constraint = an OpenArc static rule (imports, forbidden names, effects, calls, sketch containment).

## Per arm and seed

| backend | model | config | seed | n | held-out tests (raw) | exercise pass (raw) | accepted-and-correct exercises | accepted held-out tests | public gate passed | attempts | compile-fail / attempt | public-fail / attempt | constraint violations | mean calls | mean prompt tok | mean output tok | mean wall s |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| llama-server-vulkan-json | qwen2.5-coder-7b | A | 1 | 17 | 40% (74/185) | 18% (3/17) | 18% (3/17) | 40% (74/185) | 76% (13/17) | 29 | 14% | 38% | 0 | 1.6 | 1451.4 | 413.4 | 17.9 |
| llama-server-vulkan-json | qwen2.5-coder-7b | A | 2 | 17 | 41% (75/185) | 18% (3/17) | 18% (3/17) | 41% (75/185) | 82% (14/17) | 30 | 7% | 43% | 0 | 1.6 | 1485.2 | 414.8 | 17.3 |
| llama-server-vulkan-json | qwen2.5-coder-7b | A | 3 | 17 | 38% (71/185) | 18% (3/17) | 18% (3/17) | 37% (69/185) | 76% (13/17) | 32 | 16% | 41% | 0 | 1.8 | 1719.5 | 405.3 | 17.4 |
| llama-server-vulkan-json | qwen2.5-coder-7b | D | 1 | 17 | 48% (89/185) | 35% (6/17) | 29% (5/17) | 45% (83/185) | 76% (13/17) | 27 | 0% | 52% | 0 | 1.6 | 1114.7 | 342.9 | 10.7 |
| llama-server-vulkan-json | qwen2.5-coder-7b | D | 2 | 17 | 42% (77/185) | 29% (5/17) | 24% (4/17) | 38% (71/185) | 71% (12/17) | 29 | 0% | 59% | 0 | 1.7 | 1381.9 | 423.5 | 12.2 |
| llama-server-vulkan-json | qwen2.5-coder-7b | D | 3 | 17 | 39% (73/185) | 24% (4/17) | 18% (3/17) | 34% (62/185) | 65% (11/17) | 29 | 0% | 62% | 0 | 1.7 | 1381.9 | 423.5 | 12.2 |

## Mean over seeds, with 95% task-level bootstrap CIs (10000 resamples of the 17 exercises)

| backend | model | config | seeds | exercise pass (raw) | accepted-and-correct | held-out tests (raw, pooled) | held-out tests (accepted) | mean tokens/task | mean wall s/task |
|---|---|---|---|---|---|---|---|---|---|
| llama-server-vulkan-json | qwen2.5-coder-7b | A | 1,2,3 | 18% [0%, 35%] | 18% [0%, 35%] | 40% [24%, 57%] | 39% [24%, 57%] | 1963.2 | 17.5 |
| llama-server-vulkan-json | qwen2.5-coder-7b | D | 1,2,3 | 29% [10%, 51%] | 24% [6%, 43%] | 43% [30%, 60%] | 39% [25%, 56%] | 1689.5 | 11.7 |

## Paired difference vs A (exercise pass, percentage points; mean over seeds, 95% bootstrap CI over exercises)

| backend | model | config | raw diff | accepted-and-correct diff |
|---|---|---|---|---|
| llama-server-vulkan-json | qwen2.5-coder-7b | D | +11.8 [+0.0, +25.5] | +5.9 [+0.0, +15.7] |

## Paired difference vs D (exercise pass, percentage points; mean over seeds, 95% bootstrap CI over exercises)

| backend | model | config | raw diff | accepted-and-correct diff |
|---|---|---|---|---|
| llama-server-vulkan-json | qwen2.5-coder-7b | A | -11.8 [-25.5, +0.0] | -5.9 [-15.7, +0.0] |

## Per exercise: seeds with all held-out tests passing, raw / accepted (mean held-out tests passed)

| exercise | A | D |
|---|---|---|
| acronym | 0/0 of 3 (0.0/3) | 3/0 of 3 (3.0/3) |
| all-your-base | 0/0 of 3 (6.0/19) | 0/0 of 3 (5.0/19) |
| binary-search | 0/0 of 3 (3.0/8) | 0/0 of 3 (3.0/8) |
| diamond | 0/0 of 3 (0.0/2) | 0/0 of 3 (0.0/2) |
| flatten-array | 3/3 of 3 (3.0/3) | 3/3 of 3 (3.0/3) |
| food-chain | 0/0 of 3 (0.0/6) | 0/0 of 3 (0.0/6) |
| matching-brackets | 3/3 of 3 (14.0/14) | 3/3 of 3 (14.0/14) |
| minesweeper | 0/0 of 3 (0.7/9) | 2/2 of 3 (7.7/9) |
| phone-number | 0/0 of 3 (3.0/16) | 0/0 of 3 (3.0/16) |
| pig-latin | 0/0 of 3 (12.0/16) | 0/0 of 3 (6.0/16) |
| rectangles | 0/0 of 3 (0.0/11) | 0/0 of 3 (1.0/11) |
| spiral-matrix | 3/3 of 3 (4.0/4) | 3/3 of 3 (4.0/4) |
| sum-of-multiples | 0/0 of 3 (10.0/13) | 0/0 of 3 (10.0/13) |
| transpose | 0/0 of 3 (6.0/9) | 0/0 of 3 (6.0/9) |
| twelve-days | 0/0 of 3 (0.0/12) | 1/1 of 3 (4.0/12) |
| variable-length-quantity | 0/0 of 3 (4.7/20) | 0/0 of 3 (3.0/20) |
| wordy | 0/0 of 3 (7.0/20) | 0/0 of 3 (7.0/20) |
