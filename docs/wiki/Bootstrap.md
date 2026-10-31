# Bootstrap: OpenArc compiling OpenArc

`selfhost/` is OpenArc's own compiler written as an OpenArc project. It has 21 function regions and 9 block regions, each with a typed spec and examples, and every body starts as a placeholder.

| Stage | What | Status |
|---|---|---|
| **0** | `stage0/`: every region hand-written, then built into the `openarc` npm package | ✅ 21/21 regions pass their examples |
| **1** | stage 0 (installed as `openarc-stage0`) compiles the pristine `selfhost/` scaffold | 🟡 first run: 14/29 regions generated and verified |
| **2** | the package built from stage 1 recompiles the scaffold with stage 1's cache: 0 model calls, byte-identical output | ⏳ after stage 1 completes |

Stage 0 stays installed as the known-good compiler. A broken stage N never has to repair itself.

## First stage-1 run (2026-10-31)

Settings: `qwen3.5:9b` (Q4_K_M, local, AMD RX 7600 8 GB), `--keep-going`, 3 attempts per region, context starting at L0. Totals: 376.8 s and 50 model calls.

**Generated and verified (14):**
- `cli.parseArgv` (11/11 examples)
- `ownership.detect` (9/9)
- `ids.findDuplicateIds` (3/3)
- `model.buildRequest`
- `model.call` (via the HTTP fake)
- `sandbox.buildArgv`
- 8 of the 9 `compile.run` blocks: the compiler's own orchestration, verified through `compile.run`'s examples with in-memory ports

**Failed after 3 attempts (11).** Two were OpenArc's fault, and both are fixed:

| Region | Cause | |
|---|---|---|
| `hash.sha256Tagged` | static rule flagged an imported `crypto` as the global | **OpenArc bug**, fixed (file-level bindings exempt) |
| `markers.scanMarkers` | write-scope guard rejected the string `"@openarc:"` that the scanner legitimately needs | **OpenArc bug**, fixed (only marker-shaped comments or lines are rejected) |
| `hash.normalizeOwnedText` | `import * as ts` instead of a default import | model; context could show canonical import forms |
| `plan.selectTargets`, `hash.canonicalJson`, `compile.run.recover`, `model.parseOutput` | type and syntax errors that survived repair | model capability |
| `ids.isValidId`, `markers.buildRegionTree`, `model.renderTemplate`, `block.checkRestrictions` | wrong logic, caught by examples | model capability; the examples did their job |

**Not attempted (4):** `sandbox.readHarnessOutput` and `txn.*`. The machine ran out of RAM (two local models resident plus sandboxes), and the OOM-killer restarted Ollama. Since then Ollama requests send `keep_alive` (default 2m) and the default context is 8192.

Nothing incorrect was committed. Every failure left its region `pending`, and the 14 successes were committed in one transaction.

## Next

1. Re-run with the two fixes (the 14 verified bodies come from cache, at 0 model calls).
2. Configure a `fallbackBackend` (a larger local model or an API; see [[Configuration]]) for the regions a 9B model can't do.
3. Stage 2.
