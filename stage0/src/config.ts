// Project configuration: openarc.config.json at the project root (like package.json/tsconfig.json).
// Hand-written. It picks which backend compiles which region and how much context each one gets.
import type { Json } from "open-arc";
import { ISOLATIONS, type Isolation } from "./isolation.ts";

/** Context levels, cumulative (spec §8.4, adaptive context):
 *  0 contract: signature, the type closure of the signature, intent, examples, effects/deps, rules
 *  1 + dependencies: signatures and type closures of helpers in `deps` and of file imports
 *  2 + source: the region's whole file and the source of its local deps */
export type ContextLevel = 0 | 1 | 2;

/** "ollama": local /api/chat. "openai": any OpenAI-compatible Chat Completions endpoint (OpenAI, OpenRouter, Groq,
 *  LM Studio, vLLM, llama.cpp server). "anthropic": the Claude Messages API. */
export type Provider = "ollama" | "openai" | "anthropic";
/** What a config file may write as `provider`: a Provider, or a preset that parseConfig normalises to one.
 *  "openrouter": openai at https://openrouter.ai/api/v1, key env OPENROUTER_API_KEY, header X-Title: OpenArc, json_object.
 *  "local": an OpenAI-compatible server on your machine (llama.cpp llama-server, LM Studio, vLLM, Ollama /v1): baseUrl
 *  required, no key, ollamaCompat when the URL has :11434. Explicit fields always win over a preset's defaults. */
export type Preset = Provider | "openrouter" | "local";
export const PRESETS: readonly Preset[] = ["ollama", "openai", "anthropic", "openrouter", "local"];

export interface BackendConfig {
  provider: Provider;
  preset?: Preset; // set by parseConfig: what the file said; part of the fingerprint
  model: string;
  maxContextTokens: number; // the context budget = this minus outputReserveTokens; Ollama also gets it as num_ctx
  outputReserveTokens?: number; // default 3072 (DEFAULT_OUTPUT_RESERVE), bounded by the context left after the prompt; the output cap: Ollama num_predict, hosted max_tokens. A truncated reply is retried with double the cap (backends.complete)
  seed?: number; // default 1 (ollama, openai)
  temperature?: number; // default 0 (ollama, openai); a retry with a byte-identical prompt raises it (engine.retrySampling)
  // ollama
  host?: string; // default http://127.0.0.1:11434
  think?: boolean; // reasoning models (qwen3.x): default false, because structured output is enough
  keepAlive?: string; // default "2m": how long Ollama keeps the model in RAM after a call
  // openai, anthropic
  baseUrl?: string; // default https://api.openai.com/v1 | https://api.anthropic.com/v1
  apiKeyEnv?: string; // NAME of the env var that holds the key; keys never live in the config file
  headers?: Record<string, string>; // extra headers, e.g. OpenRouter's HTTP-Referer / X-Title
  structuredOutput?: "json_schema" | "json_object"; // openai only, default json_schema
  ollamaCompat?: boolean; // openai only: the endpoint is Ollama's /v1 (default: baseUrl ends in :11434/v1). Sends keep_alive and reasoning_effort "none"
  /** Set by the engine per request, never read from the file: the structured-output schema to use instead of the
   *  `{body, imports}` one (sketch regions reply `{fills, imports}`). `strict` is for OpenAI json_schema. */
  outputSchema?: { loose: Json; strict: Json };
  outputFormat?: OutputFormat; // default "json"; a region's own outputFormat wins (src/output-format.ts)
}

/** How the model returns a body. "json": {"body", "imports"} under a JSON schema (Ollama format, OpenAI response_format,
 *  Anthropic output_config). "code": one fenced code block, import lines first, plain text output (no schema). */
export type OutputFormat = "json" | "code";
const OUTPUT_FORMATS: readonly OutputFormat[] = ["json", "code"];

export const DEFAULT_OUTPUT_RESERVE = 3072;

export interface OpenArcConfig {
  version: 1;
  backends: Record<string, BackendConfig>;
  compilation: {
    defaultBackend: string;
    fallbackBackend?: string;
    maxAttempts: number;
    context: { initialLevel: ContextLevel; expandOnFailure: boolean };
  };
  regions?: Record<string, { backend?: string; contextLevel?: ContextLevel; outputFormat?: OutputFormat }>;
  sandbox?: {
    heapMb?: number;
    addressSpaceBytes?: number;
    cpuSeconds?: number;
    nodeBin?: string;
    /** spec §9.2: "auto" (default) = bwrap on Linux, sandbox-exec on macOS, else "node" (OARC-W046). "container" and
     *  "unsafe-none" only when written here. */
    isolation?: Isolation;
    containerImage?: string; // container tier, default docker.io/library/node:<this Node's version>-slim
  };
  /** UI regions (§2.6): the DOM the harness renders components in, from the project's devDependencies. Without it, UI
   *  regions fail with OARC-E092 (dom:not-configured); there is no unverified fallback. */
  ui?: { dom?: "jsdom" };
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
  const iso = c.sandbox?.isolation;
  if (iso !== undefined && !ISOLATIONS.includes(iso))
    return { config: DEFAULT_CONFIG, error: `openarc.config.json: sandbox.isolation must be one of ${ISOLATIONS.join(", ")}${(iso as string) === "none" ? ' (no sandbox at all is spelled "unsafe-none")' : ""}` };
  if (c.ui !== undefined && (typeof c.ui !== "object" || c.ui === null || (c.ui.dom !== undefined && c.ui.dom !== "jsdom")))
    return { config: DEFAULT_CONFIG, error: 'openarc.config.json: ui.dom must be "jsdom" (installed as a devDependency of the project)' };
  for (const [name, b] of Object.entries(c.backends)) {
    const bad = (why: string) => ({ config: DEFAULT_CONFIG, error: `openarc.config.json: backend "${name}": ${why}` });
    if (typeof b !== "object" || b === null) return bad("must be an object");
    if ("apiKey" in b) return bad(`literal "apiKey" is not allowed; put the key in an env var and name it in "apiKeyEnv"`);
    if (!PRESETS.includes(b.provider)) return bad(`unknown provider "${b.provider}" (one of ${PRESETS.join(", ")})`);
    if ((b.provider as Preset) === "local" && typeof b.baseUrl !== "string") return bad(`"baseUrl" is required for provider "local" (e.g. http://127.0.0.1:8080/v1)`);
    if (b.structuredOutput !== undefined && !["json_schema", "json_object"].includes(b.structuredOutput)) return bad(`"structuredOutput" must be json_schema or json_object`);
    if (b.ollamaCompat !== undefined && typeof b.ollamaCompat !== "boolean") return bad(`"ollamaCompat" must be true or false`);
    if (b.outputFormat !== undefined && !OUTPUT_FORMATS.includes(b.outputFormat)) return bad(`"outputFormat" must be json or code`);
  }
  for (const [id, r] of Object.entries(c.regions ?? {}))
    if (r.outputFormat !== undefined && !OUTPUT_FORMATS.includes(r.outputFormat))
      return { config: DEFAULT_CONFIG, error: `openarc.config.json: region "${id}": "outputFormat" must be json or code` };
  return {
    config: {
      ...c,
      backends: Object.fromEntries(Object.entries(c.backends).map(([name, b]) => [name, applyPreset(b)])),
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

/** A backend as written in the file -> a backend of one of the three providers. Deterministic: preset defaults first,
 *  then every explicit field. */
export function applyPreset(b: BackendConfig): BackendConfig {
  const preset = (b.preset ?? b.provider) as Preset;
  const set = Object.fromEntries(Object.entries(b).filter(([, v]) => v !== undefined)) as Partial<BackendConfig>;
  switch (preset) {
    case "openrouter":
      return { baseUrl: "https://openrouter.ai/api/v1", apiKeyEnv: "OPENROUTER_API_KEY", structuredOutput: "json_object", ...set, headers: { "X-Title": "OpenArc", ...b.headers }, provider: "openai", preset } as BackendConfig;
    case "local":
      return { ollamaCompat: (b.baseUrl ?? "").includes(":11434"), ...set, provider: "openai", preset } as BackendConfig;
    case "openai":
      return { ...(b.baseUrl === undefined || b.baseUrl.replace(/\/$/, "") === "https://api.openai.com/v1" ? { apiKeyEnv: "OPENAI_API_KEY" } : {}), ...set, preset } as BackendConfig;
    case "anthropic":
      return { apiKeyEnv: "ANTHROPIC_API_KEY", ...set, preset } as BackendConfig;
    default:
      return { ...set, preset } as BackendConfig;
  }
}

/** `openarc init --backend <preset> [--model <id>] [--base-url <url>]`: a config whose default backend is that preset.
 *  Only what the user chose is written; the preset fills in the rest when the file is read. A string is a usage error. */
export function presetConfig(preset: string, model?: string, baseUrl?: string): OpenArcConfig | string {
  if (!PRESETS.includes(preset as Preset)) return `unknown backend preset "${preset}" (one of ${PRESETS.join(", ")})`;
  if (preset !== "ollama" && !model) return `--backend ${preset} needs --model <id>`;
  if (preset === "local" && !baseUrl) return `--backend local needs --base-url <url>, e.g. http://127.0.0.1:8080/v1 (llama-server), :1234/v1 (LM Studio), :8000/v1 (vLLM)`;
  const b: BackendConfig = preset === "ollama"
    ? { ...DEFAULT_CONFIG.backends.local!, ...(model ? { model } : {}), ...(baseUrl ? { host: baseUrl } : {}) }
    : { provider: preset as Provider, model: model!, maxContextTokens: preset === "local" ? 8192 : 32768, ...(baseUrl ? { baseUrl } : {}) };
  return { ...DEFAULT_CONFIG, backends: { [preset]: b }, compilation: { ...DEFAULT_CONFIG.compilation, defaultBackend: preset } };
}
