# Configuration: `openarc.config.json`

The project chooses its agents, the same way `package.json` chooses dependencies.

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
  "regions": {
    "payments.process": { "backend": "big", "contextLevel": 2 }
  },
  "sandbox": { "heapMb": 512, "cpuSeconds": 20 }
}
```

## Providers

| `provider` | Talks to | Structured output | Fields |
|---|---|---|---|
| `ollama` | local Ollama `/api/chat` | `format: <schema>` | `host` (default `http://127.0.0.1:11434`), `think`, `keepAlive` (default `"2m"`) |
| `openai` | any OpenAI-compatible Chat Completions endpoint: OpenAI, OpenRouter, Groq, LM Studio, vLLM, llama.cpp server | `response_format` `json_schema` (strict), or `json_object` | `baseUrl` (default `https://api.openai.com/v1`), `apiKeyEnv` (optional for keyless local servers), `headers`, `structuredOutput` |
| `anthropic` | Claude Messages API | `output_config.format` `json_schema` | `baseUrl` (default `https://api.anthropic.com/v1`), `apiKeyEnv` (default `ANTHROPIC_API_KEY`), `headers` |
| `openrouter` | preset: `openai` at `https://openrouter.ai/api/v1` | `json_object` by default | as `openai`; defaults `apiKeyEnv: "OPENROUTER_API_KEY"`, header `X-Title: OpenArc` |
| `local` | preset: `openai` at a server on your machine (llama.cpp `llama-server`, LM Studio, vLLM, Ollama `/v1`) | `json_schema` | as `openai`; `baseUrl` required, no key; `ollamaCompat` defaults to true when the URL contains `:11434` |

`openrouter` and `local` are presets: when the file is read they become `provider: "openai"` with the defaults above filled in. Any field you write yourself wins over a preset's default. The `openai` provider also defaults `apiKeyEnv` to `OPENAI_API_KEY` when `baseUrl` is OpenAI's own (or unset). The preset and the resulting endpoint settings are part of the fingerprint, so changing them recompiles what that backend compiled.

**API keys never go in the config file.** `apiKeyEnv` is the *name* of an environment variable; OpenArc reads the key from it at call time. A literal `"apiKey"` field is rejected (`OARC-E051`). An unset variable fails the call with `OARC-E080` and detail `missing-key:<ENV_NAME>`; the key itself is never printed, logged, or put in a diagnostic.

## Connecting providers

The quickest way is `init` with a preset, then a one-request check:

```bash
npx openarc init --backend openrouter --model qwen/qwen3-coder
export OPENROUTER_API_KEY=...
npx openarc backends test
```

`openarc init --backend <preset> [--model <id>] [--base-url <url>]` writes `openarc.config.json` with that backend as the default (`--model` is required except for `ollama`; `--base-url` is required for `local`). It never changes an existing `openarc.config.json`; add the backend to that file by hand. `openarc backends` lists the configured backends with provider, model, URL and whether each key's env var is set (never the key). `openarc backends test [name]` (default: the default backend) sends one small structured request through the same code path a compile uses and prints `OK` or `FAIL` with the reason and the latency. The reasons it reports are: missing key, unreachable, auth rejected (401/403), model not found, model not pulled (Ollama), `json_schema` unsupported (switch to `"structuredOutput": "json_object"`), and invalid JSON.

OpenRouter (any model it hosts):

```json
"router": { "provider": "openrouter", "model": "qwen/qwen3-coder", "maxContextTokens": 32768 }
```

This uses `OPENROUTER_API_KEY`, `json_object` (many routed models lack strict `json_schema`; set `"structuredOutput": "json_schema"` to override) and `X-Title: OpenArc`. Add `"headers": { "HTTP-Referer": "https://github.com/you/your-project" }` if you want attribution.

OpenAI:

```json
"openai": { "provider": "openai", "model": "gpt-5", "maxContextTokens": 32768 }
```

Anthropic:

```json
"claude": { "provider": "anthropic", "model": "claude-opus-5-5", "maxContextTokens": 64000, "outputReserveTokens": 16000 }
```

Current Claude models always think before answering, and thinking counts against `max_tokens`, so give them a generous `outputReserveTokens`. For a cheaper backend use `"claude-sonnet-5-5"` or `"claude-haiku-5-5"`.

Local OpenAI-compatible servers (no key):

```json
"llamacpp": { "provider": "local", "baseUrl": "http://127.0.0.1:8080/v1", "model": "qwen3.5-9b", "maxContextTokens": 8192 },
"lmstudio": { "provider": "local", "baseUrl": "http://127.0.0.1:1234/v1", "model": "qwen3.5-9b", "maxContextTokens": 8192 },
"vllm":     { "provider": "local", "baseUrl": "http://127.0.0.1:8000/v1", "model": "Qwen/Qwen3.5-9B", "maxContextTokens": 8192 },
"ollamav1": { "provider": "local", "baseUrl": "http://127.0.0.1:11434/v1", "model": "qwen3.5:9b", "maxContextTokens": 8192 }
```

llama.cpp's `llama-server` serves whatever model it was started with, so `model` is only a label there; LM Studio and vLLM need the id they list at `/v1/models`. vLLM rejects a request whose prompt plus `max_tokens` exceeds the window; OpenArc bounds the output cap by the room left after the prompt. For Ollama itself the native `ollama` provider is still the default (`openarc init` without `--backend`); it checks that the model is pulled and records its digest.

Export the key in your shell (`export OPENROUTER_API_KEY=...`) and point `compilation.defaultBackend` or `fallbackBackend` at the backend. A common setup is a local Ollama default with a hosted model as `fallbackBackend`.

## Fields

| Field | Meaning |
|---|---|
| `backends.*.maxContextTokens` | the size of the context budget (see [[Context Packages]]); Ollama also gets it as `num_ctx` |
| `backends.*.outputReserveTokens` | tokens kept free for the answer (default 3072), and the output cap: Ollama gets it as `num_predict`, hosted APIs as `max_tokens`. A reply cut at the cap is retried with double the cap, up to `maxContextTokens` minus the prompt, and logged |
| `backends.*.ollamaCompat` | `openai` provider only: the endpoint is Ollama's `/v1`, so also send `keep_alive` (from `keepAlive`) and `reasoning_effort: "none"`. Default: true when `baseUrl` ends in `:11434/v1` (the `local` preset: when it contains `:11434`); must be `true` or `false` |
| `backends.*.seed` | default 1; sent to Ollama and OpenAI-compatible APIs (Anthropic has no seed) |
| `backends.*.temperature` | default 0; sent to Ollama and OpenAI-compatible APIs. A retry whose prompt is byte-identical to the previous attempt's is sent with temperature 0.4, then 0.7, and seed + attempt − 1, because a deterministic resend can only repeat the same body; `provenance.sampling` records it |
| `backends.*.think` | Ollama: `false` turns off reasoning on thinking models; structured output is enough |
| `backends.*.keepAlive` | Ollama: how long the model stays in RAM after a call (default `"2m"`). Keep it short if two models don't fit in memory together |
| `backends.*.host` | Ollama: default `http://127.0.0.1:11434` |
| `backends.*.outputFormat` | how the model returns a body: `"json"` (default) or `"code"`. See [Output format](#output-format) |
| `compilation.fallbackBackend` | used on the last attempt |
| `regions.<id>` | per-region `backend`, starting `contextLevel` and `outputFormat` (wins over the backend's) |
| `sandbox.nodeBin` | defaults to the running Node's resolved binary (never a version-manager shim) |
| `ui.dom` | `"jsdom"` (since 0.8.0): opt into UI regions. Their checks render components in the project's own `jsdom`, `react` and `react-dom` (devDependencies). Without it a UI region is `OARC-E092` (`dom:not-configured`). See "UI specs" in [[Writing Specs]] |
| `sandbox.isolation` | `"auto"` (default): `bwrap` on Linux when it works, `sandbox-exec` on macOS, else `node` (`OARC-W046`). Or one of `"bwrap"`, `"sandbox-exec"`, `"node"`, `"container"`, `"unsafe-none"`; a tier that isn't available here is `OARC-E092`. `"none"` is invalid: only `"unsafe-none"` turns the sandbox off, with an error-level `OARC-W047` on every run. See [[Safety Model]] |
| `sandbox.containerImage` | the `container` tier's image, default `docker.io/library/node:<this Node's version>-slim` (it needs `timeout` from coreutils) |
| `sandbox.heapMb`, `sandbox.cpuSeconds`, `sandbox.addressSpaceBytes` | heap cap (default 512), CPU limit (default 20 s; the wall-clock timeout is this plus 20 s), virtual address space for `prlimit` on Linux (default 32 GiB) |

## Lint

The `lint` block configures `openarc lint` (see "Lint rules" in [[CLI Reference]]). Compile ignores it.

```json
{
  "lint": {
    "extends": "recommended",
    "failOnWarnings": false,
    "rules": { "spec/require-tests": "error", "spec/require-intent": "off" },
    "overrides": [
      { "files": ["src/payments/**"], "extends": "strict", "rules": {} }
    ]
  }
}
```

| Field | Meaning |
|---|---|
| `lint.extends` | the profile: `"recommended"` (default) or `"strict"`. `openarc lint --profile` replaces it for one run |
| `lint.failOnWarnings` | `true`: a warning fails the run too (exit 1), as `--strict` does. Default `false` |
| `lint.rules` | rule name to `"off"`, `"warn"` or `"error"` |
| `lint.overrides` | for specs in files matching one of `files` (project-relative globs: `*` within a path segment, `**` across segments), an `extends` and `rules` applied on top |

A rule's severity for a spec is decided in this order, each step overriding the one before: the profile, the top-level `rules`, then each override whose `files` match the spec's file, in order: its profile (when it sets `extends`), then its `rules`. So a later override wins, and an override's `extends` replaces what the top-level `rules` said. An unknown rule name, a severity other than the three, an unknown profile or an override without `files` is invalid config (`OARC-E051`).

## Output format

`outputFormat` decides what the model is asked to reply with. Set it on a backend, or on a region under `regions.<id>` (the region's setting wins):

```json
{
  "backends": { "local": { "provider": "ollama", "model": "qwen3.5:9b", "maxContextTokens": 8192, "outputFormat": "code" } },
  "regions": { "tasks.normalizeTitle": { "outputFormat": "json" } }
}
```

| Value | The model replies with | Sent to the provider |
|---|---|---|
| `"json"` (default) | `{"body": "<statements>", "imports": [...]}` | the JSON schema: Ollama `format`, OpenAI `response_format`, Anthropic `output_config` |
| `"code"` | one fenced code block: optional `import` lines at the top, then the function's body statements (or the block's statements) | nothing: plain text output, no schema |

In `"code"` mode the compiler drops `<think>…</think>` blocks, takes the first fence tagged `ts`, `typescript` or nothing (a reply with no fence at all is taken whole), and turns its leading `import` lines into imports. Named, default (`import x from "m"`), namespace (`import * as x from "m"`) and `import type` forms are accepted; renames inside braces and side-effect imports are an `OARC-E081` (`bad-import:…`), and so is a fence cut off at the output cap (`unclosed-fence`). After that the body goes through exactly the same checks as a `"json"` reply: whole-function unwrapping, the import rules (`OARC-E071`), the write-scope guards (`OARC-E097`), the static rules, `calls`, the type check, the sandboxed examples and the coverage probe.

A sketch region (`defineRegion({ sketch })`) replies `{"fills": {...}, "imports": [...]}` in `"json"` mode, under a schema with one string per hole. In `"code"` mode it replies with the whole sketch, holes filled, as one code block; the containment check (`OARC-E099`) recovers the fills and rejects any change outside the holes.

`"code"` exists to measure whether writing code as an escaped JSON string under constrained decoding costs small models accuracy (the 2026-10-31 benchmark's finding 6). The default stays `"json"` until that is measured. The output format is part of the fingerprint and of `provenance.outputFormat`, so switching it recompiles the regions it applies to.

The model's **digest** is part of every fingerprint. If you re-pull a model, everything it compiled becomes stale. Hosted APIs have no digest, so the fingerprint uses `<provider>:<baseUrl>:<model>`, plus the preset, `structuredOutput` and `ollamaCompat`. A hosted model can change behind the same id without making anything stale; that's acceptable because a cached body is re-verified (type check and examples) every time it is used.

A backend is a bounded interface: a request goes in and `{body, imports}` comes back. Hosted APIs are plain request/response calls behind that interface. Future adapters for tool-using agents (Codex, Claude Code) must use the same interface, so the compiler stays the only writer (see [[Safety Model]]).
