| Arm | Seeds | Tokens | Wall s | Calls | Initial step tokens | Later steps tokens | Correct function-steps | Strict (public too) | Tokens per correct fn-step | Seconds per correct fn-step | Final functions passing | Final held-out tests | Regressions | Hand edit |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Cx | 3 | 15393 | 185.0 | 13.0 | 4086 | 11307 | 14.0 | 14.0 | 1099 | 13.2 | 2.0/9 | 23.0/80 | 0.0 | kept |
| Ce1 | 3 | 19506 | 193.5 | 14.3 | 4086 | 15420 | 14.0 | 14.0 | 1393 | 13.8 | 2.0/9 | 21.0/80 | 0.0 | kept |
| Ce2 | 3 | 23554 | 240.5 | 14.3 | 4086 | 19468 | 14.0 | 14.0 | 1682 | 17.2 | 2.0/9 | 23.3/80 | 0.0 | kept |

Per seed: tokens / wall s / correct function-steps

| Arm | s1 | s2 | s3 |
|---|---|---|---|
| Cx | 15531 / 188.4 / 14 | 15488 / 186.5 / 14 | 15159 / 180.1 / 14 |
| Ce1 | 20268 / 194.8 / 14 | 19163 / 194.0 / 14 | 19086 / 191.6 / 14 |
| Ce2 | 22450 / 222.3 / 14 | 23294 / 233.6 / 14 | 24917 / 265.6 / 14 |

Correct function-steps with 95% bootstrap CIs (10000 resamples of the 9 functions)

| Arm | Correct | Strict | Correct diff vs A | Strict diff vs A |
|---|---|---|---|---|
| Cx | 14.0 [0.0, 34.0] | 14.0 [0.0, 34.0] | - | - |
| Ce1 | 14.0 [0.0, 34.0] | 14.0 [0.0, 34.0] | 0.0 [0.0, 0.0] | 0.0 [0.0, 0.0] |
| Ce2 | 14.0 [0.0, 34.0] | 14.0 [0.0, 34.0] | 0.0 [0.0, 0.0] | 0.0 [0.0, 0.0] |
