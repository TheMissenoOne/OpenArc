Tasks: 408 from results/2026-11-03-dev-quant. OpenArc 0.10.0. Backends: llama-server-vulkan-json.

Raw = held-out tests on whatever the arm shipped. Accepted-and-correct = counted only when the arm's own gate passed (OpenArc: every region verified on the public examples; baseline: every public example passes). Fail rates are per model attempt: compile = type/syntax error or unparseable output (baseline: the file did not load; it is not type-checked), public = a public example failed, constraint = an OpenArc static rule (imports, forbidden names, effects, calls, sketch containment).

## Per arm and seed

| backend | model | config | seed | n | held-out tests (raw) | exercise pass (raw) | accepted-and-correct exercises | accepted held-out tests | public gate passed | attempts | compile-fail / attempt | public-fail / attempt | constraint violations | mean calls | mean prompt tok | mean output tok | mean wall s |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| llama-server-vulkan-json | qwen3.5-9b-q3km | A | 1 | 17 | 37% (69/185) | 18% (3/17) | 18% (3/17) | 36% (66/185) | 65% (11/17) | 35 | 17% | 46% | 1 | 1.9 | 1598.8 | 500.6 | 21.0 |
| llama-server-vulkan-json | qwen3.5-9b-q3km | A | 2 | 17 | 38% (71/185) | 18% (3/17) | 18% (3/17) | 38% (71/185) | 76% (13/17) | 34 | 12% | 47% | 0 | 1.9 | 1570.8 | 503.8 | 21.0 |
| llama-server-vulkan-json | qwen3.5-9b-q3km | A | 3 | 17 | 37% (69/185) | 18% (3/17) | 18% (3/17) | 36% (66/185) | 65% (11/17) | 36 | 14% | 53% | 0 | 2.0 | 1647.1 | 492.1 | 20.8 |
| llama-server-vulkan-json | qwen3.5-9b-q3km | D | 1 | 17 | 61% (112/185) | 59% (10/17) | 53% (9/17) | 56% (103/185) | 76% (13/17) | 25 | 0% | 48% | 0 | 1.5 | 1148.4 | 559.8 | 12.9 |
| llama-server-vulkan-json | qwen3.5-9b-q3km | D | 2 | 17 | 59% (110/185) | 53% (9/17) | 47% (8/17) | 55% (102/185) | 71% (12/17) | 27 | 11% | 44% | 0 | 1.6 | 1442.2 | 642.4 | 14.8 |
| llama-server-vulkan-json | qwen3.5-9b-q3km | D | 3 | 17 | 60% (111/185) | 53% (9/17) | 47% (8/17) | 55% (102/185) | 71% (12/17) | 27 | 11% | 44% | 0 | 1.6 | 1440.2 | 652.1 | 15.0 |
| llama-server-vulkan-json | qwen3.5-9b-q5km | A | 1 | 17 | 39% (73/185) | 29% (5/17) | 29% (5/17) | 39% (73/185) | 71% (12/17) | 32 | 28% | 31% | 0 | 1.8 | 1533.7 | 481.6 | 15.9 |
| llama-server-vulkan-json | qwen3.5-9b-q5km | A | 2 | 17 | 39% (73/185) | 29% (5/17) | 29% (5/17) | 39% (73/185) | 71% (12/17) | 30 | 23% | 33% | 0 | 1.6 | 1422.2 | 448.8 | 15.0 |
| llama-server-vulkan-json | qwen3.5-9b-q5km | A | 3 | 17 | 38% (71/185) | 29% (5/17) | 29% (5/17) | 36% (67/185) | 65% (11/17) | 32 | 31% | 31% | 0 | 1.8 | 1494.6 | 449.6 | 14.8 |
| llama-server-vulkan-json | qwen3.5-9b-q5km | D | 1 | 17 | 62% (115/185) | 47% (8/17) | 41% (7/17) | 52% (97/185) | 71% (12/17) | 28 | 11% | 46% | 0 | 1.6 | 1655.8 | 853.9 | 23.9 |
| llama-server-vulkan-json | qwen3.5-9b-q5km | D | 2 | 17 | 62% (115/185) | 47% (8/17) | 41% (7/17) | 52% (97/185) | 71% (12/17) | 28 | 11% | 46% | 0 | 1.6 | 1878.6 | 1000.6 | 28.1 |
| llama-server-vulkan-json | qwen3.5-9b-q5km | D | 3 | 17 | 68% (125/185) | 47% (8/17) | 41% (7/17) | 58% (107/185) | 76% (13/17) | 26 | 0% | 50% | 0 | 1.5 | 1396.8 | 826.5 | 23.0 |
| llama-server-vulkan-json | qwen3.5-9b-q6k | A | 1 | 17 | 43% (79/185) | 35% (6/17) | 35% (6/17) | 43% (79/185) | 76% (13/17) | 31 | 29% | 23% | 0 | 1.7 | 1518.3 | 447.3 | 25.1 |
| llama-server-vulkan-json | qwen3.5-9b-q6k | A | 2 | 17 | 39% (73/185) | 35% (6/17) | 35% (6/17) | 37% (69/185) | 65% (11/17) | 31 | 29% | 32% | 0 | 1.7 | 1513.2 | 454.1 | 25.4 |
| llama-server-vulkan-json | qwen3.5-9b-q6k | A | 3 | 17 | 39% (73/185) | 35% (6/17) | 35% (6/17) | 37% (69/185) | 65% (11/17) | 32 | 25% | 38% | 0 | 1.8 | 1547.1 | 489.4 | 26.8 |
| llama-server-vulkan-json | qwen3.5-9b-q6k | D | 1 | 17 | 63% (111/176) | 47% (8/17) | 41% (7/17) | 60% (106/176) | 76% (13/17) | 27 | 0% | 52% | 0 | 1.8 | 1949.4 | 1190.3 | 58.8 |
| llama-server-vulkan-json | qwen3.5-9b-q6k | D | 2 | 17 | 63% (111/176) | 47% (8/17) | 41% (7/17) | 60% (106/176) | 76% (13/17) | 27 | 0% | 52% | 0 | 1.8 | 1950.8 | 1191.7 | 59.4 |
| llama-server-vulkan-json | qwen3.5-9b-q6k | D | 3 | 17 | 63% (111/176) | 47% (8/17) | 41% (7/17) | 60% (106/176) | 76% (13/17) | 27 | 0% | 52% | 0 | 1.8 | 1949.4 | 1190.3 | 58.7 |
| llama-server-vulkan-json | seed-coder-8b-q6k | A | 1 | 17 | 43% (80/185) | 24% (4/17) | 24% (4/17) | 41% (76/185) | 71% (12/17) | 35 | 14% | 46% | 1 | 1.9 | 1646.6 | 410.1 | 35.8 |
| llama-server-vulkan-json | seed-coder-8b-q6k | A | 2 | 17 | 39% (72/185) | 24% (4/17) | 24% (4/17) | 37% (68/185) | 65% (11/17) | 33 | 24% | 36% | 1 | 1.8 | 1558.2 | 426.4 | 36.6 |
| llama-server-vulkan-json | seed-coder-8b-q6k | A | 3 | 17 | 43% (79/185) | 24% (4/17) | 24% (4/17) | 41% (75/185) | 71% (12/17) | 35 | 17% | 43% | 1 | 1.9 | 1638.1 | 433.2 | 37.2 |
| llama-server-vulkan-json | seed-coder-8b-q6k | D | 1 | 17 | 43% (80/185) | 35% (6/17) | 29% (5/17) | 38% (70/185) | 59% (10/17) | 31 | 0% | 68% | 0 | 1.8 | 1600.6 | 536.3 | 34.6 |
| llama-server-vulkan-json | seed-coder-8b-q6k | D | 2 | 17 | 43% (80/185) | 35% (6/17) | 29% (5/17) | 38% (70/185) | 59% (10/17) | 31 | 0% | 68% | 0 | 1.8 | 1600.6 | 536.3 | 34.6 |
| llama-server-vulkan-json | seed-coder-8b-q6k | D | 3 | 17 | 43% (80/185) | 35% (6/17) | 29% (5/17) | 38% (70/185) | 59% (10/17) | 31 | 0% | 68% | 0 | 1.8 | 1600.6 | 536.3 | 34.7 |

## Mean over seeds, with 95% task-level bootstrap CIs (10000 resamples of the 17 exercises)

| backend | model | config | seeds | exercise pass (raw) | accepted-and-correct | held-out tests (raw, pooled) | held-out tests (accepted) | mean tokens/task | mean wall s/task |
|---|---|---|---|---|---|---|---|---|---|
| llama-server-vulkan-json | qwen3.5-9b-q3km | A | 1,2,3 | 18% [0%, 35%] | 18% [0%, 35%] | 38% [20%, 58%] | 37% [19%, 58%] | 2104.4 | 20.9 |
| llama-server-vulkan-json | qwen3.5-9b-q3km | D | 1,2,3 | 55% [31%, 76%] | 49% [25%, 73%] | 60% [37%, 84%] | 55% [31%, 81%] | 1961.7 | 14.3 |
| llama-server-vulkan-json | qwen3.5-9b-q5km | A | 1,2,3 | 29% [12%, 53%] | 29% [12%, 53%] | 39% [20%, 62%] | 38% [19%, 61%] | 1943.5 | 15.2 |
| llama-server-vulkan-json | qwen3.5-9b-q5km | D | 1,2,3 | 47% [24%, 71%] | 41% [18%, 65%] | 64% [43%, 84%] | 54% [31%, 78%] | 2537.4 | 25.0 |
| llama-server-vulkan-json | qwen3.5-9b-q6k | A | 1,2,3 | 35% [12%, 59%] | 35% [12%, 59%] | 41% [22%, 64%] | 39% [20%, 63%] | 1989.8 | 25.7 |
| llama-server-vulkan-json | qwen3.5-9b-q6k | D | 1,2,3 | 47% [24%, 71%] | 41% [18%, 65%] | - [-, -] | - [-, -] | 3140.6 | 59.0 |
| llama-server-vulkan-json | seed-coder-8b-q6k | A | 1,2,3 | 24% [6%, 47%] | 24% [6%, 47%] | 42% [25%, 61%] | 39% [22%, 60%] | 2037.5 | 36.5 |
| llama-server-vulkan-json | seed-coder-8b-q6k | D | 1,2,3 | 35% [12%, 59%] | 29% [12%, 53%] | 43% [26%, 64%] | 38% [19%, 60%] | 2136.9 | 34.6 |

## Paired difference vs A (exercise pass, percentage points; mean over seeds, 95% bootstrap CI over exercises)

| backend | model | config | raw diff | accepted-and-correct diff |
|---|---|---|---|---|
| llama-server-vulkan-json | qwen3.5-9b-q3km | D | +37.3 [+15.7, +60.8] | +31.4 [+11.8, +52.9] |
| llama-server-vulkan-json | qwen3.5-9b-q5km | D | +17.6 [-5.9, +41.2] | +11.8 [-11.8, +35.3] |
| llama-server-vulkan-json | qwen3.5-9b-q6k | D | +11.8 [-11.8, +35.3] | +5.9 [-11.8, +23.5] |
| llama-server-vulkan-json | seed-coder-8b-q6k | D | +11.8 [+0.0, +29.4] | +5.9 [+0.0, +17.6] |

## Paired difference vs D (exercise pass, percentage points; mean over seeds, 95% bootstrap CI over exercises)

| backend | model | config | raw diff | accepted-and-correct diff |
|---|---|---|---|---|
| llama-server-vulkan-json | qwen3.5-9b-q3km | A | -37.3 [-60.8, -15.7] | -31.4 [-52.9, -11.8] |
| llama-server-vulkan-json | qwen3.5-9b-q5km | A | -17.6 [-41.2, +5.9] | -11.8 [-35.3, +11.8] |
| llama-server-vulkan-json | qwen3.5-9b-q6k | A | -11.8 [-35.3, +11.8] | -5.9 [-23.5, +11.8] |
| llama-server-vulkan-json | seed-coder-8b-q6k | A | -11.8 [-29.4, +0.0] | -5.9 [-17.6, +0.0] |

## Per exercise: seeds with all held-out tests passing, raw / accepted (mean held-out tests passed)

| exercise | qwen3.5-9b-q3km A | qwen3.5-9b-q3km D | qwen3.5-9b-q5km A | qwen3.5-9b-q5km D | qwen3.5-9b-q6k A | qwen3.5-9b-q6k D | seed-coder-8b-q6k A | seed-coder-8b-q6k D |
|---|---|---|---|---|---|---|---|---|
| acronym | 0/0 of 3 (0.0/3) | 3/0 of 3 (3.0/3) | 0/0 of 3 (0.0/3) | 3/0 of 3 (3.0/3) | 0/0 of 3 (0.0/3) | 3/0 of 3 (3.0/3) | 0/0 of 3 (0.0/3) | 3/0 of 3 (3.0/3) |
| all-your-base | 0/0 of 3 (6.0/19) | 1/1 of 3 (18.3/19) | 0/0 of 3 (9.0/19) | 3/3 of 3 (19.0/19) | 0/0 of 3 (9.0/19) | 3/3 of 3 (19.0/19) | 0/0 of 3 (6.0/19) | 0/0 of 3 (6.0/19) |
| binary-search | 0/0 of 3 (3.0/8) | 0/0 of 3 (3.0/8) | 0/0 of 3 (3.0/8) | 0/0 of 3 (3.0/8) | 0/0 of 3 (3.0/8) | 0/0 of 3 (3.0/8) | 0/0 of 3 (3.0/8) | 0/0 of 3 (3.0/8) |
| diamond | 0/0 of 3 (0.0/2) | 3/3 of 3 (2.0/2) | 0/0 of 3 (0.0/2) | 3/3 of 3 (2.0/2) | 3/3 of 3 (2.0/2) | 3/3 of 3 (2.0/2) | 0/0 of 3 (0.0/2) | 0/0 of 3 (0.0/2) |
| flatten-array | 3/3 of 3 (3.0/3) | 3/3 of 3 (3.0/3) | 3/3 of 3 (3.0/3) | 3/3 of 3 (3.0/3) | 3/3 of 3 (3.0/3) | 3/3 of 3 (3.0/3) | 3/3 of 3 (3.0/3) | 3/3 of 3 (3.0/3) |
| food-chain | 0/0 of 3 (0.0/6) | 0/0 of 3 (0.7/6) | 0/0 of 3 (0.0/6) | 0/0 of 3 (0.0/6) | 0/0 of 3 (1.3/6) | 0/0 of 3 (4.0/6) | 0/0 of 3 (0.0/6) | 0/0 of 3 (1.0/6) |
| matching-brackets | 0/0 of 3 (13.0/14) | 3/3 of 3 (14.0/14) | 3/3 of 3 (14.0/14) | 3/3 of 3 (14.0/14) | 3/3 of 3 (14.0/14) | 3/3 of 3 (14.0/14) | 3/3 of 3 (14.0/14) | 3/3 of 3 (14.0/14) |
| minesweeper | 3/3 of 3 (9.0/9) | 3/3 of 3 (9.0/9) | 3/3 of 3 (9.0/9) | 3/3 of 3 (9.0/9) | 3/3 of 3 (9.0/9) | 3/3 of 3 (9.0/9) | 3/3 of 3 (9.0/9) | 3/3 of 3 (9.0/9) |
| phone-number | 0/0 of 3 (0.7/16) | 0/0 of 3 (2.0/16) | 0/0 of 3 (3.0/16) | 0/0 of 3 (2.0/16) | 0/0 of 3 (3.0/16) | 0/0 of 3 (3.0/16) | 0/0 of 3 (1.0/16) | 0/0 of 3 (3.0/16) |
| pig-latin | 0/0 of 3 (12.0/16) | 3/3 of 3 (16.0/16) | 3/3 of 3 (16.0/16) | 0/0 of 3 (15.0/16) | 3/3 of 3 (16.0/16) | 0/0 of 3 (15.0/16) | 0/0 of 3 (12.0/16) | 0/0 of 3 (12.0/16) |
| rectangles | 0/0 of 3 (0.0/11) | 0/0 of 3 (0.0/11) | 0/0 of 3 (0.0/11) | 0/0 of 3 (7.0/11) | 0/0 of 3 (0.0/11) | 0/0 of 3 (0.0/11) | 0/0 of 3 (0.3/11) | 0/0 of 3 (2.0/11) |
| spiral-matrix | 3/3 of 3 (4.0/4) | 3/3 of 3 (4.0/4) | 3/3 of 3 (4.0/4) | 3/3 of 3 (4.0/4) | 3/3 of 3 (4.0/4) | 3/3 of 3 (4.0/4) | 3/3 of 3 (4.0/4) | 3/3 of 3 (4.0/4) |
| sum-of-multiples | 0/0 of 3 (10.0/13) | 3/3 of 3 (13.0/13) | 0/0 of 3 (0.0/13) | 3/3 of 3 (13.0/13) | 0/0 of 3 (0.0/13) | 3/3 of 3 (13.0/13) | 0/0 of 3 (10.0/13) | 3/3 of 3 (13.0/13) |
| transpose | 0/0 of 3 (6.0/9) | 0/0 of 3 (6.0/9) | 0/0 of 3 (6.0/9) | 0/0 of 3 (6.0/9) | 0/0 of 3 (6.0/9) | 0/0 of 3 (-/?) error | 0/0 of 3 (6.0/9) | 0/0 of 3 (3.0/9) |
| twelve-days | 0/0 of 3 (0.0/12) | 3/3 of 3 (12.0/12) | 0/0 of 3 (0.0/12) | 0/0 of 3 (0.0/12) | 0/0 of 3 (0.0/12) | 0/0 of 3 (0.0/12) | 0/0 of 3 (0.0/12) | 0/0 of 3 (0.0/12) |
| variable-length-quantity | 0/0 of 3 (3.0/20) | 0/0 of 3 (3.0/20) | 0/0 of 3 (5.3/20) | 0/0 of 3 (15.0/20) | 0/0 of 3 (4.7/20) | 0/0 of 3 (17.0/20) | 0/0 of 3 (4.0/20) | 0/0 of 3 (4.0/20) |
| wordy | 0/0 of 3 (0.0/20) | 0/0 of 3 (2.0/20) | 0/0 of 3 (0.0/20) | 0/0 of 3 (3.3/20) | 0/0 of 3 (0.0/20) | 0/0 of 3 (2.0/20) | 0/0 of 3 (4.7/20) | 0/0 of 3 (0.0/20) |
