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

The sandbox depends on the OS. `sandbox.isolation` in `openarc.config.json` picks it; the default `"auto"` takes the strongest one available:

| OS | Default tier (`"auto"`) | What isolates generated code |
|---|---|---|
| Linux | `bwrap` (needs `bwrap` and `prlimit`) | bubblewrap namespaces (no network, read-only stage, private `/tmp`, no host processes), `prlimit` CPU and address-space caps, Node's permission model, heap cap |
| macOS | `sandbox-exec` | a `sandbox-exec` profile (no network, no writes outside the temp dir, no reads under your home except the stage, `node_modules` and Node), Node's permission model, heap cap, wall-clock timeout |
| Windows, or Linux without a usable `bwrap` | `node` (warns `OARC-W046`) | Node's permission model only: reads limited to the stage and `node_modules`; no writes, child processes, workers, addons or (Node 25+) network; heap cap, wall-clock timeout |
| any, opt-in | `container` | `podman`/`docker run --rm --network=none`, the stage mounted read-only, plus Node's permission model |
| any, opt-in | `unsafe-none` | nothing. Printed as an error (`OARC-W047`) on every run |

An explicitly configured tier that isn't available here (`bwrap` on macOS, `container` without podman or docker) is `OARC-E092`, and nothing runs. There is no implicit way to turn the sandbox off: `"none"` is invalid config, and only the spelled-out `"unsafe-none"` does it. `openarc doctor` proves the current tier: one example inside it, plus a file write, a child process and a network request that must all be refused.

Every tier but `unsafe-none` runs the harness under `node --permission` with no `--allow-*` grant except `--allow-fs-read`. Node's permission model denies network access only from Node 25 (`--allow-net` was added in v25.0.0); on Node 23.6 to 24 the `node` tier does not block the network, and `OARC-W046` says so (`[node-<version>:network-not-blocked]`).

The Linux tier, unchanged since 0.3:

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

The other tiers (`src/isolation.ts`) have no `prlimit`: the heap is capped by `--max-old-space-size` and runaway code by the wall-clock timeout (`cpuSeconds` + 20 s), which kills the process (`OARC-E091`). The process has no children to leave behind, because the permission model refuses to start them. In the container tier, `timeout -s KILL` inside the container ends it, since killing the podman/docker client would not.

## 4. Your work is never overwritten

- **Edits:** a region whose body hash differs from the last commit becomes `developer`, and OpenArc never writes to it again.
- **What counts as an edit:** hashes cover parse-tree tokens plus every comment, so a formatter run doesn't count as an edit but a changed comment does.
- **Transactions:** compiles are all-or-nothing, with journal-based crash recovery (`OARC-W094`).
- **Concurrency:** a lock file prevents concurrent runs (`OARC-E095`).
