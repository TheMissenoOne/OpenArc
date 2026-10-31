# Context Packages

A region is compiled the way a unit test isolates code. Instead of the repository, the model gets a **deterministic context package** built from the TypeScript type graph.

| Level | Contains |
|---|---|
| **L0 contract** | the fixed signature; the file's import lines; the signatures of the file's other implemented top-level values (helpers and compiled or hand-written regions; pending regions are left out); the **type closure** of all of these (every project-local type reachable from them, verbatim); intent; effects; allowed imports; examples; rules |
| **L1 dependencies** | + signatures of exported helpers from modules the file imports or the spec lists in `deps`, plus their type closure |
| **L2 source** | + the region's whole file |

Block regions start at L1. They also get the variables in scope, with checker-printed types, and the enclosing function with `<<<HERE>>>` where the block goes.

## Types in scope

The type closure can reach a type the file never imports (for example `Side`, through `LogEntry`). The body can't name it without an import, and in the evaluation that was TS2304 on every attempt, at every level. Such types are marked in the package:

```
// Side: not in scope; the compiler adds import type { Side } from "./types.ts" if you use it
export type Side = "L" | "R";
```

If the body names a marked type, the compiler adds that `import type` line itself. A closure type that its file doesn't export is marked "don't name it".

## What a body may import

The rules in the package and the verifier agree. A requested import (`imports: [{from, names, default?}]`) is accepted when `from` is:
- in the spec's `deps`, or `openarc`;
- a module the file already imports (names it already imports are in scope anyway, and are not imported twice);
- the file of a type the package marked "not in scope", for exactly those type names (a type-only import).

Anything else is `OARC-E071`. `"default": "x"` asks for a default import (`import x from "…"`); without it, imports are named.

## Import forms

"Allowed new imports" lists the spec's `deps`. For each package dep it adds the exact import line the project already uses, e.g. `import ts from "typescript";` (typescript needs a default import; `import * as ts` fails with TS2595). If the project never imports that package, only the specifier is shown.

## Budgets

`budget = (maxContextTokens − outputReserveTokens) × 3.5` characters. If a package is too large, optional sections are dropped in this order: full file, helpers from other modules, same-file values, imports. Larger models get richer packages simply by having a bigger `maxContextTokens`.

## Escalation by failure type

| Failure | Interpretation | Next attempt |
|---|---|---|
| TS2304/2305/2339/2551/2552/2724 (cannot find name/property/export), TS2595/2614/1259/2497 (wrong import form for a module) | context problem | one level more context |
| other type errors, failed examples, static rules | implementation problem | same level + the exact diagnostics |
| last attempt | capability problem | `fallbackBackend`, if configured |
| a retry prompt byte-identical to the previous one | determinism problem | same prompt, temperature 0.4 then 0.7 and a new seed (Ollama, OpenAI-compatible) |

The hash of the context package is part of the fingerprint. If any type a region depends on changes, the cached body is invalid.

## Why

Most of what a large model contributes on a repo-wide task is *finding* the relevant context. OpenArc does that deterministically from the type graph, which leaves the model only the part it's best at: writing a small, well-specified body.

That's the hypothesis to benchmark, measured as implementations that pass per unit of compute, by model size and context level.
