| Arm | Seeds | Tokens | Wall s | Calls | Initial step tokens | Later steps tokens | Correct function-steps | Strict (public too) | Tokens per correct fn-step | Seconds per correct fn-step | Final functions passing | Final held-out tests | Regressions | Hand edit |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| A | 3 | 24766 | 129.0 | 24.0 | 5132 | 19633 | 12.7 | - | 1955 | 10.2 | 2.0/9 | 13.7/68 | 0.0 | kept |
| D | 3 | 26977 | 135.3 | 21.0 | 4411 | 22566 | 23.0 | - | 1173 | 5.9 | 3.0/9 | 26.0/68 | 0.0 | kept |

Per seed: tokens / wall s / correct function-steps

| Arm | s1 | s2 | s3 |
|---|---|---|---|
| A | 24568 / 107.8 / 12 | 21830 / 97.2 / 12 | 27899 / 182.1 / 14 |
| D | 26977 / 136.3 / 23 | 26977 / 135.0 / 23 | 26977 / 134.7 / 23 |

Correct function-steps with 95% bootstrap CIs (10000 resamples of the 9 functions); strict needs rows with publicPass

| Arm | Correct | Strict | Correct diff vs A | Strict diff vs A |
|---|---|---|---|---|
| A | 12.7 [0.0, 30.7] | - | - | - |
| D | 23.0 [0.0, 46.0] | - | 10.3 [0.0, 28.3] | - |
