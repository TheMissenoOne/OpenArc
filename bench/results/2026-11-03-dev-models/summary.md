Tasks: 306 from results/2026-11-03-dev-models. OpenArc 0.10.0. Backends: llama-server-vulkan-json.

Raw = held-out tests on whatever the arm shipped. Accepted-and-correct = counted only when the arm's own gate passed (OpenArc: every region verified on the public examples; baseline: every public example passes). Fail rates are per model attempt: compile = type/syntax error or unparseable output (baseline: the file did not load; it is not type-checked), public = a public example failed, constraint = an OpenArc static rule (imports, forbidden names, effects, calls, sketch containment).

## Per arm and seed

| backend | model | config | seed | n | held-out tests (raw) | exercise pass (raw) | accepted-and-correct exercises | accepted held-out tests | public gate passed | attempts | compile-fail / attempt | public-fail / attempt | constraint violations | mean calls | mean prompt tok | mean output tok | mean wall s |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| llama-server-vulkan-json | qwen2.5-coder-7b | A | 1 | 17 | 40% (74/185) | 18% (3/17) | 18% (3/17) | 40% (74/185) | 76% (13/17) | 30 | 13% | 40% | 0 | 1.6 | 1306.0 | 384.7 | 16.7 |
| llama-server-vulkan-json | qwen2.5-coder-7b | A | 2 | 17 | 47% (87/185) | 24% (4/17) | 24% (4/17) | 47% (87/185) | 88% (15/17) | 30 | 7% | 40% | 0 | 1.6 | 1287.4 | 390.2 | 16.7 |
| llama-server-vulkan-json | qwen2.5-coder-7b | A | 3 | 17 | 41% (75/185) | 18% (3/17) | 18% (3/17) | 41% (75/185) | 82% (14/17) | 30 | 13% | 37% | 0 | 1.6 | 1283.2 | 347.9 | 16.0 |
| llama-server-vulkan-json | qwen2.5-coder-7b | D | 1 | 17 | 42% (77/185) | 29% (5/17) | 24% (4/17) | 38% (71/185) | 71% (12/17) | 29 | 0% | 59% | 0 | 1.7 | 1381.9 | 423.5 | 12.2 |
| llama-server-vulkan-json | qwen2.5-coder-7b | D | 2 | 17 | 42% (77/185) | 29% (5/17) | 24% (4/17) | 38% (71/185) | 71% (12/17) | 29 | 0% | 59% | 0 | 1.7 | 1381.9 | 423.5 | 12.2 |
| llama-server-vulkan-json | qwen2.5-coder-7b | D | 3 | 17 | 39% (73/185) | 24% (4/17) | 18% (3/17) | 34% (62/185) | 65% (11/17) | 29 | 0% | 62% | 0 | 1.7 | 1381.9 | 423.5 | 12.2 |
| llama-server-vulkan-json | qwen3.5-9b | A | 1 | 17 | 46% (86/185) | 24% (4/17) | 24% (4/17) | 46% (86/185) | 76% (13/17) | 33 | 12% | 45% | 0 | 1.8 | 1453.1 | 501.2 | 18.4 |
| llama-server-vulkan-json | qwen3.5-9b | A | 2 | 17 | 37% (69/185) | 12% (2/17) | 12% (2/17) | 37% (69/185) | 71% (12/17) | 34 | 12% | 50% | 0 | 1.9 | 1503.8 | 509.8 | 18.6 |
| llama-server-vulkan-json | qwen3.5-9b | A | 3 | 17 | 38% (71/185) | 12% (2/17) | 12% (2/17) | 38% (71/185) | 71% (12/17) | 33 | 18% | 42% | 0 | 1.9 | 1642.1 | 851.5 | 26.6 |
| llama-server-vulkan-json | qwen3.5-9b | D | 1 | 17 | 55% (101/185) | 47% (8/17) | 41% (7/17) | 53% (98/185) | 88% (15/17) | 23 | 4% | 30% | 0 | 1.4 | 1209.6 | 882.5 | 22.4 |
| llama-server-vulkan-json | qwen3.5-9b | D | 2 | 17 | 62% (115/185) | 47% (8/17) | 41% (7/17) | 61% (112/185) | 88% (15/17) | 24 | 4% | 33% | 0 | 1.4 | 1371.5 | 772.1 | 19.4 |
| llama-server-vulkan-json | qwen3.5-9b | D | 3 | 17 | 57% (105/185) | 47% (8/17) | 41% (7/17) | 53% (98/185) | 82% (14/17) | 23 | 4% | 35% | 0 | 1.4 | 1471.6 | 842.6 | 21.1 |
| llama-server-vulkan-json | seed-coder-8b | A | 1 | 17 | 39% (72/185) | 24% (4/17) | 24% (4/17) | 37% (68/185) | 71% (12/17) | 34 | 24% | 38% | 0 | 1.9 | 1638.9 | 464.6 | 19.2 |
| llama-server-vulkan-json | seed-coder-8b | A | 2 | 17 | 39% (72/185) | 24% (4/17) | 24% (4/17) | 37% (68/185) | 71% (12/17) | 33 | 39% | 21% | 0 | 1.8 | 1653.0 | 632.8 | 22.7 |
| llama-server-vulkan-json | seed-coder-8b | A | 3 | 17 | 39% (72/185) | 24% (4/17) | 24% (4/17) | 37% (68/185) | 59% (10/17) | 35 | 31% | 37% | 0 | 1.9 | 1730.1 | 688.2 | 23.9 |
| llama-server-vulkan-json | seed-coder-8b | D | 1 | 17 | 51% (94/185) | 35% (6/17) | 29% (5/17) | 47% (87/185) | 71% (12/17) | 27 | 0% | 56% | 0 | 1.6 | 1343.4 | 466.1 | 10.3 |
| llama-server-vulkan-json | seed-coder-8b | D | 2 | 17 | 51% (94/185) | 35% (6/17) | 29% (5/17) | 47% (87/185) | 71% (12/17) | 27 | 0% | 56% | 0 | 1.6 | 1358.0 | 471.8 | 10.5 |
| llama-server-vulkan-json | seed-coder-8b | D | 3 | 17 | 53% (98/185) | 35% (6/17) | 29% (5/17) | 47% (87/185) | 71% (12/17) | 27 | 0% | 56% | 0 | 1.6 | 1345.1 | 468.4 | 10.4 |

## Mean over seeds, with 95% task-level bootstrap CIs (10000 resamples of the 17 exercises)

| backend | model | config | seeds | exercise pass (raw) | accepted-and-correct | held-out tests (raw, pooled) | held-out tests (accepted) | mean tokens/task | mean wall s/task |
|---|---|---|---|---|---|---|---|---|---|
| llama-server-vulkan-json | qwen2.5-coder-7b | A | 1,2,3 | 20% [4%, 39%] | 20% [4%, 39%] | 43% [28%, 59%] | 43% [28%, 59%] | 1666.5 | 16.5 |
| llama-server-vulkan-json | qwen2.5-coder-7b | D | 1,2,3 | 27% [8%, 49%] | 22% [6%, 43%] | 41% [27%, 58%] | 37% [22%, 55%] | 1805.4 | 12.2 |
| llama-server-vulkan-json | qwen3.5-9b | A | 1,2,3 | 16% [2%, 33%] | 16% [2%, 33%] | 41% [26%, 58%] | 41% [26%, 58%] | 2153.8 | 21.2 |
| llama-server-vulkan-json | qwen3.5-9b | D | 1,2,3 | 47% [24%, 71%] | 41% [18%, 65%] | 58% [40%, 77%] | 55% [37%, 75%] | 2183.3 | 21.0 |
| llama-server-vulkan-json | seed-coder-8b | A | 1,2,3 | 24% [6%, 47%] | 24% [6%, 47%] | 39% [21%, 60%] | 37% [18%, 59%] | 2269.2 | 21.9 |
| llama-server-vulkan-json | seed-coder-8b | D | 1,2,3 | 35% [12%, 59%] | 29% [12%, 53%] | 52% [35%, 70%] | 47% [29%, 67%] | 1817.6 | 10.4 |

## Paired difference vs A (exercise pass, percentage points; mean over seeds, 95% bootstrap CI over exercises)

| backend | model | config | raw diff | accepted-and-correct diff |
|---|---|---|---|---|
| llama-server-vulkan-json | qwen2.5-coder-7b | D | +7.8 [-3.9, +23.5] | +2.0 [-5.9, +11.8] |
| llama-server-vulkan-json | qwen3.5-9b | D | +31.4 [+9.8, +54.9] | +25.5 [+5.9, +47.1] |
| llama-server-vulkan-json | seed-coder-8b | D | +11.8 [+0.0, +29.4] | +5.9 [+0.0, +17.6] |

## Paired difference vs D (exercise pass, percentage points; mean over seeds, 95% bootstrap CI over exercises)

| backend | model | config | raw diff | accepted-and-correct diff |
|---|---|---|---|---|
| llama-server-vulkan-json | qwen2.5-coder-7b | A | -7.8 [-23.5, +3.9] | -2.0 [-11.8, +5.9] |
| llama-server-vulkan-json | qwen3.5-9b | A | -31.4 [-54.9, -9.8] | -25.5 [-47.1, -5.9] |
| llama-server-vulkan-json | seed-coder-8b | A | -11.8 [-29.4, +0.0] | -5.9 [-17.6, +0.0] |

## Per exercise: seeds with all held-out tests passing, raw / accepted (mean held-out tests passed)

| exercise | qwen2.5-coder-7b A | qwen2.5-coder-7b D | qwen3.5-9b A | qwen3.5-9b D | seed-coder-8b A | seed-coder-8b D |
|---|---|---|---|---|---|---|
| acronym | 0/0 of 3 (0.0/3) | 3/0 of 3 (3.0/3) | 0/0 of 3 (0.0/3) | 3/0 of 3 (3.0/3) | 0/0 of 3 (0.0/3) | 3/0 of 3 (3.0/3) |
| all-your-base | 0/0 of 3 (6.0/19) | 0/0 of 3 (5.0/19) | 0/0 of 3 (5.0/19) | 0/0 of 3 (13.0/19) | 0/0 of 3 (6.0/19) | 0/0 of 3 (6.0/19) |
| binary-search | 0/0 of 3 (3.0/8) | 0/0 of 3 (3.0/8) | 0/0 of 3 (3.0/8) | 0/0 of 3 (3.0/8) | 0/0 of 3 (3.0/8) | 0/0 of 3 (3.0/8) |
| diamond | 0/0 of 3 (0.0/2) | 0/0 of 3 (0.0/2) | 0/0 of 3 (0.0/2) | 3/3 of 3 (2.0/2) | 0/0 of 3 (0.0/2) | 0/0 of 3 (0.0/2) |
| flatten-array | 3/3 of 3 (3.0/3) | 3/3 of 3 (3.0/3) | 3/3 of 3 (3.0/3) | 3/3 of 3 (3.0/3) | 3/3 of 3 (3.0/3) | 3/3 of 3 (3.0/3) |
| food-chain | 0/0 of 3 (0.0/6) | 0/0 of 3 (0.0/6) | 0/0 of 3 (0.0/6) | 0/0 of 3 (0.0/6) | 0/0 of 3 (0.0/6) | 0/0 of 3 (1.3/6) |
| matching-brackets | 3/3 of 3 (14.0/14) | 3/3 of 3 (14.0/14) | 1/1 of 3 (4.7/14) | 3/3 of 3 (14.0/14) | 3/3 of 3 (14.0/14) | 3/3 of 3 (14.0/14) |
| minesweeper | 0/0 of 3 (0.7/9) | 2/2 of 3 (7.7/9) | 3/3 of 3 (9.0/9) | 3/3 of 3 (9.0/9) | 3/3 of 3 (9.0/9) | 3/3 of 3 (9.0/9) |
| phone-number | 0/0 of 3 (3.0/16) | 0/0 of 3 (3.0/16) | 0/0 of 3 (3.0/16) | 0/0 of 3 (1.0/16) | 0/0 of 3 (1.0/16) | 0/0 of 3 (3.0/16) |
| pig-latin | 0/0 of 3 (12.0/16) | 0/0 of 3 (6.0/16) | 1/1 of 3 (15.0/16) | 0/0 of 3 (12.0/16) | 0/0 of 3 (12.0/16) | 0/0 of 3 (12.0/16) |
| rectangles | 0/0 of 3 (0.0/11) | 0/0 of 3 (1.0/11) | 0/0 of 3 (7.0/11) | 0/0 of 3 (0.0/11) | 0/0 of 3 (0.0/11) | 0/0 of 3 (4.0/11) |
| spiral-matrix | 3/3 of 3 (4.0/4) | 3/3 of 3 (4.0/4) | 0/0 of 3 (0.0/4) | 3/3 of 3 (4.0/4) | 3/3 of 3 (4.0/4) | 3/3 of 3 (4.0/4) |
| sum-of-multiples | 0/0 of 3 (10.0/13) | 0/0 of 3 (10.0/13) | 0/0 of 3 (10.0/13) | 3/3 of 3 (13.0/13) | 0/0 of 3 (10.0/13) | 3/3 of 3 (13.0/13) |
| transpose | 0/0 of 3 (6.0/9) | 0/0 of 3 (6.0/9) | 0/0 of 3 (6.0/9) | 0/0 of 3 (5.0/9) | 0/0 of 3 (6.0/9) | 0/0 of 3 (5.0/9) |
| twelve-days | 1/1 of 3 (4.0/12) | 0/0 of 3 (0.0/12) | 0/0 of 3 (0.0/12) | 3/3 of 3 (12.0/12) | 0/0 of 3 (0.0/12) | 0/0 of 3 (0.0/12) |
| variable-length-quantity | 0/0 of 3 (6.0/20) | 0/0 of 3 (3.0/20) | 0/0 of 3 (2.7/20) | 0/0 of 3 (7.0/20) | 0/0 of 3 (4.0/20) | 0/0 of 3 (4.0/20) |
| wordy | 0/0 of 3 (7.0/20) | 0/0 of 3 (7.0/20) | 0/0 of 3 (7.0/20) | 0/0 of 3 (6.0/20) | 0/0 of 3 (0.0/20) | 0/0 of 3 (11.0/20) |

