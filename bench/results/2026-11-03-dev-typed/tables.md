Tasks: 102 from results/2026-11-03-dev-typed. OpenArc 0.10.0. Backends: typed-llama-cpp-python-vulkan-code.

Raw = held-out tests on whatever the arm shipped. Accepted-and-correct = counted only when the arm's own gate passed (OpenArc: every region verified on the public examples; baseline: every public example passes). Fail rates are per model attempt: compile = type/syntax error or unparseable output (baseline: the file did not load; it is not type-checked), public = a public example failed, constraint = an OpenArc static rule (imports, forbidden names, effects, calls, sketch containment).

## Per arm and seed

| backend | model | config | seed | n | held-out tests (raw) | exercise pass (raw) | accepted-and-correct exercises | accepted held-out tests | public gate passed | attempts | compile-fail / attempt | public-fail / attempt | constraint violations | mean calls | mean prompt tok | mean output tok | mean wall s |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| typed-llama-cpp-python-vulkan-code | qwen2.5-coder-7b | A-typed-off | 1 | 17 | 40% (74/185) | 18% (3/17) | 18% (3/17) | 40% (74/185) | 71% (12/17) | 34 | 12% | 50% | 0 | 1.9 | 1440.4 | 341.6 | 18.2 |
| typed-llama-cpp-python-vulkan-code | qwen2.5-coder-7b | A-typed-off | 2 | 17 | 44% (81/185) | 24% (4/17) | 24% (4/17) | 43% (79/185) | 76% (13/17) | 31 | 16% | 39% | 0 | 1.7 | 1323.5 | 290.5 | 16.8 |
| typed-llama-cpp-python-vulkan-code | qwen2.5-coder-7b | A-typed-off | 3 | 17 | 45% (84/185) | 18% (3/17) | 18% (3/17) | 45% (84/185) | 76% (13/17) | 31 | 13% | 42% | 0 | 1.7 | 1297.9 | 296.0 | 16.9 |
| typed-llama-cpp-python-vulkan-code | qwen2.5-coder-7b | A-typed | 1 | 17 | 41% (76/185) | 18% (3/17) | 18% (3/17) | 41% (76/185) | 76% (13/17) | 35 | 17% | 43% | 0 | 2.1 | 2011.1 | 1724.9 | 82.1 |
| typed-llama-cpp-python-vulkan-code | qwen2.5-coder-7b | A-typed | 2 | 17 | 44% (82/185) | 24% (4/17) | 24% (4/17) | 44% (82/185) | 82% (14/17) | 31 | 19% | 32% | 0 | 1.8 | 1419.5 | 1606.9 | 85.3 |
| typed-llama-cpp-python-vulkan-code | qwen2.5-coder-7b | A-typed | 3 | 17 | 45% (84/185) | 18% (3/17) | 18% (3/17) | 45% (84/185) | 76% (13/17) | 31 | 16% | 39% | 0 | 1.8 | 1399.2 | 1663.9 | 72.0 |

## Mean over seeds, with 95% task-level bootstrap CIs (10000 resamples of the 17 exercises)

| backend | model | config | seeds | exercise pass (raw) | accepted-and-correct | held-out tests (raw, pooled) | held-out tests (accepted) | mean tokens/task | mean wall s/task |
|---|---|---|---|---|---|---|---|---|---|
| typed-llama-cpp-python-vulkan-code | qwen2.5-coder-7b | A-typed | 1,2,3 | 20% [6%, 37%] | 20% [6%, 37%] | 44% [30%, 61%] | 44% [30%, 61%] | 3275.2 | 79.8 |
| typed-llama-cpp-python-vulkan-code | qwen2.5-coder-7b | A-typed-off | 1,2,3 | 20% [6%, 37%] | 20% [6%, 37%] | 43% [29%, 60%] | 43% [28%, 60%] | 1663.3 | 17.3 |

## Per exercise: seeds with all held-out tests passing, raw / accepted (mean held-out tests passed)

| exercise | A-typed | A-typed-off |
|---|---|---|
| acronym | 0/0 of 3 (0.0/3) | 0/0 of 3 (0.0/3) |
| all-your-base | 0/0 of 3 (6.0/19) | 0/0 of 3 (6.0/19) |
| binary-search | 0/0 of 3 (3.0/8) | 0/0 of 3 (3.0/8) |
| diamond | 0/0 of 3 (0.0/2) | 0/0 of 3 (0.0/2) |
| flatten-array | 2/2 of 3 (2.0/3) | 2/2 of 3 (2.0/3) |
| food-chain | 0/0 of 3 (0.0/6) | 0/0 of 3 (0.0/6) |
| matching-brackets | 3/3 of 3 (14.0/14) | 3/3 of 3 (14.0/14) |
| minesweeper | 1/1 of 3 (3.0/9) | 1/1 of 3 (3.0/9) |
| phone-number | 0/0 of 3 (3.0/16) | 0/0 of 3 (3.0/16) |
| pig-latin | 0/0 of 3 (14.0/16) | 0/0 of 3 (14.0/16) |
| rectangles | 0/0 of 3 (1.7/11) | 0/0 of 3 (1.0/11) |
| spiral-matrix | 3/3 of 3 (4.0/4) | 3/3 of 3 (4.0/4) |
| sum-of-multiples | 0/0 of 3 (10.0/13) | 0/0 of 3 (10.0/13) |
| transpose | 0/0 of 3 (6.0/9) | 0/0 of 3 (6.0/9) |
| twelve-days | 1/1 of 3 (4.0/12) | 1/1 of 3 (4.0/12) |
| variable-length-quantity | 0/0 of 3 (5.0/20) | 0/0 of 3 (4.7/20) |
| wordy | 0/0 of 3 (5.0/20) | 0/0 of 3 (5.0/20) |
