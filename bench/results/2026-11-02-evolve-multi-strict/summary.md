| Arm | Seeds | Tokens | Wall s | Calls | Initial step tokens | Later steps tokens | Correct function-steps | Strict (public too) | Tokens per correct fn-step | Seconds per correct fn-step | Final functions passing | Final held-out tests | Regressions | Hand edit |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| A | 3 | 19031 | 96.9 | 20.3 | 5148 | 13883 | 12.7 | 12.7 | 1502 | 7.7 | 2.0/9 | 20.3/80 | 0.0 | kept |
| D | 3 | 16801 | 92.9 | 15.0 | 4486 | 12315 | 23.0 | 14.0 | 730 | 4.0 | 3.0/9 | 29.0/80 | 0.0 | kept |

Per seed: tokens / wall s / correct function-steps

| Arm | s1 | s2 | s3 |
|---|---|---|---|
| A | 18516 / 96.9 / 12 | 19285 / 93.0 / 14 | 19292 / 100.8 / 12 |
| D | 16801 / 92.9 / 23 | 16801 / 93.0 / 23 | 16801 / 92.9 / 23 |


Strict counting (held-out and the function's own public examples) shrinks D's lead over A from 23 vs 12.7 to 14 vs 12.7. D's acronym body passes the held-out tests but fails its public example, so most of the earlier gap was a metric artifact.
