# OpenArc

[![npm](https://img.shields.io/npm/v/open-arc)](https://www.npmjs.com/package/open-arc)

**Compile typed specs into verified TypeScript with small local models.**

You write the contract: a function type, examples, and as much structure as you know (prose, a sketch with typed holes, a concept's laws, a TSX component outline). OpenArc gives a local model only the context that one function needs, the way a unit test isolates code. It verifies the returned body with tsc, static rules (including an optional `calls` allowlist of the functions it may call) and your examples in a sandbox, where a block only counts as verified if an example actually runs it. Only then does it splice the body in. Hand edits are never overwritten, and the model can't touch anything outside its own region.

```ts
import * as arc from "open-arc";

type NormalizeTitle = (title: string) => string;

export const normalizeTitleSpec = arc.defineRegion<NormalizeTitle>({
  id: "tasks.normalizeTitle",
  intent: "Trim, collapse internal whitespace to one space, capitalize the first letter.",
  examples: [
    { args: ["  buy   milk "], expected: "Buy milk" },
    { args: ["   "], expected: "" },
  ],
});
```

What you can write instead of prose (since 0.8.0):

- **Sketches:** the body as typed TypeScript with `arc.hole<T>("…")` gaps. The model fills only the holes; the compiler checks the rest is unchanged (`OARC-E099`), that every hole is reached by an example, and stops early when an example contradicts the sketch itself.
- **Concepts:** `arc.defineConcept({ id, intent, laws })` and variants that name it. Laws are example templates every variant must pass, with its own fixtures.
- **TSX UI specs:** `ui: (props) => <Form …><Field …/><Submit>…</Submit></Form>` in a `*.spec.tsx` file. The React component is checked in a real DOM inside the sandbox: structure, accessible names, wiring and interaction scripts.
- **The palette:** reusable concepts that ship with OpenArc: authentication (password, API key, magic link), a load balancer (round-robin, least-connections, weighted, consistent-hash, health checks, failover), a p2p protocol (framing, handshake, gossip over a fake network) and a login page. Import them (`open-arc/palette/auth`) or copy them into your project. See [Palette](docs/wiki/Palette.md).

Install from npm: [`open-arc`](https://www.npmjs.com/package/open-arc) (the command is `openarc`).

```bash
npm i -D open-arc && npx openarc init
npx openarc scaffold && npx openarc compile
npx openarc watch    # or keep it running: recompiles regions as you save, one at a time
```

**Documentation:** [Wiki](https://github.com/TheMissenoOne/OpenArc/wiki) (source in [`docs/wiki/`](docs/wiki)) · [Specification](SPEC-phase0.md)

## Repository layout

| Path | What |
|---|---|
| `SPEC-phase0.md` | normative specification (v0.3) |
| `selfhost/` | **OpenArc written as an OpenArc project.** It's the source of truth; regions are compiled by OpenArc itself |
| `stage0/` | the bootstrap compiler: `selfhost/` with every region written by hand; builds the `open-arc` npm package |
| `examples/demo/` | the smallest real project |
| `examples/palette-demo/` | the palette in use: a login flow, a load-balanced service, a 3-peer gossip network |
| `docs/wiki/` | wiki pages |

## Develop

```bash
cd stage0 && npm i && npx tsc -p . && node tools/run-examples.ts --strict   # 43/43 regions (24 compiler + 19 palette)
(cd tests/fixtures/ui && npm i)                                              # optional: jsdom + react, so ui.check runs the DOM
for f in tests/*.check.ts; do node $f; done                                   # no model; sandbox.check runs the real sandbox
node tools/build.ts && (cd build && npm pack)                                # openarc-x.y.z.tgz
cd ../selfhost && npm i && npx openarc compile --keep-going                  # OpenArc compiling OpenArc
```

## Requirements

Linux, macOS or Windows, Node ≥ 23.6 (25+ recommended), and a model: local via [Ollama](https://ollama.com), or any API (OpenAI-compatible such as OpenAI, OpenRouter, Groq and vLLM, or Anthropic). Keys are read from environment variables named in `openarc.config.json`; see [Configuration](docs/wiki/Configuration.md).

Examples always run sandboxed; how strongly depends on the OS (`sandbox.isolation`, default `"auto"`):

| OS | Sandbox | Isolation |
|---|---|---|
| Linux with `bwrap` and `prlimit` | `bwrap` | strongest: namespaces (no network, read-only stage, no host processes), CPU and memory limits, Node's permission model |
| macOS | `sandbox-exec` | OS profile (no network, no writes, no reads in your home outside the project and Node) plus Node's permission model |
| Windows, or Linux without a usable `bwrap` | `node` | Node's permission model only, with warning `OARC-W046`: no writes, child processes, workers or addons; network blocked only on Node 25+ |
| any, opt-in | `container` | `podman`/`docker --network=none`, read-only mount |

`npx openarc doctor` shows the tier this machine uses and proves it with one sandboxed example. Running without a sandbox takes an explicit `"isolation": "unsafe-none"`. See [Safety Model](docs/wiki/Safety-Model.md).

## License

[MIT](LICENSE)
