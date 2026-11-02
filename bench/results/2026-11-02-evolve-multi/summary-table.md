| Arm | Seeds | Tokens | Wall s | Calls | Initial step tokens | Later steps tokens | Correct function-steps | Strict (public too) | Tokens per correct fn-step | Seconds per correct fn-step | Final functions passing | Final held-out tests | Regressions | Hand edit |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| A | 3 | 60195 | 387.2 | 59.3 | 5148 | 55047 | 13.3 | - | 4515 | 29.0 | 2.0/9 | 23.0/80 | 0.0 | kept |
| R | 3 | 52961 | 205.3 | 58.0 | 5701 | 47260 | 13.7 | - | 3875 | 15.0 | 2.0/9 | 22.3/80 | 0.0 | kept |
| P1 | 3 | 97750 | 387.6 | 100.3 | 9199 | 88551 | 13.0 | - | 7519 | 29.8 | 2.0/9 | 19.0/80 | 0.0 | kept |
| P | 3 | 89113 | 405.6 | 102.0 | 12192 | 76921 | 14.0 | - | 6365 | 29.0 | 2.3/9 | 26.0/80 | 0.0 | kept |
| D | 3 | 16651 | 92.6 | 15.0 | 4411 | 12240 | 23.0 | - | 724 | 4.0 | 3.0/9 | 29.0/80 | 0.0 | kept |

Per seed: tokens / wall s / correct function-steps

| Arm | s1 | s2 | s3 |
|---|---|---|---|
| A | 29879 / 106.6 / 13 | 67195 / 269.2 / 14 | 83511 / 785.6 / 13 |
| R | 55276 / 186.8 / 14 | 67360 / 279.4 / 13 | 36247 / 149.6 / 14 |
| P1 | 70029 / 273.5 / 13 | 74331 / 300.3 / 13 | 148889 / 589.0 / 13 |
| P | 92342 / 417.0 / 12 | 102549 / 464.2 / 12 | 72448 / 335.6 / 18 |
| D | 16651 / 92.6 / 23 | 16651 / 92.6 / 23 | 16651 / 92.6 / 23 |

Correct function-steps with 95% bootstrap CIs (10000 resamples of the 9 functions); strict needs rows with publicPass

| Arm | Correct | Strict | Correct diff vs A | Strict diff vs A |
|---|---|---|---|---|
| A | 13.3 [0.0, 33.3] | - | - | - |
| R | 13.7 [0.0, 33.7] | - | 0.3 [0.0, 1.0] | - |
| P1 | 13.0 [0.0, 32.0] | - | -0.3 [-1.0, 0.0] | - |
| P | 14.0 [0.0, 32.7] | - | 0.7 [-2.7, 4.3] | - |
| D | 23.0 [0.0, 46.0] | - | 9.7 [0.0, 27.7] | - |
