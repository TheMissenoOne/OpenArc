# Issue #19: evolution benchmark

One module, `src/toolkit.ts`, changed over 5 steps (`evolve.mjs`): create it with `flatten` and `ofSize`; add
`find` (binary-search); change `flatten`'s intent; hand-edit `ofSize` and add `transpose`; rebuild with no change.
Local qwen2.5-coder 7B (same server and flags as the other #19 runs), seeds 1-3, 3 attempts per step or region.

- **A**: OpenArc, edit the specs, `openarc scaffold`, `openarc compile --keep-going`. "before fix" is batch 7263b22,
  "fixed" is eefb181 (re-verify a region's own body when only its context changed).
- **D**: a fresh chat per step with the current file and the change, the complete file back, up to 3 attempts with
  the failing public examples as feedback.

Mean over 3 seeds, per step: tokens · seconds · model calls.

| step | A before fix tokens · s · calls | A fixed tokens · s · calls | D tokens · s · calls |
|---|---|---|---|
| create | 2486 · 14.6 · 2.7 | 2719 · 15.0 · 3.0 | 859 · 6.8 · 1.0 |
| add binary-search | 3272 · 15.9 · 2.3 | 2227 · 9.2 · 2.0 | 1331 · 9.4 · 1.0 |
| change flatten intent | 745 · 4.2 · 1.0 | 745 · 4.2 · 1.0 | 995 · 8.7 · 1.0 |
| hand-edit ofSize, add transpose | 3943 · 15.6 · 3.0 | 747 · 4.8 · 1.0 | 1306 · 10.6 · 1.0 |
| no change | 766 · 4.2 · 1.0 | 0 · 1.1 · 0.0 | 0 · 0.0 · 0.0 |
| **total** | **11211 · 54.5 · 10.0** | **6438 · 34.3 · 7.0** | **4491 · 35.6 · 4.0** |

Final held-out tests (all functions): A 16/24 in every seed, D 15/24 in every seed (transpose 6/9 vs 5/9). No
regressions in any arm. The hand edit survived in every arm and seed (the 7B kept it when given the whole file).

## Findings

1. **Bug found and fixed.** Adding an unrelated function changed every same-file region's fingerprint, so OpenArc
   regenerated bodies that were verified and unchanged (step 4 before the fix: 3 calls, 3943 tokens, 15.6 s; a
   no-change rebuild still made a call). Fixed in eefb181: a region whose spec is unchanged re-verifies its current
   body first. Total cost fell from 11211 to 6438 tokens and from 54.5 to 34.3 s.
2. **Incremental steps: OpenArc is cheaper and faster than the plain prompt.** Change one intent: 745 vs 995 tokens,
   4.2 vs 8.7 s. Hand edit plus a new function: 747 vs 1306 tokens, 4.8 vs 10.6 s. OpenArc sends one region's context
   and gets one body back; the plain prompt sends and returns the whole file, so its cost grows with the file.
3. **Creation is where OpenArc still loses**: 2719 vs 859 tokens (3 calls vs 1), from the per-call overhead and the
   retries the acceptance gate triggers (the same gap as the one-shot benchmark).
4. Over these 5 steps the totals are 6438 vs 4491 tokens and 34.3 vs 35.6 s: OpenArc already matches on time; on tokens
   it gains about 400-560 per incremental step, so it breaks even after roughly 4 more incremental steps on this file.
