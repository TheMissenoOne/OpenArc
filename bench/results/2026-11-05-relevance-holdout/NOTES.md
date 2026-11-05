# Relevance-ranked context on held-out multi-function files

Follow-up to `../2026-11-04-relevance-context/`, whose nine functions couldn't settle whether `compilation.context.relevance` helps.

## Decision rule, written before the run
- **Tasks:** the 190 MultiPL-E tasks that decontamination drops from the training pool (`train-pool.mjs --holdout`). No fine-tune has seen them, and the bench `dev` and `test` splits aren't touched.
- **Layout:** each seed shuffles the tasks into files of 6 functions, so a function has different siblings on each seed.
  - **Primary, `--pack 6 --rounds`, seeds 1 to 5:** each round adds one function to every file. Prompts hold one region and 0 to 5 siblings. This is where the flag acts: on the first attempt of a region compiled by itself.
  - **Secondary, `--pack 6`, seeds 1 to 3:** whole files at once, which compile in batches of up to 4 by default. A no-harm check, since batches are what a user gets when adding several functions together.
- **Arms:** Cx (control) and Cr (relevance), both with `expandOnFailure`, same as the earlier run. Qwen3.5-9B Q5, open-arc 0.11.0 built from main at 6b60bae. A smoke run of 16 tasks only tested the harness and isn't counted.
- **Primary metric:** per-function difference in passing all held-out tests on the final step of the primary layout (`paired-multi.mjs`), with a function-level bootstrap 95% CI and a sign test.
- **Secondary:** total tokens.
- **Recommend default on** if the CI lower bound is above 0, or if the CI's lower bound is above -1 point and tokens fall at least 10%.
- **Recommend dropping the flag** if the CI upper bound is below 0.
- **A secondary CI upper bound below 0** blocks default on, whatever the primary says.
- **Otherwise** it stays off by default and opt-in.

## What this can't show
These tasks are unrelated to each other, so no spec names a sibling. It tests the trimming half of the feature (siblings removed from the prompt), not the half that keeps named siblings.

## First run: invalid, discarded
The first full run hit a harness bug. `camel()` left the `-2` of `mbpp167-next-power-of-2` and `mbpp388-highest-power-of-2` in the region id. OpenArc rejects that with E010 for the whole project, so as soon as either task entered a project, every later compile made no model calls and all remaining functions scored as failures, in both arms. Two seeds made no calls at all, and final pass rates were around 16%.

Its numbers, for the record only: rounds +0.1 points [-0.6, 0.8], burst -1.4 points [-2.8, -0.2], over mostly uncompiled functions. Raw data is kept outside the repo in `runs/relevance-holdout-invalid-E010`.

**Changes before the rerun:** `camel()` handles digits, and a step that adds functions with no model call now aborts the arm instead of scoring it. A stub-model preflight of the 190 tasks reached every region with no load errors. The decision rule above is unchanged.

**Seen before the rerun:** I'd read the invalid numbers before restarting, so this run isn't blind to them. The rule was committed earlier and nothing about it changes.

**Retries:** in `--rounds`, a region that failed is attempted again when a later round adds a sibling, because that changes its fingerprint. Both arms get this, so it adds calls but not bias.

## Result
The flag **stays off by default and opt-in**. The rule's other two outcomes don't apply: the primary lower bound is -2.8, too low for default on, and the upper bound is above 0, so it isn't dropped. The secondary upper bound is also above 0, so it wouldn't have blocked anything.

Final step, 190 functions per seed, no backend errors or load errors:

| Layout | Seeds | Cx pass | Cr pass | Cr - Cx, points per function (95% CI) | Better / worse | Sign test | Tokens |
|---|---|---|---|---|---|---|---|
| Rounds (primary) | 5 | 793/950 (83.5%) | 781/950 (82.2%) | -1.3 [-2.8, 0.3] | 14 / 21 | p = 0.31 | -13.8% |
| Burst (secondary) | 3 | 452/570 (79.3%) | 439/570 (77.0%) | -2.3 [-4.9, 0.2] | 12 / 22 | p = 0.12 | -10.6% |

Passing functions per seed, Cx vs Cr:
- Rounds: 158/158, 156/153, 160/158, 162/159, 157/153.
- Burst: 157/149, 148/147, 147/143.

Cr never beat Cx on a seed: 7 of the 8 are lower and 1 is tied.

## Reading
- **The earlier gain didn't replicate.** The +9 correct function-steps on evolve-multi's nine functions isn't seen here. Neither interval excludes zero, but both lean negative and no seed favours relevance.
- **Tokens are the real effect:** 11% to 14% fewer. Someone who wants cheaper compiles can trade for them, with a possible small cost in correctness.
- **Not tested:** these tasks are unrelated, so no spec names a sibling. The half of the feature that keeps named siblings has no controlled evidence, including the `lb.healthCheck` gain on self-host.

`rounds.jsonl` and `burst.jsonl` hold every row (`node bench/paired-multi.mjs Cx Cr <file>`). `queue.sh` and `matrix.json` are the run's setup.
