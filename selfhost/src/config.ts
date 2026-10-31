// Project configuration: openarc.config.json at the project root (like package.json/tsconfig.json).
// Hand-written. It picks which backend compiles which region and how much context each one gets.
import type { Json } from "openarc";

/** Context levels, cumulative (spec §8.4, adaptive context):
 *  0 contract: signature, the type closure of the signature, intent, examples, effects/deps, rules
 *  1 + dependencies: signatures and type closures of helpers in `deps` and of file imports
 *  2 + source: the region's whole file and the source of its local deps */
export type ContextLevel = 0 | 1 | 2;

/** "ollama": local /api/chat. "openai": any OpenAI-compatible Chat Completions endpoint (OpenAI, OpenRouter, Groq,
 *  LM Studio, vLLM, llama.cpp server). "anthropic": the Claude Messages API. */
export type Provider = "ollama" | "openai" | "anthropic";

export interface BackendConfig {
  provider: Provider;
  model: string;
  maxContextTokens: number; // the context budget = this minus outputReserveTokens; Ollama also gets it as num_ctx
  outputReserveTokens?: number; // default 2048; sent as max_tokens to hosted APIs
  seed?: number; // default 1 (ollama, openai)
  // ollama
  host?: string; // default http://127.0.0.1:11434
  think?: boolean; // reasoning models (qwen3.x): default false, because structured output is enough
  keepAlive?: string; // default "2m": how long Ollama keeps the model in RAM after a call
  // openai, anthropic
  baseUrl?: string; // default https://api.openai.com/v1 | https://api.anthropic.com/v1
  apiKeyEnv?: string; // NAME of the env var that holds the key; keys never live in the config file
  headers?: Record<string, string>; // extra headers, e.g. OpenRouter's HTTP-Referer / X-Title
  structuredOutput?: "json_schema" | "json_object"; // openai only, default json_schema
}

export interface OpenArcConfig {
  version: 1;
  backends: Record<string, BackendConfig>;
  compilation: {
    defaultBackend: string;
    fallbackBackend?: string;
    maxAttempts: number;
    context: { initialLevel: ContextLevel; expandOnFailure: boolean };
  };
  regions?: Record<string, { backend?: string; contextLevel?: ContextLevel }>;
  sandbox?: { heapMb?: number; addressSpaceBytes?: number; cpuSeconds?: number; nodeBin?: string };
}

export const DEFAULT_CONFIG: OpenArcConfig = {
  version: 1,
  backends: {
    local: { provider: "ollama", model: "qwen3.5:9b", maxContextTokens: 8192, think: false },
  },
  compilation: {
    defaultBackend: "local",
    maxAttempts: 3,
    context: { initialLevel: 0, expandOnFailure: true },
  },
};

export function parseConfig(text: string | null): { config: OpenArcConfig; error?: string } {
  if (text === null) return { config: DEFAULT_CONFIG };
  let raw: Json;
  try {
    raw = JSON.parse(text) as Json;
  } catch (e) {
    return { config: DEFAULT_CONFIG, error: `openarc.config.json: invalid JSON (${(e as Error).message})` };
  }
  const c = raw as unknown as OpenArcConfig;
  if (c?.version !== 1) return { config: DEFAULT_CONFIG, error: "openarc.config.json: version must be 1" };
  const names = Object.keys(c.backends ?? {});
  if (!names.length) return { config: DEFAULT_CONFIG, error: "openarc.config.json: no backends" };
  for (const ref of [c.compilation?.defaultBackend, c.compilation?.fallbackBackend, ...Object.values(c.regions ?? {}).map((r) => r.backend)])
    if (ref !== undefined && !names.includes(ref)) return { config: DEFAULT_CONFIG, error: `openarc.config.json: unknown backend "${ref}"` };
  for (const [name, b] of Object.entries(c.backends)) {
    const bad = (why: string) => ({ config: DEFAULT_CONFIG, error: `openarc.config.json: backend "${name}": ${why}` });
    if (typeof b !== "object" || b === null) return bad("must be an object");
    if ("apiKey" in b) return bad(`literal "apiKey" is not allowed; put the key in an env var and name it in "apiKeyEnv"`);
    if (!["ollama", "openai", "anthropic"].includes(b.provider)) return bad(`unknown provider "${b.provider}"`);
    if (b.provider === "anthropic" && !b.apiKeyEnv) return bad(`"apiKeyEnv" is required`);
    if (b.structuredOutput !== undefined && !["json_schema", "json_object"].includes(b.structuredOutput)) return bad(`"structuredOutput" must be json_schema or json_object`);
  }
  return {
    config: {
      ...c,
      compilation: {
        defaultBackend: c.compilation?.defaultBackend ?? names[0]!,
        fallbackBackend: c.compilation?.fallbackBackend,
        maxAttempts: c.compilation?.maxAttempts ?? 3,
        context: { initialLevel: c.compilation?.context?.initialLevel ?? 0, expandOnFailure: c.compilation?.context?.expandOnFailure ?? true },
      },
    },
  };
}

export const hostOf = (b: BackendConfig) => (b.host ?? "http://127.0.0.1:11434").replace(/\/$/, "");
