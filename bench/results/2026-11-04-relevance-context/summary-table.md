| Arm | Seeds | Tokens | Wall s | Calls | Initial step tokens | Later steps tokens | Correct function-steps | Strict (public too) | Tokens per correct fn-step | Seconds per correct fn-step | Final functions passing | Final held-out tests | Regressions | Hand edit |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Cx | 3 | 15342 | 189.3 | 13.0 | 4086 | 11256 | 14.0 | 14.0 | 1096 | 13.5 | 2.0/9 | 23.0/80 | 0.0 | kept |
| Cr | 3 | 14555 | 184.9 | 13.0 | 4024 | 10531 | 23.0 | 23.0 | 633 | 8.0 | 3.0/9 | 36.0/80 | 0.0 | kept |

Per seed: tokens / wall s / correct function-steps

| Arm | s1 | s2 | s3 |
|---|---|---|---|
| Cx | 15531 / 188.4 / 14 | 15488 / 193.7 / 14 | 15008 / 185.7 / 14 |
| Cr | 14327 / 180.9 / 23 | 14335 / 177.6 / 23 | 15002 / 196.2 / 23 |

Correct function-steps with 95% bootstrap CIs (10000 resamples of the 9 functions)

| Arm | Correct | Strict | Correct diff vs A | Strict diff vs A |
|---|---|---|---|---|
| Cx | 14.0 [0.0, 34.0] | 14.0 [0.0, 34.0] | - | - |
| Cr | 23.0 [0.0, 46.0] | 23.0 [0.0, 46.0] | 9.0 [0.0, 27.0] | 9.0 [0.0, 27.0] |
