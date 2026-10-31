# Context Packages

A region is compiled the way a unit test isolates code. Instead of the repository, the model gets a **deterministic context package** built from the TypeScript type graph.

| Level | Contains |
|---|---|
| **L0 contract** | the fixed signature; the **type closure** of `F` (every project-local type reachable from the signature, verbatim); intent; effects; allowed imports; examples; rules |
| **L1 dependencies** | + the file's import lines; signatures of exported helpers from modules the file imports or the spec lists in `deps`, plus their type closure |
| **L2 source** | + the region's whole file |

Block regions start at L1. They also get the variables in scope, with checker-printed types, and the enclosing function with `<<<HERE>>>` where the block goes.

## Budgets

`budget = (maxContextTokens − outputReserveTokens) × 3.5` characters. If a package is too large, optional sections are dropped in this order: full file, helpers, imports. Larger models get richer packages simply by having a bigger `maxContextTokens`.

## Escalation by failure type

| Failure | Interpretation | Next attempt |
|---|---|---|
| TS2304/2305/2339/2551/2552/2724 (cannot find name/property/export) | context problem | one level more context |
| other type errors, failed examples, static rules | implementation problem | same level + the exact diagnostics |
| last attempt | capability problem | `fallbackBackend`, if configured |

The hash of the context package is part of the fingerprint. If any type a region depends on changes, the cached body is invalid.

## Why

Most of what a large model contributes on a repo-wide task is *finding* the relevant context. OpenArc does that deterministically from the type graph, which leaves the model only the part it's best at: writing a small, well-specified body.

That's the hypothesis to benchmark, measured as implementations that pass per unit of compute, by model size and context level.
