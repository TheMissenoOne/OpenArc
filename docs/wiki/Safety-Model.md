# Safety Model

Nothing below depends on the model following instructions. Every rule is enforced by the compiler.

## 1. The model never writes files

It returns `{"body": string, "imports": [...]}` as data, constrained by a JSON schema (Ollama structured output). The compiler is the only writer.

## 2. Write scope: a body lands only in its own region

| Check | Rejects |
|---|---|
| **Containment:** the body must parse, with no syntax errors, as exactly one statement inside `async function __region() { … }` | `}; export const fooSpec = …; function q() {` (escaping the braces) |
| **No markers:** a marker-shaped line, or a comment still mentioning `@openarc:`, is rejected. A comment that merely mentions the prefix (`// matches @openarc: markers`) is stripped first, and the strip is logged | forging `// @openarc:end` to move region boundaries |
| **Splice:** outside the region, the file must be byte-identical, except for added `import {…} from "<dep>"` lines | any edit to other code |
| **Spec integrity:** at commit, only `src/` files may change, and every `defineRegion`/`defineBlock` statement must be byte-identical | weakening a spec or an example |
| **Static examples:** the harness receives examples from the compiler's parse of the spec, not from the module at runtime | a body that does `fooSpec.examples.length = 0` when called |

All violations are `OARC-E097`. A spec's `calls` list adds one more structural check: the body may call only the listed imported or port functions (`OARC-E098`, see [[Writing Specs]]). The guards are tested in `selfhost/tests/write-scope.check.ts`, the call allowlist and the coverage probe in `selfhost/tests/v063.check.ts`.

## 3. Generated code runs only in a sandbox

```
bwrap --unshare-all …            no network, read-only project, private /tmp, no host processes
prlimit --as=32G --cpu=20        CPU and address-space backstop
node --permission                no fs writes, child processes, workers, addons
     --allow-fs-read=/work
     --max-old-space-size=512    heap cap
```

Measured on the target machine:
- network → `ENETUNREACH`
- file write → `ERR_ACCESS_DENIED`
- `process.exit()` → detected, because the harness's final `{"done": n}` line is missing

`--as` has to be at least 16 GiB, because Node's type stripper reserves about 10 GiB of WebAssembly address space. That's virtual memory, not RAM.

## 4. Your work is never overwritten

- **Edits:** a region whose body hash differs from the last commit becomes `developer`, and OpenArc never writes to it again.
- **What counts as an edit:** hashes cover parse-tree tokens plus every comment, so a formatter run doesn't count as an edit but a changed comment does.
- **Transactions:** compiles are all-or-nothing, with journal-based crash recovery (`OARC-W094`).
- **Concurrency:** a lock file prevents concurrent runs (`OARC-E095`).
