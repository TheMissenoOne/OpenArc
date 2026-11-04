# deps bench, Qwen3.5-9B Q4_K_M (llama-server, 16k context), three runs

| run | engine | correct | library tasks | no-library tasks |
|---|---|---|---|---|
| `../2026-11-03-deps` | a416fea | 4/9 | 1/6 (semver-compare) | 3/3 |
| `../2026-11-04-deps` | + "use the declared package" line (7739c7f) | 3/9 | 0/6 | 3/3 |
| `2026-11-04-deps-lift` | + import lines lifted out of JSON bodies | 5/9 | 2/6 (deep-equal, slugify) | 3/3 |

- 7739c7f made the model use the package, but in JSON output it wrote the import into the body (TS1232), so every trial
  failed verification. Lifting the leading import lines fixed that.
- Remaining library misses: semver-compare and csv-parse fail verification with the package (wrong import form on the
  first attempt; `maxAttempts` 2); uuid-v4 still verifies without importing; date-add-days finds no usable candidate
  (the search returns date-picker UI packages).
- No wrong proposals in any run: every package proposed raised the held-out score (deep-equal 0/12 -> 12/12, slugify
  0/6 -> 5/6, semver-compare 0/27 -> 27/27 in the first run).
- One run each, one seed: a 1-2 task swing is within noise.
