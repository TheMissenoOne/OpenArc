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
