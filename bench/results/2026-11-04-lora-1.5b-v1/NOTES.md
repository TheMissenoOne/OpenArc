# LoRA v1 on Qwen2.5-Coder 1.5B (#63)

Question: does a LoRA trained only on verified compiler output make a small model follow OpenArc's contract?

Setup
- Teacher: Qwen3.5-9B Q5_K_M compiled the MultiPL-E training pool (`bench/train-pool.md`, 351 tasks, no overlap with this benchmark by design). 285 verified, 262 also passed every hidden test. Only those 262 were trained on.
- Training: `bench/train_lora.py`, rank 16, 3 epochs, bf16, 5.4 min on an RX 7600 (PyTorch 2.9.1 ROCm 6.4). Training loss 0.30 to about 0.04.
- Serving: `llama-server --lora` on the same Q4_K_M GGUF as the untuned arm.
- Evaluation: dev split, 17 exercises x 3 seeds, arms A (OpenArc L0, repair) and D (plain prompt, repair), open-arc main e38cac1. The test split was not touched. Dev was not trained on.

Results (pass = every hidden test passes)

| model | arm | pass | public examples pass | tokens/task | attempts/task |
|---|---|---|---|---|---|
| untuned | A | 4/51 (8%) | 18 | 2629 | 2.53 |
| LoRA v1 | A | 7/51 (14%) | 24 | 2055 | 2.25 |
| untuned | D | 6/51 (12%) | 27 | 1909 | 1.94 |
| LoRA v1 | D | 0/51 | 0 | 4033 | 2.82 |

Paired difference, LoRA minus untuned, by exercise (bootstrap over 17 exercises): A +5.9 points [-7.8, +21.6]; D -11.8 points [-29.4, 0.0]. The A gain is not significant.

Arm A diagnostics across attempts, untuned to LoRA:
- Compile failures 60 to 32; containment E097 30 to 9; TS2322 46 to 23; constraint failures 2 to 0
- Example failures E090 32 to 63: more bodies now reach the examples and fail there
- New: TS2588 (assigning to a const) 11

Per exercise, passes out of 3 (untuned to LoRA, arm A): flatten-array 0 to 3, matching-brackets 1 to 3, spiral-matrix 3 to 1. No other exercise passes either way.

Reading
- Contract compliance improved clearly: compile failures fell by almost half and tokens per task by 22%. Correctness did not clearly improve. This matches the weight-space-programming post's claim that a light edit removes obstacles but doesn't add capability.
- Arm D collapsing is expected: all 144 attempts failed to compile, the plain prompt gets the trained output format. The adapter is specific to OpenArc's prompt, so it says nothing about plain prompting.
- Three exercises drive the whole A difference, and 17 clusters is too few to rule out noise.

Checks
- The untuned arm reproduced an earlier run from the same day exactly (A 4/51, D 6/51, identical failure counts), so these runs are deterministic at temperature 0 and the two arms differ only in the adapter.
- More seeds of the same pool would add little training data for the same reason: first attempts repeat. More data needs more tasks or sampled attempts.

## evolve-multi (arm A, 3 seeds, same adapter)

Four files over 9 steps; `evolve-multi/` holds the raw rows. No step had a backend error.

| Model | Tokens | Correct function-steps | Final functions passing | Final held-out |
|---|---|---|---|---|
| Untuned 1.5B | 29,230 | 5.0 | 1.0/9 | 8.0/80 |
| LoRA v1 | 26,862 | 1.7 | 0.3/9 | 14.0/80 |

The paired difference is -3.3 correct function-steps [-10.0, 0.0], so no gain, and if anything a loss. Tokens fell 8%. Held-out passes rose, but the adapter passed fewer functions completely: it gets partway on more functions (flatten-array 2/3, transpose 4/9) and loses spiral-matrix on 2 of 3 seeds. One function (spiral-matrix) accounts for the difference, and seeds mostly repeat at temperature 0, so this is thin evidence either way.

Together with the dev split, v1 improves compliance on single functions and shows no lift on correctness. It isn't worth shipping as is.
