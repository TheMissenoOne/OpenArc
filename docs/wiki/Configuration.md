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
| `anthropic` | Claude Messages API | `output_config.format` `json_schema` | `baseUrl` (default `https://api.anthropic.com/v1`), `apiKeyEnv` (required), `headers` |

**API keys never go in the config file.** `apiKeyEnv` is the *name* of an environment variable; OpenArc reads the key from it at call time. A literal `"apiKey"` field is rejected (`OARC-E051`). An unset variable fails the call with `OARC-E080` and detail `missing-key:<ENV_NAME>`; the key itself is never printed, logged, or put in a diagnostic.

OpenRouter (any model it hosts, through its OpenAI-compatible API):

```json
"router": {
  "provider": "openai",
  "baseUrl": "https://openrouter.ai/api/v1",
  "apiKeyEnv": "OPENROUTER_API_KEY",
  "model": "qwen/qwen3-coder",
  "headers": { "HTTP-Referer": "https://github.com/you/your-project", "X-Title": "OpenArc" },
  "maxContextTokens": 32768
}
```

If the routed model rejects `json_schema`, add `"structuredOutput": "json_object"`.

OpenAI:

```json
"openai": { "provider": "openai", "apiKeyEnv": "OPENAI_API_KEY", "model": "gpt-5", "maxContextTokens": 32768 }
```

Anthropic:

```json
"claude": {
  "provider": "anthropic",
  "apiKeyEnv": "ANTHROPIC_API_KEY",
  "model": "claude-opus-5-5",
  "maxContextTokens": 64000,
  "outputReserveTokens": 16000
}
```

Current Claude models always think before answering, and thinking counts against `max_tokens`, so give them a generous `outputReserveTokens`. For a cheaper backend use `"claude-sonnet-5-5"` or `"claude-haiku-5-5"`.

Then export the key in your shell (`export OPENROUTER_API_KEY=...`) and point `compilation.defaultBackend` or `fallbackBackend` at the backend. A common setup is a local Ollama default with a hosted model as `fallbackBackend`.

## Fields

| Field | Meaning |
|---|---|
| `backends.*.maxContextTokens` | the size of the context budget (see [[Context Packages]]); Ollama also gets it as `num_ctx` |
| `backends.*.outputReserveTokens` | tokens kept free for the answer (default 3072), and the output cap: Ollama gets it as `num_predict`, hosted APIs as `max_tokens`. A reply cut at the cap is retried with double the cap, up to `maxContextTokens` minus the prompt, and logged |
| `backends.*.ollamaCompat` | `openai` provider only: the endpoint is Ollama's `/v1`, so also send `keep_alive` (from `keepAlive`) and `reasoning_effort: "none"`. Default: true when `baseUrl` ends in `:11434/v1` |
| `backends.*.seed` | default 1; sent to Ollama and OpenAI-compatible APIs (Anthropic has no seed) |
| `backends.*.temperature` | default 0; sent to Ollama and OpenAI-compatible APIs. A retry whose prompt is byte-identical to the previous attempt's is sent with temperature 0.4, then 0.7, and seed + attempt − 1, because a deterministic resend can only repeat the same body; `provenance.sampling` records it |
| `backends.*.think` | Ollama: `false` turns off reasoning on thinking models; structured output is enough |
| `backends.*.keepAlive` | Ollama: how long the model stays in RAM after a call (default `"2m"`). Keep it short if two models don't fit in memory together |
| `backends.*.host` | Ollama: default `http://127.0.0.1:11434` |
| `compilation.fallbackBackend` | used on the last attempt |
| `regions.<id>` | per-region backend and starting context level |
| `sandbox.nodeBin` | defaults to the running Node's resolved binary (never a version-manager shim) |

The model's **digest** is part of every fingerprint. If you re-pull a model, everything it compiled becomes stale. Hosted APIs have no digest, so the fingerprint uses `<provider>:<baseUrl>:<model>`. A hosted model can change behind the same id without making anything stale; that's acceptable because a cached body is re-verified (type check and examples) every time it is used.

A backend is a bounded interface: a request goes in and `{body, imports}` comes back. Hosted APIs are plain request/response calls behind that interface. Future adapters for tool-using agents (Codex, Claude Code) must use the same interface, so the compiler stays the only writer (see [[Safety Model]]).
