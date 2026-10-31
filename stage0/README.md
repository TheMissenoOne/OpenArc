# OpenArc

[npm: open-arc](https://www.npmjs.com/package/open-arc) · [GitHub](https://github.com/TheMissenoOne/OpenArc) · [Wiki](https://github.com/TheMissenoOne/OpenArc/wiki)

Compile typed specs into verified TypeScript with **small local models**.

You write the contract: a function type, an intent and examples. OpenArc builds a minimal context package for that one function, the way a unit test isolates code. It asks a local model for the body, then verifies the result:
- type-checking (tsc),
- static rules,
- your examples, run in a sandbox.

Only then does it splice the body in. Your hand edits are never overwritten.

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

// @openarc:begin tasks.normalizeTitle
export const normalizeTitle: NormalizeTitle = (title) => {
  return title.trim().replace(/\s+/g, " ").charAt(0).toUpperCase() + title.trim().replace(/\s+/g, " ").slice(1);
};
// @openarc:end tasks.normalizeTitle
```

## Requirements

- Linux, macOS or Windows. Examples always run sandboxed; the strength depends on the OS: `bwrap` on Linux (namespaces, no network, read-only stage, resource limits; install bubblewrap), `sandbox-exec` on macOS, and Node's permission model alone on Windows (warning `OARC-W046`). `npx openarc doctor` shows and tests the sandbox on your machine. OpenArc never runs examples unsandboxed unless you configure `"isolation": "unsafe-none"`.
- Node ≥ 23.6, which runs `.ts` directly; Node 25+ recommended (the Node-only sandbox blocks network access from Node 25).
- [Ollama](https://ollama.com) with a model, e.g. `ollama pull qwen3.5:9b`.

## Use

```bash
npm i -D open-arc
npx openarc init          # openarc.config.json, tsconfig.json, .openarc/
# write defineRegion specs in src/*.ts
npx openarc scaffold      # adds markers + typed placeholders (deterministic, no model)
npx openarc compile       # generates, verifies and commits every pending/stale region
npx openarc graph         # region tree with ownership states
npx openarc watch         # nodemon-style: recompiles regions as you edit specs (one at a time)
npx openarc extract src/x.ts   # adopt existing functions as regions (bodies kept as-is)
```

| Command | Effect |
|---|---|
| `compile [ids…]` | one transaction: nothing is written unless every target passes |
| `freeze <id>` | keep the current body, never regenerate |
| `release <id>` | hand an edited region back to the compiler (the body is backed up first) |
| `resolve <id> --keep\|--regen\|--unlink` | settle a conflict |
| `inspect <id>` | spec, state and provenance |
| `check <id> --oracle <module>#<export>` | compare a compiled region with a reference implementation on its examples plus seeded variations, in the sandbox |
| `init --backend <preset> [--model <id>] [--base-url <url>]` | start with another backend: `openrouter`, `openai`, `anthropic`, `local` (an OpenAI-compatible server on your machine) or `ollama` |
| `backends` / `backends test [name]` | list the backends (and whether each key's env var is set), or send one small request and report OK or FAIL with the reason and latency |

## Configuration: `openarc.config.json`

```json
{
  "version": 1,
  "backends": {
    "local": { "provider": "ollama", "model": "qwen3.5:9b", "maxContextTokens": 8192, "think": false },
    "big":   { "provider": "ollama", "model": "qwen2.5-coder:14b", "maxContextTokens": 32768 }
  },
  "compilation": {
    "defaultBackend": "local",
    "fallbackBackend": "big",
    "maxAttempts": 3,
    "context": { "initialLevel": 0, "expandOnFailure": true }
  },
  "regions": { "payments.process": { "backend": "big", "contextLevel": 2 } }
}
```

`provider` is `"ollama"` (local), `"openai"` (any OpenAI-compatible endpoint), `"anthropic"` (Claude), or one of two presets: `"openrouter"` and `"local"` (llama.cpp `llama-server`, LM Studio, vLLM, Ollama `/v1`; `baseUrl` required, no key). Hosted backends read the key from an environment variable (default `OPENROUTER_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`); the key itself never goes in the file. Explicit fields override a preset's defaults:

```json
"router":   { "provider": "openrouter", "model": "qwen/qwen3-coder", "maxContextTokens": 32768 },
"openai":   { "provider": "openai", "model": "gpt-5", "maxContextTokens": 32768 },
"claude":   { "provider": "anthropic", "model": "claude-opus-5-5", "maxContextTokens": 64000, "outputReserveTokens": 16000 },
"llamacpp": { "provider": "local", "baseUrl": "http://127.0.0.1:8080/v1", "model": "qwen3.5-9b", "maxContextTokens": 8192 }
```

Check a backend with `npx openarc backends test <name>` before compiling with it.

Ollama backends unload the model after `keepAlive` (default `"2m"`) so two local models don't sit in RAM together. A reply cut at the output cap (`outputReserveTokens`, default 3072) is retried with double the cap. All fields: [docs/wiki/Configuration.md](../docs/wiki/Configuration.md).

**Context levels** (each includes the one before):
- **L0, the contract:** signature, the types it references (verbatim), intent and examples.
- **L1:** adds the signatures of the helpers the function may call.
- **L2:** adds the whole file.

The budget follows the backend's `maxContextTokens`. A missing-name error expands the context; other failures are repaired with diagnostics; the last attempt can switch to `fallbackBackend`.

## What the model can and cannot touch

These are enforced by the compiler, not by the prompt:

- The model returns a body string. It never writes files.
- The body must parse as one function body. It can't close its braces to escape, and it can't contain `@openarc:` markers (a comment that merely mentions the prefix is stripped).
- With `calls: ["engine.parse", "ports.fs.*"]` on a spec, the body may call only those imported or port functions (`OARC-E098`).
- A block counts as verified only if a passing example of its function actually runs it; otherwise it is unverified (`OARC-W045`) and not committed. The exception is a function with no examples: its blocks get `OARC-W041` (no behavioral verification) and are committed without a sandbox run.
- After splicing, everything outside the region must be byte-identical. The only exception is added imports from the spec's `deps`.
- Spec statements (`defineRegion`/`defineBlock`) must be byte-identical before a run commits. Tests and fakes are never written.
- Examples reach the sandbox from the compiler's static parse of your spec. A body can't weaken its own tests at runtime.

## Effects: fakes

Functions that take ports (filesystem, HTTP, …) are tested with developer-written fakes:

```ts
{ args: [{ $fake: "fs.memory", init: { files: { "a.txt": "x" } } }], fakesAfter: { "fs.memory": { files: { "a.txt": "y" } } } }
```

`tests/fakes/fs.memory.ts` must export `default defineFake<FsPort>((init) => ({ instance, snapshot }))`.

## Status

0.6.4 (alpha). OpenArc compiles parts of itself; see the [wiki](https://github.com/TheMissenoOne/OpenArc/wiki) and [`SPEC-phase0.md`](https://github.com/TheMissenoOne/OpenArc/blob/main/SPEC-phase0.md).
