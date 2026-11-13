arc-tokens dry run: 9 steps (dev split), first-attempt INPUT of each arm (system + user message), no model called.
Tokens are an ESTIMATE: characters / 4 (the repo has no tokenizer). Repairs (attempts 2-3) and output are not included.
Earlier steps' code is stand-in code from earlier runs (config D finalSource): acronym <- 2026-11-04-dev-q5-param qwen3.5-9b-q5km held-out 3/3; diamond <- 2026-11-04-dev-q5-param qwen3.5-9b-q5km held-out 2/2; flatten-array <- 2026-11-04-lora-1.5b-v1 qwen2.5-coder-1.5b held-out 3/3; binary-search <- 2026-11-04-lora-1.5b-v1 qwen2.5-coder-1.5b held-out 3/8; variable-length-quantity <- 2026-11-03-dev-quant qwen3.5-9b-q6k held-out 17/20; transpose <- 2026-11-04-dev-q5-param qwen3.5-9b-q5km held-out 6/9; spiral-matrix <- 2026-11-04-lora-1.5b-v1 qwen2.5-coder-1.5b held-out 4/4; rectangles <- 2026-11-04-dev-q5-param qwen3.5-9b-q5km held-out 7/11; wordy <- 2026-11-04-dev-q5-param qwen3.5-9b-q5km held-out 18/20

| # | step | exercises | B prompts | B chars | B est tok | A prompts | A chars | A est tok | .arc chars | A/B |
|---|---|---|---|---|---|---|---|---|---|---|
| 0 | create text.ts and arrays.ts | acronym, diamond, flatten-array, binary-search | 2 | 5228 | 1307 | 2 | 6503 | 1626 | 233 | 1.24 |
| 1 | add codec.ts | variable-length-quantity | 1 | 2062 | 516 | 1 | 2675 | 669 | 99 | 1.30 |
| 2 | add transpose to arrays.ts | transpose | 1 | 2025 | 506 | 1 | 1819 | 455 | 221 | 0.90 |
| 3 | change flatten intent | flatten-array | 1 | 5416 | 1354 | 1 | 1256 | 314 | 362 | 0.23 |
| 4 | add grid.ts | spiral-matrix | 1 | 756 | 189 | 1 | 1135 | 284 | 62 | 1.50 |
| 5 | hand-edit ofSize, add rectangles | rectangles | 1 | 1515 | 379 | 1 | 1355 | 339 | 135 | 0.89 |
| 6 | add wordy to text.ts | wordy | 1 | 3261 | 815 | 1 | 2636 | 659 | 539 | 0.81 |
| 7 | change binary-search intent | binary-search | 1 | 5413 | 1353 | 1 | 1312 | 328 | 362 | 0.24 |
| 8 | no change |  | 0 | 0 | 0 | 0 | 0 | 0 | 0 | - |
| | total | | 9 | 25676 | 6419 | 9 | 18691 | 4673 | | 0.73 |

decompile failures: 0
