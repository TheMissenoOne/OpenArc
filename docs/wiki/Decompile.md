# Decompile

`openarc decompile` reads a project's code into `.arc` spec files. It works on TypeScript and plain JavaScript, changes nothing in the code, writes no markers, and calls no model.

```
openarc decompile [dirs...] [--out=<dir>] [--run-tests[=<command>]] [--fresh] [--json]
openarc decompile --report [--json]
openarc decompile --todo [--json]
```

`dirs` are the source directories (default `src`). Run it from the folder that holds `package.json`. The project does not need to install `open-arc`: without it, the sandbox runs the example runner of the `openarc` you called (not on the `container` isolation tier).

## What it recovers

For every exported function:

| Part | Where it comes from |
|---|---|
| Signature and types | the TypeScript checker. In JavaScript that means inference and JSDoc: an untyped parameter is `Any` |
| Intent | the function's JSDoc, or the `//` lines directly above it |
| Examples | running the function in the sandbox. Inputs come from literal calls found in the project (tests first, also through a `const` bound to a literal) and from the parameter types. Each input runs twice, and one whose results or changed arguments differ is dropped |
| Tests | the test files that use the function, found by their imports |

Exported type aliases and interfaces become `type` lines. Classes and generic functions are skipped and counted.

## The `.arc` file

One file per module, under `arc/spec/` by default (`--out=<dir>` changes it), mirroring the source tree. The levels above it live next to that folder: see [[Levels]].

```
module survival from "src/survival.js"

fn drain(stats: Any, effort?: Num): { water: Num }
  "Drains water by effort. Never leaves 0..100."
  example ({water: 50}) => {water: 40}
  example ({water: 5}, 2) => {water: 0}

fn label(rain: Any): "heavy rain" | "clear"
  example (0.9) => "heavy rain"
  example (0) => "clear"
  rule known: result in ["heavy rain", "clear"]
```

| Line | Meaning |
|---|---|
| `module <name> from "<file>"` | one per file. Indented strings under it are the module's intent |
| `type Name = <type>` | a named type |
| `fn name(p: T, q?: T, ...r: [T]): R` | a function. `async fn` when it returns a promise |
| `"text"` | one line of intent |
| `example (args) => value # name` | a call and its result. Values are JSON; object keys need no quotes |
| `example (args) => value after (args) # name` | the call changes its arguments: they are as listed after it. A function that returns nothing shows `=> "$undefined" after (...)` |
| `example (args) throws "text"` | the call throws, and the message contains the text |
| `rule name: <predicate>` | kept and printed. Rules are not evaluated yet |
| `hold` | reserved for sync |

Types: `Int`, `Float`, `Num`, `Bool`, `Str`, `Any`, `Void`, `Null`, `[T]`, `{ k: T, k?: T }`, `A | B`, `T?`, literals, names of `type` lines, and a backticked native type such as `` `Map<string, number>` `` for anything else.

What you write in an `.arc` file stays. A later run keeps a function's intent, rules and examples, and puts the lines in the order above.

## Status

Each function gets one status, stored in `.openarc/decompile.json`:

| Status | Meaning |
|---|---|
| `tested` | `--run-tests` ran every test file that uses it, and they passed |
| `failing` | one of those files fails. Its recorded examples describe behaviour the project's own tests reject |
| `examples` | it has recorded examples and no test run |
| `described` | an intent and nothing to check it with |
| `bare` | a signature only. `why` says what stopped it, for example `every input throws: document is not defined` for code that needs a browser |

`--run-tests` runs the mapped files with `node --test`, or with the command you give (`--run-tests="npx vitest run"`). This is the project's own test run and is not sandboxed. Without the flag, the test files are listed and not run.

`--report` prints the counts per module from the last run. `--todo` lists the functions that have no intent yet, as `<arc file>: <name>`, for a person or a coding agent to fill in.

## Resuming

A module whose source and test mapping are unchanged is not run again, and the state file is written after every module, so an interrupted run continues where it stopped. `--fresh` runs everything again.

## Limits
- Only exported functions. Methods and classes are skipped.
- An untyped JavaScript function that no test or other code calls with literals gets no examples.
- Results longer than 600 characters of JSON are not kept as examples.
- Sync and compile don't read `.arc` files yet. Today they are the output of decompile and a readable map of the code.
