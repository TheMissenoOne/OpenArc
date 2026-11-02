# Multi-file evolution benchmark (2026-11-02)

`evolve-multi.mjs`: four modules (`text.ts`, `arrays.ts`, `codec.ts`, `grid.ts`) built and changed over 9 steps (two new files,
functions added to existing files, two intent changes, a hand edit of `ofSize`, a step with no change). 9 exercises,
10 functions, 80 held-out tests at the end. qwen2.5-coder-7b Q4_K_M on llama-server.service (:8080), seeds 1-3,
open-arc built from the `strategy` branch (890e662). D (plain prompt per touched file, temperature 0) is the same on every seed.

Arms: A OpenArc as shipped; R `strategy.repair: "routed"` (a fix hint per failure class, no extra call); P1 `plan:
"after-failure"` (a free-text planning call before each retry); P `plan: "always"` (a planning call before every
code request, batching off); D plain prompt.

A "correct function-step" is one function passing all its held-out tests at one step (the project never reached a
state where every function passes, in any arm). Means over seeds:

| Arm | Seeds | Tokens | Wall s | Calls | Initial step tokens | Later steps tokens | Correct function-steps | Tokens per correct fn-step | Seconds per correct fn-step | Final functions passing | Final held-out tests | Regressions | Hand edit |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| A | 3 | 60195 | 387.2 | 59.3 | 5148 | 55047 | 13.3 | 4515 | 29.0 | 2.0/9 | 23.0/80 | 0.0 | kept |
| R | 3 | 52961 | 205.3 | 58.0 | 5701 | 47260 | 13.7 | 3875 | 15.0 | 2.0/9 | 22.3/80 | 0.0 | kept |
| P1 | 3 | 97750 | 387.6 | 100.3 | 9199 | 88551 | 13.0 | 7519 | 29.8 | 2.0/9 | 19.0/80 | 0.0 | kept |
| P | 3 | 89113 | 405.6 | 102.0 | 12192 | 76921 | 14.0 | 6365 | 29.0 | 2.3/9 | 26.0/80 | 0.0 | kept |
| D | 3 | 16651 | 92.6 | 15.0 | 4411 | 12240 | 23.0 | 724 | 4.0 | 3.0/9 | 29.0/80 | 0.0 | kept |

## Findings

1. **No "agent" variant helps.** Correct function-steps are 13.0-14.0 in every OpenArc arm (A 13.3). Planning costs
   +48-62 % tokens (P 89k, P1 98k vs A 60k) for no gain; P's final 2.3/9 functions is one seed. Routed hints are within
   seed noise of A (53k vs 60k tokens, 13.7 vs 13.3). Per the "no prompt changes without evidence" rule, none ships.
2. **OpenArc loses to the plain prompt here**: 3.6x the tokens, 4x the time, 13.3 vs 23 correct function-steps.
   Three causes, all visible in the logs:
   - **Failed regions are retried on every compile.** A region whose examples the model can't pass (acronym, wordy)
     stays pending and costs up to 3 calls at every later step, whatever changed. The no-change step alone costs A 3-11
     calls and up to 10.6k tokens (D: 0). `watch` already remembers failures per spec key; one-shot `compile` does not.
   - **Runaway output on retries.** At temperature 0.4/0.7 the 7B fell into repetition loops (wordy: `word !== 'on' &&
     word !== 'at' && ...`), and a truncated reply is retried with twice the output cap: 11.5k and 11.0k completion
     tokens, about 210 s each (A seed 3: 786 s total).
   - **All or nothing per function.** A function that fails its public examples is left unimplemented (0 held-out
     credit); the plain prompt keeps imperfect code that passes part of the held-out tests (acronym, rectangles).
3. Hand edits were kept in every run where they were applied. In P seeds 1-2 `ofSize` was still pending at the
   hand-edit step, so there was nothing to edit (the script now records that as "not applied").

## Next

Fix the first two causes in OpenArc (remember failed regions across compiles until their spec or context changes;
don't double the output cap for a repetitive truncated reply), then rerun A and D.
