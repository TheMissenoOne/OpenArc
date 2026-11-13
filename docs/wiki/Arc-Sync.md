# Arc Sync

[[Decompile]] reads code into `.arc` files. Arc sync goes the other way: you edit a function's intent, `example` lines or rules in `arc/spec/<module>.arc`, and the change reaches the code. The `.arc` file is the source of truth for the functions it lists. The code stays the developer's: no markers are written, and only the function's body changes.

```
openarc arc status [<module>|<module.fn>] [--json]
openarc arc prompt <module.fn> [--json]
openarc arc accept <module.fn> [--file <path>] [--json]     # body on stdin
openarc arc compile <module.fn>|<module>|--stale [--json]
```

All four take `--out=<dir>` when the `.arc` files are not under `arc/spec`. A function is named `<module>.<fn>`, where the module is the name on the `.arc` file's `module` line (`deep.screen` for `arc/spec/deep/screen.arc`).

## Worked example

`src/calc.js` has `export const double = (n) => n * 2;`, and `openarc decompile` wrote:

```
module calc from "src/calc.js"

fn double(n: Any): Num
  observed (3) => 6
```

The function should now triple. Edit the `.arc` file:

```
fn double(n: Any): Num
  "Triples a number."
  example (3) => 9
  example (0) => 0
  observed (3) => 6
```

Then:

```
$ openarc arc status
calc.double: stale: example (3) => 9: the code returns 6
1 functions: ok 0, stale 1, unrunnable 0, no examples 0

$ openarc arc prompt calc.double        # what to write, for the agent
$ echo 'return n * 4;' | openarc arc accept calc.double
example (3) => 9: the code returns 12   # exit 1, src/calc.js unchanged
$ echo 'return n * 3;' | openarc arc accept calc.double
accepted calc.double
```

`src/calc.js` now reads `export const double = (n) => {\n  return n * 3;\n};`, and nothing else in it changed. `openarc arc status` reports `calc.double: observed (3) changed: was 6, now 9`: the old observation is out of date, and the next `openarc decompile` records it again.

## `arc status`

Runs every function's `example` lines against the code in the sandbox (the machinery behind `decompile --check`) and reports one status per function. It writes nothing.

| Status | Meaning |
|---|---|
| `ok` | every `example` holds |
| `stale` | an `example` fails: the spec moved ahead of the code. Each failing example is printed with what the code returned |
| `unrunnable` | the module cannot run, or the code no longer exports the function. The reason is given |
| `no examples` | the function has no `example` lines, so nothing can be checked |

`observed` lines never make a function stale. When one no longer matches, a `changed` line reports it. The exit code is 1 when a function is stale or the name matches nothing, else 0. `--json` prints `{ ok, summary, fns: [{ id, file, status, failing?: [{ example, got }], why?, changed?: [{ args, was, now }] }] }`.

## `arc prompt`

Prints what a writer needs: the instruction line, the `.arc` signature, the `type` lines it uses, the intent, the `example` lines, the rules, the current code of the function, and the examples that fail now with what the code returned. `--json` prints `{ id, file, signature, outputFormat, system, prompt }`, the shape of `openarc prompt` in [[Host Agent Mode]].

## `arc accept`

Reads a body (statements, no signature; a code fence is dropped) from stdin or `--file`, and replaces the body of the function in its source file. The function is found the way decompile finds exports: `function f`, `const f = <fn>`, `export default <fn>`, `exports.f = <fn>`. An arrow with an expression body gets a block body. The new body is indented one step past the line the function starts on. Everything outside the body stays byte for byte.

Then it checks, without writing anything yet:

1. The file still parses, and for a TypeScript file the type check adds no error to it (the program decompile builds: the project's `tsconfig.json`, or its defaults).
2. Every `example` line holds in the sandbox, `after (...)` and `throws` included.

When both pass, the file and the function's entry in `.openarc/decompile.json` are written in one transaction. The entry becomes `specified`, as decompile records a function whose examples all hold. On a failure the file is not touched, the problems are printed one per line (`example (3) => 9: the code returns 12`, `TS2322 line 5: ...`), and the exit code is 1. No model is called.

It refuses, on stderr with exit 1:

- a function that is in no `.arc` file;
- a function with no `example` lines: nothing would verify the body. Promote an `observed` line (change the word to `example`) or write an example;
- a body that repeats the signature, or that changes code outside the body (unbalanced braces);
- a body with `import` lines: add the import to the file first.

## `arc compile`

The same loop with the configured model writing the body: the prompt from `arc prompt`, a request to the default backend, accept's checks, and on a failure a new request carrying the problems, up to `compilation.maxAttempts` requests in all. It stops at the first accepted body. It works on stale functions only: `--stale` all of them, a module its stale functions, `<module>.<fn>` that one when stale. Prints `compiled <id> (attempt N)` or the problems of the last attempt; exit 1 when one is not compiled.

## Guard

`openarc guard` and its pre-edit hook protect compiler-owned regions only. Decompiled code has no markers, so its functions are the developer's and the guard never blocks an edit to them.

## Limits

- Only the edited file is type checked, and a new error counts only when its message was not already there. A caller elsewhere that a new body breaks is not reported.
- Rules are not evaluated yet.
- A body's lines are re-indented, including the inside of a multi-line template literal.
- A source file at the project root (not in a directory) is not reached.
