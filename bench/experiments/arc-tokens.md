# Pre-registration: `.arc` spec context vs whole-file context, token cost

Written 2026-11-13, before any run with a model. Harness: `bench/arc-tokens.mjs`. The commit that adds this file fixes the harness, the prompts and the rule below; each results row records the commit it ran on. A run on a later commit that changes `bench/arc-tokens.mjs`, `bench/lib/multi.mjs` or `bench/lib/baseline.mjs` is not this experiment.

## Hypothesis

An agent that changes code through the module's compact `.arc` spec (from `openarc decompile`) plus the code of the functions it changes uses fewer tokens than one given the whole source file, with no loss of correctness.

## Task

The evolve-multi scenario (`SCENARIO` in `bench/lib/multi.mjs`, the default of `bench/evolve-multi.mjs`): 9 steps over 4 files (`text`, `arrays`, `codec`, `grid`). 6 steps add functions (one of them right after a hand edit of `ofSize`), 2 change an intent ("Return a new value and never mutate the input."), 1 changes nothing. 9 exercises, all in the dev split (`exercises.json` `sets.dev`); the script refuses `--set test` and any exercise outside `sets.dev`. Public examples and held-out tests: the existing split rule (`bench/lib/common.mjs`).

## Arms

Both arms make one chat per file the step touches, get the same change text for that file (`changeText`: the exercise instructions, the signature and the public examples for an added exercise; the intent sentence for an intent change), and have up to 3 attempts per file. A failed attempt appends the reply and the failing public examples (or the load error) to the conversation. After 3 failed attempts the last attempt is kept.

| | B (baseline) | A (spec) |
|---|---|---|
| system | evolve-multi D's: reply with the complete file in one code block | `arc prompt`'s line (`stage0/src/arcsync.ts`), made plural: one code block per function, body statements only |
| user | the whole current file (none for a new file) + the change text + "Keep everything else unchanged. Return the complete file." | the file's `.arc` text (`openarc decompile` on the current code, in a scratch project under the work dir, no model) + the current code of the target functions (a typed stub for a new function) + the change text + "Return the body only" |
| reply | the complete file, replacing the old one | one body per target function, spliced into the file; the harness writes the signatures and types |
| gate | every public example of the file | every public example of the target functions |

Same for both: model, server, temperature 0, seed 1, output cap, no thinking, the scoring.

## Fixed parameters

From `bench/matrix-evolve-multi.json`: provider `openai` (llama-server at `http://127.0.0.1:8080/v1`), model `qwen2.5-coder-7b` (Qwen2.5-Coder-7B-Instruct Q4_K_M), server context 16384, `max_tokens` 4096, temperature 0, seed 1, 3 attempts per file, one seed, one run. `openarc decompile` from this checkout's `stage0/src/main.ts`. The steps run in order, and within each step B before A.

## Primary metric

Total tokens: the sum over all dev steps, every attempt included, of the backend's reported `usage.prompt_tokens + usage.completion_tokens`, per arm, counted by the same metering proxy evolve-multi uses.

## Correct step

evolve-multi's `correct`: after the step, every function added so far passes all its held-out tests. It is cumulative, so one function that stays wrong makes every later step incorrect.

## Decision rule (fixed in advance)

Arm A wins if both hold:

1. A's total tokens are at least 30% below B's: `A <= 0.70 * B`;
2. A has at most one fewer correct step than B: `correct(A) >= correct(B) - 1`.

Otherwise the claim is not supported. `node bench/arc-tokens.mjs --report <file>` applies the rule mechanically.

Exclusions: a step where decompile gives arm A no `.arc` for a target (decompile fails, or lists no `fn` for it) is left out of both arms' totals and correct counts, and listed. If any step lacks a row for either arm, the verdict is "not computable".

## Reported whatever the outcome

The per-step table (input and output tokens, calls, correct, wall time per arm), both arms' correct-step counts, both totals and their ratio, the verdict, the excluded steps and why. Also, as description only (not part of the rule): held-out tests passed per function, public-example gates, regressions, whether the hand edit survived, decompile time.

## Sample size and what it can show

9 steps, 8 of which call the model, one seed, one model. The correctness comparison is a guard against a large drop. It is not a test of equivalence, and with this few steps a difference of one or two correct steps can be noise. The token comparison holds for this scenario, model and prompt wording only.

## Not used

The held-out test split (`sets.test`). No prompt, parameter or rule changes after a run has started.

## Command

Start llama-server with the model above (thinking off), then:

```bash
cd bench
node arc-tokens.mjs --dataset /path/to/ts-bench --dry-run   # optional: every first-attempt prompt, no model
node arc-tokens.mjs --dataset /path/to/ts-bench          # resumable; results in results/arc-tokens/qwen2.5-coder-7b-s1/arc-tokens.jsonl
node arc-tokens.mjs --report results/arc-tokens/qwen2.5-coder-7b-s1/arc-tokens.jsonl
```

## Results (to be filled after the run)
