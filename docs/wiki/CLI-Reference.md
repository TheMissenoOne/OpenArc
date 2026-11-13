# CLI Reference

| Command | |
|---|---|
| `openarc init` | create `openarc.config.json`, `tsconfig.json`, `.openarc/` (existing files are kept). At a terminal it also writes a code-first starter into an empty `src/`: `src/hello.ts` (an interface and a class with one pending method) and `src/hello.test.ts` |
| `openarc init --example` / `--no-example` | write the starter also when not at a terminal (scripts, CI) / never |
| `openarc init --backend <preset> [--model <id>] [--base-url <url>]` | the same, with that backend as the default in a new `openarc.config.json`. Presets: `ollama`, `openai`, `anthropic`, `openrouter`, `local`. See "Connecting providers" in [[Configuration]] |
| `openarc backends` | list the configured backends: provider (and preset), model, URL, and whether each key's env var is set; the default is marked `*`. Keys are never printed |
| `openarc backends test [name]` | send one small structured request through a backend (default: the default backend) and print `OK` or `FAIL`, the reason and the latency; for Ollama, also check the model is pulled. Exit 1 on FAIL |
| `openarc scaffold` | add markers and typed placeholders for specs without a region (a UI spec's region goes in the sibling `.tsx` file, created if missing); deterministic, no model. Doesn't need the project to type-check: run it before `tsc`, since files that import another file's regions only type-check once those exist |
| `openarc compile [ids…]` | generate and verify pending/stale regions in one transaction. A sketch's callees compile before it; a concept variant prints each waived law (`<id>: law "<name>" waived: <reason>`) |
| `openarc compile --keep-going` | commit what passed; failed regions stay pending; exit 1. Blocks whose function can't pass its examples yet (a sibling failed) are held back (W042). Stops calling the backend after 3 consecutive E080s |
| `openarc compile --retry-failed` | also retry regions that exhausted their attempts before on the same spec and context. Without it, such a region is reported as `OARC-E082` (`failed before: …`) with no model call, until its spec, context or model changes, or you name it (`openarc compile <id>`). The memory is `.openarc/failed.json` |
| `openarc compile --timings` | also log each attempt's stage times in ms (`<id>: timings context … · model … · static … · tsc … · sandboxStage … · sandboxStart … · tests …`) and the final write (`timings commit N`, or `timings stage N (nothing written)`). Each failed attempt's file in `.openarc/attempts/<id>/` stores the same `timings`. `model` is the request and parsing the reply; `context` includes building a batched prompt. Output is unchanged without the flag |
| `openarc watch [--debounce <ms>]` | keep running: on each relevant save, analyse, queue stale regions and compile them one at a time (one model in memory). Failed regions wait for their spec to change; an unreachable backend pauses the queue. See [[Watch Mode]] |
| `openarc decompile [dirs...] [--out=<dir>] [--run-tests[=<command>]] [--fresh] [--json]` | read TypeScript or JavaScript code into `.arc` spec files: signatures, intents from comments, examples from running the code, and the tests that use each function. Changes no code and calls no model. `--report` and `--todo` read the last run. See [[Decompile]] |
| `openarc arch [dirs...] [--check] [--json]` / `openarc concept [--check] [--json]` | the levels above the module specs: derive or extend `arc/architecture.arc` (parts, which part uses which, packages) from the real imports, and check it against them; write or reprint `arc/concept.arc` (goals, non-goals, glossary) and check every goal traces to architecture parts. Exit 1 on a violation. See [[Levels]] |
| `openarc adopt [--no-model] [--brief] [--json]` | generate specs for a repo that has none: bodies stay as they are, examples come from running them. See [[Agent Sync]] |
| `openarc sync [--watch] [--no-model] [--brief] [--json]` | carry edits between `openarc.spec.md` and the code, and compile what that leaves stale. See [[Agent Sync]] |
| `openarc graph` | region tree: kind, state (`stale` for a compiler region whose spec changed since its body was verified), number of examples (and of tests, for a code-first region), file |
| `openarc inspect <id>` | spec, state (`stale` as in `graph`, with `ownership` alongside), `tokens` (`{prompt, completion}` the model used to produce the current body, failed attempts included; `null` when the backend reports none or the body isn't generated), manifest entry and provenance (model, output format, context level, attempts, sampling, tokens, checks) |
| `openarc check <id> --oracle <module>#<export> [--runs <n>] [--seed <n>]` | differential test: run the compiled region and a reference implementation on its examples' arguments plus structural edits and seeded variations that fit the parameter types (200 inputs and seed 1 by default), in the sandbox, and list every disagreement; exit 1 if any. See "Thin examples" in [[Writing Specs]] |
| `openarc check <ids...> --mutants [--operators trivial,boundary,comparison,constant,logical,guard,swap]` | mutation score: run deterministic one-change variants of each region's body through tsc and its sandbox examples/tests, and list the ones no check catches. No model; exit 0 (a report), 2 on a bad flag. See [Mutants](#mutants) |
| `openarc doctor` | report Node, the platform, the tools found and the selected sandbox tier, then run one example in that sandbox which also tries a file write, a child process and a network request; each must be refused. No model. Exit 1 if the tier is unavailable or anything gets through (except the network on Node < 25 in the `node` tier, which is reported) |
| `openarc lint [--strict \| --profile recommended\|strict] [--fail-on-warnings] [--format text\|json] [ids or files…]` | check the specs against the lint rules below. Offline and deterministic: it parses and analyses the project like `graph` (no model call, no sandbox run, no network). Exit 1 if any finding is at `error` (or any at all with `--fail-on-warnings` or `lint.failOnWarnings`), 2 on a bad flag or an unknown id/file. Configure it in the `lint` block of [[Configuration]]. See [Lint rules](#lint-rules) |
| `openarc freeze <id>` | make a region developer-owned |
| `openarc release <id>` | hand a region back to the compiler; the current body is backed up to `.openarc/backup/` |
| `openarc resolve <id> --keep` | accept the current body under the new spec |
| `openarc resolve <id> --regen` | back up and regenerate |
| `openarc resolve <id> --unlink` | forget a region whose markers you deleted |
| `openarc extract <file> [--function <name>] [--id <id>] [--style code\|region]` | adopt existing functions as developer-owned regions, bodies untouched. Default `--style code`: markers inside each body, `@arc id` added to the JSDoc, the derived id (generics are fine). `--style region`: markers around the declaration and a `defineRegion` spec with a checker-derived `type <Name>Fn`. Both add a manifest entry. A missing flag value, or one starting with `--` (`--function --id`), is a bad flag (exit 2). See [[Adopting Existing Code]] |
| `openarc deps suggest <id> [--max <n>] [--json] [--no-trial] [--query <text>] [--keep]` | look for an npm package that would help a function region, and decide by measurement: search the registry (keywords from the model, or the intent's words; `--query` sets them), filter on facts (license, downloads, last publish, typosquat-like names, types, install scripts, deprecated, dependency count), then compile the region in scratch copies without and with each of the first `--max` (default 2) survivors, installed pinned with `--ignore-scripts`. Prints the evidence and a proposal (`deps` change, `package.json` entry, install command) or why there is none. **Never installs or writes anything in the project.** `--no-trial` stops after the filter; `--keep` keeps the copies. Exit 0 (a report), 1 unknown region or registry failure, 2 bad flag. See [Dependency suggestions](#dependency-suggestions) |
| `openarc migrate <id>` | convert one `defineRegion` function region to code-first form in one transaction: `export function` with the types printed from `F`, the intent as JSDoc, examples and settings in `arc.configure`; id, ownership and provenance kept. See [[Code First]] |

## Lint rules

`openarc lint` prints one line per finding, `<severity> <rule> <regionId> <file>:<line>  <message>`, then a summary line. `--format json` prints an array of `{rule, severity, id, file, line, message}` instead. The line is the spec's on disk: the `defineRegion` statement, or the code-first declaration. Arguments select regions by id, or by the file that holds their spec. `--profile` replaces `lint.extends` for this run, and `--strict` is short for `--profile strict`. `--fail-on-warnings` makes warnings fail the run too (for CI).

Rules apply to function regions (blocks are verified through their function). Compile never runs them and never reads the `lint` block: lint only reports.

| Rule | recommended | strict | Fires when |
|---|---|---|---|
| `spec/contradictory-examples` | error | error | two examples have the same `args` (compared as canonical JSON) and different outcomes (`expected`, or one throws) |
| `spec/duplicate-test-names` | warn | error | two examples of a region share a `name`, or two `arc.test`/`arc.law` that run for it share kind and name |
| `spec/require-tests` | warn | error | nothing behavioural verifies the region: no example, no `arc.test`, no `arc.law` (only its type is checked) |
| `spec/require-intent` | warn | warn | the intent is empty: a code-first region without a JSDoc description of its own or inherited (`OARC-W023`'s condition), or a `defineRegion` with `intent: ""`. A sketch, `ui` or `concept` spec is exempt |
| `spec/thin-examples` | warn | warn | `OARC-W044`'s condition (the same code): fewer than 3 examples, or none with an edge-case argument. Not reported when `spec/require-tests` already is |
| `spec/boundary-cases` | off | warn | a `number`, `string` or array parameter (literal unions excluded) that no example passes a boundary value: `0` or a negative number, `""`, `[]`, and `null`/`undefined` (or omitting the argument) when the type allows it. For tests it is a text search: a `0`, a negative literal, `""`, `[]`, `null` or `undefined` anywhere in a test that runs for the region counts for every parameter of that kind. A hint, not proof |
| `spec/return-union-coverage` | off | warn | the return type (awaited) is a union of literal types, or includes `null`/`undefined`, and one of its literal, `null` or `undefined` members is never an example's `expected` (`undefined` is written `"$undefined"`). Examples only: a region with any `arc.test`/`arc.law` is skipped, since what a test returns isn't known statically |
| `spec/undeclared-effects` | warn | error | the intent uses a word for an effect that `effects` doesn't declare: `clock` (current date/time, today's date, `Date.now`, wall clock, system time), `random` (random, randomly, shuffle, uuid; not when the intent mentions a seed), `log` (logs, logged, logging, console, "log a/the/each…"). A keyword check on prose: the compiler's own effect check reads bodies, and a spec has none yet |
| `spec/explicit-deps` | off | warn | the intent names something the spec's file imports as code (`` `name` ``, `name(…)`, `name.x(…)`), and the spec declares neither `deps` nor `calls`. `open-arc` and type-only imports don't count |
| `spec/suppression-reason` | error | error | an `openarc-lint-disable-next-line` comment has no reason after `--`. Such a comment suppresses nothing |

A spec error found while analysing (`OARC-E010`, `E011`, `E012`, `E013`, `E020`, `E022`, `E041`, `E064`, `E070`) is also listed, under its code, at `error`. These stop `compile` too; they can't be configured or suppressed.

### Suppressions

A comment directly above the spec silences the named rules for that region:

```ts
// openarc-lint-disable-next-line spec/thin-examples, spec/boundary-cases -- ported as-is; openarc check --oracle covers it
export const parseSpec = arc.defineRegion<Parse>({ id: "csv.parse", intent: "…", examples: […] });
```

"Directly above" is the line before the `defineRegion` statement, or before the code-first declaration's JSDoc (or the declaration, without one). For a method, a comment above its class applies to every method of the class. Several such comments may be stacked. The reason after ` -- ` is required.

## Mutants

`openarc check <ids...> --mutants` asks whether a region's examples and tests can tell its body apart from plausible wrong ones. Only implemented function regions (compiler- or developer-owned) whose examples/tests already pass are analysed; any other prints `mutants <id>: skipped (<reason>)`.

Each mutant is one change to the body, at most 40 per region, always in the same order: trivial bodies first (return the zero value of the return type, `""`, `0`, `false`, `[]`, `{}`, `null` or `undefined`; return the first argument when its type fits; throw), then in source order `boundary` (`>=`/`>`, `<=`/`<`), `comparison` (`===`/`!==`, `==`/`!=`, `<`/`>=`, `>`/`<=`), `constant` (a number `+1` and `-1`), `logical` (`&&`/`||`, a dropped `!`), `guard` (a dropped `if` without `else` that returns or throws) and `swap` (two adjacent same-typed call arguments exchanged). `--operators boundary,constant` picks kinds. A mutant that doesn't type-check is `invalid` and not scored; the others run through the same sandbox and limits as compile. A survivor is then compared with the original on the `check --oracle` inputs: no difference makes it `equivalent` (likely equivalent), which is listed but not scored. Score = killed / (killed + survived).

```
mutants m.weak: killed 3/6 (50%), survived 3, equivalent 0, invalid 0, timeout 0
survived m.weak line 7: n >= 0 -> n > 0; try: args [0] (original true, mutant false)
survived m.weak line 7: n >= 0 -> n >= 1; try: args [0] (original true, mutant false)
survived m.weak line 7: n >= 0 -> n >= -1; try: args [-1] (original false, mutant true)
```

Each survivor names an input where it differs from the original: here `{ args: [0], expected: true }` and `{ args: [-1], expected: false }` would kill all three. An equivalent mutant prints no example: `equivalent m.pick line 14: Math.max(a, b) -> Math.max(b, a)`. With no such input to try (no example has only plain values to vary), `try:` lists the edge values to add, like OARC-W044, or the line to reach. A trivial-body survivor also says `(the examples pass for a vacuous body)`. A survivor means the checks can't tell that variant apart, not that the body is wrong. `equivalent` means no generated input told them apart, not a proof: read those lines. There is no `unreachable` class: the harness records hits per region, not per line, so a mutant the checks never reach is `equivalent` or `survived` by the same rule. No model call, nothing written outside the sandbox stage; exit 0.

## Dependency suggestions

```
deps suggest uuid.isV4: query "uuid validate" (model)
  without: verified, attempts 2, tokens 880, mutants 2/2, 0.8s
  rejected uuid-validate@0.1.0 [MIT, 38211/wk, 2018-05-26]: last publish 2018-05-26 (> 5 years) and < 1000000 weekly downloads
  candidate uuid@14.0.3 [MIT, .../wk, ..., types bundled, 0 deps]
    with:    verified, attempts 1, tokens 440, mutants 6/6, 0.8s
    verdict: better
proposal: uuid@14.0.3 (not applied; nothing was installed in this project)
  spec:         deps: ["uuid"]
  package.json: {"dependencies":{"uuid":"14.0.3"}}
  install:      npm install --save-exact uuid@14.0.3
```

A candidate is `better` when, with it, the region verifies, the body imports it, and something measured improves: the baseline failed, fewer attempts, a higher mutant score, or the same score for at most 80% of the tokens. When the model answers that the standard library suffices, nothing is searched. Network is needed for the keyword request to the region's backend (it leaves the machine when that backend is hosted; `--query` skips it), the registry search and `npm install`; the compiles run in the sandbox as usual. Thresholds and details: SPEC §16. The benchmark is `bench/deps/run.mjs`.

## Files

| Path | Commit it? | |
|---|---|---|
| `openarc.config.json` | yes | backends and policies |
| `.openarc/manifest.json` | yes | ownership, hashes, fingerprints, provenance |
| `.openarc/cache/` | optional | verified bodies by fingerprint; makes rebuilds free and reproducible |
| `.openarc/harness.mjs` | yes | sandbox entry point |
| `.openarc/sandbox/`, `txn/`, `lock` | no | runtime only (`.openarc/.gitignore`). `lock` holds the PID of its holder; a lock whose holder is gone is removed with a warning |
| `openarc.spec.md` | yes | the spec sheet, a view of the specs in the code |
| `src/*.arc.ts` | yes | examples `openarc sync` wrote, as `arc.configure` statements; nothing imports them |
| `.openarc/usage.jsonl` | no | tokens per model request, written during `openarc sync` |
| `.openarc/sheet-state.json`, `sync-status.json`, `sync-watch.pid` | no | `openarc sync` merge base, last status, watcher |
| `.openarc/watch-history.jsonl` | no | `openarc watch` dispatch log, last 1000 entries (`.openarc/.gitignore`) |
| `.openarc/traces.jsonl` | no | only with `"traces": true` or `OPENARC_TRACES=1`: one line per model attempt, `{v: 1, ts, runId, id, file, backend, model, level, attempt, messages: [{role: "system", content}, {role: "user", content}], raw, body, outcome, problems, tokens, compilerVersion}`; `outcome` is `verified`, `provisional`, `unverified`, `failed`, `invalid` or `repeat`; one `runId` per compile (`.openarc/.gitignore`) |
| `.openarc/attempts/<id>/<n>.json` | no | every failed attempt: body (or the raw invalid output), imports, problems, output format, context level, prompt hash, sampling, tokens (`{prompt, completion}` as the backend reported them: Ollama `prompt_eval_count`/`eval_count`, OpenAI `usage.prompt_tokens`/`completion_tokens`, Anthropic `usage.input_tokens`/`output_tokens`; `null` when it reports none); the last 20 per region (`.openarc/.gitignore`; `openarc init` adds the line to an existing file) |

## Diagnostics

Errors are `OARC-Exxx` and warnings `OARC-Wxxx`. The full table is in `SPEC-phase0.md` §11. The common ones:

| Code | Meaning |
|---|---|
| E013 | a code-first region's field (`calls`, `effects`, `deps`, `tolerance`, `outputFormat`, `backend`) is set in more than one of: JSDoc `@arc` tags, `arc.configure`, a `defineRegion` with its id (detail `<field>:<layers>`) |
| E022 | a code-first region (`return arc.todo();`) has no explicit return type: `arc.todo()` would infer `never` |
| E064 | `@arc id` disagrees with the markers inside the body (after the first commit the markers are the id) |
| W023 | a code-first region has no intent: no JSDoc of its own or inherited (printed at PLAN) |
| E070 | type error in the generated body (shown with the line); detail `sketch:TS<code>` for an error in a sketch, `test:TS<code>` for one in a code-first test that runs for the region, `spec:TS<code>` for one outside the regions (the spec's signature or examples, other code in the file), all reported before any model call |
| E082 | attempts exhausted for a region |
| E090 | an example or a test failed. For tests the repair prompt lists each failing assertion with its line; a hidden test by name only. Details: `joint:<tests>` (a class's members failed together), `test-registry:…` (the sandbox registered tests the static plan doesn't have: the run stops) |
| E096 | a file changed on disk while the compile ran; nothing was written, run it again (watch re-queues it by itself) |
| E097 | the generated code tried to write outside its region (a comment that merely mentions `@openarc:` is stripped instead, and logged) |
| E098 | the body calls an imported or port function that its spec's `calls` list doesn't allow (detail: the call path); in a sketch, a fill calls something neither the sketch nor `calls` allows |
| E099 | a sketch region's body changed code outside its holes |
| E100 | an example fails without reaching any hole of the sketch: the sketch decides it, so fix the sketch or the example (detail: the example name) |
| E010 | a spec isn't static, or a code-first test or `arc.configure` can't be read statically (`test:<what>`, `configure:not-static`, `configure:not-a-region:<target>`, `fake:<type>[:ambiguous]`, `examples:method`, `backend:<name>`), or (since 0.8.0) a sketch, concept or UI structure breaks its rules (detail `sketch:…`, `fixture-missing:<name>`, `concept-unknown:<id>`, `waive-unknown-law:<name>`, `ui:…`) |
| E020 | a body doesn't match its type `F`; or a concept variant's `F` isn't an instance of the concept's interface (detail `concept-interface:<name>`) |
| W060 | manual edit detected; region is now yours |
| E061 | you changed the spec of a region you had edited; resolve it |
| E080 | the model backend is unreachable (retried once after 10 s; `stopped:3-consecutive` means the run gave up on it) |
| W042 | a generated block was held back until its sibling blocks exist (it's cached for the next run); or, detail `waiting:<ids>`, a region whose failing examples all end in pending callees: inconclusive, its attempts stop |
| W043 | a compiler-owned region's recompile failed, so it keeps a body that does not satisfy its current spec; `compile` exits 1 and `graph` shows it as `stale` |
| W044 | thin examples: fewer than 3, or none with an edge case (empty, zero, negative, null); consider `openarc check --oracle` |
| W045 | a generated block, a code-first region (detail `unreached:<id>`), or a sketch hole (detail `hole:<id>#<n>`), is unverified: no passing example or test reaches it. It isn't cached as verified or committed; add one that runs through it |
| E091 | the sandbox timed out (wall clock) or hit a resource limit |
| E092 | the configured sandbox tier isn't available on this machine (detail: `bwrap-unavailable`, `sandbox-exec-unavailable`, `no-podman-or-docker`); nothing runs. For a UI region: no DOM (`dom:not-configured`, `dom:jsdom-missing`, `dom:react-missing`, `dom:react-dom-missing`) |
| W046 | weaker isolation: Node permission model only, no OS sandbox (the `node` tier: Windows, or Linux without a usable `bwrap`). Printed once per command. Detail `node-<version>:network-not-blocked` on Node < 25 |
| W047 | `sandbox.isolation` is `"unsafe-none"`: no sandbox at all. Printed at error level on every run; it is never chosen implicitly |
