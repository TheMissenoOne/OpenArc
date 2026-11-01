# Latency profile (compile --timings)

Arm A on the `latency` branch (e14b703), same 8 exercises and seeds 1-3 as the other 2026-11-01 runs, qwen2.5-coder 7B
through `llama-server.service` (:8080, -c 16384). 24 tasks, 51 attempts. Driver: `run.mjs --matrix matrix-latency.json`.

Mean per task (ms) and median per attempt:

| stage | per task | median per attempt |
|---|---|---|
| context (build the package) | 3 | 1 |
| model (request, generation, parse) | 8767 | 3922 |
| static checks | 16 | 5 |
| tsc | 66 | 23 |
| sandbox staging (writes, links) | 13 | 11 |
| sandbox startup (spawn to harness start) | 48 | 25 |
| tests (harness load and run) | 68 | 36 |
| commit (stage + transactional write) | 7 | |

Wall time per task 10351 ms. Outside `compile`'s stages: `openarc init` 206 ms and `openarc scaffold` 525 ms (benchmark
project setup, once per project in real use), and about 525 ms of `compile` process startup, parse and analyze.

Against the plain prompt (D, results/2026-11-01-batch): wall 7430 vs 10351 ms, model time 7150 vs 8734 ms, calls 1.75 vs
2.00, tokens 1752 vs 2031.

## Findings

- **Verification is not the bottleneck.** Static checks, tsc and the sandbox together take about 0.2 s per task
  (median about 0.1 s per attempt). A warm type checker would save under 0.1 s per task, so it is not worth doing now.
- **The gap to the plain prompt is about 2.9 s per task:** about 1.6 s more model time (more calls and tokens: the
  acceptance gate's retries) and about 1.3 s outside the model, of which 0.73 s is the benchmark's per-project setup
  (init, scaffold) and about 0.5 s is compile's process startup with parse and analyze.
- The earlier estimate ("1.5-2 s of tsc and sandbox per attempt") was wrong: it attributed CLI startup and project setup
  to verification.

## What this changes

1. Model calls are the lever: raise the first-attempt pass rate (fewer retries) and keep prompts small.
2. Per-invocation overhead (about 0.5 s) matters for one-shot compiles; `watch` should keep the parsed project and
   TypeScript program between cycles (check whether it already does before changing anything).
3. Benchmark harness: setup (init, scaffold) should be reported separately from compile time.
