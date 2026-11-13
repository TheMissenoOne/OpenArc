# Decompile

`openarc decompile` reads a project's code into `.arc` spec files. It works on TypeScript and plain JavaScript, changes nothing in the code, writes no markers, and calls no model.

```
openarc decompile [dirs...] [--out=<dir>] [--run-tests[=<command>] [--no-record]] [--fresh] [--json]
openarc decompile --report [--json]
openarc decompile --todo [--json]
openarc decompile --check [dirs...] [--out=<dir>] [--json]
```

`dirs` are the source directories (default `src`). Run it from the folder that holds `package.json`. To have Claude Code, Codex or OpenCode do the decompile workflow and fill in intents, run `openarc setup` first: its `openarc-specs` skill teaches the agent the levels and the steps. See [[Setup]]. The project does not need to install `open-arc`: without it, the sandbox runs the example runner of the `openarc` you called (not on the `container` isolation tier).

## What it recovers

For every exported function:

| Part | Where it comes from |
|---|---|
| Signature and types | the TypeScript checker. In JavaScript that means inference and JSDoc: an untyped parameter is `Any` |
| Intent | the function's JSDoc, or the `//` lines directly above it |
| Observations | running the function in the sandbox. Inputs come from the arguments the tests passed (with `--run-tests`, see [Recorded arguments](#recorded-arguments)), from literal calls found in the project (tests first, also through a `const` bound to a literal) and from the parameter types. Each input runs twice, and one whose results or changed arguments differ is dropped |
| Tests | the test files that use the function, found by their imports |

Exported type aliases and interfaces become `type` lines. Classes and generic functions are skipped and counted.

## Observations and examples

Decompile records what the code does today, bugs included. So an `.arc` file has two kinds of call line:

- `observed (args) => value`: behaviour recorded from the code. It has no authority: it says what the code did, not what it should do. Decompile writes only these.
- `example (args) => value`: a requirement, written or confirmed by a person (or by an agent on their behalf).

To promote an observation, change the word `observed` to `example`. From then on decompile never rewrites or drops that line. It checks it against the code on every run that executes the module, and the function is `failing` when the code does not satisfy it.

The state file records where each observation's input came from (`origins`, keyed by the JSON of the arguments): `call <file>:<line>` for a literal call in the project, `recorded <test file>` for arguments recorded while that test file ran, `types` for an input derived from the parameter types, `kept` for one taken from an existing `observed` line whose origin is unknown. The `.arc` file does not carry it.

## The `.arc` file

One file per module, under `arc/spec/` by default (`--out=<dir>` changes it), mirroring the source tree. The levels above it live next to that folder: see [[Levels]].

```
module survival from "src/survival.js"

fn drain(stats: Any, effort?: Num): { water: Num }
  "Drains water by effort. Never leaves 0..100."
  example ({water: 50}) => {water: 40}
  observed ({water: 5}, 2) => {water: 0}

fn label(rain: Any): "heavy rain" | "clear"
  observed (0.9) => "heavy rain"
  observed (0) => "clear"
  rule known: result in ["heavy rain", "clear"]
```

| Line | Meaning |
|---|---|
| `module <name> from "<file>"` | one per file. Indented strings under it are the module's intent |
| `type Name = <type>` | a named type |
| `fn name(p: T, q?: T, ...r: [T]): R` | a function. `async fn` when it returns a promise |
| `"text"` | one line of intent |
| `example (args) => value # name` | a requirement: the call returns the value. Values are JSON; object keys need no quotes |
| `example (args) => value after (args) # name` | the call changes its arguments: they are as listed after it. A function that returns nothing shows `=> "$undefined" after (...)` |
| `example (args) throws "text"` | the call throws, and the message contains the text |
| `observed ...` | the same forms, recorded from the code: what it did, not what it should do |
| `rule name: <predicate>` | kept and printed. Rules are not evaluated yet |
| `hold` | reserved for sync |

Types: `Int`, `Float`, `Num`, `Bool`, `Str`, `Any`, `Void`, `Null`, `[T]`, `{ k: T, k?: T }`, `A | B`, `T?`, literals, names of `type` lines, and a backticked native type such as `` `Map<string, number>` `` for anything else.

What you write in an `.arc` file stays. A later run keeps a function's intent, rules and `example` lines, re-records its `observed` lines, and puts the lines in this order: intent, `hold`, `example`, `observed`, rules.

## Status

Each function gets one status, stored in `.openarc/decompile.json`:

| Status | Meaning |
|---|---|
| `failing` | a test file that uses it fails, or one of its `example` lines does not hold. `why` names the first: `example (3) => 6: the code returns 4` |
| `tested` | `--run-tests` ran every test file that uses it, and they passed |
| `specified` | it has `example` lines and the code satisfies all of them |
| `observed` | it has only observations |
| `described` | an intent and nothing to check it with |
| `bare` | a signature only. `why` says what stopped it, for example `every input throws: document is not defined` for code that needs a browser |

When several apply, the first in the table wins. A state file from an older version that says `examples` is read as `observed`.

`--run-tests` runs the mapped files with `node --test`, or with the command you give (`--run-tests="npx vitest run"`). This is the project's own test run and is not sandboxed. Without the flag, the test files are listed and not run.

## Recorded arguments

With `--run-tests`, decompile also records the arguments each exported function receives while its test files run, and uses them as inputs. This is the third source of inputs, and the one that reaches code the other two miss: an untyped JavaScript function that the tests call only with values built at run time. Only the inputs come from the test run. The results still come from running each input twice in the sandbox, so nothing a test process reports is taken as a result.

How it works: decompile writes a copy of each source file with one added call at the start of each exported function's body, on the same line, so line numbers do not change. The copies go under `.openarc/recorded/`, and the project's files are not modified. Each test process gets `--import` of OpenArc's recorder added to `NODE_OPTIONS`. The recorder makes Node load the copies in place of the originals, and writes what it saw when the process exits. `.openarc/recorded/` is removed at the end of the run.

- Per function, recorded inputs come first, then literal calls, then the types. Up to 6 recorded argument lists are used.
- An argument list is kept only when it is plain JSON (no functions, class instances, `Map`, `Set`, cycles, or `undefined` before the last argument) and at most 600 characters long. Arguments are copied when the call starts, so a function that changes its argument records the value it was called with.
- Reliability: a test file that fails with the recorder installed runs once more without it, and that second run decides `tested` or `failing`. When the two runs disagree, decompile prints `<test file>: recording changed the outcome of this test file; ...` and uses nothing recorded from that file.
- `--no-record` turns recording off. Without `--run-tests` nothing is recorded, and `--check` never records. Switching it on or off does not re-run unchanged modules: add `--fresh` for that.

Limits:

- It sees only code that Node's own module loader loads through `import`: ESM sources, TypeScript sources Node type-strips, and CommonJS sources that are imported. Tested on Node 22, 23 and 25. A `require()` from a CommonJS test file is not recorded (on Node 25 a `require()` inside an imported CommonJS module is). Test runners that transform sources themselves, such as Vitest and Jest, record nothing. The run still works; pass `--no-record` to skip the overhead.
- Only arguments are recorded, never results or other state.
- An arrow function with a destructured or rest parameter is not recorded. A generator's arguments are recorded at its first `next()`.
- Recorded argument values end up in `.arc` files as `observed` lines. If tests pass secrets (keys, tokens, passwords) as arguments, run with `--no-record`.

`--report` prints the counts per module from the last run. `--todo` lists the functions that have no intent yet, as `<arc file>: <name>`, for a person or a coding agent to fill in.

## Checking for changed behaviour

After a refactor or a regeneration, `openarc decompile --check` asks: did behaviour change? It runs the arguments of every `observed` and `example` line in the `.arc` files under `--out` against the current code. It writes nothing, neither `.arc` files nor the state file, and does not read the state file, so it works on a fresh clone that has only the `.arc` files.

| Result | Meaning |
|---|---|
| `preserved` | same result and same changed arguments as the line says |
| `changed` | an `observed` line whose result differs. An unexplained difference: printed with the old and the new value |
| `failing` | an `example` line the code does not satisfy |
| `unrunnable` | the module cannot run now. The reason is given once per function |
| `removed` | the `.arc` file has a function the code no longer exports |
| `new` | the code exports a function the `.arc` file lacks |

It prints one line per finding that is not `preserved`, then `checked N functions: preserved P, changed C, failing F, unrunnable U, removed R, new W`. With `--json`: `{ ok, summary, items: [{ file, fn, kind, args?, was?, now?, why? }] }`. The exit code is 0 when nothing changed, failed or was removed, else 1. `unrunnable` and `new` alone do not fail.

To accept a `changed` observation, run `openarc decompile` (it re-records the line) or edit or promote the line. A pass shows that the code agrees on these inputs only: finitely many inputs do not prove two versions equal.

## Resuming

A module whose source and test mapping are unchanged is not run again, and the state file is written after every module, so an interrupted run continues where it stopped. `--fresh` runs everything again.

A run that executes a module checks every `example` line and re-records the `observed` ones: on the arguments of the existing observed lines plus the inputs derived now. Each observation whose result differs from the line that was in the file prints `<file>: <fn>(<args>) changed: was <old>, now <new>`, and the summary counts them. A reused module runs nothing and keeps its status.

## Limits
- Only exported functions. Methods and classes are skipped.
- An untyped JavaScript function that no test or other code calls with literals gets no observations, unless `--run-tests` records its arguments from the tests.
- Results longer than 600 characters of JSON are not kept as observations.
- An `.arc` file written before `observed` existed has recorded lines as `example`: they now count as requirements.
- Sync and compile don't read `.arc` files yet. Today they are the output of decompile and a readable map of the code.
