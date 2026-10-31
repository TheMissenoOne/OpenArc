# OpenArc

[![npm](https://img.shields.io/npm/v/open-arc)](https://www.npmjs.com/package/open-arc)

**Compile typed specs into verified TypeScript with small local models.**

You write the contract: a function type, an intent and examples. OpenArc gives a local model only the context that one function needs, the way a unit test isolates code. It verifies the returned body with tsc, static rules (including an optional `calls` allowlist of the functions it may call) and your examples in a sandbox, where a block only counts as verified if an example actually runs it. Only then does it splice the body in. Hand edits are never overwritten, and the model can't touch anything outside its own region.

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
| `docs/wiki/` | wiki pages |

## Develop

```bash
cd stage0 && npm i && npx tsc -p . && node tools/run-examples.ts --strict   # 24/24 regions
for f in tests/*.check.ts; do node $f; done                                   # no model, no network
node tools/build.ts && (cd build && npm pack)                                # openarc-x.y.z.tgz
cd ../selfhost && npm i && npx openarc compile --keep-going                  # OpenArc compiling OpenArc
```

Requires Linux with `bwrap` and `prlimit`, Node ≥ 23.6, and a model: local via [Ollama](https://ollama.com), or any API (OpenAI-compatible such as OpenAI, OpenRouter, Groq and vLLM, or Anthropic). Keys are read from environment variables named in `openarc.config.json`; see [Configuration](docs/wiki/Configuration.md).

## License

[MIT](LICENSE)
