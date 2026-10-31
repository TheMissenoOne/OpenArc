# Design Log

OpenArc's spec was tested by using it: first by writing OpenArc's own compiler as OpenArc specs, then by running it. Each finding below changed the spec (`[Fn]` tags in `SPEC-phase0.md`).

| # | Found by | Problem | Resolution |
|---|---|---|---|
| F1 | writing specs | long intents needed `.join()`, a call, which breaks static specs | `intent: string \| string[]` |
| F2 | self-hosting | specs' own examples contain marker text in strings, so a line scanner false-alarms | markers are recognised on comment tokens only |
| F3 | running the TS scanner | the raw scanner drops whitespace inside templates and regexes, so a real edit could keep the old hash and be **silently overwritten** | hash parse-tree leaves, not scanner tokens |
| F4 | tsc on the scaffold | a `never`-typed placeholder makes later code unreachable, breaking narrowing, so the first compile could never pass | block placeholder `arc.pending(): void` |
| F5 | developer skeletons | new marked regions defaulted to `developer`, so pending blocks could never be generated | a placeholder body always means `pending` |
| F6 | effectful regions | JSON examples can't pass ports | [[Fakes]] |
| F7 | block examples | arrows were treated as opaque, but they capture `this`/`arguments` | arrows are transparent |
| F8 | running bwrap | asdf shim → wrong Node inside the sandbox; `--as` too small crashes V8; `process.exit()` truncated output | resolved binary + prefix bind; completion line |
| F9 | diagnostic examples | prose messages make examples brittle | codes + structured `detail`, no message text |
| F10 | cross-file imports | code that imports a not-yet-scaffolded symbol fails tsc | scaffold before validate |
| F11 | prompt template | a generated template would feed model output into its own cache key | policy artifacts are hand-written |
| F12 | `core/` | the compiler can't generate itself before it exists | [[Bootstrap]] stages |
| F13 | first real model call | small models return a whole function when asked for a body | the compiler unwraps it |
| F14 | sibling blocks | blocks can only pass their function's examples together | inconclusive per block, joint check before commit |
| — | stage 0 examples | `getLeadingCommentRanges` misses same-line comments, so `x = 1; // why` edits weren't detected | collect trailing comment ranges too |
| — | first sandboxed `.ts` | Node's WASM type stripper needs ~10 GiB of address space | `--as` ≥ 16 GiB (default 32 GiB) |
| — | review | write scope was only implied | structural guards, see [[Safety Model]] |
| — | hand-editing a compiled region | with 0 targets, `compile` returned before STAGE, so the W060 transition was never written: the warning repeated every run and a later spec change couldn't be seen as E061 | a manifest-only transaction when ownership changed and nothing compiles |
| — | second self-compile | a model wrote `import * as ts from "typescript"` (TS2595: typescript needs a default import) | context packages show the project's canonical import line for each package dep; TS2595/1259/2497 escalate context |
| — | second self-compile | Ollama was OOM-killed mid-run, and every remaining region failed with `fetch failed` | the backend retries a connection error once after 10 s; `--keep-going` stops after 3 consecutive E080s |
| — | second self-compile | with `--keep-going`, a function whose block failed skipped its joint check, but its other generated blocks were committed anyway; `compile.run.parse` landed wrong | a block is committed only after its function passes all its examples; otherwise it's held back (W042) and kept in the cache |
| — | VS Code extension parser | `engine.ts` comments that mentioned the marker prefix raised W001 on OpenArc's own source | reworded; hand-written files are checked with `scanMarkers` |
| — | adopting existing code | §10 only covered block extraction | `openarc extract` for whole functions, see [[Adopting Existing Code]] |

The pattern: every serious bug was found by **executing** something (tsc, the scanner, the sandbox, the examples), never by re-reading prose. That's why the spec's tables are executable: the ownership table is `ownership.detect`'s examples, and the sandbox command is `sandbox.buildArgv`'s example.
