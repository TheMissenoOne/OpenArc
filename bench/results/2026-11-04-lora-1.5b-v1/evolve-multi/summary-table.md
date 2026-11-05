| Arm | Seeds | Tokens | Wall s | Calls | Initial step tokens | Later steps tokens | Correct function-steps | Strict (public too) | Tokens per correct fn-step | Seconds per correct fn-step | Final functions passing | Final held-out tests | Regressions | Hand edit |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 15b | 3 | 29230 | 67.4 | 23.0 | 7103 | 22128 | 5.0 | 5.0 | 5846 | 13.5 | 1.0/9 | 8.0/80 | 0.0 | kept |
| lora | 3 | 26862 | 65.5 | 25.0 | 9246 | 17617 | 1.7 | 1.7 | 16117 | 39.3 | 0.3/9 | 14.0/80 | 0.0 | kept |

Per seed: tokens / wall s / correct function-steps

| Arm | s1 | s2 | s3 |
|---|---|---|---|
| 15b | 31134 / 68.0 / 5 | 26499 / 64.7 / 5 | 30058 / 69.5 / 5 |
| lora | 28370 / 67.9 / 0 | 29505 / 72.8 / 0 | 22712 / 55.7 / 5 |

Correct function-steps with 95% bootstrap CIs (10000 resamples of the 9 functions)

| Arm | Correct | Strict | Correct diff vs A | Strict diff vs A |
|---|---|---|---|---|
| 15b | 5.0 [0.0, 15.0] | 5.0 [0.0, 15.0] | - | - |
| lora | 1.7 [0.0, 5.0] | 1.7 [0.0, 5.0] | -3.3 [-10.0, 0.0] | -3.3 [-10.0, 0.0] |
