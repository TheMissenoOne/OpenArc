# Dev set follow-ups, 2026-11-03/04 (Qwen3.5-9B unless noted)

Accepted-and-correct, mean over seeds 1-3, 95% bootstrap CI over the 17 dev exercises. A = OpenArc L0 with repair,
D = whole-file baseline with repair. llama-server (Vulkan), 8k context, `--fit on`.

## 1. Quantization (`../2026-11-03-dev-quant`, OpenArc 0.10.0 main 3eabb01)

| weights | A | D | D - A (paired) |
|---|---|---|---|
| Q3_K_M | 18% | 49% | +31.4 [+11.8, +52.9] |
| Q4_K_M (`../2026-11-03-dev-models`) | 16% | 41% | +25.5 [+5.9, +47.1] |
| Q5_K_M | 29% | 41% | +11.8 [-11.8, +35.3] |
| Q6_K | 35% | 41% | +5.9 [-11.8, +23.5] |
| Seed-Coder-8B Q6_K | 24% | 29% | +5.9 [0.0, +17.6] (same as its Q4) |

A rises with weight precision; D does not. Q6_K D's 59 s/task is one runaway transpose reply (about 7,600 output
tokens, then the repair overflowed the 8k context on every seed), not CPU offload.

## 2. Prompt variants on Q4 (`../2026-11-03-dev-variants`)

A-same-info (the instructions' line breaks kept) 29% vs A 16% (separate runs, not paired); A-code (plain-code output)
24%. The bench adapter now keeps line breaks by default (#56).

## 3. Type-constrained decoding, Qwen2.5-Coder-7B Q4 (`../2026-11-03-dev-typed`)

A-typed 20% = A-typed-off 20%, at 4.6x the wall time. The checker enforces return types; the compile failures came
from the experimental server (multi-region prompts answered with one body, runaway generations). See issue #52.

## 4. Rerun after #51/#55/#56 on Q5_K_M (this directory, main ef75605)

| | A | D | D - A (paired) |
|---|---|---|---|
| accepted-and-correct | 35% [12, 59] | 47% [25, 69] | +11.8 [-9.8, +33.3] |
| held-out tests (accepted) | 49% | 62% | |
| tokens/task, wall s/task | 1765, 14.8 | 2661, 33.0 | |

Versus Q5 before the fixes (section 1): A 29% -> 35%, D 41% -> 47% (D's prompt did not change: run-to-run noise of
about 6 points). The gap is not significant; A is 2.2x faster and uses 34% fewer tokens.

A's 24 compile failures: 13 TS2300 (the body redeclares a parameter: `const question = question.trim();`, on every
repair attempt; fixed by #57, which made sum-of-multiples pass 13/13 on all three seeds), 4 TS2322, 3 TS2588,
2 E097 syntax, 1 TS7053, 1 TS18046.

An earlier attempt at this run (not kept) was invalid: run from a worktree without `bench/node_modules` (held-out
runner could not load), and llama-server died with SIGBUS in a CPU mul_mat (likely an mmap page fault on the HDD).
`run-dev8.sh` now restarts the server before each seed if it is down.

## 5. Rerun with #57 (redeclared parameter -> assignment), `../2026-11-04-dev-q5-param` (branch fix/param-redeclare 59a8aab)

| | A | D | D - A (paired) |
|---|---|---|---|
| accepted-and-correct | 41% [18, 65] | 45% [22, 69] | +3.9 [-13.7, +21.6] |
| held-out tests (accepted) | 56% | 64% | |
| tokens/task, wall s/task | 1690, 14.8 | 1985, 25.8 | |

A 35% -> 41% with the same seeds and server flags; identical on all three seeds (7/17). A's compile-fail rate per
attempt fell from 23-30% to 17-21%.
