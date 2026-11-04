# Relevance-ranked context (`compilation.context.relevance`)

At level 0, same-file siblings the spec names (in its intent, signature, declaration or `calls`) keep their signature and types. The others are listed by name only, and a failed attempt expands to level 1, which shows them all. The flag is off by default and doesn't enter the fingerprint.

## Prompt size (no model)
Level 0 prompts for the 44 self-host function regions: 180,317 to 146,680 characters, 19% fewer. Median 4,103 to 3,090.

## evolve-multi (Qwen3.5-9B Q5, 3 seeds)
Both arms use `expandOnFailure: true`, unlike the benchmark's usual arm A, so their numbers don't compare with earlier A results.

| Arm | Tokens | Correct function-steps | Final functions passing | Final held-out |
|---|---|---|---|---|
| Cx, control | 15,342 | 14.0 | 2.0/9 | 23.0/80 |
| Cr, relevance | 14,555 | 23.0 | 3.0/9 | 36.0/80 |

The paired difference is +9.0 correct function-steps [0.0, 27.0], and tokens fell 5%.

By function, Cr gains diamond (0 to 2/2), wordy (0 to 12/20, 9/20 on seed 3) and variable-length-quantity (5 to 7/20), and loses rectangles (2 to 0). Seeds mostly repeat at temperature 0, so this is close to one observation per function. The interval touches zero, and diamond alone accounts for the correct-step difference.

Seed 1 of Cx was rerun: the original hit `503 Loading model` on its first step because the 9B took about 4 minutes to load and the queue waited 3. That row was dropped. No kept row has a backend error.

## Self-host retry (Qwen3.5-9B Q5)
The failed stage 1 regions, flag on: 43 calls, 17 minutes. `lb.healthCheck` verified (6/6 examples, second attempt, level 0), a region the 9B without the flag and the 14B both failed. The other regions in the retry still fail or are held back (`selfhost-retry.txt`). The earlier flag-off 9B runs aren't a controlled comparison: any prompt change can flip a deterministic outcome, so one region shows little by itself.

## Reading
Promising and cheap, with no sign of harm beyond rectangles, but not enough to make it the default. A proper test needs more multi-function tasks than evolve-multi's nine functions.
