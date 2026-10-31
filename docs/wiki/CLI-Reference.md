# CLI Reference

| Command | |
|---|---|
| `openarc init` | create `openarc.config.json`, `tsconfig.json`, `.openarc/` (existing files are kept) |
| `openarc scaffold` | add markers and typed placeholders for specs without a region; deterministic, no model |
| `openarc compile [ids…]` | generate and verify pending/stale regions in one transaction |
| `openarc compile --keep-going` | commit what passed; failed regions stay pending; exit 1. Blocks whose function can't pass its examples yet (a sibling failed) are held back (W042). Stops calling the backend after 3 consecutive E080s |
| `openarc graph` | region tree: kind, state, number of examples, file |
| `openarc inspect <id>` | spec, state, manifest entry and provenance (model, context level, attempts, checks) |
| `openarc freeze <id>` | make a region developer-owned |
| `openarc release <id>` | hand a region back to the compiler; the current body is backed up to `.openarc/backup/` |
| `openarc resolve <id> --keep` | accept the current body under the new spec |
| `openarc resolve <id> --regen` | back up and regenerate |
| `openarc resolve <id> --unlink` | forget a region whose markers you deleted |
| `openarc extract <file> [--function <name>] [--id <id>]` | adopt existing functions as developer-owned regions: markers, a `defineRegion` spec with a checker-derived `type <Name>Fn`, and a manifest entry; bodies untouched. See [[Adopting Existing Code]] |

## Files

| Path | Commit it? | |
|---|---|---|
| `openarc.config.json` | yes | backends and policies |
| `.openarc/manifest.json` | yes | ownership, hashes, fingerprints, provenance |
| `.openarc/cache/` | optional | verified bodies by fingerprint; makes rebuilds free and reproducible |
| `.openarc/harness.mjs` | yes | sandbox entry point |
| `.openarc/sandbox/`, `txn/`, `lock` | no | runtime only (`.openarc/.gitignore`) |

## Diagnostics

Errors are `OARC-Exxx` and warnings `OARC-Wxxx`. The full table is in `SPEC-phase0.md` §11. The common ones:

| Code | Meaning |
|---|---|
| E070 | type error in the generated body (shown with the line) |
| E082 | attempts exhausted for a region |
| E090 | an example failed |
| E097 | the generated code tried to write outside its region |
| W060 | manual edit detected; region is now yours |
| E061 | you changed the spec of a region you had edited; resolve it |
| E080 | the model backend is unreachable (retried once after 10 s; `stopped:3-consecutive` means the run gave up on it) |
| W042 | a generated block was held back until its sibling blocks exist; it's cached for the next run |
