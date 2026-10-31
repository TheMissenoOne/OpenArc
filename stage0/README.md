# OpenArc

[npm: open-arc](https://www.npmjs.com/package/open-arc) · [GitHub](https://github.com/TheMissenoOne/OpenArc) · [Wiki](https://github.com/TheMissenoOne/OpenArc/wiki)

**Compile TypeScript with holes into verified TypeScript, using small local models.**

You write ordinary TypeScript: interfaces, classes, the members you know how to write, and tests. Where you want the compiler to write a body, you leave `return arc.todo();`. OpenArc gives a model only the context that one body needs (the class shell, the types it reaches, the tests that exercise it), then verifies the returned body with tsc, static rules and your tests in a sandbox. Only then does it write the body in. Hand edits are never overwritten, and the model can't touch anything outside the body.

```ts
// src/lb/balancer.ts
import * as arc from "open-arc";

export interface Backend { id: string; healthy: boolean }

/** Routes requests to backends. */
export interface Balancer {
  /** The backend id for one request, or null when no backend is healthy. */
  pick(key: string): string | null;
}

export class RoundRobin implements Balancer {
  readonly backends: Backend[];
  next = 0;
  constructor(backends: Backend[]) {
    this.backends = backends;
  }
  /** The next healthy backend in list order, wrapping around. Keys are ignored. */
  pick(key: string): string | null {
    return arc.todo(); // region lb.balancer.roundRobin.pick: the compiler writes this body
  }
}
```

```ts
// tests/balancer.test.ts
import * as arc from "open-arc";
import { RoundRobin } from "../src/lb/balancer.ts";

arc.test(RoundRobin, "rotates and skips unhealthy backends", (RR, expect) => {
  const rr = new RR([{ id: "a", healthy: true }, { id: "b", healthy: false }, { id: "c", healthy: true }]);
  expect(["1", "2", "3"].map((k) => rr.pick(k))).toEqual(["a", "c", "a"]);
  expect(new RR([]).pick("k")).toBe(null);
});
```

The signature is the contract, the JSDoc is the intent, and the test is TypeScript that tsc checks against the real class. Members of one class are verified together, `arc.test.hidden` keeps a test out of the model's sight, and `arc.law` checks a property on seeded random inputs.

```bash
npm i -D open-arc && npm pkg set type=module
npx openarc init --example   # config, tsconfig, .openarc/, and a code-first starter (src/hello.ts + its test)
npx tsc -p .                 # your code and tests type-check as written, pending bodies included
npx openarc compile          # or keep it running: npx openarc watch
```

**Documentation:** [Wiki](https://github.com/TheMissenoOne/OpenArc/wiki) · [Specification](https://github.com/TheMissenoOne/OpenArc/blob/main/SPEC-phase0.md) · [Code-first example](https://github.com/TheMissenoOne/OpenArc/blob/main/examples/code-first-demo)

## Features

| Feature | What it does | Docs |
|---|---|---|
| **Code-first specs** | A pending body (`return arc.todo()`) in a function, method, getter or arrow is a region; tests are `arc.test`, `arc.test.hidden`, `arc.law` | [Code First](https://github.com/TheMissenoOne/OpenArc/wiki/Code-First) |
| `defineRegion` and blocks | A function type plus intent and JSON examples; block regions inside a hand-written function | [Writing Specs](https://github.com/TheMissenoOne/OpenArc/wiki/Writing-Specs#more-ways-to-write-regions) |
| Sketches | The body as typed code with `arc.hole<T>("…")` gaps; only the holes are generated | [Writing Specs](https://github.com/TheMissenoOne/OpenArc/wiki/Writing-Specs#sketches-structure-as-code) |
| Concepts | One contract with laws, many variants that must pass them | [Writing Specs](https://github.com/TheMissenoOne/OpenArc/wiki/Writing-Specs#concepts-one-contract-many-variants) |
| TSX UI specs | A component's rough structure in TSX, checked in a real DOM inside the sandbox | [Writing Specs](https://github.com/TheMissenoOne/OpenArc/wiki/Writing-Specs#ui-specs-tsx-structure) |
| **Your own palette** | Concepts with laws, sketches, code-first classes: reusable building blocks you write, in your project or your own package | [Your own palette](https://github.com/TheMissenoOne/OpenArc/wiki/Palette) |
| Watch mode | `openarc watch` recompiles regions as you save, one at a time | [Watch Mode](https://github.com/TheMissenoOne/OpenArc/wiki/Watch-Mode) |
| `extract` | Adopt functions you already have as regions (bodies kept); code-first by default, `--style region` for specs | [Adopting Existing Code](https://github.com/TheMissenoOne/OpenArc/wiki/Adopting-Existing-Code) |
| `migrate` | Turn one `defineRegion` region into code-first form, keeping its id, ownership and provenance | [Code First](https://github.com/TheMissenoOne/OpenArc/wiki/Code-First#migrating-a-defineregion-region) |
| `check --oracle` | Compare a compiled region with a reference implementation on seeded inputs | [CLI Reference](https://github.com/TheMissenoOne/OpenArc/wiki/CLI-Reference) |
| `doctor` | Show the sandbox tier on this machine and prove it with one sandboxed example | [Safety Model](https://github.com/TheMissenoOne/OpenArc/wiki/Safety-Model) |
| Providers | Ollama by default; `init --backend openrouter\|openai\|anthropic\|local`; `backends test` sends one request | [Configuration](https://github.com/TheMissenoOne/OpenArc/wiki/Configuration) |
| Output formats | `outputFormat: "json"` (a JSON body) or `"code"` (a fenced code block) per backend or region | [Configuration](https://github.com/TheMissenoOne/OpenArc/wiki/Configuration) |
| Throws examples, token accounting | `{ throws: "message" }` examples; prompt and completion tokens per region in the manifest | [Writing Specs](https://github.com/TheMissenoOne/OpenArc/wiki/Writing-Specs#examples-that-throw) |

**Deprecated:** the bundled palette (`open-arc/palette/*`, `examples/palette-demo`) and the built-in `open-arc/ui` vocabulary (`Form`, `Field`, `ErrorText`, `Submit`) are frozen since 0.9.0: they keep working unchanged, and the mechanisms they use stay supported.

**Safety, enforced in code rather than in the prompt:** the model returns a body and never writes files; everything outside the body must stay byte-identical (`OARC-E097`); a `calls` allowlist limits what a body may call (`OARC-E098`); a body counts as verified only if a passing test or example actually runs it (`OARC-W045`); tests and examples run in a sandbox whose strength depends on the OS (below). See [Safety Model](https://github.com/TheMissenoOne/OpenArc/wiki/Safety-Model).

## More ways to write regions

Code-first is the main way, and every earlier form stays fully supported. They mix freely, also in one file.

| Form | Looks like | When |
|---|---|---|
| `defineRegion` | `arc.defineRegion<F>({ id, intent, examples })` and `export const f: F` between markers | you think in contracts and JSON examples, or the function type exists already |
| Blocks | `arc.defineBlock({ id, intent })` around statements of a hand-written function | you want to write the control flow and leave steps to the model |
| Sketches | `defineRegion({ sketch: (a) => { … arc.hole<T>("…") … } })` | you know the structure, not every expression |
| Concepts | `defineConcept({ id, laws })` and variants with `concept:` | several implementations of one contract |
| UI specs | `ui: (props) => <Form …/>` in a `*.spec.tsx` | React components checked in a DOM |
| Customization | `@arc calls ...` JSDoc tags, `arc.configure(fn, { examples })`, a `defineRegion` with a code-first region's id | extra settings for a code-first region |

## Status

| | |
|---|---|
| Release | [`open-arc` on npm](https://www.npmjs.com/package/open-arc): 0.7.1 published; 0.8.0 (palette) and 0.9.0 (code-first) are in review |
| CI | Linux (bwrap), macOS (sandbox-exec), Windows (Node permission model) on Node 25, plus Linux on Node 23 |
| Benchmark | The untuned pilot solved 0/5 tasks with OpenArc against 2/5 for a plain prompt. A rerun on a tuned backend is in progress: preliminary results are about 2/8 against 3/8, and the code output format didn't help. OpenArc doesn't beat a plain prompt yet. See draft PR [#5](https://github.com/TheMissenoOne/OpenArc/pull/5) and issue [#10](https://github.com/TheMissenoOne/OpenArc/issues/10) |
| Self-hosting | Part of OpenArc is compiled by OpenArc (`selfhost/`); finishing it is issue [#14](https://github.com/TheMissenoOne/OpenArc/issues/14) |

Alpha: the compiler's guarantees (write scope, sandbox, ownership) are tested on every commit; how often small models produce a passing body is what the benchmark is measuring.

## Roadmap

- [#13](https://github.com/TheMissenoOne/OpenArc/issues/13) Code-first specs: phases 1 and 2 are in 0.9.0; next are laws over every implementation of an interface, in-place sketches, and atomic-design TSX
- [#10](https://github.com/TheMissenoOne/OpenArc/issues/10) Benchmark rerun on a tuned backend: JSON vs code output vs plain prompt
- [#11](https://github.com/TheMissenoOne/OpenArc/issues/11) Local LLM setup: the best engine and model for a given machine
- [#14](https://github.com/TheMissenoOne/OpenArc/issues/14) Self-hosting: stage 1 and stage 2
- [#15](https://github.com/TheMissenoOne/OpenArc/issues/15) Known limitations from the benchmark and reviews
- [#7](https://github.com/TheMissenoOne/OpenArc/issues/7) VS Code extension
- [#12](https://github.com/TheMissenoOne/OpenArc/issues/12) Palette (done in 0.8.0; the bundled palette is deprecated and frozen since 0.9.0)


## Requirements

Linux, macOS or Windows, Node 23.6 or later (25+ recommended), and a model: local via [Ollama](https://ollama.com), or any API (OpenAI-compatible such as OpenAI, OpenRouter, Groq and vLLM, or Anthropic). Keys are read from environment variables named in `openarc.config.json`; see [Configuration](https://github.com/TheMissenoOne/OpenArc/wiki/Configuration).

Tests and examples always run sandboxed; how strongly depends on the OS (`sandbox.isolation`, default `"auto"`):

| OS | Sandbox | Isolation |
|---|---|---|
| Linux with `bwrap` and `prlimit` | `bwrap` | strongest: namespaces (no network, read-only stage, no host processes), CPU and memory limits, Node's permission model |
| macOS | `sandbox-exec` | OS profile (no network, no writes, no reads in your home outside the project and Node) plus Node's permission model |
| Windows, or Linux without a usable `bwrap` | `node` | Node's permission model only, with warning `OARC-W046`: no writes, child processes, workers or addons; network blocked only on Node 25+ |
| any, opt-in | `container` | `podman`/`docker --network=none`, read-only mount |

`npx openarc doctor` shows the tier this machine uses and proves it with one sandboxed example. Running without a sandbox takes an explicit `"isolation": "unsafe-none"`.

## License

[MIT](https://github.com/TheMissenoOne/OpenArc/blob/main/LICENSE)

The command is `openarc`; development, the benchmark and the self-hosted tree live in the [GitHub repository](https://github.com/TheMissenoOne/OpenArc).
