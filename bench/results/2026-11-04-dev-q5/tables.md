Tasks: 102 from /tmp/claude-1000/-mnt-data-projetos/0a52dddd-ec03-4d58-8441-c8ccfe4d6411/scratchpad/dev8/out. OpenArc 0.10.0. Backends: llama-server-vulkan-json.

Raw = held-out tests on whatever the arm shipped. Accepted-and-correct = counted only when the arm's own gate passed (OpenArc: every region verified on the public examples; baseline: every public example passes). Fail rates are per model attempt: compile = type/syntax error or unparseable output (baseline: the file did not load; it is not type-checked), public = a public example failed, constraint = an OpenArc static rule (imports, forbidden names, effects, calls, sketch containment).

## Per arm and seed

| backend | model | config | seed | n | held-out tests (raw) | exercise pass (raw) | accepted-and-correct exercises | accepted held-out tests | public gate passed | attempts | compile-fail / attempt | public-fail / attempt | constraint violations | mean calls | mean prompt tok | mean output tok | mean wall s |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| llama-server-vulkan-json | qwen3.5-9b-q5km | A | 1 | 17 | 49% (91/185) | 35% (6/17) | 35% (6/17) | 49% (91/185) | 71% (12/17) | 30 | 27% | 30% | 0 | 1.6 | 1396.6 | 377.4 | 15.0 |
| llama-server-vulkan-json | qwen3.5-9b-q5km | A | 2 | 17 | 49% (91/185) | 35% (6/17) | 35% (6/17) | 49% (91/185) | 71% (12/17) | 30 | 23% | 33% | 0 | 1.6 | 1400.8 | 364.7 | 14.6 |
| llama-server-vulkan-json | qwen3.5-9b-q5km | A | 3 | 17 | 50% (92/185) | 35% (6/17) | 35% (6/17) | 50% (92/185) | 71% (12/17) | 30 | 30% | 27% | 0 | 1.6 | 1384.3 | 369.5 | 14.8 |
| llama-server-vulkan-json | qwen3.5-9b-q5km | D | 1 | 17 | 66% (122/185) | 53% (9/17) | 47% (8/17) | 61% (112/185) | 76% (13/17) | 28 | 0% | 54% | 0 | 1.6 | 1872.8 | 1152.4 | 37.7 |
| llama-server-vulkan-json | qwen3.5-9b-q5km | D | 2 | 17 | 71% (132/185) | 53% (9/17) | 47% (8/17) | 66% (122/185) | 82% (14/17) | 26 | 0% | 46% | 0 | 1.5 | 1397.1 | 886.7 | 29.0 |
| llama-server-vulkan-json | qwen3.5-9b-q5km | D | 3 | 17 | 65% (121/185) | 53% (9/17) | 47% (8/17) | 60% (111/185) | 76% (13/17) | 27 | 4% | 48% | 0 | 1.6 | 1693.5 | 979.1 | 32.2 |

## Mean over seeds, with 95% task-level bootstrap CIs (10000 resamples of the 17 exercises)

| backend | model | config | seeds | exercise pass (raw) | accepted-and-correct | held-out tests (raw, pooled) | held-out tests (accepted) | mean tokens/task | mean wall s/task |
|---|---|---|---|---|---|---|---|---|---|
| llama-server-vulkan-json | qwen3.5-9b-q5km | A | 1,2,3 | 35% [12%, 59%] | 35% [12%, 59%] | 49% [30%, 72%] | 49% [30%, 72%] | 1764.5 | 14.8 |
| llama-server-vulkan-json | qwen3.5-9b-q5km | D | 1,2,3 | 53% [29%, 75%] | 47% [25%, 69%] | 68% [50%, 85%] | 62% [40%, 82%] | 2660.5 | 33.0 |

## Paired difference vs A (exercise pass, percentage points; mean over seeds, 95% bootstrap CI over exercises)

| backend | model | config | raw diff | accepted-and-correct diff |
|---|---|---|---|---|
| llama-server-vulkan-json | qwen3.5-9b-q5km | D | +17.6 [-5.9, +41.2] | +11.8 [-9.8, +33.3] |

## Paired difference vs D (exercise pass, percentage points; mean over seeds, 95% bootstrap CI over exercises)

| backend | model | config | raw diff | accepted-and-correct diff |
|---|---|---|---|---|
| llama-server-vulkan-json | qwen3.5-9b-q5km | A | -17.6 [-41.2, +5.9] | -11.8 [-33.3, +9.8] |

## Per exercise: seeds with all held-out tests passing, raw / accepted (mean held-out tests passed)

| exercise | A | D |
|---|---|---|
| acronym | 0/0 of 3 (0.0/3) | 3/0 of 3 (3.0/3) |
| all-your-base | 0/0 of 3 (9.0/19) | 3/3 of 3 (19.0/19) |
| binary-search | 0/0 of 3 (3.0/8) | 0/0 of 3 (3.0/8) |
| diamond | 3/3 of 3 (2.0/2) | 3/3 of 3 (2.0/2) |
| flatten-array | 3/3 of 3 (3.0/3) | 3/3 of 3 (3.0/3) |
| food-chain | 0/0 of 3 (0.0/6) | 0/0 of 3 (1.0/6) |
| matching-brackets | 3/3 of 3 (14.0/14) | 3/3 of 3 (14.0/14) |
| minesweeper | 3/3 of 3 (9.0/9) | 3/3 of 3 (9.0/9) |
| phone-number | 0/0 of 3 (0.0/16) | 0/0 of 3 (2.0/16) |
| pig-latin | 0/0 of 3 (14.0/16) | 2/2 of 3 (15.3/16) |
| rectangles | 3/3 of 3 (11.0/11) | 0/0 of 3 (7.0/11) |
| spiral-matrix | 3/3 of 3 (4.0/4) | 3/3 of 3 (4.0/4) |
| sum-of-multiples | 0/0 of 3 (0.0/13) | 3/3 of 3 (13.0/13) |
| transpose | 0/0 of 3 (6.0/9) | 0/0 of 3 (5.3/9) |
| twelve-days | 0/0 of 3 (9.0/12) | 1/1 of 3 (4.0/12) |
| variable-length-quantity | 0/0 of 3 (7.3/20) | 0/0 of 3 (14.3/20) |
| wordy | 0/0 of 3 (0.0/20) | 0/0 of 3 (6.0/20) |
