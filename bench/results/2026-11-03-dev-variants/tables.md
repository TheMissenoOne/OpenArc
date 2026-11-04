Tasks: 102 from results/2026-11-03-dev-variants. OpenArc 0.10.0. Backends: llama-server-vulkan-json.

Raw = held-out tests on whatever the arm shipped. Accepted-and-correct = counted only when the arm's own gate passed (OpenArc: every region verified on the public examples; baseline: every public example passes). Fail rates are per model attempt: compile = type/syntax error or unparseable output (baseline: the file did not load; it is not type-checked), public = a public example failed, constraint = an OpenArc static rule (imports, forbidden names, effects, calls, sketch containment).

## Per arm and seed

| backend | model | config | seed | n | held-out tests (raw) | exercise pass (raw) | accepted-and-correct exercises | accepted held-out tests | public gate passed | attempts | compile-fail / attempt | public-fail / attempt | constraint violations | mean calls | mean prompt tok | mean output tok | mean wall s |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| llama-server-vulkan-json | qwen3.5-9b | A-code | 1 | 17 | 44% (81/185) | 24% (4/17) | 24% (4/17) | 43% (80/185) | 71% (12/17) | 30 | 7% | 50% | 0 | 1.6 | 1409.8 | 961.2 | 29.0 |
| llama-server-vulkan-json | qwen3.5-9b | A-code | 2 | 17 | 48% (88/185) | 24% (4/17) | 24% (4/17) | 45% (84/185) | 76% (13/17) | 31 | 10% | 45% | 0 | 1.8 | 1636.0 | 1129.1 | 33.1 |
| llama-server-vulkan-json | qwen3.5-9b | A-code | 3 | 17 | 51% (95/185) | 24% (4/17) | 24% (4/17) | 49% (90/185) | 82% (14/17) | 27 | 4% | 37% | 0 | 1.5 | 1315.2 | 797.6 | 25.6 |
| llama-server-vulkan-json | qwen3.5-9b | A-same-info | 1 | 17 | 54% (99/185) | 29% (5/17) | 29% (5/17) | 51% (94/185) | 76% (13/17) | 33 | 12% | 42% | 0 | 1.8 | 1599.9 | 508.8 | 18.6 |
| llama-server-vulkan-json | qwen3.5-9b | A-same-info | 2 | 17 | 52% (97/185) | 29% (5/17) | 29% (5/17) | 52% (97/185) | 82% (14/17) | 32 | 9% | 44% | 0 | 1.8 | 1559.5 | 497.8 | 18.2 |
| llama-server-vulkan-json | qwen3.5-9b | A-same-info | 3 | 17 | 49% (90/185) | 29% (5/17) | 29% (5/17) | 46% (85/185) | 71% (12/17) | 34 | 15% | 44% | 0 | 1.9 | 1628.9 | 523.4 | 19.9 |

## Mean over seeds, with 95% task-level bootstrap CIs (10000 resamples of the 17 exercises)

| backend | model | config | seeds | exercise pass (raw) | accepted-and-correct | held-out tests (raw, pooled) | held-out tests (accepted) | mean tokens/task | mean wall s/task |
|---|---|---|---|---|---|---|---|---|---|
| llama-server-vulkan-json | qwen3.5-9b | A-code | 1,2,3 | 24% [6%, 47%] | 24% [6%, 47%] | 48% [32%, 66%] | 46% [29%, 65%] | 2416.3 | 29.2 |
| llama-server-vulkan-json | qwen3.5-9b | A-same-info | 1,2,3 | 29% [12%, 53%] | 29% [12%, 53%] | 52% [34%, 71%] | 50% [32%, 69%] | 2106.1 | 18.9 |

## Per exercise: seeds with all held-out tests passing, raw / accepted (mean held-out tests passed)

| exercise | A-code | A-same-info |
|---|---|---|
| acronym | 0/0 of 3 (0.0/3) | 0/0 of 3 (0.0/3) |
| all-your-base | 0/0 of 3 (9.0/19) | 0/0 of 3 (9.3/19) |
| binary-search | 0/0 of 3 (3.0/8) | 0/0 of 3 (3.0/8) |
| diamond | 0/0 of 3 (0.0/2) | 3/3 of 3 (2.0/2) |
| flatten-array | 3/3 of 3 (3.0/3) | 3/3 of 3 (3.0/3) |
| food-chain | 0/0 of 3 (1.7/6) | 0/0 of 3 (2.7/6) |
| matching-brackets | 3/3 of 3 (14.0/14) | 3/3 of 3 (14.0/14) |
| minesweeper | 3/3 of 3 (9.0/9) | 3/3 of 3 (9.0/9) |
| phone-number | 0/0 of 3 (3.0/16) | 0/0 of 3 (3.0/16) |
| pig-latin | 0/0 of 3 (13.0/16) | 0/0 of 3 (14.7/16) |
| rectangles | 0/0 of 3 (4.0/11) | 0/0 of 3 (7.0/11) |
| spiral-matrix | 3/3 of 3 (4.0/4) | 3/3 of 3 (4.0/4) |
| sum-of-multiples | 0/0 of 3 (10.0/13) | 0/0 of 3 (10.0/13) |
| transpose | 0/0 of 3 (6.0/9) | 0/0 of 3 (6.0/9) |
| twelve-days | 0/0 of 3 (0.0/12) | 0/0 of 3 (0.0/12) |
| variable-length-quantity | 0/0 of 3 (3.7/20) | 0/0 of 3 (1.7/20) |
| wordy | 0/0 of 3 (4.7/20) | 0/0 of 3 (6.0/20) |
