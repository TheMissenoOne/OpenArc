Tasks: 102 from /tmp/claude-1000/-mnt-data-projetos/0a52dddd-ec03-4d58-8441-c8ccfe4d6411/scratchpad/dev10/out. OpenArc 0.10.0. Backends: llama-server-vulkan-json.

Raw = held-out tests on whatever the arm shipped. Accepted-and-correct = counted only when the arm's own gate passed (OpenArc: every region verified on the public examples; baseline: every public example passes). Fail rates are per model attempt: compile = type/syntax error or unparseable output (baseline: the file did not load; it is not type-checked), public = a public example failed, constraint = an OpenArc static rule (imports, forbidden names, effects, calls, sketch containment).

## Per arm and seed

| backend | model | config | seed | n | held-out tests (raw) | exercise pass (raw) | accepted-and-correct exercises | accepted held-out tests | public gate passed | attempts | compile-fail / attempt | public-fail / attempt | constraint violations | mean calls | mean prompt tok | mean output tok | mean wall s |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| llama-server-vulkan-json | qwen3.5-9b-q5km | A | 1 | 17 | 56% (104/185) | 41% (7/17) | 41% (7/17) | 56% (104/185) | 76% (13/17) | 29 | 21% | 31% | 0 | 1.6 | 1321.5 | 379.9 | 15.0 |
| llama-server-vulkan-json | qwen3.5-9b-q5km | A | 2 | 17 | 56% (104/185) | 41% (7/17) | 41% (7/17) | 56% (104/185) | 76% (13/17) | 29 | 17% | 34% | 0 | 1.6 | 1324.8 | 375.2 | 14.9 |
| llama-server-vulkan-json | qwen3.5-9b-q5km | A | 3 | 17 | 57% (105/185) | 41% (7/17) | 41% (7/17) | 57% (105/185) | 76% (13/17) | 29 | 21% | 31% | 0 | 1.6 | 1305.9 | 362.9 | 14.5 |
| llama-server-vulkan-json | qwen3.5-9b-q5km | D | 1 | 17 | 63% (116/185) | 53% (9/17) | 47% (8/17) | 61% (112/185) | 76% (13/17) | 25 | 4% | 44% | 0 | 1.5 | 1282.4 | 938.1 | 30.6 |
| llama-server-vulkan-json | qwen3.5-9b-q5km | D | 2 | 17 | 68% (125/185) | 47% (8/17) | 41% (7/17) | 65% (121/185) | 82% (14/17) | 24 | 0% | 42% | 0 | 1.4 | 1153.7 | 748.1 | 24.5 |
| llama-server-vulkan-json | qwen3.5-9b-q5km | D | 3 | 17 | 69% (128/185) | 53% (9/17) | 47% (8/17) | 67% (124/185) | 82% (14/17) | 24 | 0% | 42% | 0 | 1.4 | 1153.5 | 677.7 | 22.3 |

## Mean over seeds, with 95% task-level bootstrap CIs (10000 resamples of the 17 exercises)

| backend | model | config | seeds | exercise pass (raw) | accepted-and-correct | held-out tests (raw, pooled) | held-out tests (accepted) | mean tokens/task | mean wall s/task |
|---|---|---|---|---|---|---|---|---|---|
| llama-server-vulkan-json | qwen3.5-9b-q5km | A | 1,2,3 | 41% [18%, 65%] | 41% [18%, 65%] | 56% [36%, 78%] | 56% [36%, 78%] | 1690.1 | 14.8 |
| llama-server-vulkan-json | qwen3.5-9b-q5km | D | 1,2,3 | 51% [27%, 75%] | 45% [22%, 69%] | 66% [48%, 83%] | 64% [46%, 81%] | 1984.5 | 25.8 |

## Paired difference vs A (exercise pass, percentage points; mean over seeds, 95% bootstrap CI over exercises)

| backend | model | config | raw diff | accepted-and-correct diff |
|---|---|---|---|---|
| llama-server-vulkan-json | qwen3.5-9b-q5km | D | +9.8 [-11.8, +31.4] | +3.9 [-13.7, +21.6] |

## Paired difference vs D (exercise pass, percentage points; mean over seeds, 95% bootstrap CI over exercises)

| backend | model | config | raw diff | accepted-and-correct diff |
|---|---|---|---|---|
| llama-server-vulkan-json | qwen3.5-9b-q5km | A | -9.8 [-31.4, +11.8] | -3.9 [-21.6, +13.7] |

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
| pig-latin | 0/0 of 3 (14.0/16) | 2/2 of 3 (12.7/16) |
| rectangles | 3/3 of 3 (11.0/11) | 0/0 of 3 (7.0/11) |
| spiral-matrix | 3/3 of 3 (4.0/4) | 3/3 of 3 (4.0/4) |
| sum-of-multiples | 3/3 of 3 (13.0/13) | 3/3 of 3 (13.0/13) |
| transpose | 0/0 of 3 (6.0/9) | 0/0 of 3 (6.0/9) |
| twelve-days | 0/0 of 3 (9.0/12) | 0/0 of 3 (0.0/12) |
| variable-length-quantity | 0/0 of 3 (7.3/20) | 0/0 of 3 (9.3/20) |
| wordy | 0/0 of 3 (0.0/20) | 0/0 of 3 (15.0/20) |
