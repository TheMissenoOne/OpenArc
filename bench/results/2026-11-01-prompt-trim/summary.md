# Issue #19: prompt-trim run (batch 7263b22)

Same model, server, exercises, seeds 1-3 and budget as `results/2026-11-01-batch`; arms A and E-resample on the
`batch` branch at 7263b22 (labelled 0.9.3), D control reused from the batch run. Driver: `trim.sh` / `matrix-trim.json`.
Full tables: `compare.md` (`node compare.mjs results/2026-11-01-prompt-trim/compare.md results/2026-11-01-batch results/2026-11-01-prompt-trim`).

Changes measured: the batched template says each body is its own function (nothing one declares is visible in
another); the `// T = signature` line is dropped when Types already declares T; closed Rules drop the in-scope
sentence when the file has no imports or helpers.

| arm | tokens/task | s/task | accepted-and-correct |
|---|---|---|---|
| A 0.9.2 | 2123 | 12.0 | 25% |
| A 0.9.3 | 2034 | 10.1 | 25% |
| E-resample 0.9.2 | 2025 | 10.9 | 25% |
| E-resample 0.9.3 | 1851 | 9.8 | 29% |
| D (plain prompt) | 1752 | 7.4 | 25% |

Paired, 95% CI over exercises:

- E-resample 0.9.3 - D: tokens +99 [-123, +283] (no longer distinguishable), time +2.4 s [+0.5, +5.2], accepted-and-correct +4.2 pp [0, +12.5].
- E-resample 0.9.3 - 0.9.2: tokens -174 [-397, -44], time -1.1 s [-3.6, +0.2].
- A 0.9.3 - D: tokens +282 [-42, +737], time +2.7 s [+0.7, +5.8].
- The batch scope note worked: food-chain's batched attempts no longer fail to compile (0 compile failures; the TS2339 shared-scope error is gone), they now fail on behaviour like D does. One E-resample seed passed food-chain, the first accepted-and-correct food-chain in any arm.

What is left against the plain prompt is wall time, about 2.5 s per task outside the model (tsc and the sandbox per
attempt; the sandbox stage is already reused within a compile), not tokens.
