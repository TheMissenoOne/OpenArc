# Languages

The `.arc` language is the same for every language: one module per source file, `type` lines, functions with intent,
`example`, `observed` and `rule` lines. What differs is how a language's code is read, run and edited. That lives behind
one small seam, `stage0/src/lang/lang.ts`, with one implementation per language, picked per file by its extension. A
folder can hold several languages: `openarc decompile src svc` reads a JavaScript `src/` and a Go module in `svc/` in one
run.

| | TypeScript, JavaScript | Go |
|---|---|---|
| Files | `.ts .tsx .mts .cts .js .jsx .mjs .cjs` (not `.d.ts`) | `.go`, per module (the nearest `go.mod` above the file) |
| Tests | `tests/`, `test/`, `__tests__/`, `*.test.*`, `*.spec.*` | `*_test.go` |
| `openarc decompile` | yes | yes |
| `decompile --check`, `rule` lines | yes | yes |
| `--run-tests` | each mapped test file with `node --test` (or your command) | `go test -json ./...` once per module; `--run-tests=<cmd>` is ignored |
| Recorded arguments (`--run-tests`) | yes | no |
| `openarc arc status`, `prompt`, `accept`, `compile` | yes | yes |
| `openarc arch` | imports from the TypeScript scanner | packages from directories, dependencies from imports, third parties from `go.mod` requires |
| `openarc status`, MCP tools | yes | yes: they read the same state and `.arc` files |
| Legacy specs (`openarc compile`, `sync`, markers) | yes | no |

## Go

Needs a Go toolchain: `OPENARC_GO` (the `go` binary), else `go` on `PATH`. Without one, every Go path stops with
`openarc: Go code needs the Go toolchain: set OPENARC_GO to the go binary ... or put go on PATH`. Projects without
`.go` files never look for it.

On first use a small helper (`lang-go/arcgo`, standard library only: `go/parser`, `go/types`) is built into
`.openarc/go/`. It reads each package with the type checker and reports exported functions and methods of exported
types, exported struct types, doc comments, imports, literal calls, composite literals of the method types, and which
`_test.go` files name which functions.

### What it recovers

| Part | Where it comes from |
|---|---|
| Signature and types | `go/types`, mapped as below |
| Intent | the doc comment, at most 6 lines |
| Observations | the function run in the sandbox on inputs from literal calls (tests first) and from the parameter types |
| Tests | the `_test.go` files that use the function (in-package and `<pkg>_test` tests) |

A method is `fn Type.Method(...)`, an instance method like a class method in TypeScript. Its receiver is written
`new (<value>)`: the receiver decoded from that JSON value, the same as a composite literal `Type{...}` with those
fields. `new ()` is the zero value, `new(Type)`. Receivers come from the composite literals of the type the project
writes with literal fields (`Counter{N: 5}` gives `new ({n: 5})`), then the zero value. A `NewType(...)` function is
not read as a constructor: it is a function of its own, with its own observations.

Generic functions and methods are listed under `skipped` (type parameters are not run yet).

### Type mapping

| Go | `.arc` |
|---|---|
| `int`, `int8` ... `int64`, `uint` ... `uint64`, `uintptr`, `rune`, `byte` | `Int` |
| `float32`, `float64` | `Float` |
| `string` | `Str` |
| `bool` | `Bool` |
| `[]T`, `[N]T` | `[T]` |
| `[]byte` | `` `[]byte` `` (encoding/json writes it as a base64 string) |
| `*T` | `T?` (`null` is a nil pointer) |
| an exported struct of the package | its name, with a `type` line: a record of its JSON field names (`json` tags respected, `omitempty` and `omitzero` as `name?`, unexported, embedded and `json:"-"` fields left out) |
| a named type over one of the above (`type Celsius float64`) | the mapping of what it is built on |
| `any`, `interface{}` | `Any` |
| a type with its own JSON form (`MarshalJSON`, `MarshalText`, `time.Time`) | backticked native type |
| `map[K]V`, other interfaces, functions, channels, structs of other packages or unexported ones | backticked native type, `` `map[string]int` `` |

Results: none is `Void` (observed as `"$undefined"`, like a JavaScript function that returns nothing); one is its type;
several are an array of them (`(int, int)` is `[Int]`, `(string, int)` is `[Str | Int]`). A last `error` result is a
throw: `(T, error)` is `T`, and a non-nil error is `throws "<its message>"`. A panic is also `throws`, with the panic
value as the message. A variadic parameter is a rest parameter: `...xs: [Int]`, each trailing argument one element.

### Running

Nothing runs in the source tree. For each module the sandbox stages a copy (go.mod, go.sum and every non-test `.go`
file, under `.openarc/sandbox/`), writes a generated in-package test file there (`lang-go/harness.go`, so `package main`
and unexported helpers work), and runs `go test -run ^TestOpenarcRun$` on it. The harness decodes each input with
`encoding/json` into the real parameter types, calls the function, encodes the result, and encodes the arguments again
after the call, so a change made through a slice, map or pointer shows as `after (...)`. It prints the same JSON lines
as the JavaScript harness. Each call has the same 5 s limit; since a goroutine cannot be stopped, a call that runs over
it ends its process and the remaining inputs run in a fresh one. A process that dies on an input (`os.Exit`, a fatal
runtime error) reports that input as a throw and the rest still run.

Isolation: the bwrap tier, with the same namespaces as for JavaScript (no network, own PID and IPC namespaces), a clean
environment (`GOPROXY=off`, `GOFLAGS=-mod=readonly`, `GOTOOLCHAIN=local`, `CGO_ENABLED=0`), and `prlimit` on every
process (CPU seconds and address space from the sandbox config). The sandbox sees the stage read-only, `/usr`, the Go
root and the module cache read-only, a private `/tmp`, and one writable directory: the project's own build cache,
`.openarc/go-build`, so what runs there never writes the user's cache. The first run in a project fills that cache
(tens of seconds); later runs reuse it. Other tiers: `unsafe-none` runs `go test` unsandboxed when configured by that
name; `node`, `sandbox-exec` and `container` refuse Go code with `OARC-E092`.

### `arc accept`

The helper gives the function's (or method's: `fn Counter.Inc` is `func (c *Counter) Inc` or `func (c Counter) Inc`) body by byte offsets; the new body replaces exactly those bytes, indented with a tab,
and everything outside it stays byte for byte. Then `go build` and `go vet` run on the function's package in a staged
copy of the module holding the new text (they compile, they run nothing), and only errors the new text adds count,
printed as the compiler prints them: `src/calc.go:12:13: undefined: missing`. Then the examples and rules run as for
every language. `arc prompt` names the language (`(Go)`) and shows the current Go function.
Packages that import the edited one are not built: a Go signature is declared, never inferred from the body, so a
new body cannot change what a caller compiles against. (TypeScript infers return types, so its accept also type checks
the files that import the edited one.)

### Limits

- Recording arguments from test runs (`--run-tests`) is not supported: Go inputs come from literal calls and types only.
- `--run-tests` maps by test file, as JavaScript does: a file fails when one of its tests fails, and every test file of
  a package that does not build fails.
- A receiver is built from a composite literal with literal fields or the zero value only; a type whose methods need a
  constructor (`NewT(...)`) to set unexported state gets observations on the zero value, which may say little.
- Embedded struct fields (which encoding/json flattens into the parent) are not in the `type` line.
- NaN and the infinities are kept (`"$NaN"`) only as a float result itself; inside a slice or struct they cannot be
  encoded and the result says so.
- A nil slice result is `null`, as encoding/json writes it.
- Types of third-party packages are read only when their export data is at hand; otherwise they are native types.
- Packages with cgo do not build in the sandbox (`CGO_ENABLED=0`).
- Each function's examples are one `go test` build and run (well under a second each with a warm cache).
- Methods on generic types and generic functions are skipped.

## Adding a language

Implement `Lang` (`stage0/src/lang/lang.ts`) and add it to `LANGS`:

| Member | What it does |
|---|---|
| `code`, `isTest(rel)` | which files are this language's, and which of them are tests |
| `label(file)`, `forms`, `indent` | the language's name in a prompt, the function forms `arc accept` finds (for its refusal), one indent step |
| `read(ctx, sources, tests)` | the source files into modules: per exported function its `ArcFn` (signature in `.arc` types, intent), the inputs its parameter types allow, the test files that use it, its literal calls, and for an instance method how a receiver is built; `type` lines; skipped names with why |
| `open(ctx, texts)` | a runner kept open for a whole run: `observe(file, fn, inputs)` runs the function on each input in the sandbox and reports per input the arguments, the result or `{ throws }`, and the arguments after the call when it changed them |
| `runTest(ctx, file, env)` | runs one test file for `--run-tests`, true when it passes |
| `locate(ctx, file, text, name)` | the function's body in a file's text: its range (braces included), the indent of its first line, and its whole text for a prompt |
| `notBody(file, body, name)` | the reply repeats the declaration instead of being a body |
| `problems(ctx, file, after)` | the syntax and type errors a new text adds to the file |
| `imports(ports, files)` | the imports between files and to packages, for the architecture level |

Everything else (the `.arc` printer and parser, the state file, statuses, `--check`, rules, `arc status`, the
transactional write of an accepted body, levels and status) is shared.
