| Arm | Seeds | Tokens | Wall s | Calls | Initial step tokens | Later steps tokens | Correct function-steps | Strict (public too) | Tokens per correct fn-step | Seconds per correct fn-step | Final functions passing | Final held-out tests | Regressions | Hand edit |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| S | 3 | 34585 | 89.6 | 31.7 | 7542 | 27042 | 14.0 | - | 2470 | 6.4 | 2.0/9 | 13.0/80 | 0.0 | kept |
| DS | 3 | 17136 | 85.5 | 14.0 | 5242 | 11894 | 23.0 | - | 745 | 3.7 | 3.0/9 | 32.0/80 | 0.0 | kept |

Per seed: tokens / wall s / correct function-steps

| Arm | s1 | s2 | s3 |
|---|---|---|---|
| S | 34565 / 96.3 / 14 | 31859 / 80.0 / 14 | 37330 / 92.4 / 14 |
| DS | 17136 / 85.8 / 23 | 17136 / 85.1 / 23 | 17136 / 85.5 / 23 |

Correct function-steps with 95% bootstrap CIs (10000 resamples of the 9 functions); strict needs rows with publicPass

| Arm | Correct | Strict | Correct diff vs A | Strict diff vs A |
|---|---|---|---|---|
| S | 14.0 [0.0, 34.0] | - | - | - |
| DS | 23.0 [0.0, 46.0] | - | 9.0 [0.0, 27.0] | - |
