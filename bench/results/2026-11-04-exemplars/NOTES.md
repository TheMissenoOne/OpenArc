# Verified exemplars: no lift (#10)

Adding k already-verified bodies from the project to the prompt, ranked by shared signature words and calls. Tested on `evolve-multi`, Qwen3.5-9B Q5, 3 seeds, `expandOnFailure: true` in every arm. No row has a backend error.

| Arm | Tokens | Correct function-steps | Final functions passing | Final held-out |
|---|---|---|---|---|
| Control | 15,393 | 14.0 | 2.0/9 | 23.0/80 |
| 1 exemplar | 19,506 (+27%) | 14.0 | 2.0/9 | 21.0/80 |
| 2 exemplars | 23,554 (+53%) | 14.0 | 2.0/9 | 23.3/80 |

The paired difference is 0.0 for both arms, at a real token cost. The same two functions pass in every run. The control reproduced the 14.0 from the relevance experiment.

The implementation wasn't merged. `exemplars.patch` keeps it (an opt-in `compilation.context.exemplars`, with a check), in case a larger benchmark gives a reason to revisit. Limits: nine functions, seeds that mostly repeat at temperature 0, signature words rather than the type graph the issue proposed, and the bench's small, unrelated tasks, which may have little to learn from each other. A project with shared APIs could behave differently; this run doesn't test that.
