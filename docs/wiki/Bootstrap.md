# Bootstrap: OpenArc compiling OpenArc

`selfhost/` is OpenArc's own compiler written as an OpenArc project. It has 21 function regions and 9 block regions, each with a typed spec and examples, and every body starts as a placeholder.

| Stage | What | Status |
|---|---|---|
| **0** | `stage0/`: every region hand-written, then built into the `open-arc` npm package | done: 43/43 regions (24 compiler, 19 palette) pass their examples |
| **1** | stage 0 (installed as `openarc-stage0`) compiles the pristine `selfhost/` scaffold | in progress: 8/29 regions verified after the correction below (first run 14/29, second run claimed 16/29) |
| **2** | the package built from stage 1 recompiles the scaffold with stage 1's cache: 0 model calls, byte-identical output | pending: after stage 1 completes |

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

## Second stage-1 run (2026-10-31)

Settings: stage 0 rebuilt as `openarc-stage0@0.3.0` (API backends plus the two false-rejection fixes), `qwen3.5:9b` local only, `maxContextTokens` 16384, `keepAlive` "2m", `--keep-going`, 3 attempts per region. **No fallback backend was used**: none of `OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` was set, so every attempt went to the local model. Totals: 642.1 s (10 min 43 s wall) and 58 model calls.

Result: 16 of 29 regions are compiler-owned (`compile.run` itself is developer-owned), 13 pending. `tsc` is clean; `run-examples`: 8 ok, 13 pending, 0 failing.

**Cache: only partly reused.** 4 of the 14 first-run regions came from cache at 0 model calls (`cli.parseArgv`, `ownership.detect`, `ids.findDuplicateIds`, `sandbox.buildArgv`). The other 10 (`model.buildRequest`, `model.call` and the 8 `compile.run` blocks) were stale. Their L0/L1 context package grew by 100 to 760 characters compared with the first run, and the context hash is part of the fingerprint. The exact source of the growth has not been traced yet. It matters for stage 2, which requires 0 model calls.

**Passed (16):**
- From cache: `cli.parseArgv`, `ownership.detect`, `ids.findDuplicateIds`, `sandbox.buildArgv`
- Regenerated and re-verified: `model.buildRequest`, `model.call`, and 7 `compile.run` blocks (`lock`, `parse`, `analyze`, `plan`, `generate`, `stage`, `commit`)
- New this run: `txn.planJournal` (2/2), `txn.commit` (1/1)
- `compile.run.unlock` keeps its first-run body. All 3 regeneration attempts failed (`return` is not allowed in a block), and the body on disk was left untouched.

**Weak verification, found in review:** `compile.run.parse` passed but contains statements that do not belong to it (it builds a journal and calls `commit` right after `engine.parse`). Block regions are verified only through `compile.run`'s examples, and one of the two examples is inconclusive while sibling blocks are pending (`OARC-W040`). Indirect verification currently lets wrong blocks through.

**Failed after 3 attempts (13):**

```
✗ block.checkRestrictions    example "break to outside": got []
✗ compile.run.recover        TS2451 cannot redeclare 'journal'
✗ hash.canonicalJson         TS7053 implicit any index on Json
✗ hash.normalizeOwnedText    TS2595 'ts' needs a default import
✗ hash.sha256Tagged          OARC-E074 'crypto' requires effect 'random' 
✗ ids.isValidId              example "#1": got false
✗ markers.scanMarkers        OARC-E097 a comment in the body mentions the marker prefix
✗ markers.buildRegionTree    example "nested": empty roots
✗ model.renderTemplate       example "#1": reports 'name' missing
✗ model.parseOutput          syntax error (',' expected)
✗ plan.selectTargets         TS2322 body returns void
✗ sandbox.readHarnessOutput  TS2304 cannot find name 'ExampleOutcome'
✗ txn.recover                example "crash after entry 1 of 3": got []
```

Notes:
- `hash.sha256Tagged` is still rejected with `OARC-E074`. `hash.ts` has no file-level `crypto` import, so the rule fires either because the model used the global `crypto` (a correct rejection) or because a `crypto` import requested through the answer's `imports` field is not exempt (an OpenArc gap). The log does not show the body, so this is unresolved.
- `markers.scanMarkers` now fails for a different reason: the model wrote a comment that mentions the marker prefix. The narrowed rule is working as intended here.
- Context expansion is uneven. Many regions ran all 3 attempts at L0.

**Memory.** Before the run, 8.2 GB was available and no model was loaded. Only one model was resident at a time, but the Ollama runner (`llama-server`) grew from about 6.0 to 7.9 GB RSS. Swap use rose to 5.1 GB and available RAM fell to about 0.9 GB. Unloading the model once mid-run (`keep_alive: 0`) freed the memory, and the next call reloaded it. After the run, 9.2 GB was available.

Nothing incorrect was committed by the transaction: failed regions stayed `pending`. The exception is the weakly verified `compile.run.parse` described above.

## Next

1. Find out why the context package (and with it the fingerprint) changed for 10 cached regions, and tighten block verification.
2. Configure a `fallbackBackend` (a larger local model or an API; see [[Configuration]]) for the regions a 9B model can't do.
3. Stage 2.

## Correction after the second run

The second run's "16/29" overstated it. `compile.run.parse` was committed with wrong code: it built a journal and called `commit()` during parsing. The cause was an OpenArc bug: with `--keep-going`, when a sibling block failed (`compile.run.recover`), the joint check for `compile.run` was skipped, but the other generated blocks were committed anyway. A block's only behavioural test is its function's examples, so none of the 8 committed `compile.run` blocks had really been verified.

All `compile.run` blocks are back to pending, which leaves **8/29 verified regions** (all function regions with their own examples). The engine is being fixed: blocks are held back until their whole function passes its examples (`OARC-W042`). The 8 function regions are unaffected.
