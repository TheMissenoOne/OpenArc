| Arm | Seeds | Tokens | Wall s | Calls | Initial step tokens | Later steps tokens | Correct function-steps | Strict (public too) | Tokens per correct fn-step | Seconds per correct fn-step | Final functions passing | Final held-out tests | Regressions | Hand edit |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| A | 3 | 21163 | 99.8 | 22.7 | 5156 | 16006 | 12.7 | - | 1671 | 7.9 | 2.0/9 | 20.7/80 | 0.0 | kept |
| D | 3 | 16651 | 92.6 | 15.0 | 4411 | 12240 | 23.0 | - | 724 | 4.0 | 3.0/9 | 29.0/80 | 0.0 | kept |

Per seed: tokens / wall s / correct function-steps

| Arm | s1 | s2 | s3 |
|---|---|---|---|
| A | 21818 / 94.7 / 12 | 19309 / 93.6 / 14 | 22361 / 111.0 / 12 |
| D | 16651 / 92.6 / 23 | 16651 / 92.6 / 23 | 16651 / 92.6 / 23 |

Correct function-steps with 95% bootstrap CIs (10000 resamples of the 9 functions); strict needs rows with publicPass

| Arm | Correct | Strict | Correct diff vs A | Strict diff vs A |
|---|---|---|---|---|
| A | 12.7 [0.0, 30.7] | - | - | - |
| D | 23.0 [0.0, 46.0] | - | 10.3 [0.0, 28.3] | - |
