# Dev set, 2026-11-03: OpenArc 0.10.0 (main 3eabb01), three models

Arms: A = OpenArc L0 with repair, D = baseline (whole file, repair). 17 dev exercises, seeds 1-3, llama-server (Vulkan),
Q4_K_M weights, f16 KV cache, 8k context. Runner: `run-dev2.sh`; matrices alongside. Full tables: `summary.md`.

## Accepted-and-correct (mean over seeds, 95% bootstrap CI over exercises)

| model | A | D | D - A (paired) | tokens/task A / D | wall s/task A / D |
|---|---|---|---|---|---|
| Qwen2.5-Coder-7B | 20% [4, 39] | 22% [6, 43] | +2.0 [-5.9, +11.8] | 1667 / 1805 | 16.5 / 12.2 |
| Seed-Coder-8B | 24% [6, 47] | 29% [12, 53] | +5.9 [0.0, +17.6] | 2269 / 1818 | 21.9 / 10.4 |
| Qwen3.5-9B | 16% [2, 33] | 41% [18, 65] | +25.5 [+5.9, +47.1] | 2154 / 2183 | 21.2 / 21.0 |

Versus the frozen 0.9.7 run (`../2026-11-02-dev`, 7B only): A 18% -> 20%, A tokens/task 1963 -> 1667 (-15%), wall
17.5 -> 16.5 s. D 24% -> 22% (same arm, run-to-run noise). OpenArc still does not beat plain prompting on any model,
and loses significantly on Qwen3.5-9B.

## Why A loses

- **Seed-Coder-8B compile failures** (24-39% of A's attempts vs 0% for D; D is never type-checked, only loaded).
  Of 32 compile-failed attempts: 14 are a whole function returned instead of a body (`return (start, end) => {...}`,
  fixed by PR #51), 10 strict-TS errors (possibly-null, implicit any), 7 JSON escaping/syntax (`\n` became `n`), 1 other.
- **Qwen3.5-9B: A's prompt flattens the instructions.** `bench/lib/adapter.mjs` joins the lines of each paragraph with
  spaces and OpenArc joins the intent array with spaces, so the diamond picture, verse layouts and bullet rules arrive as
  one line (`··A·· ·B·B· C···C ·B·B· ··A··`). D sees the original line breaks. 5 of the 10 D-only wins in seeds 1-2 are
  A passing its one public example with code that is wrong on layout (diamond) or edge cases (sum-of-multiples, factor
  0 loops forever); the other 5 fail the public gate (twelve-days, spiral-matrix, matching-brackets). The earlier
  A-same-info ablation (line breaks kept) showed no effect, but on the 7B and 8 exercises only. Follow-up:
  `../2026-11-03-dev-variants`.
- **Routing would not help.** A perfect per-task A/D chooser gains 0-6 points over the better arm; "D, then A if D's
  public gate fails" reaches that ceiling on 7B and Seed-Coder.

One methodological note: a stage0 test run briefly held the openarc lock during Qwen3.5 seed 1 (twelve-days); the
runner waited about 60 s before that task, and that wait is not in its wall time.
