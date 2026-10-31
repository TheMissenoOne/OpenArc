# OpenArc

Compile typed specs into verified TypeScript with **small local models**.

You write the contract: a function type, an intent and examples. OpenArc builds a minimal context package for that one function, the way a unit test isolates code. It asks a local model for the body, then verifies the result:
- type-checking (tsc),
- static rules,
- your examples, run in a sandbox.

Only then does it splice the body in. Your hand edits are never overwritten.

```ts
import * as arc from "openarc";

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

- Linux, with `bwrap` (bubblewrap) and `prlimit`. Examples run in a sandbox with no network, a read-only filesystem and resource limits. If the sandbox is unavailable, OpenArc refuses to run examples rather than running them unsandboxed.
- Node ≥ 23.6, which runs `.ts` directly.
- [Ollama](https://ollama.com) with a model, e.g. `ollama pull qwen3.5:9b`.

## Use

```bash
npm i -D openarc
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

`provider` is `"ollama"` (local), `"openai"` (any OpenAI-compatible endpoint: OpenAI, OpenRouter, Groq, LM Studio, vLLM, llama.cpp server) or `"anthropic"` (Claude). Hosted backends name the environment variable that holds the key; the key itself never goes in the file:

```json
"router": { "provider": "openai", "baseUrl": "https://openrouter.ai/api/v1", "apiKeyEnv": "OPENROUTER_API_KEY", "model": "qwen/qwen3-coder", "maxContextTokens": 32768 },
"openai": { "provider": "openai", "apiKeyEnv": "OPENAI_API_KEY", "model": "gpt-5", "maxContextTokens": 32768 },
"claude": { "provider": "anthropic", "apiKeyEnv": "ANTHROPIC_API_KEY", "model": "claude-opus-5-5", "maxContextTokens": 64000, "outputReserveTokens": 16000 }
```

Ollama backends unload the model after `keepAlive` (default `"2m"`) so two local models don't sit in RAM together. All fields: [docs/wiki/Configuration.md](../docs/wiki/Configuration.md).

**Context levels** (each includes the one before):
- **L0, the contract:** signature, the types it references (verbatim), intent and examples.
- **L1:** adds the signatures of the helpers the function may call.
- **L2:** adds the whole file.

The budget follows the backend's `maxContextTokens`. A missing-name error expands the context; other failures are repaired with diagnostics; the last attempt can switch to `fallbackBackend`.

## What the model can and cannot touch

These are enforced by the compiler, not by the prompt:

- The model returns a body string. It never writes files.
- The body must parse as one function body. It can't close its braces to escape, and it can't contain `@openarc:` markers.
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

0.5.0 (alpha). OpenArc compiles parts of itself; see the [wiki](https://github.com/TheMissenoOne/OpenArc/wiki) and [`SPEC-phase0.md`](https://github.com/TheMissenoOne/OpenArc/blob/main/SPEC-phase0.md).
