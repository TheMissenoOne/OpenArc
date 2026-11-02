# Multi-file evolution benchmark: sketches (2026-11-02)

Same scenario as `../2026-11-02-evolve-multi-fixed` (open-arc 0.9.6, qwen2.5-coder 7B on llama-server, seeds 1-3).
S = arm A plus `sketch:` from `bench/sketches/<ex>.<fn>.ts` (all 10 functions; diamond, vlq and rectangles sketches
written for this run). DS = arm D with the same sketch appended to the change text as an implementation outline.

| Arm | Tokens | Wall s | Calls | Correct function-steps | Final held-out tests |
|---|---|---|---|---|---|
| A (no sketch) | 21.2k | 99.8 | 22.7 | 12.7 | 20.7/80 |
| S (sketch) | 34.6k (+63 %) | 89.6 | 31.7 | 14.0 | 13.0/80 |
| D (plain prompt) | 16.7k | 92.6 | 15.0 | 23.0 | 29.0/80 |
| DS (plain + outline) | 17.1k | 85.5 | 14.0 | 23.0 | 32.0/80 |

Conclusion: sketches do not pay on a 7B. For OpenArc they add 63 % tokens for +1.3 correct function-steps (within seed
noise) and fewer final held-out passes; for the plain prompt the outline changes nothing. Failure causes in S (attempt
files, seed 1): holes filled with names out of scope (`b` after the loop in the vlq decode sketch, a sketch-writing
error; `mid` in binary-search), statement-hole rule E035 (a `return` in a statement hole), type errors inside filled
holes, and the same acronym miss as A ("HML" for "HyperText", the camelCase rule is in no example or hole). A sketch is
code the developer must get right, and the model is still the bottleneck inside each hole.
