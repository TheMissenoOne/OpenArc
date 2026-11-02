# Context variants (evolve-multi, qwen2.5-coder-7b, 3 seeds, open-arc 0.10.0 + context-variants)

Signature-only pending siblings (Cs) match the full note+intent prompt (A) at 14.0 correct function-steps in every seed, with 21% fewer tokens (19.6k vs 25.0k) and 4 s less. Intent without the note (Ci) is worse (12.0, -2.0 [-6.0, 0.0]). previousBody (Cp) is indistinguishable from A: this benchmark rarely changes the spec of an implemented region (+146 tokens in total). Decision: signature-only prompt, both options dropped.

| Arm | Seeds | Tokens | Wall s | Calls | Initial step tokens | Later steps tokens | Correct function-steps | Strict (public too) | Tokens per correct fn-step | Seconds per correct fn-step | Final functions passing | Final held-out tests | Regressions | Hand edit |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| A | 3 | 24955 | 96.0 | 21.7 | 6933 | 18023 | 14.0 | 14.0 | 1783 | 6.9 | 2.0/9 | 22.3/80 | 0.0 | kept |
| Ci | 3 | 26258 | 105.5 | 21.0 | 9659 | 16598 | 12.0 | 12.0 | 2188 | 8.8 | 2.0/9 | 22.3/80 | 0.0 | kept |
| Cs | 3 | 19607 | 92.0 | 20.3 | 5647 | 13959 | 14.0 | 14.0 | 1400 | 6.6 | 2.0/9 | 24.3/80 | 0.0 | kept |
| Cp | 3 | 25102 | 94.8 | 21.7 | 6933 | 18169 | 14.0 | 14.0 | 1793 | 6.8 | 2.0/9 | 22.3/80 | 0.0 | kept |

Per seed: tokens / wall s / correct function-steps

| Arm | s1 | s2 | s3 |
|---|---|---|---|
| A | 23354 / 86.7 / 14 | 26163 / 102.8 / 14 | 25349 / 98.4 / 14 |
| Ci | 28166 / 108.0 / 12 | 25704 / 106.5 / 12 | 24903 / 101.9 / 12 |
| Cs | 19775 / 87.5 / 14 | 20616 / 99.0 / 14 | 18429 / 89.6 / 14 |
| Cp | 23503 / 86.0 / 14 | 26312 / 100.8 / 14 | 25491 / 97.6 / 14 |

Correct function-steps with 95% bootstrap CIs (10000 resamples of the 9 functions)

| Arm | Correct | Strict | Correct diff vs A | Strict diff vs A |
|---|---|---|---|---|
| A | 14.0 [0.0, 34.0] | 14.0 [0.0, 34.0] | - | - |
| Ci | 12.0 [0.0, 29.0] | 12.0 [0.0, 29.0] | -2.0 [-6.0, 0.0] | -2.0 [-6.0, 0.0] |
| Cs | 14.0 [0.0, 34.0] | 14.0 [0.0, 34.0] | 0.0 [0.0, 0.0] | 0.0 [0.0, 0.0] |
| Cp | 14.0 [0.0, 34.0] | 14.0 [0.0, 34.0] | 0.0 [0.0, 0.0] | 0.0 [0.0, 0.0] |
