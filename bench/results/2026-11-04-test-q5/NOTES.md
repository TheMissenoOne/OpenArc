# Test split, 2026-11-04: OpenArc 0.10.0 (main 9842c9f), run once

The dev set was frozen at main 9842c9f after the #57 rerun (`../2026-11-04-dev-q5-param`, A 41% vs D 45%). This is the
single run on the held-out test split: 21 exercises never used for tuning, arms A (OpenArc L0, repair) and D
(baseline, whole file, repair), Qwen3.5-9B Q5_K_M on llama-server (Vulkan), seeds 1-3. Runner: `run-test1.sh`; full
tables: `tables.md`.

## Accepted-and-correct (mean over seeds, 95% bootstrap CI over exercises)

| A | D | A - D (paired) | tokens/task A / D | wall s/task A / D |
|---|---|---|---|---|
| 62% [41, 81] | 52% [29, 71] | +9.5 [-7.9, +27.0] | 1861 / 2111 | 20.6 / 22.1 |

Raw exercise pass (no gate): A 62%, D 57%. Held-out tests passed, pooled: A 80%, D 82%.

OpenArc is level with or slightly ahead of plain prompting on unseen exercises, and uses 12% fewer tokens. The
difference is not significant. On dev the sign was the other way (-3.9, also not significant), so the honest summary
is parity on correctness, with OpenArc cheaper.

## Where the arms differ (per exercise, seeds 1-3, 1 = accepted and correct)

| exercise | A | D | why |
|---|---|---|---|
| nucleotide-count | 111 | 000 | D throws `Invalid nucleotide: X`; the held-out test expects `Invalid nucleotide in strand` |
| saddle-points | 111 | 000 | D fails its public examples (all held-out tests pass, so the gate costs it) |
| run-length-encoding | 101 | 000 | D fails public examples (`...24WBB` for `...24WB`) |
| house | 010 | 000 | |
| protein-translation | 000 | 111 | A never throws `Invalid codon`; throw cases are held-out only (examples cannot express throws) |

Every other exercise is the same in both arms (10 pass, 6 fail). Seeds barely differ: A scored 13/21 and D 11/21 on
each seed.

## Failure profile

- A: 15-18% of attempts fail to compile, 21-26% fail a public example, 0 constraint violations.
- D: 0% compile failures (never type-checked), 50% of attempts fail a public example.
